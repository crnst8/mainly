/** Routes for folders, views, preferences, drafts, sync, and events. */

import type { FastifyInstance } from 'fastify';
import { one, query } from '../../db/index.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { withPreferenceDefaults } from '../../contract/types.ts';
import type { Draft, Folder, Preferences, SavedView, SyncState } from '../../contract/types.ts';
import { subscribe } from '../events/bus.ts';
import { syncNow } from '../../sync/engine.ts';
import { sendDraft, toDraft, type DraftRow } from '../../smtp/send.ts';
import { createFolder } from '../../sync/mailboxes.ts';

/* ── Folders ─────────────────────────────────────────────────────────────── */

interface FolderRow {
  id: string;
  account_id: string;
  path: string;
  name: string;
  role: Folder['role'];
  parent_id: string | null;
  depth: number;
  unread: number;
  total: number;
  color: string | null;
  pinned: boolean;
  subscribed: boolean;
  position: number;
}

const FOLDER_COLUMNS = `
  f.id, f.account_id, f.path, f.name, f.role, f.parent_id, f.depth,
  f.unread, f.total, f.color, f.pinned, f.subscribed, f.position
`;

const toFolder = (r: FolderRow): Folder => ({
  id: r.id,
  accountId: r.account_id,
  path: r.path,
  name: r.name,
  role: r.role,
  parentId: r.parent_id,
  depth: r.depth,
  unread: r.unread,
  total: r.total,
  color: r.color,
  pinned: r.pinned,
  subscribed: r.subscribed,
  position: r.position,
});

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { accountId?: string } }>('/folders', async (req) => {
    const rows = await query<FolderRow>(
      `SELECT ${FOLDER_COLUMNS} FROM folders f JOIN accounts a ON a.id = f.account_id
        WHERE a.user_id = $1 AND ($2::uuid IS NULL OR f.account_id = $2::uuid)
        ORDER BY a.position, f.position`,
      [req.userId, req.query.accountId ?? null],
    );
    return rows.map(toFolder);
  });

  /** Create a user-requested IMAP folder; see AGENTS.md §1. */
  app.post<{ Body: { accountId: string; name: string; parentId?: string | null } }>(
    '/folders',
    async (req, reply) => {
      const { id } = await createFolder(req.userId, {
        accountId: req.body?.accountId,
        name: req.body?.name,
        parentId: req.body?.parentId ?? null,
      });
      const row = await one<FolderRow>(
        `SELECT ${FOLDER_COLUMNS} FROM folders f JOIN accounts a ON a.id = f.account_id
          WHERE a.user_id = $1 AND f.id = $2`,
        [req.userId, id],
      );
      return reply.code(201).send(toFolder(row!));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<Folder> }>('/folders/:id', async (req) => {
    const p = req.body;
    const sets: string[] = [];
    const values: unknown[] = [req.userId, req.params.id];
    const bind = (v: unknown) => `$${values.push(v)}`;
    if (p.color !== undefined) sets.push(`color = ${bind(p.color)}`);
    if (p.pinned !== undefined) sets.push(`pinned = ${bind(p.pinned)}`);
    if (p.position !== undefined) sets.push(`position = ${bind(p.position)}`);
    if (!sets.length) throw badRequest('Nothing to update');

    const row = await one<FolderRow>(
      `UPDATE folders f SET ${sets.join(', ')}
         FROM accounts a
        WHERE a.id = f.account_id AND a.user_id = $1 AND f.id = $2
        RETURNING ${FOLDER_COLUMNS}`,
      values,
    );
    if (!row) throw notFound('Folder');
    return toFolder(row);
  });
}

/* ── Saved views ─────────────────────────────────────────────────────────── */

