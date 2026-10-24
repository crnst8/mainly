import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgres://filter-test/none';
process.env.SECRET_KEY = Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET = 'filter-test';
process.env.FILTER_LLM_KEY = 'test-only';
const { listModels } = await import('./llm.ts');

test('model discovery validates the provider shape and deduplicates ids', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, {}, { id: '' }] }));
  assert.deepEqual(await listModels(), ['a', 'b']);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: {} }));
  await assert.rejects(listModels(), /unreadable model list/);
});

test('oversized provider streams are cancelled before being fully buffered', async (t) => {
  let cancelled = false;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(listModels(), /oversized response/);
  assert.equal(cancelled, true);
  assert.ok(reads <= 4);
});
