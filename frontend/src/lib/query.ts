/**
 * List querying: filter → sort → group.
 *
 * Lives on the client so the mock adapter and the UI agree exactly, and so the
 * real backend has an executable spec to match. The Postgres implementation
 * mirrors these semantics one-for-one — see docs/architecture.md.
 */

import {
  PRIORITY_WEIGHT,
  type GroupKey,
  type ListQuery,
  type MessageSummary,
  type SortDir,
  type SortKey,
} from './types';

/* ── Filtering ────────────────────────────────────────────────────────────── */

/** What the filters need that a message does not carry. `domains` filters on a
 *  property of the owning account, so it cannot be answered from the row. */
export interface FilterContext {
  domainOf(accountId: string): string;
}

export function matchesFilters(m: MessageSummary, q: ListQuery, ctx: FilterContext): boolean {
  const f = q.filters;
  if (f.unreadOnly && m.seen) return false;
  if (f.flaggedOnly && !m.flagged) return false;
  if (f.hasAttachments && !m.hasAttachments) return false;
  if (f.accountIds.length && !f.accountIds.includes(m.accountId)) return false;
  if (f.folderIds.length && !f.folderIds.includes(m.folderId)) return false;
  if (f.domains.length && !f.domains.includes(ctx.domainOf(m.accountId))) return false;
  if (f.priorities.length && !f.priorities.includes(m.priority)) return false;
  if (f.labels.length && !f.labels.some((l) => m.labels.includes(l))) return false;
  if (f.since && Date.parse(m.date) < Date.parse(f.since)) return false;
  if (f.before && Date.parse(m.date) > Date.parse(f.before)) return false;
  return true;
}

/* ── Sorting ──────────────────────────────────────────────────────────────── */

const senderKey = (m: MessageSummary) => (m.from.name ?? m.from.address).toLowerCase();
const subjectKey = (m: MessageSummary) => m.subject.replace(/^((re|fwd|fw)\s*:\s*)+/i, '').toLowerCase();

const COMPARATORS: Record<SortKey, (a: MessageSummary, b: MessageSummary) => number> = {
  date: (a, b) => Date.parse(a.date) - Date.parse(b.date),
  // Priority sorts by tier first, then recency — a stale critical still beats a
  // fresh muted, but within a tier the newest wins.
  priority: (a, b) =>
    PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
    Date.parse(a.date) - Date.parse(b.date),
  sender: (a, b) => senderKey(a).localeCompare(senderKey(b)) || Date.parse(a.date) - Date.parse(b.date),
  subject: (a, b) => subjectKey(a).localeCompare(subjectKey(b)) || Date.parse(a.date) - Date.parse(b.date),
  size: (a, b) => a.size - b.size,
  unread: (a, b) => Number(a.seen) - Number(b.seen) || Date.parse(a.date) - Date.parse(b.date),
  // Replaced by the caller's score under a search scope; elsewhere every row
  // scores identically, so this is the honest fallback rather than a no-op.
  relevance: (a, b) => Date.parse(a.date) - Date.parse(b.date),
};

export function sortMessages(
  list: MessageSummary[],
  sort: SortKey,
  dir: SortDir,
  /** Relevance only. Higher sorts first, like every other key under `desc`. */
  score?: (m: MessageSummary) => number,
): MessageSummary[] {
  const cmp =
    sort === 'relevance' && score
      ? (a: MessageSummary, b: MessageSummary) =>
          score(a) - score(b) || Date.parse(a.date) - Date.parse(b.date)
      : COMPARATORS[sort];
  const sign = dir === 'desc' ? -1 : 1;
  // Stable: ties fall back to id so pagination cursors never skip a row.
  return [...list].sort((a, b) => sign * cmp(a, b) || a.id.localeCompare(b.id));
}

/* ── Threading ────────────────────────────────────────────────────────────── */

/** Collapse to one row per thread, keeping the newest and carrying the count. */
export function collapseThreads(
  list: MessageSummary[],
  /** Optional complete source for the indexed, unfiltered path. */
  source: MessageSummary[] = list,
): MessageSummary[] {
  const byThread = new Map<string, MessageSummary[]>();
  for (const m of list) {
    const bucket = byThread.get(m.threadId);
    if (bucket) bucket.push(m);
    else byThread.set(m.threadId, [m]);
  }
  const allByThread = new Map<string, MessageSummary[]>();
  for (const m of source) {
    const bucket = allByThread.get(m.threadId);
    if (bucket) bucket.push(m);
    else allByThread.set(m.threadId, [m]);
  }
  const out: MessageSummary[] = [];
  for (const bucket of byThread.values()) {
    const newest = (allByThread.get(bucket[0]!.threadId) ?? bucket).reduce((a, b) => {
      const dates = Date.parse(a.date) - Date.parse(b.date);
      return dates > 0 || (dates === 0 && a.id.localeCompare(b.id) >= 0) ? a : b;
    });
    out.push({
      ...newest,
      threadCount: bucket.length,
      // A thread is unread if *any* message in it is unread.
      seen: bucket.every((m) => m.seen),
      flagged: bucket.some((m) => m.flagged),
      hasAttachments: bucket.some((m) => m.hasAttachments),
    });
  }
  return out;
}

