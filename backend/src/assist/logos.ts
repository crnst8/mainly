/**
 * Sender logos, found from the sender's own domain.
 *
 * Two sources, in order of trust:
 *
 *  1. **BIMI.** A brand that wants its logo shown in inboxes publishes it in
 *     DNS (`default._bimi.<domain>`, `l=` an HTTPS SVG). That record is the
 *     domain saying "this is our mark", so it is the only source used without
 *     the user asking for a particular sender (`assist.senderLogos`).
 *  2. **The site's icon.** The `apple-touch-icon` or largest `icon` link on the
 *     domain's home page, else `/favicon.ico`. Only when the user asks for one
 *     sender's logo: a site icon is a good guess, not a declaration.
 *
 * Lookups happen on this server, never in the browser, so a sender learns at
 * most that this install looked them up — not which person, from which
 * device. Results are cached per domain for every user, including "none".
 *
 * Every fetch is an outbound request to a host taken from someone else's
 * mail, so each hop goes through net-guard, redirects are followed by hand
 * with the guard re-applied, and every body is size-capped while it streams.
 *
 * An SVG served from this origin would run script if opened directly, so the
 * route that serves these sends a sandboxing Content-Security-Policy with it.
 */

import { resolveTxt } from 'node:dns/promises';
import { one, query } from '../db/index.ts';
import { organisation } from '../filter/features.ts';
import { assertPublicHost } from '../lib/net-guard.ts';

const IMAGE_MAX = 256 * 1024;
const PAGE_MAX = 512 * 1024;
const TIMEOUT_MS = 6000;
const FOUND_TTL_DAYS = 30;
const MISSING_TTL_DAYS = 7;

const IMAGE_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/**
 * Domains that host mail for people rather than organisations. A logo for
 * these would put a mail provider's mark on a friend's message.
 */
const PERSONAL_DOMAINS = new Set(
  `gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com
  icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me fastmail.com fastmail.fm
  gmx.com gmx.de gmx.net web.de mail.com zoho.com yandex.com yandex.ru hey.com tutanota.com
  tuta.io qq.com 163.com 126.com naver.com bigpond.com optusnet.com.au comcast.net`
    .split(/\s+/)
    .filter(Boolean),
);

export interface Logo {
  contentType: string;
  image: Buffer;
  source: 'bimi' | 'icon';
}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A sender domain this module will look up, lower-cased, or null. */
export function logoDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN.test(d) && !PERSONAL_DOMAINS.has(organisation(d)) ? d : null;
}

/** Whether the user has mail from this domain or a subdomain of it. A logo is
 *  looked up only for a sender the user has heard from, so this route cannot
 *  be used to make the server fetch from arbitrary domains. */
