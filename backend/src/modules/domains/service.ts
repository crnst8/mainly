/**
 * Domain control — everything except the HTTP.
 *
 * This is the only place a provisioning credential is decrypted, and the only
 * place that decides whether an operation is allowed. Routes call in here; so
 * does the CLI. Neither repeats a check.
 *
 * **The permission model, in one place.** An operation has to survive three
 * independent gates, and they are deliberately not stored together:
 *
 *   1. `driver.capabilities()` — what this kind of mail server can do at all.
 *   2. `mail_domains.grants`   — what this install has been told it may do.
 *   3. The mail server's own allowlist — what it will actually agree to.
 *
 * The third is the one that matters, and it is the one this application cannot
 * write. Everything here can be subverted by someone with the database; none of
 * it can widen what the mail server will do. The first two exist so the UI can
 * be honest about what will work, and so a mistake is caught before it becomes
 * a request.
 */

import { one, query } from '../../db/index.ts';
import { open, seal } from '../../lib/crypto.ts';
import { assertPublicHost } from '../../lib/net-guard.ts';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.ts';
import {
  DOMAIN_GRANTS,
  isDomainGrant,
  type DomainGrant,
  type DomainOp,
  type DomainProbe,
  type DomainStatus,
  type ManagedAlias,
  type ManagedDomain,
  type ManagedMailbox,
} from '../../contract/types.ts';
import { driverFor, type DomainDriver, type DriverContext } from './drivers/index.ts';
// Reached directly, and only here: see the note in drivers/index.ts.
import { scanHostKey } from './drivers/ssh.ts';
import { DOMAIN_RE, effectiveGrants } from './grants.ts';

// Re-exported so callers have one import for the module rather than having to
// know which file inside it a rule lives in.
export { effectiveGrants, LOCALPART_RE } from './grants.ts';

/* ── Rows ────────────────────────────────────────────────────────────────── */

interface DomainRow {
  id: string;
  domain: string;
  driver: string;
  config: Record<string, unknown>;
  grants: string[];
  server_grants: string[];
  status: string;
  error: string | null;
  last_checked_at: Date | null;
}

/** The secret columns are absent, exactly as in accounts/routes.ts. No read that
 *  serves a response is allowed to select them. */
const PUBLIC_COLUMNS = `
  id, domain, driver, config, grants, server_grants, status, error, last_checked_at
`;

const asGrants = (v: string[]): DomainGrant[] => v.filter(isDomainGrant);

const toDomain = (r: DomainRow): ManagedDomain => {
  const grants = asGrants(r.grants);
  const serverGrants = asGrants(r.server_grants);
  const driver = driverFor(r.driver);
  const capable = driver ? driver.capabilities() : [];
  return {
    id: r.id,
    domain: r.domain,
    driver: r.driver,
    config: {
      host: typeof r.config.host === 'string' ? r.config.host : '',
      port: typeof r.config.port === 'number' ? r.config.port : 22,
      user: typeof r.config.user === 'string' ? r.config.user : 'mailprov',
      hostKey: typeof r.config.hostKey === 'string' ? r.config.hostKey : null,
    },
    grants,
    serverGrants,
    effective: effectiveGrants(grants, serverGrants, capable),
    status: (['pending', 'ok', 'unreachable', 'error'] as const).includes(r.status as DomainStatus)
      ? (r.status as DomainStatus)
      : 'error',
    error: r.error,
    lastCheckedAt: r.last_checked_at?.toISOString() ?? null,
  };
};

/* ── Audit ───────────────────────────────────────────────────────────────── */

/** How the caller authenticated, in the form `domain_ops.actor` records — the
 *  same convention `unsubscribe_attempts.actor` uses. */
export type Actor = { kind: 'session' } | { kind: 'token'; name: string };

const actorName = (actor: Actor) => (actor.kind === 'session' ? 'session' : actor.name);

