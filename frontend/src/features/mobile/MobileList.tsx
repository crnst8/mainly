/**
 * The mobile message list — the same windowing shape as the desktop list, at a
 * fixed touch-row height. Flatten groups → positioned items, binary-search the
 * window, prefetch a page near the bottom. No group headers unless the query
 * asks for them, because a unified list across forty-five mailboxes is the
 * default here and every header is space the message is not using.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Refresh } from '@/components/icons';
import { Empty } from '@/components/ui';
import { useGroups, useStore } from '@/lib/store';
import { firstItemAt } from '@/lib/virtual';
import type { MessageSummary } from '@/lib/types';
import { MobileRow } from './MobileRow';
import { SwipeRow, closeSwipe } from './SwipeRow';

const ROW_H = 66;
const GROUP_H = 26;
/** Drag past this, in travelled pixels, and letting go syncs. */
const PULL_THRESHOLD = 64;
/** Past this the rubber band stops giving, so the gesture has an obvious end. */
const PULL_MAX = 96;
/** Rows rendered above and below the viewport. */
const OVERSCAN = 6;

type Item =
  | { kind: 'group'; key: string; label: string; top: number; h: number }
  | { kind: 'row'; key: string; message: MessageSummary; top: number; h: number };

export function MobileList() {
  const groups = useGroups();
  const result = useStore((s) => s.result);
  const loading = useStore((s) => s.loading);
  const stale = useStore((s) => s.stale);
  const groupKey = useStore((s) => s.query.group);
  const loadMore = useStore((s) => s.loadMore);
  const open = useStore((s) => s.open);
  const refresh = useStore((s) => s.refresh);
  const syncing = useStore((s) => s.sync.busy);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [pull, setPull] = useState(0);

  const { items, totalH } = useMemo(() => {
    const out: Item[] = [];
    let top = 0;
    for (const g of groups) {
      if (groupKey !== 'none') {
        out.push({ kind: 'group', key: `g:${g.key}`, label: g.label, top, h: GROUP_H });
        top += GROUP_H;
      }
      for (const m of g.messages) {
        out.push({ kind: 'row', key: m.id, message: m, top, h: ROW_H });
        top += ROW_H;
      }
    }
    return { items: out, totalH: top };
  }, [groups, groupKey]);

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

  /*
   * Pull to refresh.
   *
   * Touch events rather than the pointer events the rest of the mobile shell
   * uses, because this is the one gesture that has to `preventDefault` — at
   * scrollTop 0 the browser owns a downward drag and turns it into an overscroll
   * bounce, and a passive listener cannot take it back. It does not race
   * `SwipeRow`: this only engages on a vertical drag at the top of the list,
   * and that engages only on a horizontal one.
   */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const st = { startY: 0, active: false, armed: false };

    const onStart = (e: TouchEvent) => {
      if (el.scrollTop > 0 || e.touches.length !== 1) return;
      st.startY = e.touches[0]!.clientY;
      st.active = true;
      st.armed = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!st.active) return;
      const dy = e.touches[0]!.clientY - st.startY;
      // An upward drag, or a list that has scrolled, is an ordinary scroll.
      if (dy <= 0 || el.scrollTop > 0) {
        st.active = false;
        setPull(0);
        return;
      }
      e.preventDefault();
      // Half rate, hard ceiling: the band gets stiffer rather than endless.
      const d = Math.min(dy * 0.5, PULL_MAX);
      setPull(d);
      const armed = d >= PULL_THRESHOLD;
      if (armed !== st.armed) {
        st.armed = armed;
        if (armed && navigator.vibrate) navigator.vibrate(12);
      }
    };

    const onEnd = () => {
      if (!st.active) return;
      st.active = false;
      if (st.armed) void refresh();
      st.armed = false;
      setPull(0);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [refresh]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    closeSwipe();
    setScrollTop(el.scrollTop);
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) void loadMore();
  }, [loadMore]);

  // Reset to the top when the scope changes.
  const scopeKey = useStore((s) => `${s.query.scope.kind}:${s.query.scope.value}:${s.query.scope.role}`);
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [scopeKey]);

  const empty = !loading && !stale && result && result.messages.length === 0;

  return (
    <div className="mobile__list" ref={scrollerRef} onScroll={onScroll} tabIndex={-1}>
      {(loading || stale) && <div className="progress" />}

      <div
        className="mobile__pull"
        data-armed={pull >= PULL_THRESHOLD || undefined}
        data-syncing={syncing || undefined}
        style={{ transform: `translateY(${pull || (syncing ? PULL_THRESHOLD : 0)}px)` }}
        aria-hidden={!pull && !syncing}
      >
        <Refresh size={16} />
      </div>

      {empty ? (
        <Empty title="Inbox zero" body="Nothing here. That is the whole point." />
      ) : !result ? (
        <div className="mobile__loading" />
      ) : (
        <div
          className="mobile__sizer"
          data-pulling={pull > 0 || undefined}
          style={{ height: totalH, transform: `translateY(${pull}px)` }}
        >
          {visible.map((item) =>
            item.kind === 'group' ? (
              <div
                key={item.key}
                className="mobile__group"
                style={{ transform: `translateY(${item.top}px)` }}
              >
                {item.label}
              </div>
            ) : (
              <SwipeRow
                key={item.key}
                top={item.top}
                message={item.message}
                onOpen={() => void open(item.message.id, 'push')}
              >
                <MobileRow message={item.message} />
              </SwipeRow>
            ),
          )}
        </div>
      )}
    </div>
  );
}