export async function hasMailFrom(userId: string, domain: string): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM messages m JOIN accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND (m.from_address LIKE '%@' || $2 OR m.from_address LIKE '%.' || $2)
     ) AS ok`,
    [userId, domain],
  );
  return !!row?.ok;
}

/** The cached logo, `null` for a cached "none", or `undefined` when there is
 *  no fresh entry. */
export async function cachedLogo(domain: string): Promise<Logo | null | undefined> {
  const row = await one<{ content_type: string | null; image: Buffer | null; source: 'bimi' | 'icon' | null; fresh: boolean }>(
    `SELECT content_type, image, source,
            fetched_at > now() - (CASE WHEN image IS NULL THEN $2 ELSE $3 END || ' days')::interval AS fresh
       FROM sender_logos WHERE domain = $1`,
    [domain, MISSING_TTL_DAYS, FOUND_TTL_DAYS],
  );
  if (!row || !row.fresh) return undefined;
  return row.image && row.content_type && row.source
    ? { contentType: row.content_type, image: row.image, source: row.source }
    : null;
}

async function store(domain: string, logo: Logo | null): Promise<void> {
  await query(
    `INSERT INTO sender_logos (domain, content_type, image, source, fetched_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (domain) DO UPDATE
       SET content_type = EXCLUDED.content_type, image = EXCLUDED.image,
           source = EXCLUDED.source, fetched_at = now()`,
    [domain, logo?.contentType ?? null, logo?.image ?? null, logo?.source ?? null],
  );
}

/** Lookups in flight, so forty rows from one sender make one request. */
const inflight = new Map<string, Promise<Logo | null>>();

/**
 * The logo for a domain, from the cache or found now. `icons` allows the
 * site-icon fallback; without it only BIMI is tried. A cached "none" from a
 * BIMI-only lookup does not stop a later lookup that allows icons.
 */
export function findLogo(domain: string, icons: boolean): Promise<Logo | null> {
  const key = `${domain}|${icons}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const cached = await cachedLogo(domain);
    if (cached || (cached === null && !icons)) return cached;
    const found = (await bimi(domain).catch(() => null)) ?? (icons ? await siteIcon(domain).catch(() => null) : null);
    // A BIMI-only miss is cached; an icon miss too. A hit is cached either way.
    await store(domain, found);
    return found;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/* ── BIMI ───────────────────────────────────────────────────────────────── */

/** The `l=` URL of a BIMI record, if the text is one. */
export function bimiLocation(record: string): string | null {
  if (!/^v=BIMI1\s*(;|$)/i.test(record.trim())) return null;
  for (const part of record.split(';')) {
    const [k, ...v] = part.split('=');
    if (k?.trim().toLowerCase() === 'l') {
      const url = v.join('=').trim();
      return url.startsWith('https://') ? url : null;
    }
  }
  return null;
}

async function bimi(domain: string): Promise<Logo | null> {
  // The record is looked up on the sending domain, then on its organisation,
  // as the BIMI draft says a receiver should.
  for (const d of [...new Set([domain, organisation(domain)])]) {
    const records = await resolveTxt(`default._bimi.${d}`).catch(() => [] as string[][]);
    for (const chunks of records) {
      const url = bimiLocation(chunks.join(''));
      if (!url) continue;
      const got = await fetchBounded(url, IMAGE_MAX);
      if (got && got.contentType === 'image/svg+xml') return { contentType: got.contentType, image: got.body, source: 'bimi' };
    }
  }
  return null;
}

/* ── Site icon ──────────────────────────────────────────────────────────── */

/** Candidate icon URLs from a page's `<link>` tags, best first: the
 *  apple-touch-icon (180px, opaque), then icons by declared size. */
export function iconLinks(html: string, base: string): string[] {
  const found: { url: string; score: number }[] = [];
  for (const tag of html.slice(0, PAGE_MAX).match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\b(icon|apple-touch-icon)\b/.test(rel) || /mask-icon/.test(rel)) continue;
    let url: string;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!url.startsWith('https://')) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const score = rel.includes('apple-touch-icon') ? 1000 : size || (/\.svg(\?|$)/i.test(url) ? 500 : 16);
    found.push({ url, score });
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.url);
}

async function siteIcon(domain: string): Promise<Logo | null> {
  const home = `https://${organisation(domain)}/`;
  const page = await fetchBounded(home, PAGE_MAX).catch(() => null);
  const candidates = [
    ...(page && page.contentType === 'text/html' ? iconLinks(page.body.toString('utf8'), page.url) : []),
    new URL('/favicon.ico', page?.url ?? home).toString(),
  ];
  for (const url of [...new Set(candidates)].slice(0, 4)) {
    const got = await fetchBounded(url, IMAGE_MAX).catch(() => null);
    // A tiny favicon.ico is a 16px smudge, not a logo worth showing.
    if (got && IMAGE_TYPES.has(got.contentType) && got.body.length > 200)
      return { contentType: got.contentType, image: got.body, source: 'icon' };
  }
  return null;
}

/* ── Fetching ───────────────────────────────────────────────────────────── */

/** GET a public HTTPS URL, following up to three redirects by hand so each
 *  hop is checked, and reading at most `max` bytes. Null on any failure. */
async function fetchBounded(
  start: string,
  max: number,
): Promise<{ url: string; contentType: string; body: Buffer } | null> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    await assertPublicHost(parsed.hostname, 'A sender logo');
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/*,text/html;q=0.8', 'user-agent': `mainly/${process.env.APP_VERSION || 'dev'} (logo)` },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      await res.body?.cancel();
      if (!next) return null;
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > max) {
      await res.body.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    return { url, contentType, body: Buffer.concat(chunks) };
  }
  return null;
}
