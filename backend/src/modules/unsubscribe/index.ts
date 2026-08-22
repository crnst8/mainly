/**
 * Unsubscribe planning and execution.
 * POST only RFC 8058 one-click HTTPS targets; reject non-public addresses and
 * redirects; record every outcome in `unsubscribe_attempts`.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';

import { config } from '../../config.ts';
import { one, query } from '../../db/index.ts';
import { open } from '../../lib/crypto.ts';
import { badRequest, notFound, upstream } from '../../lib/errors.ts';
import { ensureBody } from '../../sync/bodies.ts';
import { isOneClick, isPrivateAddress, parseListUnsubscribe } from './parse.ts';
import type {
  UnsubscribeAttempt,
  UnsubscribeOption,
  UnsubscribePlan,
  UnsubscribeResult,
} from '../../contract/types.ts';

/** A stranger's server gets one shot and a short one. */
const HTTP_TIMEOUT_MS = 10_000;

/* ── Planning ───────────────────────────────────────────────────────────────*/

interface MessageRow {
  id: string;
  account_id: string;
  from_name: string | null;
  from_address: string;
}

async function loadMessage(userId: string, messageId: string): Promise<MessageRow> {
  const row = await one<MessageRow>(
    `SELECT m.id, m.account_id, m.from_name, m.from_address
       FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = $2`,
    [userId, messageId],
  );
  if (!row) throw notFound('Message');
  return row;
}

async function historyFor(userId: string, fromAddress: string): Promise<UnsubscribeAttempt[]> {
  const rows = await query<{
    created_at: Date;
    method: string;
    target: string;
    status: string;
    detail: string | null;
    actor: string;
  }>(
    `SELECT created_at, method, target, status, detail, actor
       FROM unsubscribe_attempts
      WHERE user_id = $1 AND from_address = $2
      ORDER BY created_at DESC
      LIMIT 20`,
    [userId, fromAddress],
  );
  return rows.map((r) => ({
    at: r.created_at.toISOString(),
    method: r.method === 'mailto' ? 'mailto' : 'http',
    target: r.target,
    status: r.status === 'ok' ? 'ok' : 'failed',
    detail: r.detail,
    actor: r.actor,
  }));
}

/**
 * What could be done about this sender.
 *
 * `fresh` re-reads the headers from IMAP instead of trusting the body cache.
 * The preview does not need it; executing does, because `List-Unsubscribe-Post`
 * decides whether a POST is allowed and a cache row written before this feature
 * existed would not carry it.
 */
export async function planUnsubscribe(
  userId: string,
  messageId: string,
  opts: { fresh?: boolean } = {},
): Promise<UnsubscribePlan> {
  const message = await loadMessage(userId, messageId);
  const body = await ensureBody(userId, messageId, { refetch: opts.fresh });
  // Header fetch failures are distinct from an absent unsubscribe option.
  if (body?.error) throw upstream(body.error);
  const headers = body?.headers ?? {};

  const oneClick = isOneClick(headers['list-unsubscribe-post']);
  const options: UnsubscribeOption[] = parseListUnsubscribe(headers['list-unsubscribe']).map(
    (o): UnsubscribeOption => {
      if (o.method === 'mailto') return { method: 'mailto', target: o.target, automatic: true };
      if (!o.target.toLowerCase().startsWith('https://')) {
        return {
          method: 'http',
          target: o.target,
          automatic: false,
          blockedReason: 'The link is not HTTPS, so it is shown rather than followed.',
        };
      }
      return oneClick
        ? { method: 'http', target: o.target, automatic: true }
        : {
            method: 'http',
            target: o.target,
            automatic: false,
            blockedReason:
              'The sender did not mark this as one-click (RFC 8058), so it is a page to open rather than an endpoint to call.',
          };
    },
  );

  // One-click first, then mailto, then everything that needs a browser. This is
  // the order of preference the caller acts on when it does not name a target.
  options.sort((a, b) => Number(b.automatic) - Number(a.automatic) || (a.method === 'http' ? -1 : 1));

  return {
    messageId: message.id,
    accountId: message.account_id,
    from: { name: message.from_name, address: message.from_address },
    listId: headers['list-id'] ?? null,
    options,
    history: await historyFor(userId, message.from_address),
  };
}

/* ── SSRF guard ─────────────────────────────────────────────────────────────*/

/**
 * Refuse anything that is not a public HTTPS endpoint.
 *
 * The hostname is resolved and *every* answer is checked, not just the first —
 * a name with one public and one loopback record must not pass on a coin flip.
 *
 * Known limit, stated rather than hidden: this resolves, then `fetch` resolves
 * again, so a name that changes its answer in between could still slip through.
 * Closing that properly means dialling the checked IP with the original
 * hostname for TLS, which `undici` does not expose cleanly. The API binds to
 * loopback and this action is rare and audited, so the residual risk is
 * accepted here and written down rather than glossed over.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('That unsubscribe link is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw badRequest('Only HTTPS unsubscribe links are followed.');
  }
  if (config.imap.allowPrivateHosts) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw upstream(`Could not resolve ${host}.`);
      });

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw badRequest(
        `That unsubscribe link points at a private address (${address}). Refusing to follow it.`,
      );
    }
  }
  return url;
}

/* ── Execution ──────────────────────────────────────────────────────────────*/

interface SmtpRow {
  address: string;
  display_name: string | null;
  username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: 'tls' | 'starttls' | 'none';
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_key_version: number;
}

/**
 * Send the message the list asked for.
 *
 * `mailto:` may carry a subject and a body, and some lists require the exact
 * subject they published — so both are honoured when present, and the fallback
 * subject is the one every list processor recognises.
 */
