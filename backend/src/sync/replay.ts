/**
 * Outbound replay. `sync_ops` → IMAP commands.
 *
 * Every mutation the API accepts is written to `sync_ops` in the same
 * transaction as the local change, and the response goes back immediately. This
 * file is what eventually tells the mail server. The ordering is the whole
 * point: the local index is authoritative for what the user sees, and IMAP is
 * eventually consistent with it. Blocking a click on an IMAP round trip is how
 * webmail comes to feel slow.
 *
 * Failure handling has two kinds. A transient failure (server down, connection
 * dropped) backs off and tries again. A permanent one (the folder is gone, the
 * credential was revoked) is parked with the server's own error text, because
 * "Mailbox doesn't exist: Archive" tells the user what to do and "sync failed"
 * does not.
 */

import type { ImapFlow } from 'imapflow';
import { query } from '../db/index.ts';
import type { Flag, MessageAction } from '../contract/types.ts';
import { withConnection, type AccountCredentials } from './pool.ts';

/** Ops attempted per pass. Bounded so one account with a thousand queued moves
 *  cannot hold the connection while every other account waits. */
const PER_PASS = 200;
/** After this many attempts an op is parked rather than retried forever. */
const MAX_ATTEMPTS = 8;

/**
 * Where a message was on the server when the user acted on it.
 *
 * Captured into the payload at queue time, not looked up here, because by the
 * time replay runs the local index has already been mutated. A move that
 * resolved its source from `messages.folder_id` would read back the
 * *destination* and correctly conclude there was nothing to do; a permanent
 * delete would find no row at all. The op has to be self-describing.
 */
interface Target {
  path: string;
  uid: number;
}

interface OpRow {
  id: number;
  kind: string;
  /** `targets` addresses the server; `ids` names the local rows, which is what
   *  the envelope pass reads to know whose flags are still in flight. */
  payload: { ids: string[]; targets: Target[]; action: MessageAction };
  attempts: number;
}

/** IMAP has no notion of "answered" as a client-side concept, and `\Recent` is
 *  read-only, so neither maps outward. */
const IMAP_FLAG: Partial<Record<Flag, string>> = {
  seen: '\\Seen',
  flagged: '\\Flagged',
  answered: '\\Answered',
  draft: '\\Draft',
  deleted: '\\Deleted',
};

/**
 * Drain this account's queue.
 *
 * Called at the top of the account's sync pass, on the same connection budget.
 * Returns the number of ops that completed, which the caller only uses for
 * logging — a failure here never fails the pass, because the envelope sync
 * behind it is still worth running.
 */
export async function replayAccount(creds: AccountCredentials): Promise<number> {
  const ops = await query<OpRow>(
    `SELECT id, kind, payload, attempts
       FROM sync_ops
      WHERE account_id = $1
        AND next_attempt_at <= now()
        AND attempts < $2
      ORDER BY id
      LIMIT $3`,
    [creds.id, MAX_ATTEMPTS, PER_PASS],
  );
  if (!ops.length) return 0;

  let done = 0;
  try {
    await withConnection(creds, async (client) => {
      for (const op of ops) {
        try {
          await applyOp(client, creds.id, op);
          await query('DELETE FROM sync_ops WHERE id = $1', [op.id]);
          done++;
        } catch (err) {
          await recordFailure(op, err as Error);
        }
      }
    });
  } catch (err) {
    // Could not connect at all. Nothing was attempted, so nothing is charged an
    // attempt: this is the server's outage, not the op's fault, and burning the
    // retry budget on it would park perfectly good work.
    console.warn({ account: creds.address, err: (err as Error).message }, 'replay could not connect');
    return 0;
  }
  return done;
}

/* ── One op ────────────────────────────────────────────────────────────────── */

/** Targets grouped by source mailbox: one SELECT and one STORE per folder,
 *  rather than one of each per message. */
function byFolder(targets: Target[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const t of targets) {
    const list = out.get(t.path);
    if (list) list.push(t.uid);
    else out.set(t.path, [t.uid]);
  }
  return out;
}

