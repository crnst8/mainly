/**
 * Which IP addresses this application refuses to contact.
 *
 * Addresses are compared as **bytes**, never as text. `127.0.0.1`,
 * `2130706433`, `0x7f000001`, `::ffff:7f00:1` and `0:0:0:0:0:0:0:1` are one
 * destination written five ways, and a regex over the string catches whichever
 * ones its author thought of that morning.
 *
 * Pure, and with no import that reads the environment, so the table of spellings
 * in ip.test.ts runs without a database, a mail server or a `.env` — the same
 * reason unsubscribe/parse.ts is split from the module that uses it. Resolving a
 * *name* before judging it is the other half, and lives in net-guard.ts.
 */

import { isIP } from 'node:net';

/* ── Parsing ─────────────────────────────────────────────────────────────── */

/** The four octets of a dotted-quad, or null. Strict: `isIP` has already said
 *  this is well-formed, and anything it rejects is not our problem to guess at. */
function ipv4Bytes(text: string): number[] | null {
  if (isIP(text) !== 4) return null;
  return text.split('.').map(Number);
}

/**
 * The sixteen bytes of an IPv6 address, or null.
 *
 * Written out rather than pulled in, because the whole point is that no textual
 * form survives: `::` expands, a trailing dotted-quad is absorbed, and what
 * comes back is the address itself rather than one of its spellings.
 */
function ipv6Bytes(text: string): number[] | null {
  if (isIP(text) !== 6) return null;
  let head = text;
  let tail = '';
  const split = text.indexOf('::');
  if (split !== -1) {
    head = text.slice(0, split);
    tail = text.slice(split + 2);
  }

  const expand = (part: string): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      // A trailing dotted-quad: `::ffff:127.0.0.1` and `::127.0.0.1`.
      if (group.includes('.')) {
        const quad = ipv4Bytes(group);
        if (!quad) return [];
        out.push(...quad);
        continue;
      }
      const n = Number.parseInt(group, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };

  const left = expand(head);
  const right = expand(tail);
  const gap = 16 - left.length - right.length;
  if (gap < 0) return null;
  // Without `::` there is no gap to fill and the two halves must already be whole.
  if (split === -1 && gap !== 0) return null;
  return [...left, ...new Array<number>(gap).fill(0), ...right];
}

/* ── Judging ─────────────────────────────────────────────────────────────── */

/** Private, loopback, link-local, CGNAT, multicast and reserved v4. */
function privateV4(b: number[]): boolean {
  const [a, second, third] = b as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && second >= 16 && second <= 31) return true;
  if (a === 192 && second === 168) return true;
  if (a === 169 && second === 254) return true;
  // 100.64.0.0/10 — carrier-grade NAT, and what Tailscale hands out.
  if (a === 100 && second >= 64 && second <= 127) return true;
  // 192.0.0.0/24 IETF assignments, 192.0.2.0/24 TEST-NET-1.
  if (a === 192 && second === 0 && (third === 0 || third === 2)) return true;
  // 192.88.99.0/24 — the withdrawn 6to4 relay anycast.
  if (a === 192 && second === 88 && third === 99) return true;
  // 198.18.0.0/15 benchmarking, 198.51.100.0/24 TEST-NET-2.
  if (a === 198 && (second === 18 || second === 19)) return true;
  if (a === 198 && second === 51 && third === 100) return true;
  // 203.0.113.0/24 TEST-NET-3.
  if (a === 203 && second === 0 && third === 113) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, which takes 255.255.255.255.
  if (a >= 224) return true;
  return false;
}

/** True when every byte in `[from, to)` is zero. */
const zeroes = (b: number[], from: number, to: number): boolean =>
  b.slice(from, to).every((x) => x === 0);

function privateV6(b: number[]): boolean {
  // :: unspecified and ::1 loopback.
  if (zeroes(b, 0, 15)) return b[15] === 0 || b[15] === 1;
  // fc00::/7 unique-local.
  if ((b[0]! & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local.
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;
  // ff00::/8 multicast.
  if (b[0] === 0xff) return true;
  // 100::/64 discard-only.
  if (b[0] === 0x01 && zeroes(b, 1, 8)) return true;
  // 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;

  /* Anything that carries a v4 address inside it is judged on that address —
     an embedded 127.0.0.1 is still 127.0.0.1 however it is wrapped. */
  const embedded = (from: number): boolean => privateV4(b.slice(from, from + 4));
  // ::ffff:0:0/96 v4-mapped, and the deprecated ::/96 v4-compatible.
  if (zeroes(b, 0, 10) && ((b[10] === 0xff && b[11] === 0xff) || zeroes(b, 10, 12))) {
    return embedded(12);
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return embedded(12);
  // 2002::/16 — 6to4, which carries its v4 address in the next four bytes.
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2);

  return false;
}

/**
 * Is this address one we refuse to contact?
 *
 * Takes an address, not a name — resolution is the caller's job, because a
 * caller that has already resolved must check *every* answer rather than the
 * first. Anything unparseable is treated as private: a guard that fails open on
 * input it did not understand is a guard with a hole shaped like that input.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip);
  if (v4) return privateV4(v4);
  const v6 = ipv6Bytes(ip);
  if (v6) return privateV6(v6);
  return true;
}

/** Strip the brackets a URL puts around an IPv6 literal. */
export const bareHost = (host: string): string => host.replace(/^\[|\]$/g, '');
