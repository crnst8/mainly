/**
 * On-demand body fetch, sanitise, and cache.
 *
 * Bodies are not synced. The index holds metadata for every message; a body is
 * read the first time someone opens the message, sanitised, cached with a TTL,
 * and evicted on a timer. Storing every body would be tens of gigabytes for
 * these mailboxes and would buy offline reading nobody asked for.
 *
 * Two properties are non-negotiable:
 *
 * - **`BODY.PEEK[]`, never `BODY[]`.** Rendering a message must not be what
 *   marks it read. Marking read is the client's decision, on its own timer, and
 *   a plain `BODY[]` fetch would take that decision away and set `\Seen` as a
 *   side effect of drawing pixels.
 *
 * - **Sanitise on ingest, server-side, before anything is stored.** The reader's
 *   shadow root is defence in depth, not the defence. What lands in
 *   `message_bodies` is already safe, so a future consumer that is not the
 *   reader — a digest, an export, a notification preview — cannot reintroduce
 *   the hole.
 */

import type { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { one, query } from '../db/index.ts';
import { notFound, upstream } from '../lib/errors.ts';
import type { Attachment } from '../contract/types.ts';
import { toPreview } from './parse.ts';
import { connect, type AccountCredentials } from './pool.ts';

/** Inline images are embedded as data: URIs up to this size. Past it the reader
 *  shows an attachment row instead — a 4MB base64 blob inside an HTML column is
 *  not a body, it is a denial of service against our own reader. */
const INLINE_IMAGE_MAX = 512 * 1024;
/** A single message larger than this is not worth parsing to display. */
const SOURCE_MAX = 30 * 1024 * 1024;

export interface CachedBody {
  bodyHtml: string | null;
  bodyText: string | null;
  headers: Record<string, string>;
  attachments: Attachment[];
  hasBlockedRemote: boolean;
  /** Set instead of throwing when the fetch failed. See `Message.bodyError`. */
  error: string | null;
}

/* ── Sanitiser ─────────────────────────────────────────────────────────────── */

/**
 * The allow-list.
 *
 * Absent on purpose: `script`, `style`, `object`, `embed`, `form`, `input`,
 * `iframe`, `link`, `meta`, `base`. `style` is excluded as a *tag* — a
 * stylesheet inside the body can position an element over the app's own chrome —
 * while the `style` *attribute* is kept, because without it a great deal of real
 * mail renders as unformatted soup.
 */
const SANITISE: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'abbr', 'address', 'area', 'article', 'aside', 'b', 'bdi', 'bdo', 'big',
    'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
    'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'map', 'mark', 'nav', 'ol',
    'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'title'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    '*': ['style', 'class', 'align', 'valign', 'bgcolor', 'color', 'colspan',
          'rowspan', 'width', 'height', 'dir', 'lang', 'border', 'cellpadding',
          'cellspacing'],
  },
  // `cid:` survives so inline images can be resolved to data: URIs below.
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid'],
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
  allowProtocolRelative: false,
  // `position: fixed` inside a mail body can float over the app's chrome even
  // from within a shadow root, because the shadow root is not a containing block.
  allowedStyles: {
    '*': {
      color: [/.*/],
      'background-color': [/.*/],
      background: [/^(?!.*url\s*\()/i],
      'text-align': [/.*/],
      'text-decoration': [/.*/],
      'font-size': [/.*/],
      'font-family': [/.*/],
      'font-weight': [/.*/],
      'font-style': [/.*/],
      'line-height': [/.*/],
      margin: [/.*/], 'margin-top': [/.*/], 'margin-bottom': [/.*/],
      'margin-left': [/.*/], 'margin-right': [/.*/],
      padding: [/.*/], 'padding-top': [/.*/], 'padding-bottom': [/.*/],
      'padding-left': [/.*/], 'padding-right': [/.*/],
      border: [/.*/], 'border-top': [/.*/], 'border-bottom': [/.*/],
      'border-left': [/.*/], 'border-right': [/.*/], 'border-radius': [/.*/],
      'border-color': [/.*/], 'border-collapse': [/.*/],
      width: [/.*/], 'max-width': [/.*/], height: [/.*/], 'min-height': [/.*/],
      display: [/^(block|inline|inline-block|table|table-row|table-cell|none|flex)$/i],
      'vertical-align': [/.*/],
      'white-space': [/.*/],
      'letter-spacing': [/.*/],
      'list-style': [/.*/], 'list-style-type': [/.*/],
    },
  },
  transformTags: {
    // Every link leaves the app, in a new tab, without handing the destination a
    // referrer or a window handle back to us.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
  },
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
};

