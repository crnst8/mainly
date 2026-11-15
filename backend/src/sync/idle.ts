/**
 * IMAP IDLE. Push, so new mail appears without anyone pressing anything.
 *
 * One long-lived connection per account, parked on its INBOX. When the server
 * says `EXISTS` or `EXPUNGE`, the envelope pass runs for that one folder — not
 * the whole account, which would turn every incoming message into a full
 * mailbox scan.
 *
 * Every account gets one by default, up to `IMAP_IDLE_MAX_ACCOUNTS` (100).
 * Dovecot's `mail_max_userip_connections` (default 10) is per login and client
 * IP, so one held connection per mailbox uses one of that mailbox's ten, not a
 * shared budget. A held connection costs a socket and little memory here, while
 * polling costs a login per account every `SYNC_INTERVAL_MS`, so push is the
 * cheaper of the two as well as the faster. The cap exists for servers or
 * firewalls that also limit connections per IP; past it, accounts poll. Which
 * accounts get one is not arbitrary: priority order, muted last.
 *
 * Push covers the inbox only. Watching another folder needs a second
 * connection (imapflow has no NOTIFY), so changes elsewhere are caught by the
 * `SYNC_IDLE_INTERVAL_MS` poll.
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
import { FolderPassScheduler } from './folder-pass.ts';

/** Wait before reconnecting a dropped watcher, doubling to a ceiling. A server
 *  that is down should not be hammered by 12 reconnect loops. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Gap between starting watchers. A restart with every account watched would
 *  otherwise open dozens of logins, and their catch-up passes, against the same
 *  mail server in the same second. */
const START_STAGGER_MS = 250;

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
  private passes: FolderPassScheduler;
  /** Parked on the inbox right now. The poll loop slows down only while this
   *  holds, so a watcher in backoff hands its account straight back to it. */
  live = false;

  // Declared and assigned explicitly. Node runs these sources with type
  // stripping, which erases annotations but cannot synthesise the assignments a
  // constructor parameter property implies — the same reason lib/errors.ts does
  // it this way. Typecheck passes either way; only running it catches this.
  private readonly row: Watchable;
  private readonly path: string;

  constructor(row: Watchable, path: string) {
    this.row = row;
    this.path = path;
    this.passes = new FolderPassScheduler(
      { creds: credentialsOf(row), userId: row.user_id, priority: row.priority },
      'idle',
    );
  }

  get accountId(): string {
    return this.row.id;
  }

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.live = false;
    this.passes.stop();
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
    // while nothing else is using the connection. Listeners go on before `live`
    // is set, so a connection that dies at once cannot leave it stuck true.
    const closed = new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });
    this.live = true;
    // Catch up once per (re)connect. While the poll loop treats this account as
    // pushed it polls slowly, so mail that landed between the last poll and
    // this IDLE starting would otherwise wait for the slow poll.
    this.schedule();
    await closed;
    this.live = false;

    this.client = null;
    await client.logout().catch(() => {});
  }

  /** Fetch the inbox. Bursts are coalesced by the scheduler. */
  private schedule(): void {
    this.passes.request([this.path]);
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

  let started = 0;
  for (const row of wanted) {
    if (!row.inbox_path) continue;
    keep.add(row.id);
    if (watchers.has(row.id)) continue;
    const watcher = new Watcher(row, row.inbox_path);
    watchers.set(row.id, watcher);
    // A watcher stopped before its turn exits on its first loop check.
    setTimeout(() => watcher.start(), started++ * START_STAGGER_MS);
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

/** Accounts whose inbox is on a live IDLE connection in this process. */
export function liveWatchers(): string[] {
  return [...watchers.values()].filter((w) => w.live).map((w) => w.accountId);
}

export const idleStats = () => ({
  held: watchers.size,
  cap: config.imap.idleMaxAccounts,
  accounts: [...watchers.keys()],
});
