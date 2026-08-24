/**
 * Message read and mutate endpoints.
 *
 * `/messages/query` is POST rather than GET because the ListQuery object is
 * well past a sane URL length once filters and a saved view are involved. It
 * is a read; the verb is a transport detail.
 */

import type { FastifyInstance } from 'fastify';
import { one, query, transaction } from '../../db/index.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import type {
  Addr,
  Attachment,
  ListQuery,
  Message,
  MessageAction,
  MessageSummary,
  Priority,
  Thread,
} from '../../contract/types.ts';
import { listMessages } from './query.ts';
import { publish } from '../events/bus.ts';
import { refreshCounts, publishCounts } from '../../sync/folders.ts';
import { refreshThreads } from '../../sync/threads.ts';
import { syncNow } from '../../sync/engine.ts';
import { ensureBody, fetchAttachment, type CachedBody } from '../../sync/bodies.ts';
import { toPreview } from '../../sync/parse.ts';

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // A POST that reads. The verb is a transport detail, so the scope is declared
  // rather than inferred — an agent with only `read` must be able to search.
  app.post<{ Body: ListQuery }>('/messages/query', { config: { scope: 'read' } }, async (req) => {
    const q = req.body;
    if (!q?.scope) throw badRequest('scope is required');
    return listMessages({ userId: req.userId, q });
  });

  app.get<{ Params: { id: string } }>('/messages/:id', async (req) => {
    const row = await one<MessageRow>(FULL_MESSAGE_SQL, [req.userId, req.params.id]);
    if (!row) throw notFound('Message');

    // Cache miss goes to IMAP now, on the request. The alternative — return the
    // envelope and let the client poll — means the reader paints an empty
    // message first, and an empty message is indistinguishable from a broken one.
    const body = row.body_html === null && row.body_text === null
      ? await ensureBody(req.userId, req.params.id)
      : null;

    return toMessage(row, body);
  });

  /** An attachment's bytes. Streamed straight through; nothing is stored. */
  app.get<{ Params: { id: string; part: string } }>(
    '/messages/:id/attachments/:part',
    async (req, reply) => {
      const file = await fetchAttachment(req.userId, req.params.id, req.params.part);
      return reply
        .header('content-type', file.mimeType)
        // `attachment` and not `inline`: the browser must never be asked to
        // render mail-supplied bytes on our own origin, whatever they claim to be.
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        )
        .header('content-length', file.content.length)
        .header('cache-control', 'private, max-age=300')
        // Belt and braces: the disposition header above is the rule, this stops a
        // sniffing browser from overriding it.
        .header('x-content-type-options', 'nosniff')
        .send(file.content);
    },
  );

  /**
   * A thread, from the local index.
   *
   * No IMAP: threading is resolved at index time into `thread_id`, so this is
   * the same data the list already serves, ordered oldest-first because that is
   * how a conversation reads.
   */
  app.get<{ Params: { id: string } }>('/threads/:id', async (req) => {
    const rows = await query<MessageRow>(
      `
      SELECT m.*, b.body_html, b.body_text, b.headers, b.attachments, b.has_blocked_remote
        FROM messages m
        JOIN accounts a ON a.id = m.account_id
        LEFT JOIN message_bodies b ON b.message_id = m.id
       WHERE a.user_id = $1 AND m.thread_id = $2
       ORDER BY m.date ASC, m.id ASC
      `,
      [req.userId, req.params.id],
    );
    const first = rows[0];
    if (!first) throw notFound('Thread');

    // Cached bodies only. A thread of twenty messages must not become twenty
    // IMAP fetches on one request; the reader loads a body when an item is
    // actually expanded.
    const messages = rows.map((r) => toMessage(r));
    const seen = new Set<string>();
    return {
      id: req.params.id,
      subject: first.subject,
      messages,
      participants: messages
        .map((m) => m.from)
        .filter((p) => (seen.has(p.address) ? false : (seen.add(p.address), true))),
      lastDate: messages.at(-1)!.date,
      unread: messages.filter((m) => !m.seen).length,
    } satisfies Thread;
  });

  app.post<{ Body: { ids: string[]; action: MessageAction } }>(
    '/messages/actions',
    async (req, reply) => {
      const { ids, action } = req.body;
      if (!ids?.length) throw badRequest('ids is required');

      const affected = await transaction(async (tx) => {
        // Ownership check and mutation in one statement — a separate check
        // would be a TOCTOU gap.
        //
        // The folder path and UID are read here, *before* the local mutation,
        // and travel into the queued op. Replay cannot look them up afterwards:
        // a move has already changed `folder_id`, so resolving the source later
        // reads back the destination, and a permanent delete leaves no row to
        // read at all. See sync/replay.ts.
        const owned = await tx.query<{
           id: string;
           account_id: string;
           thread_id: string;
           uid: number;
          path: string;
        }>(
           `SELECT m.id, m.account_id, m.thread_id, m.uid, f.path
             FROM messages m
             JOIN accounts a ON a.id = m.account_id
             JOIN folders f ON f.id = m.folder_id
            WHERE a.user_id = $1 AND m.id = ANY($2::uuid[])`,
          [req.userId, ids],
        );
        const ownedIds = owned.rows.map((r) => r.id);
        if (!ownedIds.length) throw notFound('Messages');
        const affectedAccounts = [...new Set(owned.rows.map((r) => r.account_id))];

        switch (action.type) {
          case 'flag': {
            const sets: string[] = [];
            for (const f of action.add) {
              if (f === 'seen') sets.push('seen = true');
              if (f === 'flagged') sets.push('flagged = true');
              if (f === 'answered') sets.push('answered = true');
            }
            for (const f of action.remove) {
              if (f === 'seen') sets.push('seen = false');
              if (f === 'flagged') sets.push('flagged = false');
            }
            if (sets.length) {
              await tx.query(
                `UPDATE messages SET ${sets.join(', ')} WHERE id = ANY($1::uuid[])`,
                [ownedIds],
              );
            }
            break;
          }
          case 'move': {
            // The destination has to belong to the same account as every
            // message being moved. Folder ids are per-account, so an unchecked
            // update files mail into a mailbox it does not live in and the next
            // sync cannot reconcile it. The UI only ever offers folders from the
            // right account; an agent working from ids has no such guardrail,
            // which is what makes the check worth its round trip.
            const target = await tx.query<{ account_id: string }>(
              `SELECT f.account_id FROM folders f JOIN accounts a ON a.id = f.account_id
                WHERE a.user_id = $1 AND f.id = $2`,
              [req.userId, action.folderId],
            );
            const destination = target.rows[0];
            if (!destination) throw notFound('Folder');
            const strays = owned.rows.filter((r) => r.account_id !== destination.account_id);
            if (strays.length) {
              throw badRequest(
                `${strays.length} of ${owned.rows.length} messages belong to a different account than that folder. Move within one account at a time.`,
              );
            }
            await tx.query('UPDATE messages SET folder_id = $2 WHERE id = ANY($1::uuid[])', [
              ownedIds,
              action.folderId,
            ]);
            break;
          }
          case 'delete':
            if (action.permanent) {
              await tx.query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [ownedIds]);
            } else {
              await tx.query(
                `UPDATE messages m
                    SET folder_id = t.id
                   FROM folders t
                  WHERE m.id = ANY($1::uuid[])
                    AND t.account_id = m.account_id
                    AND t.role = 'trash'`,
                [ownedIds],
              );
            }
            break;
          case 'label':
            await tx.query(
              `UPDATE messages
                  SET labels = (
                    SELECT coalesce(array_agg(DISTINCT l), '{}')
                      FROM unnest(labels || $2::text[]) l
                     WHERE l <> ALL($3::text[])
                  )
                WHERE id = ANY($1::uuid[])`,
              [ownedIds, action.add, action.remove],
            );
            break;
          case 'snooze':
            await tx.query('UPDATE messages SET snoozed_until = $2 WHERE id = ANY($1::uuid[])', [
              ownedIds,
              action.until,
            ]);
            break;
          case 'copy':
            break;
        }

        // Queue the same change for IMAP, in the same transaction as the local
        // write. The local index is authoritative for what the user sees; IMAP
        // catches up. See docs/architecture.md.
        // Labels and snooze are ours alone — the mail server is read-only
        // infrastructure and has no equivalent. Queueing them would mean writing
        // a row that replay only ever deletes unread.
        if (action.type !== 'label' && action.type !== 'snooze') {
          for (const accountId of affectedAccounts) {
            const mine = owned.rows.filter((r) => r.account_id === accountId);
            await tx.query(
              'INSERT INTO sync_ops (account_id, kind, payload) VALUES ($1, $2, $3)',
              [
                accountId,
                action.type,
                JSON.stringify({
                  ids: mine.map((r) => r.id),
                  targets: mine.map((r) => ({ path: r.path, uid: r.uid })),
                  action,
                }),
              ],
            );
          }
        }
        return {
          // The ids that were actually ours. The request's own list may name
          // messages belonging to someone else, and those must not appear in an
          // event telling every open tab to change a row.
          ids: ownedIds,
          accountIds: affectedAccounts,
          threadIds: [...new Set(owned.rows.map((r) => r.thread_id))],
        };
      });

      // Say what changed, not merely that something did.
      //
      // This used to publish an empty patch, which every other open tab
      // faithfully applied to nothing: a message marked read here stayed bold
      // over there until that tab happened to refetch. The patch is derivable
      // for the actions where it is the same for every row; `label` is not, so
      // it stays a bare notification and the other tab catches up on its next
      // read.
      if (action.type === 'delete') {
        publish(req.userId, { type: 'messages:deleted', ids: affected.ids });
      } else {
        publish(req.userId, {
          type: 'messages:changed',
          ids: affected.ids,
          patch: patchOf(action),
        });
      }

      // One aggregate refresh for every affected account. Re-reading message
      // ownership here was both an extra query and wrong after a permanent
      // delete, because those rows no longer existed to identify their account.
      if (['flag', 'move', 'delete', 'label'].includes(action.type)) {
        await refreshCounts(affected.accountIds);
        // And tell the clients. Without this the sidebar's unread numbers were
        // correct in the database and stale on screen until the next sync pass
        // — up to a full interval of watching a count that no longer matched
        // the list beside it.
        await publishCounts(req.userId, affected.accountIds);
      }
      if (['flag', 'move', 'delete'].includes(action.type)) {
        await refreshThreads(req.userId, affected.threadIds);
      }

      // Nudge the queue rather than waiting for the poll.
      //
      // The local index is authoritative for what the user sees, so the response
      // has already gone back and the UI has already repainted — but leaving the
      // op to sit for up to a full sync interval means a message moved here is
      // still in the inbox on your phone two minutes later. `syncNow` claims
      // through the same advisory lock, so a burst of actions collapses into one
      // pass instead of stacking up.
      if (action.type !== 'label' && action.type !== 'snooze') {
        for (const accountId of affected.accountIds) syncNow(req.userId, accountId);
      }

      return reply.code(204).send();
    },
  );
}