async function record(
  userId: string,
  domain: string,
  action: string,
  target: string,
  status: 'ok' | 'failed',
  detail: string | null,
  actor: Actor,
): Promise<void> {
  await query(
    `INSERT INTO domain_ops (user_id, domain, action, target, status, detail, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, domain, action, target, status, detail, actorName(actor)],
  );
}

/**
 * Run a mutating driver call, and record it either way.
 *
 * Wrapped rather than left to each caller because the failure path is the one
 * that matters: an operation that half-worked, or that the mail server refused,
 * is exactly what someone will want to find later, and it is the path a caller
 * most easily forgets to log.
 */
async function audited<T>(
  userId: string,
  domain: string,
  action: string,
  target: string,
  actor: Actor,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();
    await record(userId, domain, action, target, 'ok', null, actor);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record(userId, domain, action, target, 'failed', message, actor).catch(() => {
      /* The original failure is the one worth reporting. */
    });
    throw err;
  }
}

/* ── Loading and permission ──────────────────────────────────────────────── */

interface Loaded {
  row: DomainRow;
  driver: DomainDriver;
  ctx: DriverContext;
}

/**
 * Load a domain, open its credential, and check one grant.
 *
 * Both grant sets are checked here. The server would refuse anyway — that is
 * the guarantee — but failing before the connection means the operator gets a
 * sentence explaining which switch is off, rather than a mail server's terse
 * refusal relayed through two layers.
 */
async function load(userId: string, id: string, need: DomainGrant | null): Promise<Loaded> {
  const row = await one<
    DomainRow & {
      secret_ciphertext: Buffer;
      secret_nonce: Buffer;
      secret_tag: Buffer;
      secret_key_version: number;
    }
  >(
    `SELECT ${PUBLIC_COLUMNS},
            secret_ciphertext, secret_nonce, secret_tag, secret_key_version
       FROM mail_domains WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  if (!row) throw notFound('Domain');

  const driver = driverFor(row.driver);
  if (!driver) {
    throw badRequest(
      `This domain uses the '${row.driver}' driver, which this version does not have.`,
    );
  }

  if (need) {
    if (!driver.capabilities().includes(need)) {
      throw badRequest(`The ${row.driver} driver cannot ${need}.`);
    }
    if (!asGrants(row.grants).includes(need)) {
      throw forbidden(
        `'${need}' is not granted for ${row.domain}. Turn it on in Settings → Mail server.`,
      );
    }
    // Not checked against server_grants: that snapshot can be stale, and the
    // server is entitled to change its mind. Letting the request through means
    // the refusal comes from the authority that owns the answer.
  }

  return {
    row,
    driver,
    ctx: {
      domain: row.domain,
      config: row.config,
      secret: open({
        ciphertext: row.secret_ciphertext,
        nonce: row.secret_nonce,
        tag: row.secret_tag,
        keyVersion: row.secret_key_version,
      }),
    },
  };
}

/** A driver method that may not exist. Capability said it should; this is the
 *  assertion that the driver agrees. */
function must<K extends keyof DomainDriver>(
  driver: DomainDriver,
  method: K,
  grant: DomainGrant,
): NonNullable<DomainDriver[K]> {
  const fn = driver[method];
  if (typeof fn !== 'function') {
    throw badRequest(`The ${driver.kind} driver cannot ${grant}.`);
  }
  return fn as NonNullable<DomainDriver[K]>;
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listDomains(userId: string): Promise<ManagedDomain[]> {
  const rows = await query<DomainRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM mail_domains WHERE user_id = $1 ORDER BY domain`,
    [userId],
  );
  return rows.map(toDomain);
}

export async function getDomain(userId: string, id: string): Promise<ManagedDomain> {
  const row = await one<DomainRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM mail_domains WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  if (!row) throw notFound('Domain');
  return toDomain(row);
}

/**
 * Ask the mail server what it is and what it permits, and cache the answer.
 *
 * The cached `server_grants` is what lets the settings screen grey out a switch
 * the server will refuse instead of offering a button that fails. It is a
 * snapshot, never a permission: nothing reads it to decide whether to proceed.
 */
export async function probeDomain(
  userId: string,
  id: string,
  actor: Actor,
): Promise<DomainProbe> {
  const { row, driver, ctx } = await load(userId, id, null);

  try {
    const result = await driver.probe(ctx);
    await query(
      `UPDATE mail_domains
          SET status = 'ok', error = NULL, server_grants = $3::text[], last_checked_at = now()
        WHERE user_id = $1 AND id = $2`,
      [userId, id, result.serverGrants],
    );
    await record(userId, row.domain, 'probe', row.domain, 'ok', null, actor);
    return { status: 'ok', error: null, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A refusal means the server is reachable and working; anything else means
    // it is not. Recorded differently because the operator's next move differs.
    const status: DomainStatus =
      err instanceof AppError && err.status === 403 ? 'error' : 'unreachable';
    await query(
      `UPDATE mail_domains SET status = $3, error = $4, last_checked_at = now()
        WHERE user_id = $1 AND id = $2`,
      [userId, id, status, message],
    );
    await record(userId, row.domain, 'probe', row.domain, 'failed', message, actor);
    return {
      status,
      error: message,
      postfix: null,
      dovecot: null,
      parity: true,
      serverGrants: asGrants(row.server_grants),
    };
  }
}

/**
 * The addresses the mail server has for this domain.
 *
 * `linked` is filled in here rather than by the driver: whether an address is
 * already being synced is a fact about this application, and a driver has no
 * business knowing it.
 */
export async function listMailboxes(userId: string, id: string): Promise<ManagedMailbox[]> {
  const { row, driver, ctx } = await load(userId, id, 'list');
  const boxes = await driver.list(ctx);

  const linked = new Set(
    (
      await query<{ address: string }>(
        'SELECT lower(address) AS address FROM accounts WHERE user_id = $1 AND domain = $2',
        [userId, row.domain],
      )
    ).map((r) => r.address),
  );

  return boxes.map((b) => ({ ...b, linked: linked.has(b.address.toLowerCase()) }));
}

export async function listAliases(userId: string, id: string): Promise<ManagedAlias[]> {
  const { driver, ctx } = await load(userId, id, 'alias');
  return must(driver, 'listAliases', 'alias').call(driver, ctx);
}

export async function listOps(userId: string, limit = 100): Promise<DomainOp[]> {
  const rows = await query<{
    id: number;
    domain: string;
    action: string;
    target: string;
    status: string;
    detail: string | null;
    actor: string;
    created_at: Date;
  }>(
    `SELECT id, domain, action, target, status, detail, actor, created_at
       FROM domain_ops WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    action: r.action,
    target: r.target,
    status: r.status === 'ok' ? 'ok' : 'failed',
    detail: r.detail,
    actor: r.actor,
    createdAt: r.created_at.toISOString(),
  }));
}

