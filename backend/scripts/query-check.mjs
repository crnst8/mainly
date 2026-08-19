/**
 * Correctness checks for the query engine, against seeded data.
 *
 * Smoke tests prove the SQL parses. These prove it means what the contract
 * says it means: threading collapses, facets count the scope rather than the
 * filtered set, keyset pagination does not skip or repeat, and priority sort
 * beats recency across accounts.
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5274/api';

let cookies = '';
let csrf = '';

async function call(path, { method = 'GET', body } = {}) {
  const headers = { cookie: cookies };
  if (body) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const jar = new Map(cookies.split('; ').filter(Boolean).map((x) => x.split('=').slice(0, 2)));
    const [k, v] = c.split(';')[0].split('=');
    jar.set(k, v);
    cookies = [...jar].map(([a, b]) => `${a}=${b}`).join('; ');
  }
  const next = res.headers.get('x-csrf-token');
  if (next) csrf = next;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const EMPTY = {
  unreadOnly: false,
  flaggedOnly: false,
  hasAttachments: false,
  accountIds: [],
  domains: [],
  folderIds: [],
  priorities: [],
  labels: [],
  since: null,
  before: null,
};

const q = (over = {}) => ({
  scope: { kind: 'unified', value: null, role: 'inbox' },
  sort: 'date',
  dir: 'desc',
  group: 'none',
  threaded: false,
  filters: EMPTY,
  limit: 100,
  cursor: null,
  ...over,
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

await call('/auth/login', {
  method: 'POST',
  body: { email: 'smoke@example.test', password: 'smoke-password-1234' },
});

/* Seeded: 40 messages on bigchungus.holdings (critical, hours apart, thr-a shared by 2),
   25 on notchungus.xyz (muted, days apart). 65 total, 64 threads. */

const flat = await call('/messages/query', { method: 'POST', body: q() });
check('unthreaded returns all 65', flat.body.total === 65, `got ${flat.body.total}`);

const threaded = await call('/messages/query', { method: 'POST', body: q({ threaded: true }) });
check(
  'threading collapses the shared thread (65 → 64)',
  threaded.body.messages.length === 64,
  `got ${threaded.body.messages.length}`,
);
const collapsed = threaded.body.messages.find((m) => m.threadId === 'thr-a');
check('collapsed row carries threadCount 2', collapsed?.threadCount === 2, JSON.stringify(collapsed?.threadCount));
check('collapsed rollup sees an attachment on any message', collapsed?.hasAttachments === true, JSON.stringify(collapsed?.hasAttachments));

let threadedCursor = null;
const threadedIds = new Set();
let threadedPages = 0;
let threadedRepeat = false;
do {
  const page = await call('/messages/query', {
    method: 'POST',
    body: q({ threaded: true, limit: 10, cursor: threadedCursor }),
  });
  for (const message of page.body.messages) {
    if (threadedIds.has(message.id)) threadedRepeat = true;
    threadedIds.add(message.id);
  }
  threadedCursor = page.body.nextCursor;
  threadedPages++;
} while (threadedCursor && threadedPages < 20);
check(
  'threaded keyset pages contain 64 distinct rows',
  !threadedCursor && !threadedRepeat && threadedIds.size === 64,
  `${threadedIds.size} ids, cursor ${threadedCursor}`,
);

const threadedUnread = await call('/messages/query', {
  method: 'POST',
  body: q({ threaded: true, filters: { ...EMPTY, unreadOnly: true } }),
});
check(
  'filtered threaded queries stay on the message-collapse path',
  threadedUnread.body.messages.every((m) => !m.seen) && threadedUnread.body.messages.length <= flat.body.messages.length,
  `got ${threadedUnread.body.messages.length}`,
);

const byDate = await call('/messages/query', { method: 'POST', body: q() });
const dates = byDate.body.messages.map((m) => Date.parse(m.date));
check(
  'date desc is monotonic',
  dates.every((d, i) => i === 0 || d <= dates[i - 1]),
  'ordering broke',
);

// The seeded muted account has newer-by-hours messages than nothing, but the
// critical account must still sort first under priority.
const byPriority = await call('/messages/query', { method: 'POST', body: q({ sort: 'priority' }) });
const firstTen = byPriority.body.messages.slice(0, 10);
check(
  'priority sort puts critical before muted',
  firstTen.every((m) => m.priority === 'critical'),
  firstTen.map((m) => m.priority).join(','),
);

