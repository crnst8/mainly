/**
 * What the filter knows about one user, read from Postgres.
 *
 * Three kinds of knowledge, from strongest to weakest:
 *
 *  1. **Rules.** The latest example for a sender or list decides its mail
 *     outright. Filing one message from a newsletter files the next one; taking
 *     one back out stops that. Rules are not a separate table — they are the
 *     newest example per key, so there is one ledger and nothing to keep in
 *     step with it.
 *  2. **People you write to.** Mail from an address in your Sent folder, or in
 *     a conversation you have written in, is never filed by the classifier or
 *     the model. Only an explicit rule overrides it.
 *  3. **The classifier.** Counts over the user's examples (mail they filed and
 *     mail they rescued) and over a sample of mail they read and left in the
 *     inbox or archive, which is the quiet majority of "keep" evidence.
 *
 * The counts are built once and cached per process, and rebuilt when the
 * examples change or the cache is half an hour old. The API process writes
 * examples and the sync process reads them, so the cache key is read from the
 * table itself rather than invalidated by a message between processes.
 */

import { one, query, type QueryRunner } from '../db/index.ts';
import type { Addr } from '../contract/types.ts';
import { emptyCounts, train, type Counts } from './classifier.ts';
import { featuresOf, ruleKey, type FilterInput } from './features.ts';
import type { LlmExample } from './llm.ts';

/** Examples kept per user. Older ones are dropped as new ones arrive; a
 *  person's sense of what is clutter drifts, and the counts should follow. */
export const MAX_EXAMPLES = 5000;
/** Read-and-kept mail sampled into the "keep" class. */
const KEEP_SAMPLE = 1000;
const CACHE_MS = 30 * 60_000;

/** A message row with everything the filter reads. */
export interface FilterRow {
  id: string;
  account_id: string;
  thread_id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  preview: string;
  list_id: string | null;
  bulk: boolean;
  to_addrs: Addr[] | null;
  cc_addrs: Addr[] | null;
  has_attachments: boolean;
  account: string;
}

export const FILTER_ROW_COLUMNS = `
  m.id, m.account_id, m.thread_id, m.from_address, m.from_name, m.subject, m.preview,
  m.list_id, m.bulk, m.to_addrs, m.cc_addrs, m.has_attachments, a.address AS account`;

export function inputOf(r: FilterRow): FilterInput {
  return {
    fromAddress: r.from_address,
    fromName: r.from_name,
    subject: r.subject,
    preview: r.preview,
    listId: r.list_id,
    bulk: r.bulk,
    to: r.to_addrs ?? [],
    cc: r.cc_addrs ?? [],
    account: r.account,
    hasAttachments: r.has_attachments,
  };
}

/** Rows for a set of message ids, scoped to the user. */
export async function filterRows(userId: string, ids: readonly string[], run: QueryRunner = query): Promise<FilterRow[]> {
  if (!ids.length) return [];
  return run<FilterRow>(
    `SELECT ${FILTER_ROW_COLUMNS}
       FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.id = ANY($2::uuid[])`,
    [userId, ids],
  );
}

/* ── Rules ──────────────────────────────────────────────────────────────── */

/** `list:<id>` or `sender:<address>` → the newest verdict for it. */
export async function rulesFor(
  userId: string,
  rows: readonly { from_address: string; list_id: string | null }[],
): Promise<Map<string, 'filter' | 'keep'>> {
  const lists = [...new Set(rows.flatMap((r) => (r.list_id ? [r.list_id] : [])))];
  const senders = [...new Set(rows.filter((r) => !r.list_id).map((r) => r.from_address))];
  const out = new Map<string, 'filter' | 'keep'>();
  if (!lists.length && !senders.length) return out;
  const found = await query<{ key: string; verdict: 'filter' | 'keep' }>(
    `SELECT DISTINCT ON (key) key, verdict FROM (
       SELECT CASE WHEN list_id IS NOT NULL THEN 'list:' || list_id ELSE 'sender:' || from_address END AS key,
              verdict, id
         FROM filter_examples
        WHERE user_id = $1
          AND (list_id = ANY($2::text[]) OR (list_id IS NULL AND from_address = ANY($3::text[])))
     ) x
     ORDER BY key, id DESC`,
    [userId, lists, senders],
  );
  for (const r of found) out.set(r.key, r.verdict);
  return out;
}

export const keyOf = (r: { from_address: string; list_id: string | null }): string => {
  const k = ruleKey({ fromAddress: r.from_address, listId: r.list_id });
  return `${k.kind}:${k.value}`;
};

/* ── People you write to ────────────────────────────────────────────────── */

/** Addresses among `addresses` that the user has sent mail to, and threads
 *  among `threads` they have written in. */
