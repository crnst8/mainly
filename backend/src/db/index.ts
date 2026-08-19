/**
 * Postgres access. A thin wrapper, deliberately.
 *
 * No ORM: the list query in modules/messages is the entire performance story of
 * this application, and an abstraction that hides which index is being used
 * would cost more than it saves.
 */

import pg from 'pg';
import { config } from '../config.ts';

// Return bigints as numbers. UIDs and MODSEQs are well inside Number.MAX_SAFE_INTEGER
// for any realistic mailbox, and strings would poison every arithmetic comparison.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: `mail-${config.role}`,
});

pool.on('error', (err) => {
  // An idle client erroring is not fatal — the pool replaces it — but it is
  // always worth knowing about.
  console.error({ err: err.message }, 'idle postgres client error');
});

/** Any object shape. Deliberately not `Record<string, unknown>`: hand-written
 *  row interfaces do not have index signatures, and requiring one would mean
 *  every query result had to be typed as loosely as the loosest one. */
export type Row = object;

async function execute<T extends Row = Row>(
  db: pg.Pool | pg.PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = performance.now();
  const res = await db.query<T>(text, params);
  const ms = performance.now() - started;
  // Anything over the Doherty threshold is a bug in the query, not the data.
  if (ms > 400) {
    console.warn({ ms: Math.round(ms), sql: text.slice(0, 120) }, 'slow query');
  }
  return res.rows;
}

export async function query<T extends Row = Row>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return execute<T>(pool, text, params);
}

export type QueryRunner = typeof query;

/**
 * Keep a related sequence of reads on one checked-out client.
 *
 * A list request performs scope, page, capped-count and facet reads. Letting
 * each `pool.query` acquire independently makes one HTTP request occupy four
 * pool slots under load; a single client keeps that amplification at one while
 * retaining the same autocommit semantics.
 */
export async function withClient<T>(fn: (run: QueryRunner) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const run: QueryRunner = (text, params = []) => execute(client, text, params);
  try {
    return await fn(run);
  } finally {
    client.release();
  }
}

export async function one<T extends Row = Row>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run a function inside a transaction. Rolls back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Try to take an advisory lock for an account.
 *
 * This is how sync work is distributed across replicas without a scheduler or
 * a queue: whichever worker gets the lock owns the account until it releases
 * or its connection dies. See docs/architecture.md.
 *
 * The returned release function must be called; the caller owns the client.
 */
export async function claimAccount(
  accountId: string,
): Promise<{ release: () => Promise<void> } | null> {
  const client = await pool.connect();
  const res = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    [accountId],
  );
  if (!res.rows[0]?.locked) {
    client.release();
    return null;
  }
  return {
    release: async () => {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [accountId]).catch(() => {});
      client.release();
    },
  };
}

export async function close(): Promise<void> {
  await pool.end();
}