const PRIORITY = { muted: 0, low: 1, normal: 2, high: 3, critical: 4 };
const sortKeys = {
  sender: (m) => (m.from.name ?? m.from.address).toLowerCase(),
  subject: (m) => m.subject.replace(/^((re|fwd|fw)\s*:\s*)+/i, '').toLowerCase(),
  size: (m) => m.size,
  unread: (m) => Number(m.seen),
  priority: (m) => PRIORITY[m.priority],
};
const sortValues = async (sort, dir) => {
  const result = (await call('/messages/query', {
    method: 'POST',
    body: q({ sort, dir, limit: 100 }),
  })).body;
  return { result, keys: result.messages.map(sortKeys[sort]) };
};
for (const sort of Object.keys(sortKeys)) {
  const asc = await sortValues(sort, 'asc');
  const desc = await sortValues(sort, 'desc');
  check(
    `${sort} asc is monotonic`,
    asc.keys.every((value, i) => i === 0 || value >= asc.keys[i - 1]),
    asc.keys.slice(0, 8).join(', '),
  );
  check(
    `${sort} desc is the reverse ordering`,
    desc.keys.join('|') === [...asc.keys].reverse().join('|'),
    `${asc.keys.slice(0, 5).join(', ')} / ${desc.keys.slice(0, 5).join(', ')}`,
  );

  let cursor = null;
  const ids = new Set();
  let pages = 0;
  let repeat = false;
  do {
    const page = (await call('/messages/query', {
      method: 'POST',
      body: q({ sort, dir: 'desc', limit: 10, cursor }),
    })).body;
    for (const message of page.messages) {
      if (ids.has(message.id)) repeat = true;
      ids.add(message.id);
    }
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 20);
  check(
    `${sort} pagination contains all 65 rows once`,
    !cursor && !repeat && ids.size === 65,
    `${ids.size} ids, cursor ${cursor}`,
  );
}

// Facets are computed over the scope with filters removed, so turning a filter
// on must not change the counts the filter bar shows.
const unfiltered = await call('/messages/query', { method: 'POST', body: q() });
const filtered = await call('/messages/query', {
  method: 'POST',
  body: q({ filters: { ...EMPTY, unreadOnly: true } }),
});
check(
  'facets ignore active filters',
  unfiltered.body.facets.unread === filtered.body.facets.unread,
  `${unfiltered.body.facets.unread} vs ${filtered.body.facets.unread}`,
);
check(
  'unreadOnly actually filters',
  filtered.body.messages.every((m) => !m.seen) && filtered.body.total < 65,
  `total ${filtered.body.total}`,
);

check(
  'facets split by domain',
  unfiltered.body.facets.domains['bigchungus.holdings'] === 40 &&
    unfiltered.body.facets.domains['notchungus.xyz'] === 25,
  JSON.stringify(unfiltered.body.facets.domains),
);
check(
  'facet counts count messages rather than label joins',
  unfiltered.body.facets.labels.receipts === 10 &&
    unfiltered.body.facets.labels.finance === 2 &&
    unfiltered.body.facets.domains['bigchungus.holdings'] === 40,
  JSON.stringify(unfiltered.body.facets),
);

// Keyset pagination: two pages must tile the result exactly, with no overlap.
const p1 = await call('/messages/query', { method: 'POST', body: q({ limit: 20 }) });
check('page 1 returns a cursor', !!p1.body.nextCursor, 'no cursor');
const p2 = await call('/messages/query', {
  method: 'POST',
  body: q({ limit: 20, cursor: p1.body.nextCursor }),
});
const ids1 = new Set(p1.body.messages.map((m) => m.id));
const overlap = p2.body.messages.filter((m) => ids1.has(m.id));
check('pages do not overlap', overlap.length === 0, `${overlap.length} repeated rows`);
check('page 2 is full', p2.body.messages.length === 20, `got ${p2.body.messages.length}`);

// Scope narrowing.
const domainScoped = await call('/messages/query', {
  method: 'POST',
  body: q({ scope: { kind: 'domain', value: 'bigchungus.holdings', role: 'inbox' } }),
});
check('domain scope narrows to 40', domainScoped.body.total === 40, `got ${domainScoped.body.total}`);

const labelled = await call('/messages/query', {
  method: 'POST',
  body: q({ filters: { ...EMPTY, labels: ['receipts'] } }),
});
check(
  'label filter matches the 10 seeded rows',
  labelled.body.total === 10 && labelled.body.messages.every((m) => m.labels.includes('receipts')),
  `got ${labelled.body.total}`,
);

