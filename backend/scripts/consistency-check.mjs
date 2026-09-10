/** Real Postgres + HTTP mutations, with a deterministic IMAP peer for replay. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query, close } from '../src/db/index.ts';
import { applyOp, dueOps, replayOps } from '../src/sync/replay.ts';
import { applyFlags, upsert, syncFolder } from '../src/sync/envelopes.ts';
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5284/api';
let cookie = '',
  csrf = '',
  userId,
  accountId;
async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie,
      'x-csrf-token': csrf,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  csrf = res.headers.get('x-csrf-token') ?? csrf;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const act = async (ids, action, threaded = false) => {
  const response = await call('/messages/actions', { ids, action, threaded });
  assert.equal(response.status, 204, JSON.stringify(response.body));
};
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};
try {
  const email = `consistency-${randomUUID()}@example.test`;
  [{ id: userId }] = await query(
    `INSERT INTO users(email, password_hash) SELECT $1, password_hash FROM users WHERE email='smoke@example.test' RETURNING id`,
    [email],
  );
  [{ id: accountId }] = await query(
    `INSERT INTO accounts(user_id,address,domain,label,imap_host,imap_port,smtp_host,smtp_port,username,secret_ciphertext,secret_nonce,secret_tag,status)
    VALUES ($1,$2,'example.test','Consistency','invalid',993,'invalid',587,$2,'x','x','x','disabled') RETURNING id`,
    [userId, email],
  );
  const folders = await query(
    `INSERT INTO folders(account_id,path,name,role,uidvalidity,uidnext)
    VALUES ($1,'INBOX','Inbox','inbox',1,100),($1,'Trash','Trash','trash',1,100),($1,'Archive','Archive','archive',1,100) RETURNING *`,
    [accountId],
  );
  const inbox = folders.find((f) => f.role === 'inbox'),
    trash = folders.find((f) => f.role === 'trash');
  const add = async (folder, uid, thread = `thread-${uid}`) =>
    (
      await query(
        `INSERT INTO messages(account_id,folder_id,uid,thread_id,message_id,from_address,date,labels)
    VALUES ($1,$2,$3,$4,$5,'sender@example.test',now(),'{keep}') RETURNING *`,
        [accountId, folder.id, uid, thread, `message-${folder.path}-${uid}`],
      )
    )[0];
  const m = await add(inbox, 7, 'conversation'),
    sibling = await add(inbox, 8, 'conversation'),
    collision = await add(trash, 7);
  const login = await call('/auth/login', { email, password: 'smoke-password-1234' });
  assert.equal(login.status, 200);
  const timings = [];
  let start = performance.now();
  await act([m.id], { type: 'flag', add: ['seen'], remove: [] }, true);
  timings.push(performance.now() - start);
  const members = await query('SELECT seen FROM messages WHERE thread_id=$1 AND account_id=$2', [
    'conversation',
    accountId,
  ]);
  const thread = (
    await query('SELECT unread_count FROM threads WHERE user_id=$1 AND thread_id=$2', [
      userId,
      'conversation',
    ])
  )[0];
  check('thread read persists every member and its aggregate before acknowledgement', () => {
    assert.ok(members.every((m) => m.seen));
    assert.equal(thread.unread_count, 0);
  });
  await applyFlags(userId, inbox.id, [{ uid: 7, seen: false, flagged: false, answered: false }]);
  check('stale IMAP flags cannot overwrite a queued read', async () => {});
  assert.equal((await query('SELECT seen FROM messages WHERE id=$1', [m.id]))[0].seen, true);
  const indexed = {
    uid: 7,
    messageId: m.message_id,
    inReplyTo: null,
    references: [],
    subjectNormalised: '',
    isReply: false,
    date: new Date(),
    participants: [],
    fromName: null,
    fromAddress: 'sender@example.test',
    to: [],
    cc: [],
    subject: '',
    preview: '',
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    size: 0,
    attachmentCount: 0,
    bodyText: null,
  };
  await upsert(userId, accountId, inbox.id, 'normal', [indexed]);
  check('full envelope refresh also preserves a queued read', () => {});
  assert.equal((await query('SELECT seen FROM messages WHERE id=$1', [m.id]))[0].seen, true);
  // Discard the read op after verifying its protection, as if STORE succeeded.
  await query('DELETE FROM sync_ops WHERE account_id=$1', [accountId]);
  start = performance.now();
  await act([m.id], { type: 'delete', permanent: false });
  timings.push(performance.now() - start);
  let moved = (await query('SELECT * FROM messages WHERE id=$1', [m.id]))[0];
  check('trash persists immediately without colliding with the same UID in Trash', () => {
    assert.equal(moved.folder_id, trash.id);
    assert.equal(moved.uid, null);
    assert.equal(moved.remote_uid, 7);
    assert.equal(moved.remote_folder_id, inbox.id);
  });
  const reread = await call(`/messages/${m.id}`);
  assert.equal(reread.body.folderId, trash.id);
  await upsert(userId, accountId, inbox.id, 'normal', [indexed]);
  check('an unreplayed move cannot resurrect its source row', () => {});
  assert.equal(
    (
      await query('SELECT count(*)::int AS n FROM messages WHERE folder_id=$1 AND uid=7', [
        inbox.id,
      ])
    )[0].n,
    0,
  );
  // A census of an empty destination must keep logical moves still in flight.
  const emptyClient = {
    mailboxOpen: async () => ({ uidValidity: 1n, uidNext: 100, exists: 0 }),
    capabilities: new Set(),
    async *fetch() {},
  };
  // Use Archive, avoiding the unrelated message that really lives in Trash.
  const archive = folders.find((f) => f.role === 'archive');
  await act([sibling.id], { type: 'move', folderId: archive.id });
  await syncFolder(emptyClient, userId, accountId, 'normal', archive, () => {});
  assert.ok((await query('SELECT id FROM messages WHERE id=$1', [sibling.id]))[0]);
  check('empty-folder reconciliation preserves pending moves', () => {});
  await act([m.id], { type: 'flag', add: ['flagged'], remove: [] });
  await act([m.id], { type: 'move', folderId: inbox.id });
  const ops = await query('SELECT * FROM sync_ops WHERE account_id=$1 ORDER BY id', [accountId]);
  const calls = [];
  const client = {
    capabilities: new Set(['UIDPLUS']),
    mailbox: { uidValidity: 1n, permanentFlags: new Set(['\\*']) },
    async getMailboxLock(path, opts) {
      assert.equal(opts.readOnly, false);
      this.mailbox.path = path;
      return { release() {} };
    },
    async messageMove(uids, target) {
      calls.push(['move', this.mailbox.path, uids, target]);
      return { uidValidity: 1n, uidMap: new Map(uids.map((uid) => [uid, uid + 100])) };
    },
    async messageFlagsAdd(uids) {
      calls.push(['flag', this.mailbox.path, uids]);
      return true;
    },
  };
  for (const old of ops) {
    const op = (await query('SELECT * FROM sync_ops WHERE id=$1', [old.id]))[0];
    await applyOp(client, accountId, op);
    await query('DELETE FROM sync_ops WHERE id=$1', [op.id]);
  }
  moved = (await query('SELECT * FROM messages WHERE id=$1', [m.id]))[0];
  const untouched = (await query('SELECT * FROM messages WHERE id=$1', [collision.id]))[0];
  check('move, flag, and Undo follow the assigned server UIDs and preserve metadata', () => {
    assert.ok(
      calls.some(([kind, path, uids]) => kind === 'flag' && path === 'Trash' && uids[0] === 107),
    );
    assert.ok(
      calls.some(
        ([kind, path, uids, target]) =>
          kind === 'move' && path === 'Trash' && uids[0] === 107 && target === 'INBOX',
      ),
    );
    assert.equal(moved.folder_id, inbox.id);
    assert.equal(moved.uid, 207);
    assert.equal(moved.remote_uid, null);
    assert.deepEqual(moved.labels, ['keep']);
    assert.equal(untouched.uid, 7);
    assert.equal(untouched.folder_id, trash.id);
  });
  // A refused earlier STORE must not run after a newer mark-unread succeeds.
  await act([collision.id], { type: 'flag', add: ['seen'], remove: [] });
  await act([collision.id], { type: 'flag', add: [], remove: ['seen'] });
  const failed = [];
  const refusing = {
    ...client,
    async messageFlagsAdd(uids) {
      failed.push(['add', uids]);
      return false;
    },
    async messageFlagsRemove(uids) {
      failed.push(['remove', uids]);
      return true;
    },
  };
  await replayOps(refusing, accountId, await dueOps(accountId));
  assert.equal(failed.length, 1);
  assert.equal((await dueOps(accountId)).length, 0);
  check('retry backoff cannot reorder conflicting actions', () => {});
  await query('UPDATE sync_ops SET next_attempt_at=now() WHERE account_id=$1', [accountId]);
  const recovered = {
    ...refusing,
    async messageFlagsAdd(uids) {
      failed.push(['retry', uids]);
      return true;
    },
  };
  await replayOps(recovered, accountId, await dueOps(accountId));
  assert.deepEqual(
    failed.map(([kind]) => kind),
    ['add', 'retry', 'remove'],
  );
  check('retry completes the original action before its successor', () => {});
  await act([m.id], { type: 'delete', permanent: true });
  await upsert(userId, accountId, inbox.id, 'normal', [{ ...indexed, uid: 207 }]);
  assert.equal(
    (
      await query('SELECT count(*)::int AS n FROM messages WHERE account_id=$1 AND message_id=$2', [
        accountId,
        m.message_id,
      ])
    )[0].n,
    0,
  );
  check('pending permanent deletion is not resurrected by envelope ingestion', () => {});
  await query("UPDATE folders SET role='custom' WHERE id=$1", [trash.id]);
  const noTrash = await call('/messages/actions', {
    ids: [collision.id],
    action: { type: 'delete', permanent: false },
  });
  check('missing Trash is an explicit failure with no local deletion', () =>
    assert.equal(noTrash.status, 400),
  );
  const invalid = await call('/messages/actions', {
    ids: [collision.id],
    action: { type: 'flag', add: ['seen'], remove: ['seen'] },
  });
  check('conflicting flags fail before changing data', () => assert.equal(invalid.status, 400));
  console.log(
    `consistency-check: ${passed} passed; local action acknowledgements ${timings.map((ms) => Math.round(ms) + 'ms').join(', ')}`,
  );
} finally {
  if (userId) await query('DELETE FROM users WHERE id=$1', [userId]);
  await close();
}
