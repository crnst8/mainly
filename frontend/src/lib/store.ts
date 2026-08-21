/**
 * Application state.
 *
 * Rules that keep this fast:
 *  - Mutations paint first, then reconcile. Every action that touches a row
 *    updates local state synchronously and fires the API in the background.
 *  - Destructive actions are staged behind an undo window, not a confirm
 *    dialog. Nothing you can do here is unrecoverable within `undoWindowMs`.
 *  - The list is the only thing allowed to hold message arrays. Everything else
 *    holds ids.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import { getApi } from './api';
import { collapseThreads, defaultQuery, emptyFilters, groupMessages, type Group } from './query';
import { homeScope } from './scope';
import { parseLocation, routeDefaults, sameFilters, sameScope, type RouteState } from './url';
import { withPreferenceDefaults } from './types';
import type {
  Account,
  AccountGroup,
  Draft,
  Folder,
  Id,
  ListQuery,
  ListResult,
  Message,
  MessageAction,
  MessageSummary,
  Preferences,
  SavedView,
  Scope,
  Session,
  SyncState,
  Thread,
} from './types';

export interface Toast {
  id: string;
  message: string;
  /** Present when the action is reversible. */
  undo?: () => void;
  expiresAt: number;
}

export interface State {
  /* Bootstrap */
  ready: boolean;
  error: string | null;

  /* Data */
  /** Who is signed in — the app login, not a mailbox. Null until `boot`
   *  resolves, and in mock mode for as long as the mock says so. */
  user: Session | null;
  accounts: Account[];
  folders: Folder[];
  views: SavedView[];
  prefs: Preferences | null;
  sync: SyncState;

  /* List */
  query: ListQuery;
  result: ListResult | null;
  loading: boolean;
  /** Set while a new scope is loading, so the old list can stay on screen. */
  stale: boolean;

  /* Selection & focus */
  focusedId: Id | null;
  selectedIds: Set<Id>;
  /** Anchor for shift-range selection. */
  anchorId: Id | null;

  /* Reader */
  openId: Id | null;
  openMessage: Message | null;
  openThread: Thread | null;
  readerLoading: boolean;

  /* Compose */
  composer: Draft | null;
  composerMinimised: boolean;
  /**
   * Which address new mail goes out as.
   *
   * Session state, not a stored preference: "who am I right now" follows what
   * you are doing, and persisting it means the identity you used once in March
   * silently addresses a reply in August.
   */
  identityId: Id | null;

  /** Where you have been, most recent first. Feeds the palette. */
  recentScopes: Scope[];
  /** Queries you have run, most recent first. Feeds the suggestion list. */
  recentSearches: string[];
  /**
   * Where you were when the search started.
   *
   * Session state, because it answers "what does *here* mean" for the scoping
   * toggle. The narrowing itself lives in the filters, so it is in the URL and
   * survives a reload — this only decides what the second button offers.
   */
  searchBase: Scope | null;

  /* Overlays */
  palette: boolean;
  settings: string | null;
  onboarding: boolean;

  toasts: Toast[];

  /**
   * How the last state change should be recorded in browser history.
   *
   * Set by whichever action caused the change, read by `lib/router.ts`. It is
   * state rather than a module variable so it stays inspectable next to the
   * change it describes: going somewhere is `push`, changing how you look at
   * where you already are is `replace`.
   */
  nav: 'push' | 'replace';
}

interface Actions {
  boot(): Promise<void>;

  setScope(scope: Scope): void;
  /** The unified inbox, from anywhere, in one action. */
  goHome(): void;
  openView(id: Id): void;
  /** Write a whole location into the store in one go — one refresh, not five. */
  applyRoute(route: RouteState): void;
  patchQuery(patch: Partial<ListQuery>): void;
  patchFilters(patch: Partial<ListQuery['filters']>): void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** Re-read everything the SSE stream would have told us while it was down:
   *  accounts, folders, sync state and the list. Cheap enough to run whenever
   *  the tab comes back, which is the only time it is called. */
  resync(): Promise<void>;

  focus(id: Id | null): void;
  moveFocus(delta: number): void;
  toggleSelect(id: Id, mode?: 'single' | 'range' | 'add'): void;
  /** Add or remove a whole set at once — a group header, a saved search, an
   *  agent handing over a list. One `set` rather than one per id. */
  selectMany(ids: Id[], selected: boolean): void;
  selectAll(): void;
  clearSelection(): void;

  /** `mode` decides whether the reader becomes a history entry. Opening from a
   *  click or Enter is navigation; the reader following j/k is not. */
  open(id: Id | null, mode?: 'push' | 'replace'): Promise<void>;
  openNext(delta: number): Promise<void>;
  /** Fetch one thread member's body and patch it into the open thread. The
   *  thread read serves cached bodies only, so expanding an item is what asks
   *  the server for it. */
  loadThreadBody(id: Id): Promise<void>;

  act(ids: Id[], action: MessageAction, label?: string): Promise<void>;
  toggleRead(ids?: Id[]): Promise<void>;
  toggleFlag(ids?: Id[]): Promise<void>;
  /** Set the flag rather than toggle it. A bulk menu offering "Flag" must flag,
   *  even when one of the twelve already was — a toggle there does the opposite
   *  of what its own label says roughly half the time. */
  setFlag(ids: Id[], flagged: boolean): Promise<void>;
  setRead(ids: Id[], seen: boolean): Promise<void>;
  archive(ids?: Id[]): Promise<void>;
  trash(ids?: Id[]): Promise<void>;

  setIdentity(accountId: Id): void;
  compose(seed?: Partial<Draft>): void;
  reply(all: boolean): void;
  forward(): void;
  closeComposer(): void;
  sendComposer(): Promise<void>;

  /** Add and/or remove labels across a set of messages. Labels are ours, not
   *  IMAP keywords — the mail server is read-only infrastructure. */
  setLabels(ids: Id[], add: string[], remove: string[]): Promise<void>;
  /** Move messages into a folder, with the same undo window as archive. */
  moveTo(ids: Id[], folderId: Id, folderName: string): Promise<void>;
  /** Create a folder on the server and adopt it into the sidebar. Returns null
   *  and raises a toast when the server refuses. */
  createFolder(accountId: Id, name: string, parentId: Id | null): Promise<Folder | null>;
  /** Give a label a colour, creating it in preferences if it is new. */
  setLabelColor(label: string, color: string | null): Promise<void>;
  /** Colour, pin or reorder a folder. Presentation only — the mail server is
   *  not told, because none of it is its business. */
  updateFolder(id: Id, patch: Partial<Folder>): Promise<void>;
  /** Ask the server to sync now. Fire and forget; progress arrives over SSE. */
  triggerSync(accountId?: Id): Promise<void>;

  updateAccount(id: Id, patch: Partial<Account>): Promise<void>;