/* Search.

   The syntax is parsed by the shared `contract/search.ts`; the SQL that
   executes it is hand-written in `search-sql.ts`. These checks are the only
   thing standing between the two, so every operator gets one — a syntax that
   means one thing in the mock adapter and another here is worse than no syntax
   at all.

   Seeded: 65 messages, 13 with "Invoice" subjects, 5 with attachments, 35 seen,
   8 flagged, sizes 500…40000, senders sender1@example.com … , 20 labelled
   `receipts`, all in folders named Inbox. */

const find = async (value, over = {}) =>
  (await call('/messages/query', {
    method: 'POST',
    body: q({ scope: { kind: 'search', value, role: null }, ...over }),
  })).body;

const search = await find('invoice');
check('search finds the 13 invoice subjects', search.total === 13, `got ${search.total}`);

const fromOne = await find('from:sender3@example.com');
check(
  'from: matches the address',
  fromOne.messages.length > 0 && fromOne.messages.every((m) => m.from.address === 'sender3@example.com'),
  `got ${fromOne.total}`,
);

// Substring, not exact: `from:"Sender 3"` also finds Sender 30…39, which is
// what a user typing a partial name wants and what the mock does too.
const fromName = await find('from:"Sender 3"');
check(
  'from: matches the display name as a substring',
  fromName.total >= fromOne.total && fromName.messages.every((m) => /Sender 3/.test(m.from.name)),
  `got ${fromName.total}`,
);

const subjectOnly = await find('subject:invoice');
check('subject: matches only the subject', subjectOnly.total === 13, `got ${subjectOnly.total}`);

const bodyWord = await find('xylophone', { sort: 'relevance' });
check('body-only search finds the body and subject matches', bodyWord.total === 2, `got ${bodyWord.total}`);
check(
  'subject matches outrank body matches',
  /xylophone/i.test(bodyWord.messages[0]?.subject ?? ''),
  bodyWord.messages.map((m) => m.subject).join(' | '),
);
const nullBodySubject = await find('subject:xylophone');
check(
  'a null body vector does not hide subject matches',
  nullBodySubject.total === 1 && /xylophone/i.test(nullBodySubject.messages[0]?.subject ?? ''),
  `got ${nullBodySubject.total}`,
);
const sync = await call('/sync');
check(
  'sync reports body-index progress',
  sync.body.bodySearch?.indexed === 1 && sync.body.bodySearch?.total === 65,
  JSON.stringify(sync.body.bodySearch),
);

// Counts are derived, not hardcoded: the smoke run mutates flags before this
// script executes, so an absolute number here fails for a reason that has
// nothing to do with search.
const seenCount = flat.body.messages.filter((m) => m.seen).length;
const unread = await find('is:unread');
check(
  'is:unread matches exactly the unseen',
  unread.total === 65 - seenCount && unread.messages.every((m) => !m.seen),
  `${unread.total} vs ${65 - seenCount}`,
);
const read = await find('is:read');
check(
  'is:read matches exactly the seen, and the two partition the corpus',
  read.total === seenCount && read.total + unread.total === 65,
  `${read.total} + ${unread.total}`,
);
const flagged = await find('is:flagged');
check(
  'is:flagged matches only flagged rows',
  flagged.messages.every((m) => m.flagged) &&
    flagged.total === flat.body.messages.filter((m) => m.flagged).length,
  `got ${flagged.total}`,
);
const attach = await find('has:attachment');
check('has:attachment matches the 5', attach.total === 5, `got ${attach.total}`);

const labelled2 = await find('label:receipts');
check(
  'label: matches and every row carries it',
  labelled2.total === 10 && labelled2.messages.every((m) => m.labels.includes('receipts')),
  `got ${labelled2.total}`,
);

const inFolder = await find('folder:inbox');
check('folder: matches by role', inFolder.total === 65, `got ${inFolder.total}`);
const noFolder = await find('folder:nowhere');
check('folder: with no match returns nothing', noFolder.total === 0, `got ${noFolder.total}`);

const big = await find('larger:20kb');
check(
  'larger: filters on size',
  big.total > 0 && big.messages.every((m) => m.size > 20480),
  `got ${big.total}`,
);
const small = await find('smaller:5kb');
check(
  'smaller: filters on size',
  small.total > 0 && small.messages.every((m) => m.size < 5120),
  `got ${small.total}`,
);

