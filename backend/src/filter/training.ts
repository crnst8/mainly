/**
 * What a move teaches the filter.
 *
 * The filter learns from where the user puts mail, not from a separate
 * "train" button, so every way of filing teaches it the same thing: the Filter
 * button, dragging to the folder, an agent moving mail through the API.
 *
 *  - **Into Filtered** from anywhere else: an example that this mail belongs
 *    there. Its list or sender becomes a rule.
 *  - **Out of Filtered** to anywhere but Trash or Junk:
 *     - if the user filed it themselves, their own example is withdrawn. This
 *       is Undo, or a change of mind, and leaves no opposite rule behind;
 *     - otherwise the filter (or a server rule) put it there and was wrong:
 *       an example that it belongs in the inbox, and a rule that keeps its
 *       list or sender there.
 *  - Into Trash or Junk from Filtered teaches nothing: deleting filtered mail
 *    is what the folder is for.
 *
 * Runs inside the action's transaction, after the move, so the lesson commits
 * or rolls back with the move that taught it.
 */

import type pg from 'pg';
import { featuresOf } from './features.ts';
import { FILTER_ROW_COLUMNS, MAX_EXAMPLES, inputOf, type FilterRow } from './model.ts';

/** Roles that taking mail out of Filtered into is not a correction. */
const DISPOSAL = new Set(['trash', 'junk']);

export async function learnFromMove(
  tx: pg.PoolClient,
  userId: string,
  moved: readonly { id: string; folder_id: string }[],
  targetFolderId: string,
): Promise<void> {
  if (!moved.length) return;
  const folders = (
    await tx.query<{ id: string; role: string }>('SELECT id, role FROM folders WHERE id = ANY($1::uuid[])', [
      [targetFolderId, ...new Set(moved.map((m) => m.folder_id))],
    ])
  ).rows;
  const role = new Map(folders.map((f) => [f.id, f.role]));
  const target = role.get(targetFolderId);

  const filed = target === 'filtered' ? moved.filter((m) => role.get(m.folder_id) !== 'filtered') : [];
  const rescued =
    target !== 'filtered' && !DISPOSAL.has(target ?? '')
      ? moved.filter((m) => role.get(m.folder_id) === 'filtered')
      : [];
  if (!filed.length && !rescued.length) return;

  const rows = (
    await tx.query<FilterRow>(
      `SELECT ${FILTER_ROW_COLUMNS} FROM messages m JOIN accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND m.id = ANY($2::uuid[])`,
      [userId, [...filed, ...rescued].map((m) => m.id)],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));

  if (filed.length) {
    // Filing again what was filed before replaces the old example rather than
    // counting the same message twice.
    await tx.query(`DELETE FROM filter_examples WHERE user_id = $1 AND message_id = ANY($2::uuid[])`, [
      userId,
      filed.map((m) => m.id),
    ]);
    await insertExamples(tx, userId, filed.flatMap((m) => byId.get(m.id) ?? []), 'filter');
  }

  if (rescued.length) {
    const ids = rescued.map((m) => m.id);
    const withdrawn = (
      await tx.query<{ message_id: string }>(
        `DELETE FROM filter_examples
          WHERE user_id = $1 AND message_id = ANY($2::uuid[]) AND verdict = 'filter'
          RETURNING message_id`,
        [userId, ids],
      )
    ).rows.map((r) => r.message_id);
    const mistaken = ids.filter((id) => !withdrawn.includes(id));
    await tx.query(
      `UPDATE filter_decisions SET rescued_at = now()
        WHERE user_id = $1 AND message_id = ANY($2::uuid[]) AND rescued_at IS NULL`,
      [userId, mistaken],
    );
    await insertExamples(tx, userId, mistaken.flatMap((id) => byId.get(id) ?? []), 'keep');
  }

  await tx.query(
    `DELETE FROM filter_examples WHERE user_id = $1 AND id <= (
       SELECT id FROM filter_examples WHERE user_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1
     )`,
    [userId, MAX_EXAMPLES],
  );
}

async function insertExamples(
  tx: pg.PoolClient,
  userId: string,
  rows: readonly FilterRow[],
  verdict: 'filter' | 'keep',
): Promise<void> {
  if (!rows.length) return;
  await tx.query(
    `INSERT INTO filter_examples (user_id, message_id, verdict, from_address, from_name, subject, list_id, features)
     SELECT $1, r.message_id, $2, r.from_address, r.from_name, r.subject, r.list_id, r.features
       FROM jsonb_to_recordset($3::jsonb) AS r(
         message_id uuid, from_address text, from_name text, subject text, list_id text, features text[]
       )`,
    [
      userId,
      verdict,
      JSON.stringify(
        rows.map((r) => ({
          message_id: r.id,
          from_address: r.from_address,
          from_name: r.from_name,
          subject: r.subject.slice(0, 300),
          list_id: r.list_id,
          features: featuresOf(inputOf(r)),
        })),
      ),
    ],
  );
}