export async function viewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/views', async (req) => {
    const rows = await query<Record<string, unknown>>(
      'SELECT * FROM saved_views WHERE user_id = $1 ORDER BY position',
      [req.userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      glyph: r.glyph,
      color: r.color,
      query: r.query,
      pinned: r.pinned,
      position: r.position,
    }));
  });

  app.post<{ Body: Partial<SavedView> }>('/views', async (req, reply) => {
    const v = req.body;
    if (!v.name || !v.query) throw badRequest('name and query are required');
    const row = await one(
      `INSERT INTO saved_views (user_id, name, glyph, color, query, pinned, position)
       VALUES ($1, $2, $3, $4, $5, $6,
               (SELECT coalesce(max(position) + 1, 0) FROM saved_views WHERE user_id = $1))
       RETURNING *`,
      [req.userId, v.name, v.glyph ?? '•', v.color ?? null, JSON.stringify(v.query), v.pinned ?? true],
    );
    return reply.code(201).send(row);
  });

  app.delete<{ Params: { id: string } }>('/views/:id', async (req, reply) => {
    await query('DELETE FROM saved_views WHERE user_id = $1 AND id = $2', [
      req.userId,
      req.params.id,
    ]);
    return reply.code(204).send();
  });
}

/* ── Preferences ─────────────────────────────────────────────────────────── */

export async function preferenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/preferences', async (req) => {
    const row = await one<{ data: Partial<Preferences> }>(
      'SELECT data FROM preferences WHERE user_id = $1',
      [req.userId],
    );
    // Always return a complete object. A user who has never opened settings
    // has an empty row, and the client should not have to know that.
    return withPreferenceDefaults(row?.data);
  });

  app.put<{ Body: Preferences }>('/preferences', async (req) => {
    // Stored as one JSONB blob: preferences are read whole, written whole, and
    // never queried by field. A column per setting would be churn for nothing.
    const row = await one<{ data: Preferences }>(
      `INSERT INTO preferences (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data
       RETURNING data`,
      [req.userId, JSON.stringify(req.body)],
    );
    return row!.data;
  });
}

/* ── Sync ────────────────────────────────────────────────────────────────── */

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sync', async (req): Promise<SyncState> => {
    const rows = await query<{
      id: string;
      status: string;
      last_sync_at: Date | null;
      error: string | null;
      }>('SELECT id, status, last_sync_at, error FROM accounts WHERE user_id = $1', [req.userId]);
    const bodyRows = await query<{ indexed: number; total: number }>(
      `SELECT count(*) FILTER (WHERE m.body_indexed_at IS NOT NULL)::int AS indexed,
              count(*)::int AS total
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
        WHERE a.user_id = $1`,
      [req.userId],
    );

    const state: SyncState = {
      accounts: {},
      busy: false,
      bodySearch: bodyRows[0] ?? { indexed: 0, total: 0 },
    };
    for (const r of rows) {
      state.accounts[r.id] = {
        status: r.status as SyncState['accounts'][string]['status'],
        progress: null,
        step: null,
        lastSyncAt: r.last_sync_at?.toISOString() ?? null,
        error: r.error,
      };
      if (r.status === 'syncing') state.busy = true;
    }
    return state;
  });

  app.post<{ Body: { accountId?: string } }>('/sync', async (req, reply) => {
    syncNow(req.userId, req.body?.accountId);
    // 202: the work is queued, not done. The client watches /events.
    return reply.code(202).send();
  });
}

/* ── SSE ─────────────────────────────────────────────────────────────────── */

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx buffers proxied responses by default, which would hold every
      // event until the buffer fills. This is the header that stops it.
      'x-accel-buffering': 'no',
    });

    const send = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribe = subscribe(req.userId, send);
    // Comment frames keep intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Keep the handler open; the socket is managed above.
    return reply;
  });
}

/* ── Drafts ──────────────────────────────────────────────────────────────── */

