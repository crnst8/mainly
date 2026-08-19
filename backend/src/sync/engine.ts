/**
 * The sync loop.
 *
 * Claims accounts with a Postgres advisory lock, so N replicas coordinate with
 * no scheduler, no leader election, and no queue. A worker that crashes drops
 * its connection, which drops the lock, and another worker picks the account up
 * on the next tick.
 *
 * Order within one account's pass is deliberate:
 *
 *   replay → folders → envelopes
 *
 * Replay first because the server is only authoritative for flags once it has
 * heard from us; reading flags before pushing ours is how a message you just
 * marked read comes back unread for one poll interval. Folders before envelopes
 * because a folder that does not exist locally has nothing to index into.
 */

import { claimAccount, query } from '../db/index.ts';
import { config } from '../config.ts';
import { syncFolders, refreshCounts, publishCounts } from './folders.ts';
import { syncEnvelopes, evictStaleBodies, type StepReporter } from './envelopes.ts';
import { refreshAccountThreads } from './threads.ts';
import { indexPendingBodies } from './body-index.ts';
import { replayAccount } from './replay.ts';
import type { AccountCredentials } from './pool.ts';
import { publish } from '../modules/events/bus.ts';
import type { Priority } from '../contract/types.ts';
import { KeyedWorkQueue } from './work-queue.ts';

let running = false;
let timer: NodeJS.Timeout | null = null;
const accountQueue = new KeyedWorkQueue(config.sync.maxConcurrentAccounts, (accountId, err) => {
  console.error({ accountId, err: err.message }, 'queued account sync failed');
});

interface AccountRow {
  id: string;
  user_id: string;
  address: string;
  priority: Priority;
  imap_host: string;
  imap_port: number;
  imap_security: 'tls' | 'starttls' | 'none';
  username: string;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_key_version: number;
  last_sync_at: Date | null;
}

const ACCOUNT_COLUMNS = `
  id, user_id, address, priority,
  imap_host, imap_port, imap_security, username,
  secret_ciphertext, secret_nonce, secret_tag, secret_key_version,
  last_sync_at
`;

const toCredentials = (r: AccountRow): AccountCredentials => ({
  id: r.id,
  address: r.address,
  imapHost: r.imap_host,
  imapPort: r.imap_port,
  imapSecurity: r.imap_security,
  username: r.username,
  secretCiphertext: r.secret_ciphertext,
  secretNonce: r.secret_nonce,
  secretTag: r.secret_tag,
  secretKeyVersion: r.secret_key_version,
});

export function startSyncLoop(): void {
  if (running) return;
  running = true;
  const tick = () => {
    void runOnce().catch((err) => console.error({ err: err.message }, 'sync tick failed'));
  };
  tick();
  timer = setInterval(tick, config.sync.intervalMs);
  console.log(
    `sync loop started (every ${config.sync.intervalMs}ms, ${config.sync.maxConcurrentAccounts} accounts at once)`,
  );
}

export async function stopSyncLoop(): Promise<void> {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  await accountQueue.stop();
}

async function runOnce(): Promise<void> {
  const due = await query<AccountRow>(
    `
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
     WHERE status <> 'disabled'
       AND (last_sync_at IS NULL OR last_sync_at < now() - ($1 || ' milliseconds')::interval)
     -- Never-synced accounts first: a new account showing nothing is the worst
     -- first impression this app can make.
     ORDER BY last_sync_at NULLS FIRST
     LIMIT 20
    `,
    [config.sync.intervalMs],
  );

  for (const row of due) enqueueAccount(row);

  // Body cache eviction rides on the sync tick rather than owning a scheduler.
  // It is a single indexed DELETE and there is nothing to gain from running it
  // on its own clock.
  const evicted = await evictStaleBodies().catch(() => 0);
  if (evicted) console.log({ evicted }, 'evicted cached bodies past their TTL');
}

function enqueueAccount(row: AccountRow): void {
  accountQueue.enqueue(row.id, async () => {
    const claim = await claimAccount(row.id);
    if (!claim) return; // another replica owns it
    try {
      await syncAccount(row);
    } finally {
      await claim.release();
    }
  });
}

