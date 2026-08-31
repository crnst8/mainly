/** The login limiter, driven through the real app.
 *
 *  Two regressions this exists to catch, both of which were live:
 *
 *   1. `trustProxy: true` made `req.ip` whatever the caller put in
 *      `X-Forwarded-For`, so an IP-keyed limiter handed out a fresh budget per
 *      forged header — eight attempts, zero 429s. There is no account lockout
 *      behind it, so that limiter is the only thing bounding password guessing.
 *   2. Keying on the address at all is the wrong axis for a login route. The
 *      key is the account, which cannot be spoofed, lowercased so that `A@b.c`
 *      is not five more attempts at `a@b.c`.
 *
 *  No database: the limiter answers before the handler ever queries, so what is
 *  asserted is the count of 429s and never what the other responses were. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WEB_ROOT = mkdtempSync(join(tmpdir(), 'mainly-auth-check-'));
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SECRET_KEY ??= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.SESSION_SECRET ??= 'auth-check';
process.env.APP_ORIGIN ??= 'http://localhost:5273';
/* The default, stated: the point of the exercise is that a forged header buys
   nothing, and reading it from a developer's shell would defeat the test. */
delete process.env.TRUST_PROXY;

const { build } = await import('../src/server.ts');
const app = await build();

/* Registered before the first inject, because the account-keyed limiter below
   would pass on its own merits even with `trustProxy: true` restored — and the
   *other* limiters (the global cap, and 10/hour on /onboarding/verify) are still
   keyed on the address. So the address itself is asserted directly. */
app.get('/__probe_ip', async (req) => ({ ip: req.ip, protocol: req.protocol }));

const LIMIT = 5;
const ATTEMPTS = 8;

const login = (email, headers = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { email, password: 'not-the-password' },
  });

/** How many of `ATTEMPTS` were throttled. */
async function throttled(email, headerFor) {
  let count = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    const res = await login(email, headerFor?.(i) ?? {});
    if (res.statusCode === 429) count++;
  }
  return count;
}

let passed = 0;
const failures = [];

const check = (name, ok, detail) => {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// A fresh address per case, because the budget is per account and cases share a process.
const addr = (n) => `probe-${n}-${Date.now()}@example.test`;

{
  const res = await app.inject({
    method: 'GET',
    url: '/__probe_ip',
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-forwarded-proto': 'https' },
  });
  const { ip, protocol } = JSON.parse(res.body);
  check('req.ip does not follow X-Forwarded-For by default', ip !== '203.0.113.9', `req.ip=${ip}`);
  check('nor does req.protocol follow X-Forwarded-Proto', protocol !== 'https', `protocol=${protocol}`);
}

{
  const n = await throttled(addr(1));
  check('an ordinary caller is throttled after the limit', n === ATTEMPTS - LIMIT, `${n} of ${ATTEMPTS} throttled`);
}
{
  // The bypass, exactly as it was: a different X-Forwarded-For on every request.
  const n = await throttled(addr(2), (i) => ({ 'x-forwarded-for': `203.0.113.${i}` }));
  check('a forged X-Forwarded-For buys no extra attempts', n === ATTEMPTS - LIMIT, `${n} of ${ATTEMPTS} throttled`);
}
{
  const n = await throttled(addr(3), () => ({
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250)}`,
    'x-real-ip': '203.0.113.7',
    forwarded: 'for=203.0.113.8',
  }));
  check('nor do the other client-IP headers', n === ATTEMPTS - LIMIT, `${n} of ${ATTEMPTS} throttled`);
}
{
  // Case rotation must not multiply the budget: one account, one budget.
  const base = addr(4);
  let n = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    const spelling = i % 2 ? base.toUpperCase() : base;
    if ((await login(spelling)).statusCode === 429) n++;
  }
  check('case-rotating the address is the same account', n === ATTEMPTS - LIMIT, `${n} of ${ATTEMPTS} throttled`);
}
{
  // One account being attacked must not lock everyone else out.
  const n = await throttled(addr(5));
  check('a different account has its own budget', n === ATTEMPTS - LIMIT, `${n} of ${ATTEMPTS} throttled`);
}

await app.close();

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\nauth-check: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`auth-check: ${passed} passed, 0 failed`);
