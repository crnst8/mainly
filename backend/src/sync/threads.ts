/**
 * The maintained thread index used by the unfiltered threaded list path.
 *
 * Thread rows are per app user, not per account: the same conversation can be
 * delivered to two of the user's addresses. Every caller supplies the threads
 * it changed, and this module is the only code allowed to write the index.
 */

import { query, transaction } from '../db/index.ts';

const CHUNK = 1000;

/** Recompute explicit threads for one user, including their folder rollups. */
export async function refreshThreads(
  userId: string,
  threadIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(threadIds)].filter(Boolean);
  if (!unique.length) return;

  for (let offset = 0; offset < unique.length; offset += CHUNK) {
    const chunk = unique.slice(offset, offset + CHUNK);
    await transaction(async (tx) => {
      await tx.query(
        `WITH agg AS (
           SELECT m.thread_id,
                  max(m.date) AS last_date,
                  count(*)::int AS msg_count,
                  count(*) FILTER (WHERE NOT m.seen)::int AS unread_count,
                  count(*) FILTER (WHERE m.flagged)::int AS flagged_count,
                  count(*) FILTER (WHERE m.has_attachments)::int AS attachment_count
             FROM messages m
             JOIN accounts a ON a.id = m.account_id
            WHERE a.user_id = $1 AND m.thread_id = ANY($2::text[])
            GROUP BY m.thread_id
         ), newest AS (
           SELECT DISTINCT ON (m.thread_id) m.thread_id, m.id
             FROM messages m
             JOIN accounts a ON a.id = m.account_id
            WHERE a.user_id = $1 AND m.thread_id = ANY($2::text[])
            ORDER BY m.thread_id, m.date DESC, m.id DESC
         )
         INSERT INTO threads (
           user_id, thread_id, last_date, last_message,
           msg_count, unread_count, flagged_count, attachment_count
         )
         SELECT $1, agg.thread_id, agg.last_date, newest.id,
                agg.msg_count, agg.unread_count, agg.flagged_count, agg.attachment_count
           FROM agg JOIN newest ON newest.thread_id = agg.thread_id
         ON CONFLICT (user_id, thread_id) DO UPDATE SET
           last_date = EXCLUDED.last_date,
           last_message = EXCLUDED.last_message,
           msg_count = EXCLUDED.msg_count,
           unread_count = EXCLUDED.unread_count,
           flagged_count = EXCLUDED.flagged_count,
           attachment_count = EXCLUDED.attachment_count`,
        [userId, chunk],
      );

      // A permanent delete can leave an index row with no message. Remove it
      // before rebuilding folder leaves; the composite FK removes its leaves.
      await tx.query(
        `DELETE FROM threads t
          WHERE t.user_id = $1
            AND t.thread_id = ANY($2::text[])
            AND NOT EXISTS (
              SELECT 1
                FROM messages m
                JOIN accounts a ON a.id = m.account_id
               WHERE a.user_id = $1 AND m.thread_id = t.thread_id
            )`,
        [userId, chunk],
      );

      // Delete first because a thread can lose its last message in a folder.
      await tx.query(
        'DELETE FROM thread_folders WHERE user_id = $1 AND thread_id = ANY($2::text[])',
        [userId, chunk],
      );

      await tx.query(
        `INSERT INTO thread_folders (
           user_id, thread_id, folder_id, last_date,
           msg_count, unread_count, flagged_count, attachment_count
         )
         SELECT a.user_id, m.thread_id, m.folder_id, t.last_date,
                count(*)::int,
                count(*) FILTER (WHERE NOT m.seen)::int,
                count(*) FILTER (WHERE m.flagged)::int,
                count(*) FILTER (WHERE m.has_attachments)::int
           FROM messages m
           JOIN accounts a ON a.id = m.account_id
           JOIN threads t ON t.user_id = a.user_id AND t.thread_id = m.thread_id
          WHERE a.user_id = $1 AND m.thread_id = ANY($2::text[])
          GROUP BY a.user_id, m.thread_id, m.folder_id, t.last_date`,
        [userId, chunk],
      );
    });
  }
}

/** Recompute every thread touched by one or more accounts. */
export async function refreshAccountThreads(
  accountIds: string | readonly string[],
): Promise<void> {
  const ids = typeof accountIds === 'string' ? [accountIds] : [...new Set(accountIds)];
  if (!ids.length) return;

  const owners = await query<{ user_id: string }>(
    'SELECT DISTINCT user_id FROM accounts WHERE id = ANY($1::uuid[])',
    [ids],
  );

  const rows = await query<{ user_id: string; thread_id: string }>(
    `SELECT DISTINCT a.user_id, m.thread_id
       FROM messages m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.account_id = ANY($1::uuid[])
     UNION
     SELECT DISTINCT a.user_id, tf.thread_id
       FROM thread_folders tf
       JOIN folders f ON f.id = tf.folder_id
       JOIN accounts a ON a.id = f.account_id
      WHERE f.account_id = ANY($1::uuid[])`,
    [ids],
  );

  const byUser = new Map<string, string[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id);
    if (list) list.push(row.thread_id);
    else byUser.set(row.user_id, [row.thread_id]);
  }

  for (const { user_id: userId } of owners) {
    await refreshThreads(userId, byUser.get(userId) ?? []);
    // Folder deletion cascades thread_folders before this hook runs. Clean any
    // now-unreachable thread rows as well, even when no surviving leaf could
    // identify them for the explicit refresh above.
    await query(
      `DELETE FROM threads t
        WHERE t.user_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            JOIN accounts a ON a.id = m.account_id
           WHERE a.user_id = t.user_id AND m.thread_id = t.thread_id
          )`,
      [userId],
    );
  }
}
