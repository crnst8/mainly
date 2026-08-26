/**
 * Replay's contract with imapflow: a command that reports failure is a failure.
 *
 * imapflow does not throw when the server refuses a STORE — it catches the
 * NO/BAD, logs it, and returns `false`. Reading that as success is what let a
 * failed "mark read" delete its own queue row, which removed the guard in
 * envelopes.ts that keeps local flag state while a change is in flight, which
 * let the next envelope pass write the server's still-unread flag back over it.
 * These tests pin the return-value handling so that cannot come back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow } from 'imapflow';

// config.ts validates at import, and replay reaches it through the connection
// pool. None of these are used: the flag path issues no query.
process.env.DATABASE_URL ??= 'postgres://replay-test/none';
process.env.SECRET_KEY ??= Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET ??= 'replay-test';

const { applyOp } = await import('./replay.ts');

interface Recorded {
  command: 'add' | 'remove';
  uids: number[];
  flags: string[];
}

function fakeClient(opts: {
  add?: boolean;
  remove?: boolean;
  permanentFlags?: Set<string> | undefined;
}) {
  const calls: Recorded[] = [];
  let releases = 0;
  const client = {
    mailbox: { path: 'INBOX', permanentFlags: opts.permanentFlags },
    async getMailboxLock(path: string) {
      client.mailbox = { ...client.mailbox, path };
      return { path, release: () => { releases++; } };
    },
    async messageFlagsAdd(uids: number[], flags: string[]) {
      calls.push({ command: 'add', uids, flags });
      return opts.add ?? true;
    },
    async messageFlagsRemove(uids: number[], flags: string[]) {
      calls.push({ command: 'remove', uids, flags });
      return opts.remove ?? true;
    },
  };
  return { client: client as unknown as ImapFlow, calls, releases: () => releases };
}

const markRead = (uids: number[] = [11, 12]) => ({
  id: 1,
  kind: 'flag',
  attempts: 0,
  payload: {
    ids: ['a', 'b'],
    targets: uids.map((uid) => ({ path: 'INBOX', uid })),
    action: { type: 'flag' as const, add: ['seen' as const], remove: [] },
  },
});

test('a STORE the server accepts completes the op', async () => {
  const { client, calls, releases } = fakeClient({ permanentFlags: new Set(['\\Seen']) });
  await applyOp(client, 'account', markRead());
  assert.deepEqual(calls, [{ command: 'add', uids: [11, 12], flags: ['\\Seen'] }]);
  assert.equal(releases(), 1);
});

test('a STORE the server refuses fails the op rather than dropping it', async () => {
  const { client, releases } = fakeClient({ add: false, permanentFlags: new Set(['\\Seen']) });
  await assert.rejects(
    () => applyOp(client, 'account', markRead()),
    // Named well enough that a parked op tells the user which mailbox refused.
    /Setting \\Seen on 2 message\(s\) in INBOX/,
  );
  // The lock is released on the way out, or the connection is wedged for every
  // op behind this one.
  assert.equal(releases(), 1);
});

test('a mailbox that will not keep the flag is refused before the command', async () => {
  const { client, calls } = fakeClient({ permanentFlags: new Set(['\\Flagged']) });
  await assert.rejects(
    () => applyOp(client, 'account', markRead()),
    (err: Error) => {
      assert.match(err.message, /INBOX does not keep the \\Seen flag/);
      // Permanent: retrying eight times will not change a mailbox's mind.
      assert.equal((err as Error & { permanent?: boolean }).permanent, true);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('a mailbox that allows any keyword is not second-guessed', async () => {
  const { client, calls } = fakeClient({ permanentFlags: new Set(['\\*']) });
  await applyOp(client, 'account', markRead([7]));
  assert.deepEqual(calls, [{ command: 'add', uids: [7], flags: ['\\Seen'] }]);
});

test('a server that sends no PERMANENTFLAGS has not said no', async () => {
  const { client, calls } = fakeClient({ permanentFlags: undefined });
  await applyOp(client, 'account', markRead([7]));
  assert.deepEqual(calls, [{ command: 'add', uids: [7], flags: ['\\Seen'] }]);
});

test('a refused flag removal fails the op too', async () => {
  const { client } = fakeClient({ remove: false, permanentFlags: new Set(['\\Seen']) });
  await assert.rejects(
    () =>
      applyOp(client, 'account', {
        ...markRead([5]),
        payload: {
          ...markRead([5]).payload,
          action: { type: 'flag' as const, add: [], remove: ['seen' as const] },
        },
      }),
    /Clearing \\Seen on 1 message\(s\) in INBOX/,
  );
});

test('targets in two mailboxes are one STORE each', async () => {
  const { client, calls, releases } = fakeClient({ permanentFlags: new Set(['\\*']) });
  await applyOp(client, 'account', {
    ...markRead(),
    payload: {
      ...markRead().payload,
      targets: [
        { path: 'INBOX', uid: 1 },
        { path: 'Archive', uid: 2 },
        { path: 'INBOX', uid: 3 },
      ],
    },
  });
  assert.deepEqual(calls, [
    { command: 'add', uids: [1, 3], flags: ['\\Seen'] },
    { command: 'add', uids: [2], flags: ['\\Seen'] },
  ]);
  assert.equal(releases(), 2);
});
