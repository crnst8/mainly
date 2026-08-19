/**
 * The list's control bar and filter chips.
 *
 * Two modes in one strip: normal (scope + view controls) and selection (bulk
 * actions). Swapping the contents rather than stacking a second toolbar keeps
 * the controls in a fixed position — muscle memory survives the mode change.
 */

import { useState } from 'react';
import {
  Archive,
  Check,
  Chevron,
  Close,
  Dot,
  Group as GroupIcon,
  Layout,
  Refresh,
  Sort,
  Star,
  Trash,
} from '@/components/icons';
import { Field, IconButton, Modal, PopItem, PopLabel, PopSep, Popover } from '@/components/ui';
import { count as fmtCount } from '@/lib/format';
import { filterCount } from '@/lib/query';
import { narrowingFilters, scopeCrumbs, scopeLabel, searchNarrowing } from '@/lib/scope';
import { useStore } from '@/lib/store';
import type { Density, GroupKey, SortKey } from '@/lib/types';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'priority', label: 'Priority' },
  { key: 'sender', label: 'Sender' },
  { key: 'subject', label: 'Subject' },
  { key: 'unread', label: 'Unread first' },
  { key: 'size', label: 'Size' },
];

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'account', label: 'Account' },
  { key: 'domain', label: 'Domain' },
  { key: 'priority', label: 'Priority' },
  { key: 'sender', label: 'Sender' },
  { key: 'folder', label: 'Folder' },
  { key: 'none', label: 'No grouping' },
];

const DENSITIES: Density[] = ['compact', 'cosy', 'relaxed'];

export function ListBar() {
  const selected = useStore((s) => s.selectedIds);
  return selected.size > 0 ? <SelectionBar /> : <ViewBar />;
}

/* ── Normal mode ──────────────────────────────────────────────────────────── */

