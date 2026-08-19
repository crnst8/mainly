/**
 * Correctness checks for the search syntax.
 *
 * The parser is the half of search that is shared between the mock adapter and
 * Postgres, so it is the half where a mistake shows up as "the same query means
 * two different things". Every operator is asserted on what it parses to, and
 * every malformed input is asserted to survive as text rather than throw.
 *
 * Runs under Node's type stripping — `search.ts` has no runtime imports.
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_SEARCH_PREFERENCES,
  classifyIntent,
  isEmptySearch,
  matchesSearch,
  parseDateish,
  parseSearch,
  parseSize,
  relevanceScore,
  resolveProfile,
  searchTerms,
  sqlNumber,
  withSearchDefaults,
} from '../src/lib/search.ts';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 5).join('\n    ')}`);
  }
}

/** A fixed clock, so "last week" is a fact rather than a moving target.
 *  Friday 7 August 2026, local time. */
const NOW = new Date(2026, 7, 7, 12, 0, 0).getTime();

const msg = (over = {}) => ({
  id: 'm1',
  accountId: 'a1',
  folderId: 'f1',
  threadId: 't1',
  messageId: '<x@y>',
  from: { name: 'Anna Reyes', address: 'anna.reyes@acme.co' },
  to: [{ name: 'Dale', address: 'dale@bigchungus.holdings' }],
  subject: 'Invoice #9470 — payment received',
  preview: 'Attached is the pricing sheet for the 2026 run.',
  date: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
  seen: false,
  flagged: false,
  answered: false,
  draft: false,
  hasAttachments: true,
  attachmentCount: 1,
  threadCount: 1,
  size: 24_000,
  labels: ['receipts'],
  priority: 'normal',
  ...over,
});

const CTX = { folderNames: () => ['Receipts', 'custom'] };
const match = (raw, m = msg()) => matchesSearch(m, parseSearch(raw, NOW), CTX);
const clauses = (raw) => parseSearch(raw, NOW).groups.flat();

/* ── Operators parse to what they say ─────────────────────────────────────── */

check('field operators', () => {
  assert.deepEqual(
    clauses('from:anna to:dale subject:invoice label:tax folder:receipts').map((c) => [
      c.field,
      c.value,
    ]),
    [
      ['from', 'anna'],
      ['to', 'dale'],
      ['subject', 'invoice'],
      ['label', 'tax'],
      ['folder', 'receipts'],
    ],
  );
});

check('is: and has: become flag clauses', () => {
  assert.deepEqual(
    clauses('is:unread is:read is:flagged is:answered has:attachment').map((c) => c.field),
    ['unread', 'read', 'flagged', 'answered', 'attachment'],
  );
});

check('aliases resolve to the same field', () => {
  assert.equal(clauses('in:inbox')[0].field, 'folder');
  assert.equal(clauses('is:starred')[0].field, 'flagged');
  assert.equal(clauses('has:file')[0].field, 'attachment');
  assert.equal(clauses('since:2026-01-01')[0].field, 'after');
  assert.equal(clauses('bigger:1mb')[0].field, 'larger');
});

check('a quoted value stays one clause', () => {
  const c = clauses('from:"anna reyes"');
  assert.equal(c.length, 1);
  assert.equal(c[0].value, 'anna reyes');
  assert.equal(c[0].phrase, true);
});

check('a fully quoted token is a phrase, not an operator', () => {
  const c = clauses('"time: 4pm"');
  assert.equal(c.length, 1);
  assert.equal(c[0].field, 'text');
  assert.equal(c[0].value, 'time: 4pm');
});

check('negation', () => {
  assert.equal(clauses('-from:anna')[0].negated, true);
  assert.equal(clauses('-newsletter')[0].negated, true);
  assert.equal(clauses('-"exact phrase"')[0].value, 'exact phrase');
});

check('OR splits groups, AND is the default within one', () => {
  const q = parseSearch('from:anna OR from:ben has:attachment', NOW);
  assert.equal(q.groups.length, 2);
  assert.equal(q.groups[0].length, 1);
  assert.equal(q.groups[1].length, 2);
  assert.equal(parseSearch('a | b', NOW).groups.length, 2);
});

check('lowercase "or" is a search term, not an operator', () => {
  // Accepting it would break a literal search for the word, which is a worse
  // failure than requiring the shift key.
  assert.equal(parseSearch('cats or dogs', NOW).groups.length, 1);
  assert.equal(parseSearch('cats or dogs', NOW).groups[0].length, 3);
});

