/**
 * The list query.
 *
 * Semantics are defined by `frontend/src/lib/query.ts`, which is executable and
 * doubles as the spec — the mock adapter runs it directly, so any divergence
 * shows up immediately as a behaviour difference between mock and http mode.
 *
 * Performance rules, in priority order:
 *   1. Keyset pagination. `OFFSET` on a unified inbox is a table scan.
 *   2. Scope resolves to a folder-id array, never a join to accounts.
 *   3. Counts are capped. Nobody needs an exact 41,882.
 *   4. Facets ride along in the same round trip as the page.
 *
 * Budget: p95 under 50ms over 500k rows. If a change misses it, the change is
 * wrong, not the budget.
 */

import { withClient, type QueryRunner } from '../../db/index.ts';
import { badRequest } from '../../lib/errors.ts';
import {
  classifyIntent,
  parseSearch,
  resolveProfile,
  withSearchDefaults,
  type SearchPreferences,
} from '../../contract/search.ts';
import { relevanceSql, searchWhere } from './search-sql.ts';
import type { ListQuery, ListResult, MessageSummary, Priority } from '../../contract/types.ts';
import { toPreview } from '../../sync/parse.ts';

const COUNT_CAP = 10_000;
const MAX_LIMIT = 500;

/** Whitelist. Sort keys arrive from the client and are interpolated into SQL,
 *  so they can never be taken as-is. `relevance` is absent on purpose: it is
 *  not a column but an expression over the query, built per request. */
const SORT_SQL: Record<Exclude<ListQuery['sort'], 'relevance'>, string> = {
  date: 'm.date',
  priority: 'm.priority',
  sender: 'lower(coalesce(m.from_name, m.from_address))',
  subject: 'm.subject_normalised',
  size: 'm.size',
  unread: 'm.seen',
};

interface Params {
  userId: string;
  q: ListQuery;
  folderIds: string[];
}

type ListParams = Omit<Params, 'folderIds'>;

interface Cursor {
  v: string | number | boolean | null;
  id: string;
  /** The instant a relevance ranking was computed against. Carried so every
   *  page of one scan is ranked by the same clock. */
  t?: string;
}

const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

const decodeCursor = (raw: string): Cursor => {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.id !== 'string') throw new Error('bad shape');
    return parsed as Cursor;
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
};

/**
 * Builds the shared WHERE clause. Returns SQL, the bound values, and whether
 * the caller has to join `folders` — `folder:` is the only predicate that needs
 * it, and adding the join unconditionally would put it on the hot path of every
 * list query to serve a rare operator.
 */
function buildWhere(p: Params): {
  sql: string;
  values: unknown[];
  joinAccounts: boolean;
  joinFolders: boolean;
} {
  const { q, folderIds } = p;
  const values: unknown[] = [];
  const clauses: string[] = [];
  const bind = (v: unknown) => `$${values.push(v)}`;

  // Scope. An empty folder set means "nothing matches", which is different from
  // "no restriction" — an empty array here must not silently become a no-op.
  clauses.push(`m.folder_id = ANY(${bind(folderIds)}::uuid[])`);

  const f = q.filters;
  if (f.unreadOnly) clauses.push('NOT m.seen');
  if (f.flaggedOnly) clauses.push('m.flagged');
  if (f.hasAttachments) clauses.push('m.has_attachments');

  // Empty arrays mean "no restriction". Getting this backwards is the easiest
  // bug to write in this file.
  if (f.accountIds.length) clauses.push(`m.account_id = ANY(${bind(f.accountIds)}::uuid[])`);
  if (f.folderIds.length) clauses.push(`m.folder_id = ANY(${bind(f.folderIds)}::uuid[])`);
  const joinAccounts = f.domains.length > 0;
  if (joinAccounts) clauses.push(`a.domain = ANY(${bind(f.domains)}::text[])`);
  if (f.priorities.length) clauses.push(`m.priority = ANY(${bind(f.priorities)}::priority_t[])`);
  if (f.labels.length) clauses.push(`m.labels && ${bind(f.labels)}::text[]`);
  if (f.since) clauses.push(`m.date >= ${bind(f.since)}::timestamptz`);
  if (f.before) clauses.push(`m.date <= ${bind(f.before)}::timestamptz`);

  // Snoozed messages are hidden until they are due.
  clauses.push('(m.snoozed_until IS NULL OR m.snoozed_until <= now())');

  let joinFolders = false;
  if (q.scope.kind === 'search' && q.scope.value) {
    const parsed = parseSearch(q.scope.value);
    const where = searchWhere(parsed, bind);
    if (where) clauses.push(where);
    joinFolders = parsed.groups.some((g) => g.some((c) => c.field === 'folder'));
  }

  return { sql: clauses.join(' AND '), values, joinAccounts, joinFolders };
}

