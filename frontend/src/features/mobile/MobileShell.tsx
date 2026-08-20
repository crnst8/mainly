/**
 * The touch shell. Mounts below the 720px breakpoint instead of `AppShell` —
 * a separate list, reader, and chrome, sharing the same store and contract.
 *
 * Nothing here reaches into another feature's internals beyond what the shared
 * store and components expose. The desktop app is byte-for-byte untouched.
 */

import { useState } from 'react';
import { Chevron, Plus } from '@/components/icons';
import { MobileComposer } from './MobileComposer';
import { Onboarding } from '@/features/accounts/Onboarding';
import { Settings } from '@/features/settings/Settings';
import { SearchBox } from '@/features/shell/SearchBox';
import { Toasts } from '@/features/shell/AppShell';
import { useRouter } from '@/lib/router';
import { useDomains, useStore } from '@/lib/store';
import { homeScope, ROLE_LABEL } from '@/lib/scope';
import type { FolderRole, Scope } from '@/lib/types';
import { MobileList } from './MobileList';
import { MobileReader } from './MobileReader';
import { Sheet } from './Sheet';
import './mobile.css';

export function MobileShell() {
  useRouter();
  const compose = useStore((s) => s.compose);
  const settings = useStore((s) => s.settings);
  const onboarding = useStore((s) => s.onboarding);
  const openId = useStore((s) => s.openId);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  return (
    <div className="mobile">
      <MobileTopbar onOpenScope={() => setScopeOpen(true)} onOpenFilter={() => setFilterOpen(true)} />

      <div className="mobile__searchrow">
        <div className="mobile__search">
          <SearchBox />
        </div>
        <button
          type="button"
          className="mobile__compose"
          aria-label="Compose"
          onClick={() => compose()}
        >
          <Plus size={20} />
        </button>
      </div>

      <MobileList />

      {openId && <MobileReader />}

      <ScopeSheet open={scopeOpen} onClose={() => setScopeOpen(false)} />
      <FilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} />

      <MobileComposer />
      <Toasts />
      {settings && <Settings />}
      {onboarding && <Onboarding />}
    </div>
  );
}

/* ── Topbar ──────────────────────────────────────────────────────────────── */

function MobileTopbar({
  onOpenScope,
  onOpenFilter,
}: {
  onOpenScope: () => void;
  onOpenFilter: () => void;
}) {
  const goHome = useStore((s) => s.goHome);
  const setSettings = useStore((s) => s.setSettings);
  const result = useStore((s) => s.result);
  const unread = result?.facets.unread ?? 0;
  const filters = useStore((s) => s.query.filters);
  const patchFilters = useStore((s) => s.patchFilters);

  return (
    <header className="mobile__topbar">
      <button type="button" className="mobile__mark" aria-label="All mail" onClick={goHome}>
        {/* Both variants ship and CSS picks one, matching AppShell. */}
        {/* BASE_URL, not a bare "/…": Vite rewrites asset paths in index.html and
            in CSS url(), but a string literal in JSX is opaque to it. A build
            mounted anywhere other than the site root asks the origin for
            /logo/… and gets a 404. */}
        <img
          className="mobile__logo"
          src={`${import.meta.env.BASE_URL}logo/logo-128.png`}
          alt=""
          width={20}
          height={20}
        />
        <img
          className="mobile__logo mobile__logo--dark"
          src={`${import.meta.env.BASE_URL}logo/logo-light-128.png`}
          alt=""
          width={20}
          height={20}
        />
      </button>

      <div className="mobile__chips">
        <Chip
          label="Unread"
          count={unread}
          active={filters.unreadOnly}
          onClick={() => patchFilters({ unreadOnly: !filters.unreadOnly })}
        />
        <Chip
          label="Important"
          active={filters.flaggedOnly}
          onClick={() => patchFilters({ flaggedOnly: !filters.flaggedOnly })}
        />
        <Chip label="Show emails for" caret onClick={onOpenScope} />
        <Chip label="Filter" caret onClick={onOpenFilter} />
      </div>

      <button
        type="button"
        className="mobile__gear"
        aria-label="Settings"
        onClick={() => setSettings('mobile')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <path
            d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </header>
  );
}

function Chip({
  label,
  count,
  active,
  caret,
  onClick,
}: {
  label: string;
  count?: number;
  active?: boolean;
  caret?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="mobile__chip"
      data-active={active || undefined}
      onClick={onClick}
    >
      {label}
      {count !== undefined && <span className="mobile__chipcount tnum">{count}</span>}
      {caret && <Chevron size={11} />}
    </button>
  );
}

/* ── Scope sheet ─────────────────────────────────────────────────────────── */

function ScopeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const domains = useDomains();
  const setScope = useStore((s) => s.setScope);
  const query = useStore((s) => s.query);

  const go = (scope: Scope) => {
    setScope(scope);
    onClose();
  };

  const roles: FolderRole[] = ['inbox', 'flagged', 'sent', 'drafts', 'archive', 'trash', 'junk'];

  return (
    <Sheet open={open} onClose={onClose} title="Show emails for">
      <div className="sheet__list">
        <SheetRow
          label="All mail"
          hint="Every mailbox"
          on={query.scope.kind === 'unified' && query.scope.role === 'inbox'}
          onClick={() => go(homeScope())}
        />
        {roles.map((r) => (
          <SheetRow
            key={r}
            label={ROLE_LABEL[r]}
            hint="across all accounts"
            on={query.scope.kind === 'unified' && query.scope.role === r}
            onClick={() => go({ kind: 'unified', value: null, role: r })}
          />
        ))}
        {domains.map((d) => (
          <SheetRow
            key={d.domain}
            label={d.domain}
            hint={`${d.accounts.length} account${d.accounts.length > 1 ? 's' : ''}`}
            on={query.scope.kind === 'domain' && query.scope.value === d.domain}
            onClick={() => go({ kind: 'domain', value: d.domain, role: null })}
          />
        ))}
        {accounts.map((a) => (
          <SheetRow
            key={a.id}
            label={a.label}
            hint={a.address}
            on={query.scope.kind === 'account' && query.scope.value === a.id}
            onClick={() => go({ kind: 'account', value: a.id, role: 'inbox' })}
          />
        ))}
        {folders.map((f) => (
          <SheetRow
            key={f.id}
            label={f.name}
            hint="folder"
            on={query.scope.kind === 'folder' && query.scope.value === f.id}
            onClick={() => go({ kind: 'folder', value: f.id, role: null })}
          />
        ))}
      </div>
    </Sheet>
  );
}

