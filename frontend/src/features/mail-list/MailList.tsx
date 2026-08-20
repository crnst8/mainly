/**
 * The message list.
 *
 * Virtualised: only the rows in view are mounted. With a dozen accounts a
 * unified inbox is routinely 10k+ rows, and mounting them all is the difference
 * between a list that scrolls at 120fps and one that stutters on every wheel
 * tick. Group headers and rows share one flat index so scrolling, keyboard
 * focus, and the sticky header all read from the same array.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Attachment, Check, Dot, Star, Trash } from '@/components/icons';
import { Empty, IconButton, Mark } from '@/components/ui';
import { initials, listDate, displayName } from '@/lib/format';
import { parseSearch, searchTerms } from '@/lib/search';
import { homeScope, searchNarrowing } from '@/lib/scope';
import { useAccountColor, useGroups, useStore } from '@/lib/store';
import { firstItemAt } from '@/lib/virtual';
import type { Id, MessageSummary } from '@/lib/types';
import { useContextMenu } from '@/components/context-menu';
import { ListBar } from './ListBar';
import { MessageMenu } from './MessageMenu';
import './list.css';

const GROUP_H = 26;
const ROW_H: Record<string, number> = { compact: 32, cosy: 62, relaxed: 84 };
/** Rows rendered above and below the viewport. Enough that a fast flick never
 *  shows blank space, small enough that we are not mounting a screenful spare. */
const OVERSCAN = 6;

type Item =
  | {
      kind: 'group';
      key: string;
      label: string;
      hint: string | null;
      /** The group's members, so its header can select all of them without the
       *  list handing every header a copy of the grouping. */
      ids: Id[];
      top: number;
      h: number;
    }
  | { kind: 'row'; key: string; message: MessageSummary; top: number; h: number };