/** The folders join, or nothing. Written once so the three query builders
 *  cannot disagree about whether `f` is in scope. */
const foldersJoin = (needed: boolean) =>
  needed ? 'JOIN folders f ON f.id = m.folder_id' : '';

/** Resolve the authorised folder set on the same client as the list reads. */
async function resolveScope(run: QueryRunner, userId: string, q: ListQuery): Promise<string[]> {
  const { scope } = q;

  if (scope.kind === 'folder' && scope.value) {
    const rows = await run<{ id: string }>(
      `SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id
        WHERE a.user_id = $1 AND f.id = $2`,
      [userId, scope.value],
    );
    return rows[0] ? [rows[0].id] : [];
  }

  const clauses = ['a.user_id = $1'];
  const values: unknown[] = [userId];
  const bind = (v: unknown) => `$${values.push(v)}`;

  if (scope.kind === 'account' && scope.value) clauses.push(`a.id = ${bind(scope.value)}::uuid`);
  if (scope.kind === 'domain' && scope.value) clauses.push(`a.domain = ${bind(scope.value)}`);
  // Hidden accounts drop out of unified and search views but keep syncing.
  if (scope.kind === 'unified' || scope.kind === 'search' || scope.kind === 'saved') {
    clauses.push('NOT a.hidden');
  }
  if (scope.role) clauses.push(`f.role = ${bind(scope.role)}::folder_role_t`);

  const rows = await run<{ id: string }>(
    `SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE ${clauses.join(' AND ')}`,
    values,
  );
  return rows.map((r) => r.id);
}

/** Only fields that cross the list contract. In particular this excludes the
 * generated tsvector, reference arrays and cache timestamps; carrying `m.*`
 * through the threaded sort makes memory and temporary I/O scale with data the
 * response immediately discards. */
const MESSAGE_COLUMNS = `
  m.id, m.account_id, m.folder_id, m.thread_id, m.message_id,
  m.from_name, m.from_address, m.to_addrs,
  m.subject, m.subject_normalised, m.preview, m.date,
  m.seen, m.flagged, m.answered, m.draft_flag,
  m.has_attachments, m.attachment_count, m.size, m.labels, m.priority
`;

/**
 * The user's search ranking dials.
 *
 * Read on the same client as the rest of the request, and only when a relevance
 * sort is actually asked for. A user who has never opened Settings has no row
 * and no `search` key; `withSearchDefaults` turns both into the shipped
 * profile, so the ranker never sees a hole.
 */
async function searchPreferences(run: QueryRunner, userId: string): Promise<SearchPreferences> {
  const rows = await run<{ data: { search?: Partial<SearchPreferences> } | null }>(
    'SELECT data FROM preferences WHERE user_id = $1',
    [userId],
  );
  return withSearchDefaults(rows[0]?.data?.search);
}

/**
 * Scope and list reads share one pool client. They are still independent
 * autocommit statements; the client ownership only prevents one HTTP request
 * from multiplying into four simultaneous pool acquisitions.
 */