  /* Sidebar groups. Presentation only, so they live in preferences and never
     reach the mail server. */
  createAccountGroup(name: string): Promise<Id | null>;
  renameAccountGroup(id: Id, name: string): Promise<void>;
  removeAccountGroup(id: Id): Promise<void>;
  setAccountGroupColor(id: Id, color: string | null): Promise<void>;
  toggleAccountGroup(id: Id): Promise<void>;
  /** Put an account in a group, or with `groupId: null` back among the
   *  ungrouped. `index` is the drop position inside the destination. */
  moveAccountToGroup(accountId: Id, groupId: Id | null, index?: number): Promise<void>;
  /** Re-seal a mailbox password. Resolves to the server's message on rejection
   *  rather than throwing, so the settings row can show it inline instead of
   *  raising a toast that vanishes before it is read. */
  updateAccountPassword(id: Id, password: string): Promise<string | null>;
  /** Stop syncing a mailbox and drop its local index. Irreversible locally; the
   *  mail server is untouched. */
  removeAccount(id: Id): Promise<void>;
  savePrefs(patch: Partial<Preferences>): Promise<void>;
  saveTheme(patch: Partial<Preferences['theme']>): Promise<void>;
  saveCurrentView(name: string, glyph: string): Promise<void>;

  /** Change the app password. Resolves to the server's message on rejection
   *  rather than throwing, so the form can show it inline next to the field
   *  that caused it — the same contract `updateAccountPassword` uses. */
  changePassword(currentPassword: string, newPassword: string): Promise<string | null>;
  /** End the session and reload. Everything this document holds — the message
   *  index, cached bodies, the event stream — goes with it. */
  signOut(): Promise<void>;

  setPalette(open: boolean): void;
  setSettings(tab: string | null): void;
  setOnboarding(open: boolean): void;
  toast(message: string, undo?: () => void): void;
  dismissToast(id: string): void;
}

/** Ids that are staged for removal but still inside the undo window. Kept out
 *  of the store so re-renders do not depend on them. */
const pendingRemoval = new Set<Id>();

/** Window listeners are wired once per document, not once per boot. `boot` can
 *  run again after a sign-in without stacking a second copy of each. */
let listening = false;

/** The live SSE stream's teardown, so a second `boot` replaces it rather than
 *  racing it. Module scope for the same reason `listening` is: it belongs to
 *  the document, not to a render. */
let unsubscribeEvents: (() => void) | null = null;

