/**
 * The pure half of unsubscribing: reading headers and judging addresses.
 *
 * Split from `index.ts` so it can be tested without a database, a mail server,
 * or an environment. Everything here is a function of its arguments.
 */

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
 * Re-exported, not reimplemented.
 *
 * This lived here first, as a v4/v6 pattern match with its own tests. It now
 * comes from lib/ip.ts, which compares bytes rather than text — the two copies
 * had already drifted, and the one over in sync/pool.ts was the weaker. One
 * classifier, one set of answers, tested in one place.
 */
export { isPrivateAddress } from '../../lib/ip.ts';
