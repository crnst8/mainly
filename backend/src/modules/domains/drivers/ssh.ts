/**
 * The SSH driver — a flat-file Postfix and Dovecot host, reached through a
 * forced command.
 *
 * The mail server runs `scripts/mainly-provision` from this repository, pinned
 * in `authorized_keys` so the key this driver holds can run that and nothing
 * else. Authorisation therefore lives on the mail server, in a config file this
 * application cannot write: a compromise here can ask for anything, and the
 * server still answers only for the domains and verbs its own allowlist names.
 * That is the whole reason for the helper's existence — see
 * docs/domain-control.md.
 *
 * `ssh2` rather than an `ssh` binary. The runtime image is node:22-alpine with
 * no openssh-client, and shipping one would mean managing a known_hosts file
 * inside a container. Here the host key is pinned explicitly in the domain's
 * config, verified in process, and visible in the settings screen — which is
 * the property known_hosts was approximating anyway.
 *
 * **Connections are reused for a few seconds, and that is not an optimisation.**
 * The obvious design — one connection per call — was what this did first, and it
 * is wrong for a reason that only shows up against a real server: sshd is
 * commonly socket-activated (the default on Ubuntu 24.04), and
 * `ssh.socket`'s `TriggerLimitBurst` refuses everything once ~20 connections
 * arrive within two seconds. A handful of provisioning calls in a row therefore
 * looks exactly like an attack, and the punishment lands on the operator's
 * ability to log in at all. Listing eight addresses after creating one must be
 * one connection, not nine.
 *
 * So: at most one live connection per host, closed after a short idle. Not a
 * pool holding a privileged connection open around the clock — a window just
 * long enough that a burst is a burst.
 */

import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';

import type { DomainGrant, ManagedAlias, ManagedMailbox } from '../../../contract/types.ts';
import { isDomainGrant } from '../../../contract/types.ts';
import { AppError, badRequest, upstream } from '../../../lib/errors.ts';
import type { DomainDriver, DriverContext, ProbeResult } from './types.ts';

/** Long enough for `postfix reload`, short enough that a wedged host does not
 *  hold an HTTP request open until the client gives up first. */
const TIMEOUT_MS = 20_000;

/** How long a connection lingers after the last call. Long enough to cover a
 *  create-then-list, or a person working through a list of addresses; short
 *  enough that an idle install holds nothing open. */
const IDLE_MS = 10_000;

/** The helper answers with one JSON object. This is a ceiling on a reply that
 *  should never exceed a few kilobytes, so a host that streams garbage cannot
 *  become a memory problem. */
const MAX_REPLY_BYTES = 256 * 1024;

interface SshConfig {
  host: string;
  port: number;
  user: string;
  /** `sha256:BASE64`, as printed by `ssh-keyscan … | ssh-keygen -lf -`.
   *  Null only between adding a domain and pinning its key. */
  hostKey: string | null;
}

/**
 * The helper's own error vocabulary, mapped to this application's.
 *
 * The distinctions matter to whoever reads the result. A refusal is a 403 and
 * not a 500: the mail server is working correctly and saying no, and the fix is
 * in an allowlist this application deliberately cannot edit. A state error is a
 * 409, fixed by looking at what already exists. Everything else is the upstream
 * server's problem, reported in its own words.
 */
function fromHelper(error: string | undefined, message: string): AppError {
  switch (error) {
    case 'domain_not_allowed':
    case 'verb_not_granted':
      return new AppError(403, 'server_refused', message);
    case 'already_exists':
    case 'not_found':
      return new AppError(409, 'conflict', message);
    case 'lock_busy':
      return new AppError(409, 'lock_busy', message);
    default:
      return upstream(message);
  }
}

function readConfig(raw: Record<string, unknown>): SshConfig {
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (!host) throw badRequest('This domain has no mail server host configured');
  const port = typeof raw.port === 'number' && raw.port > 0 ? raw.port : 22;
  const user = typeof raw.user === 'string' && raw.user ? raw.user : 'mailprov';
  const hostKey = typeof raw.hostKey === 'string' && raw.hostKey ? raw.hostKey : null;
  return { host, port, user, hostKey };
}