/**
 * Move remote image sources to `data-src`.
 *
 * A remote image is a read receipt the sender did not ask permission for: it
 * reports the moment a message was opened, from which IP. The client restores
 * these on request, per the user's `remoteImages` preference.
 */
function deferRemoteImages(html: string): { html: string; blocked: boolean } {
  let blocked = false;
  const out = html
    .replace(/(<img\b[^>]*?)\ssrc=("|')(https?:\/\/[^"']*)\2/gi, (_m, head: string, q: string, url: string) => {
      blocked = true;
      return `${head} data-src=${q}${url}${q}`;
    })
    // srcset is the same leak with more URLs in it.
    .replace(/(<img\b[^>]*?)\ssrcset=("|')[^"']*\2/gi, (_m, head: string) => {
      blocked = true;
      return head;
    })
    // Tracking pixels dressed as background images.
    .replace(/background(-image)?\s*:\s*url\([^)]*\)/gi, () => {
      blocked = true;
      return '';
    });
  return { html: out, blocked };
}

/** Resolve `cid:` references against the message's own inline parts. */
function inlineCidImages(html: string, parsed: ParsedMail): string {
  const byCid = new Map<string, { mime: string; data: Buffer }>();
  for (const a of parsed.attachments ?? []) {
    const cid = a.cid ?? a.contentId?.replace(/^<|>$/g, '');
    if (!cid || !a.contentType?.startsWith('image/')) continue;
    if (a.size > INLINE_IMAGE_MAX) continue;
    byCid.set(cid, { mime: a.contentType, data: a.content });
  }
  if (!byCid.size) return html;

  return html.replace(/src=("|')cid:([^"']+)\1/gi, (whole, q: string, cid: string) => {
    const found = byCid.get(cid.trim());
    if (!found) return whole;
    return `src=${q}data:${found.mime};base64,${found.data.toString('base64')}${q}`;
  });
}

/* ── Parsing ───────────────────────────────────────────────────────────────── */

/** Headers worth keeping for the "show original" panel. The full set is large,
 *  mostly Received lines, and nobody reads it from a cache. */
const KEEP_HEADERS = [
  'from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id',
  'in-reply-to', 'references', 'list-id', 'list-unsubscribe',
  // RFC 8058. Its presence is the sender's own statement that a bare POST to
  // the List-Unsubscribe URL is the intended, no-confirmation-page flow — so it
  // is the header that decides whether this app may act without a browser.
  'list-unsubscribe-post', 'return-path',
  'content-type', 'x-mailer', 'user-agent', 'authentication-results',
  'dkim-signature', 'received-spf', 'delivered-to', 'precedence', 'importance',
  'x-priority', 'auto-submitted',
];

function pickHeaders(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEEP_HEADERS) {
    const value = parsed.headers.get(key);
    if (value === undefined || value === null) continue;
    out[key] =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.map(String).join(', ')
          : // Structured values (addresses, content-type) stringify usefully
            // enough for a diagnostic panel; the parsed fields are what the UI
            // actually reads.
            (value as { text?: string }).text ?? JSON.stringify(value);
  }
  return out;
}

/**
 * Attachment metadata, with an id the download endpoint can resolve.
 *
 * The id is the attachment's ordinal within the parse. mailparser walks MIME
 * depth-first and deterministically, so re-parsing the same source yields the
 * same order — which is what makes an ordinal a usable handle without storing
 * anything server-side. The download endpoint cross-checks the filename before
 * handing bytes back, so a mismatch fails rather than serving the wrong file.
 */
function toAttachments(parsed: ParsedMail): Attachment[] {
  return (parsed.attachments ?? []).map((a, i) => ({
    id: String(i),
    filename: a.filename ?? `attachment-${i + 1}`,
    mimeType: a.contentType ?? 'application/octet-stream',
    size: a.size ?? a.content?.length ?? 0,
    inline: a.contentDisposition === 'inline' || !!a.cid,
    contentId: a.cid ?? null,
  }));
}

