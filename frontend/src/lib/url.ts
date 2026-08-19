/**
 * URL ⇄ view state.
 *
 * `Scope` in the contract says "serialisable → it lives in the URL". This is
 * that promise kept. Pure functions only — no store, no DOM — so the router and
 * `frontend/scripts/url-check.mjs` exercise byte-for-byte the same code.
 *
 *   /                      unified inbox
 *   /u                     unified, every folder
 *   /u/:role               unified, one folder role
 *   /d/:domain/:role?      one domain
 *   /a/:accountId/:role?   one account
 *   /f/:folderId           one folder
 *   /v/:viewId             a saved view
 *   /search?q=…            a search
 *   …/m/:messageId         an open message — a location, not a mode
 *   …?settings=:tab        settings, over whatever list you were looking at
 *
 * Sort, grouping, threading and facet filters ride in the query string and are
 * omitted whenever they match the caller's defaults, so the common case stays
 * short enough to read out loud.
 *
 * Postel: anything unrecognised — a bad role, a sort key from a future version,
 * a truncated path — degrades to the default rather than throwing. A URL is
 * user input arriving from a bookmark bar, and it is never worth an error page.
 */

import type {
  FolderRole,
  GroupKey,
  Id,
  ListQuery,
  Priority,
  SavedView,
  Scope,
  SortDir,
  SortKey,
} from './types';

/* These four whitelists are the validation boundary for path and query values,
   which is why they are spelled out here rather than derived: a value that is
   not in the list is not merely wrong, it is untrusted. */
const ROLES: FolderRole[] = [
  'inbox',
  'drafts',
  'sent',
  'trash',
  'junk',
  'archive',
  'flagged',
  'all',
  'custom',
];
const SORTS: SortKey[] = ['date', 'priority', 'sender', 'subject', 'size', 'unread'];
const GROUPS: GroupKey[] = ['none', 'date', 'account', 'domain', 'priority', 'sender', 'folder'];
const PRIORITY_VALUES: Priority[] = ['critical', 'high', 'normal', 'low', 'muted'];

/** What the list looks like when no parameter says otherwise. For an ordinary
 *  scope these are the user's preferences; for a saved view they are the view's
 *  own query, so `/v/:id` on its own means "the view exactly as saved". */
export interface RouteDefaults {
  sort: SortKey;
  dir: SortDir;
  group: GroupKey;
  threaded: boolean;
  filters: ListQuery['filters'];
}

/** Everything a location encodes. A superset of the list query minus its
 *  transport concerns (limit, cursor), plus the open message. */
export interface RouteState {
  scope: Scope;
  sort: SortKey;
  dir: SortDir;
  group: GroupKey;
  threaded: boolean;
  filters: ListQuery['filters'];
  openId: Id | null;
  /**
   * The open settings tab, or null.
   *
   * A query parameter rather than a path, because settings is drawn *over* a
   * list and closing it must return you to exactly that list — scope, sort,
   * filters, open message and all. Encoding it in the path would mean rebuilding
   * that state on the way back out.
   *
   * It is in the URL at all because settings covers the whole viewport, and a
   * full-screen view that is not a location swallows the browser's Back button:
   * Back navigated the list underneath while settings stayed on top of it, so
   * the one control every user reaches for to leave a page did nothing visible.
   */
  settings: string | null;
}

/** The parser's fallback for anything it cannot read. `lib/scope.ts` declares
 *  the same place for the UI; this copy exists because this file deliberately
 *  has no runtime imports. */
const HOME: Scope = { kind: 'unified', value: null, role: 'inbox' };

/**
 * Resolve the defaults for a scope.
 *
 * A saved view carries its own query, so `/v/:id` alone means the view exactly
 * as saved and any parameter present is a deliberate deviation from it.
 * Everything else falls back to the user's default query.
 */
