import { useSyncExternalStore } from 'react';

/** True below the touch breakpoint. `?ui=mobile|desktop` forces it, for testing
 *  the touch shell on a desktop without resizing the window. */

const TOUCH_BREAKPOINT = '(max-width: 720px)';

/**
 * Where the desktop shell stops showing two panes side by side.
 *
 * Must stay in step with the `max-width: 1080px` block in `shell.css`, which is
 * where the sidebar goes away and the reader stops sitting *next to* the list
 * and starts sitting *over* it. Anything that has to know whether the list is
 * still visible reads this rather than guessing from a width of its own.
 */
const STACKED_BREAKPOINT = '(max-width: 1080px)';

/** Read once at module load: the override is a deliberate, stable choice for a
 *  session, not something that should follow the window around. */
const forced = new URLSearchParams(window.location.search).get('ui');

function subscribe(cb: () => void): () => void {
  const mql = matchMedia(TOUCH_BREAKPOINT);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

function snapshot(): boolean {
  if (forced === 'mobile') return true;
  if (forced === 'desktop') return false;
  return matchMedia(TOUCH_BREAKPOINT).matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * True when the desktop shell has collapsed to one pane at a time — a window
 * dragged to half a screen, most often — so the reader covers the message list
 * instead of sitting beside it.
 */
export function useIsStacked(): boolean {
  return useSyncExternalStore(subscribeStacked, stackedSnapshot, stackedSnapshot);
}

function subscribeStacked(cb: () => void): () => void {
  const mql = matchMedia(STACKED_BREAKPOINT);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

function stackedSnapshot(): boolean {
  return matchMedia(STACKED_BREAKPOINT).matches;
}

/**
 * Pixels of viewport currently covered by the on-screen keyboard.
 *
 * The layout viewport does not shrink when a soft keyboard opens on iOS, so a
 * `position: fixed; inset: 0` pane keeps its full height and everything at the
 * bottom of it — the send bar, the last line being typed — sits underneath the
 * keyboard. `visualViewport` is the only thing that reports the truth, and it
 * reports it on both platforms.
 *
 * Returns 0 where the API is absent, which degrades to the pre-existing
 * behaviour rather than to a broken layout.
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribeViewport, viewportInset, () => 0);
}

function subscribeViewport(cb: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener('resize', cb);
  vv.addEventListener('scroll', cb);
  return () => {
    vv.removeEventListener('resize', cb);
    vv.removeEventListener('scroll', cb);
  };
}

function viewportInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  // `offsetTop` matters when the page itself has been scrolled up to reveal a
  // focused field: without it the inset over-reports by exactly that much.
  const inset = window.innerHeight - vv.height - vv.offsetTop;
  // Round, so a fractional device pixel does not spam re-renders, and clamp:
  // some browsers report a negative inset mid-rotation.
  return inset > 1 ? Math.round(inset) : 0;
}
