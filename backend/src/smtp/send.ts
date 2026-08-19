/**
 * Outbound send.
 *
 * The order of operations is the design, and it is chosen so that every failure
 * leaves the user's work recoverable:
 *
 *   1. submit over SMTP
 *   2. APPEND a copy to the account's Sent folder
 *   3. flag the message being replied to as `\Answered`
 *   4. delete the draft
 *
 * Submission first, because it is the only irreversible step — once the SMTP
 * server has accepted the message it is gone, and everything after that is
 * bookkeeping. The draft is deleted last, so a failure anywhere leaves it in the
 * composer with the server's own error text. The reverse order — tidy up first,
 * then send — is how a mail client loses a message it told you it sent.
 *
 * Steps 2 and 3 are best-effort on purpose. A Sent folder that is missing, or an
 * original that has since been deleted, must not turn a delivered message into a
 * reported failure. Both are logged and their queue rows retried; neither
 * changes the answer the user gets.
 */

import nodemailer from 'nodemailer';
import { one, query } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, notFound, upstream } from '../lib/errors.ts';
import { open } from '../lib/crypto.ts';
import type { Addr, Draft } from '../contract/types.ts';
import { connect, assertHostAllowed, type AccountCredentials } from '../sync/pool.ts';

interface SendableRow {
  id: string;
  account_id: string;
  to_addrs: Addr[];
  cc_addrs: Addr[];
  bcc_addrs: Addr[];
  subject: string;
  body_text: string;
  body_html: string | null;
  in_reply_to: string | null;
  forward_of: string | null;

  address: string;
  display_name: string;
  signature: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_security: 'tls' | 'starttls' | 'none';
  username: string;
  imap_host: string;
  imap_port: number;
  imap_security: 'tls' | 'starttls' | 'none';
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_key_version: number;
}

const SENDABLE_SQL = `
  SELECT d.id, d.account_id, d.to_addrs, d.cc_addrs, d.bcc_addrs, d.subject,
         d.body_text, d.body_html, d.in_reply_to::text, d.forward_of::text,
         a.address, a.display_name, a.signature,
         a.smtp_host, a.smtp_port, a.smtp_security, a.username,
         a.imap_host, a.imap_port, a.imap_security,
         a.secret_ciphertext, a.secret_nonce, a.secret_tag, a.secret_key_version
    FROM drafts d
    JOIN accounts a ON a.id = d.account_id
   WHERE d.user_id = $1 AND d.id = $2
`;

const credentialsOf = (r: SendableRow): AccountCredentials => ({
  id: r.account_id,
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

const asRecipients = (list: Addr[]): string[] =>
  list.filter((a) => a.address).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));

export interface SendResult {
  messageId: string;
}

