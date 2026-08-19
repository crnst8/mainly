/**
 * The search field, its suggestions, and its scoping toggle.
 *
 * Three things happen in one control, so the ordering rules matter:
 *
 *  - **Completing beats running.** Enter with a suggestion highlighted completes
 *    the token; Enter with nothing highlighted runs the search. Otherwise the
 *    keyboard path has to guess.
 *  - **Suggestions are contextual to the token under the cursor**, not to the
 *    whole query. Typing `from:an` offers senders, not operators — the operator
 *    list is only useful before you have committed to one.
 *  - **Nothing here is a modal.** The list can be ignored entirely; typing and
 *    pressing Enter has always worked and still does.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Close, Folder as FolderIcon, Globe, Search, Star, User } from '@/components/icons';
import { IconButton, Kbd } from '@/components/ui';
import { OPERATORS } from '@/lib/search';
import { useStore } from '@/lib/store';

interface Suggestion {
  /** What replaces the token under the cursor. */
  insert: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  group: string;
  /** Recent searches replace the whole query, not just a token. */
  whole?: boolean;
}

const DEBOUNCE_MS = 180;

export function SearchBox() {
  const scope = useStore((s) => s.query.scope);
  const setScope = useStore((s) => s.setScope);
  const searching = scope.kind === 'search';

  const [value, setValue] = useState(searching ? (scope.value ?? '') : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number>(0);

  // Follow navigation that happened elsewhere — a rail click, Back, a deep
  // link. Only the scope can tell us; the input is otherwise the user's.
  useEffect(() => {
    setValue(scope.kind === 'search' ? (scope.value ?? '') : '');
  }, [scope.kind, scope.value]);

  const suggestions = useSuggestions(value, inputRef.current?.selectionStart ?? value.length);
  const shown = open ? suggestions : [];

  const commit = (raw: string, immediate = false) => {
    window.clearTimeout(timer.current);
    // A half-typed operator is not a query. Running `from:` would empty the
    // list and answer "nothing found" to someone who has not finished asking.
    if (!immediate && /(^|\s)[a-z]+:$/i.test(raw)) return;
    const run = () => {
      const next = raw.trim();
      if (next) setScope({ kind: 'search', value: next, role: null });
      else if (searching) setScope({ kind: 'unified', value: null, role: 'inbox' });
    };
    // Debounced while typing — 180ms skips intermediate keystrokes and still
    // reads as "results follow the typing". Immediate on Enter.
    if (immediate) run();
    else timer.current = window.setTimeout(run, DEBOUNCE_MS);
  };

  const accept = (s: Suggestion) => {
    const caret = inputRef.current?.selectionStart ?? value.length;
    const next = s.whole ? s.insert : replaceToken(value, caret, s.insert);
    setValue(next);
    setActive(-1);
    // An operator that still needs a value leaves the caret after the colon and
    // the list open; a complete one runs.
    const needsValue = !s.whole && next.endsWith(':');
    if (!needsValue) commit(next, true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const at = next.length;
      inputRef.current?.setSelectionRange(at, at);
    });
  };

  return (
    <div className="searchwrap">
      <div className="search" data-open={open && shown.length > 0}>
        <Search size={14} />
        <input
          ref={inputRef}
          data-search-input
          value={value}
          placeholder="Search mail — try from: or has:attachment"
          aria-label="Search mail"
          role="combobox"
          aria-expanded={open && shown.length > 0}
          aria-controls="search-suggestions"
          aria-activedescendant={active >= 0 ? `search-sug-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Let a click on a suggestion land before the list disappears.
            window.setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            setValue(e.target.value);
            setActive(-1);
            setOpen(true);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(-1, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (active >= 0 && shown[active]) accept(shown[active]!);
              else {
                commit(value, true);
                setOpen(false);
                inputRef.current?.blur();
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (open && shown.length) {
                setOpen(false);
                setActive(-1);
              } else if (value) {
                setValue('');
                commit('', true);
              } else {
                inputRef.current?.blur();
              }
            } else if (e.key === 'Tab' && active >= 0 && shown[active]) {
              e.preventDefault();
              accept(shown[active]!);
            }
          }}
        />
        {value ? (
          <IconButton
            label="Clear search"
            onClick={() => {
              setValue('');
              commit('', true);
              inputRef.current?.focus();
            }}
          >
            <Close size={13} />
          </IconButton>
        ) : (
          <Kbd>/</Kbd>
        )}
      </div>

      {open && shown.length > 0 && (
        <SuggestionList items={shown} active={active} onHover={setActive} onPick={accept} />
      )}

    </div>
  );
}

/* ── Suggestions ──────────────────────────────────────────────────────────── */

function SuggestionList({
  items,
  active,
  onHover,
  onPick,
}: {
  items: Suggestion[];
  active: number;
  onHover: (i: number) => void;
  onPick: (s: Suggestion) => void;
}) {
  const groups: [string, { s: Suggestion; i: number }[]][] = [];
  items.forEach((s, i) => {
    const last = groups.at(-1);
    if (last && last[0] === s.group) last[1].push({ s, i });
    else groups.push([s.group, [{ s, i }]]);
  });

  return (
    <div className="suggest" id="search-suggestions" role="listbox" aria-label="Search suggestions">
      {groups.map(([group, rows]) => (
        <div key={group}>
          <div className="suggest__group label">{group}</div>
          {rows.map(({ s, i }) => (
            <button
              key={`${group}:${s.insert}:${i}`}
              id={`search-sug-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className="suggest__item"
              data-active={i === active}
              onMouseMove={() => onHover(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(s)}
            >
              {s.icon}
              <span className="truncate">{s.label}</span>
              {s.hint && <span className="suggest__hint truncate">{s.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * What to offer for the token under the caret.
 *
 * Capped hard at eight rows. A suggestion list you have to read is slower than
 * the typing it was meant to save (Hick).
 */
function useSuggestions(value: string, caret: number): Suggestion[] {
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const result = useStore((s) => s.result);
  const recent = useStore((s) => s.recentSearches);

  return useMemo(() => {
    const token = tokenAt(value, caret);
    const lower = token.toLowerCase();
    const out: Suggestion[] = [];

    const colon = token.indexOf(':');
    const field = colon > 0 ? token.slice(0, colon).toLowerCase() : null;
    const partial = colon > 0 ? token.slice(colon + 1).toLowerCase().replace(/^"/, '') : '';
    const quote = (v: string) => (v.includes(' ') ? `"${v}"` : v);

    /* Committed to an operator: offer values for it. */
    if (field === 'from' || field === 'to') {
      const seen = new Set<string>();
      for (const m of result?.messages ?? []) {
        const a = m.from;
        if (seen.has(a.address)) continue;
        if (partial && !`${a.name ?? ''} ${a.address}`.toLowerCase().includes(partial)) continue;
        seen.add(a.address);
        out.push({
          insert: `${field}:${quote(a.address)}`,
          label: a.name ?? a.address,
          hint: a.address,
          icon: <User size={14} />,
          group: 'Senders',
        });
        if (seen.size >= 6) break;
      }
      for (const a of accounts) {
        if (partial && !a.address.toLowerCase().includes(partial)) continue;
        if (seen.has(a.address)) continue;
        seen.add(a.address);
        out.push({
          insert: `${field}:${a.address}`,
          label: a.label,
          hint: a.address,
          icon: <User size={14} />,
          group: 'Your addresses',
        });
      }
      const domains = [...new Set(accounts.map((a) => a.domain))];
      for (const d of domains) {
        if (!partial || !d.includes(partial)) continue;
        out.push({
          insert: `${field}:${d}`,
          label: d,
          icon: <Globe size={14} />,
          group: 'Domains',
        });
      }
      return out.slice(0, 8);
    }

    if (field === 'label' || field === 'tag') {
      for (const l of Object.keys(result?.facets.labels ?? {})) {
        if (partial && !l.toLowerCase().includes(partial)) continue;
        out.push({
          insert: `label:${quote(l)}`,
          label: l,
          hint: String(result?.facets.labels[l] ?? ''),
          icon: <Star size={14} />,
          group: 'Labels',
        });
      }
      return out.slice(0, 8);
    }

    if (field === 'folder' || field === 'in') {
      const names = [...new Set(folders.map((f) => f.name))];
      for (const n of names) {
        if (partial && !n.toLowerCase().includes(partial)) continue;
        out.push({
          insert: `folder:${quote(n)}`,
          label: n,
          icon: <FolderIcon size={14} />,
          group: 'Folders',
        });
      }
      return out.slice(0, 8);
    }

    if (field === 'after' || field === 'before' || field === 'since') {
      for (const when of ['today', 'yesterday', 'last week', 'last month', '7d', '2026-01-01']) {
        if (partial && !when.startsWith(partial)) continue;
        out.push({
          insert: `${field}:${quote(when)}`,
          label: when,
          icon: <Clock size={14} />,
          group: 'When',
        });
      }
      return out.slice(0, 8);
    }

    /* Not yet committed: operators that start with what has been typed, then
       recent searches when the box is still empty. */
    for (const op of OPERATORS) {
      if (lower && !op.token.startsWith(lower)) continue;
      out.push({
        insert: op.token,
        label: op.token,
        hint: op.hint,
        icon: <Search size={14} />,
        group: 'Narrow by',
      });
    }

    if (!token) {
      for (const r of recent) {
        out.push({
          insert: r,
          label: r,
          icon: <Clock size={14} />,
          group: 'Recent searches',
          whole: true,
        });
      }
    }

    return out.slice(0, 8);
  }, [value, caret, accounts, folders, result, recent]);
}

/** The whitespace-delimited token the caret sits in. */
function tokenAt(value: string, caret: number): string {
  const start = value.lastIndexOf(' ', Math.max(0, caret - 1)) + 1;
  const endAt = value.indexOf(' ', caret);
  return value.slice(start, endAt === -1 ? value.length : endAt);
}

function replaceToken(value: string, caret: number, insert: string): string {
  const start = value.lastIndexOf(' ', Math.max(0, caret - 1)) + 1;
  const endAt = value.indexOf(' ', caret);
  const end = endAt === -1 ? value.length : endAt;
  const tail = value.slice(end);
  const joiner = insert.endsWith(':') ? '' : tail.startsWith(' ') ? '' : ' ';
  return `${value.slice(0, start)}${insert}${joiner}${tail}`.replace(/\s+$/, insert.endsWith(':') ? '' : ' ');
}
