/**
 * IMAP connection pool.
 *
 * Bounded on purpose. The app host is usually small and shared, and Dovecot's
 * `mail_max_userip_connections` defaults to 10 — an unbounded
 * "one connection per account, always" design would trip both. Connections are
 * leased, used, and returned; idle ones are reaped.
 */

import { ImapFlow, type Logger } from 'imapflow';
import { config } from '../config.ts';
import { open } from '../lib/crypto.ts';
import { upstream } from '../lib/errors.ts';
import { assertPublicHost } from '../lib/net-guard.ts';

export interface AccountCredentials {
  id: string;
  address: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: 'tls' | 'starttls' | 'none';
  username: string;
  secretCiphertext: Buffer;
  secretNonce: Buffer;
  secretTag: Buffer;
  secretKeyVersion: number;
}

const inFlight = new Map<string, number>();
let globalInFlight = 0;

/**
 * Resolve a mail hostname to its override address, if configured.
 *
 * This is what lets traffic go over Tailscale while TLS still validates: the
 * connection targets the private address, but SNI and certificate checking use
 * the real hostname. See docs/architecture.md.
 */
function resolveHost(host: string): { host: string; servername: string } {
  const override = config.imap.hostOverrides.get(host);
  return override ? { host: override, servername: host } : { host, servername: host };
}

/**
 * Guards every path that connects to a user-supplied mail server.
 *
 * Async because it resolves the name first. It used to be a synchronous match
 * against the *string*, which meant `2130706433`, `0x7f000001` and any public
 * DNS record pointing at 127.0.0.1 walked straight through it. See net-guard.ts.
 */
export async function assertHostAllowed(host: string): Promise<void> {
  await assertPublicHost(host, `The mail server ${host}`);
}

/* ── What the server said no to ────────────────────────────────────────────── */

/**
 * The last refusal a connection heard, kept so replay can quote it.
 *
 * imapflow answers a refused STORE, MOVE or COPY with `false` and keeps the
 * server's own words to itself: every command in its `lib/commands` catches the
 * NO/BAD, hands the error to its logger, and returns. Under `logger: false`
 * that text is gone, which leaves sync/replay.ts parking an op as "the server
 * refused" — the same non-answer as "sync failed".
 *
 * Only the server's response text is kept, and nothing is written anywhere.
 * imapflow's lower log levels carry the LOGIN command and message bytes, and
 * this process does not put either into a log.
 */
interface Refusal {
  text: string | null;
}

const refusals = new WeakMap<ImapFlow, Refusal>();

function capturingLogger(slot: Refusal): Logger {
  const drop = (): void => {};
  const record = (entry: unknown): void => {
    const err = (entry as { err?: Record<string, unknown> } | null)?.err;
    if (!err) return;
    // `enhanceCommandError` puts the server's line on `response` and its
    // response code on `serverResponseCode`. Either alone is usable; together
    // they read like the server talking.
    const parts = [err.serverResponseCode, err.response ?? err.message].filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    if (parts.length) slot.text = parts.join(' ');
  };
  // `trace` and `fatal` are outside imapflow's `Logger` type but inside what it
  // calls. An absent `fatal` is `console.log`ged by its synthetic wrapper —
  // exactly the leak `logger: false` was there to prevent.
  const logger = { trace: drop, debug: drop, info: drop, warn: record, error: record, fatal: record };
  return logger;
}

/**
 * Take the last refusal recorded for this connection, clearing it.
 *
 * Cleared on read so a later op cannot inherit an earlier one's reason and park
 * itself with somebody else's error text.
 */
export function takeRefusal(client: ImapFlow): string | null {
  const slot = refusals.get(client);
  if (!slot?.text) return null;
  const text = slot.text;
  slot.text = null;
  return text;
}

export async function connect(creds: AccountCredentials): Promise<ImapFlow> {
  const { host, servername } = resolveHost(creds.imapHost);

  const refusal: Refusal = { text: null };
  const client = new ImapFlow({
    host,
    port: creds.imapPort,
    secure: creds.imapSecurity === 'tls',
    servername,
    auth: {
      user: creds.username,
      // Decrypted here and nowhere else. Held only for the life of this call.
      pass: open({
        ciphertext: creds.secretCiphertext,
        nonce: creds.secretNonce,
        tag: creds.secretTag,
        keyVersion: creds.secretKeyVersion,
      }),
    },
    // Not `false`: that also throws away the server's reason for refusing a
    // command, which replay needs. The logger below remembers that one string
    // and drops every other entry.
    logger: capturingLogger(refusal),
    // Never emit credentials or message contents into logs.
    emitLogs: false,
    tls: { servername, minVersion: 'TLSv1.2' },
    connectionTimeout: config.imap.connectTimeoutMs,
    greetingTimeout: config.imap.connectTimeoutMs,
  });

  refusals.set(client, refusal);

  await client.connect();
  if (creds.imapSecurity === 'starttls' && !client.secureConnection) {
    await client.logout();
    throw upstream('Server did not upgrade the connection to TLS');
  }
  return client;
}

/**
 * Lease a connection, run `fn`, always release.
 *
 * Waits rather than rejecting when at capacity — sync is background work and
 * backpressure is the correct response to a busy server.
 */
export async function withConnection<T>(
  creds: AccountCredentials,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  await waitForSlot(creds.id);
  let client: ImapFlow | null = null;
  try {
    client = await connect(creds);
    return await fn(client);
  } finally {
    releaseSlot(creds.id);
    if (client) await client.logout().catch(() => {});
  }
}

async function waitForSlot(accountId: string): Promise<void> {
  // Simple spin with backoff. A queue would be tidier but this contends on at
  // most a dozen accounts and never on the request path.
  for (let attempt = 0; ; attempt++) {
    const perAccount = inFlight.get(accountId) ?? 0;
    if (globalInFlight < config.imap.poolMax && perAccount < config.imap.perAccountMax) {
      globalInFlight++;
      inFlight.set(accountId, perAccount + 1);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(2000, 50 * 2 ** Math.min(attempt, 5))));
  }
}

function releaseSlot(accountId: string): void {
  globalInFlight = Math.max(0, globalInFlight - 1);
  const n = (inFlight.get(accountId) ?? 1) - 1;
  if (n <= 0) inFlight.delete(accountId);
  else inFlight.set(accountId, n);
}

export const poolStats = () => ({
  global: globalInFlight,
  perAccount: Object.fromEntries(inFlight),
  limits: { global: config.imap.poolMax, perAccount: config.imap.perAccountMax },
});