/**
 * The part of a row an action changes, when it changes the same thing on all of
 * them.
 *
 * `label` is deliberately absent: add/remove are uniform but the resulting
 * array is not, so there is no single patch to send and inventing one would be
 * worse than sending none.
 */
function patchOf(action: MessageAction): Partial<MessageSummary> {
  if (action.type === 'flag') {
    const patch: Partial<MessageSummary> = {};
    for (const f of action.add) {
      if (f === 'seen') patch.seen = true;
      if (f === 'flagged') patch.flagged = true;
      if (f === 'answered') patch.answered = true;
    }
    for (const f of action.remove) {
      if (f === 'seen') patch.seen = false;
      if (f === 'flagged') patch.flagged = false;
    }
    return patch;
  }
  if (action.type === 'move') return { folderId: action.folderId };
  return {};
}

/* ── Row → contract ─────────────────────────────────────────────────────────
   The list has its own mapper in query.ts because it returns MessageSummary and
   never touches the body join. This one is the full Message. Both exist so that
   no route can accidentally hand a raw database row to a client: column names
   are snake_case, dates are Date objects, and `bcc`/`replyTo` have no columns at
   all — a row is simply not a Message, and shipping one crashes the reader. */

const FULL_MESSAGE_SQL = `
  SELECT m.*, b.body_html, b.body_text, b.headers, b.attachments, b.has_blocked_remote
    FROM messages m
    JOIN accounts a ON a.id = m.account_id
    LEFT JOIN message_bodies b ON b.message_id = m.id
   WHERE a.user_id = $1 AND m.id = $2
`;

