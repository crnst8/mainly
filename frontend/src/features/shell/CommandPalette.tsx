/**
 * ⌘K. One target for everything: jump to an account, domain, folder or saved
 * view; change sort, grouping, density or theme; act on the current selection.
 *
 * Ranked, not filtered alphabetically — a prefix match on the label beats a
 * substring match anywhere else, so the thing you meant is nearly always first.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Clock,
  Command,
  Folder as FolderIcon,
  Globe,
  Group as GroupIcon,
  Inbox,
  Key,
  Layout,
  Palette,
  Plus,
  Question,
  Search,
  Settings as SettingsIcon,
  SignOut,
  Sort,
  Star,
  Trash,
  User,
} from '@/components/icons';
import { Kbd } from '@/components/ui';
import { scopeLabel } from '@/lib/scope';
import { sameScope } from '@/lib/url';
import { useStore } from '@/lib/store';
import type { Density, GroupKey, SortKey } from '@/lib/types';

interface Cmd {
  id: string;
  label: string;
  group: string;
  hint?: string[];
  icon?: React.ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useCommands(() => setPalette(false));

  const results = useMemo(() => rank(commands, q).slice(0, 40), [commands, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const grouped: [string, Cmd[]][] = [];
  for (const c of results) {
    const last = grouped.at(-1);
    if (last && last[0] === c.group) last[1].push(c);
    else grouped.push([c.group, [c]]);
  }

  let index = -1;

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Jump to, or run a command…"
            aria-label="Command"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
                e.preventDefault();
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                results[active]?.run();
              }
            }}
          />
          {q && (
            <button type="button" className="btn btn--sm" onClick={() => setQ('')}>
              Clear
            </button>
          )}
        </div>

        <div className="palette__list" ref={listRef}>
          {results.length === 0 && (
            <div className="palette__group label" style={{ padding: 'var(--s-7)' }}>
              Nothing matches “{q}”
            </div>
          )}
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="palette__group label">{group}</div>
              {items.map((c) => {
                index++;
                const i = index;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="palette__item"
                    data-index={i}
                    data-active={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={c.run}
                  >
                    {c.icon}
                    <span className="truncate">{c.label}</span>
                    {c.hint && (
                      <span className="palette__item__hint">
                        {c.hint.map((k, n) => (
                          <Kbd key={n}>{k}</Kbd>
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="palette__foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Command set ──────────────────────────────────────────────────────────── */

