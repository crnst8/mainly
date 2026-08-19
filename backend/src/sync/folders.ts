/**
 * Folder pass. LIST/LSUB → the `folders` table.
 *
 * Cheap and idempotent, so it runs on a slow timer and on every account
 * creation. The interesting part is role mapping: SPECIAL-USE is the right
 * answer when the server advertises it, and name matching is the fallback for
 * the ones that do not. Dovecot advertises it; not every server does.
 */

import { query, transaction } from '../db/index.ts';
import type { FolderRole } from '../contract/types.ts';
import { publish } from '../modules/events/bus.ts';
import { withConnection, type AccountCredentials } from './pool.ts';

/** IMAP SPECIAL-USE attribute → our role enum. */
const SPECIAL_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\Flagged': 'flagged',
  '\\All': 'all',
};

/** Fallback for servers without SPECIAL-USE. Matched against the leaf name. */
const BY_NAME: [RegExp, FolderRole][] = [
  [/^inbox$/i, 'inbox'],
  [/^(drafts?|entw[üu]rfe)$/i, 'drafts'],
  [/^(sent|sent items|sent mail)$/i, 'sent'],
  [/^(trash|deleted items|bin)$/i, 'trash'],
  [/^(junk|spam|bulk mail)$/i, 'junk'],
  [/^(archive|all mail)$/i, 'archive'],
];

function roleOf(specialUse: string | undefined, name: string, path: string): FolderRole {
  if (specialUse && SPECIAL_USE[specialUse]) return SPECIAL_USE[specialUse]!;
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  for (const [re, role] of BY_NAME) if (re.test(name)) return role;
  return 'custom';
}

/** Roles get a fixed order; custom folders sort alphabetically after them. */
const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  flagged: 4,
  junk: 5,
  trash: 6,
  all: 7,
  custom: 100,
};

export async function syncFolders(creds: AccountCredentials): Promise<number> {
  return withConnection(creds, async (client) => {
    // One LIST covers both: the response carries `subscribed` per entry, so a
    // separate LSUB round trip would be redundant.
    const listed = await client.list();

    const rows = listed
      .filter((f) => !f.flags.has('\\NoSelect'))
      .map((f) => {
        const delimiter = f.delimiter || '.';
        const parts = f.path.split(delimiter);
        const raw = f.name || parts.at(-1) || f.path;
        const specialUse = f.specialUse;
        const role = roleOf(specialUse, raw, f.path);
        // IMAP requires the inbox be named "INBOX" exactly, and Dovecot returns
        // it that way. Shouting it in the sidebar beside "Receipts" and "Work"
        // is a protocol detail leaking into the interface.
        const name = raw.toUpperCase() === 'INBOX' ? 'Inbox' : raw;
        return {
          path: f.path,
          name,
          role,
          // INBOX's children are depth 1, not 2 — the INBOX prefix is not a
          // level anyone thinks in.
          depth: Math.max(0, parts.length - (parts[0]?.toUpperCase() === 'INBOX' ? 2 : 1)),
          parentPath: parts.length > 1 ? parts.slice(0, -1).join(delimiter) : null,
          subscribed: f.subscribed ?? true,
        };
      })
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.path.localeCompare(b.path));

    await transaction(async (tx) => {
      for (const [i, r] of rows.entries()) {
        await tx.query(
          `
          INSERT INTO folders (account_id, path, name, role, depth, subscribed, position)
          VALUES ($1, $2, $3, $4::folder_role_t, $5, $6, $7)
          ON CONFLICT (account_id, path) DO UPDATE
            SET name = EXCLUDED.name,
                role = EXCLUDED.role,
                depth = EXCLUDED.depth,
                subscribed = EXCLUDED.subscribed,
                position = EXCLUDED.position
          `,
          [creds.id, r.path, r.name, r.role, r.depth, r.subscribed, i],
        );
      }

      // Resolve parents in a second pass — the first pass may insert a child
      // before its parent exists.
      await tx.query(
        `
        UPDATE folders child
           SET parent_id = parent.id
          FROM folders parent
         WHERE child.account_id = $1
           AND parent.account_id = $1
           AND parent.id <> child.id
           AND (child.path LIKE parent.path || '.%' OR child.path LIKE parent.path || '/%')
           AND length(child.path) - length(replace(child.path, '.', ''))
             = length(parent.path) - length(replace(parent.path, '.', '')) + 1
        `,
        [creds.id],
      );

      // Folders that vanished server-side. Their messages cascade away with
      // them, which is correct: the server is authoritative for what exists.
      await tx.query(
        `DELETE FROM folders WHERE account_id = $1 AND path <> ALL($2::text[])`,
        [creds.id, rows.map((r) => r.path)],
      );
    });

    return rows.length;
  });
}