export function routeDefaults(views: SavedView[], base: RouteDefaults, scope: Scope): RouteDefaults {
  if (scope.kind === 'saved') {
    const v = views.find((x) => x.id === scope.value);
    if (v) {
      return {
        sort: v.query.sort,
        dir: v.query.dir,
        group: v.query.group,
        threaded: v.query.threaded,
        filters: v.query.filters,
      };
    }
  }
  // A search arrives sorted by relevance and ungrouped: date headers over a
  // result set are noise, and the best answer belongs at the top. Both are
  // still overridable, and the override shows in the URL.
  if (scope.kind === 'search') return { ...base, sort: 'relevance', group: 'none' };
  return base;
}

/* ── Parse ────────────────────────────────────────────────────────────────── */

/** Defaults may depend on where you are — a saved view carries its own — so the
 *  callers that need that pass a resolver instead of a fixed object. */
export type Defaults = RouteDefaults | ((scope: Scope) => RouteDefaults);

const resolve = (d: Defaults, scope: Scope): RouteDefaults =>
  typeof d === 'function' ? d(scope) : d;

export function parseLocation(pathname: string, search: string, defaults: Defaults): RouteState {
  const params = new URLSearchParams(search);
  let segs = pathname.split('/').filter(Boolean).map(safeDecode);

  // The open message is a trailing `/m/:id` on whatever list it was opened
  // from. No route puts a literal "m" in that position, so the check is exact.
  let openId: Id | null = null;
  if (segs.length >= 2 && segs[segs.length - 2] === 'm') {
    openId = segs[segs.length - 1] ?? null;
    segs = segs.slice(0, -2);
  }

  const scope = parseScope(segs, params);
  const d = resolve(defaults, scope);

  return {
    scope,
    sort: oneOf(params.get('sort'), SORTS, d.sort),
    dir: params.get('dir') === 'asc' ? 'asc' : params.get('dir') === 'desc' ? 'desc' : d.dir,
    group: oneOf(params.get('group'), GROUPS, d.group),
    threaded: bool(params.get('threaded'), d.threaded),
    filters: {
      unreadOnly: bool(params.get('unread'), d.filters.unreadOnly),
      flaggedOnly: bool(params.get('flagged'), d.filters.flaggedOnly),
      hasAttachments: bool(params.get('att'), d.filters.hasAttachments),
      accountIds: list(params.get('acc'), d.filters.accountIds),
      domains: list(params.get('dom'), d.filters.domains),
      folderIds: list(params.get('fld'), d.filters.folderIds),
      priorities: list(params.get('pri'), d.filters.priorities).filter((p): p is Priority =>
        (PRIORITY_VALUES as string[]).includes(p),
      ),
      labels: list(params.get('label'), d.filters.labels),
      since: params.get('since') ?? d.filters.since,
      before: params.get('before') ?? d.filters.before,
    },
    openId,
    // Anything is accepted; the settings screen falls back to its first tab for
    // a name it does not know, the same way a bad sort key degrades.
    settings: params.get('settings') || null,
  };
}

function parseScope(segs: string[], params: URLSearchParams): Scope {
  const [head, a, b] = segs;
  switch (head) {
    case undefined:
      return { ...HOME };
    case 'u':
      return { kind: 'unified', value: null, role: role(a) };
    case 'd':
      return a ? { kind: 'domain', value: a, role: role(b) } : { ...HOME };
    case 'a':
      return a ? { kind: 'account', value: a, role: role(b) } : { ...HOME };
    case 'f':
      return a ? { kind: 'folder', value: a, role: null } : { ...HOME };
    case 'v':
      return a ? { kind: 'saved', value: a, role: null } : { ...HOME };
    case 'search': {
      const q = params.get('q')?.trim();
      return q ? { kind: 'search', value: q, role: null } : { ...HOME };
    }
    default:
      return { ...HOME };
  }
}

/* ── Build ────────────────────────────────────────────────────────────────── */

