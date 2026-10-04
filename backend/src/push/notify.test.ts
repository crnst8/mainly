import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_NOTIFICATIONS, type NotificationPreferences } from '../contract/types.ts';
import type { Arrival } from '../sync/envelopes.ts';

// notify.ts reaches the database module, which reads config on import. Nothing
// here connects; the values only have to exist.
process.env.DATABASE_URL ??= 'postgres://notify-test/none';
process.env.SECRET_KEY ??= Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET ??= 'notify-test';

const { buildPayloads, inQuietHours, newsworthy } = await import('./notify.ts');

const prefs = (patch: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  ...DEFAULT_NOTIFICATIONS,
  ...patch,
});

test('quiet hours wrap midnight in the window’s own zone', () => {
  const q = { enabled: true, start: '22:00', end: '07:00', timeZone: 'Australia/Adelaide' };
  // 13:00 UTC is 22:30 in Adelaide (ACST, UTC+9:30).
  assert.equal(inQuietHours(q, new Date('2026-07-01T13:00:00Z')), true);
  // 02:00 UTC is 11:30 in Adelaide.
  assert.equal(inQuietHours(q, new Date('2026-07-01T02:00:00Z')), false);
  assert.equal(inQuietHours({ ...q, enabled: false }, new Date('2026-07-01T13:00:00Z')), false);
  assert.equal(inQuietHours({ ...q, timeZone: 'Not/AZone' }, new Date('2026-07-01T13:00:00Z')), false);
  assert.equal(inQuietHours({ ...q, start: '09:00', end: '17:00', timeZone: 'UTC' }, new Date('2026-07-01T12:00:00Z')), true);
});

test('only fresh, unread, recent mail in the chosen folders is news', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const base: Arrival = {
    id: 'a',
    folderId: 'f',
    role: 'inbox',
    spam: false,
    seen: false,
    date: new Date(now - 60_000),
    fresh: true,
  };
  const list: Arrival[] = [
    base,
    { ...base, id: 'first-sync', fresh: false },
    { ...base, id: 'read', seen: true },
    { ...base, id: 'spam', spam: true },
    { ...base, id: 'old', date: new Date(now - 72 * 3600_000) },
    { ...base, id: 'custom', role: 'custom' },
    { ...base, id: 'sent', role: 'sent' },
  ];
  assert.deepEqual(newsworthy(list, prefs(), now).map((a) => a.id), ['a']);
  assert.deepEqual(newsworthy(list, prefs({ folders: 'all' }), now).map((a) => a.id), ['a', 'custom']);
});

test('grouped notifications share one tag per mailbox and count', () => {
  const rows = [
    { id: 'm2', from_name: 'Bea', from_address: 'b@x', subject: 'Second', preview: 'two' },
    { id: 'm1', from_name: null, from_address: 'a@x', subject: '', preview: '' },
  ];
  const account = { address: 'me@x', label: 'Work', priority: 'normal' as const };
  const grouped = buildPayloads('acc', account, rows, prefs());
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.tag, 'account:acc');
  assert.equal(grouped[0]!.count, 2);
  assert.equal(grouped[0]!.body, 'Work · Bea: Second');

  const single = buildPayloads('acc', account, rows.slice(1), prefs());
  assert.equal(single[0]!.title, 'a@x');
  assert.equal(single[0]!.body, '(no subject)');
  assert.equal(single[0]!.url, 'a/acc/m/m1');

  const hidden = buildPayloads('acc', account, rows.slice(0, 1), prefs({ content: 'count' }));
  assert.equal(hidden[0]!.title, 'New mail');
  assert.ok(!hidden[0]!.body.includes('Second'));

  const separate = buildPayloads('acc', account, rows, prefs({ group: false }));
  assert.deepEqual(separate.map((p) => p.tag), ['message:m2', 'message:m1']);
});
