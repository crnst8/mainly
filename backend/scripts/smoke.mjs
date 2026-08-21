/**
 * End-to-end smoke test against a running API.
 *
 * Exercises the paths that are easy to get wrong and impossible to typecheck:
 * the SQL in the query engine, the CSRF handshake, and the scope resolver.
 *
 *   node --experimental-strip-types scripts/smoke.mjs
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5274/api';
const EMAIL = 'smoke@example.test';
const PASSWORD = 'smoke-password-1234';

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

  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    const jar = new Map(cookies.split('; ').filter(Boolean).map((c) => c.split('=').slice(0, 2)));
    for (const c of setCookie) {
      const [k, v] = c.split(';')[0].split('=');
      jar.set(k, v);
    }
    cookies = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const nextCsrf = res.headers.get('x-csrf-token');
  if (nextCsrf) csrf = nextCsrf;

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response body */
  }
  return { status: res.status, body: json, text };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail ?? ''}`}`);
  if (!ok) failures++;
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

const health = await call('/health');
check('health responds', health.status === 200 && health.body?.ok, JSON.stringify(health.body));

const noAuth = await call('/accounts');
check('accounts requires a session', noAuth.status === 401, `got ${noAuth.status}`);

// The user is created out-of-band by scripts/create-user.mjs; log in as them.
const login = await call('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: PASSWORD },
});
check('login succeeds', login.status === 200, `${login.status} ${login.text}`);
check('csrf token issued', csrf.length > 0, 'no x-csrf-token header');

const accounts = await call('/accounts');
check('accounts lists', accounts.status === 200 && Array.isArray(accounts.body), `${accounts.status} ${accounts.text}`);

/* ── The app login ──────────────────────────────────────────────────────────
   Every assertion below typechecks perfectly while being wrong: whether the
   current password is really verified, and whether other sessions really die,
   are facts only a request can establish. */

const me = await call('/auth/session');
check('session names the signed-in user', me.status === 200 && me.body?.email === EMAIL, me.text);

// Three calls to this route per run, and no more: it is rate-limited at ten a
// minute, and a suite that spends its own budget fails on the limiter rather
// than on the code. The length floor is left to the unit-free path — the form
// enforces it before the request, and `MIN_APP_PASSWORD` is one shared constant.
const wrongCurrent = await call('/auth/password', {
  method: 'POST',
  body: { currentPassword: 'not-the-password', newPassword: 'a-perfectly-fine-password' },
});
check('password change rejects a wrong current password', wrongCurrent.status === 401, `got ${wrongCurrent.status}`);

const NEW_PASSWORD = 'smoke-password-rotated-4321';
const changed = await call('/auth/password', {
  method: 'POST',
  body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
});
check('password change succeeds', changed.status === 204, `${changed.status} ${changed.text}`);

const stillMine = await call('/accounts');
// Half of the revocation, and deliberately only half.
//
// The DELETE excludes this session by id, and getting that exclusion backwards
// — or dropping it — signs you out of the tab you just used, which is what this
// catches. The other half, that every *other* session really did die, would
// need a second sign-in, and `/auth/login` is rate-limited at five a minute per
// IP: a smoke run that spends two of them locks the developer out of their own
// browser for the rest of the minute. Not worth it for one assertion.
check('the session that changed it survives', stillMine.status === 200, `got ${stillMine.status}`);

// Back to the fixture's password, so a second run of this script starts where
// the first one did.
const restored = await call('/auth/password', {
  method: 'POST',
  body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD },
});
check('password change restores the fixture', restored.status === 204, `${restored.status} ${restored.text}`);

const folders = await call('/folders');
check('folders lists', folders.status === 200 && Array.isArray(folders.body), `${folders.status}`);