/* ── Grouping ─────────────────────────────────────────────────────────────── */

export interface Group {
  key: string;
  label: string;
  /** Secondary text on the group header, e.g. the domain under an account. */
  hint: string | null;
  messages: MessageSummary[];
}

const DAY = 864e5;

/** Calendar-aware date buckets — "Yesterday" means yesterday, not 24h ago. */
export function dateBucket(iso: string, now = Date.now()): { key: string; label: string; rank: number } {
  const d = new Date(iso);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const delta = startOfToday.getTime() - new Date(d).setHours(0, 0, 0, 0);

  if (delta <= 0) return { key: 'today', label: 'Today', rank: 0 };
  if (delta <= DAY) return { key: 'yesterday', label: 'Yesterday', rank: 1 };
  if (delta <= 6 * DAY) return { key: 'week', label: 'Earlier this week', rank: 2 };
  if (delta <= 13 * DAY) return { key: 'lastweek', label: 'Last week', rank: 3 };
  if (delta <= 30 * DAY) return { key: 'month', label: 'This month', rank: 4 };
  if (d.getFullYear() === new Date(now).getFullYear()) {
    const m = d.toLocaleString('en', { month: 'long' });
    return { key: `m-${d.getMonth()}`, label: m, rank: 5 + (11 - d.getMonth()) / 12 };
  }
  return { key: `y-${d.getFullYear()}`, label: String(d.getFullYear()), rank: 100 - d.getFullYear() / 1e4 };
}

export interface GroupContext {
  accountLabel: (id: string) => string;
  accountDomain: (id: string) => string;
  folderName: (id: string) => string;
}

export function groupMessages(
  list: MessageSummary[],
  group: GroupKey,
  ctx: GroupContext,
): Group[] {
  if (group === 'none') return [{ key: 'all', label: '', hint: null, messages: list }];

  const buckets = new Map<string, Group & { rank: number }>();
  const push = (key: string, label: string, hint: string | null, rank: number, m: MessageSummary) => {
    let g = buckets.get(key);
    if (!g) {
      g = { key, label, hint, rank, messages: [] };
      buckets.set(key, g);
    }
    g.messages.push(m);
  };

  for (const m of list) {
    switch (group) {
      case 'date': {
        const b = dateBucket(m.date);
        push(b.key, b.label, null, b.rank, m);
        break;
      }
      case 'account':
        push(m.accountId, ctx.accountLabel(m.accountId), ctx.accountDomain(m.accountId), 0, m);
        break;
      case 'domain': {
        const d = ctx.accountDomain(m.accountId);
        push(d, d, null, 0, m);
        break;
      }
      case 'priority':
        push(m.priority, m.priority, null, -PRIORITY_WEIGHT[m.priority], m);
        break;
      case 'sender': {
        const k = m.from.address.toLowerCase();
        push(k, m.from.name ?? m.from.address, m.from.address, 0, m);
        break;
      }
      case 'folder':
        push(m.folderId, ctx.folderName(m.folderId), null, 0, m);
        break;
    }
  }

  const groups = [...buckets.values()];
  // Date and priority have an intrinsic order; everything else sorts by weight.
  if (group === 'date' || group === 'priority') groups.sort((a, b) => a.rank - b.rank);
  else groups.sort((a, b) => b.messages.length - a.messages.length || a.label.localeCompare(b.label));
  return groups.map(({ rank: _rank, ...g }) => g);
}

/* ── Defaults ─────────────────────────────────────────────────────────────── */

export const emptyFilters = (): ListQuery['filters'] => ({
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
});

export const defaultQuery = (): ListQuery => ({
  scope: { kind: 'unified', value: null, role: 'inbox' },
  sort: 'date',
  dir: 'desc',
  group: 'date',
  threaded: true,
  filters: emptyFilters(),
  limit: 200,
  cursor: null,
});

export const filterCount = (f: ListQuery['filters']): number =>
  (f.unreadOnly ? 1 : 0) +
  (f.flaggedOnly ? 1 : 0) +
  (f.hasAttachments ? 1 : 0) +
  f.accountIds.length +
  f.domains.length +
  f.folderIds.length +
  f.priorities.length +
  f.labels.length +
  (f.since ? 1 : 0) +
  (f.before ? 1 : 0);

/**
 * The sort a scope arrives with when nothing says otherwise.
 *
 * A search wants its best answer first; everything else wants the user's
 * default. Shared by the router and the store so a URL and a click agree.
 */
export const defaultSortFor = (scope: ListQuery['scope'], base: SortKey): SortKey =>
  scope.kind === 'search' ? 'relevance' : base;
