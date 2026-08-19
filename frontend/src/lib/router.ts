/**
 * Two-way sync between the address bar and the store.
 *
 * Hand-rolled rather than pulled from a package. The route space here is seven
 * fixed shapes and a query string with no nesting, no loaders, no data
 * boundaries and no code splitting — the ~90 lines below are the whole of what
 * a router library would be doing for us, minus a dependency that would also
 * want to own rendering. `lib/url.ts` holds the parsing; this file holds only
 * the history policy.
 *
 * The policy, in one sentence: **going somewhere pushes, changing how you look
 * at where you already are replaces.** Scope changes and deliberately opening a
 * message are navigation. Sort, grouping, filters, and the reader following j/k
 * are not, which is what keeps Back from turning into an undo stack for
 * keystrokes.
 */

import { useEffect } from 'react';
import { emptyFilters } from './query';
import { useStore, type State } from './store';
import {
  buildLocation,
  parseLocation,
  routeDefaults,
  sameScope,
  type RouteDefaults,
  type RouteState,
} from './url';
import { DEFAULT_PREFERENCES, type Scope } from './types';

/**
 * Where this build is mounted, without a trailing slash: `''` at a site root,
 * `/demo` for the hosted demo that lives beside a landing page.
 *
 * It is handled *here* and nowhere else. `lib/url.ts` stays pure — it maps a
 * route to a path and back with no idea that a prefix exists — which is what
 * lets `scripts/url-check.mjs` assert on exact strings without knowing how the
 * bundle was built. Every crossing between the browser's address bar and that
 * pure layer goes through `stripBase` or `withBase`, and there are three.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

const stripBase = (path: string) =>
  BASE && (path === BASE || path.startsWith(`${BASE}/`)) ? path.slice(BASE.length) || '/' : path;

const withBase = (location: string) => (BASE ? BASE + location : location);

/** True while the store is being written *from* the URL, so the resulting state
 *  change does not immediately write a second history entry back. */
let applying = false;

/** Marker left on entries this router pushed for an open message. It is what
 *  lets Escape walk back out of the reader instead of stacking a new entry. */
interface NavState {
  openedReader?: boolean;
  openedSettings?: boolean;
}

export function useRouter() {
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    if (!ready) return;

    const resolve = (scope: Scope) => defaultsFor(useStore.getState(), scope);

    const fromUrl = () => {
      applying = true;
      try {
        useStore
          .getState()
          .applyRoute(
            parseLocation(stripBase(window.location.pathname), window.location.search, resolve),
          );
      } finally {
        applying = false;
      }
    };

    fromUrl();
    // `/u/inbox` and `/` are the same place; say so in the address bar. Not a
    // navigation, so it replaces.
    write('replace', withBase(buildLocation(toRoute(useStore.getState()), resolve)), history.state);

    const onPop = () => fromUrl();
    window.addEventListener('popstate', onPop);

    const unsubscribe = useStore.subscribe((s, prev) => {
      if (applying) return;
      const next = withBase(buildLocation(toRoute(s), resolve));
      if (next === window.location.pathname + window.location.search) return;

      // Closing the reader while standing on the very entry that opened it:
      // step back out rather than stacking a third one, so Back and Forward
      // stay symmetric. Anywhere else, closing is an ordinary navigation.
      const closedReader = prev.openId && !s.openId && sameScope(prev.query.scope, s.query.scope);
      if (closedReader && (history.state as NavState | null)?.openedReader) {
        history.back();
        return;
      }

      // Opening settings is going somewhere, so it pushes and Back closes it.
      // Closing it from the entry that opened it steps back out rather than
      // stacking a third entry, exactly as the reader does — otherwise Back
      // after closing settings re-opens it, which is worse than not working.
      const closedSettings = prev.settings && !s.settings;
      if (closedSettings && (history.state as NavState | null)?.openedSettings) {
        history.back();
        return;
      }

      // The marker has to survive a replace — otherwise the reader following
      // j/k quietly erases the thing that lets Escape walk back out of it.
      const opened = !!s.openId && !prev.openId;
      const openedSettings = !!s.settings && !prev.settings;
      const entry: NavState = openedSettings
        ? { openedSettings: true }
        : opened
          ? { openedReader: true }
          : s.nav === 'push'
            ? {}
            : ((history.state as NavState | null) ?? {});

      write(s.nav, next, entry);
    });

    return () => {
      window.removeEventListener('popstate', onPop);
      unsubscribe();
    };
  }, [ready]);
}

function write(mode: 'push' | 'replace', url: string, state: unknown) {
  if (mode === 'push') history.pushState(state, '', url);
  else history.replaceState(state, '', url);
}

/* ── State ⇄ route ────────────────────────────────────────────────────────── */

export function toRoute(s: State): RouteState {
  return {
    scope: s.query.scope,
    sort: s.query.sort,
    dir: s.query.dir,
    group: s.query.group,
    threaded: s.query.threaded,
    filters: s.query.filters,
    openId: s.openId,
    settings: s.settings,
  };
}

/** What counts as "unspecified" here — the user's default query, or a saved
 *  view's own query when that is where we are. */
export function defaultsFor(s: State, scope: Scope): RouteDefaults {
  const base = s.prefs?.defaultQuery ?? DEFAULT_PREFERENCES.defaultQuery;
  return routeDefaults(s.views, { ...base, filters: emptyFilters() }, scope);
}
