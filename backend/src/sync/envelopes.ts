/**
 * The envelope pass. IMAP → the `messages` index.
 *
 * This is the piece that makes the product exist: every list query, facet,
 * count and search reads rows this file wrote. Specified in
 * docs/architecture.md.
 *
 * Three things about the shape of the code are load-bearing:
 *
 * 1. **UID windows, not one big fetch.** imapflow's `fetch()` is an async
 *    generator and no IMAP command may run while it is being consumed, so a
 *    design that fetches everything and upserts inside the loop deadlocks the
 *    moment it needs a second command. Buffering the whole folder instead would
 *    make memory a function of mailbox size. Windowing the UID range gives
 *    bounded memory and a place to run the preview fetch between windows.
 *
 * 2. **Batch upsert through `jsonb_to_recordset`.** One statement per 500
 *    messages. Row-at-a-time is roughly 50× slower, which is the difference
 *    between a first sync of a real mailbox taking half a minute and taking half
 *    an hour.
 *
 * 3. **Local flag state is not clobbered while a change is in flight.** The
 *    server is authoritative for flags, but only once it has heard from us.
 *    Rows with an unreplayed `sync_ops` flag change keep what the user did — the
 *    alternative is an unread count that flickers back for one poll interval
 *    every time you mark something read.
 */

import type { ImapFlow } from 'imapflow';
import { query, transaction } from '../db/index.ts';
import { config } from '../config.ts';
import type { Priority } from '../contract/types.ts';
import {
  countAttachments,
  decodePart,
  firstAddr,
  htmlToText,
  normaliseSubject,
  cleanId,
  parseReferences,
  previewPart,
  readFlags,
  toAddrs,
  toPreview,
  type BodyNode,
} from './parse.ts';
import { assignThreads, type Threadable } from './threading.ts';
import { withConnection, type AccountCredentials } from './pool.ts';

/** UIDs fetched per round trip. Bounds memory without making the folder pass
 *  chatty: a 12,000-message mailbox is twelve windows, not twelve thousand. */
const WINDOW = 1000;
/** Rows per INSERT. Past a few hundred the win flattens and the statement gets
 *  long enough to matter to the parser. */
const BATCH = 500;
/** Text parts larger than this are not read for a 200-character preview. */
export const PREVIEW_MAX_BYTES = 256 * 1024;
/** Avoid indexing quoted megabyte-sized text parts and keep tsvector input bounded. */
const BODY_INDEX_MAX_CHARS = 100_000;

export interface EnvelopeSyncResult {
  indexed: number;
  updated: number;
  removed: number;
}

export type StepReporter = (step: string, progress: number | null) => void;

interface FolderRow {
  id: string;
  path: string;
  name: string;
  role: string;
  uidvalidity: number | null;
  uidnext: number | null;
  highest_modseq: number | null;
}

/** One message, ready to become a row. */
interface Indexed extends Threadable {
  uid: number;
  fromName: string | null;
  fromAddress: string;
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  subject: string;
  preview: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  size: number;
  attachmentCount: number;
  previewPart: string | null;
  previewIsHtml: boolean;
  previewEncoding: string | undefined;
  previewCharset: string | undefined;
  bodyText: string | null;
}

/* ── Entry point ───────────────────────────────────────────────────────────── */

export async function syncEnvelopes(
  creds: AccountCredentials,
  userId: string,
  priority: Priority,
  opts: { folderPaths?: string[]; onStep?: StepReporter } = {},
): Promise<EnvelopeSyncResult> {
  const folders = await query<FolderRow>(
    `SELECT id, path, name, role, uidvalidity, uidnext, highest_modseq
       FROM folders
      WHERE account_id = $1
        AND subscribed
        AND ($2::text[] IS NULL OR path = ANY($2::text[]))
      -- Inbox first, then the fixed roles, then everything else. A first sync
      -- that fills the inbox in five seconds feels finished even while the
      -- archive is still going.
      ORDER BY position`,
    [creds.id, opts.folderPaths ?? null],
  );

  const total: EnvelopeSyncResult = { indexed: 0, updated: 0, removed: 0 };
  if (!folders.length) return total;

  return withConnection(creds, async (client) => {
    for (const [i, folder] of folders.entries()) {
      const step: StepReporter = (text, p) =>
        // Folder-local progress, scaled into this account's share of the pass.
        opts.onStep?.(text, (i + (p ?? 0)) / folders.length);

      try {
        const result = await syncFolder(client, userId, creds.id, priority, folder, step);
        total.indexed += result.indexed;
        total.updated += result.updated;
        total.removed += result.removed;
      } catch (err) {
        // One unreadable folder must not cost the account its other 20. A
        // mailbox can disappear between the folder pass and this one, and
        // ACL-restricted shared folders are selectable-but-not-readable.
        const message = (err as Error).message;
        if (/no.?such|not found|nonexistent|permission|denied/i.test(message)) {
          console.warn({ folder: folder.path, err: message }, 'skipping unreadable folder');
          continue;
        }
        throw err;
      }
    }
    return total;
  });
}