// The important one: this executes the whole query engine — scope resolution,
// keyset pagination, threading window functions, and the facet aggregate.
const emptyFilters = {
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

for (const [name, q] of [
  ['unified/date', { sort: 'date', group: 'date', threaded: true }],
  ['unified/priority', { sort: 'priority', group: 'priority', threaded: true }],
  ['unified/sender-unthreaded', { sort: 'sender', group: 'sender', threaded: false }],
  ['unified/size', { sort: 'size', group: 'none', threaded: false }],
  ['unified/unread-filtered', { sort: 'unread', group: 'none', threaded: true, unreadOnly: true }],
]) {
  const res = await call('/messages/query', {
    method: 'POST',
    body: {
      scope: { kind: 'unified', value: null, role: 'inbox' },
      sort: q.sort,
      dir: 'desc',
      group: q.group,
      threaded: q.threaded,
      filters: { ...emptyFilters, unreadOnly: !!q.unreadOnly },
      limit: 50,
      cursor: null,
    },
  });
  check(
    `query ${name}`,
    res.status === 200 && Array.isArray(res.body?.messages) && !!res.body?.facets,
    `${res.status} ${res.text?.slice(0, 300)}`,
  );
}

const search = await call('/messages/query', {
  method: 'POST',
  body: {
    scope: { kind: 'search', value: 'invoice payment', role: null },
    sort: 'date',
    dir: 'desc',
    group: 'none',
    threaded: false,
    filters: emptyFilters,
    limit: 20,
    cursor: null,
  },
});
check('full-text search executes', search.status === 200, `${search.status} ${search.text?.slice(0, 300)}`);

const badCursor = await call('/messages/query', {
  method: 'POST',
  body: {
    scope: { kind: 'unified', value: null, role: 'inbox' },
    sort: 'date',
    dir: 'desc',
    group: 'none',
    threaded: false,
    filters: emptyFilters,
    limit: 10,
    cursor: 'not-a-cursor',
  },
});
check('bad cursor is rejected cleanly', badCursor.status === 400, `got ${badCursor.status}`);

const prefs = await call('/preferences', { method: 'PUT', body: { layout: 'columns' } });
check('preferences round-trip', prefs.status === 200 && prefs.body?.layout === 'columns', prefs.text);

const sync = await call('/sync');
check('sync state responds', sync.status === 200 && !!sync.body?.accounts, `${sync.status}`);

// CSRF must actually be enforced, not merely issued.
const saved = csrf;
csrf = 'wrong-token';
const csrfFail = await call('/preferences', { method: 'PUT', body: {} });
check('CSRF rejects a bad token', csrfFail.status === 401, `got ${csrfFail.status}`);
csrf = saved;

/* ── The error shape ────────────────────────────────────────────────────────
   Asserted because it broke silently once. `setErrorHandler` was registered
   after the route plugins, and Fastify child contexts capture the parent's
   handler when they are created — so every error in the application came back
   in Fastify's default `{statusCode, code, error, message}` shape. The client
   reads `payload.error.code`, found a status string where an object belonged,
   and reported every failure as "unknown". Typecheck cannot see this; only a
   request can. */

const shapeOf = (body) =>
  !!body && typeof body.error === 'object' && body.error !== null &&
  typeof body.error.code === 'string' && typeof body.error.message === 'string';

const missing = await call('/messages/00000000-0000-0000-0000-000000000000');
check(
  'a 404 from a route matches the contract error shape',
  missing.status === 404 && shapeOf(missing.body),
  missing.text,
);

const noRoute = await call('/definitely-not-a-route');
check(
  'an unknown endpoint matches the contract error shape',
  noRoute.status === 404 && shapeOf(noRoute.body),
  noRoute.text,
);

const badBody = await call('/messages/actions', { method: 'POST', body: { ids: [] } });
check(
  'a rejected request body matches the contract error shape',
  badBody.status === 400 && shapeOf(badBody.body),
  badBody.text,
);

csrf = 'wrong-token';
const authShape = await call('/preferences', { method: 'PUT', body: {} });
check(
  'an auth failure matches the contract error shape',
  authShape.status === 401 && shapeOf(authShape.body),
  authShape.text,
);
csrf = saved;

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