const DRAFT_COLUMNS = `
  id, account_id, to_addrs, cc_addrs, bcc_addrs, subject, body_text, body_html,
  in_reply_to::text, forward_of::text, attachments, send_at, updated_at
`;

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  app.get('/drafts', async (req) => {
    const rows = await query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM drafts WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.userId],
    );
    return rows.map(toDraft);
  });

  app.post<{ Body: Partial<Draft> }>('/drafts', async (req, reply) => {
    const d = req.body;
    if (!d.accountId) throw badRequest('accountId is required');
    // Ownership of the account is checked by the insert itself: the subquery
    // yields no row for someone else's account, so the INSERT affects nothing
    // rather than filing a draft against a mailbox the caller cannot see.
    const row = await one<DraftRow>(
      `INSERT INTO drafts (user_id, account_id, to_addrs, cc_addrs, bcc_addrs,
                           subject, body_text, body_html, in_reply_to, forward_of,
                           attachments, send_at)
       SELECT $1, a.id, $3, $4, $5, $6, $7, $8, $9::uuid, $10::uuid, $11, $12
         FROM accounts a WHERE a.id = $2 AND a.user_id = $1
       RETURNING ${DRAFT_COLUMNS}`,
      [
        req.userId,
        d.accountId,
        JSON.stringify(d.to ?? []),
        JSON.stringify(d.cc ?? []),
        JSON.stringify(d.bcc ?? []),
        d.subject ?? '',
        d.bodyText ?? '',
        d.bodyHtml ?? null,
        d.inReplyTo ?? null,
        d.forwardOf ?? null,
        JSON.stringify(d.attachments ?? []),
        d.sendAt ?? null,
      ],
    );
    if (!row) throw notFound('Account');
    return reply.code(201).send(toDraft(row));
  });

  app.patch<{ Params: { id: string }; Body: Partial<Draft> }>('/drafts/:id', async (req) => {
    const d = req.body;
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [req.userId, req.params.id];
    const bind = (v: unknown) => `$${values.push(v)}`;

    // Explicit allow-list, as everywhere else a client hands us a patch: a
    // generic loop here would let a caller move a draft to another user.
    if (d.accountId !== undefined) sets.push(`account_id = ${bind(d.accountId)}::uuid`);
    if (d.to !== undefined) sets.push(`to_addrs = ${bind(JSON.stringify(d.to))}`);
    if (d.cc !== undefined) sets.push(`cc_addrs = ${bind(JSON.stringify(d.cc))}`);
    if (d.bcc !== undefined) sets.push(`bcc_addrs = ${bind(JSON.stringify(d.bcc))}`);
    if (d.subject !== undefined) sets.push(`subject = ${bind(d.subject)}`);
    if (d.bodyText !== undefined) sets.push(`body_text = ${bind(d.bodyText)}`);
    if (d.bodyHtml !== undefined) sets.push(`body_html = ${bind(d.bodyHtml)}`);
    if (d.attachments !== undefined)
      sets.push(`attachments = ${bind(JSON.stringify(d.attachments))}`);
    if (d.sendAt !== undefined) sets.push(`send_at = ${bind(d.sendAt)}`);

    const row = await one<DraftRow>(
      `UPDATE drafts SET ${sets.join(', ')}
        WHERE user_id = $1 AND id = $2
        RETURNING ${DRAFT_COLUMNS}`,
      values,
    );
    if (!row) throw notFound('Draft');
    return toDraft(row);
  });

  app.delete<{ Params: { id: string } }>('/drafts/:id', async (req, reply) => {
    const gone = await one<{ id: string }>(
      'DELETE FROM drafts WHERE user_id = $1 AND id = $2 RETURNING id',
      [req.userId, req.params.id],
    );
    if (!gone) throw notFound('Draft');
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/drafts/:id/send', async (req) => {
    const result = await sendDraft(req.userId, req.params.id);
    // The Sent copy is now on the server but not in the index until the next
    // pass. Nudging sync means it shows up in Sent within seconds rather than
    // within the poll interval.
    syncNow(req.userId);
    return result;
  });
}
