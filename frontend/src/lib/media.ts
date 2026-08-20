import { useSyncExternalStore } from 'react';

/** True below the touch breakpoint. `?ui=mobile|desktop` forces it, for testing
 *  the touch shell on a desktop without resizing the window. */

const TOUCH_BREAKPOINT = '(max-width: 720px)';

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
