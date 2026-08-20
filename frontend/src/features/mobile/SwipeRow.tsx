/**
 * Swipe actions on a mobile row. Pointer events, never HTML5 drag-and-drop:
 * `touch-action: pan-y` on the row is what stops the swipe
 * fighting the list — vertical scrolling stays the browser's, horizontal is
 * ours. One action per side, both configurable in settings.
 *
 * The outer element carries the virtualiser's `translateY(top)`; an inner
 * element carries the swipe's `translateX(dx)`. They must not share a
 * transform, or a horizontal swipe would move the row out of its vertical
 * slot.
 */

import { useEffect, useRef, useState } from 'react';
import { Archive, Dot, Star, Trash } from '@/components/icons';
import { useStore } from '@/lib/store';
import type { MessageSummary, SwipeAction } from '@/lib/types';

/** Horizontal movement past this locks the gesture as a swipe, not a scroll. */
const LOCK_PX = 8;
/** Horizontal travel must beat vertical by this much to count as a swipe. A
 *  thumb flick down a list is never perfectly vertical, and without this a
 *  diagonal scroll drags rows sideways and leaves one open. */
const AXIS_BIAS = 1.5;
/** A release short of this snaps back with nothing happening. */
const SNAP_PX = 72;
/** The reveal detent: enough to expose the labelled button. */
const DETENT = 88;
/** A swipe past this fraction of the row width commits without lifting. */
const COMMIT_FRACTION = 0.4;
/** How long the confirmation is held before a destructive action runs. Long
 *  enough to register as a thing that happened, short enough to stay under the
 *  threshold where a UI stops feeling direct. */
const CONFIRM_MS = 190;

type Tone = 'neutral' | 'danger' | 'warning';

interface Act {
  label: string;
  tone: Tone;
  icon: React.ReactNode;
  /** Destructive actions remove the row from the list; the rest snap back. */
  removes: boolean;
  run: (id: string) => void;
}

interface SwipeHandlers {
  archive: (ids?: string[]) => Promise<void>;
  trash: (ids?: string[]) => Promise<void>;
  toggleRead: (ids?: string[]) => Promise<void>;
  toggleFlag: (ids?: string[]) => Promise<void>;
}

function actOf(a: SwipeAction, h: SwipeHandlers): Act | null {
  switch (a) {
    case 'archive':
      return { label: 'Archive', tone: 'neutral', icon: <Archive size={18} />, removes: true,
               run: (id) => void h.archive([id]) };
    case 'trash':
      return { label: 'Trash', tone: 'danger', icon: <Trash size={18} />, removes: true,
               run: (id) => void h.trash([id]) };
    case 'read':
      return { label: 'Read', tone: 'neutral', icon: <Dot size={14} />, removes: false,
               run: (id) => void h.toggleRead([id]) };
    case 'pin':
      return { label: 'Pin', tone: 'warning', icon: <Star size={17} filled />, removes: false,
               run: (id) => void h.toggleFlag([id]) };
    // move and label need a target picker, not a single existing store action.
    default:
      return null;
  }
}

/* One row open at a time. A module-level handle beats threading a close
 * callback through every virtualised row, and lets the list close the open row
 * on scroll. */
let openRow: { id: object; close: () => void } | null = null;

export function closeSwipe() {
  openRow?.close();
}