function useCommands(close: () => void): Cmd[] {
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const views = useStore((s) => s.views);
  const prefs = useStore((s) => s.prefs);
  const recentScopes = useStore((s) => s.recentScopes);
  const scope = useStore((s) => s.query.scope);

  return useMemo(() => {
    const s = useStore.getState();
    const run = (fn: () => void) => () => {
      fn();
      close();
    };
    const cmds: Cmd[] = [];
    const ctx = { accounts, folders, views };

    /* Recently visited, newest first, above everything else.
       Serial position: the top of the list is the cheapest thing to reach, and
       the place you want next is usually the place you were just before. */
    for (const scope of s.recentScopes) {
      // Offering where you already are is a wasted row at the top of the list.
      if (sameScope(scope, s.query.scope)) continue;
      cmds.push({
        id: `recent:${scope.kind}:${scope.value}:${scope.role}`,
        label: scopeLabel(scope, ctx),
        group: 'Recent',
        icon: <Clock size={15} />,
        run: run(() => s.setScope(scope)),
      });
    }

    /* Places */
    cmds.push({
      id: 'go:all',
      label: 'All mail',
      group: 'Go to',
      icon: <Inbox size={15} />,
      hint: ['g', 'h'],
      run: run(() => s.goHome()),
    });

    const domains = [...new Set(accounts.map((a) => a.domain))];
    for (const d of domains) {
      cmds.push({
        id: `go:domain:${d}`,
        label: d,
        group: 'Go to',
        icon: <Globe size={15} />,
        run: run(() => s.setScope({ kind: 'domain', value: d, role: 'inbox' })),
      });
    }

    for (const a of accounts) {
      cmds.push({
        id: `go:acc:${a.id}`,
        label: `${a.label} — ${a.address}`,
        group: 'Go to',
        icon: <User size={15} />,
        run: run(() => s.setScope({ kind: 'account', value: a.id, role: 'inbox' })),
      });
    }

    for (const v of views) {
      cmds.push({
        id: `go:view:${v.id}`,
        label: v.name,
        group: 'Go to',
        icon: <Star size={15} />,
        run: run(() => s.openView(v.id)),
      });
    }

    // Folders are the long tail — only offered once the user has typed.
    for (const f of folders.filter((f) => f.role === 'custom')) {
      const account = accounts.find((a) => a.id === f.accountId);
      cmds.push({
        id: `go:fld:${f.id}`,
        label: `${f.name} · ${account?.label ?? ''}`,
        group: 'Folders',
        icon: <FolderIcon size={15} />,
        run: run(() => s.setScope({ kind: 'folder', value: f.id, role: null })),
      });
    }

    /* Actions on the current selection */
    const n = s.selectedIds.size || (s.focusedId ? 1 : 0);
    if (n) {
      cmds.push(
        {
          id: 'act:archive',
          label: `Archive ${n} message${n > 1 ? 's' : ''}`,
          group: 'Act',
          icon: <Archive size={15} />,
          hint: ['e'],
          run: run(() => void s.archive()),
        },
        {
          id: 'act:trash',
          label: `Move ${n} to trash`,
          group: 'Act',
          icon: <Trash size={15} />,
          hint: ['#'],
          run: run(() => void s.trash()),
        },
        {
          id: 'act:read',
          label: 'Toggle read',
          group: 'Act',
          icon: <Inbox size={15} />,
          hint: ['u'],
          run: run(() => void s.toggleRead()),
        },
        {
          id: 'act:flag',
          label: 'Toggle flag',
          group: 'Act',
          icon: <Star size={15} />,
          hint: ['s'],
          run: run(() => void s.toggleFlag()),
        },
      );
    }

    cmds.push({
      id: 'act:compose',
      label: 'Compose new message',
      group: 'Act',
      icon: <Plus size={15} />,
      hint: ['c'],
      run: run(() => s.compose()),
    });

    /* View */
    const sorts: SortKey[] = ['date', 'priority', 'sender', 'subject', 'unread', 'size'];
    for (const k of sorts) {
      cmds.push({
        id: `view:sort:${k}`,
        label: `Sort by ${k}`,
        group: 'View',
        icon: <Sort size={15} />,
        run: run(() => s.patchQuery({ sort: k })),
      });
    }

    const groups: GroupKey[] = ['date', 'account', 'domain', 'priority', 'sender', 'none'];
    for (const k of groups) {
      cmds.push({
        id: `view:group:${k}`,
        label: k === 'none' ? 'Remove grouping' : `Group by ${k}`,
        group: 'View',
        icon: <GroupIcon size={15} />,
        run: run(() => s.patchQuery({ group: k })),
      });
    }

    for (const d of ['compact', 'cosy', 'relaxed'] as Density[]) {
      cmds.push({
        id: `view:density:${d}`,
        label: `Density: ${d}`,
        group: 'View',
        icon: <Layout size={15} />,
        run: run(() => void s.saveTheme({ density: d })),
      });
    }

    cmds.push({
      id: 'view:threads',
      label: s.query.threaded ? 'Expand threads' : 'Collapse threads',
      group: 'View',
      icon: <GroupIcon size={15} />,
      run: run(() => s.patchQuery({ threaded: !s.query.threaded })),
    });

    cmds.push({
      id: 'view:save',
      label: 'Save this view…',
      group: 'View',
      icon: <Star size={15} />,
      run: run(() => {
        const name = prompt('Name this view');
        if (name) void s.saveCurrentView(name, name[0]!.toUpperCase());
      }),
    });

    /* App */
    cmds.push(
      {
        id: 'app:theme',
        label: `Switch to ${prefs?.theme.mode === 'dark' ? 'light' : 'dark'} mode`,
        group: 'App',
        icon: <Palette size={15} />,
        run: run(() => void s.saveTheme({ mode: prefs?.theme.mode === 'dark' ? 'light' : 'dark' })),
      },
      {
        id: 'app:settings',
        label: 'Settings',
        group: 'App',
        icon: <SettingsIcon size={15} />,
        hint: [','],
        run: run(() => s.setSettings('appearance')),
      },
      {
        id: 'app:accounts',
        label: 'Add an account',
        group: 'App',
        icon: <Plus size={15} />,
        run: run(() => s.setOnboarding(true)),
      },
      {
        id: 'app:help',
        label: 'Help and guides',
        group: 'App',
        icon: <Question size={15} />,
        hint: ['?'],
        run: run(() => s.setHelp('start')),
      },
      {
        id: 'app:keys',
        label: 'Keyboard shortcuts',
        group: 'App',
        icon: <Command size={15} />,
        run: run(() => s.setHelp('shortcuts')),
      },
      {
        id: 'app:password',
        label: 'Change your password',
        group: 'App',
        icon: <Key size={15} />,
        run: run(() => s.setSettings('signin')),
      },
      {
        id: 'app:signout',
        label: 'Sign out',
        group: 'App',
        icon: <SignOut size={15} />,
        run: run(() => void s.signOut()),
      },
      {
        id: 'app:sync',
        label: 'Sync all accounts now',
        group: 'App',
        icon: <SettingsIcon size={15} />,
        run: run(() => {
          void s.refresh();
          s.toast('Syncing all accounts');
        }),
      },
    );

    return cmds;
  }, [accounts, folders, views, prefs, recentScopes, scope, close]);
}

/* ── Ranking ──────────────────────────────────────────────────────────────── */

function rank(cmds: Cmd[], q: string): Cmd[] {
  if (!q.trim()) return cmds.filter((c) => c.group !== 'Folders');
  const needle = q.toLowerCase();

  const scored: { c: Cmd; score: number }[] = [];
  for (const c of cmds) {
    const label = c.label.toLowerCase();
    let score = 0;
    if (label.startsWith(needle)) score = 100;
    else if (label.includes(` ${needle}`)) score = 80;
    else if (label.includes(needle)) score = 60;
    else if (subsequence(label, needle)) score = 30;
    else continue;
    // Shorter labels win ties — "Sent" over "Sent — dale@bigchungus.holdings".
    score -= Math.min(20, label.length / 4);
    scored.push({ c, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((x) => x.c);
}

/** Fuzzy fallback: "gdom" matches "Go to domain". */
function subsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}