export async function listMessages(input: ListParams): Promise<ListResult> {
  return withClient(async (run) => {
    const folderIds = await resolveScope(run, input.userId, input.q);
    return listScoped({ ...input, folderIds }, run);
  });
}

async function listScoped(p: Params, run: QueryRunner): Promise<ListResult> {
  const { q } = p;
  const limit = Math.min(Math.max(1, q.limit || 100), MAX_LIMIT);
  const { sql: where, values, joinAccounts, joinFolders } = buildWhere(p);
  const bind = (v: unknown) => `$${values.push(v)}`;

  /*
   * Relevance is not a column. It is an expression over the parsed query, so it
   * is built per request, selected into the CTE as `search_rank`, and sorted on
   * from there — which also gives the cursor something concrete to carry.
   *
   * A query with nothing textual to rank (`is:unread has:attachment`) scores
   * every row identically, so it falls back to date rather than shuffling.
   */
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const rankedAt = cursor?.t ?? new Date().toISOString();
  const parsed =
    q.scope.kind === 'search' && q.scope.value ? parseSearch(q.scope.value) : null;

  /*
   * The ranking profile is resolved once per request, not once per row: the
   * query's intent plus the user's dials produce one object, which is then the
   * only thing the SQL builder needs. Preferences are read here and nowhere
   * else on the list path — an extra round trip on a relevance search is worth
   * it; an extra round trip on every inbox render would not be.
   */
  const profile =
    q.sort === 'relevance' && parsed
      ? resolveProfile(classifyIntent(parsed), await searchPreferences(run, p.userId))
      : null;
  const rank =
    q.sort === 'relevance' && parsed && profile
      ? relevanceSql(parsed, bind, rankedAt, profile)
      : null;
  const rankExpr = rank?.sql ?? null;

  let sortExpr: string;
  let outerSort: string;
  if (q.sort === 'relevance') {
    sortExpr = rankExpr ?? SORT_SQL.date;
    outerSort = rankExpr ? 'scoped.search_rank' : 'scoped.date';
  } else {
    const column = SORT_SQL[q.sort];
    if (!column) throw badRequest(`Unknown sort key: ${q.sort}`);
    sortExpr = column;
    outerSort = column.replace(/m\./g, 'scoped.');
  }

  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  /*
   * Ties always break on id so keyset pagination can never skip or repeat.
   *
   * No `NULLS LAST`. Every expression in SORT_SQL is over a NOT NULL column —
   * `from_name` is the one nullable input and it is inside a coalesce with
   * `from_address` — so the clause selects between two orderings that cannot
   * differ. It is not free, though: a `DESC` btree is NULLS FIRST, so asking
   * for `DESC NULLS LAST` is an ordering no index here can satisfy, and every
   * sort key including `date` fell back to an explicit Sort. The inner lateral
   * and this outer sort must stay identical for the per-folder merge to be
   * correct, so they are written the same way.
   */
  const usesThreadIndex =
    q.threaded &&
    q.scope.kind !== 'search' &&
    !hasActiveFilters(q) &&
    (q.sort === 'date' || (q.sort === 'relevance' && !rankExpr));
  const orderBy = usesThreadIndex
    ? `scoped.thread_date ${dir}, scoped.thread_id ${dir}`
    : `${outerSort} ${dir}, scoped.id ${dir}`;

  // Keyset predicate. Row-value comparison lets Postgres use the composite
  // index directly instead of filtering after the fact.
  let keyset = '';
  if (cursor && !usesThreadIndex) {
    const op = dir === 'DESC' ? '<' : '>';
    keyset = ` AND (${sortExpr}, m.id) ${op} (${bind(cursor.v)}, ${bind(cursor.id)})`;
  }

  const rankColumn = rankExpr ? `, ${rankExpr} AS search_rank` : '';
  // `folderIds` came from the authorised scope query above, on this same call.
  // Rejoining accounts merely to repeat that ownership check turns each
  // per-folder page seek into one scan per account. Domains are the only list
  // filter that actually needs the table.
  const joins = `${joinAccounts ? 'JOIN accounts a ON a.id = m.account_id' : ''} ${foldersJoin(
    joinFolders || (rank?.needsFolders ?? false),
  )}`;
  const pageLimit = bind(limit + 1);

  /*
   * Threading: DISTINCT ON collapses to the newest message per thread, then the
   * outer query applies the real sort. Thread size comes from a window function
   * in the same pass rather than a second query.
   *
   * The common unthreaded date path takes only one page candidate per folder.
   * A plain `folder_id = ANY(...) ORDER BY date LIMIT` becomes a bitmap scan and
   * sorts the entire unified mailbox; bounded lateral index scans merge at most
   * `(limit + 1) × folders` rows instead.
   */
  let base: string;
  /*
   * Which parameter array the finished statement is executed with, and which
   * placeholder its outer LIMIT reads.
   *
   * The thread-index branch uses none of buildWhere's predicates — not `where`,
   * not `keyset` — so it must not inherit its parameters either. Postgres infers
   * a parameter's type from where it is used, and a value that is sent but never
   * referenced has nowhere to infer from: the statement fails to prepare with
   * "could not determine data type of parameter $1". So that branch binds into
   * its own array.
   */
  let queryValues = values;
  let limitParam = pageLimit;
  if (usesThreadIndex) {
    const threadValues: unknown[] = [];
    const bindThread = (v: unknown) => `$${threadValues.push(v)}`;
    const userId = bindThread(p.userId);
    const scopedFolders = bindThread(p.folderIds);
    let threadKeyset = '';
    if (cursor) {
      const op = dir === 'DESC' ? '<' : '>';
      threadKeyset =
        ` AND (tf.last_date, tf.thread_id) ${op} (${bindThread(cursor.v)}, ${bindThread(cursor.id)})`;
    }
    const threadLimit = bindThread(limit + 1);
    queryValues = threadValues;
    limitParam = threadLimit;
    /*
     * The representative message and the snooze test are inside the lateral, so
     * `LIMIT` counts rows that survive the filter. Hoisting either one out puts
     * the filter after the limit: a page then comes back short, and a short page
     * reads as `hasMore = false`, which nulls the cursor and makes the rest of
     * the mailbox unreachable. The unthreaded path avoids this the same way, by
     * carrying its whole WHERE inside the lateral.
     *
     * `m.thread_id` is `tf.thread_id` by construction — m is the thread's own
     * newest message — so the collapse reads it straight out of MESSAGE_COLUMNS
     * rather than selecting the key twice under two names.
     */
    base = `
      SELECT DISTINCT ON (cand.thread_id) cand.*
        FROM unnest(${scopedFolders}::uuid[]) AS wanted(folder_id)
        CROSS JOIN LATERAL (
          SELECT ${MESSAGE_COLUMNS},
                 tf.last_date AS thread_date,
                 1 AS thread_count,
                 m.seen AS thread_seen,
                 m.flagged AS thread_flagged,
                 m.has_attachments AS thread_attachments
            FROM thread_folders tf
            JOIN threads t ON t.user_id = tf.user_id AND t.thread_id = tf.thread_id
            JOIN messages m ON m.id = t.last_message
           WHERE tf.user_id = ${userId}
             AND tf.folder_id = wanted.folder_id
             AND (m.snoozed_until IS NULL OR m.snoozed_until <= now())
             ${threadKeyset}
           ORDER BY tf.last_date ${dir}, tf.thread_id ${dir}
           LIMIT ${threadLimit}::int
        ) cand
       ORDER BY cand.thread_id, cand.thread_date DESC
    `;
  } else if (q.threaded) {
    base = `
      SELECT DISTINCT ON (m.thread_id)
             ${MESSAGE_COLUMNS},
             count(*) OVER (PARTITION BY m.thread_id) AS thread_count,
             bool_and(m.seen) OVER (PARTITION BY m.thread_id) AS thread_seen,
             bool_or(m.flagged) OVER (PARTITION BY m.thread_id) AS thread_flagged,
             bool_or(m.has_attachments) OVER (PARTITION BY m.thread_id) AS thread_attachments${rankColumn}
        FROM messages m
        ${joins}
       WHERE ${where}${keyset}
       ORDER BY m.thread_id, m.date DESC
    `;
  } else if (q.sort !== 'relevance' || !rankExpr) {
    base = `
      SELECT per_folder.*
        FROM unnest(${bind(p.folderIds)}::uuid[]) AS wanted(folder_id)
        CROSS JOIN LATERAL (
            SELECT ${MESSAGE_COLUMNS},
                  1 AS thread_count, m.seen AS thread_seen,
                  m.flagged AS thread_flagged, m.has_attachments AS thread_attachments
             FROM messages m
             ${joins}
            WHERE ${where}${keyset}
              AND m.folder_id = wanted.folder_id
            ORDER BY ${sortExpr} ${dir}, m.id ${dir}
            LIMIT ${pageLimit}::int
        ) per_folder
    `;
  } else {
    base = `
      SELECT ${MESSAGE_COLUMNS},
             1 AS thread_count, m.seen AS thread_seen,
             m.flagged AS thread_flagged, m.has_attachments AS thread_attachments${rankColumn}
        FROM messages m
       ${joins}
       WHERE ${where}${keyset}
    `;
  }

  const rows = await run<MessageRow>(
    `
    WITH scoped AS (${base})
    SELECT * FROM scoped
     ORDER BY ${orderBy}
     LIMIT ${limitParam}
    `,
    queryValues,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  if (usesThreadIndex && page.length) {
    const threadIds = page.map((row) => row.thread_id);
    const counts = await run<ThreadCountRow>(
      `SELECT tf.thread_id,
              sum(tf.msg_count)::int AS msg_count,
              sum(tf.unread_count)::int AS unread_count,
              sum(tf.flagged_count)::int AS flagged_count,
              sum(tf.attachment_count)::int AS attachment_count
         FROM thread_folders tf
        WHERE tf.thread_id = ANY($1::text[])
          AND tf.folder_id = ANY($2::uuid[])
        GROUP BY tf.thread_id`,
      [threadIds, p.folderIds],
    );
    const byThread = new Map(counts.map((row) => [row.thread_id, row]));
    for (const row of page) {
      const count = byThread.get(row.thread_id);
      if (!count) continue;
      row.thread_count = count.msg_count;
      row.thread_seen = count.unread_count === 0;
      row.thread_flagged = count.flagged_count > 0;
      row.thread_attachments = count.attachment_count > 0;
    }
  }

  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v: usesThreadIndex ? last.thread_date.toISOString() : rankExpr ? Number(last.search_rank) : sortValueOf(last, q.sort),
          id: usesThreadIndex ? last.thread_id : last.id,
          ...(rankExpr ? { t: rankedAt } : {}),
        })
      : null;

  const facets = await facetScope(p, run);
  const { total, approximate } = hasActiveFilters(q)
    ? await countScope(p, run)
    : cappedTotal(Object.values(facets.accounts).reduce((sum, n) => sum + n, 0));

  return {
    messages: page.map(toSummary),
    nextCursor,
    total,
    approximate,
    facets,
  };
}