/* ── One folder ────────────────────────────────────────────────────────────── */

async function syncFolder(
  client: ImapFlow,
  userId: string,
  accountId: string,
  priority: Priority,
  folder: FolderRow,
  step: StepReporter,
): Promise<EnvelopeSyncResult> {
  const result: EnvelopeSyncResult = { indexed: 0, updated: 0, removed: 0 };

  const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
  const uidValidity = Number(mailbox.uidValidity);
  const serverUidNext = Number(mailbox.uidNext ?? 0);
  const serverModseq = mailbox.highestModseq ? Number(mailbox.highestModseq) : null;
  const exists = mailbox.exists ?? 0;

  // UIDVALIDITY changed: every UID we hold now names a different message, or no
  // message at all. There is no partial recovery from this and pretending
  // otherwise corrupts the index silently, so the folder is re-indexed. Logged
  // loudly because on Maildir it almost always means the directory was moved.
  let fromUid = 1;
  if (folder.uidvalidity !== null && folder.uidvalidity !== uidValidity) {
    console.warn(
      { folder: folder.path, was: folder.uidvalidity, now: uidValidity },
      'UIDVALIDITY changed — re-indexing folder from scratch',
    );
    const dropped = await query<{ id: string }>(
      'DELETE FROM messages WHERE folder_id = $1 RETURNING id',
      [folder.id],
    );
    result.removed += dropped.length;
    await query(
      'UPDATE folders SET uidvalidity = NULL, uidnext = NULL, highest_modseq = NULL WHERE id = $1',
      [folder.id],
    );
  } else if (folder.uidvalidity === uidValidity && folder.uidnext) {
    fromUid = folder.uidnext;
  }

  /* ── New mail ───────────────────────────────────────────────────────────── */

  if (exists > 0 && (serverUidNext === 0 || fromUid < serverUidNext)) {
    // When the server reports no UIDNEXT (rare, but legal) fall back to a single
    // open-ended window; otherwise walk fixed windows so memory stays flat.
    const ceiling = serverUidNext > 0 ? serverUidNext : fromUid + WINDOW;
    for (let start = fromUid; start < ceiling; start += WINDOW) {
      const end = Math.min(start + WINDOW - 1, ceiling - 1);
      const batch = await fetchEnvelopes(client, start, end, folder);
      if (!batch.length) continue;

      await fillPreviews(client, batch);
      for (let i = 0; i < batch.length; i += BATCH) {
        const slice = batch.slice(i, i + BATCH);
        result.indexed += await upsert(userId, accountId, folder.id, priority, slice);
      }
      step(
        `Indexing ${folder.name} ${result.indexed.toLocaleString()}`,
        serverUidNext > fromUid ? (end - fromUid + 1) / (serverUidNext - fromUid) : null,
      );
    }
  }

  /* ── Flags ──────────────────────────────────────────────────────────────── */

  const condstore = client.capabilities?.has('CONDSTORE') ?? false;
  const useDelta = condstore && folder.highest_modseq !== null && folder.uidvalidity === uidValidity;

  // The delta path reports only what changed, so it cannot also serve as the
  // "what still exists" census. The full scan does both.
  const serverUids = new Set<number>();
  const flagUpdates: { uid: number; seen: boolean; flagged: boolean; answered: boolean }[] = [];

  if (exists > 0) {
    for await (const msg of client.fetch(
      '1:*',
      { uid: true, flags: true },
      useDelta
        ? { uid: true, changedSince: BigInt(folder.highest_modseq!) }
        : { uid: true },
    )) {
      const f = readFlags(msg.flags);
      if (!useDelta) serverUids.add(msg.uid);
      flagUpdates.push({ uid: msg.uid, seen: f.seen, flagged: f.flagged, answered: f.answered });
    }
  }

  if (flagUpdates.length) {
    for (let i = 0; i < flagUpdates.length; i += BATCH) {
      result.updated += await applyFlags(folder.id, flagUpdates.slice(i, i + BATCH));
    }
  }

  /* ── Vanished ───────────────────────────────────────────────────────────── */

  // A count mismatch is the trigger. Any deletion produces one, because the new
  // mail above has already been added on both sides, so the counts agree unless
  // something left. This is cheaper than a census on every pass and never misses
  // a deletion: a mismatch always leads to the full reconciliation below.
  const local = await query<{ n: number }>(
    'SELECT count(*)::int AS n FROM messages WHERE folder_id = $1',
    [folder.id],
  );
  const localCount = local[0]?.n ?? 0;

  if (localCount !== exists) {
    let census: Set<number> | null = serverUids;
    if (useDelta || !census.size) {
      // QRESYNC's VANISHED response is authoritative but only available in a
      // resynchronising SELECT; a SEARCH ALL is one round trip and works on
      // every server, which the fallback path has to.
      //
      // `search` answers `false` rather than throwing when it cannot run.
      // Reading that as an empty mailbox would delete the folder's entire index,
      // so it means "no census this pass" and reconciliation waits for the next
      // one. Deletions are not urgent; deleting the user's index is permanent.
      const found = exists > 0 ? await client.search({ all: true }, { uid: true }) : [];
      census = found === false ? null : new Set(found);
    }

    if (census) {
      const gone = await query<{ id: string }>(
        `DELETE FROM messages
          WHERE folder_id = $1 AND uid <> ALL($2::bigint[])
          RETURNING id`,
        [folder.id, [...census]],
      );
      result.removed += gone.length;
      if (gone.length) {
        console.log({ folder: folder.path, removed: gone.length }, 'messages vanished server-side');
      }
    }
  }

  /* ── Cursors ────────────────────────────────────────────────────────────── */

  // The modseq recorded is the one read at SELECT, not one read now: anything
  // that changed while this pass ran has a higher value and is picked up next
  // time. Recording "now" instead is how a change gets skipped forever.
  await query(
    `UPDATE folders
        SET uidvalidity = $2, uidnext = $3, highest_modseq = $4, last_sync_at = now()
      WHERE id = $1`,
    [folder.id, uidValidity, serverUidNext || null, serverModseq],
  );

  return result;
}