export function buildLocation(s: RouteState, defaults: Defaults): string {
  const segs: string[] = [];
  const params = new URLSearchParams();
  const { scope } = s;
  const d = resolve(defaults, scope);

  switch (scope.kind) {
    case 'unified':
      // The unified inbox is the app's origin, so it gets the shortest URL there
      // is. Every other role is spelled out.
      if (scope.role !== 'inbox') {
        segs.push('u');
        if (scope.role) segs.push(scope.role);
      }
      break;
    case 'domain':
      segs.push('d', scope.value ?? '');
      if (scope.role) segs.push(scope.role);
      break;
    case 'account':
      segs.push('a', scope.value ?? '');
      if (scope.role) segs.push(scope.role);
      break;
    case 'folder':
      segs.push('f', scope.value ?? '');
      break;
    case 'saved':
      segs.push('v', scope.value ?? '');
      break;
    case 'search':
      segs.push('search');
      params.set('q', scope.value ?? '');
      break;
  }

  if (s.openId) segs.push('m', s.openId);

  if (s.settings) params.set('settings', s.settings);

  if (s.sort !== d.sort) params.set('sort', s.sort);
  if (s.dir !== d.dir) params.set('dir', s.dir);
  if (s.group !== d.group) params.set('group', s.group);
  if (s.threaded !== d.threaded) params.set('threaded', s.threaded ? '1' : '0');

  const f = s.filters;
  const df = d.filters;
  if (f.unreadOnly !== df.unreadOnly) params.set('unread', f.unreadOnly ? '1' : '0');
  if (f.flaggedOnly !== df.flaggedOnly) params.set('flagged', f.flaggedOnly ? '1' : '0');
  if (f.hasAttachments !== df.hasAttachments) params.set('att', f.hasAttachments ? '1' : '0');
  if (!sameList(f.accountIds, df.accountIds)) params.set('acc', f.accountIds.join(','));
  if (!sameList(f.domains, df.domains)) params.set('dom', f.domains.join(','));
  if (!sameList(f.folderIds, df.folderIds)) params.set('fld', f.folderIds.join(','));
  if (!sameList(f.priorities, df.priorities)) params.set('pri', f.priorities.join(','));
  if (!sameList(f.labels, df.labels)) params.set('label', f.labels.join(','));
  if (f.since !== df.since) params.set('since', f.since ?? '');
  if (f.before !== df.before) params.set('before', f.before ?? '');

  const path = `/${segs.map(encodeURIComponent).join('/')}`;
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/* ── Comparison ───────────────────────────────────────────────────────────── */

export const sameScope = (a: Scope, b: Scope): boolean =>
  a.kind === b.kind && a.value === b.value && a.role === b.role;

export function sameFilters(a: ListQuery['filters'], b: ListQuery['filters']): boolean {
  return (
    a.unreadOnly === b.unreadOnly &&
    a.flaggedOnly === b.flaggedOnly &&
    a.hasAttachments === b.hasAttachments &&
    a.since === b.since &&
    a.before === b.before &&
    sameList(a.accountIds, b.accountIds) &&
    sameList(a.domains, b.domains) &&
    sameList(a.folderIds, b.folderIds) &&
    sameList(a.priorities, b.priorities) &&
    sameList(a.labels, b.labels)
  );
}

/* ── Coercion ─────────────────────────────────────────────────────────────── */

function safeDecode(s: string): string {
  // A stray "%" in a folder id would otherwise throw out of the router.
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function oneOf<T extends string>(raw: string | null, allowed: T[], fallback: T): T {
  return raw && (allowed as string[]).includes(raw) ? (raw as T) : fallback;
}

function role(raw: string | undefined): FolderRole | null {
  return raw && (ROLES as string[]).includes(raw) ? (raw as FolderRole) : null;
}

function bool(raw: string | null, fallback: boolean): boolean {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

function list(raw: string | null, fallback: string[]): string[] {
  if (raw === null) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