function hasActiveFilters(q: ListQuery): boolean {
  const f = q.filters;
  return f.unreadOnly || f.flaggedOnly || f.hasAttachments ||
    f.accountIds.length > 0 || f.domains.length > 0 || f.folderIds.length > 0 ||
    f.priorities.length > 0 || f.labels.length > 0 || !!f.since || !!f.before;
}

const cappedTotal = (n: number): { total: number; approximate: boolean } =>
  n > COUNT_CAP ? { total: COUNT_CAP, approximate: true } : { total: n, approximate: false };

/* ── Counting ───────────────────────────────────────────────────────────────
   Capped: stop at COUNT_CAP and report the result as approximate. Counting
   every row of a 40k mailbox costs more than the page query it accompanies. */

async function countScope(
  p: Params,
  run: QueryRunner,
): Promise<{ total: number; approximate: boolean }> {
  const { sql: where, values, joinAccounts, joinFolders } = buildWhere(p);
  const rows = await run<{ n: string }>(
    `
    SELECT count(*)::text AS n FROM (
      SELECT 1 FROM messages m
        ${joinAccounts ? 'JOIN accounts a ON a.id = m.account_id' : ''}
        ${foldersJoin(joinFolders)}
       WHERE ${where}
       LIMIT ${COUNT_CAP + 1}
    ) capped
    `,
    values,
  );
  const n = Number(rows[0]?.n ?? 0);
  return cappedTotal(n);
}