/* ── Writes on the mail server ───────────────────────────────────────────── */

export async function createMailbox(
  userId: string,
  id: string,
  input: { localpart: string; password: string },
  actor: Actor,
): Promise<ManagedMailbox> {
  const { row, driver, ctx } = await load(userId, id, 'create');
  const create = must(driver, 'create', 'create');
  const address = `${input.localpart}@${row.domain}`;

  await audited(userId, row.domain, 'create', address, actor, () =>
    create.call(driver, ctx, input),
  );

  return { localpart: input.localpart, address, linked: false };
}

export async function removeMailbox(
  userId: string,
  id: string,
  input: { localpart: string; purge: boolean },
  actor: Actor,
): Promise<void> {
  // Two grants, checked separately, because they are two decisions. Retiring an
  // address is reversible by recreating it; destroying its mail is not.
  const { row, driver, ctx } = await load(userId, id, input.purge ? 'purge' : 'delete');
  if (input.purge && !asGrants(row.grants).includes('delete')) {
    throw forbidden(`'delete' is not granted for ${row.domain}.`);
  }
  const remove = must(driver, 'remove', 'delete');
  const address = `${input.localpart}@${row.domain}`;

  await audited(userId, row.domain, input.purge ? 'delete-purge' : 'delete', address, actor, () =>
    remove.call(driver, ctx, input),
  );
}

export async function setMailboxPassword(
  userId: string,
  id: string,
  input: { localpart: string; password: string },
  actor: Actor,
): Promise<void> {
  const { row, driver, ctx } = await load(userId, id, 'password');
  const setPassword = must(driver, 'setPassword', 'password');
  const address = `${input.localpart}@${row.domain}`;

  await audited(userId, row.domain, 'password', address, actor, () =>
    setPassword.call(driver, ctx, input),
  );
}

export async function addAlias(
  userId: string,
  id: string,
  input: { localpart: string; target: string },
  actor: Actor,
): Promise<void> {
  const { row, driver, ctx } = await load(userId, id, 'alias');
  const add = must(driver, 'addAlias', 'alias');
  const address = `${input.localpart}@${row.domain}`;

  await audited(userId, row.domain, 'alias-add', address, actor, () =>
    add.call(driver, ctx, input),
  );
}

export async function removeAlias(
  userId: string,
  id: string,
  input: { localpart: string },
  actor: Actor,
): Promise<void> {
  const { row, driver, ctx } = await load(userId, id, 'alias');
  const del = must(driver, 'removeAlias', 'alias');
  const address = `${input.localpart}@${row.domain}`;

  await audited(userId, row.domain, 'alias-del', address, actor, () =>
    del.call(driver, ctx, input),
  );
}

/* ── Configuration ───────────────────────────────────────────────────────── */

/**
 * Read a mail server's SSH host key so it can be pinned.
 *
 * Wrapped rather than re-exporting `scanHostKey`, so that the guard below is
 * not something a caller can forget. Both the HTTP route and the CLI come
 * through here.
 */
export async function readHostKey(host: string, port = 22): Promise<string> {
  await assertPublicHost(host, `The mail server ${host}`);
  return scanHostKey(host, port);
}