/* ── Filter sheet ────────────────────────────────────────────────────────── */

const SORTS: { value: 'date' | 'priority' | 'sender' | 'subject' | 'unread'; label: string }[] = [
  { value: 'date', label: 'Date' },
  { value: 'priority', label: 'Priority' },
  { value: 'sender', label: 'Sender' },
  { value: 'subject', label: 'Subject' },
  { value: 'unread', label: 'Unread' },
];

const GROUPS: { value: 'none' | 'date' | 'account' | 'sender'; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'date', label: 'Date' },
  { value: 'account', label: 'Account' },
  { value: 'sender', label: 'Sender' },
];

function FilterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const filters = useStore((s) => s.query.filters);
  const query = useStore((s) => s.query);
  const patchFilters = useStore((s) => s.patchFilters);
  const patchQuery = useStore((s) => s.patchQuery);
  // Select the raw result and derive here. `Object.keys` in the selector builds
  // a new array every call, which re-renders forever.
  const result = useStore((s) => s.result);
  const labels = Object.keys(result?.facets.labels ?? {});

  const toggleLabel = (l: string) =>
    patchFilters({
      labels: filters.labels.includes(l)
        ? filters.labels.filter((x) => x !== l)
        : [...filters.labels, l],
    });

  return (
    <Sheet open={open} onClose={onClose} title="Filter">
      <div className="sheet__sectionhead label">Sort</div>
      <div className="sheet__seg">
        {SORTS.map((s) => (
          <button
            key={s.value}
            type="button"
            className="sheet__segitem"
            data-on={query.sort === s.value}
            onClick={() => patchQuery({ sort: s.value })}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="sheet__sectionhead label">Group</div>
      <div className="sheet__seg">
        {GROUPS.map((g) => (
          <button
            key={g.value}
            type="button"
            className="sheet__segitem"
            data-on={query.group === g.value}
            onClick={() => patchQuery({ group: g.value })}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="sheet__sectionhead label">Narrow</div>
      <div className="sheet__list">
        <SheetRow
          label="With attachments"
          on={filters.hasAttachments}
          onClick={() => patchFilters({ hasAttachments: !filters.hasAttachments })}
        />
        <SheetRow
          label="Unread only"
          on={filters.unreadOnly}
          onClick={() => patchFilters({ unreadOnly: !filters.unreadOnly })}
        />
        <SheetRow
          label="Important (pinned)"
          on={filters.flaggedOnly}
          onClick={() => patchFilters({ flaggedOnly: !filters.flaggedOnly })}
        />
        {labels.map((l) => (
          <SheetRow
            key={l}
            label={`Label: ${l}`}
            on={filters.labels.includes(l)}
            onClick={() => toggleLabel(l)}
          />
        ))}
      </div>
    </Sheet>
  );
}

/* ── Shared sheet row ────────────────────────────────────────────────────── */

function SheetRow({
  label,
  hint,
  on,
  onClick,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="sheet__row" data-on={on || undefined} onClick={onClick}>
      <span className="sheet__rowlabel truncate">
        {label}
        {hint && <span className="sheet__rowhint truncate">{hint}</span>}
      </span>
      {on && <span className="sheet__rowcheck">✓</span>}
    </button>
  );
}