/* ── Facets ─────────────────────────────────────────────────────────────────
   Computed over the *scope* with filters removed, so the filter bar shows what
   turning a filter on would give you rather than what is already on. */

async function facetScope(p: Params, run: QueryRunner): Promise<ListResult['facets']> {
  if (p.q.scope.kind !== 'search') return cachedFacetScope(p, run);

  const bare: Params = {
    ...p,
    q: {
      ...p.q,
      filters: {
        unreadOnly: false,
        flaggedOnly: false,
        hasAttachments: false,
        accountIds: [],
        domains: [],
        folderIds: [],
        priorities: [],
        labels: [],
        since: null,
        before: null,
      },
    },
  };
  const { sql: where, values, joinFolders } = buildWhere(bare);

  const rows = await run<FacetRow>(
    `
    SELECT m.account_id, a.domain, m.priority, m.labels,
           count(*)::int                                   AS n,
           count(*) FILTER (WHERE NOT m.seen)::int          AS unread,
           count(*) FILTER (WHERE m.flagged)::int           AS flagged,
           count(*) FILTER (WHERE m.has_attachments)::int   AS with_attachments
      FROM messages m
      JOIN accounts a ON a.id = m.account_id
      ${foldersJoin(joinFolders)}
     WHERE ${where}
     GROUP BY m.account_id, a.domain, m.priority, m.labels
    `,
    values,
  );

  return facetResult(rows);
}