/* ── The fetch ─────────────────────────────────────────────────────────────── */

/** What a failed read returns beside its error. Not cached — the next open
 *  tries again, because the reason is usually temporary. */
const EMPTY_BODY = {
  bodyHtml: null,
  bodyText: null,
  headers: {} as Record<string, string>,
  attachments: [] as Attachment[],
  hasBlockedRemote: false,
} as const;

interface Locator {
  id: string;
  uid: number;
  path: string;
  preview: string;
  status: string;
  creds: AccountCredentials;
}

/**
 * Everything needed to go and get one message's body.
 *
 * This is the only SELECT outside the sync directory's own files that lists the
 * `secret_*` columns, and it is here because a body fetch *is* sync work — it
 * opens an IMAP connection with the account's credential.
 */
async function locate(userId: string, messageId: string): Promise<Locator | null> {
  const row = await one<{
    id: string;
    uid: number;
    path: string;
    preview: string;
    status: string;
    account_id: string;
    address: string;
    imap_host: string;
    imap_port: number;
    imap_security: 'tls' | 'starttls' | 'none';
    username: string;
    secret_ciphertext: Buffer;
    secret_nonce: Buffer;
    secret_tag: Buffer;
    secret_key_version: number;
  }>(
    `SELECT m.id, m.uid, f.path, m.preview, a.status,
            a.id AS account_id, a.address, a.imap_host, a.imap_port, a.imap_security,
            a.username, a.secret_ciphertext, a.secret_nonce, a.secret_tag, a.secret_key_version
       FROM messages m
       JOIN folders f  ON f.id = m.folder_id
       JOIN accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = $2`,
    [userId, messageId],
  );
  if (!row) return null;

  return {
    id: row.id,
    uid: row.uid,
    path: row.path,
    preview: row.preview,
    status: row.status,
    creds: {
      id: row.account_id,
      address: row.address,
      imapHost: row.imap_host,
      imapPort: row.imap_port,
      imapSecurity: row.imap_security,
      username: row.username,
      secretCiphertext: row.secret_ciphertext,
      secretNonce: row.secret_nonce,
      secretTag: row.secret_tag,
      secretKeyVersion: row.secret_key_version,
    },
  };
}

/**
 * The cached body for a message, fetching it first if we do not have it.
 *
 * Returns null when the message does not exist or is not this user's. Throws
 * `upstream` when the mail server refuses, so the reader can say what went wrong
 * instead of showing an empty message that looks like an empty message.
 */
