/**
 * IMAP IDLE. Push, so new mail appears without anyone pressing anything.
 *
 * One long-lived connection per account, parked on its INBOX. When the server
 * says `EXISTS` or `EXPUNGE`, the envelope pass runs for that one folder — not
 * the whole account, which would turn every incoming message into a full
 * mailbox scan.
 *
 * Bounded, because the alternative does not survive contact with a real
 * deployment. Dovecot's `mail_max_userip_connections` defaults to 10, the app
 * host is usually small and shared, and a user here may have dozens of
 * mailboxes. So `IMAP_IDLE_MAX_ACCOUNTS` connections are held and everything
 * else polls on the normal interval. Which accounts get one is not arbitrary:
 * priority order, muted last, because a connection spent watching a muted
 * newsletter mailbox is a connection not watching the inbox that matters.
 *
 * imapflow keeps IDLE running on an otherwise-idle connection by itself, and
 * re-issues it after each command. The work here is holding the connection open,
 * noticing when it dies, and coming back.
 */

import type { ImapFlow } from 'imapflow';
import { query } from '../db/index.ts';
import { config } from '../config.ts';
import type { Priority } from '../contract/types.ts';
import { connect, type AccountCredentials } from './pool.ts';
import { syncEnvelopes } from './envelopes.ts';
import { refreshCounts, publishCounts } from './folders.ts';
import { refreshAccountThreads } from './threads.ts';
import { publish } from '../modules/events/bus.ts';

/** Wait before reconnecting a dropped watcher, doubling to a ceiling. A server
 *  that is down should not be hammered by 12 reconnect loops. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Collapse bursts: a delivery run can fire EXISTS several times in a second,
 *  and each one does not need its own fetch. */
const DEBOUNCE_MS = 1_500;

interface Watchable {
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
  inbox_path: string | null;
}

const credentialsOf = (r: Watchable): AccountCredentials => ({
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

class Watcher {
  private client: ImapFlow | null = null;
  private stopped = false;
  private backoff = RETRY_MIN_MS;
  private debounce: NodeJS.Timeout | null = null;
  private syncing = false;
  private dirty = false;

  // Declared and assigned explicitly. Node runs these sources with type
  // stripping, which erases annotations but cannot synthesise the assignments a
  // constructor parameter property implies — the same reason lib/errors.ts does
  // it this way. Typecheck passes either way; only running it catches this.
  private readonly row: Watchable;
  private readonly path: string;

  constructor(row: Watchable, path: string) {
    this.row = row;
    this.path = path;
  }

  get accountId(): string {
    return this.row.id;
  }

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    const client = this.client;
    this.client = null;
    if (client) await client.logout().catch(() => {});
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.watch();
        // A clean return means the connection closed without erroring, which is
        // normal — servers cycle IDLE connections. Reconnect promptly.
        this.backoff = RETRY_MIN_MS;
      } catch (err) {
        if (this.stopped) return;
        console.warn(
          { account: this.row.address, err: (err as Error).message },
          'idle watcher dropped',
        );
        // An account whose password is wrong must not be retried on a five
        // second loop; that is how a mailbox gets locked out. Hand it back to
        // the polling path instead.
        if (/authenticat|credential|login/i.test((err as Error).message)) {
          console.warn({ account: this.row.address }, 'idle watcher stopping: credential rejected');
          return;
        }
        this.backoff = Math.min(RETRY_MAX_MS, this.backoff * 2);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.backoff));
    }
  }

  private async watch(): Promise<void> {
    const client = await connect(credentialsOf(this.row));
    this.client = client;

    // Read-only: opening the inbox read-write clears `\Recent` for everything in
    // it, and a watcher must not change state just by watching.
    await client.mailboxOpen(this.path, { readOnly: true });

    const wake = () => this.schedule();
    client.on('exists', wake);
    client.on('expunge', wake);
    client.on('flags', wake);

    // Resolve when the connection goes away; imapflow keeps IDLE alive itself
    // while nothing else is using the connection.
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });

    this.client = null;
    await client.logout().catch(() => {});
  }

  /** Coalesce a burst of notifications into one pass. */
  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    // A notification arriving mid-pass is remembered rather than dropped: the
    // fetch already in flight may have read the mailbox before the new message
    // landed in it.
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.dirty = false;
        const result = await syncEnvelopes(
          credentialsOf(this.row),
          this.row.user_id,
          this.row.priority,
          // This folder only. A push about the inbox is not a reason to re-scan
          // an archive of forty thousand messages.
          { folderPaths: [this.path] },
        );
        if (result.indexed || result.updated || result.removed) {
          await refreshCounts(this.row.id);
          await refreshAccountThreads(this.row.id);
          publish(this.row.user_id, { type: 'messages:changed', ids: [], patch: {} });
          await publishCounts(this.row.user_id, this.row.id);
          console.log({ account: this.row.address, ...result }, 'idle pass indexed new mail');
        }
      } while (this.dirty);
    } catch (err) {
      console.warn(
        { account: this.row.address, err: (err as Error).message },
        'idle-triggered sync failed',
      );
    } finally {
      this.syncing = false;
    }
  }
}

/* ── Supervisor ────────────────────────────────────────────────────────────── */

const watchers = new Map<string, Watcher>();
let timer: NodeJS.Timeout | null = null;

/**
 * Which accounts deserve a held connection.
 *
 * `priority DESC` puts critical first and muted last, so the cap spends
 * connections where mail matters. Accounts with no inbox row yet — never
 * synced — are excluded: there is nothing to open.
 */
async function pickWatchable(): Promise<Watchable[]> {
  return query<Watchable>(
    `SELECT a.id, a.user_id, a.address, a.priority,
            a.imap_host, a.imap_port, a.imap_security, a.username,
            a.secret_ciphertext, a.secret_nonce, a.secret_tag, a.secret_key_version,
            (SELECT f.path FROM folders f
              WHERE f.account_id = a.id AND f.role = 'inbox'
              ORDER BY f.position LIMIT 1) AS inbox_path
       FROM accounts a
      WHERE a.status IN ('ok', 'syncing')
      ORDER BY a.priority DESC, a.position
      LIMIT $1`,
    [config.imap.idleMaxAccounts],
  );
}

/** Reconcile held connections against the current answer, every minute. Accounts
 *  are added, removed, disabled and retiered while the process runs. */
async function reconcile(): Promise<void> {
  const wanted = await pickWatchable();
  const keep = new Set<string>();

  for (const row of wanted) {
    if (!row.inbox_path) continue;
    keep.add(row.id);
    if (watchers.has(row.id)) continue;
    const watcher = new Watcher(row, row.inbox_path);
    watchers.set(row.id, watcher);
    watcher.start();
  }

  for (const [id, watcher] of watchers) {
    if (keep.has(id)) continue;
    watchers.delete(id);
    await watcher.stop();
  }
}

export function startIdle(): void {
  if (timer) return;
  const tick = () => {
    void reconcile().catch((err) =>
      console.error({ err: (err as Error).message }, 'idle reconcile failed'),
    );
  };
  tick();
  timer = setInterval(tick, 60_000);
  console.log(`idle supervisor started (up to ${config.imap.idleMaxAccounts} connections)`);
}

export async function stopIdle(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const all = [...watchers.values()];
  watchers.clear();
  await Promise.all(all.map((w) => w.stop()));
}

export const idleStats = () => ({
  held: watchers.size,
  cap: config.imap.idleMaxAccounts,
  accounts: [...watchers.keys()],
});