export async function connectDomain(
  userId: string,
  input: {
    domain: string;
    driver: string;
    host: string;
    port?: number;
    user?: string;
    hostKey?: string | null;
    privateKey: string;
  },
): Promise<ManagedDomain> {
  const domain = input.domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) throw badRequest(`'${input.domain}' is not a domain name`);

  // net-guard.ts is explicit that every host taken from outside this process
  // comes through it, "because a guard that can be spelled around is not a
  // guard". This is the fourth such call site. ALLOW_PRIVATE_IMAP_HOSTS is the
  // opt-out, and a mail server on a LAN or a tailnet is the normal case here.
  await assertPublicHost(input.host.trim(), `The mail server ${input.host.trim()}`);

  const driver = driverFor(input.driver);
  if (!driver) throw badRequest(`Unknown driver '${input.driver}'`);

  if (!input.privateKey.includes('PRIVATE KEY')) {
    throw badRequest('That does not look like an SSH private key. Paste the whole file.');
  }

  const existing = await one<{ id: string }>(
    'SELECT id FROM mail_domains WHERE user_id = $1 AND domain = $2',
    [userId, domain],
  );
  if (existing) throw badRequest(`${domain} is already connected`);

  const sealed = seal(input.privateKey);
  const row = await one<DomainRow>(
    `INSERT INTO mail_domains
       (user_id, domain, driver, config,
        secret_ciphertext, secret_nonce, secret_tag, secret_key_version)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      userId,
      domain,
      input.driver,
      JSON.stringify({
        host: input.host.trim(),
        port: input.port ?? 22,
        user: input.user?.trim() || 'mailprov',
        hostKey: input.hostKey ?? null,
      }),
      sealed.ciphertext,
      sealed.nonce,
      sealed.tag,
      sealed.keyVersion,
    ],
  );
  // `grants` is left at its default of none. Connecting a domain is not
  // granting anything, and making that a separate deliberate step is the point.
  return toDomain(row!);
}

export async function updateDomain(
  userId: string,
  id: string,
  patch: {
    grants?: string[];
    host?: string;
    port?: number;
    user?: string;
    hostKey?: string | null;
    privateKey?: string;
  },
): Promise<ManagedDomain> {
  const current = await one<DomainRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM mail_domains WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  if (!current) throw notFound('Domain');

  const sets: string[] = [];
  const values: unknown[] = [userId, id];
  const bind = (v: unknown) => `$${values.push(v)}`;

  if (patch.grants !== undefined) {
    const unknown = patch.grants.filter((g) => !isDomainGrant(g));
    if (unknown.length) {
      throw badRequest(
        `Unknown grant(s): ${unknown.join(', ')}. Valid: ${DOMAIN_GRANTS.join(', ')}`,
      );
    }
    // Purge without delete is unreachable — the delete path is the only thing
    // that purges — so it is refused here rather than left as a switch that
    // silently does nothing.
    if (patch.grants.includes('purge') && !patch.grants.includes('delete')) {
      throw badRequest("'purge' needs 'delete' as well: it is what removing an address does.");
    }
    sets.push(`grants = ${bind(patch.grants)}::text[]`);
  }

  const configPatch: Record<string, unknown> = {};
  if (patch.host !== undefined) {
    // Re-checked on change: a domain may be repointed at a new machine, and the
    // guard has to apply to that one too.
    await assertPublicHost(patch.host.trim(), `The mail server ${patch.host.trim()}`);
    configPatch.host = patch.host.trim();
  }
  if (patch.port !== undefined) configPatch.port = patch.port;
  if (patch.user !== undefined) configPatch.user = patch.user.trim();
  if (patch.hostKey !== undefined) configPatch.hostKey = patch.hostKey;
  if (Object.keys(configPatch).length) {
    sets.push(`config = config || ${bind(JSON.stringify(configPatch))}::jsonb`);
    // Connection detail changed, so the cached verdict is about a server that
    // may no longer be the one this points at.
    sets.push(`status = 'pending'`, `server_grants = '{}'::text[]`, `last_checked_at = NULL`);
  }

  if (patch.privateKey !== undefined) {
    if (!patch.privateKey.includes('PRIVATE KEY')) {
      throw badRequest('That does not look like an SSH private key. Paste the whole file.');
    }
    const sealed = seal(patch.privateKey);
    sets.push(
      `secret_ciphertext = ${bind(sealed.ciphertext)}`,
      `secret_nonce = ${bind(sealed.nonce)}`,
      `secret_tag = ${bind(sealed.tag)}`,
      `secret_key_version = ${bind(sealed.keyVersion)}`,
    );
  }

  if (!sets.length) throw badRequest('Nothing to update');

  const row = await one<DomainRow>(
    `UPDATE mail_domains SET ${sets.join(', ')}
      WHERE user_id = $1 AND id = $2 RETURNING ${PUBLIC_COLUMNS}`,
    values,
  );
  return toDomain(row!);
}

/**
 * Forget a domain.
 *
 * App-side only. It removes a credential and a set of permissions from this
 * database; it does not touch a mailbox, an address, or a byte of mail. Worth
 * being explicit about, because "delete domain" is a phrase that could
 * reasonably mean something far worse.
 */
export async function disconnectDomain(userId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>(
    'DELETE FROM mail_domains WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, id],
  );
  if (!rows.length) throw notFound('Domain');
}