export async function ensureBody(
  userId: string,
  messageId: string,
  /**
   * Skip the cache and re-read from IMAP.
   *
   * One caller uses it: executing an unsubscribe. That decision turns on
   * `List-Unsubscribe-Post`, which older cache rows predate, and it reaches a
   * third party and cannot be undone. One extra fetch is the right price for
   * not acting on a header we might merely be missing.
   */
  opts: { refetch?: boolean } = {},
): Promise<CachedBody | null> {
  const cached = opts.refetch ? null : await one<{
    body_html: string | null;
    body_text: string | null;
    headers: Record<string, string>;
    attachments: Attachment[];
    has_blocked_remote: boolean;
  }>(
    `SELECT b.body_html, b.body_text, b.headers, b.attachments, b.has_blocked_remote
       FROM message_bodies b
       JOIN messages m ON m.id = b.message_id
       JOIN accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND b.message_id = $2`,
    [userId, messageId],
  );
  if (cached) {
    return {
      bodyHtml: cached.body_html,
      bodyText: cached.body_text,
      headers: cached.headers ?? {},
      attachments: cached.attachments ?? [],
      hasBlockedRemote: cached.has_blocked_remote,
      error: null,
    };
  }

  const target = await locate(userId, messageId);
  if (!target) return null;

  // A disabled account is not contacted, and an account we already know has a
  // rejected credential is not contacted either: retrying a bad password on
  // every message the user opens is how a mailbox gets rate-limited or locked.
  if (target.status === 'disabled' || target.status === 'auth_error') {
    return {
      ...EMPTY_BODY,
      error:
        target.status === 'disabled'
          ? 'This account is disabled, so its messages cannot be loaded.'
          : `Sign-in to ${target.creds.address} is failing, so the message could not be loaded. Update the password for this account.`,
    };
  }

  let source: Buffer;
  try {
    source = await fetchSource(target);
  } catch (err) {
    // The envelope is already indexed and worth showing. Failing the whole read
    // would mean an unreachable mail server takes away mail we already hold.
    return { ...EMPTY_BODY, error: (err as Error).message };
  }

  const parsed = await simpleParser(source, {
    // mailparser would otherwise inline every cid: image as a data: URI with no
    // size limit, which turns one 6MB embedded photo into a 8MB HTML column and
    // a reader that takes a second to paint. `inlineCidImages` below does the
    // same job with a cap.
    skipImageLinks: true,
  });

  const rawHtml = typeof parsed.html === 'string' ? parsed.html : null;
  let html: string | null = null;
  let blocked = false;

  if (rawHtml) {
    const withInline = inlineCidImages(rawHtml, parsed);
    const clean = sanitizeHtml(withInline, SANITISE);
    const deferred = deferRemoteImages(clean);
    html = deferred.html;
    blocked = deferred.blocked;
  }

  const text = parsed.text ?? null;
  const attachments = toAttachments(parsed);
  const headers = pickHeaders(parsed);

  const body: CachedBody = {
    bodyHtml: html,
    bodyText: text,
    headers,
    attachments,
    hasBlockedRemote: blocked,
    error: null,
  };

  await query(
    `INSERT INTO message_bodies
       (message_id, body_html, body_text, headers, attachments, has_blocked_remote, bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id) DO UPDATE SET
       body_html = EXCLUDED.body_html,
       body_text = EXCLUDED.body_text,
       headers = EXCLUDED.headers,
       attachments = EXCLUDED.attachments,
       has_blocked_remote = EXCLUDED.has_blocked_remote,
       bytes = EXCLUDED.bytes,
       fetched_at = now()`,
    [
      target.id,
      html,
      text,
      JSON.stringify(headers),
      JSON.stringify(attachments),
      blocked,
      source.length,
    ],
  );

  // The envelope pass takes its preview from the first text part, which is empty
  // for messages whose text part was too large to read cheaply, or absent. Now
  // that the real body is here, fill it in — this is also what puts the message
  // into search results that match on preview.
  const preview = toPreview(text ?? (html ? html : ''), !text && !!html);
  await query(
    `UPDATE messages
        SET body_cached_at = now(),
            preview = CASE WHEN $2 <> '' AND preview = '' THEN $2 ELSE preview END
      WHERE id = $1`,
    [target.id, preview],
  );

  return body;
}

async function fetchSource(target: Locator): Promise<Buffer> {
  let client: ImapFlow | null = null;
  try {
    client = await connect(target.creds);
    // Read-only: opening a mailbox read-write clears `\Recent` for every message
    // in it, which is a visible side effect of someone reading one message.
    const lock = await client.getMailboxLock(target.path, { readOnly: true });
    try {
      const msg = await client.fetchOne(
        String(target.uid),
        { source: { start: 0, maxLength: SOURCE_MAX }, uid: true },
        { uid: true },
      );
      if (!msg || !msg.source) {
        throw upstream('The mail server no longer has this message');
      }
      return msg.source;
    } finally {
      lock.release();
    }
  } catch (err) {
    const message = (err as Error).message;
    if (/authenticat|credential|login/i.test(message)) {
      throw upstream(`Could not sign in to ${target.creds.address}: ${message}`);
    }
    throw upstream(message);
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/* ── Attachment download ───────────────────────────────────────────────────── */

export interface FetchedAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * One attachment's bytes.
 *
 * Re-parsed from source rather than cached: attachment payloads are the bulk of
 * a mailbox's size and caching them would defeat the reason bodies are a cache
 * in the first place. Downloads are rare and a second fetch is cheap.
 */
export async function fetchAttachment(
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<FetchedAttachment> {
  const target = await locate(userId, messageId);
  if (!target) throw notFound('Message');

  const index = Number(attachmentId);
  if (!Number.isInteger(index) || index < 0) throw notFound('Attachment');

  const parsed = await simpleParser(await fetchSource(target), { skipImageLinks: true });
  const found = (parsed.attachments ?? [])[index];
  if (!found) throw notFound('Attachment');

  return {
    filename: found.filename ?? `attachment-${index + 1}`,
    mimeType: found.contentType ?? 'application/octet-stream',
    content: found.content,
  };
}
