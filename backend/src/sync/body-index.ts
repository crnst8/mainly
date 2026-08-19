/**
 * Bounded body-search backfill.
 *
 * New mail is indexed during the normal preview fetch. This pass handles older
 * rows without making a large mailbox's sync loop unbounded: recent messages are
 * selected first and at most BATCH rows are attempted per account pass.
 */

import type { ImapFlow } from 'imapflow';
import { query } from '../db/index.ts';
import {
  fetchTextParts,
  PREVIEW_MAX_BYTES,
  type TextPartTarget,
} from './envelopes.ts';
import { htmlToText, previewPart, type BodyNode } from './parse.ts';
import { withConnection, type AccountCredentials } from './pool.ts';

const BATCH = 200;

interface PendingRow {
  id: string;
  uid: number;
  path: string;
}

interface PartRow extends PendingRow {
  part: string | null;
  encoding: string | null;
  charset: string | null;
  is_html: boolean;
}

/** Index a bounded batch of one account's pending message bodies. */
export async function indexPendingBodies(
  creds: AccountCredentials,
  accountId: string = creds.id,
): Promise<number> {
  return withConnection(creds, async (client) => {
    const pending = await query<PendingRow>(
      `SELECT m.id, m.uid, f.path
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
        WHERE m.account_id = $1 AND m.body_indexed_at IS NULL
        ORDER BY m.date DESC, m.id DESC
        LIMIT $2`,
      [accountId, BATCH],
    );
    if (!pending.length) return 0;

    const indexed = await indexRows(client, pending);
    return indexed;
  });
}

async function indexRows(client: ImapFlow, pending: PendingRow[]): Promise<number> {
  const byFolder = new Map<string, PendingRow[]>();
  for (const row of pending) {
    const rows = byFolder.get(row.path);
    if (rows) rows.push(row);
    else byFolder.set(row.path, [row]);
  }

  const parts: PartRow[] = [];
  for (const [path, rows] of byFolder) {
    await client.mailboxOpen(path, { readOnly: true });
    const byUid = new Map(rows.map((row) => [row.uid, row]));
    try {
      for await (const msg of client.fetch(
        rows.map((row) => row.uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      )) {
        const row = byUid.get(msg.uid);
        if (!row) continue;
        const found = previewPart(msg.bodyStructure as BodyNode | undefined);
        const readable = found && (found.node.size ?? 0) <= PREVIEW_MAX_BYTES ? found : null;
        parts.push({
          ...row,
          part: readable?.part ?? null,
          encoding: readable?.node.encoding ?? null,
          charset: readable?.node.parameters?.charset ?? null,
          is_html: readable?.node.type === 'text/html',
        });
      }
    } catch (err) {
      console.warn({ folder: path, err: (err as Error).message }, 'body-index structure fetch failed');
    }
    for (const row of rows) {
      if (!parts.some((part) => part.id === row.id)) {
        parts.push({ ...row, part: null, encoding: null, charset: null, is_html: false });
      }
    }
  }

  const targets: TextPartTarget[] = parts.flatMap((row) =>
    row.part
      ? [{ uid: row.uid, part: row.part, encoding: row.encoding ?? undefined, charset: row.charset ?? undefined }]
      : [],
  );
  const rawText = new Map<string, string>();
  for (const [path, rows] of byPath(parts)) {
    await client.mailboxOpen(path, { readOnly: true });
    const uids = new Set(rows.map((row) => row.uid));
    const folderTargets = targets.filter((target) => uids.has(target.uid));
    const fetched = await fetchTextParts(client, folderTargets);
    for (const [uid, text] of fetched) rawText.set(`${path}:${uid}`, text);
  }

  const payload = parts.map((row) => ({
    id: row.id,
    body_text: rawText.has(`${row.path}:${row.uid}`)
      ? row.is_html
        ? htmlToText(rawText.get(`${row.path}:${row.uid}`)!)
        : rawText.get(`${row.path}:${row.uid}`)
      : null,
  }));

  const updated = await query<{ id: string }>(
    `UPDATE messages m
        SET body_search = CASE WHEN r.body_text IS NULL THEN NULL
                               ELSE setweight(to_tsvector('english', left(r.body_text, 100000)), 'D') END,
            body_indexed_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, body_text text)
      WHERE m.id = r.id AND m.body_indexed_at IS NULL
      RETURNING m.id`,
    [JSON.stringify(payload)],
  );
  return updated.length;
}

function byPath(rows: PartRow[]): Map<string, PartRow[]> {
  const out = new Map<string, PartRow[]>();
  for (const row of rows) {
    const list = out.get(row.path);
    if (list) list.push(row);
    else out.set(row.path, [row]);
  }
  return out;
}