function ViewBar() {
  const query = useStore((s) => s.query);
  const result = useStore((s) => s.result);
  const prefs = useStore((s) => s.prefs);
  const patchQuery = useStore((s) => s.patchQuery);
  const patchFilters = useStore((s) => s.patchFilters);
  const saveTheme = useStore((s) => s.saveTheme);
  const savePrefs = useStore((s) => s.savePrefs);
  const refresh = useStore((s) => s.refresh);
  const busy = useStore((s) => s.sync.busy);

  const nFilters = filterCount(query.filters);

  return (
    <>
      <div className="listbar">
        <div className="listbar__scope">
          <Breadcrumb />
          {result && result.facets.unread > 0 && (
            <span className="listbar__meta tnum">{fmtCount(result.facets.unread)} unread</span>
          )}
        </div>

        <Popover
          trigger={(p) => (
            <button type="button" className="iconbtn" title="Sort" aria-label="Sort" {...p}>
              <Sort size={15} />
            </button>
          )}
          align="end"
        >
          {(close) => (
            <>
              <PopLabel>Sort by</PopLabel>
              {/* Relevance only exists under a search. Offering it elsewhere
                  would be a key that silently does nothing. */}
              {(query.scope.kind === 'search'
                ? [{ key: 'relevance' as SortKey, label: 'Relevance' }, ...SORTS]
                : SORTS
              ).map((s) => (
                <PopItem
                  key={s.key}
                  checked={query.sort === s.key}
                  onClick={() => {
                    patchQuery({ sort: s.key });
                    close();
                  }}
                >
                  {s.label}
                </PopItem>
              ))}
              <PopSep />
              <PopItem
                checked={query.dir === 'desc'}
                onClick={() => patchQuery({ dir: query.dir === 'desc' ? 'asc' : 'desc' })}
              >
                Newest / largest first
              </PopItem>
            </>
          )}
        </Popover>

        <Popover
          trigger={(p) => (
            <button type="button" className="iconbtn" title="Group" aria-label="Group" {...p}>
              <GroupIcon size={15} />
            </button>
          )}
          align="end"
        >
          {(close) => (
            <>
              <PopLabel>Group by</PopLabel>
              {GROUPS.map((g) => (
                <PopItem
                  key={g.key}
                  checked={query.group === g.key}
                  onClick={() => {
                    patchQuery({ group: g.key });
                    close();
                  }}
                >
                  {g.label}
                </PopItem>
              ))}
              <PopSep />
              <PopItem checked={query.threaded} onClick={() => patchQuery({ threaded: !query.threaded })}>
                Collapse threads
              </PopItem>
            </>
          )}
        </Popover>

        <Popover
          trigger={(p) => (
            <button type="button" className="iconbtn" title="Layout" aria-label="Layout" {...p}>
              <Layout size={15} />
            </button>
          )}
          align="end"
        >
          {(close) => (
            <>
              <PopLabel>Density</PopLabel>
              {DENSITIES.map((d) => (
                <PopItem
                  key={d}
                  checked={prefs?.theme.density === d}
                  onClick={() => {
                    void saveTheme({ density: d });
                    close();
                  }}
                >
                  {d[0]!.toUpperCase() + d.slice(1)}
                </PopItem>
              ))}
              <PopSep />
              <PopLabel>Preview pane</PopLabel>
              {(['right', 'bottom', 'off'] as const).map((p) => (
                <PopItem
                  key={p}
                  checked={prefs?.preview === p}
                  onClick={() => {
                    void savePrefs({ preview: p });
                    close();
                  }}
                >
                  {p === 'off' ? 'Off' : p === 'right' ? 'Right' : 'Bottom'}
                </PopItem>
              ))}
              <PopSep />
              <PopItem
                checked={prefs?.showAccountStripe}
                onClick={() => void savePrefs({ showAccountStripe: !prefs?.showAccountStripe })}
              >
                Account colour stripe
              </PopItem>
              <PopItem
                checked={prefs?.showAvatars}
                onClick={() => void savePrefs({ showAvatars: !prefs?.showAvatars })}
              >
                Sender monograms
              </PopItem>
            </>
          )}
        </Popover>

        <SaveViewButton />

        <IconButton
          label="Refresh"
          hint="r"
          onClick={() => void refresh()}
          style={busy ? { animation: 'spin 900ms linear infinite' } : undefined}
        >
          <Refresh size={15} />
        </IconButton>
      </div>

      <div className="chips">
        <SearchScopeChips />
        <Chip
          on={query.filters.unreadOnly}
          n={result?.facets.unread}
          onClick={() => patchFilters({ unreadOnly: !query.filters.unreadOnly })}
        >
          Unread
        </Chip>
        <Chip
          on={query.filters.flaggedOnly}
          n={result?.facets.flagged}
          onClick={() => patchFilters({ flaggedOnly: !query.filters.flaggedOnly })}
        >
          Flagged
        </Chip>
        <Chip
          on={query.filters.hasAttachments}
          n={result?.facets.withAttachments}
          onClick={() => patchFilters({ hasAttachments: !query.filters.hasAttachments })}
        >
          Attachments
        </Chip>

        <PriorityChip />

        {Object.entries(result?.facets.labels ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([label, n]) => (
            <Chip
              key={label}
              on={query.filters.labels.includes(label)}
              n={n}
              onClick={() =>
                patchFilters({
                  labels: query.filters.labels.includes(label)
                    ? query.filters.labels.filter((l) => l !== label)
                    : [...query.filters.labels, label],
                })
              }
            >
              {label}
            </Chip>
          ))}

        {nFilters > 0 && (
          <button
            type="button"
            className="chip"
            onClick={() =>
              patchFilters({
                unreadOnly: false,
                flaggedOnly: false,
                hasAttachments: false,
                labels: [],
                priorities: [],
                accountIds: [],
              })
            }
            style={{ marginLeft: 'auto', borderStyle: 'dashed' }}
          >
            <Close size={11} />
            Clear {nFilters}
          </button>
        )}
      </div>
    </>
  );
}

/* ── Save this view ────────────────────────────────────────────────────────
   A search you run twice is a view. The type and the rail already supported
   saved views; this is the affordance that was missing, and it sits next to the
   controls that produced the view rather than hidden in a menu. */