/**
 * Refresh every folder aggregate in one scan, including empty folders.
 *
 * Group by each distinct label array first: this keeps the message scan single
 * pass, then expands the much smaller set of label combinations to build the
 * per-label map used by ordinary (non-search) facets.
 */
export async function refreshCounts(accountIds: string | readonly string[]): Promise<void> {
  const ids = typeof accountIds === 'string' ? [accountIds] : [...accountIds];
  if (!ids.length) return;
  await query(
    `
    WITH grouped AS MATERIALIZED (
      SELECT f2.id AS folder_id,
             coalesce(m.labels, '{}') AS labels,
             count(m.id)::int AS total,
             count(m.id) FILTER (WHERE NOT m.seen)::int AS unread,
             count(m.id) FILTER (WHERE m.flagged)::int AS flagged,
             count(m.id) FILTER (WHERE m.has_attachments)::int AS with_attachments
        FROM folders f2
        LEFT JOIN messages m ON m.folder_id = f2.id
       WHERE f2.account_id = ANY($1::uuid[])
       GROUP BY f2.id, m.labels
    ), totals AS (
      SELECT folder_id,
             sum(total)::int AS total,
             sum(unread)::int AS unread,
             sum(flagged)::int AS flagged,
             sum(with_attachments)::int AS with_attachments
        FROM grouped
       GROUP BY folder_id
    ), label_values AS (
      SELECT folder_id, label, sum(total)::int AS n
        FROM grouped
        CROSS JOIN LATERAL unnest(labels) AS label
       GROUP BY folder_id, label
    ), label_maps AS (
      SELECT folder_id, jsonb_object_agg(label, n) AS labels
        FROM label_values
       GROUP BY folder_id
    )
    UPDATE folders f
       SET unread = t.unread,
           total = t.total,
           facet_flagged = t.flagged,
           facet_with_attachments = t.with_attachments,
           facet_labels = coalesce(l.labels, '{}')
      FROM totals t
      LEFT JOIN label_maps l ON l.folder_id = t.folder_id
     WHERE f.id = t.folder_id
    `,
    [ids],
  );
}

/**
 * Read back what `refreshCounts` just wrote, per account and per folder.
 *
 * Both halves in one round trip because both are read together: the sidebar's
 * unified role rows sum folders while the account rows read the account total,
 * and a client that receives one without the other renders two numbers that
 * disagree about the same mail until the next pass.
 */
export async function countSnapshot(
  accountIds: string | readonly string[],
): Promise<{
  accounts: Record<string, { unread: number; total: number }>;
  folders: Record<string, { unread: number; total: number }>;
}> {
  const ids = typeof accountIds === 'string' ? [accountIds] : [...accountIds];
  const snapshot = { accounts: {}, folders: {} } as {
    accounts: Record<string, { unread: number; total: number }>;
    folders: Record<string, { unread: number; total: number }>;
  };
  if (!ids.length) return snapshot;

  const rows = await query<{
    account_id: string;
    folder_id: string;
    unread: number;
    total: number;
  }>(
    `SELECT account_id, id AS folder_id, unread, total
       FROM folders WHERE account_id = ANY($1::uuid[])`,
    [ids],
  );

  // Every requested account appears even with no folders yet, so a client that
  // just removed the last message in a never-synced mailbox still hears zero
  // rather than keeping the number it painted.
  for (const id of ids) snapshot.accounts[id] = { unread: 0, total: 0 };
  for (const r of rows) {
    snapshot.folders[r.folder_id] = { unread: r.unread, total: r.total };
    const account = snapshot.accounts[r.account_id];
    if (!account) continue;
    account.unread += r.unread;
    account.total += r.total;
  }
  return snapshot;
}

/** `countSnapshot` straight onto the event bus. The one thing every caller of
 *  `refreshCounts` does next, so it lives here rather than in three places. */
export async function publishCounts(
  userId: string,
  accountIds: string | readonly string[],
): Promise<void> {
  const snapshot = await countSnapshot(accountIds);
  publish(userId, { type: 'counts', ...snapshot });
}
