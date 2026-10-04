/**
 * New-mail notifications: which arrivals deserve one, and what it says.
 *
 * Every rule here comes from `NotificationPreferences`; the sync worker only
 * reports what arrived. Spam never reaches this file — arrivals.ts files it
 * first and drops it from the list.
 */

import { query } from '../db/index.ts';
import type { NotificationPreferences, Preferences, Priority, PushPayload } from '../contract/types.ts';
import type { Arrival } from '../sync/envelopes.ts';
import { deliver, type PushOptions, type PushTarget } from './webpush.ts';

/** Mail older than this is not news, even when this pass is the first to see
 *  it: a message another client moved into the inbox from an old folder. */
const NEWS_WINDOW_MS = 48 * 3600_000;
/** Past this many separate notifications in one pass, one summary says the rest. */
const MAX_SEPARATE = 4;
/** Roles that never notify under "all folders". */
const QUIET_ROLES = new Set(['sent', 'drafts', 'junk', 'trash']);

/** Whether `now` falls inside the quiet window, read in the window's own zone.
 *  Exported for the unit test. */
export function inQuietHours(q: NotificationPreferences['quietHours'], now = new Date()): boolean {
  if (!q.enabled || q.start === q.end) return false;
  let hhmm: string;
  try {
    hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: q.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
  } catch {
    // An unknown zone name must not silence notifications forever.
    return false;
  }
  return q.start < q.end ? hhmm >= q.start && hhmm < q.end : hhmm >= q.start || hhmm < q.end;
}

/** The arrivals that are news under these preferences. Exported for the test. */
export function newsworthy(arrivals: readonly Arrival[], n: NotificationPreferences, now = Date.now()): Arrival[] {
  return arrivals.filter(
    (a) =>
      a.fresh &&
      !a.seen &&
      !a.spam &&
      now - a.date.getTime() < NEWS_WINDOW_MS &&
      (a.role === 'inbox' || (n.folders === 'all' && !QUIET_ROLES.has(a.role))),
  );
}

interface AccountInfo {
  address: string;
  label: string | null;
  priority: Priority;
}

interface Summary {
  id: string;
  from_name: string | null;
  from_address: string;
  subject: string;
  preview: string;
}

export async function notifyArrivals(
  userId: string,
  accountId: string,
  arrivals: readonly Arrival[],
  prefs: Preferences,
): Promise<void> {
  const n = prefs.notifications;
  if (!n.enabled || n.mutedAccounts.includes(accountId) || inQuietHours(n.quietHours)) return;
  const news = newsworthy(arrivals, n);
  if (!news.length) return;

  const account = (
    await query<AccountInfo>('SELECT address, label, priority FROM accounts WHERE id = $1', [accountId])
  )[0];
  if (!account || !n.tiers.includes(account.priority)) return;

  const devices = await query<PushTarget>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  if (!devices.length) return;

  const rows = await query<Summary>(
    `SELECT id, from_name, from_address, subject, preview FROM messages
      WHERE account_id = $1 AND id = ANY($2::uuid[]) ORDER BY date DESC`,
    [accountId, news.map((a) => a.id)],
  );
  if (!rows.length) return;

  const payloads = buildPayloads(accountId, account, rows, n);
  const options: PushOptions = {
    ttl: 24 * 3600,
    urgency: account.priority === 'critical' || account.priority === 'high' ? 'high' : 'normal',
  };
  await sendAll(devices, payloads, options);
}

/** Exported for the test. */
export function buildPayloads(
  accountId: string,
  account: AccountInfo,
  rows: readonly Summary[],
  n: NotificationPreferences,
): PushPayload[] {
  const mailbox = account.label || account.address;
  const sender = (r: Summary) => r.from_name || r.from_address;
  const subject = (r: Summary) => r.subject || '(no subject)';
  const grouping = (newest: Summary): NonNullable<PushPayload['group']> => ({
    mailbox,
    latest:
      n.content === 'full' ? `${sender(newest)}: ${subject(newest)}` : n.content === 'sender' ? sender(newest) : null,
    url: `a/${accountId}`,
  });

  const one = (r: Summary): PushPayload => ({
    tag: n.group ? `account:${accountId}` : `message:${r.id}`,
    title: n.content === 'count' ? 'New mail' : sender(r),
    body:
      n.content === 'full'
        ? [subject(r), r.preview].filter(Boolean).join('\n')
        : n.content === 'sender'
          ? mailbox
          : `1 new message · ${mailbox}`,
    url: `a/${accountId}/m/${r.id}`,
    silent: n.silent,
    count: 1,
    ...(n.group ? { group: grouping(r) } : {}),
  });

  const summary = (list: readonly Summary[]): PushPayload => {
    const latest = list[0]!;
    return {
      tag: n.group ? `account:${accountId}` : `summary:${accountId}`,
      title: `${list.length} new messages`,
      body:
        n.content === 'full'
          ? `${mailbox} · ${sender(latest)}: ${subject(latest)}`
          : n.content === 'sender'
            ? `${mailbox} · ${[...new Set(list.map(sender))].slice(0, 3).join(', ')}`
            : mailbox,
      url: `a/${accountId}`,
      silent: n.silent,
      count: list.length,
      ...(n.group ? { group: grouping(latest) } : {}),
    };
  };

  if (rows.length === 1) return [one(rows[0]!)];
  if (n.group) return [summary(rows)];
  if (rows.length <= MAX_SEPARATE) return rows.map(one);
  return [...rows.slice(0, MAX_SEPARATE - 1).map(one), summary(rows.slice(MAX_SEPARATE - 1))];
}

/** Deliver each payload to each device; forget devices the push service has
 *  forgotten. */
export async function sendAll(
  devices: readonly PushTarget[],
  payloads: readonly PushPayload[],
  options: PushOptions,
): Promise<{ sent: number; gone: number }> {
  const gone = new Set<string>();
  const used = new Set<string>();
  await Promise.all(
    devices.map(async (device) => {
      for (const payload of payloads) {
        const result = await deliver(device, payload, options);
        if (result === 'gone') {
          gone.add(device.id);
          return;
        }
        if (result === 'sent') used.add(device.id);
      }
    }),
  );
  if (gone.size) await query('DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])', [[...gone]]);
  if (used.size)
    await query('UPDATE push_subscriptions SET last_used_at = now() WHERE id = ANY($1::uuid[])', [[...used]]);
  return { sent: used.size, gone: gone.size };
}