function SaveViewButton() {
  const scope = useStore((s) => s.query.scope);
  const filters = useStore((s) => s.query.filters);
  const views = useStore((s) => s.views);
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const save = useStore((s) => s.saveCurrentView);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const already = views.some((v) => v.id === scope.value && scope.kind === 'saved');
  // Nothing worth naming: the plain unified inbox with no filters is already
  // one keystroke away.
  const worthSaving =
    scope.kind === 'search' || filterCount(filters) > 0 || scope.kind === 'folder';
  if (already || !worthSaving) return null;

  const suggested = scopeLabel(scope, { accounts, folders, views });

  return (
    <>
      <IconButton
        label="Save this view"
        onClick={() => {
          setName(scope.kind === 'search' ? (scope.value ?? '') : suggested);
          setOpen(true);
        }}
      >
        <Star size={15} />
      </IconButton>

      {open && (
        <Modal
          title="Save this view"
          width={420}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!name.trim()}
                onClick={() => {
                  void save(name.trim(), name.trim()[0]!.toUpperCase());
                  setOpen(false);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <Field label="Name" hint="Appears in the rail and in ⌘K">
            <input
              className="input"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  void save(name.trim(), name.trim()[0]!.toUpperCase());
                  setOpen(false);
                }
              }}
            />
          </Field>
          {/* Show, don't tell: what gets saved is the view itself, so the view
              itself is what we display. */}
          <div className="savepreview">
            <Breadcrumb />
            {filterCount(filters) > 0 && (
              <span className="savepreview__meta">
                {filterCount(filters)} filter{filterCount(filters) > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ── Breadcrumb ────────────────────────────────────────────────────────────
   Where you are, spelled out, with every step above you clickable. It replaces
   a bare title because a title tells you the leaf and nothing about the branch:
   "Receipts" is four different folders across four accounts. */

function Breadcrumb() {
  const scope = useStore((s) => s.query.scope);
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const views = useStore((s) => s.views);
  const setScope = useStore((s) => s.setScope);

  const crumbs = scopeCrumbs(scope, { accounts, folders, views });

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <span className="crumbs__step" key={c.key}>
          {i > 0 && (
            <span className="crumbs__sep" aria-hidden="true">
              <Chevron size={11} dir="right" />
            </span>
          )}
          {c.scope ? (
            <button type="button" className="crumbs__link truncate" onClick={() => setScope(c.scope!)}>
              {c.label}
            </button>
          ) : (
            <span className="crumbs__here truncate" aria-current="page">
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/* ── Where a search looks ──────────────────────────────────────────────────
   Narrowing is implemented as filters, so it belongs in the filter row rather
   than floating under the search field: it sits with the other things
   restricting the result, and it is visible without hovering or remembering an
   operator. */

function SearchScopeChips() {
  const scope = useStore((s) => s.query.scope);
  const filters = useStore((s) => s.query.filters);
  const base = useStore((s) => s.searchBase);
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const views = useStore((s) => s.views);
  const patchFilters = useStore((s) => s.patchFilters);

  if (scope.kind !== 'search') return null;

  const narrowing = searchNarrowing(filters, { accounts, folders });
  const target = base && base.kind !== 'unified' ? base : null;
  if (!narrowing && !target) return null;

  const label = narrowing ?? (target ? scopeLabel(target, { accounts, folders, views }) : '');

  return (
    <>
      <button
        type="button"
        className="chip chip--scope"
        aria-pressed={!narrowing}
        onClick={() => patchFilters({ accountIds: [], domains: [], folderIds: [] })}
      >
        Everywhere
      </button>
      <button
        type="button"
        className="chip chip--scope truncate"
        aria-pressed={!!narrowing}
        disabled={!narrowing && !target}
        onClick={() => target && patchFilters(narrowingFilters(target))}
      >
        In {label}
      </button>
      <span className="chips__sep" />
    </>
  );
}

function Chip({
  on,
  n,
  onClick,
  children,
}: {
  on: boolean;
  n?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="chip" aria-pressed={on} onClick={onClick}>
      {children}
      {n !== undefined && n > 0 && <span className="chip__count tnum">{fmtCount(n)}</span>}
    </button>
  );
}

function PriorityChip() {
  const priorities = useStore((s) => s.query.filters.priorities);
  const facets = useStore((s) => s.result?.facets.priorities);
  const patchFilters = useStore((s) => s.patchFilters);

  return (
    <Popover
      trigger={(p) => (
        <button type="button" className="chip" aria-pressed={priorities.length > 0} {...p}>
          {priorities.length ? priorities.join(', ') : 'Priority'}
          <Chevron size={11} />
        </button>
      )}
    >
      {() => (
        <>
          <PopLabel>Show priority</PopLabel>
          {(['critical', 'high', 'normal', 'low', 'muted'] as const).map((p) => (
            <PopItem
              key={p}
              checked={priorities.includes(p)}
              onClick={() =>
                patchFilters({
                  priorities: priorities.includes(p)
                    ? priorities.filter((x) => x !== p)
                    : [...priorities, p],
                })
              }
            >
              {p[0]!.toUpperCase() + p.slice(1)}
              <span className="nav__count tnum" style={{ marginLeft: 'auto', paddingLeft: 8 }}>
                {facets?.[p] ?? 0}
              </span>
            </PopItem>
          ))}
        </>
      )}
    </Popover>
  );
}

/* ── Selection mode ───────────────────────────────────────────────────────── */

function SelectionBar() {
  const selected = useStore((s) => s.selectedIds);
  const messages = useStore((s) => s.result?.messages);
  const clear = useStore((s) => s.clearSelection);
  const selectAll = useStore((s) => s.selectAll);
  const setRead = useStore((s) => s.setRead);
  const setFlag = useStore((s) => s.setFlag);
  const archive = useStore((s) => s.archive);
  const trash = useStore((s) => s.trash);

  const ids = [...selected];
  const rows = (messages ?? []).filter((m) => selected.has(m.id));
  const total = messages?.length ?? 0;

  /*
   * What the buttons do is decided by the selection, and then said out loud.
   *
   * The rule is the one every mail client uses and none of them explain: a mixed
   * selection is brought *into* the state, not out of it. Twelve messages where
   * one is unread become twelve read, because that is what someone selecting
   * twelve and reaching for "read" means. The label changes with it, so the
   * button never claims to do the opposite of what it is about to do — which is
   * what a bare toggle here did roughly half the time.
   */
  const willRead = rows.some((m) => !m.seen);
  const willFlag = rows.some((m) => !m.flagged);

  return (
    <div className="listbar listbar--selecting">
      <IconButton label="Clear selection" hint="Esc" onClick={clear}>
        <Close size={15} />
      </IconButton>
      <span className="listbar__title tnum">{selected.size} selected</span>
      {selected.size < total && (
        <button type="button" className="btn btn--sm" onClick={selectAll} style={{ color: 'inherit', opacity: 0.75 }}>
          Select all {total}
        </button>
      )}
      <span className="listbar__spacer" />
      <IconButton
        label={willRead ? 'Mark read' : 'Mark unread'}
        hint="u"
        onClick={() => void setRead(ids, willRead)}
      >
        {willRead ? <Check size={15} /> : <Dot size={11} />}
      </IconButton>
      <IconButton
        label={willFlag ? `Flag ${selected.size}` : `Unflag ${selected.size}`}
        hint="s"
        on={!willFlag}
        onClick={() => void setFlag(ids, willFlag)}
      >
        <Star size={15} filled={!willFlag} />
      </IconButton>
      <span className="listbar__divider" />
      <IconButton label="Archive" hint="e" onClick={() => void archive()}>
        <Archive size={15} />
      </IconButton>
      <IconButton label="Move to trash" hint="#" onClick={() => void trash()}>
        <Trash size={15} />
      </IconButton>
    </div>
  );
}
