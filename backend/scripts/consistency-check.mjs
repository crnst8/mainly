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
  foreignUserId,
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
  // Reproduce the UI path: a collapsed row, Trash, then the very next inbox query.
  const older = await add(inbox, 51, 'trash-conversation');
  const newer = await add(inbox, 52, 'trash-conversation');
  await act([newer.id], { type: 'flag', add: ['seen'], remove: [] }, true);
  const inboxQuery = {
    scope: { kind: 'folder', value: inbox.id, role: null },
    sort: 'date', dir: 'desc', group: 'none', threaded: true, limit: 100, cursor: null,
    filters: { unreadOnly: false, flaggedOnly: false, hasAttachments: false,
      accountIds: [], domains: [], folderIds: [], priorities: [], labels: [], since: null, before: null },
  };
  const beforeTrash = await call('/messages/query', inboxQuery);
  const representative = beforeTrash.body.messages.find((m) => m.threadId === 'trash-conversation');
  assert.equal(representative.threadCount, 2);
  // Model the already-stuck inbox from the previous release: the newest member
  // is in Trash, but is still used to represent its older inbox sibling.
  await act([representative.id], { type: 'delete', permanent: false });
  const stuck = await call('/messages/query', inboxQuery);
  assert.ok(stuck.body.messages.some((m) => m.id === representative.id));
  const trashed = await call('/messages/actions', {
    ids: [representative.id], action: { type: 'delete', permanent: false },
    threaded: true, returnChanges: true,
  });
  assert.equal(trashed.status, 200);
  const afterTrash = await call('/messages/query', inboxQuery);
  check('trashing a collapsed conversation stays out of the inbox on immediate reload', () => {
    assert.ok(!afterTrash.body.messages.some((m) => m.threadId === 'trash-conversation'),
      'trashed conversation immediately reappeared in the inbox');
  });
  const receipt = trashed.body.previousFolders;
  check('Undo receipt includes the hidden inbox member and the already-trashed member', () => {
    assert.deepEqual(Object.keys(receipt).sort(), [older.id, newer.id].sort());
    assert.equal(receipt[representative.id], trash.id);
    assert.equal(receipt[representative.id === older.id ? newer.id : older.id], inbox.id);
  });
  for (const [id, folderId] of Object.entries(receipt)) {
    await act([id], { type: 'move', folderId });
  }
  const restored = await query('SELECT id, folder_id FROM messages WHERE id = ANY($1::uuid[])', [Object.keys(receipt)]);
  check('Undo restores every affected message to its own original folder', () => {
    assert.ok(restored.every((m) => m.folder_id === receipt[m.id]));
  });
  // A separate mailbox with the same thread must use its own Trash folder.
  const [secondAccount] = await query(`INSERT INTO accounts(user_id,address,domain,label,imap_host,imap_port,smtp_host,smtp_port,username,secret_ciphertext,secret_nonce,secret_tag,status)
    VALUES ($1,'second@example.test','example.test','Second','invalid',993,'invalid',587,'second','x','x','x','disabled') RETURNING id`, [userId]);
  const secondFolders = await query(`INSERT INTO folders(account_id,path,name,role,uidvalidity,uidnext)
    VALUES ($1,'INBOX','Inbox','inbox',1,100),($1,'Trash','Trash','trash',1,100) RETURNING *`, [secondAccount.id]);
  const secondInbox = secondFolders.find((f) => f.role === 'inbox');
  const secondTrash = secondFolders.find((f) => f.role === 'trash');
  const [copy] = await query(`INSERT INTO messages(account_id,folder_id,uid,thread_id,from_address,date)
    VALUES ($1,$2,1,'trash-conversation','sender@example.test',now()) RETURNING id`, [secondAccount.id,secondInbox.id]);
  const unrelated = await add(inbox,53,'unrelated-conversation');
  // Matching thread ids are not authority to mutate another user's mailbox.
  [{ id: foreignUserId }] = await query(`INSERT INTO users(email,password_hash) VALUES ($1,'no-login') RETURNING id`, [`foreign-${randomUUID()}@example.test`]);
  const [foreignAccount] = await query(`INSERT INTO accounts(user_id,address,domain,label,imap_host,imap_port,smtp_host,smtp_port,username,secret_ciphertext,secret_nonce,secret_tag,status)
    VALUES ($1,'foreign@example.test','example.test','Foreign','invalid',993,'invalid',587,'foreign','x','x','x','disabled') RETURNING id`, [foreignUserId]);
  const [foreignInbox] = await query(`INSERT INTO folders(account_id,path,name,role) VALUES ($1,'INBOX','Inbox','inbox') RETURNING id`, [foreignAccount.id]);
  const [foreignMessage] = await query(`INSERT INTO messages(account_id,folder_id,uid,thread_id,from_address,date)
    VALUES ($1,$2,1,'trash-conversation','sender@example.test',now()) RETURNING id`, [foreignAccount.id,foreignInbox.id]);
  await act([representative.id], { type:'delete', permanent:false }, true);
  const crossAccount = await query('SELECT id,folder_id,account_id FROM messages WHERE id=ANY($1::uuid[])', [[older.id,newer.id,copy.id,unrelated.id]]);
  check('thread Trash spans owned accounts without touching unrelated mail', () => {
    assert.equal(crossAccount.find((m) => m.id === copy.id).folder_id,secondTrash.id);
    assert.equal(crossAccount.find((m) => m.id === older.id).folder_id,trash.id);
    assert.equal(crossAccount.find((m) => m.id === newer.id).folder_id,trash.id);
    assert.equal(crossAccount.find((m) => m.id === unrelated.id).folder_id,inbox.id);
  });
  assert.equal((await query('SELECT folder_id FROM messages WHERE id=$1',[foreignMessage.id]))[0].folder_id,foreignInbox.id);
  const unauthorized = await call('/messages/actions', {
    ids: [foreignMessage.id], action: { type:'delete', permanent:false }, threaded: true, returnChanges: true,
  });
  check('thread expansion and receipts never cross user ownership', () => assert.equal(unauthorized.status,404));
  const pendingTargets = await query("SELECT account_id, payload FROM sync_ops WHERE kind='delete' AND account_id=ANY($1::uuid[]) ORDER BY id", [[accountId,secondAccount.id]]);
  check('every conversation member is queued for its own IMAP account', () => {
    for (const id of [older.id,newer.id,copy.id]) assert.ok(pendingTargets.some((o) => o.payload.ids.includes(id)));
    assert.ok(pendingTargets.filter((o) => o.account_id === secondAccount.id).every((o) => o.payload.targets.every((t) => t.id === copy.id && t.path === 'INBOX')));
  });
  const flatOlder = await add(inbox,61,'flat-conversation');
  const flatNewer = await add(inbox,62,'flat-conversation');
  await act([flatNewer.id], { type:'delete', permanent:false });
  check('unthreaded Trash continues to move only the explicitly selected message', () => {});
  assert.equal((await query('SELECT folder_id FROM messages WHERE id=$1',[flatOlder.id]))[0].folder_id,inbox.id);
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
  if (userId || foreignUserId) await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,foreignUserId].filter(Boolean)]);
  await close();
}