/**
 * Ordinary scopes read denormalised folder aggregates. Snoozed messages are
 * subtracted live because their visibility changes with the clock rather than
 * a write; the partial index keeps that correction proportional to the small
 * snoozed subset instead of the mailbox.
 */
async function cachedFacetScope(p: Params, run: QueryRunner): Promise<ListResult['facets']> {
  const folders = await run<FolderFacetRow>(
    `SELECT f.account_id, a.domain, a.priority,
            f.total AS n, f.unread, f.facet_flagged AS flagged,
            f.facet_with_attachments AS with_attachments,
            f.facet_labels AS labels
       FROM folders f
       JOIN accounts a ON a.id = f.account_id
      WHERE a.user_id = $1 AND f.id = ANY($2::uuid[])`,
    [p.userId, p.folderIds],
  );

  const snoozed = await run<FacetRow>(
    `SELECT m.account_id, a.domain, m.priority, m.labels,
            count(*)::int AS n,
            count(*) FILTER (WHERE NOT m.seen)::int AS unread,
            count(*) FILTER (WHERE m.flagged)::int AS flagged,
            count(*) FILTER (WHERE m.has_attachments)::int AS with_attachments
       FROM messages m
       JOIN accounts a ON a.id = m.account_id
      WHERE a.user_id = $1
        AND m.folder_id = ANY($2::uuid[])
        AND m.snoozed_until > now()
      GROUP BY m.account_id, a.domain, m.priority, m.labels`,
    [p.userId, p.folderIds],
  );

  const facets = emptyFacets();
  for (const row of folders) addFacetRow(facets, row, 1);
  for (const row of snoozed) addFacetRow(facets, row, -1);
  return facets;
}