/* ── Fetching ──────────────────────────────────────────────────────────────── */

/** A Date, a date string, or something unusable. Mail dates are user input as
 *  much as anything else on the wire. */
function toDate(value: Date | string | undefined | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchEnvelopes(
  client: ImapFlow,
  start: number,
  end: number,
  folder: FolderRow,
): Promise<Indexed[]> {
  const out: Indexed[] = [];

  for await (const msg of client.fetch(
    `${start}:${end}`,
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      size: true,
      internalDate: true,
      // ENVELOPE carries In-Reply-To but not References, and References is the
      // header that actually threads a conversation — In-Reply-To alone loses
      // the chain the moment one message in the middle is missing. One extra
      // header line per message is the cheapest correctness there is.
      headers: ['references'],
    },
    { uid: true },
  )) {
    // `N:*` ranges are inclusive of the last message even when N is past the
    // end, so a window that starts beyond UIDNEXT still yields one row. Filter
    // rather than trust the range.
    if (msg.uid < start || msg.uid > end) continue;

    const env = msg.envelope ?? {};
    const structure = msg.bodyStructure as BodyNode | undefined;
    const preview = previewPart(structure);
    const flags = readFlags(msg.flags);

    const subject = (env.subject ?? '').trim();
    const subjectNormalised = normaliseSubject(subject);
    const inReplyTo = cleanId(env.inReplyTo);
    const references = parseReferences(msg.headers?.toString('utf8'));

    const from = firstAddr(env.from);
    const to = toAddrs(env.to);
    const cc = toAddrs(env.cc);

    // A message with no Message-ID cannot be threaded by reference and cannot be
    // deduped across accounts, but it must still index. The synthesised id is
    // stable for this message in this folder, which is all threading needs.
    const messageId =
      cleanId(env.messageId) ?? `no-id.${folder.id}.${msg.uid}@local.invalid`;

    out.push({
      uid: msg.uid,
      messageId,
      inReplyTo,
      references,
      subject,
      subjectNormalised,
      isReply: !!inReplyTo || subjectNormalised !== subject,
      // The Date header is what the sender claims; internalDate is when this
      // server received it. Prefer the header — a thread reads by when it was
      // written — but a malformed one is common enough to need the fallback.
      date: toDate(env.date) ?? toDate(msg.internalDate) ?? new Date(),
      participants: [from.address, ...to.map((a) => a.address), ...cc.map((a) => a.address)].filter(
        Boolean,
      ),
      fromName: from.name,
      fromAddress: from.address,
      to,
      cc,
      preview: '',
      seen: flags.seen,
      flagged: flags.flagged,
      answered: flags.answered,
      draft: flags.draft,
      size: msg.size ?? 0,
      attachmentCount: countAttachments(structure),
      previewPart: preview && (preview.node.size ?? 0) <= PREVIEW_MAX_BYTES ? preview.part : null,
      previewIsHtml: preview?.node.type === 'text/html',
      previewEncoding: preview?.node.encoding,
      previewCharset: preview?.node.parameters?.charset,
      bodyText: null,
    });
  }

  return out;
}

