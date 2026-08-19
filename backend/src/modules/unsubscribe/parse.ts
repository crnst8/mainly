/**
 * The pure half of unsubscribing: reading headers and judging addresses.
 *
 * Split from `index.ts` so it can be tested without a database, a mail server,
 * or an environment. Everything here is a function of its arguments.
 */

import { isIP } from 'node:net';

/**
 * `List-Unsubscribe: <https://x/u/1>, <mailto:stop@x?subject=unsub>`
 *
 * Angle-bracketed, comma-separated, in the sender's order of preference. Real
 * mail gets this wrong in every direction — missing brackets, stray whitespace,
 * a bare address, a truncated URL — so the parser is forgiving in the same way
 * the search parser is: anything it cannot read is dropped, and nothing throws.
 * A malformed header means "no option here", never an error.
 */
export function parseListUnsubscribe(
  raw: string | undefined,
): { method: 'http' | 'mailto'; target: string }[] {
  if (!raw) return [];
  const out: { method: 'http' | 'mailto'; target: string }[] = [];

  // Prefer the bracketed form; fall back to splitting on commas for senders who
  // omitted the brackets entirely.
  const bracketed = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const candidates = bracketed.length ? bracketed : raw.split(',').map((s) => s.trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (lower.startsWith('mailto:')) out.push({ method: 'mailto', target: candidate });
    else if (lower.startsWith('http://') || lower.startsWith('https://')) {
      out.push({ method: 'http', target: candidate });
    }
    // Anything else — a bare word, a `tel:`, a truncated URL — is not something
    // to act on. Silently skipped.
  }
  return out;
}

/** RFC 8058: the header's value is literally `List-Unsubscribe=One-Click`. */
export const isOneClick = (raw: string | undefined): boolean =>
  /list-unsubscribe\s*=\s*one-click/i.test(raw ?? '');

/**
 * RFC 1918, loopback, link-local, CGNAT, and the v6 equivalents.
 *
 * Used to decide whether an unsubscribe URL out of a stranger's mail is
 * allowed to be contacted at all. Wrong answers here are the whole SSRF story,
 * which is why it is a plain function with its own tests rather than a regex
 * inline at the call site.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 — carrier-grade NAT, and what Tailscale hands out.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