const emptyFacets = (): ListResult['facets'] => ({
  accounts: {},
  domains: {},
  priorities: { critical: 0, high: 0, normal: 0, low: 0, muted: 0 },
  labels: {},
  unread: 0,
  flagged: 0,
  withAttachments: 0,
});

function facetResult(rows: FacetRow[]): ListResult['facets'] {
  const facets = emptyFacets();
  for (const row of rows) addFacetRow(facets, row, 1);
  return facets;
}

function addFacetRow(
  facets: ListResult['facets'],
  row: FacetRow | FolderFacetRow,
  sign: 1 | -1,
): void {
  facets.accounts[row.account_id] = (facets.accounts[row.account_id] ?? 0) + sign * row.n;
  facets.domains[row.domain] = (facets.domains[row.domain] ?? 0) + sign * row.n;
  facets.priorities[row.priority] += sign * row.n;
  facets.unread += sign * row.unread;
  facets.flagged += sign * row.flagged;
  facets.withAttachments += sign * row.with_attachments;

  if (Array.isArray(row.labels)) {
    for (const label of row.labels) {
      facets.labels[label] = (facets.labels[label] ?? 0) + sign * row.n;
    }
  } else {
    for (const [label, count] of Object.entries(row.labels)) {
      facets.labels[label] = (facets.labels[label] ?? 0) + sign * count;
    }
  }
}

/* ── Row mapping ────────────────────────────────────────────────────────────── */

interface MessageRow {
  id: string;
  account_id: string;
  folder_id: string;
  thread_id: string;
  message_id: string | null;
  from_name: string | null;
  from_address: string;
  to_addrs: { name: string | null; address: string }[];
  subject: string;
  subject_normalised: string;
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
  thread_count: number;
  thread_seen: boolean;
  thread_flagged: boolean;
  thread_attachments: boolean;
  thread_date: Date;
  /** Present only for the indexed threaded branch. */
  search_rank?: string;
}

interface ThreadCountRow {
  thread_id: string;
  msg_count: number;
  unread_count: number;
  flagged_count: number;
  attachment_count: number;
}

interface FacetRow {
  account_id: string;
  domain: string;
  priority: Priority;
  n: number;
  unread: number;
  flagged: number;
  with_attachments: number;
  labels: string[];
}

interface FolderFacetRow extends Omit<FacetRow, 'labels'> {
  labels: Record<string, number>;
}

function sortValueOf(row: MessageRow, key: ListQuery['sort']): Cursor['v'] {
  switch (key) {
    // Relevance never reaches here — the caller carries `search_rank` directly,
    // because the value is computed and not on the row otherwise.
    case 'relevance':
    case 'date':
      return row.date.toISOString();
    case 'priority':
      return row.priority;
    case 'sender':
      return (row.from_name ?? row.from_address).toLowerCase();
    case 'subject':
      return row.subject_normalised;
    case 'size':
      return row.size;
    case 'unread':
      return row.seen;
  }
}

function toSummary(r: MessageRow): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    threadId: r.thread_id,
    messageId: r.message_id ?? '',
    from: { name: r.from_name, address: r.from_address },
    to: r.to_addrs,
    subject: r.subject,
    // Normalise again at the API edge so previews indexed before the parser was
    // hardened do not keep exposing markup until a full mailbox re-index.
    preview: toPreview(r.preview, false),
    date: r.date.toISOString(),
    // A thread is unread if any message in it is unread, and flagged if any is
    // flagged — the row stands for the whole conversation.
    seen: r.thread_seen,
    flagged: r.thread_flagged,
    answered: r.answered,
    draft: r.draft_flag,
    hasAttachments: r.thread_attachments,
    attachmentCount: r.attachment_count,
    threadCount: r.thread_count,
    size: r.size,
    labels: r.labels,
    priority: r.priority,
  };
}
