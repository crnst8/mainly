/**
 * Environment parsed and validated at boot.
 */

const req = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
};

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} must be a number, got "${v}"`);
  return n;
};

/**
 * `TRUST_PROXY`: unset/`false` → trust nobody. A number → that many hops. `true`
 * → the whole chain. Anything else → a comma-separated list of proxy addresses
 * or CIDRs, which is what Fastify hands to proxy-addr.
 */
const trustProxy = (): boolean | number | string[] => {
  const v = process.env.TRUST_PROXY?.trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

const bool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  return v === undefined ? fallback : v === 'true' || v === '1';
};

/** host=ip,host=ip → Map. Keeps TLS hostname validation working while routing
 *  over a private network. See docs/architecture.md. */
const hostMap = (raw: string | undefined): Map<string, string> => {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',').filter(Boolean)) {
    const [host, ip] = pair.split('=');
    if (host && ip) map.set(host.trim(), ip.trim());
  }
  return map;
};

export type Role = 'api' | 'sync' | 'all';

const databasePoolMax = num('DATABASE_POOL_MAX', 10);
const syncMaxConcurrentAccounts = num(
  'SYNC_MAX_CONCURRENT_ACCOUNTS',
  Math.max(1, Math.min(4, databasePoolMax - 2)),
);
if (!Number.isInteger(databasePoolMax) || databasePoolMax < 2) {
  throw new Error('DATABASE_POOL_MAX must be an integer of at least 2');
}
if (
  !Number.isInteger(syncMaxConcurrentAccounts) ||
  syncMaxConcurrentAccounts < 1 ||
  syncMaxConcurrentAccounts >= databasePoolMax
) {
  throw new Error('SYNC_MAX_CONCURRENT_ACCOUNTS must be a positive integer below DATABASE_POOL_MAX');
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  get isProd() {
    return this.env === 'production';
  },
  role: (process.env.ROLE ?? 'all') as Role,
  port: num('PORT', 5274),
  host: process.env.HOST ?? '127.0.0.1',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5273',

  /* Who is allowed to tell us the client's IP.
     `X-Forwarded-For` is a header anyone can send. Trusting it unconditionally
     — which is what `trustProxy: true` does — makes `req.ip` attacker-chosen,
     and every rate limit keyed on it becomes one bucket per forged header. The
     login limiter is the one that matters: five attempts a minute is no limit
     at all if a new header is a new client.
     So: trust nothing by default, and let a deployment that really is behind a
     proxy say so. `1` is right for one reverse proxy; a CIDR list is right when
     the proxy's address is known. `true` is available and is only correct when
     nothing can reach the port except the proxy. */
  trustProxy: trustProxy(),

  /* Serve the built frontend from this process.
     Set, the API and the SPA are one origin and one container, which is the
     whole self-hosting story: `docker compose up` and open a port. Unset, the
     process is an API only and something else serves the static files — which
     is what a split `ROLE=api` deployment behind a CDN wants. */
  webRoot: process.env.WEB_ROOT ?? null,

  db: {
    url: req('DATABASE_URL'),
    poolMax: databasePoolMax,
  },

  secrets: {
    // Base64-encoded 32-byte AES key.
    key: (() => {
      const raw = Buffer.from(req('SECRET_KEY'), 'base64');
      if (raw.length !== 32) {
        throw new Error(`SECRET_KEY must decode to 32 bytes, got ${raw.length}`);
      }
      return raw;
    })(),
    keyVersion: num('SECRET_KEY_VERSION', 1),
    session: req('SESSION_SECRET'),
  },

  imap: {
    poolMax: num('IMAP_POOL_MAX', 8),
    perAccountMax: num('IMAP_PER_ACCOUNT_MAX', 2),
    connectTimeoutMs: num('IMAP_CONNECT_TIMEOUT_MS', 15_000),
    idleMaxAccounts: num('IMAP_IDLE_MAX_ACCOUNTS', 12),
    allowPrivateHosts: bool('ALLOW_PRIVATE_IMAP_HOSTS', false),
    hostOverrides: hostMap(process.env.MAIL_HOST_OVERRIDE),
  },

  sync: {
    maxConcurrentAccounts: syncMaxConcurrentAccounts,
    intervalMs: num('SYNC_INTERVAL_MS', 120_000),
    folderIntervalMs: num('SYNC_FOLDER_INTERVAL_MS', 600_000),
    bodyCacheTtlDays: num('BODY_CACHE_TTL_DAYS', 30),
  },

  redisUrl: process.env.REDIS_URL ?? null,
} as const;

export const servesHttp = config.role === 'api' || config.role === 'all';
export const runsSync = config.role === 'sync' || config.role === 'all';
