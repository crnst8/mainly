/** Exercise the real store with deferred transport responses and fake timers. */
import assert from 'node:assert/strict';
import { build } from 'vite';

const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (fn) => {
  const id = ++timerId;
  timers.set(id, fn);
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.localStorage = { getItem: () => null };
const bundled = await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    write: false,
    minify: false,
    lib: {
      entry: new URL('../src/lib/store.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: 'store',
    },
  },
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [
    {
      name: 'transport',
      enforce: 'pre',
      resolveId(id) {
        if (/^\.\/(api|media|print)$/.test(id)) return `\0test:${id}`;
      },
      load(id) {
        if (!id.startsWith('\0test:')) return;
        return id.endsWith('./api')
          ? 'export const getApi = async () => globalThis.transport;'
          : id.endsWith('./media')
            ? 'export const usePrefersDark = () => false;'
            : 'export const printMessage = () => {};';
      },
    },
  ],
});
const output = (Array.isArray(bundled) ? bundled[0] : bundled).output.find(
  (o) => o.type === 'chunk',
).code;
const { useStore: store } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const row = {
  id: 'm',
  accountId: 'a',
  folderId: 'inbox',
  threadId: 't',
  seen: false,
  flagged: false,
  labels: [],
  threadCount: 1,
};
const result = (messages) => ({ messages, total: messages.length, nextCursor: null, facets: {} });
const initial = store.getState();
function reset() {
  store.setState({
    ...initial,
    prefs: { undoWindowMs: 6000 },
    result: result([{ ...row }]),
    accounts: [{ id: 'a', unread: 1, total: 1 }],
    folders: [
      { id: 'inbox', accountId: 'a', unread: 1, total: 1, role: 'inbox' },
      { id: 'trash', accountId: 'a', unread: 0, total: 0, role: 'trash' },
    ],
  });
  globalThis.transport = {
    list: async () => result([{ ...row }]),
    listAccounts: async () => initial.accounts,
    listFolders: async () => initial.folders,
    syncState: async () => initial.sync,
  };
}
let passed = 0;
async function check(name, fn) {
  reset();
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

await check(
  'trash is sent before the undo timer, stays hidden during refresh, and Undo persists its reverse move',
  async () => {
    const saving = deferred();
    const calls = [];
    transport.act = (ids, action) => {
      calls.push({ ids, action });
      return calls.length === 1 ? saving.promise : Promise.resolve();
    };
    const act = store.getState().trash(['m']);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(store.getState().result.messages.length, 0);
    const refresh = store.getState().refresh();
    await tick();
    assert.equal(store.getState().result.messages.length, 0);
    transport.list = async () => result([]);
    saving.resolve();
    await act;
    await refresh;
    store.getState().toasts[0].undo();
    await tick();
    assert.deepEqual(calls[1], { ids: ['m'], action: { type: 'move', folderId: 'inbox' } });
  },
);
await check('conversation Trash requests a receipt and Undo restores hidden members separately', async () => {
  store.setState({ result: result([{ ...row, threadCount: 3 }]) });
  const saving = deferred();
  const calls = [];
  transport.act = (ids, action, options) => {
    calls.push({ ids, action, options });
    return calls.length === 1 ? saving.promise : Promise.resolve();
  };
  const deleting = store.getState().trash(['m']);
  await tick();
  assert.deepEqual(calls[0].options, { threaded: true, returnChanges: true });
  // Undo can be clicked before the receipt arrives; it still uses all members.
  store.getState().toasts[0].undo();
  saving.resolve({ previousFolders: { m: 'inbox', hidden: 'sent', otherAccount: 'other-inbox' } });
  transport.list = async () => result([]);
  await deleting;
  await tick();
  assert.deepEqual(calls.slice(1).map(({ ids, action }) => ({ ids, action })), [
    { ids: ['m'], action: { type: 'move', folderId: 'inbox' } },
    { ids: ['hidden'], action: { type: 'move', folderId: 'sent' } },
    { ids: ['otherAccount'], action: { type: 'move', folderId: 'other-inbox' } },
  ]);
  assert.ok(calls.slice(1).every((c) => c.options.threaded === false));
});
await check('repeated trashes fold into one toast and Undo walks back one action at a time', async () => {
  store.setState({ result: result([{ ...row }, { ...row, id: 'n' }, { ...row, id: 'o' }]) });
  const calls = [];
  transport.act = async (ids, action) => { calls.push({ ids, action }); };
  await store.getState().trash(['m']);
  const first = store.getState().toasts[0];
  await store.getState().trash(['n', 'o']);
  let { toasts } = store.getState();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].id, first.id);
  assert.equal(toasts[0].message, 'Moved to trash · 3 messages');
  assert.ok(toasts[0].expiresAt >= first.expiresAt);
  transport.list = async () => result([]);
  // First press: the latest action only, and the line shrinks by what it covered.
  toasts[0].undo();
  await tick();
  assert.deepEqual(calls.slice(2).map((c) => c.ids), [['n', 'o']]);
  ({ toasts } = store.getState());
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].id, first.id);
  assert.equal(toasts[0].message, 'Moved to trash · 1 message');
  // Second press: the first action, and nothing is left to show.
  toasts[0].undo();
  await tick();
  assert.deepEqual(calls.slice(3).map((c) => c.ids), [['m']]);
  assert.equal(store.getState().toasts.length, 0);
  // A line that cannot be undone never merges into one that can.
  store.setState({ result: result([{ ...row }]) });
  await store.getState().trash(['m']);
  store.getState().toast({ key: 'Moved to trash', count: 1, message: (n) => `Moved to trash · ${n}` });
  assert.equal(store.getState().toasts.length, 2);
});
await check('unthreaded Trash does not expand a conversation', async () => {
  store.setState({ query: { ...store.getState().query, threaded: false } });
  let options;
  transport.act = async (_ids, _action, opts) => { options = opts; };
  await store.getState().trash(['m']);
  assert.equal(options.threaded, false);
});
await check('an old list response cannot replace a newer scope', async () => {
  const old = deferred();
  let calls = 0;
  transport.list = () =>
    ++calls === 1 ? old.promise : Promise.resolve(result([{ ...row, id: 'new' }]));
  const first = store.getState().refresh();
  await tick();
  store.getState().setScope({ kind: 'folder', value: 'trash', role: null });
  await tick();
  old.resolve(result([{ ...row, id: 'old' }]));
  await first;
  assert.equal(store.getState().result.messages[0].id, 'new');
  assert.equal(store.getState().loading, false);
});
await check('a read made during a list fetch survives its stale response', async () => {
  const old = deferred();
  transport.list = () => old.promise;
  transport.act = async () => {};
  const first = store.getState().refresh();
  await tick();
  await store.getState().setRead(['m'], true);
  old.resolve(result([{ ...row }]));
  await first;
  assert.equal(store.getState().result.messages[0].seen, true);
});
await check('rapid read then unread writes preserve click order', async () => {
  const first = deferred();
  const calls = [];
  transport.act = (ids, action, options) => {
    calls.push({ action, options });
    return calls.length === 1 ? first.promise : Promise.resolve();
  };
  const read = store.getState().setRead(['m'], true);
  await tick();
  const unread = store.getState().setRead(['m'], false);
  await tick();
  assert.equal(calls.length, 1);
  first.resolve();
  await read;
  await unread;
  assert.deepEqual(
    calls.map((c) => c.action.add),
    [['seen'], []],
  );
  assert.equal(calls[0].options.threaded, true);
  assert.equal(store.getState().result.messages[0].seen, false);
});
await check('failed saves are visible and reconcile optimistic state', async () => {
  transport.act = async () => {
    throw new Error('Cannot save');
  };
  await store.getState().setRead(['m'], true);
  assert.equal(store.getState().result.messages[0].seen, false);
  assert.ok(store.getState().toasts.some((t) => t.message === 'Cannot save'));
});
await check('an old pagination response cannot append after filters change', async () => {
  const old = deferred();
  let calls = 0;
  store.setState({ result: { ...result([{ ...row }]), nextCursor: 'next' } });
  transport.list = () =>
    ++calls === 1 ? old.promise : Promise.resolve(result([{ ...row, id: 'filtered' }]));
  const page = store.getState().loadMore();
  await tick();
  store.getState().patchFilters({ unreadOnly: true });
  await tick();
  old.resolve(result([{ ...row, id: 'wrong' }]));
  await page;
  assert.deepEqual(
    store.getState().result.messages.map((m) => m.id),
    ['filtered'],
  );
});
console.log(`store-check: ${passed} passed, 0 failed`);