/* ── Values ───────────────────────────────────────────────────────────────── */

check('dates in every accepted shape', () => {
  // Compared as local calendar days, because that is what the user means: a
  // Sydney user typing after:2026-01-15 means their midnight, not UTC's.
  const day = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  assert.equal(day(parseDateish('2026-01-15', NOW)), '2026-01-15');
  assert.equal(day(parseDateish('today', NOW)), '2026-08-07');
  assert.equal(day(parseDateish('yesterday', NOW)), '2026-08-06');
  // 7 Aug 2026 is a Friday; a Monday-first week starts on the 3rd.
  assert.equal(day(parseDateish('this week', NOW)), '2026-08-03');
  assert.equal(day(parseDateish('last week', NOW)), '2026-07-27');
  assert.equal(day(parseDateish('this month', NOW)), '2026-08-01');
  assert.equal(day(parseDateish('last month', NOW)), '2026-07-01');
  assert.equal(day(parseDateish('7d', NOW)), '2026-07-31');
  assert.equal(day(parseDateish('2w', NOW)), '2026-07-24');
  assert.equal(day(parseDateish('1y', NOW)), '2025-08-07');
});

check('sizes', () => {
  assert.equal(parseSize('5mb'), 5 * 1024 ** 2);
  assert.equal(parseSize('100kb'), 102_400);
  assert.equal(parseSize('1.5gb'), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseSize('2048'), 2048);
  assert.equal(parseSize('big'), null);
});

/* ── Postel: nothing throws, nothing is rejected ──────────────────────────── */

check('an unknown field degrades to text', () => {
  const c = clauses('wharrgarbl:foo');
  assert.equal(c[0].field, 'text');
  assert.equal(c[0].value, 'wharrgarbl:foo');
});

check('an unparseable date degrades to text', () => {
  const c = clauses('after:soonish');
  assert.equal(c[0].field, 'text');
  assert.equal(c[0].value, 'after:soonish');
});

check('an unparseable size degrades to text', () => {
  assert.equal(clauses('larger:enormous')[0].field, 'text');
});

check('an unknown is: value degrades to text', () => {
  assert.equal(clauses('is:purple')[0].field, 'text');
});

check('a bare operator with no value degrades to text', () => {
  assert.equal(clauses('from:')[0].value, 'from:');
});

check('an unbalanced quote runs to the end and does not throw', () => {
  const c = clauses('subject:"unfinished business');
  assert.equal(c.length, 1);
  assert.equal(c[0].value, 'unfinished business');
});

check('an empty query matches everything', () => {
  assert.equal(isEmptySearch(parseSearch('', NOW)), true);
  assert.equal(isEmptySearch(parseSearch('   ', NOW)), true);
  assert.equal(match(''), true);
});

check('a lone OR does not produce an empty group', () => {
  assert.equal(parseSearch('OR', NOW).groups.length, 0);
  assert.equal(parseSearch('a OR OR b', NOW).groups.length, 2);
});

/* ── Matching ─────────────────────────────────────────────────────────────── */

check('field operators match the right fields', () => {
  assert.equal(match('from:anna'), true);
  assert.equal(match('from:ben'), false);
  assert.equal(match('to:dale'), true);
  assert.equal(match('subject:invoice'), true);
  assert.equal(match('subject:pricing'), false, 'pricing is in the preview, not the subject');
  assert.equal(match('label:receipts'), true);
  assert.equal(match('folder:receipts'), true);
  assert.equal(match('folder:custom'), true, 'a role is a name a folder answers to');
  assert.equal(match('folder:inbox'), false, 'the IMAP path is not searchable — everything is under INBOX.');
});

check('bare text searches subject, preview, sender, recipients and labels', () => {
  assert.equal(match('pricing'), true);
  assert.equal(match('acme.co'), true);
  assert.equal(match('receipts'), true);
  assert.equal(match('nonsense'), false);
});

check('flags match', () => {
  assert.equal(match('is:unread'), true);
  assert.equal(match('is:read'), false);
  assert.equal(match('has:attachment'), true);
  assert.equal(match('is:flagged'), false);
  assert.equal(match('is:flagged', msg({ flagged: true })), true);
});

check('negation excludes', () => {
  assert.equal(match('-from:anna'), false);
  assert.equal(match('-from:ben'), true);
  assert.equal(match('invoice -pricing'), false);
  assert.equal(match('invoice -nonsense'), true);
});

