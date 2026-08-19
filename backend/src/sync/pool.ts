/**
 * IMAP connection pool.
 *
 * Bounded on purpose. The app host is usually small and shared, and Dovecot's
 * `mail_max_userip_connections` defaults to 10 — an unbounded
 * "one connection per account, always" design would trip both. Connections are
 * leased, used, and returned; idle ones are reaped.
 */

import { ImapFlow } from 'imapflow';
import { config } from '../config.ts';
import { open } from '../lib/crypto.ts';
import { upstream } from '../lib/errors.ts';

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

/** Guards the verify endpoint, which takes a user-supplied host. */
export function assertHostAllowed(host: string): void {
  if (config.imap.allowPrivateHosts) return;
  const isPrivate =
    /^(10\.|127\.|0\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(localhost|::1|\[?::1\]?)$/i.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal');
  if (isPrivate) {
    throw upstream(
      `Refusing to connect to a private address (${host}). ` +
        'Set ALLOW_PRIVATE_IMAP_HOSTS=true if this is a self-hosted server on your own network.',
    );
  }
}

export async function connect(creds: AccountCredentials): Promise<ImapFlow> {
  const { host, servername } = resolveHost(creds.imapHost);

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
    logger: false,
    // Never emit credentials or message contents into logs.
    emitLogs: false,
    tls: { servername, minVersion: 'TLSv1.2' },
    connectionTimeout: config.imap.connectTimeoutMs,
    greetingTimeout: config.imap.connectTimeoutMs,
  });

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
