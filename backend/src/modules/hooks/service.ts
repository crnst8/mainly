/**
 * Mail hooks: a mail server that says which mailboxes changed.
 *
 * The server half is scripts/mainly-hook.lua, a Dovecot push_notification
 * driver installed by scripts/connect-mailhook.sh. It sends a login and
 * mailbox names. This half decides whether to believe it and which accounts
 * that means; sync/mail-hook.ts does the fetching.
 *
 * Trust is narrow on purpose. A hook token can do one thing: make this install
 * look at folders on the hosts the hook was created for, sooner than it would
 * have anyway. It cannot read, cannot write, cannot name a host, and a notice
 * about a login with no account here is accepted and ignored, so a holder
 * learns nothing about who has an account. Minting needs a shell on this host,
 * the same bar as an agent token (cli/hook.ts).
 */

import { createHash, randomBytes } from 'node:crypto';
import { one, query } from '../../db/index.ts';

const PREFIX = 'mh_';

/** A hook heard from within this long counts as working: accounts on its
 *  hosts are polled on the slow interval, as if on IDLE. A quiet server
 *  drops back to the normal interval until it next speaks. */
export const HOOK_LIVE_MS = 60 * 60_000;

/** `last_event_at` is written at most this often, not once per notice. */
const TOUCH_EVERY = '10 seconds';

const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export interface MailHook {
  id: string;
  hosts: string[];
}

export interface MailHookRecord extends MailHook {
  prefix: string;
  createdAt: string;
  lastEventAt: string | null;
}

/** What the Lua driver sends. Validated by the route's schema. */
export interface HookNotice {
  user: string;
  mailboxes: string[];
  folders: boolean;
}

const normaliseHosts = (hosts: string[]): string[] => [
  ...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)),
];

/**
 * Resolve a presented token, or null, and note that the hook is alive.
 *
 * One round trip: the touch is a CTE that matches nothing when the last write
 * was recent, so a burst of notices costs one write, not one each.
 */
export async function hookForToken(presented: string): Promise<MailHook | null> {
  if (!presented.startsWith(PREFIX) || presented.length > 128) return null;
  return one<MailHook>(
    `WITH hook AS (SELECT id, hosts FROM mail_hooks WHERE token_hash = $1),
          touched AS (
            UPDATE mail_hooks m SET last_event_at = now()
              FROM hook
             WHERE m.id = hook.id
               AND (m.last_event_at IS NULL OR m.last_event_at < now() - $2::interval)
          )
     SELECT id, hosts FROM hook`,
    [digest(presented), TOUCH_EVERY],
  );
}

/**
 * Create a hook for these hosts. Returns the token exactly once.
 *
 * With `replace`, hooks already covering any of the hosts are removed first —
 * that is how running the installer again renews the token. Without it, an
 * overlap is refused: two hooks for one host means one of them is stale and
 * nobody knows which.
 */
export async function createHook(
  hostsIn: string[],
  opts: { replace?: boolean } = {},
): Promise<{ token: string; record: MailHookRecord }> {
  const hosts = normaliseHosts(hostsIn);
  if (!hosts.length) throw new Error('Name at least one IMAP host');
  for (const h of hosts) {
    if (!/^[a-z0-9.-]+$/.test(h)) throw new Error(`Not a hostname: ${h}`);
  }
  const overlapping = await query<{ id: string }>(
    'SELECT id FROM mail_hooks WHERE hosts && $1::text[]',
    [hosts],
  );
  if (overlapping.length && !opts.replace) {
    throw new Error('A hook already covers one of those hosts. Remove it first, or pass --replace.');
  }
  if (overlapping.length) {
    await query('DELETE FROM mail_hooks WHERE id = ANY($1::uuid[])', [overlapping.map((r) => r.id)]);
  }
  const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const row = await one<HookRow>(
    `INSERT INTO mail_hooks (hosts, token_hash, prefix) VALUES ($1::text[], $2, $3)
     RETURNING ${HOOK_COLUMNS}`,
    [hosts, digest(token), token.slice(0, PREFIX.length + 6)],
  );
  return { token, record: toRecord(row!) };
}

interface HookRow {
  id: string;
  hosts: string[];
  prefix: string;
  created_at: Date;
  last_event_at: Date | null;
}

const HOOK_COLUMNS = 'id, hosts, prefix, created_at, last_event_at';

const toRecord = (r: HookRow): MailHookRecord => ({
  id: r.id,
  hosts: r.hosts,
  prefix: r.prefix,
  createdAt: r.created_at.toISOString(),
  lastEventAt: r.last_event_at?.toISOString() ?? null,
});

export async function listHooks(): Promise<MailHookRecord[]> {
  const rows = await query<HookRow>(`SELECT ${HOOK_COLUMNS} FROM mail_hooks ORDER BY created_at`);
  return rows.map(toRecord);
}

/** Remove by id, or every hook covering a host. Returns how many went. */
export async function removeHooks(idOrHost: string): Promise<number> {
  const isId = /^[0-9a-f-]{36}$/i.test(idOrHost);
  const rows = await query<{ id: string }>(
    isId
      ? 'DELETE FROM mail_hooks WHERE id = $1::uuid RETURNING id'
      : 'DELETE FROM mail_hooks WHERE $1 = ANY(hosts) RETURNING id',
    [isId ? idOrHost : idOrHost.toLowerCase()],
  );
  return rows.length;
}

/** The IMAP hosts accounts here use, busiest first. The installer offers
 *  these when it is not told which hosts the mail server answers to. */
export async function accountHosts(): Promise<{ host: string; accounts: number }[]> {
  return query<{ host: string; accounts: number }>(
    `SELECT lower(imap_host) AS host, count(*)::int AS accounts
       FROM accounts GROUP BY 1 ORDER BY 2 DESC, 1`,
  );
}

/** One login on these hosts, for the installer's end-to-end test. */
export async function loginOn(hostsIn: string[]): Promise<string | null> {
  const row = await one<{ username: string }>(
    `SELECT username FROM accounts
      WHERE lower(imap_host) = ANY($1::text[]) AND status IN ('ok', 'syncing')
      ORDER BY created_at LIMIT 1`,
    [normaliseHosts(hostsIn)],
  );
  return row?.username ?? null;
}