check('clauses in a group AND', () => {
  assert.equal(match('from:anna has:attachment'), true);
  assert.equal(match('from:anna is:read'), false);
});

check('groups OR', () => {
  assert.equal(match('from:ben OR from:anna'), true);
  assert.equal(match('from:ben OR from:carol'), false);
});

check('dates and sizes match', () => {
  assert.equal(match('after:2026-08-01'), true);
  assert.equal(match('after:2026-08-07'), false);
  assert.equal(match('before:2026-08-07'), true);
  assert.equal(match('larger:10kb'), true);
  assert.equal(match('larger:1mb'), false);
  assert.equal(match('smaller:1mb'), true);
});

check('the spec example runs', () => {
  // from:anna has:attachment after:"last week" — the acceptance case.
  assert.equal(match('from:anna has:attachment after:"last week"'), true);
  assert.equal(
    match('from:anna has:attachment after:"last week"', msg({ hasAttachments: false })),
    false,
  );
  assert.equal(
    match(
      'from:anna has:attachment after:"last week"',
      msg({ date: new Date(2026, 5, 1).toISOString() }),
    ),
    false,
  );
});

/* ── Ranking and highlighting ─────────────────────────────────────────────── */

check('a subject hit outranks a preview hit', () => {
  const same = { date: msg().date };
  const inSubject = msg({ ...same, subject: 'pricing sheet', preview: 'nothing here' });
  const inPreview = msg({ ...same, subject: 'nothing here', preview: 'pricing sheet' });
  const q = parseSearch('pricing', NOW);
  assert.ok(relevanceScore(inSubject, q, NOW) > relevanceScore(inPreview, q, NOW));
});

check('recency decays but does not decide', () => {
  const q = parseSearch('pricing', NOW);
  const old = msg({ subject: 'pricing sheet', date: new Date(2019, 0, 1).toISOString() });
  const fresh = msg({ subject: 'pricing sheet', date: new Date(2026, 7, 6).toISOString() });
  const weak = msg({ subject: 'nothing', preview: 'pricing', date: fresh.date });
  assert.ok(relevanceScore(fresh, q, NOW) > relevanceScore(old, q, NOW), 'fresh beats stale');
  // A 2019 subject hit still beats yesterday's passing mention — decay shades
  // the ranking, it does not replace it.
  assert.ok(relevanceScore(old, q, NOW) > relevanceScore(weak, q, NOW));
});

check('only markable, non-negated terms are offered for highlighting', () => {
  assert.deepEqual(searchTerms(parseSearch('invoice from:anna -spam is:unread', NOW)), [
    'invoice',
    'anna',
  ]);
});

/* ── Query intent ─────────────────────────────────────────────────────────── */

check('a query with nothing textual is a sweep, not a search', () => {
  assert.equal(classifyIntent(parseSearch('is:unread has:attachment', NOW)), 'triage');
  assert.equal(classifyIntent(parseSearch('is:flagged before:2026-01-01', NOW)), 'triage');
});

check('the file operators win over the person operators', () => {
  // `from:anna has:attachment` is a file hunt that names a person, not the
  // other way round. Getting this backwards buries the attachment.
  assert.equal(classifyIntent(parseSearch('from:anna has:attachment', NOW)), 'file');
  assert.equal(classifyIntent(parseSearch('contract larger:2mb', NOW)), 'file');
});

check('quoted input is a phrase; bare words are not', () => {
  assert.equal(classifyIntent(parseSearch('"quarterly report"', NOW)), 'phrase');
  assert.equal(classifyIntent(parseSearch('quarterly report', NOW)), 'general');
});

check('from: and to: outnumbering loose words makes it a person search', () => {
  assert.equal(classifyIntent(parseSearch('from:anna', NOW)), 'person');
  assert.equal(classifyIntent(parseSearch('from:anna invoice', NOW)), 'person');
  // Two loose words against one operator is no longer about the person.
  assert.equal(classifyIntent(parseSearch('from:anna invoice overdue', NOW)), 'general');
});

check('subject: alone is a subject search, and a date narrows a dated one', () => {
  assert.equal(classifyIntent(parseSearch('subject:invoice', NOW)), 'subject');
  assert.equal(classifyIntent(parseSearch('invoice after:7d', NOW)), 'dated');
});

check('negation never decides the intent', () => {
  // What you are excluding says nothing about what you are looking for.
  assert.equal(classifyIntent(parseSearch('invoice -has:attachment', NOW)), 'general');
});