/** Auto-dismiss timers, so undoing a toast with `z` also cancels the timer that
 *  would have dismissed it — otherwise it fires later against an id that is
 *  gone, and `dismissToast` walks the whole list for nothing. */
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useStore = create<State & Actions>((set, get) => ({
  ready: false,
  error: null,
  user: null,
  accounts: [],
  folders: [],
  views: [],
  prefs: null,
  sync: { accounts: {}, busy: false, bodySearch: { indexed: 0, total: 0 } },

  query: defaultQuery(),
  result: null,
  loading: false,
  stale: false,

  focusedId: null,
  selectedIds: new Set(),
  anchorId: null,

  openId: null,
  openMessage: null,
  openThread: null,
  readerLoading: false,

  composer: null,
  composerMinimised: false,
  identityId: null,
  recentScopes: [],
  recentSearches: loadRecentSearches(),
  searchBase: null,

  palette: false,
  settings: null,
  onboarding: false,
  toasts: [],
  nav: 'replace',

  /* ── Bootstrap ──────────────────────────────────────────────────────────── */

  async boot() {
    try {
      const api = await getApi();
      const [user, accounts, folders, views, storedPrefs, sync] = await Promise.all([
        api.session(),
        api.listAccounts(),
        api.listFolders(),
        api.listViews(),
        api.getPreferences(),
        api.syncState(),
      ]);

      // A user who has never opened settings has an empty preferences row.
      // Merging here means no component downstream has to guard for it.
      const prefs = withPreferenceDefaults(storedPrefs);
      // Give every domain a colour up front. Colour is the primary way this
      // app distinguishes twelve addresses at a glance, so shipping a new user
      // a wall of grey defeats the point — and picking them by hand before you
      // have used the app is a question nobody can answer well.
      const assigned = assignDomainColors(accounts, prefs.theme.domainColors);
      if (assigned) {
        prefs.theme.domainColors = assigned;
        void api.savePreferences(prefs);
      }
      // Seed the query from the address bar before the first fetch, so a deep
      // link paints its own view once instead of painting the default inbox and
      // then replacing it.
      const base = { ...defaultQuery(), ...prefs.defaultQuery };
      const route = parseLocation(window.location.pathname, window.location.search, (scope) =>
        routeDefaults(views, { ...prefs.defaultQuery, filters: emptyFilters() }, scope),
      );
      const query: ListQuery = {
        ...base,
        scope: route.scope,
        sort: route.sort,
        dir: route.dir,
        group: route.group,
        threaded: route.threaded,
        filters: route.filters,
      };
      set({ user, accounts, folders, views, prefs, sync, query, ready: true });
      applyTheme(prefs.theme);

      // `boot` runs again after a sign-in, and a second `subscribe` would leave
      // the first stream open and delivering into the same store. Close what the
      // previous run opened before opening another.
      unsubscribeEvents?.();
      unsubscribeEvents = api.subscribe((event) => {
        const s = get();
        switch (event.type) {
          case 'sync':
            set({ sync: { ...s.sync, ...event.state, accounts: { ...s.sync.accounts, ...event.state.accounts } } });
            break;
          case 'account:changed':
            set({ accounts: s.accounts.map((a) => (a.id === event.account.id ? event.account : a)) });
            break;
          case 'counts':
            // Server-authoritative, so it replaces rather than adjusts: this is
            // what reconciles whatever the optimistic paint in `act` guessed.
            set({
              accounts: s.accounts.map((a) =>
                event.accounts[a.id] ? { ...a, ...event.accounts[a.id]! } : a,
              ),
              folders: s.folders.map((f) =>
                event.folders[f.id] ? { ...f, ...event.folders[f.id]! } : f,
              ),
            });
            break;
          case 'messages:new':
            void get().refresh();
            break;
          case 'messages:changed':
            // No ids is the sync worker saying "the index moved underneath you"
            // without enumerating how. The only honest response is to re-read,
            // and the only safe way to do that is coalesced — one pass over
            // twelve accounts lands twelve of these inside a second.
            if (!event.ids.length) {
              scheduleRefresh(get);
              break;
            }
            patchMessages(set, get, event.ids, event.patch);
            break;
          case 'messages:deleted':
            dropMessages(set, get, event.ids);
            break;
        }
      });

      // Re-read on the way back.
      //
      // A laptop that slept, a tab left open overnight, a dropped connection:
      // EventSource reconnects but whatever was published while it was gone is
      // gone with it, so the screen is exactly as stale as the gap was long.
      // Returning to the tab is the moment that matters, because it is the
      // moment the numbers are looked at.
      if (!listening) {
        listening = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void get().resync();
        });
        window.addEventListener('online', () => void get().resync());
      }

      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), ready: true });
    }
  },

  /* ── List ───────────────────────────────────────────────────────────────── */

  setScope(scope) {
    const q = get().query;
    const prev = q.scope;
    // Crossing into or out of a search resets sort and grouping to whatever
    // that kind of view wants, so a click and a pasted URL land on the same
    // thing. Staying inside search keeps whatever the user has chosen.
    const crossed = (prev.kind === 'search') !== (scope.kind === 'search');
    const base = { ...defaultQuery(), ...get().prefs?.defaultQuery, filters: emptyFilters() };
    const d = routeDefaults(get().views, base, scope);

    set({
      query: {
        ...q,
        scope,
        ...(crossed ? { sort: d.sort, group: d.group } : {}),
        cursor: null,
      },
      stale: true,
      selectedIds: new Set(),
      focusedId: null,
      // Refining a search you are already in is not arriving somewhere new, so
      // a debounced input cannot fill the back stack one keystroke at a time.
      nav: prev.kind === 'search' && scope.kind === 'search' ? 'replace' : 'push',
      recentScopes: remember(get().recentScopes, scope),
      recentSearches:
        scope.kind === 'search' ? rememberSearch(get().recentSearches, scope.value) : get().recentSearches,
      // Only the *entry* into search records where you came from. Refining the
      // query must not reset the toggle to the search results themselves.
      searchBase: crossed && scope.kind === 'search' ? prev : get().searchBase,
    });
    void get().refresh();
  },

  goHome() {
    get().setScope(homeScope());
  },

  openView(id) {
    const view = get().views.find((v) => v.id === id);
    if (!view) return;
    const scope: Scope = { kind: 'saved', value: id, role: null };
    set({
      query: { ...view.query, scope, cursor: null },
      stale: true,
      selectedIds: new Set(),
      focusedId: null,
      nav: 'push',
      recentScopes: remember(get().recentScopes, scope),
    });
    void get().refresh();
  },

  applyRoute(route) {
    const q = get().query;
    const scopeChanged = !sameScope(q.scope, route.scope);
    const queryChanged =
      scopeChanged ||
      q.sort !== route.sort ||
      q.dir !== route.dir ||
      q.group !== route.group ||
      q.threaded !== route.threaded ||
      !sameFilters(q.filters, route.filters);

    if (queryChanged) {
      set({
        query: {
          ...q,
          scope: route.scope,
          sort: route.sort,
          dir: route.dir,
          group: route.group,
          threaded: route.threaded,
          filters: route.filters,
          cursor: null,
        },
        stale: true,
        selectedIds: scopeChanged ? new Set() : get().selectedIds,
        focusedId: scopeChanged ? null : get().focusedId,
        nav: 'replace',
        // A deep link and a Back are both arrivals; the palette's recent list
        // is about where you have been, not how you got there.
        recentScopes: scopeChanged
          ? remember(get().recentScopes, route.scope)
          : get().recentScopes,
      });
      void get().refresh();
    }

    if (route.openId !== get().openId) void get().open(route.openId, 'replace');
    // Settings is a location too, so Back closes it and a reload keeps it open.
    if (route.settings !== get().settings) set({ settings: route.settings, nav: 'replace' });
  },

  // Sorting, grouping and filtering push. Each is one deliberate gesture, and
  // Back undoing a filter you just applied is worth an entry. What must not
  // push is the incidental: the reader following j/k, or sliding onto the next
  // message after an archive.
  patchQuery(patch) {
    set({ query: { ...get().query, ...patch, cursor: null }, stale: true, nav: 'push' });
    void get().refresh();
  },

  patchFilters(patch) {
    const q = get().query;
    set({
      query: { ...q, filters: { ...q.filters, ...patch }, cursor: null },
      stale: true,
      nav: 'push',
    });
    void get().refresh();
  },

  async refresh() {
    const { query } = get();
    set({ loading: true });
    try {
      const api = await getApi();
      const result = await api.list({ ...query, cursor: null });
      // Hide rows that are mid-undo so they do not flash back into the list.
      const messages = result.messages.filter((m) => !pendingRemoval.has(m.id));
      set({ result: { ...result, messages }, loading: false, stale: false });

      // Keep focus valid — otherwise j/k lands nowhere after a scope change.
      const { focusedId, selectedIds } = get();
      if (!focusedId || !messages.some((m) => m.id === focusedId)) {
        set({ focusedId: messages[0]?.id ?? null });
      }
      // And the selection. Ids that survive a re-read they are no longer in are
      // how "archive 12" ends up acting on messages nothing on screen shows as
      // selected — the bar keeps counting them and the rows are gone.
      if (selectedIds.size) {
        const live = new Set(messages.map((m) => m.id));
        const kept = [...selectedIds].filter((id) => live.has(id));
        if (kept.length !== selectedIds.size) set({ selectedIds: new Set(kept) });
      }
    } catch (e) {
      set({ loading: false, stale: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async loadMore() {
    const { query, result, loading } = get();
    if (!result?.nextCursor || loading) return;
    set({ loading: true });
    try {
      const api = await getApi();
      const next = await api.list({ ...query, cursor: result.nextCursor });
      // The scope may have changed under a page that was already in flight;
      // splicing it in then interleaves two different views.
      if (get().query.scope !== query.scope) return;
      set({
        result: {
          ...next,
          messages: [...result.messages, ...next.messages.filter((m) => !pendingRemoval.has(m.id))],
        },
      });
    } catch (e) {
      // `loading` stays true forever if this throws, and `loading` is what the
      // scroll handler checks before asking for the next page — so one failed
      // page meant the list never paged again.
      get().toast(e instanceof Error ? e.message : 'Could not load more');
    } finally {
      set({ loading: false });
    }
  },

  async resync() {
    try {
      const api = await getApi();
      const [accounts, folders, sync] = await Promise.all([
        api.listAccounts(),
        api.listFolders(),
        api.syncState(),
      ]);
      set({ accounts, folders, sync });
      await get().refresh();
    } catch {
      // Called on the way back from offline or asleep, so failing is expected
      // and silent: the next visibility change tries again, and raising a toast
      // for it would mean a dialog every time a laptop lid closes.
    }
  },

  /* ── Selection ──────────────────────────────────────────────────────────── */

  focus(id) {
    set({ focusedId: id, anchorId: id });
  },

  moveFocus(delta) {
    const rows = get().result?.messages ?? [];
    if (!rows.length) return;
    const i = rows.findIndex((m) => m.id === get().focusedId);
    const next = Math.min(rows.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta));
    const target = rows[next];
    if (!target) return;
    set({ focusedId: target.id });
    // The reader following j/k is not navigation. Pushing here would turn Back
    // into an undo stack for keystrokes.
    if (get().openId) void get().open(target.id, 'replace');
  },

  toggleSelect(id, mode = 'add') {
    const { selectedIds, anchorId, result } = get();
    const rows = result?.messages ?? [];
    const next = new Set(selectedIds);

    if (mode === 'single') {
      set({ selectedIds: new Set([id]), anchorId: id, focusedId: id });
      return;
    }

    if (mode === 'range' && anchorId) {
      const a = rows.findIndex((m) => m.id === anchorId);
      const b = rows.findIndex((m) => m.id === id);
      if (a !== -1 && b !== -1) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i]!.id);
        set({ selectedIds: next, focusedId: id });
        return;
      }
    }

    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selectedIds: next, anchorId: id, focusedId: id });
  },

  selectMany(ids, selected) {
    if (!ids.length) return;
    const next = new Set(get().selectedIds);
    for (const id of ids) {
      if (selected) next.add(id);
      else next.delete(id);
    }
    // The anchor follows the last thing touched, so a shift-click after
    // selecting a group ranges from the group rather than from wherever the
    // cursor last happened to be.
    set({ selectedIds: next, anchorId: selected ? (ids.at(-1) ?? null) : get().anchorId });
  },

  selectAll() {
    set({ selectedIds: new Set((get().result?.messages ?? []).map((m) => m.id)) });
  },

  clearSelection() {
    set({ selectedIds: new Set() });
  },

  /* ── Reader ─────────────────────────────────────────────────────────────── */

  async open(id, mode = 'push') {
    if (!id) {
      set({ openId: null, openMessage: null, openThread: null, nav: mode });
      return;
    }
    set({ openId: id, readerLoading: true, focusedId: id, nav: mode });
    try {
      const api = await getApi();
      const message = await api.get(id);
      // Only commit if the user has not moved on while this was in flight.
      if (get().openId !== id) return;
      set({ openMessage: message, readerLoading: false });

      if (get().query.threaded && message.threadId) {
        const thread = await api.getThread(message.threadId);
        if (get().openId === id) set({ openThread: thread.messages.length > 1 ? thread : null });
      } else {
        set({ openThread: null });
      }

      const delay = get().prefs?.markReadDelayMs ?? 900;
      if (delay >= 0 && !message.seen) {
        setTimeout(() => {
          if (get().openId === id) void get().act([id], { type: 'flag', add: ['seen'], remove: [] });
        }, delay);
      }
    } catch (e) {
      set({ readerLoading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openNext(delta) {
    const rows = get().result?.messages ?? [];
    const i = rows.findIndex((m) => m.id === get().openId);
    const target = rows[Math.min(rows.length - 1, Math.max(0, i + delta))];
    if (target && target.id !== get().openId) await get().open(target.id, 'replace');
  },

  async loadThreadBody(id) {
    const api = await getApi();
    let full: Message;
    try {
      full = await api.get(id);
    } catch (e) {
      // Record the failure on the row itself so the strip can say so, rather
      // than spinning forever or raising a toast about a collapsed item.
      full = { ...(get().openThread?.messages.find((m) => m.id === id) as Message) };
      if (!full.id) return;
      full.bodyError = e instanceof Error ? e.message : String(e);
    }

    const thread = get().openThread;
    // The user may have moved to another message while this was in flight.
    if (!thread?.messages.some((m) => m.id === id)) return;
    set({
      openThread: {
        ...thread,
        messages: thread.messages.map((m) => (m.id === id ? full : m)),
      },
    });
  },

  /* ── Actions ────────────────────────────────────────────────────────────── */

  async act(ids, action, label) {
    if (!ids.length) return;
    const { result } = get();
    const removes = action.type === 'move' || action.type === 'delete';
    const target = new Set(ids);

    // 1. Paint immediately — every copy of the message, and the aggregates.
    const before = result?.messages ?? [];
    const touched = before.filter((m) => target.has(m.id));
    const deltas = countDeltas(get(), touched, action);
    if (result) {
      const patched = removes
        ? before.filter((m) => !target.has(m.id))
        : before.map((m) => (target.has(m.id) ? applyLocally(m, action) : m));
      set({ result: { ...result, messages: patched } });
    }
    if (!removes) {
      // The reader and the thread strip hold their own copies. Until this
      // existed, pressing `s` while reading flipped the star on the list row
      // behind the reader and left the reader's own star showing the state from
      // before the keystroke.
      const open = get().openMessage;
      if (open && target.has(open.id)) set({ openMessage: applyLocally(open, action) });
      const thread = get().openThread;
      if (thread?.messages.some((m) => target.has(m.id))) {
        set({
          openThread: {
            ...thread,
            messages: thread.messages.map((m) => (target.has(m.id) ? applyLocally(m, action) : m)),
          },
        });
      }
    }
    adjustCounts(set, get, deltas);

    if (removes) {
      for (const id of ids) pendingRemoval.add(id);
      // Focus the row that slid into the gap, not nothing.
      const i = before.findIndex((m) => m.id === ids[0]);
      const survivor = before.slice(i).find((m) => !target.has(m.id)) ?? before[i - 1];
      set({ focusedId: survivor?.id ?? null, selectedIds: new Set() });
      if (get().openId && ids.includes(get().openId!)) {
        // The reader sliding onto the next message is a consequence of the
        // action, not a place the user chose to go.
        set({ openId: survivor?.id ?? null, openMessage: null, openThread: null, nav: 'replace' });
        if (survivor) void get().open(survivor.id, 'replace');
      }
    }

    // 2. Stage destructive work behind the undo window.
    const undoWindow = get().prefs?.undoWindowMs ?? 6000;
    if (removes && label) {
      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled) return;
        for (const id of ids) pendingRemoval.delete(id);
        const api = await getApi();
        await api.act(ids, action).catch(() => get().resync());
      }, undoWindow);

      get().toast(`${label} · ${ids.length} message${ids.length > 1 ? 's' : ''}`, () => {
        cancelled = true;
        clearTimeout(timer);
        for (const id of ids) pendingRemoval.delete(id);
        // Put the aggregates back as well. Undo that restores the rows but not
        // the numbers beside them leaves the sidebar lying until the next pass.
        adjustCounts(
          set,
          get,
          deltas.map((d) => ({ ...d, unread: -d.unread, total: -d.total })),
        );
        void get().refresh();
      });
      return;
    }

    // 3. Non-destructive: fire and reconcile. `resync` rather than `refresh`
    //    because the counts were painted optimistically too, and a failed write
    //    must not leave them adjusted for something that never happened.
    const api = await getApi();
    await api.act(ids, action).catch(() => get().resync());
  },

  async toggleRead(ids) {
    const target = ids ?? targetIds(get());
    const rows = get().result?.messages ?? [];
    const anyUnread = target.some((id) => rows.find((m) => m.id === id && !m.seen));
    await get().act(target, {
      type: 'flag',
      add: anyUnread ? ['seen'] : [],
      remove: anyUnread ? [] : ['seen'],
    });
  },

  async toggleFlag(ids) {
    const target = ids ?? targetIds(get());
    const rows = get().result?.messages ?? [];
    const anyUnflagged = target.some((id) => rows.find((m) => m.id === id && !m.flagged));
    await get().act(target, {
      type: 'flag',
      add: anyUnflagged ? ['flagged'] : [],
      remove: anyUnflagged ? [] : ['flagged'],
    });
  },

  async setFlag(ids, flagged) {
    if (!ids.length) return;
    await get().act(ids, { type: 'flag', add: flagged ? ['flagged'] : [], remove: flagged ? [] : ['flagged'] });
  },

  async setRead(ids, seen) {
    if (!ids.length) return;
    await get().act(ids, { type: 'flag', add: seen ? ['seen'] : [], remove: seen ? [] : ['seen'] });
  },

  async archive(ids) {
    const target = ids ?? targetIds(get());
    const first = (get().result?.messages ?? []).find((m) => m.id === target[0]);
    const archive = get().folders.find((f) => f.role === 'archive' && f.accountId === first?.accountId);
    if (!archive) {
      // Returning silently trains people to distrust the control — the keyboard
      // shortcut and the mobile swipe both looked like they had worked. Say why
      // nothing happened instead.
      get().toast(`No Archive folder on ${first ? 'that account' : 'this account'}`);
      return;
    }
    await get().act(target, { type: 'move', folderId: archive.id }, 'Archived');
  },

  async trash(ids) {
    const target = ids ?? targetIds(get());
    await get().act(target, { type: 'delete', permanent: false }, 'Moved to trash');
  },

  /* ── Compose ────────────────────────────────────────────────────────────── */

  setIdentity(accountId) {
    set({ identityId: accountId });
    // An open blank draft should follow the switch; one already written should
    // not silently change who it is from.
    const draft = get().composer;
    if (draft && !draft.subject && !draft.bodyText.trim()) {
      set({ composer: { ...draft, accountId } });
    }
  },

  compose(seed) {
    const accounts = get().accounts;
    set({
      composer: {
        id: '',
        accountId: seed?.accountId ?? get().identityId ?? scopeAccount(get()) ?? accounts[0]?.id ?? '',
        to: seed?.to ?? [],
        cc: seed?.cc ?? [],
        bcc: seed?.bcc ?? [],
        subject: seed?.subject ?? '',
        bodyText: seed?.bodyText ?? '',
        bodyHtml: null,
        inReplyTo: seed?.inReplyTo ?? null,
        forwardOf: seed?.forwardOf ?? null,
        attachments: [],
        updatedAt: new Date().toISOString(),
        sendAt: null,
      },
      composerMinimised: false,
    });
  },

  reply(all) {
    const m = get().openMessage;
    if (!m) return;
    const me = get().accounts.find((a) => a.id === m.accountId);
    const to = m.replyTo.length ? m.replyTo : [m.from];
    const cc = all
      ? [...m.to, ...m.cc].filter((a) => a.address !== me?.address && a.address !== m.from.address)
      : [];
    get().compose({
      accountId: m.accountId,
      to,
      cc,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      inReplyTo: m.id,
      bodyText: `\n\nOn ${new Date(m.date).toLocaleString('en-GB')}, ${m.from.name ?? m.from.address} wrote:\n> ${(m.bodyText ?? m.preview).split('\n').join('\n> ')}`,
    });
  },

  forward() {
    const m = get().openMessage;
    if (!m) return;
    get().compose({
      accountId: m.accountId,
      subject: /^fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
      forwardOf: m.id,
      bodyText: `\n\n---------- Forwarded message ----------\nFrom: ${m.from.name ?? m.from.address} <${m.from.address}>\nDate: ${new Date(m.date).toLocaleString('en-GB')}\nSubject: ${m.subject}\n\n${m.bodyText ?? m.preview}`,
    });
  },

  closeComposer() {
    set({ composer: null, composerMinimised: false });
  },

  async sendComposer() {
    const draft = get().composer;
    if (!draft) return;
    const api = await getApi();
    set({ composer: null });
    try {
      const saved = await api.saveDraft(draft);
      await api.send(saved.id);
      get().toast('Sent');
    } catch (e) {
      get().toast(`Send failed — ${e instanceof Error ? e.message : 'unknown error'}`);
      set({ composer: draft });
    }
  },

  /* ── Settings ───────────────────────────────────────────────────────────── */

  async setLabels(ids, add, remove) {
    if (!ids.length || (!add.length && !remove.length)) return;
    const verb =
      add.length && !remove.length
        ? `Labelled ${add.join(', ')}`
        : remove.length && !add.length
          ? `Removed ${remove.join(', ')}`
          : 'Labels updated';
    await get().act(ids, { type: 'label', add, remove }, verb);
  },

  async moveTo(ids, folderId, folderName) {
    if (!ids.length) return;
    await get().act(ids, { type: 'move', folderId }, `Moved to ${folderName}`);
  },

  async createFolder(accountId, name, parentId) {
    try {
      const api = await getApi();
      const folder = await api.createFolder({ accountId, name, parentId });
      // Re-read rather than appending: the server decides the final path,
      // nesting and position, and the folder pass has already recorded them.
      const folders = await api.listFolders();
      set({ folders });
      get().toast(`Created ${folder.name}`);
      return folder;
    } catch (e) {
      get().toast(e instanceof Error ? e.message : 'Could not create that folder');
      return null;
    }
  },

  async setLabelColor(label, color) {
    const prefs = get().prefs;
    if (!prefs) return;
    const labelColors = { ...prefs.theme.labelColors };
    if (color) labelColors[label] = color;
    else delete labelColors[label];
    await get().saveTheme({ labelColors });
  },

  async updateFolder(id, patch) {
    // Paints first like every other mutation here: a colour that waits for a
    // round trip feels broken even when it is merely honest.
    const before = get().folders.find((f) => f.id === id);
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
    try {
      const api = await getApi();
      await api.updateFolder(id, patch);
    } catch (e) {
      // Paint-first is a promise that the screen will end up telling the truth,
      // not that the write succeeded. Leaving the optimistic value in place on
      // failure breaks the half that matters.
      if (before) set({ folders: get().folders.map((f) => (f.id === id ? before : f)) });
      get().toast(e instanceof Error ? e.message : 'Could not update that folder');
    }
  },

  async triggerSync(accountId) {
    const api = await getApi();
    await api.triggerSync(accountId);
  },

  async updateAccount(id, patch) {
    const before = get().accounts.find((a) => a.id === id);
    set({ accounts: get().accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
    try {
      const api = await getApi();
      const saved = await api.updateAccount(id, patch);
      // Take the server's row rather than keeping the guess: `priority` also
      // rewrites every message's denormalised copy, so the response is the only
      // thing that knows what the account now actually is.
      set({ accounts: get().accounts.map((a) => (a.id === id ? saved : a)) });
    } catch (e) {
      if (before) set({ accounts: get().accounts.map((a) => (a.id === id ? before : a)) });
      get().toast(e instanceof Error ? e.message : 'Could not update that account');
      return;
    }
    if (patch.priority || patch.hidden !== undefined) void get().refresh();
  },

  /* ── Sidebar groups ─────────────────────────────────────────────────────── */

  async createAccountGroup(name) {
    const prefs = get().prefs;
    const trimmed = name.trim();
    if (!prefs || !trimmed) return null;
    const id = `grp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await get().savePrefs({
      accountGroups: [
        ...prefs.accountGroups,
        {
          id,
          name: trimmed,
          color: null,
          collapsed: false,
          accountIds: [],
          position: prefs.accountGroups.length,
        },
      ],
    });
    return id;
  },

  async renameAccountGroup(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    await patchGroup(get, id, (g) => ({ ...g, name: trimmed }));
  },

  async setAccountGroupColor(id, color) {
    await patchGroup(get, id, (g) => ({ ...g, color }));
  },

  async toggleAccountGroup(id) {
    await patchGroup(get, id, (g) => ({ ...g, collapsed: !g.collapsed }));
  },

  async removeAccountGroup(id) {
    const prefs = get().prefs;
    if (!prefs) return;
    const gone = prefs.accountGroups.find((g) => g.id === id);
    // Deleting a group must not read as deleting mailboxes. They go back to
    // being ungrouped, which is where they came from.
    await get().savePrefs({
      accountGroups: prefs.accountGroups
        .filter((g) => g.id !== id)
        .map((g, i) => ({ ...g, position: i })),
    });
    if (gone) get().toast(`Removed group “${gone.name}”`);
  },

  async moveAccountToGroup(accountId, groupId, index) {
    const prefs = get().prefs;
    if (!prefs) return;
    const groups = prefs.accountGroups.map((g) => ({
      ...g,
      // An account belongs to exactly one group, so it leaves every other on
      // the way in. Anything else and a mailbox shows up twice in one sidebar.
      accountIds: g.accountIds.filter((id) => id !== accountId),
    }));
    const destination = groupId ? groups.find((g) => g.id === groupId) : null;
    if (groupId && !destination) return;
    if (destination) {
      const at = index === undefined ? destination.accountIds.length : index;
      destination.accountIds = [
        ...destination.accountIds.slice(0, at),
        accountId,
        ...destination.accountIds.slice(at),
      ];
    }
    await get().savePrefs({ accountGroups: groups });
  },

  async updateAccountPassword(id, password) {
    const api = await getApi();
    try {
      const account = await api.updatePassword(id, password);
      set({ accounts: get().accounts.map((a) => (a.id === id ? account : a)) });
      get().toast(`${account.address} reconnected`);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },

  async removeAccount(id) {
    const api = await getApi();
    const gone = get().accounts.find((a) => a.id === id);
    await api.deleteAccount(id);
    set({
      accounts: get().accounts.filter((a) => a.id !== id),
      folders: get().folders.filter((f) => f.accountId !== id),
    });
    get().toast(`${gone?.address ?? 'Account'} removed`);
    // The list may have been scoped to it, or showing its mail in a unified view.
    void get().refresh();
  },

  async savePrefs(patch) {
    const prefs = get().prefs;
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    set({ prefs: next });
    applyTheme(next.theme);
    try {
      const api = await getApi();
      await api.savePreferences(next);
    } catch (e) {
      // Preferences are written whole, so a failed write means the stored blob
      // is still the previous one — and the screen must go back to matching it,
      // or the next reload silently undoes a change the user watched happen.
      set({ prefs });
      applyTheme(prefs.theme);
      get().toast(e instanceof Error ? e.message : 'Could not save that setting');
    }
  },

  async saveTheme(patch) {
    const prefs = get().prefs;
    if (!prefs) return;
    await get().savePrefs({ theme: { ...prefs.theme, ...patch } });
  },

  async saveCurrentView(name, glyph) {
    const api = await getApi();
    const view = await api.saveView({ name, glyph, query: get().query, pinned: true });
    set({ views: [...get().views, view] });
    get().toast(`Saved view “${name}”`);
  },

  /* ── Session ────────────────────────────────────────────────────────────── */

  async changePassword(currentPassword, newPassword) {
    const api = await getApi();
    try {
      await api.changePassword(currentPassword, newPassword);
      get().toast('Password changed');
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },

  async signOut() {
    const api = await getApi();
    try {
      await api.signOut();
    } catch {
      // The session is going away either way. A network failure here means the
      // cookie may outlive the click, which is a reason to reload rather than a
      // reason to stay signed in on screen — the reload's first request finds
      // out for certain.
    }
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    // A reload, not a state reset.
    //
    // Every message summary, every cached body and the event stream itself live
    // in this document. Clearing the fifteen slices that hold them by hand is a
    // list that goes stale the first time a sixteenth is added, and the one that
    // gets forgotten is someone's mail still on screen after they signed out.
    window.location.reload();
  },

  /* ── Overlays ───────────────────────────────────────────────────────────── */

  setPalette(open) {
    set({ palette: open });
  },
  setSettings(tab) {
    // Opening is going somewhere, so it earns a history entry and Back closes
    // it. Closing is handled by the router, which steps back out of the entry
    // that opened it rather than stacking another.
    set({ settings: tab, nav: tab ? 'push' : 'replace' });
  },
  setOnboarding(open) {
    set({ onboarding: open });
  },

  toast(message, undo) {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const window = get().prefs?.undoWindowMs ?? 6000;
    set({ toasts: [...get().toasts, { id, message, undo, expiresAt: Date.now() + window }] });
    toastTimers.set(
      id,
      setTimeout(() => get().dismissToast(id), window),
    );
  },

  dismissToast(id) {
    const timer = toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

// Dev-only handle for poking at state from the console. Stripped from
// production builds by the constant-folded import.meta.env.DEV check.
if (import.meta.env.DEV) {
  (globalThis as unknown as { __store: typeof useStore }).__store = useStore;
}

/** One group changed, the rest untouched. Every group mutation but reordering
 *  is this shape, so it is written once. */
function patchGroup(
  get: () => State & Actions,
  id: Id,
  fn: (g: AccountGroup) => AccountGroup,
): Promise<void> {
  const prefs = get().prefs;
  if (!prefs) return Promise.resolve();
  return get().savePrefs({
    accountGroups: prefs.accountGroups.map((g) => (g.id === id ? fn(g) : g)),
  });
}

/* ── Event helpers ──────────────────────────────────────────────────────────── */

type Set_ = (partial: Partial<State>) => void;
type Get_ = () => State & Actions;

/**
 * Coalesced re-read.
 *
 * A sync pass over a dozen accounts publishes a dozen "something changed"
 * events inside a second, and each one un-coalesced is a full list query. The
 * delay is short enough that new mail still lands while you are looking at it.
 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_COALESCE_MS = 250;

function scheduleRefresh(get: Get_): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const s = get();
    // A refresh re-reads the first page only, so doing it under someone who has
    // paged down four times throws away three of those pages and drops them
    // back to the top mid-scroll. New mail is worth interrupting a glance at
    // the inbox; it is not worth losing your place. They will see it on their
    // next navigation, or on `r`.
    if ((s.result?.messages.length ?? 0) > s.query.limit) return;
    void s.refresh();
  }, REFRESH_COALESCE_MS);
}

/**
 * Apply a patch to every copy of a message the app is holding.
 *
 * There are three, and they went out of step constantly: the list row, the open
 * message, and the member of the open thread. Pressing `s` in the reader
 * flipped the star in the list and left the reader's own star unchanged,
 * because only the first of the three was ever patched.
 */
function patchMessages(
  set: Set_,
  get: Get_,
  ids: Id[],
  patch: Partial<MessageSummary>,
): void {
  if (!ids.length || !Object.keys(patch).length) return;
  const s = get();
  const hit = new Set(ids);
  const next: Partial<State> = {};

  if (s.result) {
    next.result = {
      ...s.result,
      messages: s.result.messages.map((m) => (hit.has(m.id) ? { ...m, ...patch } : m)),
    };
  }
  if (s.openMessage && hit.has(s.openMessage.id)) {
    next.openMessage = { ...s.openMessage, ...patch };
  }
  if (s.openThread?.messages.some((m) => hit.has(m.id))) {
    next.openThread = {
      ...s.openThread,
      messages: s.openThread.messages.map((m) => (hit.has(m.id) ? { ...m, ...patch } : m)),
    };
  }
  if (Object.keys(next).length) set(next);
}

/** A message that no longer exists anywhere we are showing it. */
function dropMessages(set: Set_, get: Get_, ids: Id[]): void {
  const s = get();
  if (!s.result) return;
  const gone = new Set(ids);
  set({
    result: { ...s.result, messages: s.result.messages.filter((m) => !gone.has(m.id)) },
    // A selection that outlives its rows is how a bulk action lands on messages
    // the user can no longer see.
    selectedIds: new Set([...s.selectedIds].filter((id) => !gone.has(id))),
  });
}

/**
 * Move the sidebar's numbers now, before the server confirms them.
 *
 * The counts come back over SSE within a moment and overwrite whatever this
 * guessed, so being approximate here is safe and being slow is not: marking
 * twelve messages read and watching the unread badge sit still for a round trip
 * is the single most obvious way for a mail client to feel broken.
 */
function adjustCounts(
  set: Set_,
  get: Get_,
  deltas: { folderId: Id; accountId: Id; unread: number; total: number }[],
): void {
  if (!deltas.length) return;
  const s = get();
  const byFolder = new Map<Id, { unread: number; total: number }>();
  const byAccount = new Map<Id, { unread: number; total: number }>();
  for (const d of deltas) {
    const f = byFolder.get(d.folderId) ?? { unread: 0, total: 0 };
    byFolder.set(d.folderId, { unread: f.unread + d.unread, total: f.total + d.total });
    const a = byAccount.get(d.accountId) ?? { unread: 0, total: 0 };
    byAccount.set(d.accountId, { unread: a.unread + d.unread, total: a.total + d.total });
  }

  const clamp = (n: number) => Math.max(0, n);
  set({
    folders: s.folders.map((f) => {
      const d = byFolder.get(f.id);
      return d ? { ...f, unread: clamp(f.unread + d.unread), total: clamp(f.total + d.total) } : f;
    }),
    accounts: s.accounts.map((a) => {
      const d = byAccount.get(a.id);
      return d ? { ...a, unread: clamp(a.unread + d.unread), total: clamp(a.total + d.total) } : a;
    }),
  });
}

/**
 * What an action does to the folder and account aggregates, per message.
 *
 * Read off the rows the list already holds — the alternative is asking the
 * server what it just did, which is the round trip this exists to avoid.
 */
function countDeltas(
  s: State,
  rows: MessageSummary[],
  action: MessageAction,
): { folderId: Id; accountId: Id; unread: number; total: number }[] {
  const out: { folderId: Id; accountId: Id; unread: number; total: number }[] = [];

  if (action.type === 'flag') {
    const seenAdded = action.add.includes('seen');
    const seenRemoved = action.remove.includes('seen');
    if (!seenAdded && !seenRemoved) return out;
    for (const m of rows) {
      // Only a row that actually flips moves a number. Marking read what is
      // already read must not decrement anything.
      if (seenAdded && m.seen) continue;
      if (seenRemoved && !m.seen) continue;
      out.push({ folderId: m.folderId, accountId: m.accountId, unread: seenAdded ? -1 : 1, total: 0 });
    }
    return out;
  }

  if (action.type === 'move' || action.type === 'delete') {
    for (const m of rows) {
      const to =
        action.type === 'move'
          ? action.folderId
          : action.permanent
            ? null
            : (s.folders.find((f) => f.role === 'trash' && f.accountId === m.accountId)?.id ?? null);
      if (to === m.folderId) continue;
      const unread = m.seen ? 0 : 1;
      out.push({ folderId: m.folderId, accountId: m.accountId, unread: -unread, total: -1 });
      // A permanent delete has no destination, so the account loses the message
      // outright; a move keeps it and only relocates it.
      if (to) out.push({ folderId: to, accountId: m.accountId, unread, total: 1 });
    }
  }
  return out;
}

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/** Bulk actions apply to the selection; with nothing selected they apply to the
 *  focused row. This is what makes the keyboard path feel like one thing. */
function targetIds(s: State): Id[] {
  if (s.selectedIds.size) return [...s.selectedIds];
  return s.focusedId ? [s.focusedId] : [];
}

/** How many recent scopes the palette offers before the static list. Past about
 *  five, a "recent" list stops being recall and becomes another list to read
 *  (Miller). */
const RECENT_MAX = 5;

/**
 * Recent searches, persisted.
 *
 * Unlike recent *scopes* — which are only meaningful inside one session's train
 * of thought — a query you ran last week is still the query you want, so this
 * one outlives the tab. Capped and de-duplicated; a query typed one character
 * at a time must not fill the list with its own prefixes, which is why only
 * committed searches reach here and each supersedes its own prefix.
 */
const RECENT_SEARCH_KEY = 'mail.recentSearches';

function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCH_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberSearch(list: string[], raw: string | null): string[] {
  const q = raw?.trim();
  if (!q || q.length < 2) return list;
  const next = [q, ...list.filter((s) => s !== q && !q.startsWith(s))].slice(0, 6);
  try {
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
  } catch {
    /* a full or disabled localStorage is not worth failing a search over */
  }
  return next;
}

function remember(list: Scope[], scope: Scope): Scope[] {
  // Home is one keystroke and the first thing in the palette already; listing
  // it as recent would push a genuinely useful entry off the end.
  if (scope.kind === 'unified' && scope.role === 'inbox') return list;
  return [scope, ...list.filter((s) => !sameScope(s, scope))].slice(0, RECENT_MAX);
}

/** The account the current scope belongs to, if it belongs to exactly one.
 *  Composing from inside an account should default to that address. */
function scopeAccount(s: State): Id | null {
  const { scope } = s.query;
  if (scope.kind === 'account') return scope.value;
  if (scope.kind === 'folder') {
    return s.folders.find((f) => f.id === scope.value)?.accountId ?? null;
  }
  return null;
}

function applyLocally<T extends { seen: boolean; flagged: boolean; answered: boolean; labels: string[] }>(
  m: T,
  action: MessageAction,
): T {
  if (action.type === 'flag') {
    const next = { ...m };
    for (const f of action.add) {
      if (f === 'seen') next.seen = true;
      if (f === 'flagged') next.flagged = true;
      if (f === 'answered') next.answered = true;
    }
    for (const f of action.remove) {
      if (f === 'seen') next.seen = false;
      if (f === 'flagged') next.flagged = false;
    }
    return next;
  }
  if (action.type === 'label') {
    const set = new Set(m.labels);
    for (const l of action.add) set.add(l);
    for (const l of action.remove) set.delete(l);
    return { ...m, labels: [...set] };
  }
  return m;
}

/**
 * Give unassigned domains a colour.
 *
 * Hues are spread around the wheel by index rather than hashed, so a user with
 * seven domains gets seven maximally distinct colours instead of whatever a
 * hash happens to collide on. Existing choices are never overwritten.
 * Returns null when nothing needed assigning, so boot can skip the write.
 */
function assignDomainColors(
  accounts: Account[],
  existing: Record<string, string>,
): Record<string, string> | null {
  const domains = [...new Set(accounts.map((a) => a.domain))].sort();
  const missing = domains.filter((d) => !existing[d]);
  if (!missing.length) return null;

  const next = { ...existing };
  // Start from the accent hue and walk the wheel by the golden angle, which
  // keeps consecutive assignments far apart at any count.
  const GOLDEN = 137.508;
  for (const [i, domain] of domains.entries()) {
    if (next[domain]) continue;
    next[domain] = `oklch(64% 0.16 ${Math.round((250 + i * GOLDEN) % 360)})`;
  }
  return next;
}

/** Push theme tokens onto :root. This is the entire theming mechanism. */
export function applyTheme(theme: Preferences['theme']) {
  const root = document.documentElement;
  const mode =
    theme.mode === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme.mode;
  root.dataset.theme = mode;
  root.dataset.density = theme.density;
  root.dataset.contrast = theme.contrast;
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--radius', `${theme.radius}px`);
  root.style.fontSize = `${16 * theme.fontScale}px`;
  if (theme.reduceMotion) root.dataset.motion = 'reduced';
  else delete root.dataset.motion;

  localStorage.setItem(
    'mail.theme',
    JSON.stringify({ mode: theme.mode, accent: theme.accent, density: theme.density, radius: theme.radius }),
  );
}

/* ── Derived selectors ──────────────────────────────────────────────────────── */

/**
 * The list, grouped.
 *
 * Memoised, and it has to be. This returned a freshly-built array on every
 * render, which made the virtualiser's positioned-item array change identity on
 * every render too — and the effect that keeps the keyboard-focused row in view
 * depends on that array. So every scroll event re-ran "scroll the focused row
 * into view", and since the focused row is the first row until you move it, the
 * list snapped back to the top the instant you touched the wheel. The list was
 * unscrollable.
 *
 * This is the third time an unstable selector return has caused a real bug
 * here. The rule is not a style preference: a
 * derived array that is not memoised is a re-render loop or a reset waiting for
 * something to depend on it.
 */
export function useGroups(): Group[] {
  const messages = useStore((s) => s.result?.messages);
  const group = useStore((s) => s.query.group);
  const accounts = useStore((s) => s.accounts);
  const folders = useStore((s) => s.folders);

  return useMemo(() => {
    if (!messages) return EMPTY_GROUPS;
    return groupMessages(messages, group, {
      accountLabel: (id) => accounts.find((a) => a.id === id)?.label ?? id,
      accountDomain: (id) => accounts.find((a) => a.id === id)?.domain ?? '',
      folderName: (id) => folders.find((f) => f.id === id)?.name ?? id,
    });
  }, [messages, group, accounts, folders]);
}

/** One shared empty array. `return []` here is a new identity every render,
 *  which is the same bug in its smallest form. */
const EMPTY_GROUPS: Group[] = [];

/**
 * Domain → its accounts, ordered. The sidebar's primary structure.
 *
 * Memoised for the same reason `useGroups` is: it is read by both the rail and
 * the sidebar on every render, and it sorts every account and every domain each
 * time it is called. Unmemoised it was also a fresh array identity per render,
 * which is one `useEffect` dependency away from the loop that rule exists to
 * prevent.
 */
export function useDomains(): { domain: string; accounts: Account[]; unread: number }[] {
  const accounts = useStore((s) => s.accounts);
  return useMemo(() => groupByDomain(accounts), [accounts]);
}

function groupByDomain(accounts: Account[]): { domain: string; accounts: Account[]; unread: number }[] {
  const map = new Map<string, Account[]>();
  for (const a of accounts) {
    const list = map.get(a.domain);
    if (list) list.push(a);
    else map.set(a.domain, [a]);
  }
  return [...map.entries()]
    .map(([domain, list]) => ({
      domain,
      accounts: list.sort((x, y) => x.position - y.position),
      unread: list.reduce((n, a) => n + a.unread, 0),
    }))
    .sort((a, b) => {
      const wa = Math.max(...a.accounts.map((x) => PRIORITY_ORDER[x.priority]));
      const wb = Math.max(...b.accounts.map((x) => PRIORITY_ORDER[x.priority]));
      return wb - wa || a.domain.localeCompare(b.domain);
    });
}

/** A group as the sidebar draws it: the stored record resolved against the
 *  accounts that still exist, with the unread total already summed. */
export interface ResolvedGroup {
  group: AccountGroup;
  accounts: Account[];
  unread: number;
}

/**
 * The Accounts section, as two lists: the user's groups, then whatever is not
 * in one, still grouped by domain.
 *
 * Membership ids that no longer resolve are skipped rather than pruned. An
 * account removed and re-added — a credential repair, most often — should land
 * back where the user put it instead of at the bottom of the ungrouped pile.
 */
export function useSidebarGroups(): { groups: ResolvedGroup[]; ungrouped: ReturnType<typeof groupByDomain> } {
  const accounts = useStore((s) => s.accounts);
  const stored = useStore((s) => s.prefs?.accountGroups);

  return useMemo(() => {
    const list = stored ?? EMPTY_ACCOUNT_GROUPS;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const claimed = new Set<Id>();

    const groups = [...list]
      .sort((a, b) => a.position - b.position)
      .map((group) => {
        const members: Account[] = [];
        for (const id of group.accountIds) {
          const account = byId.get(id);
          if (!account || claimed.has(id)) continue;
          claimed.add(id);
          members.push(account);
        }
        return { group, accounts: members, unread: members.reduce((n, a) => n + a.unread, 0) };
      });

    return { groups, ungrouped: groupByDomain(accounts.filter((a) => !claimed.has(a.id))) };
  }, [accounts, stored]);
}

const EMPTY_ACCOUNT_GROUPS: AccountGroup[] = [];

const PRIORITY_ORDER: Record<Account['priority'], number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
  muted: 0,
};

export const useAccountColor = () => {
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.prefs);
  return (accountId: Id): string => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return 'var(--n-5)';
    return a.color ?? prefs?.theme.domainColors[a.domain] ?? 'var(--n-5)';
  };
};

export { collapseThreads };
