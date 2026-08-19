/**
 * Naming a scope.
 *
 * Three places need to say where you are — the breadcrumb, the command
 * palette's recent list, and the account switcher — and they must agree,
 * because disagreeing is how a user learns not to trust the label. Shared here
 * rather than in a feature: nothing below is UI, it is the vocabulary the UI
 * uses.
 */

import type { Account, Folder, FolderRole, ListQuery, SavedView, Scope } from './types';

export interface ScopeContext {
  accounts: Account[];
  folders: Folder[];
  views: SavedView[];
}

export const ROLE_LABEL: Record<FolderRole, string> = {
  inbox: 'Inbox',
  drafts: 'Drafts',
  sent: 'Sent',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
  flagged: 'Flagged',
  all: 'All folders',
  custom: 'Folder',
};

export const HOME_LABEL = 'All mail';
export const HOME: Scope = { kind: 'unified', value: null, role: 'inbox' };

export const homeScope = (): Scope => ({ ...HOME });

/** A step on the path to where you are. `scope` is null on the last one — you
 *  are already there, so it is text rather than a target. */
export interface Crumb {
  key: string;
  label: string;
  scope: Scope | null;
}

/**
 * The trail from the unified inbox down to the current scope.
 *
 * Every step but the last is a real place, which is what makes "up one level" a
 * click rather than a trip through the sidebar. Home is always first, so you
 * are never more than one target away from it.
 */
export function scopeCrumbs(scope: Scope, ctx: ScopeContext): Crumb[] {
  const trail: Crumb[] = [{ key: 'home', label: HOME_LABEL, scope: homeScope() }];
  const role = (r: FolderRole) => trail.push({ key: `role:${r}`, label: ROLE_LABEL[r], scope: null });

  switch (scope.kind) {
    case 'unified':
      if (scope.role && scope.role !== 'inbox') role(scope.role);
      else if (!scope.role) trail.push({ key: 'role:every', label: 'Every folder', scope: null });
      break;

    case 'domain':
      trail.push({
        key: `dom:${scope.value}`,
        label: scope.value ?? 'Domain',
        scope: { kind: 'domain', value: scope.value, role: null },
      });
      if (scope.role) role(scope.role);
      break;

    // No domain step under an account. Three levels plus home does not fit the
    // list bar at any density, and the domain is already a permanent
    // edge-anchored target in the rail — spending a crumb on it buys nothing
    // and costs the account's name to truncation.
    case 'account': {
      const account = ctx.accounts.find((a) => a.id === scope.value);
      trail.push({
        key: `acc:${scope.value}`,
        label: account?.label ?? 'Account',
        scope: { kind: 'account', value: scope.value, role: null },
      });
      if (scope.role) role(scope.role);
      break;
    }

    case 'folder': {
      const folder = ctx.folders.find((f) => f.id === scope.value);
      const account = ctx.accounts.find((a) => a.id === folder?.accountId);
      if (account) {
        trail.push({
          key: `acc:${account.id}`,
          label: account.label,
          scope: { kind: 'account', value: account.id, role: null },
        });
      }
      trail.push({ key: `fld:${scope.value}`, label: folder?.name ?? 'Folder', scope: null });
      break;
    }

    case 'search':
      trail.push({ key: 'search', label: `“${scope.value ?? ''}”`, scope: null });
      break;

    case 'saved':
      trail.push({
        key: `view:${scope.value}`,
        label: ctx.views.find((v) => v.id === scope.value)?.name ?? 'View',
        scope: null,
      });
      break;
  }

  // Wherever the trail ends is where you are, so it stops being a link.
  trail.at(-1)!.scope = null;
  return trail;
}

/** One line for the same place — palette rows, switcher rows, titles. */
export function scopeLabel(scope: Scope, ctx: ScopeContext): string {
  const crumbs = scopeCrumbs(scope, ctx);
  return crumbs.length === 1
    ? crumbs[0]!.label
    : crumbs.slice(1).map((c) => c.label).join(' → ');
}

/* ── Narrowing a search ────────────────────────────────────────────────────
   Searching everywhere is the right default with twelve accounts — the whole
   point of the app is that you do not remember which address something came
   to. Narrowing is therefore expressed as *filters* rather than as a different
   scope: it composes with the query instead of replacing it, it shows up in the
   filter bar next to every other narrowing, and it travels in the URL for free. */

/** What the current filters narrow a search to, in words, or null for none. */
export function searchNarrowing(
  filters: ListQuery['filters'],
  ctx: Pick<ScopeContext, 'accounts' | 'folders'>,
): string | null {
  if (filters.folderIds.length === 1) {
    return ctx.folders.find((f) => f.id === filters.folderIds[0])?.name ?? 'this folder';
  }
  if (filters.accountIds.length === 1) {
    return ctx.accounts.find((a) => a.id === filters.accountIds[0])?.label ?? 'this account';
  }
  if (filters.domains.length === 1) return filters.domains[0]!;
  return null;
}

/** A scope expressed as the filters that reproduce it. */
export function narrowingFilters(scope: Scope): Partial<ListQuery['filters']> {
  const blank = { accountIds: [], domains: [], folderIds: [] };
  switch (scope.kind) {
    case 'domain':
      return { ...blank, domains: scope.value ? [scope.value] : [] };
    case 'account':
      return { ...blank, accountIds: scope.value ? [scope.value] : [] };
    case 'folder':
      return { ...blank, folderIds: scope.value ? [scope.value] : [] };
    default:
      return blank;
  }
}

/** The colour a scope carries, where it has one. */
export function scopeTint(
  scope: Scope,
  ctx: ScopeContext,
  domainColors: Record<string, string>,
): string | null {
  if (scope.kind === 'domain') return domainColors[scope.value ?? ''] ?? null;
  if (scope.kind === 'account') {
    const a = ctx.accounts.find((x) => x.id === scope.value);
    return a ? (a.color ?? domainColors[a.domain] ?? null) : null;
  }
  if (scope.kind === 'saved') return ctx.views.find((v) => v.id === scope.value)?.color ?? null;
  return null;
}