export async function correspondence(
  userId: string,
  addresses: readonly string[],
  threads: readonly string[],
): Promise<{ addresses: Set<string>; threads: Set<string> }> {
  const [people, conversations] = await Promise.all([
    addresses.length
      ? query<{ address: string }>(
          `SELECT DISTINCT lower(r->>'address') AS address
             FROM messages m
             JOIN folders f ON f.id = m.folder_id
             JOIN accounts a ON a.id = m.account_id
             CROSS JOIN LATERAL jsonb_array_elements(m.to_addrs || m.cc_addrs) r
            WHERE a.user_id = $1 AND f.role = 'sent'
              AND lower(r->>'address') = ANY($2::text[])`,
          [userId, addresses],
        )
      : [],
    threads.length
      ? query<{ thread_id: string }>(
          `SELECT DISTINCT m.thread_id
             FROM messages m
             JOIN folders f ON f.id = m.folder_id
             JOIN accounts a ON a.id = m.account_id
            WHERE a.user_id = $1 AND f.role = 'sent' AND m.thread_id = ANY($2::text[])`,
          [userId, threads],
        )
      : [],
  ]);
  return {
    addresses: new Set(people.map((r) => r.address)),
    threads: new Set(conversations.map((r) => r.thread_id)),
  };
}

/* ── The classifier's counts ────────────────────────────────────────────── */

interface Built {
  version: string;
  at: number;
  counts: Counts;
  /** Recent examples of each kind, for the language model's prompt. */
  examples: LlmExample[];
}

const cache = new Map<string, Built>();

/** Changes whenever an example is added or removed: ids only grow, so the
 *  pair moves on every insert and the count moves on every delete. */
async function versionOf(userId: string): Promise<string> {
  const row = await one<{ n: number; top: string }>(
    `SELECT count(*)::int AS n, coalesce(max(id), 0)::text AS top FROM filter_examples WHERE user_id = $1`,
    [userId],
  );
  return `${row?.n ?? 0}:${row?.top ?? 0}`;
}

export async function modelFor(userId: string): Promise<Built> {
  const version = await versionOf(userId);
  const hit = cache.get(userId);
  if (hit && hit.version === version && Date.now() - hit.at < CACHE_MS) return hit;

  const counts = emptyCounts();
  const examples = await query<{
    verdict: 'filter' | 'keep';
    features: string[];
    from_address: string;
    from_name: string | null;
    subject: string;
  }>(
    `SELECT verdict, features, from_address, from_name, subject
       FROM filter_examples WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, MAX_EXAMPLES],
  );
  // A rescue is a correction of a mistake the filter made, which is worth
  // more than one more message that sat in the inbox unremarked.
  for (const e of examples) train(counts, e.features, e.verdict, e.verdict === 'keep' ? 2 : 1);

  // Read, kept, and old enough that leaving it was a choice. Senders the user
  // has filed are left out: their older mail predates the decision and would
  // teach the opposite of it.
  const kept = await query<FilterRow & { strong: boolean }>(
    `SELECT ${FILTER_ROW_COLUMNS}, (m.answered OR m.flagged) AS strong
       FROM messages m
       JOIN accounts a ON a.id = m.account_id
       JOIN folders f ON f.id = m.folder_id
      WHERE a.user_id = $1 AND f.role IN ('inbox', 'archive')
        AND m.seen AND m.date < now() - interval '2 days'
        AND NOT EXISTS (SELECT 1 FROM filter_examples e WHERE e.message_id = m.id)
        AND m.from_address NOT IN (
          SELECT from_address FROM filter_examples WHERE user_id = $1 AND verdict = 'filter'
        )
      ORDER BY m.date DESC
      LIMIT $2`,
    [userId, KEEP_SAMPLE],
  );
  for (const r of kept) train(counts, featuresOf(inputOf(r)), 'keep', r.strong ? 2 : 1);

  const prompt: LlmExample[] = [
    ...examples
      .filter((e) => e.verdict === 'filter')
      .slice(0, 20)
      .map((e) => ({ from: { name: e.from_name, address: e.from_address }, subject: e.subject, verdict: 'filter' as const })),
    ...examples
      .filter((e) => e.verdict === 'keep')
      .slice(0, 10)
      .map((e) => ({ from: { name: e.from_name, address: e.from_address }, subject: e.subject, verdict: 'keep' as const })),
    ...kept
      .filter((r) => r.strong)
      .slice(0, 10)
      .map((r) => ({ from: { name: r.from_name, address: r.from_address }, subject: r.subject, verdict: 'keep' as const })),
  ];

  const built = { version, at: Date.now(), counts, examples: prompt };
  cache.set(userId, built);
  return built;
}

/* ── Track record ───────────────────────────────────────────────────────── */

/** Auto-filed and rescued in the last 60 days, per predicting stage. Rule
 *  filings are left out: rescuing one changes the rule, which is the user
 *  changing their mind, not the filter guessing wrong. */
export async function trackRecord(
  userId: string,
): Promise<Record<'model' | 'llm', { autoFiled: number; rescued: number }>> {
  const rows = await query<{ stage: 'model' | 'llm'; filed: number; rescued: number }>(
    `SELECT stage, count(*)::int AS filed, count(rescued_at)::int AS rescued
       FROM filter_decisions
      WHERE user_id = $1 AND stage IN ('model', 'llm') AND created_at > now() - interval '60 days'
      GROUP BY stage`,
    [userId],
  );
  const out = { model: { autoFiled: 0, rescued: 0 }, llm: { autoFiled: 0, rescued: 0 } };
  for (const r of rows) out[r.stage] = { autoFiled: r.filed, rescued: r.rescued };
  return out;
}
