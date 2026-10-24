/** Real Postgres + HTTP mutations, with a deterministic IMAP peer for replay. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query, close } from '../src/db/index.ts';
import { applyOp, dueOps, replayOps } from '../src/sync/replay.ts';
import { applyFlags, upsert, syncFolder, syncEnvelopes } from '../src/sync/envelopes.ts';
import { handleArrivals } from '../src/sync/arrivals.ts';
import { fileDecisions } from '../src/filter/decide.ts';
import { syncFolders } from '../src/sync/folders.ts';
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
  // A polling pass opens only the folders STATUS shows changed, and logs in not
  // at all when none did. The account's credentials are unusable on purpose:
  // leasing a connection for an unchanged account would throw.
  const [quiet, busy] = await query(
    `INSERT INTO folders(account_id,path,name,role,uidvalidity,uidnext,highest_modseq)
    VALUES ($1,'Quiet','Quiet','custom',7,10,50),($1,'Busy','Busy','custom',7,10,50) RETURNING *`,
    [accountId],
  );
  await add(quiet, 1, 'quiet-1');
  await add(quiet, 2, 'quiet-2');
  const statusOf = (over = {}) =>
    new Map([
      ['Quiet', { uidValidity: 7, uidNext: 10, highestModseq: 50, messages: 2, ...over.quiet }],
      ['Busy', { uidValidity: 7, uidNext: 10, highestModseq: 50, messages: 0, ...over.busy }],
    ]);
  const opened = [];
  const statusClient = {
    capabilities: new Set(['CONDSTORE']),
    async mailboxOpen(path) {
      opened.push(path);
      return { uidValidity: 7n, uidNext: 10, highestModseq: 51n, exists: path === 'Quiet' ? 2 : 0 };
    },
    async *fetch() {},
  };
  const creds = { id: accountId, address: email };
  const folderPaths = ['Quiet', 'Busy'];
  const idle = await syncEnvelopes(creds, userId, 'normal', { folderPaths, status: statusOf() });
  check('an account STATUS shows unchanged is not logged in to', () =>
    assert.deepEqual(idle, { indexed: 0, updated: 0, removed: 0, arrivals: [] }),
  );
  await syncEnvelopes(creds, userId, 'normal', {
    folderPaths,
    client: statusClient,
    status: statusOf({ busy: { highestModseq: 51 } }),
  });
  check('only the folder whose HIGHESTMODSEQ moved is opened', () =>
    assert.deepEqual(opened, ['Busy']),
  );
  opened.length = 0;
  await syncEnvelopes(creds, userId, 'normal', {
    folderPaths,
    client: statusClient,
    // Busy now holds the 51 its pass recorded.
    status: statusOf({ quiet: { messages: 1 }, busy: { highestModseq: 51 } }),
  });
  check('a MESSAGES count that disagrees with the index opens the folder', () =>
    assert.deepEqual(opened, ['Quiet']),
  );
  opened.length = 0;
  await syncEnvelopes(creds, userId, 'normal', {
    folderPaths,
    client: statusClient,
    status: statusOf({ quiet: { highestModseq: null }, busy: { highestModseq: 51 } }),
  });
  check('a missing marker is treated as changed', () => assert.deepEqual(opened, ['Quiet']));
  // ── Spam filing ──────────────────────────────────────────────────────────
  // A separate mailbox, so the inbox census below cannot see the rows above.
  const setPrefs = (data) =>
    query(
      `INSERT INTO preferences(user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data`,
      [userId, JSON.stringify(data)],
    );
  const [{ id: spamAccount }] = await query(
    `INSERT INTO accounts(user_id,address,domain,label,imap_host,imap_port,smtp_host,smtp_port,username,secret_ciphertext,secret_nonce,secret_tag,status)
    VALUES ($1,$2,'example.test','Spam','invalid',993,'invalid',587,$2,'x','x','x','disabled') RETURNING id`,
    [userId, `spam-${email}`],
  );
  const [spamInbox, junk] = await query(
    `INSERT INTO folders(account_id,path,name,role,uidvalidity,uidnext,position)
    VALUES ($1,'INBOX','Inbox','inbox',1,1,0),($1,'Junk','Junk','junk',1,1,1) RETURNING *`,
    [spamAccount],
  );
  const arriving = [
    { uid: 1, subject: '***SPAM*** Win a prize', headers: '' },
    { uid: 2, subject: 'Lunch?', headers: '' },
    { uid: 3, subject: 'Quarterly numbers', headers: 'X-Spam-Flag: YES\r\n' },
  ];
  const inboxPeer = (list) => ({
    capabilities: new Set(),
    mailboxOpen: async () => ({ uidValidity: 1n, uidNext: list.at(-1).uid + 1, exists: list.length }),
    async *fetch(_range, what) {
      for (const a of list) {
        if (!what.envelope) {
          yield { uid: a.uid, flags: new Set() };
          continue;
        }
        yield {
          uid: a.uid,
          flags: new Set(),
          size: 10,
          envelope: {
            subject: a.subject,
            messageId: `<spam-check-${a.uid}@example.test>`,
            from: [{ address: 'sender@example.test' }],
            date: new Date(),
          },
          headers: Buffer.from(a.headers),
        };
      }
    },
  });
  const spamCreds = { id: spamAccount, address: `spam-${email}` };
  const spamMoves = [];
  const junkPeer = {
    capabilities: new Set(['UIDPLUS']),
    mailbox: { uidValidity: 1n, permanentFlags: new Set(['\\*']) },
    async getMailboxLock(path) {
      this.mailbox.path = path;
      return { release() {} };
    },
    async messageMove(uids, target) {
      spamMoves.push([this.mailbox.path, [...uids], target]);
      return { uidValidity: 1n, uidMap: new Map(uids.map((uid) => [uid, uid + 500])) };
    },
  };
  await setPrefs({});
  const pass = await syncFolder(inboxPeer(arriving), userId, spamAccount, 'normal', spamInbox, () => {});
  const filed = await handleArrivals(spamCreds, userId, junkPeer, pass.arrivals);
  const where = await query(
    `SELECT m.subject, m.uid, f.path FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.account_id = $1 ORDER BY m.subject`,
    [spamAccount],
  );
  check('server-marked spam is filed into Junk and replayed; other mail stays', () => {
    assert.equal(pass.arrivals.length, 3);
    assert.ok(pass.arrivals.every((a) => a.fresh));
    assert.equal(filed.filed, 2);
    assert.deepEqual(
      where.map((r) => [r.subject, r.path, Number(r.uid)]),
      [
        ['***SPAM*** Win a prize', 'Junk', 501],
        ['Lunch?', 'INBOX', 2],
        ['Quarterly numbers', 'Junk', 503],
      ],
    );
    // UIDs travel in row-id order, which is random; the set is what matters.
    assert.deepEqual(
      spamMoves.map(([from, uids, to]) => [from, [...uids].sort(), to]),
      [['INBOX', [1, 3], 'Junk']],
    );
  });
  const rescued = (
    await query(`SELECT id FROM messages WHERE account_id = $1 AND uid = 501`, [spamAccount])
  )[0];
  await act([rescued.id], { type: 'move', folderId: spamInbox.id });
  for (const op of await dueOps(spamAccount)) await applyOp(junkPeer, spamAccount, op);
  await query('DELETE FROM sync_ops WHERE account_id=$1', [spamAccount]);
  const rescuedUid = Number((await query('SELECT uid FROM messages WHERE id=$1', [rescued.id]))[0].uid);
  const again = await upsert(userId, spamAccount, spamInbox.id, 'normal', [
    { ...indexed, uid: rescuedUid, messageId: 'spam-check-1@example.test', subject: '***SPAM*** Win a prize' },
  ]);
  check('mail moved back out of Junk is an update, not an arrival to file again', () =>
    assert.deepEqual(again.inserted, []),
  );
  await setPrefs({ mailHandling: { spamFilterExcluded: [spamAccount] } });
  const later = await syncFolder(
    inboxPeer([{ uid: 4, subject: '***SPAM*** Again', headers: '' }]),
    userId,
    spamAccount,
    'normal',
    (await query('SELECT * FROM folders WHERE id=$1', [spamInbox.id]))[0],
    () => {},
  );
  const skipped = await handleArrivals(spamCreds, userId, junkPeer, later.arrivals);
  check('an excluded mailbox keeps its spam in the inbox', () => {
    assert.equal(later.arrivals.length, 1);
    assert.equal(skipped.filed, 0);
  });

  // ── Filtered ─────────────────────────────────────────────────────────────
  const [{ id: filterAccount }] = await query(
    `INSERT INTO accounts(user_id,address,domain,label,imap_host,imap_port,smtp_host,smtp_port,username,secret_ciphertext,secret_nonce,secret_tag,status)
    VALUES ($1,$2,'example.test','Filter','invalid',993,'invalid',587,$2,'x','x','x','disabled') RETURNING id`,
    [userId, `filter-${email}`],
  );
  const [filterInbox, filteredFolder] = await query(
    `INSERT INTO folders(account_id,path,name,role,uidvalidity,uidnext,position)
    VALUES ($1,'INBOX','Inbox','inbox',1,1,0),($1,'INBOX.Filtered','Filtered','filtered',1,1,1) RETURNING *`,
    [filterAccount],
  );
  const filterCreds = { id: filterAccount, address: `filter-${email}` };
  const mailPeer = (list) => ({
    capabilities: new Set(),
    mailboxOpen: async () => ({ uidValidity: 1n, uidNext: list.at(-1).uid + 1, exists: list.length }),
    async *fetch(_range, what) {
      for (const a of list) {
        if (!what.envelope) {
          yield { uid: a.uid, flags: new Set() };
          continue;
        }
        yield {
          uid: a.uid,
          flags: new Set(),
          size: 10,
          envelope: {
            subject: a.subject,
            messageId: `<filter-check-${a.uid}@example.test>`,
            from: [{ address: a.from }],
            to: [{ address: filterCreds.address }],
            date: new Date(),
          },
          headers: Buffer.from(a.headers ?? ''),
        };
      }
    },
  });
  const filterMoves = [];
  const filterPeer = {
    ...junkPeer,
    mailbox: { uidValidity: 1n, permanentFlags: new Set(['\\*']) },
    async messageMove(uids, target) {
      filterMoves.push([this.mailbox.path, [...uids], target]);
      return { uidValidity: 1n, uidMap: new Map(uids.map((uid) => [uid, uid + 700])) };
    },
  };
  const currentFolder = async (id) => (await query('SELECT * FROM folders WHERE id=$1', [id]))[0];
  const byUid = async (uid) =>
    (await query('SELECT id, folder_id FROM messages WHERE account_id=$1 AND uid=$2', [filterAccount, uid]))[0];
  const examples = (where = '') =>
    query(`SELECT verdict, list_id, from_address, message_id FROM filter_examples WHERE user_id=$1 ${where} ORDER BY id`, [userId]);
  // What the server still holds in INBOX, so a later pass does not read the
  // older mail as deleted. Sorted so the last entry sets UIDNEXT.
  const present = async (...arriving) =>
    [
      ...(
        await query(
          `SELECT uid, subject, from_address, list_id FROM messages WHERE folder_id=$1 AND uid IS NOT NULL`,
          [filterInbox.id],
        )
      ).map((r) => ({
        uid: Number(r.uid),
        subject: r.subject,
        from: r.from_address,
        headers: r.list_id ? `List-Id: <${r.list_id}>\r\n` : '',
      })),
      ...arriving,
    ].sort((x, y) => x.uid - y.uid);
  const settle = async () => {
    for (const op of await dueOps(filterAccount)) await applyOp(filterPeer, filterAccount, op);
    await query('DELETE FROM sync_ops WHERE account_id=$1', [filterAccount]);
  };

  await setPrefs({});
  const first = await syncFolder(
    mailPeer([
      { uid: 1, subject: 'This week at Shop', from: 'news@shop.example', headers: 'List-Id: Shop News <news.shop.example>\r\nList-Unsubscribe: <mailto:u@shop.example>\r\n' },
      { uid: 2, subject: 'Dinner on Friday?', from: 'friend@people.example' },
      { uid: 3, subject: 'Review requested', from: 'noreply@code.example', headers: 'List-Id: <repo-a.code.example>\r\n' },
    ]),
    userId, filterAccount, 'normal', filterInbox, () => {},
  );
  const untaught = await handleArrivals(filterCreds, userId, filterPeer, first.arrivals);
  const news = await byUid(1);
  check('the filter files nothing before it has been taught anything', () => {
    assert.equal(first.arrivals.length, 3);
    assert.equal(untaught.filed, 0);
  });
  const listed = (await query('SELECT list_id, bulk FROM messages WHERE id=$1', [news.id]))[0];
  check('List-Id and bulk are indexed from the envelope headers', () => {
    assert.equal(listed.list_id, 'news.shop.example');
    assert.equal(listed.bulk, true);
  });

  await act([news.id], { type: 'move', folderId: filteredFolder.id });
  const taught = await examples();
  check('filing a message records its list as an example', () =>
    assert.deepEqual(taught.map((e) => [e.verdict, e.list_id, e.message_id]), [['filter', 'news.shop.example', news.id]]),
  );
  await act([news.id], { type: 'move', folderId: filterInbox.id });
  const undone = await examples();
  check('moving the user’s own filing back out leaves no example', () => assert.deepEqual(undone, []));
  await act([news.id], { type: 'move', folderId: filteredFolder.id });
  await settle();

  const second = await syncFolder(
    mailPeer(
      await present(
        { uid: 4, subject: 'Offers this weekend', from: 'offers@shop.example', headers: 'List-Id: <news.shop.example>\r\n' },
        { uid: 5, subject: 'Review requested', from: 'noreply@code.example', headers: 'List-Id: <repo-b.code.example>\r\n' },
      ),
    ),
    userId, filterAccount, 'normal', await currentFolder(filterInbox.id), () => {},
  );
  const ruled = await handleArrivals(filterCreds, userId, filterPeer, second.arrivals);
  const offer = await byUid(704);
  const decision = offer
    ? (await query('SELECT stage, rescued_at FROM filter_decisions WHERE message_id=$1', [offer.id]))[0]
    : null;
  check('new mail on a filtered list is filed into Filtered and replayed; other lists stay', () => {
    assert.equal(second.arrivals.length, 2);
    assert.equal(ruled.filed, 1);
    assert.ok(offer, 'the filed message took its new UID in Filtered');
    assert.equal(offer.folder_id, filteredFolder.id);
    assert.equal(decision?.stage, 'rule');
    assert.deepEqual(filterMoves.at(-1), ['INBOX', [4], 'INBOX.Filtered']);
  });

  await act([offer.id], { type: 'move', folderId: filterInbox.id });
  const corrected = (await query('SELECT rescued_at FROM filter_decisions WHERE message_id=$1', [offer.id]))[0];
  const verdicts = await examples(`AND list_id = 'news.shop.example'`);
  check('rescuing filed mail records the mistake and keeps that list in the inbox', () => {
    assert.ok(corrected.rescued_at);
    assert.deepEqual(verdicts.map((e) => e.verdict), ['filter', 'keep']);
  });

  const status = await call('/filter/status');
  check('the status lists what was learned, newest decision per list', () => {
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.examples, { filter: 1, keep: 1 });
    const source = status.body.sources.find((s) => s.value === 'news.shop.example');
    assert.equal(source?.kind, 'list');
    assert.equal(source?.verdict, 'keep');
    assert.equal(source?.count, 2);
  });
  const forgotten = await call('/filter/forget', { kind: 'list', value: 'news.shop.example' });
  const afterForget = await examples();
  check('forgetting a list removes every example from it', () => {
    assert.equal(forgotten.status, 204);
    assert.deepEqual(afterForget, []);
  });

  await settle();
  await setPrefs({ filtering: { enabled: false } });
  const third = await syncFolder(
    mailPeer(await present({ uid: 5000, subject: 'Photos from Friday', from: 'friend@people.example' })),
    userId, filterAccount, 'normal', await currentFolder(filterInbox.id), () => {},
  );
  const off = await handleArrivals(filterCreds, userId, filterPeer, third.arrivals);
  check('with the filter off nothing is filed', () => assert.equal(off.filed, 0));
  await setPrefs({});
  await act([(await byUid(2)).id], { type: 'move', folderId: filteredFolder.id });
  const swept = await call('/filter/sweep', {});
  // Filed mail has no UID in Filtered until replay assigns one, so by id.
  const photos = (await query('SELECT folder_id FROM messages WHERE id=$1', [third.arrivals[0].id]))[0];
  check('a sweep files inbox mail the sender rules already cover', () => {
    assert.equal(swept.status, 200, JSON.stringify(swept.body));
    assert.equal(swept.body.filed, 1);
    assert.equal(photos.folder_id, filteredFolder.id);
  });

  // A decision can finish after the user archived the mail and replay caught
  // up. Automatic filing must recheck the current folder inside its write.
  await settle();
  const [filterArchive] = await query(
    `INSERT INTO folders(account_id,path,name,role,uidvalidity) VALUES ($1,'Archive','Archive','archive',1) RETURNING id`,
    [filterAccount],
  );
  const raced = await byUid(3);
  await act([raced.id], { type: 'move', folderId: filterArchive.id });
  await settle();
  const late = await fileDecisions(userId, filterAccount, [{ id: raced.id, stage: 'llm', score: 1, model: 'test' }]);
  check('a late automatic decision leaves user-archived mail alone', () => assert.deepEqual(late, []));

  // ── Missing Trash and Junk ───────────────────────────────────────────────
  const [{ id: bareAccount }] = await query(
    `INSERT INTO accounts(user_id,address,domain,label,imap_host,imap_port,smtp_host,smtp_port,username,secret_ciphertext,secret_nonce,secret_tag,status)
    VALUES ($1,$2,'example.test','Bare','invalid',993,'invalid',587,$2,'x','x','x','disabled') RETURNING id`,
    [userId, `bare-${email}`],
  );
  const bareCreds = { id: bareAccount, address: `bare-${email}` };
  const serverFolders = [{ path: 'INBOX', name: 'INBOX', delimiter: '.', flags: new Set(), subscribed: true }];
  const created = [];
  const barePeer = {
    capabilities: new Set(),
    list: async () => serverFolders.map((f) => ({ ...f })),
    async mailboxCreate(raw) {
      const path = Array.isArray(raw) ? raw.join('.') : raw;
      created.push(path);
      serverFolders.push({ path, name: path.split('.').at(-1), delimiter: '.', flags: new Set(), subscribed: true });
    },
    mailboxSubscribe: async () => true,
  };
  await setPrefs({ mailHandling: { createMissingFolders: false }, filtering: { enabled: false } });
  await syncFolders(bareCreds, barePeer);
  check('missing folders are left alone when the preference is off', () => assert.deepEqual(created, []));
  await setPrefs({});
  await syncFolders(bareCreds, barePeer);
  const roles = (
    await query('SELECT role::text FROM folders WHERE account_id=$1 ORDER BY role', [bareAccount])
  ).map((r) => r.role);
  check('a mailbox with no Trash or Junk gets both, and Filtered under its inbox', () => {
    assert.deepEqual(created, ['Trash', 'Junk', 'INBOX.Filtered']);
    assert.deepEqual([...roles].sort(), ['filtered', 'inbox', 'junk', 'trash']);
  });
  await syncFolders(bareCreds, barePeer);
  check('folders that exist are not created twice', () => assert.equal(created.length, 3));

  for (const delimiter of ['.', '/']) {
    const paths = ['INBOX', `INBOX${delimiter}Filtered`, `INBOX${delimiter}Filtered${delimiter}Receipts`, 'Projects.v1', `Projects.v1${delimiter}Notes`];
    const peer = {
      ...barePeer,
      list: async () => paths.map((path) => ({ path, name: path.split(delimiter).at(-1), delimiter, flags: new Set(), subscribed: true })),
    };
    await setPrefs({ mailHandling: { createMissingFolders: false }, filtering: { enabled: false } });
    await syncFolders(bareCreds, peer);
    const tree = await query(`SELECT child.path, parent.path AS parent FROM folders child
      LEFT JOIN folders parent ON parent.id=child.parent_id WHERE child.account_id=$1`, [bareAccount]);
    check(`folder parents follow the server's ${delimiter} delimiter`, () => {
      const parents = new Map(tree.map((r) => [r.path, r.parent]));
      assert.equal(parents.get(`INBOX${delimiter}Filtered`), 'INBOX');
      assert.equal(parents.get(`INBOX${delimiter}Filtered${delimiter}Receipts`), `INBOX${delimiter}Filtered`);
      assert.equal(parents.get(`Projects.v1${delimiter}Notes`), 'Projects.v1');
      assert.equal(parents.get('Projects.v1'), null);
    });
  }

  console.log(
    `consistency-check: ${passed} passed; local action acknowledgements ${timings.map((ms) => Math.round(ms) + 'ms').join(', ')}`,
  );
} finally {
  if (userId || foreignUserId) await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,foreignUserId].filter(Boolean)]);
  await close();
}