/* ── Ranking profiles ─────────────────────────────────────────────────────── */

check('the general profile is the ranking this app shipped with', () => {
  const p = resolveProfile('general');
  assert.equal(p.subject, 1);
  assert.equal(p.sender, 0.4);
  assert.equal(p.preview, 0.2);
  assert.equal(p.decayFloor, 0.35);
  assert.equal(p.decayDays, 45);
});

check('a person search weights the sender above the subject', () => {
  const p = resolveProfile('person');
  assert.ok(p.sender > p.subject, `${p.sender} vs ${p.subject}`);
  assert.ok(resolveProfile('subject').sender < resolveProfile('general').sender);
});

check('a file hunt keeps far more of an old score than a sweep does', () => {
  assert.ok(resolveProfile('file').decayFloor > resolveProfile('triage').decayFloor);
  assert.ok(resolveProfile('file').decayDays > resolveProfile('triage').decayDays);
});

check('adaptive off pins every intent to the general profile', () => {
  const off = { adaptive: false, weights: DEFAULT_SEARCH_PREFERENCES.weights };
  for (const intent of ['person', 'file', 'phrase', 'triage', 'dated', 'subject']) {
    assert.deepEqual(resolveProfile(intent, off), resolveProfile('general', off));
  }
});

check('a dial at 0 removes its signal rather than inverting it', () => {
  const zero = withSearchDefaults({
    weights: { recency: 0, accountPriority: 0, unread: 0, demoteNoise: 0 },
  });
  const p = resolveProfile('general', zero);
  assert.equal(p.decayFloor, 1, 'no decay at all');
  for (const v of Object.values(p.priority)) assert.equal(v, 1);
  assert.equal(p.unread, 1);
  assert.equal(p.flagged, 1);
  for (const v of Object.values(p.folder)) assert.equal(v, 1);
});

check('a dial at 2 doubles the distance from neutral', () => {
  const loud = withSearchDefaults({ weights: { accountPriority: 2 } });
  const base = resolveProfile('general');
  const p = resolveProfile('general', loud);
  assert.equal(p.priority.critical, 1 + (base.priority.critical - 1) * 2);
  assert.equal(p.priority.muted, 1 + (base.priority.muted - 1) * 2);
});

check('a garbage dial falls back to neutral instead of poisoning the ranking', () => {
  const junk = withSearchDefaults({ weights: { subject: 'lots', recency: NaN } });
  const p = resolveProfile('general', junk);
  assert.ok(Number.isFinite(p.subject) && p.subject > 0);
  assert.ok(Number.isFinite(p.decayDays) && p.decayDays > 0);
});

check('a critical account outranks a muted one on an identical match', () => {
  const q = parseSearch('pricing', NOW);
  const p = resolveProfile('general');
  const same = { subject: 'pricing sheet', date: msg().date };
  const hot = msg({ ...same, priority: 'critical' });
  const cold = msg({ ...same, priority: 'muted' });
  assert.ok(relevanceScore(hot, q, NOW, { profile: p }) > relevanceScore(cold, q, NOW, { profile: p }));
});

check('the same match in junk ranks below the same match in the inbox', () => {
  const q = parseSearch('pricing', NOW);
  const p = resolveProfile('general');
  const m = msg({ subject: 'pricing sheet' });
  assert.ok(
    relevanceScore(m, q, NOW, { profile: p, folderRole: 'inbox' }) >
      relevanceScore(m, q, NOW, { profile: p, folderRole: 'junk' }),
  );
});

check('a query with no text still ranks, and ranks by recency', () => {
  const q = parseSearch('is:unread', NOW);
  const p = resolveProfile(classifyIntent(q));
  const fresh = msg({ date: new Date(2026, 7, 6).toISOString() });
  const old = msg({ date: new Date(2024, 0, 1).toISOString() });
  const a = relevanceScore(fresh, q, NOW, { profile: p });
  const b = relevanceScore(old, q, NOW, { profile: p });
  assert.ok(a > 0 && b > 0, 'never zero — a zero collapses the whole ordering');
  assert.ok(a > b);
});

check('every number bound for SQL comes back as digits and one dot', () => {
  for (const input of [1, 0.35, -2, 1e21, NaN, Infinity, '1); DROP TABLE messages;--', null]) {
    assert.match(sqlNumber(input), /^-?\d+\.\d{6}$/, String(input));
  }
});

console.log(`search-check: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