const fingerprintOf = (key: Buffer): string =>
  `sha256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/* ── Connection reuse ──────────────────────────────────────────────────────── */

interface Live {
  conn: Client;
  /** Calls currently using it. The idle timer only starts at zero. */
  refs: number;
  idle: NodeJS.Timeout | null;
  /** Reused only for the same credential. Two domains on one host with
   *  different keys are two connections, not one shared under whichever key
   *  happened to connect first. */
  fingerprint: string;
}

const live = new Map<string, Live>();

/**
 * What may share a connection.
 *
 * The pinned host key is part of the identity, not just of the handshake. Left
 * out — as it was at first — a call carrying a *wrong* host key, or none at
 * all, would be handed a connection someone else had already verified, and the
 * check it was supposed to fail would never run. Reuse must never be able to
 * launder a weaker trust setting into a stronger one, so two configs that
 * disagree about what they trust are two connections.
 */
const connKey = (cfg: SshConfig) =>
  `${cfg.user}@${cfg.host}:${cfg.port}|${cfg.hostKey ?? 'unpinned'}`;

function release(key: string) {
  const entry = live.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.idle = setTimeout(() => {
    // Re-checked: a call may have arrived and taken a reference while the timer
    // was pending.
    const current = live.get(key);
    if (!current || current.refs > 0) return;
    live.delete(key);
    current.conn.end();
  }, IDLE_MS);
  entry.idle.unref();
}

function evict(key: string, entry: Live) {
  if (live.get(key) !== entry) return;
  live.delete(key);
  if (entry.idle) clearTimeout(entry.idle);
  entry.conn.end();
}

/** An open, authenticated connection — reused when one is already there. */
function connect(cfg: SshConfig, secret: string): Promise<{ conn: Client; key: string }> {
  // Refused here rather than only in `hostVerifier`, which runs on a handshake
  // and so would never see a call that reused an existing connection.
  if (!cfg.hostKey) {
    return Promise.reject(
      upstream(
        `No host key is pinned for ${cfg.host}, so its identity cannot be checked. ` +
          'Re-add the domain, or set one in Settings → Mail server.',
      ),
    );
  }
  const key = connKey(cfg);
  const fingerprint = createHash('sha256').update(secret).digest('base64');
  const existing = live.get(key);

  if (existing && existing.fingerprint === fingerprint) {
    if (existing.idle) {
      clearTimeout(existing.idle);
      existing.idle = null;
    }
    existing.refs++;
    return Promise.resolve({ conn: existing.conn, key });
  }
  // A different credential for the same host: the old one is not ours to reuse.
  if (existing) evict(key, existing);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(upstream(`${cfg.host} did not answer within ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    timer.unref();

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const entry: Live = { conn, refs: 1, idle: null, fingerprint };
      live.set(key, entry);
      // A connection the server closes, or that breaks, must not be handed to
      // the next call as though it were healthy.
      conn.on('close', () => evict(key, entry));
      conn.on('end', () => evict(key, entry));
      resolve({ conn, key });
    });

    conn.on('error', (err: Error) => {
      const entry = live.get(key);
      if (entry?.conn === conn) evict(key, entry);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(upstream(`${cfg.host}: ${err.message}`));
    });

    try {
      conn.connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.user,
        privateKey: secret,
        readyTimeout: TIMEOUT_MS,
        // Only the key. Never fall back to asking for a password, which for an
        // unattended process means hanging until the timeout.
        tryKeyboard: false,
        hostVerifier: (hostKey: Buffer) => {
          // Trust on first use is a decision for the operator to make once, in
          // the settings screen, rather than something this does silently on
          // every connection. Unpinned means unverified means refused.
          if (!cfg.hostKey) return false;
          return fingerprintOf(hostKey) === cfg.hostKey;
        },
      } satisfies ConnectConfig);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(upstream((err as Error).message));
    }
  });
}

interface HelperReply {
  ok: boolean;
  error?: string;
  detail?: string;
  [key: string]: unknown;
}

/**
 * One request over a shared connection.
 *
 * The verb goes on stdin rather than in `SSH_ORIGINAL_COMMAND` because the
 * forced command runs under `sudo`, whose `env_reset` would drop it. Any secret
 * follows on the next line — never in argv, which is world-readable on the mail
 * host for as long as the process lives.
 *
 * Each call is its own SSH channel, so concurrent calls do not queue behind one
 * another; only the connection underneath them is shared.
 */
async function call(ctx: DriverContext, verb: string, secret?: string): Promise<HelperReply> {
  const cfg = readConfig(ctx.config);
  const { conn, key } = await connect(cfg, ctx.secret);

  try {
    return await new Promise<HelperReply>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timer = setTimeout(
        () =>
          finish(() =>
            reject(upstream(`${cfg.host} did not answer within ${TIMEOUT_MS / 1000}s`)),
          ),
        TIMEOUT_MS,
      );
      timer.unref();

      // No command: the forced command in authorized_keys supplies it. A host
      // that has not been set up that way drops to a shell instead, which is
      // why the reply is parsed strictly rather than scanned for JSON.
      conn.exec('', (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return finish(() => reject(upstream(err.message)));
        }

        let out = '';
        let over = false;

        stream.on('data', (chunk: Buffer) => {
          if (over) return;
          out += chunk.toString('utf8');
          if (out.length > MAX_REPLY_BYTES) {
            over = true;
            clearTimeout(timer);
            finish(() => reject(upstream(`${cfg.host} sent an implausibly large reply`)));
          }
        });

        // stderr is read and discarded. sudo and sshd both write notices there
        // that are not errors, and the helper puts everything that matters in
        // its JSON.
        stream.stderr.resume();

        stream.on('close', () => {
          clearTimeout(timer);
          if (over) return;
          finish(() => {
            const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
            if (!line.startsWith('{')) {
              return reject(
                upstream(
                  `${cfg.host} did not answer with a provisioning reply. Is mainly-provision ` +
                    'installed and set as the forced command for this key?',
                ),
              );
            }
            let reply: HelperReply;
            try {
              reply = JSON.parse(line) as HelperReply;
            } catch {
              return reject(upstream(`${cfg.host} sent a reply that is not JSON`));
            }
            if (reply.ok) return resolve(reply);

            const message = reply.detail || reply.error || 'the mail server refused';
            return reject(fromHelper(reply.error, message));
          });
        });

        stream.write(`${verb}\n`);
        if (secret !== undefined) stream.write(`${secret}\n`);
        stream.end();
      });
    });
  } finally {
    // Always, including on a refusal: a 403 from the helper is a healthy
    // connection that said no, and dropping it would mean the next call pays
    // for a handshake the server is already counting against us.
    release(key);
  }
}