async function applyOp(client: ImapFlow, accountId: string, op: OpRow): Promise<void> {
  const { action, targets } = op.payload;
  if (!targets?.length) return;
  const sources = byFolder(targets);

  switch (action.type) {
    case 'flag': {
      const add = action.add.map((f) => IMAP_FLAG[f]).filter((f): f is string => !!f);
      const remove = action.remove.map((f) => IMAP_FLAG[f]).filter((f): f is string => !!f);
      if (!add.length && !remove.length) return;
      for (const [path, uids] of sources) {
        const lock = await client.getMailboxLock(path);
        try {
          if (add.length) await client.messageFlagsAdd(uids, add, { uid: true });
          if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true });
        } finally {
          lock.release();
        }
      }
      return;
    }

    case 'move':
    case 'delete': {
      // A trash-delete *is* a move, and both share the same failure mode: the
      // destination may be gone server-side even though a row for it exists
      // locally. `messageMove` uses MOVE when the server has it and falls back to
      // COPY + STORE \Deleted + EXPUNGE when it does not.
      const target = await destinationPath(accountId, action);
      for (const [path, uids] of sources) {
        if (target && path === target) continue; // already there
        const lock = await client.getMailboxLock(path);
        try {
          if (target) await client.messageMove(uids, target, { uid: true });
          // Permanent delete, or no trash folder to move to.
          else await client.messageDelete(uids, { uid: true });
        } finally {
          lock.release();
        }
      }
      return;
    }

    case 'label':
    case 'snooze':
      // Both are ours. The mail server is read-only infrastructure, keyword
      // support varies per folder, and there is no server-side snooze without
      // Sieve. These rows exist so the queue is a complete record of what the
      // user did, and are dropped here without a round trip.
      return;

    case 'copy': {
      const target = await pathOf(accountId, action.folderId);
      if (!target) throw permanent('Destination folder no longer exists');
      for (const [path, uids] of sources) {
        const lock = await client.getMailboxLock(path);
        try {
          await client.messageCopy(uids, target, { uid: true });
        } finally {
          lock.release();
        }
      }
      return;
    }
  }
}

async function destinationPath(accountId: string, action: MessageAction): Promise<string | null> {
  if (action.type === 'move') {
    const path = await pathOf(accountId, action.folderId);
    if (!path) throw permanent('Destination folder no longer exists');
    return path;
  }
  if (action.type === 'delete') {
    if (action.permanent) return null;
    const rows = await query<{ path: string }>(
      `SELECT path FROM folders WHERE account_id = $1 AND role = 'trash' ORDER BY position LIMIT 1`,
      [accountId],
    );
    // No trash folder is not an error: some servers do not have one, and the
    // correct behaviour there is an expunge.
    return rows[0]?.path ?? null;
  }
  return null;
}

async function pathOf(accountId: string, folderId: string): Promise<string | null> {
  const rows = await query<{ path: string }>(
    'SELECT path FROM folders WHERE account_id = $1 AND id = $2',
    [accountId, folderId],
  );
  return rows[0]?.path ?? null;
}

/* ── Failure ───────────────────────────────────────────────────────────────── */

class PermanentError extends Error {
  readonly permanent = true;
}

const permanent = (message: string): PermanentError => new PermanentError(message);

/** Server responses that will never succeed on retry. Matched on the text
 *  because IMAP response codes for these are inconsistent across servers. */
const PERMANENT = /no.?such|does ?n.t exist|nonexistent|invalid|permission|denied|authenticat/i;

async function recordFailure(op: OpRow, err: Error): Promise<void> {
  const isPermanent = err instanceof PermanentError || PERMANENT.test(err.message);
  const attempts = op.attempts + 1;
  const parked = isPermanent || attempts >= MAX_ATTEMPTS;

  await query(
    `UPDATE sync_ops
        SET attempts = $2,
            last_error = $3,
            -- Parked ops get a far-future retry rather than a delete: the row is
            -- the only record that the user asked for something the server
            -- refused, and the UI surfaces it from here.
            next_attempt_at = CASE WHEN $4 THEN 'infinity'::timestamptz
                                   ELSE now() + (least(300, power(2, $2)::int) || ' seconds')::interval
                              END
      WHERE id = $1`,
    [op.id, parked ? MAX_ATTEMPTS : attempts, err.message, parked],
  );

  console.warn(
    { op: op.id, kind: op.kind, attempts, parked, err: err.message },
    parked ? 'sync op parked' : 'sync op failed, will retry',
  );
}

/** Ops the server refused for good. Surfaced per account so the UI can say so
 *  with the server's own words. */
export async function parkedOps(
  accountId: string,
): Promise<{ id: number; kind: string; error: string | null }[]> {
  return query(
    `SELECT id, kind, last_error AS error
       FROM sync_ops
      WHERE account_id = $1 AND attempts >= $2
      ORDER BY id`,
    [accountId, MAX_ATTEMPTS],
  );
}