export function MailList() {
  const groups = useGroups();
  const result = useStore((s) => s.result);
  const loading = useStore((s) => s.loading);
  const stale = useStore((s) => s.stale);
  const density = useStore((s) => s.prefs?.theme.density ?? 'cosy');
  const groupKey = useStore((s) => s.query.group);
  const loadMore = useStore((s) => s.loadMore);
  const focusedId = useStore((s) => s.focusedId);
  const selecting = useStore((s) => s.selectedIds.size > 0);

  // Rows are the hot path, so the terms are parsed once for the whole list
  // rather than per row. Empty outside a search, which makes `Mark` a no-op.
  const scope = useStore((s) => s.query.scope);
  const terms = useMemo(
    () => (scope.kind === 'search' && scope.value ? searchTerms(parseSearch(scope.value)) : []),
    [scope.kind, scope.value],
  );

  /* One menu for the whole list, not one per row. Five hundred rows must not
     mean five hundred mounted menus that are almost always closed. */
  const menu = useContextMenu<MessageSummary>();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);

  const rowH = ROW_H[density] ?? 62;

  /* Flatten groups → positioned items. Recomputed only when the data, the
     grouping, or the density changes. */
  const { items, totalH } = useMemo(() => {
    const out: Item[] = [];
    let top = 0;
    for (const g of groups) {
      if (groupKey !== 'none') {
        out.push({
          kind: 'group',
          key: `g:${g.key}`,
          label: g.label,
          hint: g.hint,
          ids: g.messages.map((m) => m.id),
          top,
          h: GROUP_H,
        });
        top += GROUP_H;
      }
      for (const m of g.messages) {
        out.push({ kind: 'row', key: m.id, message: m, top, h: rowH });
        top += rowH;
      }
    }
    return { items: out, totalH: top };
  }, [groups, groupKey, rowH]);

  /*
   * Window.
   *
   * Found by binary search over the positioned items rather than by dividing
   * pixels by a row height. Rows and group headers are different heights (62 vs
   * 26 at cosy density), so `scrollTop / rowH` drifts by roughly half an item
   * per group header above the viewport — fine with four date groups, blank
   * space at the bottom of the list once you group by sender and there are
   * twenty. `items` is already sorted by `top`, so the search is exact and
   * costs nothing.
   */
  const start = Math.max(0, firstItemAt(items, scrollTop) - OVERSCAN);
  const end = Math.min(items.length, firstItemAt(items, scrollTop + viewportH) + 1 + OVERSCAN);
  const visible = items.slice(start, end);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // Prefetch a page before the user reaches the bottom.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) void loadMore();
  }, [loadMore]);

  /*
   * Keep the keyboard-focused row inside the viewport. This is what makes j/k
   * usable in a virtualised list — the row may not even be mounted yet.
   *
   * It runs on focus changes and *only* on focus changes. Depending on `items`
   * as well made this fire on every render, and since a render happens on every
   * scroll event, and the focused row is the first row until you move it, every
   * wheel tick scrolled the list straight back to the top. Scrolling was
   * impossible. `items` is read through a ref so the effect can use the current
   * positions without being woken by them.
   */
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!focusedId) return;
    const el = scrollerRef.current;
    const item = itemsRef.current.find((i) => i.kind === 'row' && i.message.id === focusedId);
    if (!el || !item) return;
    const above = item.top < el.scrollTop + GROUP_H;
    const below = item.top + item.h > el.scrollTop + el.clientHeight;
    if (above) el.scrollTo({ top: Math.max(0, item.top - GROUP_H), behavior: 'auto' });
    else if (below) el.scrollTo({ top: item.top + item.h - el.clientHeight, behavior: 'auto' });
  }, [focusedId]);

  /* Scroll back to the top when the scope changes — otherwise you land halfway
     down a list you have never seen. */
  const scopeKey = useStore((s) => `${s.query.scope.kind}:${s.query.scope.value}:${s.query.scope.role}`);
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [scopeKey]);

  const empty = !loading && !stale && result && result.messages.length === 0;

  return (
    <section className="list-pane" aria-label="Messages">
      {(loading || stale) && <div className="progress" />}
      <ListBar />

      {empty ? (
        <EmptyState />
      ) : !result ? (
        <SkeletonList rows={Math.ceil(viewportH / rowH)} />
      ) : (
        <div
          className="list scroll-y"
          ref={scrollerRef}
          onScroll={onScroll}
          tabIndex={-1}
          // Once anything is selected, every row shows its checkbox. Hunting for
          // a control that only appears under the cursor is the wrong game to
          // ask someone to play while picking twelve messages out of a hundred.
          data-selecting={selecting || undefined}
        >
          <div className="list__sizer" style={{ height: totalH }}>
            {visible.map((item) =>
              item.kind === 'group' ? (
                <GroupHeader key={item.key} item={item} />
              ) : (
                <Row
                  key={item.key}
                  message={item.message}
                  top={item.top}
                  terms={terms}
                  onMenu={menu.onContextMenu}
                />
              ),
            )}
          </div>
          {result.nextCursor && loading && <div className="list__foot">Loading…</div>}
        </div>
      )}

      <MessageMenu controller={menu} />
    </section>
  );
}

/* ── Group header ─────────────────────────────────────────────────────────── */

/**
 * A group header, and the group's select-all.
 *
 * "Everything from this sender", "everything from Tuesday" is the selection
 * people actually want in bulk, and the grouping has already drawn the box
 * around it — so the box is the control. Shift-clicking a five-hundred-row range
 * to reach the same set is the thing this replaces.
 */
