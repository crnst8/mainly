/**
 * What happens to mail after the envelope pass first indexes it.
 *
 * Two things: spam the server marked is filed into Junk, and what is left is
 * offered to notifications. Spam goes first so that a filed message never
 * notifies — the order is the whole reason both live here.
 *
 * Filing is the same local move and queued `sync_ops` row a click produces
 * (see modules/messages/routes.ts), so replay, COPYUID tracking and retries
 * treat it exactly like a user's move. A message the user later moves back out
 * of Junk keeps its row and its id through that move, so the next pass sees an
 * update, not an arrival, and does not file it again.
 */

import type { ImapFlow } from 'imapflow';
import { messageTransaction } from '../db/index.ts';
import type { Preferences } from '../contract/types.ts';
import { notifyArrivals } from '../push/notify.ts';
import { refreshCounts } from './folders.ts';
import { refreshThreads } from './threads.ts';
import { replayAccount } from './replay.ts';
import { preferencesOf } from './preferences.ts';
import type { AccountCredentials } from './pool.ts';
import type { Arrival } from './envelopes.ts';

export async function handleArrivals(
  creds: AccountCredentials,
  userId: string,
  client: ImapFlow,
  arrivals: readonly Arrival[],
): Promise<{ filed: number }> {
  if (!arrivals.length) return { filed: 0 };
  const prefs = await preferencesOf(creds.id);

  let filed = 0;
  const spam = spamFilterApplies(prefs, creds.id)
    ? arrivals.filter((a) => a.spam && a.role === 'inbox').map((a) => a.id)
    : [];
  if (spam.length) {
    filed = await fileAsJunk(userId, creds.id, spam);
    if (filed) {
      console.log({ account: creds.address, filed }, 'filed server-marked spam into Junk');
      // Tell the server now rather than on the next pass, so other clients
      // stop showing it in the inbox within the same second.
      await replayAccount(creds, client).catch((err: Error) => {
        console.warn({ account: creds.address, err: err.message }, 'spam replay deferred');
      });
    }
  }

  const filedIds = new Set(filed ? spam : []);
  await notifyArrivals(
    userId,
    creds.id,
    arrivals.filter((a) => !filedIds.has(a.id) && !a.spam),
    prefs,
  ).catch((err: Error) => {
    console.warn({ account: creds.address, err: err.message }, 'new-mail notification failed');
  });
  return { filed };
}

function spamFilterApplies(prefs: Preferences, accountId: string): boolean {
  return prefs.mailHandling.spamFilter && !prefs.mailHandling.spamFilterExcluded.includes(accountId);
}

/**
 * Move rows into the account's Junk folder, locally and in the replay queue,
 * in one transaction. Returns how many moved; zero when there is no Junk
 * folder, which the folder pass creates when the user allows it.
 */
async function fileAsJunk(userId: string, accountId: string, ids: string[]): Promise<number> {
  return messageTransaction(userId, async (tx) => {
    const junk = (
      await tx.query<{ id: string }>(
        `SELECT id FROM folders WHERE account_id = $1 AND role = 'junk' ORDER BY position, id LIMIT 1`,
        [accountId],
      )
    ).rows[0];
    if (!junk) return 0;

    // Rows already moving are the user's; their move wins.
    const owned = (
      await tx.query<{ id: string; thread_id: string; uid: number; path: string; uidvalidity: number | null }>(
        `SELECT m.id, m.thread_id, m.uid, f.path, f.uidvalidity
           FROM messages m JOIN folders f ON f.id = m.folder_id
          WHERE m.account_id = $1 AND m.id = ANY($2::uuid[])
            AND m.remote_folder_id IS NULL AND m.uid IS NOT NULL
            AND m.folder_id <> $3
          ORDER BY m.id FOR UPDATE OF m`,
        [accountId, ids, junk.id],
      )
    ).rows;
    if (!owned.length) return 0;
    const ownedIds = owned.map((r) => r.id);

    await tx.query(
      `UPDATE messages
          SET remote_folder_id = folder_id, remote_uid = uid, uid = NULL, folder_id = $2
        WHERE id = ANY($1::uuid[])`,
      [ownedIds, junk.id],
    );
    await tx.query('INSERT INTO sync_ops (account_id, kind, payload) VALUES ($1, $2, $3)', [
      accountId,
      'move',
      JSON.stringify({
        ids: ownedIds,
        targets: owned.map((r) => ({ id: r.id, path: r.path, uid: Number(r.uid), uidValidity: r.uidvalidity })),
        action: { type: 'move', folderId: junk.id },
      }),
    ]);
    await refreshCounts([accountId], async (sql, params) => (await tx.query(sql, params)).rows);
    await refreshThreads(
      userId,
      owned.map((r) => r.thread_id),
      tx,
    );
    return owned.length;
  });
}
