/** Verify the SPA half of the composition root: cache headers, client-route
 *  fallback, `/api` precedence, and that no encoding of `..` escapes WEB_ROOT.
 *
 *  None of this ran in CI before. `WEB_ROOT` is set in the Docker image and
 *  nowhere else, so the single-container install — the default one — was the
 *  only place @fastify/static was ever exercised, and the first sign of a
 *  regression would have been a deploy nobody could see because index.html came
 *  back cached. That gap is worse now that Dependabot bumps the plugin on its
 *  own; v10 already moved `setHeaders` from a Node response to a FastifyReply.
 *
 *  This drives the real `build()` rather than a copy of its options, which is
 *  the only version worth having: a test that re-declares the registration
 *  passes whatever server.ts happens to be doing. No database is touched, so it
 *  runs with the fast checks rather than behind Postgres. */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const web = mkdtempSync(join(tmpdir(), 'mainly-webroot-'));
mkdirSync(join(web, 'assets'));
writeFileSync(join(web, 'index.html'), '<!doctype html><title>mainly</title>');
writeFileSync(join(web, 'assets', 'index-abc123.js'), 'console.log(0)');

/* The traversal target: a real file one level above the served root. */
const SECRET = 'ESCAPED-THE-WEB-ROOT';
writeFileSync(join(web, '..', 'mainly-static-check-secret.txt'), SECRET);

process.env.WEB_ROOT = web;
process.env.LOG_LEVEL = 'silent';
/* Deliberately unreachable. Nothing here queries, and a spec that would pass or
   fail differently depending on a database is not testing what it claims to. */
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SECRET_KEY ??= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.SESSION_SECRET ??= 'static-check';
process.env.APP_ORIGIN ??= 'http://localhost:5273';

const { build } = await import('../src/server.ts');
const app = await build();
const get = (url) => app.inject({ method: 'GET', url });

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/* Vite hashes asset names but not index.html, so the two must not share a
   policy. Caching index.html is a deploy the browser refuses to notice. */
{
  const r = await get('/index.html');
  check('index.html is served', r.statusCode === 200, `status ${r.statusCode}`);
  check('index.html is not cached', r.headers['cache-control'] === 'no-cache', r.headers['cache-control']);
}
{
  const r = await get('/assets/index-abc123.js');
  check('hashed asset is served', r.statusCode === 200, `status ${r.statusCode}`);
  check(
    'hashed asset is immutable',
    r.headers['cache-control'] === 'public, max-age=31536000, immutable',
    r.headers['cache-control'],
  );
}

/* wildcard:false means static claims only paths that exist; the notFound
   handler decides the rest. A client route is not a 404, an /api path is. */
{
  const r = await get('/mail/inbox/1');
  check('a client route falls back to the SPA', r.statusCode === 200 && r.body.includes('<title>mainly</title>'), `status ${r.statusCode}`);
  check('the fallback is not cached', r.headers['cache-control'] === 'no-cache', r.headers['cache-control']);
}
{
  const r = await get('/api/definitely-not-a-route');
  const code = r.statusCode === 404 ? JSON.parse(r.body).error?.code : null;
  check('an unknown /api path is a JSON 404', code === 'not_found', `status ${r.statusCode}`);
}

/* GHSA-83w8-p2f5-377r and GHSA-8pvw-jcv7-9cmj: the bypasses were non-canonical
   and percent-encoded separators, so encoding is the axis worth covering. */
for (const [name, url] of [
  ['plain ../', '/../mainly-static-check-secret.txt'],
  ['encoded ..%2f', '/..%2fmainly-static-check-secret.txt'],
  ['double-encoded ..%252f', '/..%252fmainly-static-check-secret.txt'],
  ['fully encoded %2e%2e%2f', '/%2e%2e%2fmainly-static-check-secret.txt'],
  ['nested ../../', '/assets/../../mainly-static-check-secret.txt'],
  ['backslash ..\\', '/..%5cmainly-static-check-secret.txt'],
]) {
  const r = await get(url);
  check(`${name} does not escape the web root`, !r.body.includes(SECRET), `status ${r.statusCode}, leaked the file`);
}

await app.close();

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\nstatic-check: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`static-check: ${passed} passed, 0 failed`);