const dated = await find('after:2026-01-01');
check('after: filters on date', dated.total === 65, `got ${dated.total}`);
const none = await find('after:2030-01-01');
check('after: in the future matches nothing', none.total === 0, `got ${none.total}`);

// Negation. The complement of a search must be exactly the rest of the corpus,
// which is the one property a hand-written NOT is most likely to get wrong on
// nullable columns.
const negated = await find('-invoice');
check(
  'negation returns the exact complement',
  negated.total === 65 - 13,
  `${negated.total} + ${search.total} should be 65`,
);
const negatedFlag = await find('-is:read');
check(
  'negating a flag is exactly its complement',
  negatedFlag.total === unread.total,
  `${negatedFlag.total} vs ${unread.total}`,
);

// AND within a group, OR between groups.
const anded = await find('invoice is:unread');
check(
  'clauses AND within a group',
  anded.total < search.total && anded.messages.every((m) => !m.seen),
  `got ${anded.total}`,
);
const ored = await find('from:sender3@example.com OR from:sender4@example.com');
check(
  'OR unions groups',
  ored.total > 0 &&
    ored.messages.every((m) =>
      ['sender3@example.com', 'sender4@example.com'].includes(m.from.address),
    ),
  `got ${ored.total}`,
);

// Postel. A malformed query must return results, not an error — the user is
// mid-typing and an error page is not an answer.
const malformed = await find('from: is:purple after:soonish larger:enormous "unclosed');
check(
  'a malformed query degrades to text and still answers',
  malformed !== null && typeof malformed.total === 'number',
  JSON.stringify(malformed),
);
const stray = await call('/messages/query', {
  method: 'POST',
  body: q({ scope: { kind: 'search', value: '%_\\ OR OR', role: null } }),
});
check('LIKE metacharacters are escaped, not executed', stray.status === 200, `got ${stray.status}`);

// Ranking: relevance must beat recency without ignoring it.
const ranked = await find('invoice', { sort: 'relevance', dir: 'desc' });
check(
  'relevance sort returns the same set as date sort',
  ranked.total === search.total,
  `${ranked.total} vs ${search.total}`,
);
check(
  'relevance puts subject matches first',
  ranked.messages.slice(0, 5).every((m) => /invoice/i.test(m.subject)),
  ranked.messages.slice(0, 5).map((m) => m.subject).join(' | '),
);
const rankedPage1 = await find('invoice', { sort: 'relevance', limit: 5 });
const rankedPage2 = await call('/messages/query', {
  method: 'POST',
  body: q({
    scope: { kind: 'search', value: 'invoice', role: null },
    sort: 'relevance',
    limit: 5,
    cursor: rankedPage1.nextCursor,
  }),
});
const seenIds = new Set(rankedPage1.messages.map((m) => m.id));
check(
  'relevance pages do not overlap',
  rankedPage1.nextCursor &&
    rankedPage2.body.messages.length > 0 &&
    rankedPage2.body.messages.every((m) => !seenIds.has(m.id)),
  `cursor ${rankedPage1.nextCursor}`,
);

// A relevance sort with nothing textual to rank must still return rows rather
// than ordering everything by the same constant.
const flagsOnly = await find('is:unread', { sort: 'relevance' });
const flagDates = flagsOnly.messages.map((m) => Date.parse(m.date));
check(
  'relevance with no text falls back to date',
  flagsOnly.total === unread.total && flagDates.every((d, i) => i === 0 || d <= flagDates[i - 1]),
  `got ${flagsOnly.total}`,
);

check(
  'relevance never returns the same message twice',
  new Set(ranked.messages.map((m) => m.id)).size === ranked.messages.length,
  `${ranked.messages.length} rows, ${new Set(ranked.messages.map((m) => m.id)).size} ids`,
);

/* ── Adaptive ranking ───────────────────────────────────────────────────────
   The profile is chosen by `classifyIntent` and scaled by stored preferences,
   both in the contract. What is only testable here is whether Postgres agrees:
   the weights become a `ts_rank_cd` weights array and a chain of CASE
   multipliers, and none of that is exercised by the TypeScript checks.

   `subject OR newsletter` is the one query that scores both accounts the same
   way: each side has exactly one A-weighted subject hit, so `ts_rank_cd` is
   near enough uniform and the boosts are what is being measured. Recency is
   dialled to 0 first, because the critical account's mail is also the newer
   mail and a passing test must not be able to pass for that reason. */

const BOTH = 'subject OR newsletter'; // 27 on the critical account, 25 on the muted one.
const CRITICAL_N = 27;

