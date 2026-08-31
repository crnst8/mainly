/**
 * What must never be recoverable from what is stored.
 *
 * `sessions.id` used to be the cookie value in the clear, so a pg_dump was a set
 * of live credentials rather than a record that sessions existed. These are the
 * two properties that fix depends on: the stored form differs from the cookie,
 * and the same cookie always produces the same stored form — without which
 * nobody could log in at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

/* crypto.ts reads SECRET_KEY at import time — it is the module that holds the
   AES key — so the suite supplies a throwaway one. Nothing below encrypts; these
   are the hashing and comparison helpers, which take no key at all. */
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SECRET_KEY ??= Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET ??= 'crypto-test';

const { randomToken, safeEqual, sessionDigest } = await import('./crypto.ts');

test('a session cookie is not what lands in the database', () => {
  const cookie = randomToken();
  const stored = sessionDigest(cookie);
  assert.notEqual(stored, cookie);
  // Nothing of the secret survives into the stored value.
  assert.ok(!stored.includes(cookie));
  assert.match(stored, /^[0-9a-f]{64}$/);
});

test('the same cookie always resolves to the same row', () => {
  const cookie = randomToken();
  assert.equal(sessionDigest(cookie), sessionDigest(cookie));
  assert.notEqual(sessionDigest(cookie), sessionDigest(randomToken()));
});

test('tokens are distinct and long enough to be worth hashing rather than stretching', () => {
  const seen = new Set(Array.from({ length: 200 }, () => randomToken()));
  assert.equal(seen.size, 200);
  // 32 bytes, base64url — no padding, and no dictionary to run against it.
  assert.ok(randomToken().length >= 42);
});

test('safeEqual matches only identical strings and never throws on length', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  // Different lengths must be false rather than a TypeError out of timingSafeEqual.
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