export function SwipeRow({
  top,
  message: m,
  onOpen,
  children,
}: {
  top: number;
  message: MessageSummary;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const mobile = useStore((s) => s.prefs?.mobile);
  const swipeLeft = mobile?.swipeLeft ?? 'archive';
  const swipeRight = mobile?.swipeRight ?? 'read';
  const longSwipeCommits = mobile?.longSwipeCommits ?? true;
  const archive = useStore((s) => s.archive);
  const trash = useStore((s) => s.trash);
  const toggleRead = useStore((s) => s.toggleRead);
  const toggleFlag = useStore((s) => s.toggleFlag);

  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** Past the commit threshold: the pane says so before the thumb lifts. */
  const [armed, setArmed] = useState(false);
  /** Non-zero while the confirmation plays, holding the pane full-bleed. */
  const [committing, setCommitting] = useState(0);
  const armedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dxRef = useRef(0);
  const gesture = useRef<{
    originX: number;
    originY: number;
    /** Where the row already sat when the finger landed. */
    base: number;
    active: boolean;
  } | null>(null);
  const didSwipe = useRef(false);
  const id = useRef<object>({}).current;

  /* A row open at its detent can scroll out of the virtualiser's window and
     unmount. Without this the module-level handle keeps pointing at a dead
     component, and the next row to open calls close() on a corpse. */
  useEffect(
    () => () => {
      if (openRow?.id === id) openRow = null;
    },
    [id],
  );

  const h = { archive, trash, toggleRead, toggleFlag };
  // Swiping the content right reveals the left pane; swiping left reveals the right.
  const leftAct = actOf(swipeRight, h);
  const rightAct = actOf(swipeLeft, h);

  const actFor = (d: number) => (d >= 0 ? leftAct : rightAct);

  const closeThis = () => {
    if (openRow?.id === id) openRow = null;
    dxRef.current = 0;
    setDx(0);
  };

  const openAtDetent = (detent: number) => {
    if (openRow) openRow.close();
    openRow = { id, close: closeThis };
    dxRef.current = detent;
    setDx(detent);
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const fire = (a: Act | null) => {
    if (openRow?.id === id) openRow = null;
    if (!a) {
      dxRef.current = 0;
      setDx(0);
      return;
    }
    const dir = dxRef.current >= 0 ? 1 : -1;

    if (a.removes) {
      /*
       * Confirm, then act.
       *
       * The store removes the row optimistically, so calling straight through
       * unmounted this component on the same frame and the "fly out" never drew
       * a single pixel — the only feedback was a toast arriving somewhere else
       * on screen. Holding the pane full-bleed for one beat first makes the
       * action something you watch happen.
       */
      setCommitting(dir);
      const out = dir * (rootRef.current?.clientWidth ?? 390);
      dxRef.current = out;
      setDx(out);
      if (navigator.vibrate) navigator.vibrate([8, 26, 8]);
      window.setTimeout(() => {
        a.run(m.id);
        /*
         * An action is not guaranteed to happen. `archive` returns without doing
         * anything when the message's account has no Archive folder, and `trash`
         * behaves the same way — so a row could be flung off screen, left there,
         * and never removed from the list, with the confirmation animation
         * having promised the opposite. If the message is still in the list
         * shortly after, put the row back.
         */
        window.setTimeout(() => {
          const alive = useStore.getState().result?.messages.some((x) => x.id === m.id);
          if (!alive) return;
          setCommitting(0);
          dxRef.current = 0;
          setDx(0);
        }, 80);
      }, CONFIRM_MS);
    } else {
      // A toggle repaints the row itself — read greys it, pin warms it — so the
      // row is its own confirmation and there is nothing to wait for.
      a.run(m.id);
      if (navigator.vibrate) navigator.vibrate(10);
      dxRef.current = 0;
      setDx(0);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (openRow && openRow.id !== id) openRow.close();
    // Seeded from where the row currently sits, so dragging an already-open row
    // continues from its detent instead of snapping back to zero first.
    gesture.current = { originX: e.clientX, originY: e.clientY, base: dxRef.current, active: false };
    didSwipe.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const mx = e.clientX - g.originX;
    const my = e.clientY - g.originY;
    if (!g.active) {
      if (Math.abs(mx) < LOCK_PX) return;
      // Vertical intent wins and ends the gesture for good: the axis is decided
      // once, as it is in a native list. `touch-action: pan-y` hands the scroll
      // to the browser, but it does not stop us painting a sideways drag first.
      if (Math.abs(mx) < Math.abs(my) * AXIS_BIAS) {
        gesture.current = null;
        return;
      }
      g.active = true;
      didSwipe.current = true;
      setDragging(true);
    }
    const next = g.base + mx;
    dxRef.current = next;
    setDx(next);

    // Arm at the same threshold the release uses, so the pane is telling the
    // truth about what letting go will do.
    const width = rootRef.current?.clientWidth ?? 390;
    const nowArmed = longSwipeCommits && Math.abs(next) >= COMMIT_FRACTION * width;
    if (nowArmed !== armedRef.current) {
      armedRef.current = nowArmed;
      setArmed(nowArmed);
      if (nowArmed && navigator.vibrate) navigator.vibrate(12);
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setDragging(false);
    armedRef.current = false;
    setArmed(false);
    if (!g || !g.active) return; // a tap is handled by onClick
    const width = rootRef.current?.clientWidth ?? 390;
    const d = dxRef.current;
    if (longSwipeCommits && Math.abs(d) >= COMMIT_FRACTION * width) {
      fire(actFor(d));
      return;
    }
    if (Math.abs(d) < SNAP_PX) {
      closeThis();
    } else {
      openAtDetent(d >= 0 ? DETENT : -DETENT);
    }
  };

  const onTap = () => {
    if (didSwipe.current) {
      didSwipe.current = false;
      return;
    }
    if (openRow?.id === id) {
      closeThis();
      return;
    }
    onOpen();
  };

  return (
    <div
      ref={rootRef}
      className="swiperow"
      data-committing={committing || undefined}
      style={{ transform: `translateY(${top}px)` } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onTap}
    >
      {leftAct && (
        <button
          type="button"
          className="swiperow__pane swiperow__pane--left"
          data-tone={leftAct.tone}
          data-armed={(dx > 0 && armed) || committing > 0 || undefined}
          aria-label={leftAct.label}
          onClick={(e) => {
            e.stopPropagation();
            fire(leftAct);
          }}
        >
          <span className="swiperow__icon">{leftAct.icon}</span>
          <span className="swiperow__label">{leftAct.label}</span>
        </button>
      )}
      {rightAct && (
        <button
          type="button"
          className="swiperow__pane swiperow__pane--right"
          data-tone={rightAct.tone}
          data-armed={(dx < 0 && armed) || committing < 0 || undefined}
          aria-label={rightAct.label}
          onClick={(e) => {
            e.stopPropagation();
            fire(rightAct);
          }}
        >
          <span className="swiperow__icon">{rightAct.icon}</span>
          <span className="swiperow__label">{rightAct.label}</span>
        </button>
      )}
      <div
        className="swiperow__content"
        data-dragging={dragging || undefined}
        style={{ transform: `translateX(${dx}px)` }}
      >
        {children}
      </div>
    </div>
  );
}
