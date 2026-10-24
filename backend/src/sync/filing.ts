/**
 * Moving mail on the user's behalf, into an account's folder of one role.
 *
 * The same local move and queued `sync_ops` row a click produces (see
 * modules/messages/routes.ts), so replay, COPYUID tracking and retries treat
 * it exactly like a user's move. Used by the spam filter (Junk) and by the
 * Filtered folder, both on arrival and when sweeping the inbox.
 */

import type pg from 'pg';
import { messageTransaction } from '../db/index.ts';
import type { FolderRole } from '../contract/types.ts';
import { refreshCounts } from './folders.ts';
import { refreshThreads } from './threads.ts';

/**
 * Move rows into the account's folder of `role`, locally and in the replay
 * queue, in one transaction. Returns the ids that moved; none when the account
 * has no such folder, which the folder pass creates when the user allows it.
 */
export async function fileByRole(
  userId: string,
  accountId: string,
  ids: readonly string[],
  role: Extract<FolderRole, 'junk' | 'filtered'>,
  /** Runs in the same transaction with the ids that moved, so a record of
   *  why they moved commits with the move or not at all. */
  after?: (tx: pg.PoolClient, moved: string[]) => Promise<void>,
): Promise<string[]> {
  if (!ids.length) return [];
  return messageTransaction(userId, async (tx) => {
    const folder = (
      await tx.query<{ id: string }>(
        `SELECT id FROM folders WHERE account_id = $1 AND role = $2::folder_role_t ORDER BY position, id LIMIT 1`,
        [accountId, role],
      )
    ).rows[0];
    if (!folder) return [];

    // Rows already moving are the user's; their move wins.
    const owned = (
      await tx.query<{ id: string; thread_id: string; uid: number; path: string; uidvalidity: number | null }>(
        `SELECT m.id, m.thread_id, m.uid, f.path, f.uidvalidity
           FROM messages m JOIN folders f ON f.id = m.folder_id
          WHERE m.account_id = $1 AND m.id = ANY($2::uuid[])
            AND m.remote_folder_id IS NULL AND m.uid IS NOT NULL
            AND m.folder_id <> $3 AND f.role = 'inbox'
          ORDER BY m.id FOR UPDATE OF m`,
        [accountId, ids, folder.id],
      )
    ).rows;
    if (!owned.length) return [];
    const ownedIds = owned.map((r) => r.id);

    await tx.query(
      `UPDATE messages
          SET remote_folder_id = folder_id, remote_uid = uid, uid = NULL, folder_id = $2
        WHERE id = ANY($1::uuid[])`,
      [ownedIds, folder.id],
    );
    await tx.query('INSERT INTO sync_ops (account_id, kind, payload) VALUES ($1, $2, $3)', [
      accountId,
      'move',
      JSON.stringify({
        ids: ownedIds,
        targets: owned.map((r) => ({ id: r.id, path: r.path, uid: Number(r.uid), uidValidity: r.uidvalidity })),
        action: { type: 'move', folderId: folder.id },
      }),
    ]);
    await refreshCounts([accountId], async (sql, params) => (await tx.query(sql, params)).rows);
    await refreshThreads(
      userId,
      owned.map((r) => r.thread_id),
      tx,
    );
    await after?.(tx, ownedIds);
    return ownedIds;
  });
}