const prefsBefore = (await call('/preferences')).body;
const withWeights = (weights, adaptive = true) =>
  call('/preferences', {
    method: 'PUT',
    body: { ...prefsBefore, search: { adaptive, weights: { ...prefsBefore.search.weights, ...weights } } },
  });

const criticalId = flat.body.messages[0].accountId;
const shape = (r) => r.messages.map((m) => (m.accountId === criticalId ? 'C' : 'm')).join('');

await withWeights({ recency: 0, accountPriority: 2 });
const byTier = await find(BOTH, { sort: 'relevance', limit: 65 });
check(
  'the fixture query really does straddle both accounts',
  byTier.total === 52,
  `got ${byTier.total}`,
);
check(
  'account priority lifts a critical account above a muted one',
  byTier.messages.slice(0, CRITICAL_N).every((m) => m.accountId === criticalId),
  shape(byTier),
);

await withWeights({ recency: 0, accountPriority: 0 });
const byNothing = await find(BOTH, { sort: 'relevance', limit: 65 });
check(
  'account priority at 0 stops sorting by account',
  byNothing.messages.slice(0, CRITICAL_N).some((m) => m.accountId !== criticalId),
  shape(byNothing),
);

check(
  'changing the weights changes the order and not the set',
  byTier.total === byNothing.total &&
    new Set(byTier.messages.map((m) => m.id)).size === byTier.messages.length,
  `${byTier.total} vs ${byNothing.total}`,
);

// Adaptive off must reproduce the shipped `general` profile exactly. The query
// above already classifies as `general`, so the two runs have to be identical
// row for row — this is the escape hatch, and it has to be real.
await withWeights({ recency: 0, accountPriority: 2 }, false);
const pinned = await find(BOTH, { sort: 'relevance', limit: 65 });
await withWeights({ recency: 0, accountPriority: 2 }, true);
const adaptive = await find(BOTH, { sort: 'relevance', limit: 65 });
check(
  'a general-intent query ranks the same with adaptive on or off',
  pinned.messages.map((m) => m.id).join() === adaptive.messages.map((m) => m.id).join(),
  'ordering diverged for a query whose intent is already `general`',
);

// A file hunt is a different profile, so it must reach Postgres as different
// SQL — and still return exactly the rows the same filter returns by date.
const fileByDate = await find('has:attachment invoice', { sort: 'date' });
const fileByRank = await find('has:attachment invoice', { sort: 'relevance' });
check(
  'a file-intent search returns the same set as its date sort',
  fileByRank.total === fileByDate.total &&
    new Set(fileByRank.messages.map((m) => m.id)).size === fileByRank.messages.length,
  `${fileByRank.total} vs ${fileByDate.total}`,
);

// Junk and trash are demoted by a CASE over `f.role`, which is the only part of
// the rank expression that needs the folders join. If the join were wrong the
// row count would move, so asserting the count is asserting the join.
check(
  'the folder-role demotion joins folders without duplicating rows',
  ranked.messages.length === new Set(ranked.messages.map((m) => m.id)).size &&
    ranked.total === search.total,
  `${ranked.total} vs ${search.total}`,
);

// Weights arrive as JSON and are interpolated into the rank expression, not
// bound. `sqlNumber` is the only thing between a preference blob and the SQL
// text, so a hostile value must produce a normal search rather than an error.
await call('/preferences', {
  method: 'PUT',
  body: {
    ...prefsBefore,
    search: {
      adaptive: true,
      weights: { ...prefsBefore.search.weights, subject: '1); DROP TABLE messages;--', recency: null },
    },
  },
});
const hostile = await find('invoice', { sort: 'relevance' });
check(
  'a non-numeric weight cannot reach the SQL text',
  hostile.total === search.total,
  `got ${hostile.total}`,
);

await call('/preferences', { method: 'PUT', body: prefsBefore });

// The folder filter added alongside accountIds and domains.
const folderId = flat.body.messages[0].folderId;
const folderFiltered = await call('/messages/query', {
  method: 'POST',
  body: q({ filters: { ...EMPTY, folderIds: [folderId] } }),
});
check(
  'folderIds filter narrows to that folder',
  folderFiltered.body.messages.every((m) => m.folderId === folderId),
  `got ${folderFiltered.body.total}`,
);
const noFolders = await call('/messages/query', {
  method: 'POST',
  body: q({ filters: { ...EMPTY, folderIds: [] } }),
});
check(
  'an empty folderIds array means no restriction, not nothing',
  noFolders.body.total === 65,
  `got ${noFolders.body.total}`,
);