/**
 * Read the first text part of each new message, for the list preview.
 *
 * A second round trip rather than part of the envelope fetch, because the part
 * number is not known until BODYSTRUCTURE has been parsed. Grouped by part
 * number so a folder of ordinary mail is one or two extra commands, not one per
 * message. Failures are not fatal: an empty preview is a cosmetic loss, and a
 * message that will not hand over its text still belongs in the index.
 */
async function fillPreviews(client: ImapFlow, batch: Indexed[]): Promise<void> {
  const text = await fetchTextParts(
    client,
    batch.flatMap((m) =>
      m.previewPart
        ? [{ uid: m.uid, part: m.previewPart, encoding: m.previewEncoding, charset: m.previewCharset }]
        : [],
    ),
  );
  for (const m of batch) {
    const raw = text.get(m.uid);
    if (raw === undefined) continue;
    const bodyText = m.previewIsHtml ? htmlToText(raw) : raw;
    m.bodyText = bodyText.slice(0, BODY_INDEX_MAX_CHARS);
    m.preview = toPreview(raw, m.previewIsHtml);
  }
}

export interface TextPartTarget {
  uid: number;
  part: string;
  encoding: string | undefined;
  charset: string | undefined;
}

/** Fetch and decode first text parts for both previews and body indexing. */
export async function fetchTextParts(
  client: ImapFlow,
  targets: readonly TextPartTarget[],
): Promise<Map<number, string>> {
  const groups = new Map<string, TextPartTarget[]>();
  for (const target of targets) {
    const list = groups.get(target.part);
    if (list) list.push(target);
    else groups.set(target.part, [target]);
  }

  const out = new Map<number, string>();
  for (const [part, members] of groups) {
    const byUid = new Map(members.map((m) => [m.uid, m]));
    try {
      for await (const msg of client.fetch(
        members.map((m) => m.uid),
        { uid: true, bodyParts: [part] },
        { uid: true },
      )) {
        const target = byUid.get(msg.uid);
        const bytes = msg.bodyParts?.get(part);
        if (!target || !bytes) continue;
        // BINARY fetches arrive already decoded; everything else is ours to undo.
        const encoding = msg.binaryParts?.has(part) ? undefined : target.encoding;
        out.set(msg.uid, decodePart(bytes, encoding, target.charset));
      }
    } catch (err) {
      console.warn({ part, err: (err as Error).message }, 'text-part fetch failed');
    }
  }
  return out;
}

/* ── Writing ───────────────────────────────────────────────────────────────── */

