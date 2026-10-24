import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgres://filter-test/none';
process.env.SECRET_KEY = Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET = 'filter-test';
process.env.FILTER_LLM_KEY = 'test-only';
process.env.ALLOW_PRIVATE_IMAP_HOSTS = 'false';
const { classify, listModels, normaliseBaseUrl, ownProvider } = await import('./llm.ts');

const opencode = ownProvider(null, 'test-only');

test('model discovery validates the provider shape and deduplicates ids', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, {}, { id: '' }] }));
  assert.deepEqual(await listModels(opencode), ['a', 'b']);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: {} }));
  await assert.rejects(listModels(opencode), /unreadable model list/);
});

test('oversized provider streams are cancelled before being fully buffered', async (t) => {
  let cancelled = false;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(listModels(opencode), /oversized response/);
  assert.equal(cancelled, true);
  assert.ok(reads <= 4);
});

test('a user-typed base URL is normalised or refused', () => {
  assert.equal(normaliseBaseUrl(' https://openrouter.ai/api/v1/ '), 'https://openrouter.ai/api/v1');
  assert.equal(normaliseBaseUrl('http://models.example:11434/v1'), 'http://models.example:11434/v1');
  assert.deepEqual(normaliseBaseUrl('ftp://models.example/v1'), { error: 'The URL must start with https://' });
  assert.deepEqual(normaliseBaseUrl('https://k:secret@models.example/v1'), { error: 'Put the key in the key field, not the URL' });
  assert.deepEqual(normaliseBaseUrl('https://models.example/v1?key=x'), { error: 'The URL cannot have a query or fragment' });
  assert.deepEqual(normaliseBaseUrl('not a url'), { error: 'Not a valid URL' });
});

test('a user-typed URL on a private address is refused before any request', async (t) => {
  const fetched = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  await assert.rejects(listModels(ownProvider('http://127.0.0.1:11434/v1', '')), /private or reserved/);
  assert.equal(fetched.mock.callCount(), 0);
});

test('an empty key sends no authorization header; a key goes as a bearer token', async (t) => {
  const seen: Headers[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return Response.json({ choices: [{ message: { content: '{"results":[{"n":1,"filter":false,"confidence":0.9}]}' } }] });
  });
  const message = { from: { name: null, address: 'a@b.example' }, subject: 's', preview: 'p', addressed: 'direct' as const, bulk: false };
  await classify(ownProvider('https://1.1.1.1/v1', ''), 'u', 'm', [message], []);
  await classify(opencode, 'u', 'm', [message], []);
  assert.equal(seen[0]!.has('authorization'), false);
  assert.equal(seen[1]!.get('authorization'), 'Bearer test-only');
});