/* Single message and thread reads.

   These exist because `GET /messages/:id` used to return the raw database row.
   It typechecked on the server (the handler was untyped), it returned 200, and
   it crashed the reader on the first render — `from` and `to` simply do not
   exist under those names. Any endpoint that claims to return a contract type
   gets asserted on the field names the contract actually declares. */

const one = await call(`/messages/${flat.body.messages[0].id}`);
const CONTRACT_FIELDS = [
  'id',
  'accountId',
  'folderId',
  'threadId',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'date',
  'seen',
  'labels',
  'priority',
  'bodyHtml',
  'bodyText',
  'attachments',
  'headers',
  'references',
  'hasBlockedRemoteContent',
];
const missing = CONTRACT_FIELDS.filter((k) => !(k in (one.body ?? {})));
check('message read returns the contract shape', missing.length === 0, `missing ${missing.join(', ')}`);
check(
  'message read carries a parsed from address',
  typeof one.body?.from?.address === 'string' && Array.isArray(one.body?.to),
  JSON.stringify(one.body?.from),
);
check(
  'message read leaks no snake_case columns',
  !Object.keys(one.body ?? {}).some((k) => k.includes('_')),
  Object.keys(one.body ?? {}).filter((k) => k.includes('_')).join(', '),
);

const thread = await call('/threads/thr-a');
check(
  'thread read returns both messages, oldest first',
  thread.body?.messages?.length === 2 &&
    Date.parse(thread.body.messages[0].date) <= Date.parse(thread.body.messages[1].date),
  JSON.stringify(thread.body?.messages?.map((m) => m.date)),
);
check(
  'thread read dedupes participants',
  Array.isArray(thread.body?.participants) &&
    new Set(thread.body.participants.map((p) => p.address)).size ===
      thread.body.participants.length,
  JSON.stringify(thread.body?.participants),
);

const missingThread = await call('/threads/thr-does-not-exist');
check('an unknown thread is 404, not 500', missingThread.status === 404, `got ${missingThread.status}`);

/* A snoozed row must not shorten the page it would have appeared on.

   The thread-index path seeks `thread_folders` per folder, and the snooze test
   reaches the representative message. Applying it after the lateral's LIMIT
   returns fewer rows than were asked for, `hasMore` reads that short page as the
   end of the list, and the cursor comes back null with most of the mailbox
   unvisited. A single folder is what exposes it: with one folder there is no
   second stream to make up the shortfall.

   Runs last because it mutates. Every earlier check asserts absolute counts. */

const byFolder = new Map();
for (const message of flat.body.messages) {
  byFolder.set(message.folderId, (byFolder.get(message.folderId) ?? 0) + 1);
}
const [biggestFolder] = [...byFolder].sort((a, b) => b[1] - a[1])[0];
const scopedFolder = { kind: 'folder', value: biggestFolder, role: null };

const pageThrough = async () => {
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const page = await call('/messages/query', {
      method: 'POST',
      body: q({ scope: scopedFolder, threaded: true, limit: 10, cursor }),
    });
    for (const message of page.body.messages) seen.add(message.threadId);
    cursor = page.body.nextCursor;
    pages++;
  } while (cursor && pages < 40);
  return { threads: seen.size, exhausted: !cursor };
};

const beforeSnooze = await pageThrough();
check(
  'a single-folder threaded scope pages to the end',
  beforeSnooze.exhausted && beforeSnooze.threads > 10,
  JSON.stringify(beforeSnooze),
);

const newest = await call('/messages/query', {
  method: 'POST',
  body: q({ scope: scopedFolder, limit: 1 }),
});
const snoozedId = newest.body.messages[0].id;
await call('/messages/actions', {
  method: 'POST',
  body: {
    ids: [snoozedId],
    action: { type: 'snooze', until: new Date(Date.now() + 864e5).toISOString() },
  },
});

const afterSnooze = await pageThrough();
check(
  'snoozing the newest row hides one thread and truncates nothing',
  afterSnooze.exhausted && afterSnooze.threads === beforeSnooze.threads - 1,
  `${JSON.stringify(afterSnooze)} against ${JSON.stringify(beforeSnooze)}`,
);

await call('/messages/actions', {
  method: 'POST',
  body: {
    ids: [snoozedId],
    action: { type: 'snooze', until: new Date(Date.now() - 864e5).toISOString() },
  },
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall query checks passed');
process.exit(failures ? 1 : 0);