const asGrants = (v: unknown): DomainGrant[] =>
  Array.isArray(v) ? v.filter((g): g is DomainGrant => typeof g === 'string' && isDomainGrant(g)) : [];

/**
 * Fetch a host key so the operator can pin it.
 *
 * Deliberately separate from every other call and never used implicitly: this
 * is the one moment the connection is unauthenticated, and it exists so that
 * moment is a visible step someone approves rather than a silent default.
 */
export function scanHostKey(host: string, port = 22): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let found: string | null = null;
    const timer = setTimeout(() => {
      conn.end();
      reject(upstream(`${host} did not answer within ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    timer.unref();

    conn.on('error', () => {
      clearTimeout(timer);
      // Authentication is expected to fail — no credential is offered. The key
      // arrives during the handshake, before that, which is all this wants.
      if (found) resolve(found);
      else reject(upstream(`Could not read a host key from ${host}:${port}`));
    });
    conn.connect({
      host,
      port,
      username: 'mainly-hostkey-scan',
      hostVerifier: (key: Buffer) => {
        found = fingerprintOf(key);
        // Refuse the connection: the key is all that was wanted, and going
        // further would be an authentication attempt nobody asked for.
        return false;
      },
    });
  });
}

export const sshDriver: DomainDriver = {
  kind: 'ssh',

  capabilities: () => ['list', 'create', 'delete', 'password', 'alias', 'purge'],

  async probe(ctx): Promise<ProbeResult> {
    const reply = await call(ctx, 'probe');
    const domains = Array.isArray(reply.domains) ? reply.domains : [];
    const mine = domains.find(
      (d): d is { domain: string; grants: unknown } =>
        typeof d === 'object' && d !== null && (d as { domain?: unknown }).domain === ctx.domain,
    );
    return {
      postfix: typeof reply.postfix === 'string' ? reply.postfix : null,
      dovecot: typeof reply.dovecot === 'string' ? reply.dovecot : null,
      // Absent from an older helper is not the same as false; only an explicit
      // false is a broken host.
      parity: reply.parity !== false,
      serverGrants: mine ? asGrants(mine.grants) : [],
    };
  },

  async list(ctx): Promise<ManagedMailbox[]> {
    const reply = await call(ctx, `list ${ctx.domain}`);
    const boxes = Array.isArray(reply.mailboxes) ? reply.mailboxes : [];
    return boxes
      .filter((b): b is string => typeof b === 'string')
      .map((localpart) => ({
        localpart,
        address: `${localpart}@${ctx.domain}`,
        // Filled in by the service, which is the half that knows about accounts.
        linked: false,
      }));
  },

  async create(ctx, { localpart, password }) {
    await call(ctx, `create ${localpart} ${ctx.domain}`, password);
  },

  async remove(ctx, { localpart, purge }) {
    await call(ctx, `delete ${localpart} ${ctx.domain}${purge ? ' --purge' : ''}`);
  },

  async setPassword(ctx, { localpart, password }) {
    await call(ctx, `password ${localpart} ${ctx.domain}`, password);
  },

  async listAliases(ctx): Promise<ManagedAlias[]> {
    const reply = await call(ctx, `alias-list ${ctx.domain}`);
    const rows = Array.isArray(reply.aliases) ? reply.aliases : [];
    return rows
      .filter(
        (a): a is { alias: string; target: string } =>
          typeof a === 'object' &&
          a !== null &&
          typeof (a as { alias?: unknown }).alias === 'string' &&
          typeof (a as { target?: unknown }).target === 'string',
      )
      .map((a) => ({ alias: a.alias, target: a.target }));
  },

  async addAlias(ctx, { localpart, target }) {
    await call(ctx, `alias-add ${localpart} ${ctx.domain} ${target}`);
  },

  async removeAlias(ctx, { localpart }) {
    await call(ctx, `alias-del ${localpart} ${ctx.domain}`);
  },
};