interface MessageRow {
  id: string;
  account_id: string;
  folder_id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_: string[];
  from_name: string | null;
  from_address: string;
  to_addrs: Addr[];
  cc_addrs: Addr[];
  subject: string;
  preview: string;
  date: Date;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft_flag: boolean;
  has_attachments: boolean;
  attachment_count: number;
  size: number;
  labels: string[];
  priority: Priority;
  body_html: string | null;
  body_text: string | null;
  headers: Record<string, string> | null;
  attachments: Attachment[] | null;
  has_blocked_remote: boolean | null;
}

/** `fetched` is a body that was just read from IMAP and is not yet reflected in
 *  the row we already have in hand. */
function toMessage(r: MessageRow, fetched: CachedBody | null = null): Message {
  return {
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    threadId: r.thread_id,
    messageId: r.message_id ?? '',
    from: { name: r.from_name, address: r.from_address },
    to: r.to_addrs ?? [],
    cc: r.cc_addrs ?? [],
    // Neither is indexed — nothing queries them — so both come off the parsed
    // body's headers, which means they are populated exactly when a body is.
    bcc: parseAddrHeader(fetched?.headers ?? r.headers, 'bcc'),
    replyTo: parseAddrHeader(fetched?.headers ?? r.headers, 'reply-to'),
    subject: r.subject,
    // Old index rows may predate HTML sniffing. Keep every reader/thread path
    // on the same plain-text preview contract as the list query.
    preview: toPreview(r.preview, false),
    date: r.date.toISOString(),
    seen: r.seen,
    flagged: r.flagged,
    answered: r.answered,
    draft: r.draft_flag,
    hasAttachments: r.has_attachments,
    attachmentCount: r.attachment_count,
    // The single-message view is not a list row, so there is no thread collapse
    // to report here.
    threadCount: 1,
    size: r.size,
    labels: r.labels,
    priority: r.priority,
    bodyHtml: fetched?.bodyHtml ?? r.body_html,
    bodyText: fetched?.bodyText ?? r.body_text,
    attachments: fetched?.attachments ?? r.attachments ?? [],
    headers: fetched?.headers ?? r.headers ?? {},
    inReplyTo: r.in_reply_to,
    references: r.references_ ?? [],
    hasBlockedRemoteContent: fetched?.hasBlockedRemote ?? r.has_blocked_remote ?? false,
    bodyError: fetched?.error ?? null,
  };
}

/**
 * Addresses out of a raw header line.
 *
 * Deliberately forgiving and deliberately small: this runs on headers we already
 * parsed and stored, and the only consumers are the reader's Bcc line and the
 * composer's reply-to default. Anything it cannot read becomes an address with
 * no display name, which is what the UI would show anyway.
 */
function parseAddrHeader(headers: Record<string, string> | null, key: string): Addr[] {
  const raw = headers?.[key];
  if (!raw) return [];
  const out: Addr[] = [];
  // Split on commas outside quotes, so `"Smith, John" <j@x>` stays one entry.
  for (const part of raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const angled = /<([^<>@\s]+@[^<>\s]+)>/.exec(part);
    const address = (angled?.[1] ?? /[^\s<>,]+@[^\s<>,]+/.exec(part)?.[0])?.toLowerCase();
    if (!address) continue;
    const name = part.slice(0, angled ? part.indexOf('<') : part.length).trim().replace(/^"|"$/g, '');
    out.push({ name: name || null, address });
  }
  return out;
}