function GroupHeader({ item }: { item: Extract<Item, { kind: 'group' }> }) {
  const selectedIds = useStore((s) => s.selectedIds);
  const selectMany = useStore((s) => s.selectMany);
  const all = item.ids.length > 0 && item.ids.every((id) => selectedIds.has(id));

  return (
    <div
      className="grouphead"
      style={{ transform: `translateY(${item.top}px)`, position: 'absolute', width: '100%' }}
    >
      <span className="grouphead__label">{item.label}</span>
      {item.hint && <span className="grouphead__hint">{item.hint}</span>}
      <span className="grouphead__rule" />
      <button
        type="button"
        className="grouphead__select"
        role="checkbox"
        aria-checked={all}
        aria-label={`${all ? 'Deselect' : 'Select'} ${item.ids.length} in ${item.label}`}
        onClick={() => selectMany(item.ids, !all)}
      >
        <span className="checkbox" data-on={all || undefined}>
          {all && <Check size={9} />}
        </span>
        <span className="grouphead__count tnum">{item.ids.length}</span>
      </button>
    </div>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────── */

function Row({
  message: m,
  top,
  terms,
  onMenu,
}: {
  message: MessageSummary;
  top: number;
  terms: string[];
  onMenu: (e: React.MouseEvent, subject: MessageSummary) => void;
}) {
  const focused = useStore((s) => s.focusedId === m.id);
  const selected = useStore((s) => s.selectedIds.has(m.id));
  const open = useStore((s) => s.openId === m.id);
  const showStripe = useStore((s) => s.prefs?.showAccountStripe ?? true);
  const showAvatar = useStore((s) => s.prefs?.showAvatars ?? true);
  const prefs = useStore((s) => s.prefs);
  const labelColors = prefs?.theme.labelColors ?? {};
  const colorOf = useAccountColor();

  const onOpen = useStore((s) => s.open);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const toggleFlag = useStore((s) => s.toggleFlag);
  const archive = useStore((s) => s.archive);
  const trash = useStore((s) => s.trash);

  const tint = colorOf(m.accountId);

  return (
    <div
      className="row-msg"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      style={{ transform: `translateY(${top}px)`, position: 'absolute', width: '100%', '--tint': tint } as React.CSSProperties}
      data-focused={focused || undefined}
      data-selected={selected || undefined}
      data-open={open || undefined}
      data-read={m.seen}
      data-stripe={showStripe}
      onClick={(e) => {
        if (e.shiftKey) toggleSelect(m.id, 'range');
        else if (e.metaKey || e.ctrlKey) toggleSelect(m.id, 'add');
        else void onOpen(m.id);
      }}
      onDoubleClick={() => void onOpen(m.id)}
      onContextMenu={(e) => {
        // Right-clicking outside the current selection moves the selection to
        // this row, so what the menu is about to act on is what is highlighted.
        // Right-clicking inside it leaves the selection alone — that is the
        // whole point of having selected twelve messages.
        if (!useStore.getState().selectedIds.has(m.id)) {
          useStore.getState().toggleSelect(m.id, 'single');
        }
        useStore.getState().focus(m.id);
        onMenu(e, m);
      }}
    >
      <span className="row-msg__stripe" />

      {/* One cell, two controls. The unread dot is what you read; the checkbox
          is what you reach for, and it takes the same 14px rather than a column
          of its own that would be empty most of the time. */}
      <span className="row-msg__lead">
        <button
          type="button"
          className="row-msg__state"
          data-read={m.seen}
          aria-label={m.seen ? 'Mark unread' : 'Mark read'}
          onClick={(e) => {
            e.stopPropagation();
            void useStore.getState().toggleRead([m.id]);
          }}
        >
          <Dot size={9} />
        </button>
        <button
          type="button"
          className="row-msg__check"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? 'Deselect message' : 'Select message'}
          onClick={(e) => {
            e.stopPropagation();
            // Shift here means the same thing it means on the row itself, so a
            // range can be picked out with the checkboxes alone.
            toggleSelect(m.id, e.shiftKey ? 'range' : 'add');
          }}
        >
          <span className="checkbox" data-on={selected || undefined}>
            {selected && <Check size={9} />}
          </span>
        </button>
      </span>

      {showAvatar ? (
        <span className="row-msg__avatar" style={{ '--tint': tint } as React.CSSProperties}>
          {initials(m.from)}
        </span>
      ) : (
        <span />
      )}

      <div className="row-msg__main">
        <div className="row-msg__line">
          <span className="row-msg__sender">
            <Mark text={displayName(m.from)} terms={terms} />
          </span>
          <span className="row-msg__subject truncate">
            <Mark text={m.subject} terms={terms} />
          </span>
        </div>
        <div className="row-msg__preview">
          <Mark text={m.preview} terms={terms} />
        </div>
      </div>

      <div className="row-msg__aside">
        <span className="row-msg__date tnum">{listDate(m.date)}</span>
        <div className="row-msg__marks">
          {m.labels.length > 0 && (
            <span className="row-msg__labels">
              {m.labels.slice(0, 3).map((l) => (
                <span
                  key={l}
                  className="row-msg__label"
                  title={l}
                  style={{ '--tint': labelColors[l] ?? 'var(--n-6)' } as React.CSSProperties}
                />
              ))}
            </span>
          )}
          {m.threadCount > 1 && <span className="row-msg__thread tnum">{m.threadCount}</span>}
          {m.hasAttachments && <Attachment size={12} />}
          {m.flagged && (
            <span className="row-msg__flag">
              <Star size={12} filled />
            </span>
          )}
        </div>
      </div>

      <div className="row-msg__hover" onClick={(e) => e.stopPropagation()}>
        <IconButton label="Flag" hint="s" on={m.flagged} onClick={() => void toggleFlag([m.id])}>
          <Star size={14} filled={m.flagged} />
        </IconButton>
        <IconButton label="Archive" hint="e" onClick={() => void archive([m.id])}>
          <Archive size={14} />
        </IconButton>
        <IconButton label="Trash" hint="#" onClick={() => void trash([m.id])}>
          <Trash size={14} />
        </IconButton>
      </div>
    </div>
  );
}

/* ── Placeholder states ───────────────────────────────────────────────────── */

function SkeletonList({ rows }: { rows: number }) {
  return (
    <div className="list">
      {Array.from({ length: Math.max(6, rows) }, (_, i) => (
        <div className="skeleton" key={i} style={{ opacity: 1 - i * 0.05 }}>
          <span />
          <span />
          <span className="skeleton__bar" style={{ width: 26, height: 26, borderRadius: 4 }} />
          <span className="skeleton__bar" style={{ width: `${40 + ((i * 37) % 45)}%` }} />
          <span className="skeleton__bar" style={{ width: 28 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const filters = useStore((s) => s.query.filters);
  const patchFilters = useStore((s) => s.patchFilters);
  const setScope = useStore((s) => s.setScope);
  const scope = useStore((s) => s.query.scope);
  const hasFilters =
    filters.unreadOnly || filters.flaggedOnly || filters.hasAttachments || filters.labels.length > 0;

  if (scope.kind === 'search') return <SearchEmpty />;
  if (hasFilters) {
    return (
      <Empty
        title="Nothing left"
        body="Every message in this view is filtered out."
        action={
          <button
            type="button"
            className="btn btn--outline"
            onClick={() =>
              patchFilters({ unreadOnly: false, flaggedOnly: false, hasAttachments: false, labels: [] })
            }
          >
            Clear filters
          </button>
        }
      />
    );
  }
  if (scope.kind !== 'unified' || scope.role !== 'inbox') {
    return (
      <Empty
        title="Nothing here"
        body="This folder is empty."
        action={
          <button type="button" className="btn btn--outline" onClick={() => setScope(homeScope())}>
            All mail
          </button>
        }
      />
    );
  }
  return <Empty title="Inbox zero" body="Nothing here. That is the whole point." />;
}

/**
 * A search that found nothing.
 *
 * The useful thing to offer is the *next narrower assumption to drop*, in
 * order: the place you limited it to, then the filters, then the operators that
 * may have been typos. Apologising for the absence of results helps nobody.
 */
function SearchEmpty() {
  const scope = useStore((s) => s.query.scope);
  const filters = useStore((s) => s.query.filters);
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);
  const patchFilters = useStore((s) => s.patchFilters);
  const setScope = useStore((s) => s.setScope);
  const bodySearch = useStore((s) => s.sync.bodySearch);

  const raw = scope.value ?? '';
  const parsed = parseSearch(raw);
  const narrowed = searchNarrowing(filters, { accounts, folders });
  const operators = parsed.groups.flat().filter((c) => c.field !== 'text');

  if (narrowed) {
    return (
      <Empty
        title={`Nothing in ${narrowed}`}
        body={`“${raw}” matches nothing in ${narrowed}. It may be somewhere else.`}
        action={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => patchFilters({ accountIds: [], domains: [], folderIds: [] })}
          >
            Search everywhere
          </button>
        }
      />
    );
  }

  if (operators.length) {
    return (
      <Empty
        title="Nothing found"
        body={`Nothing matches all of ${operators.length} condition${operators.length > 1 ? 's' : ''}. Dropping one usually finds it.`}
        action={
          <button
            type="button"
            className="btn btn--outline"
            onClick={() => {
              const terms = searchTerms(parsed);
              setScope(
                terms.length
                  ? { kind: 'search', value: terms.join(' '), role: null }
                  : homeScope(),
              );
            }}
          >
            {searchTerms(parsed).length ? 'Search the words only' : 'Back to all mail'}
          </button>
        }
      />
    );
  }

  return (
    <Empty
      title="Nothing found"
      body={
        bodySearch.indexed < bodySearch.total
          ? `Searching ${bodySearch.indexed.toLocaleString()} of ${bodySearch.total.toLocaleString()} messages — older mail is still being indexed.`
          : "Try a sender's name, or from: and has:attachment to narrow rather than widen."
      }
    />
  );
}