async function sendMailto(userId: string, accountId: string, target: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw badRequest('That unsubscribe address is not a valid mailto: URL.');
  }
  const to = decodeURIComponent(url.pathname).trim();
  if (!to.includes('@')) throw badRequest('That mailto: link has no address.');

  const subject = url.searchParams.get('subject') ?? 'unsubscribe';
  const text = url.searchParams.get('body') ?? 'unsubscribe';

  const row = await one<SmtpRow>(
    `SELECT a.address, a.display_name, a.username,
            a.smtp_host, a.smtp_port, a.smtp_security,
            a.secret_ciphertext, a.secret_nonce, a.secret_tag, a.secret_key_version
       FROM accounts a
      WHERE a.user_id = $1 AND a.id = $2`,
    [userId, accountId],
  );
  if (!row) throw notFound('Account');

  const servername = row.smtp_host;
  const transport = nodemailer.createTransport({
    host: config.imap.hostOverrides.get(servername) ?? servername,
    port: row.smtp_port,
    secure: row.smtp_security === 'tls',
    requireTLS: row.smtp_security === 'starttls',
    auth: {
      user: row.username || row.address,
      // Decrypted here and nowhere else, for the life of this call.
      pass: open({
        ciphertext: row.secret_ciphertext,
        nonce: row.secret_nonce,
        tag: row.secret_tag,
        keyVersion: row.secret_key_version,
      }),
    },
    tls: { servername, minVersion: 'TLSv1.2' },
    connectionTimeout: config.imap.connectTimeoutMs,
  });

  try {
    const sent = await transport.sendMail({
      from: row.display_name ? `${row.display_name} <${row.address}>` : row.address,
      to,
      subject,
      text,
    });
    // Not filed in Sent. This is a machine-readable command to a list processor,
    // not correspondence, and putting it in the user's Sent folder is noise.
    return `Sent to ${to} (${(sent as { messageId?: string }).messageId ?? 'accepted'})`;
  } finally {
    transport.close();
  }
}

/** RFC 8058: POST `List-Unsubscribe=One-Click`, form-encoded, and nothing else. */
async function postOneClick(url: URL): Promise<string> {
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      // Not followed. A redirect is a second destination this app never checked,
      // and a 3xx here means the endpoint took the request anyway.
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal,
    });
  } catch (err) {
    throw upstream(`The unsubscribe endpoint did not answer: ${(err as Error).message}`);
  }
  if (res.status >= 400) {
    throw upstream(`The unsubscribe endpoint answered ${res.status}.`);
  }
  return `HTTP ${res.status}`;
}

async function record(input: {
  userId: string;
  messageId: string;
  accountId: string;
  fromAddress: string;
  listId: string | null;
  method: 'http' | 'mailto';
  target: string;
  status: 'ok' | 'failed';
  detail: string | null;
  actor: string;
}): Promise<void> {
  await query(
    `INSERT INTO unsubscribe_attempts
       (user_id, message_id, account_id, from_address, list_id, method, target, status, detail, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.userId,
      input.messageId,
      input.accountId,
      input.fromAddress,
      input.listId,
      input.method,
      input.target,
      input.status,
      input.detail,
      input.actor,
    ],
  );
}

/**
 * Do it.
 *
 * `confirm` is not politeness. There is no undo for this, the caller may be an
 * agent working from a list, and a required literal `true` is the difference
 * between "unsubscribe from that" and "unsubscribe from all forty of those
 * because the loop had an off-by-one".
 *
 * `target` picks one of the plan's options by its exact string. Omitted, the
 * best automatic option is used — and if there is none, nothing happens and the
 * result says why.
 */
export async function executeUnsubscribe(
  userId: string,
  messageId: string,
  opts: { confirm: boolean; target?: string; actor: string },
): Promise<UnsubscribeResult> {
  if (opts.confirm !== true) {
    throw badRequest('Unsubscribing cannot be undone, so it requires confirm: true.');
  }

  // Fresh headers, not the cache. See planUnsubscribe.
  const plan = await planUnsubscribe(userId, messageId, { fresh: true });

  if (!plan.options.length) {
    return {
      ok: false,
      method: 'http',
      target: '',
      detail: 'This message published no unsubscribe method.',
    };
  }

  const chosen = opts.target
    ? plan.options.find((o) => o.target === opts.target)
    : plan.options.find((o) => o.automatic);

  if (opts.target && !chosen) {
    throw badRequest('That target is not one of this message’s unsubscribe options.');
  }
  if (!chosen) {
    const manual = plan.options[0]!;
    return {
      ok: false,
      method: manual.method,
      target: manual.target,
      detail: manual.blockedReason ?? 'No option here can be actioned without a browser.',
    };
  }
  if (!chosen.automatic) {
    return {
      ok: false,
      method: chosen.method,
      target: chosen.target,
      detail: chosen.blockedReason ?? 'This option has to be opened in a browser.',
    };
  }

  const common = {
    userId,
    messageId,
    accountId: plan.accountId,
    fromAddress: plan.from.address,
    listId: plan.listId,
    method: chosen.method,
    target: chosen.target,
    actor: opts.actor,
  };

  try {
    const detail =
      chosen.method === 'http'
        ? await postOneClick(await assertPublicHttpsUrl(chosen.target))
        : await sendMailto(userId, plan.accountId, chosen.target);

    await record({ ...common, status: 'ok', detail });
    return { ok: true, method: chosen.method, target: chosen.target, detail };
  } catch (err) {
    // Recorded before rethrowing. A failed attempt is exactly the one worth
    // knowing about later, and losing it because the request errored would make
    // the audit trail a log of successes.
    const detail = (err as Error).message;
    await record({ ...common, status: 'failed', detail });
    return { ok: false, method: chosen.method, target: chosen.target, detail };
  }
}
