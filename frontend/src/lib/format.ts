/** Display formatting. Terse by default — the list has no room for prose. */

import type { Addr } from './types';

const MIN = 60_000;
const HOUR = 3_600_000;

/** List-column timestamp: "14:32" today, "Tue" this week, "4 Mar" this year. */
export function listDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const t = d.getTime();
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);

  if (t >= startOfToday) {
    return now - t < MIN ? 'now' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (t >= startOfToday - 6 * 864e5) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear())
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Reader header: full, unambiguous, with the relative hint people actually use. */
export function fullDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const abs = d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${abs} · ${relative(iso, now)}`;
}

export function relative(iso: string, now = Date.now()): string {
  const delta = now - Date.parse(iso);
  if (delta < MIN) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`;
  if (delta < 864e5) return `${Math.floor(delta / HOUR)}h ago`;
  const days = Math.floor(delta / 864e5);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace('.0', '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/** Sender monogram. Real initials where a name exists, else the address. */
export function initials(addr: Addr): string {
  const source = addr.name?.trim() || addr.address.split('@')[0] || '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export const displayName = (addr: Addr): string => addr.name?.trim() || addr.address;

/** Stable hue from a string — used for sender monograms so the same person is
 *  always the same colour without storing anything. */
export function stringHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export const senderColor = (addr: Addr): string =>
  `oklch(58% 0.09 ${stringHue(addr.address)})`;

/** Address list for the reader header — "Anna, Marcus and 3 others". */
export function addrList(addrs: Addr[], max = 2): string {
  if (!addrs.length) return '';
  const names = addrs.map(displayName);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} other${names.length - max > 1 ? 's' : ''}`;
}

export const domainOf = (address: string): string => address.split('@')[1] ?? '';

/**
 * Parse whatever a person might type or paste into a recipient field.
 *
 * Bare addresses, `Name <addr>`, comma-, semicolon- or newline-separated, with
 * or without surrounding quotes. Postel's law applied literally: accept the
 * variation, emit one consistent shape. Validation is a separate question and
 * belongs to whoever is rendering the chip.
 *
 * Shared by the docked composer and the mobile one, which is why it is here
 * rather than inside either.
 */
export function parseAddrs(raw: string): Addr[] {
  const out: Addr[] = [];
  for (const part of raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const angle = /^(.*?)\s*<([^>]+)>$/.exec(part);
    if (angle) out.push({ name: angle[1]!.replace(/^["']|["']$/g, '').trim() || null, address: angle[2]!.trim() });
    else out.push({ name: null, address: part });
  }
  return out;
}

/** The shape a recipient has to have before it is worth sending to. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
