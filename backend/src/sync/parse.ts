/**
 * Turning IMAP FETCH responses into rows.
 *
 * Everything here is pure: a fetch response in, a plain object out. That keeps
 * the interesting decisions — which part is the preview, what counts as an
 * attachment, what a subject means once "Re: Re: Fwd:" is stripped — testable
 * without a mail server, and keeps envelopes.ts about sequencing rather than
 * about MIME.
 */

import type { Addr } from '../contract/types.ts';

/* ── Addresses ─────────────────────────────────────────────────────────────── */

/** imapflow's envelope address shape. Both fields are optional in the wild. */
interface EnvelopeAddress {
  name?: string;
  address?: string;
}

export function toAddrs(list: EnvelopeAddress[] | undefined): Addr[] {
  if (!list?.length) return [];
  const out: Addr[] = [];
  for (const a of list) {
    // Group syntax ("undisclosed-recipients:;") yields entries with no address.
    // They carry no information a client can act on, so they are dropped.
    if (!a.address) continue;
    out.push({ name: a.name?.trim() || null, address: a.address.trim().toLowerCase() });
  }
  return out;
}

export function firstAddr(list: EnvelopeAddress[] | undefined): Addr {
  return toAddrs(list)[0] ?? { name: null, address: '' };
}

/* ── Subjects ──────────────────────────────────────────────────────────────── */

/**
 * Reply and forward prefixes, in the languages this server's mail actually
 * arrives in, plus the numbered variants Outlook produces ("RE[2]:").
 *
 * Anchored and applied repeatedly rather than globally: "Re: Fwd: Re: Invoice"
 * has to lose three prefixes, but "Notes on Re: something" must keep its text.
 */
const PREFIX = /^\s*(?:re|aw|antw|fwd?|wg|tr|rv|sv|vs|encaminhado)\s*(?:\[\d+\])?\s*:\s*/i;

export function normaliseSubject(subject: string): string {
  let s = subject ?? '';
  // Mailing lists prepend a bracketed tag that is not part of the thread's
  // identity; two people replying from different lists must still thread.
  s = s.replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
  for (let i = 0; i < 8; i++) {
    const next = s.replace(PREFIX, '');
    if (next === s) break;
    s = next;
  }
  return s.trim().replace(/\s+/g, ' ');
}

/* ── Message-IDs ───────────────────────────────────────────────────────────── */

/** Strip the angle brackets and whitespace. Comparison is by bare id. */
export function cleanId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim();
  return id.length ? id : null;
}

/** References is a space-separated list, root-first. Order is preserved: the
 *  first entry is the thread root and threading.ts relies on that. */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const m of raw.matchAll(/<([^<>]+)>/g)) {
    const id = m[1]!.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/* ── Body structure ────────────────────────────────────────────────────────── */

export interface BodyNode {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  id?: string;
  childNodes?: BodyNode[];
}

function walk(node: BodyNode | undefined, visit: (n: BodyNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

const isLeaf = (n: BodyNode): boolean => !n.childNodes?.length;

const filenameOf = (n: BodyNode): string | null =>
  n.dispositionParameters?.filename ?? n.parameters?.name ?? null;

/**
 * The part to read for the list preview.
 *
 * text/plain wins over text/html because it needs no tag stripping, and an
 * attachment never wins at all — a .txt attachment is not the message.
 * Returns null for messages with no readable text part, which is normal for
 * calendar invites and bare attachments.
 */
export function previewPart(root: BodyNode | undefined): { part: string; node: BodyNode } | null {
  let plain: { part: string; node: BodyNode } | null = null;
  let html: { part: string; node: BodyNode } | null = null;

  walk(root, (n) => {
    if (!isLeaf(n) || n.disposition === 'attachment') return;
    // A single-part message has no part number; "1" and "TEXT" both address it,
    // and "1" is the one every server accepts.
    const part = n.part || '1';
    if (n.type === 'text/plain' && !plain) plain = { part, node: n };
    if (n.type === 'text/html' && !html) html = { part, node: n };
  });

  return plain ?? html;
}

/**
 * Attachment count from BODYSTRUCTURE alone — no body fetch.
 *
 * A leaf counts when it is explicitly `attachment`, or when it has a filename
 * and is not one of the alternative body parts. `inline` images referenced by
 * cid: are included: the list's paperclip should agree with the reader's
 * attachment row, and the reader lists them.
 */
export function countAttachments(root: BodyNode | undefined): number {
  const preview = previewPart(root);
  let count = 0;
  walk(root, (n) => {
    if (!isLeaf(n)) return;
    if (n.part && preview && n.part === preview.part) return;
    if (n.disposition === 'attachment') count++;
    else if (filenameOf(n) && !n.type?.startsWith('text/')) count++;
  });
  return count;
}

/* ── Transfer decoding ─────────────────────────────────────────────────────── */

/** Quoted-printable, per RFC 2045 §6.7. Soft line breaks first, then hex escapes. */
function decodeQuotedPrintable(input: Buffer): Buffer {
  const text = input.toString('binary').replace(/=(?:\r\n|\n|\r)/g, '');
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/**
 * A body part's bytes as text.
 *
 * imapflow hands back the raw part unless the server answered a BINARY fetch,
 * so content-transfer-encoding is ours to undo. An unknown charset decodes as
 * UTF-8 with replacement characters rather than throwing: a preview with a few
 * mojibake glyphs is worth more than a message that fails to index.
 */
export function decodePart(
  bytes: Buffer,
  encoding: string | undefined,
  charset: string | undefined,
): string {
  let raw = bytes;
  const enc = encoding?.toLowerCase();
  if (enc === 'base64') raw = Buffer.from(bytes.toString('ascii'), 'base64');
  else if (enc === 'quoted-printable') raw = decodeQuotedPrintable(bytes);

  const label = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(label, { fatal: false }).decode(raw);
  } catch {
    return raw.toString('utf8');
  }
}

/* ── Preview text ──────────────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Enough HTML-to-text for 200 characters of preview. The reader gets the real
 *  sanitised HTML; this only has to read like a sentence. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export const PREVIEW_CHARS = 200;

/**
 * Trim to preview length.
 *
 * Quoted reply blocks and the "On <date>, <person> wrote:" attribution are
 * dropped first: a preview made of the message you already read tells you
 * nothing about the reply.
 */
export function toPreview(text: string, isHtml: boolean): string {
  let body = isHtml ? htmlToText(text) : text;
  if (!isHtml) {
    body = body
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('>'))
      .join('\n');
  }
  body = body
    .replace(/^\s*On .{0,120}wrote:\s*$/gim, '')
    .replace(/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : body;
}

/* ── Flags ─────────────────────────────────────────────────────────────────── */

export interface FlagState {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  deleted: boolean;
}

export function readFlags(flags: Set<string> | undefined): FlagState {
  const has = (f: string) => flags?.has(f) ?? false;
  return {
    seen: has('\\Seen'),
    flagged: has('\\Flagged'),
    answered: has('\\Answered'),
    draft: has('\\Draft'),
    deleted: has('\\Deleted'),
  };
}