export async function syncAccount(row: AccountRow): Promise<void> {
  const creds = toCredentials(row);
  let bodySearch = { indexed: 0, total: 0 };
  const refreshBodySearch = async () => {
    const rows = await query<{ indexed: number; total: number }>(
      `SELECT count(*) FILTER (WHERE m.body_indexed_at IS NOT NULL)::int AS indexed,
              count(*)::int AS total
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
        WHERE a.user_id = $1`,
      [row.user_id],
    );
    bodySearch = rows[0] ?? { indexed: 0, total: 0 };
  };

  const report = (step: string | null, progress: number | null) =>
    publish(row.user_id, {
      type: 'sync',
      state: {
        busy: true,
        accounts: {
          [row.id]: { status: 'syncing', progress, step, lastSyncAt: null, error: null },
        },
        bodySearch,
      },
    });

  try {
    await refreshBodySearch();
    await setStatus(row.id, 'syncing', null);
    report('Connecting', null);

    // Push what we owe the server before reading its answer back.
    await replayAccount(creds);

    report('Listing folders', 0);
    await syncFolders(creds);

    const onStep: StepReporter = (step, progress) => report(step, progress);
    const result = await syncEnvelopes(creds, row.user_id, row.priority, { onStep });

    // Sidebar counts are derived, not synced. Recomputing once at the end costs
    // one indexed aggregate and removes any chance of the list and the sidebar
    // disagreeing about the same folder.
    await refreshCounts(row.id);
    await refreshAccountThreads(row.id);
    await indexPendingBodies(creds, row.id).catch((err: Error) => {
      console.warn({ account: row.address, err: err.message }, 'body-search backfill failed');
    });
    await refreshBodySearch();

    await query(
      `UPDATE accounts SET status = 'ok', error = NULL, last_sync_at = now() WHERE id = $1`,
      [row.id],
    );

    publish(row.user_id, {
      type: 'sync',
      state: {
        busy: false,
        accounts: {
          [row.id]: {
            status: 'ok',
            progress: 1,
            step: null,
            lastSyncAt: new Date().toISOString(),
            error: null,
          },
        },
        bodySearch,
      },
    });
    await publishCounts(row.user_id, row.id);
    // Only tell the client to re-read the list when there is something new to
    // read. An event per pass would refetch the list every two minutes for
    // nothing.
    if (result.indexed || result.updated || result.removed) {
      publish(row.user_id, { type: 'messages:changed', ids: [], patch: {} });
    }

    if (result.indexed || result.removed) {
      console.log(
        { account: row.address, ...result },
        'envelope pass complete',
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    // Surface the server's own words. "Authentication failed" from Dovecot is
    // more useful than anything we would paraphrase.
    const status = /auth|credential|login/i.test(message) ? 'auth_error' : 'connect_error';
    const statusError = await setStatus(row.id, status, message)
      .then(() => null)
      .catch((statusErr: Error) => statusErr);
    publish(row.user_id, {
      type: 'sync',
      state: {
        busy: false,
        accounts: {
          [row.id]: { status, progress: null, step: null, lastSyncAt: null, error: message },
        },
        bodySearch,
      },
    });
    console.error({ account: row.address, err: message }, 'account sync failed');
    if (statusError) {
      console.error(
        { account: row.address, err: statusError.message },
        'could not persist account sync failure',
      );
    }
  }
}

async function setStatus(id: string, status: string, error: string | null): Promise<void> {
  await query(`UPDATE accounts SET status = $2::account_status_t, error = $3 WHERE id = $1`, [
    id,
    status,
    error,
  ]);
}

/** Manual trigger from POST /api/sync. */
export function syncNow(userId: string, accountId?: string): void {
  // The caller gets 202 and watches SSE. This boundary owns its rejection so a
  // database outage cannot turn a fire-and-forget refresh into a process exit.
  void enqueueNow(userId, accountId).catch((err: Error) => {
    console.error({ accountId: accountId ?? null, err: err.message }, 'could not queue manual sync');
  });
}

async function enqueueNow(userId: string, accountId?: string): Promise<void> {
  const rows = await query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts
      WHERE user_id = $1
        AND status <> 'disabled'
        AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY last_sync_at NULLS FIRST`,
    [userId, accountId ?? null],
  );
  for (const row of rows) enqueueAccount(row);
}
