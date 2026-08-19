/**
 * Correctness checks for the URL codec.
 *
 * `lib/url.ts` decides what a bookmarked link means. Typechecking says nothing
 * useful about that — a role that silently parses as `null`, or a filter that
 * round-trips into a different filter, is type-correct and wrong. So: every
 * route shape is asserted both ways, and every state is asserted to survive
 * build → parse unchanged.
 *
 * Runs under Node's type stripping, which is why `url.ts` has no runtime
 * imports of its own.
 */

import assert from 'node:assert/strict';
import { buildLocation, parseLocation, routeDefaults, sameFilters, sameScope } from '../src/lib/url.ts';

const EMPTY_FILTERS = {
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

const D = { sort: 'date', dir: 'desc', group: 'date', threaded: true, filters: EMPTY_FILTERS };

const state = (over = {}) => ({
  scope: { kind: 'unified', value: null, role: 'inbox' },
  ...D,
  openId: null,
  ...over,
  filters: { ...EMPTY_FILTERS, ...(over.filters ?? {}) },
});

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`);
  }
}

const parse = (url, defaults = D) => {
  const [path, search = ''] = url.split('?');
  return parseLocation(path, search, defaults);
};

const sameState = (a, b) =>
  sameScope(a.scope, b.scope) &&
  a.sort === b.sort &&
  a.dir === b.dir &&
  a.group === b.group &&
  a.threaded === b.threaded &&
  a.openId === b.openId &&
  sameFilters(a.filters, b.filters);

/* ── 1. Every scope shape builds to the URL it should ─────────────────────── */

check('unified inbox is the origin', () => {
  assert.equal(buildLocation(state(), D), '/');
});

check('unified with no role is /u', () => {
  assert.equal(buildLocation(state({ scope: { kind: 'unified', value: null, role: null } }), D), '/u');
});

check('unified role is /u/:role', () => {
  assert.equal(
    buildLocation(state({ scope: { kind: 'unified', value: null, role: 'sent' } }), D),
    '/u/sent',
  );
});

check('domain and role', () => {
  assert.equal(
    buildLocation(state({ scope: { kind: 'domain', value: 'bigchungus.holdings', role: 'inbox' } }), D),
    '/d/bigchungus.holdings/inbox',
  );
  assert.equal(
    buildLocation(state({ scope: { kind: 'domain', value: 'bigchungus.holdings', role: null } }), D),
    '/d/bigchungus.holdings',
  );
});

check('account, folder and saved view', () => {
  assert.equal(
    buildLocation(state({ scope: { kind: 'account', value: 'acc_1', role: 'archive' } }), D),
    '/a/acc_1/archive',
  );
  assert.equal(
    buildLocation(state({ scope: { kind: 'folder', value: 'fld_9', role: null } }), D),
    '/f/fld_9',
  );
  assert.equal(
    buildLocation(state({ scope: { kind: 'saved', value: 'view_2', role: null } }), D),
    '/v/view_2',
  );
});

check('search carries its query', () => {
  assert.equal(
    buildLocation(state({ scope: { kind: 'search', value: 'from:anna receipts', role: null } }), D),
    '/search?q=from%3Aanna+receipts',
  );
});

check('an open message is a trailing segment on its list', () => {
  assert.equal(buildLocation(state({ openId: 'msg_7' }), D), '/m/msg_7');
  assert.equal(
    buildLocation(
      state({ scope: { kind: 'domain', value: 'bigchungus.holdings', role: 'inbox' }, openId: 'msg_7' }),
      D,
    ),
    '/d/bigchungus.holdings/inbox/m/msg_7',
  );
});

/* ── 2. Defaults stay out of the URL, deviations go in ────────────────────── */

check('the default view has no query string', () => {
  assert.equal(buildLocation(state(), D), '/');
});

check('non-default sort, group and threading are explicit', () => {
  const url = buildLocation(state({ sort: 'priority', group: 'sender', threaded: false }), D);
  assert.equal(url, '/?sort=priority&group=sender&threaded=0');
});

check('filters serialise only when set', () => {
  assert.equal(
    buildLocation(state({ filters: { unreadOnly: true, labels: ['receipts', 'tax'] } }), D),
    '/?unread=1&label=receipts%2Ctax',
  );
});

check('a saved view is measured against its own query', () => {
  const view = {
    id: 'view_2',
    name: 'Receipts',
    glyph: 'R',
    color: null,
    pinned: true,
    position: 0,
    query: {
      scope: { kind: 'unified', value: null, role: null },
      sort: 'sender',
      dir: 'asc',
      group: 'sender',
      threaded: false,
      filters: { ...EMPTY_FILTERS, labels: ['receipts'] },
      limit: 200,
      cursor: null,
    },
  };
  const resolve = (scope) => routeDefaults([view], D, scope);
  const scope = { kind: 'saved', value: 'view_2', role: null };

  // As saved: nothing to say.
  const asSaved = {
    scope,
    sort: 'sender',
    dir: 'asc',
    group: 'sender',
    threaded: false,
    filters: { ...EMPTY_FILTERS, labels: ['receipts'] },
    openId: null,
  };
  assert.equal(buildLocation(asSaved, resolve), '/v/view_2');
  assert.ok(sameState(parse('/v/view_2', resolve), asSaved));

  // Deviating from it: only the deviation shows.
  assert.equal(buildLocation({ ...asSaved, sort: 'date' }, resolve), '/v/view_2?sort=date');
});

check('a search defaults to relevance and no grouping', () => {
  const scope = { kind: 'search', value: 'invoice', role: null };
  const resolve = (s) => routeDefaults([], D, s);
  const asDefault = { scope, ...D, sort: 'relevance', group: 'none', openId: null };
  // The defaults for a search are not the defaults for a list, so neither shows.
  assert.equal(buildLocation(asDefault, resolve), '/search?q=invoice');
  assert.ok(sameState(parse('/search?q=invoice', resolve), asDefault));
  // …and the user overriding them does show.
  assert.equal(
    buildLocation({ ...asDefault, sort: 'date' }, resolve),
    '/search?q=invoice&sort=date',
  );
});

check('search operators survive the round trip verbatim', () => {
  const raw = 'from:anna has:attachment after:"last week" -newsletter';
  const s = state({ scope: { kind: 'search', value: raw, role: null } });
  assert.equal(parse(buildLocation(s, D)).scope.value, raw);
});

check('a folder filter serialises', () => {
  assert.equal(buildLocation(state({ filters: { folderIds: ['fld_1', 'fld_2'] } }), D), '/?fld=fld_1%2Cfld_2');
  assert.deepEqual(parse('/?fld=fld_1,fld_2').filters.folderIds, ['fld_1', 'fld_2']);
});

/* ── 3. Round trips ───────────────────────────────────────────────────────── */

const ROUND_TRIP = [
  state(),
  state({ scope: { kind: 'unified', value: null, role: null } }),
  state({ scope: { kind: 'unified', value: null, role: 'trash' } }),
  state({ scope: { kind: 'domain', value: 'chungusglobal.com', role: null } }),
  state({ scope: { kind: 'domain', value: 'bigchungus.holdings', role: 'junk' }, openId: 'msg_1' }),
  state({ scope: { kind: 'account', value: 'acc_3', role: 'sent' } }),
  state({ scope: { kind: 'folder', value: 'fld_12', role: null }, openId: 'msg_42' }),
  state({ scope: { kind: 'search', value: 'quarterly report', role: null } }),
  state({ filters: { folderIds: ['fld_3'] } }),
  state({ sort: 'size', dir: 'asc', group: 'none', threaded: false }),
  state({
    filters: {
      unreadOnly: true,
      flaggedOnly: true,
      hasAttachments: true,
      accountIds: ['acc_1', 'acc_2'],
      domains: ['bigchungus.holdings'],
      priorities: ['critical', 'high'],
      labels: ['tax'],
      since: '2026-01-01T00:00:00.000Z',
      before: '2026-06-30T00:00:00.000Z',
    },
  }),
];

for (const [i, s] of ROUND_TRIP.entries()) {
  check(`round trip ${i}: ${buildLocation(s, D)}`, () => {
    const back = parse(buildLocation(s, D));
    assert.ok(sameState(s, back), `${JSON.stringify(back)} !== ${JSON.stringify(s)}`);
  });
}

/* ── 4. Postel: bad input degrades, never throws ──────────────────────────── */

check('an unknown route is home', () => {
  assert.ok(sameScope(parse('/nonsense/deep/path').scope, state().scope));
});

check('an unknown role falls back to no restriction', () => {
  assert.equal(parse('/d/bigchungus.holdings/wharrgarbl').scope.role, null);
  assert.equal(parse('/d/bigchungus.holdings/wharrgarbl').scope.value, 'bigchungus.holdings');
});

check('an unknown sort key falls back to the default', () => {
  assert.equal(parse('/?sort=vibes').sort, 'date');
  assert.equal(parse('/?group=phase-of-moon').group, 'date');
});

check('an unknown priority is dropped, not passed through', () => {
  assert.deepEqual(parse('/?pri=critical,urgent,low').filters.priorities, ['critical', 'low']);
});

check('an empty search is home, not an empty result set', () => {
  assert.ok(sameScope(parse('/search?q=').scope, state().scope));
  assert.ok(sameScope(parse('/search').scope, state().scope));
});

check('a malformed percent escape does not throw', () => {
  assert.equal(parse('/f/100%').scope.value, '100%');
});

check('/u/inbox canonicalises to /', () => {
  assert.equal(buildLocation(parse('/u/inbox'), D), '/');
});

/* ── 5. The reader segment ────────────────────────────────────────────────── */

check('a message deep link keeps its list scope', () => {
  const r = parse('/a/acc_1/inbox/m/msg_9');
  assert.equal(r.openId, 'msg_9');
  assert.equal(r.scope.kind, 'account');
  assert.equal(r.scope.value, 'acc_1');
  assert.equal(r.scope.role, 'inbox');
});

check('a message on the unified inbox needs no list segment', () => {
  const r = parse('/m/msg_9');
  assert.equal(r.openId, 'msg_9');
  assert.ok(sameScope(r.scope, state().scope));
});

check('a message deep link keeps its query string', () => {
  const r = parse('/search/m/msg_9?q=invoice&sort=priority');
  assert.equal(r.openId, 'msg_9');
  assert.equal(r.scope.kind, 'search');
  assert.equal(r.scope.value, 'invoice');
  assert.equal(r.sort, 'priority');
});

/* ── 6. Settings ──────────────────────────────────────────────────────────────
   Settings covers the whole viewport. A full-screen view that is not a location
   swallows the browser's Back button — Back navigated the list underneath while
   settings stayed on top, so the one control everyone reaches for to leave a
   page did nothing visible. It is a query parameter rather than a path because
   closing it must return you to exactly the list you were on. */

check('settings rides on whatever list you were looking at', () => {
  const r = parse('/d/bigchungus.holdings/inbox?settings=accounts');
  assert.equal(r.settings, 'accounts');
  assert.equal(r.scope.kind, 'domain');
  assert.equal(r.scope.value, 'bigchungus.holdings');
  assert.equal(r.scope.role, 'inbox');
});

check('no settings parameter means settings is closed', () => {
  assert.equal(parse('/').settings, null);
  assert.equal(parse('/d/bigchungus.holdings').settings, null);
});

check('settings round-trips without disturbing the list', () => {
  const url = '/a/acc_1/sent?settings=appearance&sort=priority';
  const r = parse(url);
  assert.equal(r.settings, 'appearance');
  assert.equal(buildLocation(r, D), url);
});

check('settings survives beside an open message', () => {
  const r = parse('/m/msg_9?settings=keyboard');
  assert.equal(r.settings, 'keyboard');
  assert.equal(r.openId, 'msg_9');
});

check('an empty settings parameter is closed, not a blank tab', () => {
  assert.equal(parse('/?settings=').settings, null);
});

check('closing settings drops the parameter entirely', () => {
  const r = { ...parse('/?settings=colours'), settings: null };
  assert.equal(buildLocation(r, D), '/');
});

console.log(`url-check: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