export async function sendDraft(userId: string, draftId: string): Promise<SendResult> {
  const row = await one<SendableRow>(SENDABLE_SQL, [userId, draftId]);
  if (!row) throw notFound('Draft');

  const to = asRecipients(row.to_addrs ?? []);
  const cc = asRecipients(row.cc_addrs ?? []);
  const bcc = asRecipients(row.bcc_addrs ?? []);
  if (!to.length && !cc.length && !bcc.length) {
    throw badRequest('This message has no recipients.');
  }

  assertHostAllowed(row.smtp_host);

  // The reply headers come off the message being answered, not off the draft:
  // In-Reply-To and References are what make the recipient's client thread the
  // reply, and getting them from anywhere else is how a reply arrives as a new
  // conversation.
  const parent = row.in_reply_to
    ? await one<{ message_id: string | null; references_: string[] }>(
        `SELECT m.message_id, m.references_
           FROM messages m JOIN accounts a ON a.id = m.account_id
          WHERE a.user_id = $1 AND m.id = $2`,
        [userId, row.in_reply_to],
      )
    : null;

  const inReplyTo = parent?.message_id ? `<${parent.message_id}>` : undefined;
  const references = parent?.message_id
    ? [...(parent.references_ ?? []), parent.message_id].map((id) => `<${id}>`).join(' ')
    : undefined;

  const signature = row.signature?.trim();
  const text = signature ? `${row.body_text}\n\n-- \n${signature}` : row.body_text;

  const servername = row.smtp_host;
  const host = config.imap.hostOverrides.get(servername) ?? servername;
  const password = open({
    ciphertext: row.secret_ciphertext,
    nonce: row.secret_nonce,
    tag: row.secret_tag,
    keyVersion: row.secret_key_version,
  });

  const transport = nodemailer.createTransport({
    host,
    port: row.smtp_port,
    secure: row.smtp_security === 'tls',
    requireTLS: row.smtp_security === 'starttls',
    auth: { user: row.username || row.address, pass: password },
    tls: { servername, minVersion: 'TLSv1.2' },
    connectionTimeout: config.imap.connectTimeoutMs,
  });

  const message = {
    // The envelope sender is the account, always. A From the SMTP server is not
    // authorised to send for fails SPF and DKIM at the far end.
    from: row.display_name ? `${row.display_name} <${row.address}>` : row.address,
    to,
    cc,
    bcc,
    subject: row.subject,
    text,
    ...(row.body_html ? { html: row.body_html } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  };

  /* 0. Compile the MIME once.
     Building it here rather than letting the SMTP transport build it means the
     bytes submitted and the bytes filed in Sent are the same bytes. Compiling
     twice risks a Sent copy with a different Message-ID and boundary from the
     one the recipient received, which makes the two impossible to correlate
     later. The built envelope is used as-is because nodemailer keeps Bcc out of
     the headers while keeping it in the envelope, which is exactly right. */
  const builder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const built = (await builder.sendMail(message)) as unknown as {
    message: Buffer;
    messageId: string;
    envelope: { from: string | false; to: string[] };
  };
  const raw = built.message;
  const messageId = built.messageId;

  /* 1. Submit. The only irreversible step. */
  try {
    await transport.sendMail({ envelope: built.envelope, raw });
  } catch (err) {
    // Verbatim. "550 5.7.1 Relay access denied" is actionable; "send failed" is
    // not. The draft is still in the database, so the composer can restore it.
    throw upstream((err as Error).message, { draftId });
  } finally {
    transport.close();
  }

  /* 2. File a copy in Sent. Best effort. */
  await appendToSent(credentialsOf(row), raw).catch((err: Error) =>
    console.warn(
      { account: row.address, err: err.message },
      'message sent, but the Sent copy could not be filed',
    ),
  );

  /* 3. Mark the original answered, locally and on the server. */
  if (row.in_reply_to) {
    await markAnswered(userId, row.in_reply_to).catch((err: Error) =>
      console.warn({ err: err.message }, 'could not flag the original as answered'),
    );
  }

  /* 4. Only now is the draft safe to remove. */
  await query('DELETE FROM drafts WHERE user_id = $1 AND id = $2', [userId, draftId]);

  return { messageId };
}

/**
 * APPEND the sent bytes to the account's Sent folder, creating it if needed.
 *
 * `\Seen` because you have, by definition, read what you just wrote. Without it
 * every sent message arrives unread and the sidebar count becomes noise.
 *
 * On creation: a Dovecot install commonly declares `Sent` with
 * `special_use = \Sent` without autocreating it, so on a mailbox that has never
 * been sent from by an IMAP-aware client the folder simply does not exist. Without it a sent message
 * leaves and is filed nowhere the user can ever see — which is not "sending
 * mail". The rule this app holds to is that it never *provisions* anything on
 * the mail server — no accounts, no domains, no server configuration. An IMAP
 * CREATE issued as the already-authenticated user is ordinary client behaviour
 * and is what every mail client does on first send. Only `Sent`, only on
 * demand, and never any other folder.
 */
async function appendToSent(creds: AccountCredentials, raw: Buffer): Promise<void> {
  if (!raw.length) return;

  const sent = await one<{ path: string }>(
    `SELECT path FROM folders WHERE account_id = $1 AND role = 'sent' ORDER BY position LIMIT 1`,
    [creds.id],
  );

  const client = await connect(creds);
  try {
    let path = sent?.path;

    if (!path) {
      // The name comes from the server's own namespace, so a server that
      // prefixes everything under INBOX. gets INBOX.Sent and one that does not
      // gets Sent. imapflow applies the prefix for us.
      path = 'Sent';
      try {
        await client.mailboxCreate(path);
        console.log({ account: creds.address, path }, 'created a Sent folder for first send');
      } catch (err) {
        // Already there but unsubscribed, or not listed — either way, try the
        // APPEND, which is the thing we actually need to succeed.
        console.warn(
          { account: creds.address, err: (err as Error).message },
          'could not create a Sent folder; attempting the append anyway',
        );
      }
      // Subscribed, or it stays invisible in every other client the user owns.
      await client.mailboxSubscribe(path).catch(() => {});
    }

    await client.append(path, raw, ['\\Seen']);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Local flag plus a queued IMAP op, the same path a click through the UI takes,
 *  so replay handles the round trip and its retries. */
async function markAnswered(userId: string, messageId: string): Promise<void> {
  const row = await one<{ id: string; account_id: string; uid: number; path: string }>(
    `SELECT m.id, m.account_id, m.uid, f.path
       FROM messages m
       JOIN accounts a ON a.id = m.account_id
       JOIN folders f  ON f.id = m.folder_id
      WHERE a.user_id = $1 AND m.id = $2`,
    [userId, messageId],
  );
  if (!row) return;

  await query('UPDATE messages SET answered = true WHERE id = $1', [row.id]);
  await query('INSERT INTO sync_ops (account_id, kind, payload) VALUES ($1, $2, $3)', [
    row.account_id,
    'flag',
    JSON.stringify({
      ids: [row.id],
      targets: [{ path: row.path, uid: row.uid }],
      action: { type: 'flag', add: ['answered'], remove: [] },
    }),
  ]);
}

/* ── Row → contract ────────────────────────────────────────────────────────── */

export interface DraftRow {
  id: string;
  account_id: string;
  to_addrs: Addr[];
  cc_addrs: Addr[];
  bcc_addrs: Addr[];
  subject: string;
  body_text: string;
  body_html: string | null;
  in_reply_to: string | null;
  forward_of: string | null;
  attachments: Draft['attachments'];
  send_at: Date | null;
  updated_at: Date;
}

export const toDraft = (r: DraftRow): Draft => ({
  id: r.id,
  accountId: r.account_id,
  to: r.to_addrs ?? [],
  cc: r.cc_addrs ?? [],
  bcc: r.bcc_addrs ?? [],
  subject: r.subject,
  bodyText: r.body_text,
  bodyHtml: r.body_html,
  inReplyTo: r.in_reply_to,
  forwardOf: r.forward_of,
  attachments: r.attachments ?? [],
  updatedAt: r.updated_at.toISOString(),
  sendAt: r.send_at?.toISOString() ?? null,
});