const UPSERT_SQL = `
INSERT INTO messages (
  account_id, folder_id, uid, message_id, thread_id, in_reply_to, references_,
  from_name, from_address, to_addrs, cc_addrs,
  subject, subject_normalised, preview, date,
  body_search, body_indexed_at,
  seen, flagged, answered, draft_flag,
  has_attachments, attachment_count, size, priority
)
SELECT $1::uuid, $2::uuid, r.uid, r.message_id, r.thread_id, r.in_reply_to,
       coalesce(r.references_, '{}'),
       r.from_name, r.from_address, r.to_addrs, r.cc_addrs,
        r.subject, r.subject_normalised, r.preview, r.date,
        CASE WHEN r.body_text IS NULL THEN NULL
             ELSE setweight(to_tsvector('english', r.body_text), 'D') END,
        CASE WHEN r.body_text IS NULL THEN NULL ELSE now() END,
        r.seen, r.flagged, r.answered, r.draft_flag,
       r.attachment_count > 0, r.attachment_count, r.size, $3::priority_t
  FROM jsonb_to_recordset($4::jsonb) AS r(
    uid bigint, message_id text, thread_id text, in_reply_to text, references_ text[],
    from_name text, from_address text, to_addrs jsonb, cc_addrs jsonb,
     subject text, subject_normalised text, preview text, date timestamptz,
     body_text text,
    seen bool, flagged bool, answered bool, draft_flag bool,
    attachment_count int, size int
  )
ON CONFLICT (folder_id, uid) DO UPDATE SET
  message_id = EXCLUDED.message_id,
  thread_id = EXCLUDED.thread_id,
  in_reply_to = EXCLUDED.in_reply_to,
  references_ = EXCLUDED.references_,
  from_name = EXCLUDED.from_name,
  from_address = EXCLUDED.from_address,
  to_addrs = EXCLUDED.to_addrs,
  cc_addrs = EXCLUDED.cc_addrs,
  subject = EXCLUDED.subject,
  subject_normalised = EXCLUDED.subject_normalised,
  -- An empty re-read must not blank a preview we already have.
  preview = CASE WHEN EXCLUDED.preview = '' THEN messages.preview ELSE EXCLUDED.preview END,
  body_search = CASE WHEN EXCLUDED.body_search IS NULL THEN messages.body_search ELSE EXCLUDED.body_search END,
  body_indexed_at = CASE WHEN EXCLUDED.body_search IS NULL THEN messages.body_indexed_at ELSE EXCLUDED.body_indexed_at END,
  date = EXCLUDED.date,
  seen = EXCLUDED.seen,
  flagged = EXCLUDED.flagged,
  answered = EXCLUDED.answered,
  draft_flag = EXCLUDED.draft_flag,
  has_attachments = EXCLUDED.has_attachments,
  attachment_count = EXCLUDED.attachment_count,
  size = EXCLUDED.size
-- labels, snoozed_until and body_cached_at are ours, not the server's, and are
-- deliberately absent from the update list.
RETURNING id
`;

async function upsert(
  userId: string,
  accountId: string,
  folderId: string,
  priority: Priority,
  batch: Indexed[],
): Promise<number> {
  const threads = await assignThreads(userId, batch);

  const payload = batch.map((m) => ({
    uid: m.uid,
    message_id: m.messageId,
    thread_id: threads.get(m.messageId) ?? m.messageId,
    in_reply_to: m.inReplyTo,
    references_: m.references,
    from_name: m.fromName,
    from_address: m.fromAddress,
    to_addrs: m.to,
    cc_addrs: m.cc,
    subject: m.subject,
    subject_normalised: m.subjectNormalised,
    preview: m.preview,
    body_text: m.bodyText,
    date: m.date.toISOString(),
    seen: m.seen,
    flagged: m.flagged,
    answered: m.answered,
    draft_flag: m.draft,
    attachment_count: m.attachmentCount,
    size: m.size,
  }));

  const rows = await query<{ id: string }>(UPSERT_SQL, [
    accountId,
    folderId,
    priority,
    JSON.stringify(payload),
  ]);
  return rows.length;
}

/**
 * Push server flag state onto local rows.
 *
 * Rows with an unreplayed flag change are left alone. Until replay has drained,
 * the server's answer is stale by definition, and applying it undoes what the
 * user just did.
 */
async function applyFlags(
  folderId: string,
  updates: { uid: number; seen: boolean; flagged: boolean; answered: boolean }[],
): Promise<number> {
  const rows = await query<{ id: string }>(
    `
    UPDATE messages m
       SET seen = r.seen, flagged = r.flagged, answered = r.answered
      FROM jsonb_to_recordset($2::jsonb) AS r(uid bigint, seen bool, flagged bool, answered bool)
     WHERE m.folder_id = $1
       AND m.uid = r.uid
       AND (m.seen, m.flagged, m.answered) IS DISTINCT FROM (r.seen, r.flagged, r.answered)
       AND NOT EXISTS (
         SELECT 1 FROM sync_ops o
          WHERE o.account_id = m.account_id
            AND o.kind = 'flag'
            AND o.payload -> 'ids' ? m.id::text
       )
    RETURNING m.id
    `,
    [folderId, JSON.stringify(updates)],
  );
  return rows.length;
}

/** Bodies older than the TTL are dropped, not the messages. Runs on the same
 *  timer as sync rather than as its own scheduler. */
export async function evictStaleBodies(): Promise<number> {
  const rows = await query<{ message_id: string }>(
    `DELETE FROM message_bodies
      WHERE fetched_at < now() - ($1 || ' days')::interval
      RETURNING message_id`,
    [config.sync.bodyCacheTtlDays],
  );
  if (rows.length) {
    await transaction(async (tx) => {
      await tx.query('UPDATE messages SET body_cached_at = NULL WHERE id = ANY($1::uuid[])', [
        rows.map((r) => r.message_id),
      ]);
    });
  }
  return rows.length;
}
