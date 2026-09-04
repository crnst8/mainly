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
import { usePrefersDark } from './media';
import { printMessage } from './print';
import { remoteImagesAllowed } from './sender';
import { parseLocation, routeDefaults, sameFilters, sameScope, type RouteState } from './url';
import { groupMemberTint, groupTintsMembers, withPreferenceDefaults } from './types';
import type {
  Account,
  AccountGroup,
  Draft,
  Folder,
  Id,
  ListQuery,
  ListResult,
  MailColors,
  Message,
  MessageAction,
  MessageSummary,
  Preferences,
  PrintColors,
  SavedView,
  Scope,
  Session,
  SyncState,
  ThemeMode,
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
  /**
   * A one-message answer to "re-light this, or show it as sent?".
   *
   * `null` means "whatever the preference says", which is the state every
   * message opens in. An explicit boolean is the reader having overruled it for
   * *this* message, and it is deliberately not sticky: the reason to see one
   * message as sent — a colour swatch, a chart, something that looked wrong —
   * is a property of that message, and carrying the answer to the next one
   * would silently turn a glance into a setting.
   */
  mailOverride: boolean | null;
  /**
   * The same shape of answer for remote images: `null` defers to the sender's
   * standing permission, a boolean is this message only.
   *
   * It lives here rather than in the reader because two components render a
   * message and a third — the printer — has to know what the reader agreed to.
   * Held locally it was also reset by *any* preference write, so adjusting the
   * density in settings put the blocked-images notice back over a message whose
   * images you were looking at.
   */
  mailRemote: boolean | null;

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
  help: string | null;
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
  /** `extend` grows the selection from the anchor instead of moving alone —
   *  shift+j/k, the keyboard's version of a shift-click. */
  moveFocus(delta: number, extend?: boolean): void;
  /** `range` selects everything between the anchor and `id`, in the order the
   *  list is actually drawn in — shift-click, by another name. */
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
  /** Override the re-lighting of the open message, or `null` to hand it back
   *  to the preference. */
  setMailOverride(dark: boolean | null): void;
  /** Show or hide the open message's remote images, or `null` to hand the
   *  answer back to the sender's standing permission. */
  setMailRemote(show: boolean | null): void;
  /** Send the open message to the printer. `colors` defaults to the
   *  preference. */
  printOpen(colors?: PrintColors): void;
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
  /**
   * Mark every unread message in a set of mailboxes read.
   *
   * Not `setRead` with a list of ids: the list holds one page of one scope, and
   * "mark this group read" is about mail that is mostly not on screen. The
   * unread set is read back through the ordinary query API — the same path the
   * list uses — so there is no second definition of what unread means.
   */
  markAccountsRead(accountIds: Id[], label: string, folderIds?: Id[]): Promise<void>;
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
  /** Whether the group's colour cascades to the mailboxes in it. */
  toggleAccountGroupTint(id: Id): Promise<void>;
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
  setHelp(guide: string | null): void;
  setSettings(tab: string | null): void;
  setOnboarding(open: boolean): void;
  toast(message: string, undo?: () => void): void;
  dismissToast(id: string): void;
}

/** Ids that are staged for removal but still inside the undo window. Kept out
 *  of the store so re-renders do not depend on them. */
const pendingRemoval = new Set<Id>();

/* Bulk mark-read paging. A page is large because the rows are thrown away and
   only the ids kept; the cap is what stops "mark read" on a hundred-thousand
   message archive from becoming a job with no progress bar. The write chunk is
   smaller so one rejected batch does not take the whole set with it. */
const MARK_READ_PAGE = 500;
const MARK_READ_MAX = 20_000;
const MARK_READ_CHUNK = 250;

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

/** There can only be one message held open. Clearing the previous timer when
 *  navigation moves keeps a quick j/k pass from leaving a trail of messages
 *  that become read after the user has already left them. */
let markReadTimer: ReturnType<typeof setTimeout> | null = null;
let openGeneration = 0;

function cancelMarkRead(): void {
  if (!markReadTimer) return;
  clearTimeout(markReadTimer);
  markReadTimer = null;
}

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
  mailOverride: null,
  mailRemote: null,

  composer: null,
  composerMinimised: false,
  identityId: null,
  recentScopes: [],
  recentSearches: loadRecentSearches(),
  searchBase: null,

  palette: false,
  help: null,
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

  moveFocus(delta, extend) {
    const rows = visualOrder(get());
    if (!rows.length) return;
    const i = rows.indexOf(get().focusedId ?? '');
    const next = Math.min(rows.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta));
    const target = rows[next];
    if (!target) return;

    // Shift+j/k is the keyboard's shift-click: it grows the selection from the
    // anchor and leaves the reader where it is, because extending a selection
    // is not going somewhere.
    if (extend) {
      if (!get().anchorId) set({ anchorId: rows[i === -1 ? 0 : i] ?? target });
      get().toggleSelect(target, 'range');
      return;
    }

    set({ focusedId: target, anchorId: target });
    // The reader following j/k is not navigation. Pushing here would turn Back
    // into an undo stack for keystrokes.
    if (get().openId) void get().open(target, 'replace');
  },

  toggleSelect(id, mode = 'add') {
    const { selectedIds, anchorId } = get();
    const next = new Set(selectedIds);

    if (mode === 'single') {
      set({ selectedIds: new Set([id]), anchorId: id, focusedId: id });
      return;
    }

    if (mode === 'range') {
      const rows = visualOrder(get());
      // No anchor means nothing has been touched in this list yet, so the range
      // is from the top — which is what a shift-click into a fresh list means
      // everywhere else. Falling through to a plain toggle instead is how a
      // shift-click used to select exactly one message.
      const from = anchorId ?? rows[0];
      const a = from ? rows.indexOf(from) : -1;
      const b = rows.indexOf(id);
      if (a !== -1 && b !== -1) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i]!);
        // The anchor stays put: shift-clicking again re-ranges from the same
        // place, so overshooting is corrected by a second click rather than by
        // starting over.
        set({ selectedIds: next, anchorId: from, focusedId: id });
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
    const generation = ++openGeneration;
    cancelMarkRead();
    if (!id) {
      set({
        openId: null,
        openMessage: null,
        openThread: null,
        mailOverride: null,
        mailRemote: null,
        nav: mode,
      });
      return;
    }
    // Opening is a deliberate touch of one row, so it becomes the anchor: a
    // shift-click after reading something ranges from the message you read
    // rather than from wherever the selection last happened to be.
    set({
      openId: id,
      openThread: null,
      readerLoading: true,
      focusedId: id,
      anchorId: id,
      mailOverride: null,
      mailRemote: null,
      nav: mode,
    });
    try {
      const api = await getApi();
      const message = await api.get(id);
      // Only commit if the user has not moved on while this was in flight.
      if (get().openId !== id || generation !== openGeneration) return;
      set({ openMessage: message, readerLoading: false });

      // Reading starts when the message is visible, not when the secondary
      // thread request happens to finish. Previously a slow or failed thread
      // read meant this timer was never created, so clicking unread mail could
      // leave it unread indefinitely.
      const delay = get().prefs?.markReadDelayMs ?? 900;
      const listed = get().result?.messages.find((m) => m.id === id);
      // In threaded mode the row is unread when *any* member is unread, while
      // `message` describes only the newest representative. Trusting the latter
      // skipped auto-read whenever that newest message had already been seen.
      const unreadAtOpen = listed ? !listed.seen : !message.seen;
      let readDelayElapsed = false;
      if (delay >= 0 && unreadAtOpen) {
        markReadTimer = setTimeout(() => {
          markReadTimer = null;
          readDelayElapsed = true;
          const current = get();
          if (current.openId !== id || generation !== openGeneration) return;
          // A collapsed row represents the conversation. Mark every unread
          // member we know about so the next thread-count refresh cannot make
          // the row spring back to unread.
          const unread = current.openThread?.messages.filter((m) => !m.seen).map((m) => m.id) ?? [];
          void current.act([...new Set([id, ...unread])], { type: 'flag', add: ['seen'], remove: [] });
        }, delay);
      }

      if (get().query.threaded && message.threadId) {
        const thread = await api.getThread(message.threadId);
        if (get().openId === id && generation === openGeneration) {
          set({ openThread: thread.messages.length > 1 ? thread : null });
          // With an instant/short delay the timer can beat the thread lookup.
          // Finish the conversation once its member ids arrive.
          if (readDelayElapsed) {
            const unread = thread.messages.filter((m) => !m.seen && m.id !== id).map((m) => m.id);
            if (unread.length) {
              void get().act(unread, { type: 'flag', add: ['seen'], remove: [] });
            }
          }
        }
      } else {
        set({ openThread: null });
      }
    } catch (e) {
      set({ readerLoading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openNext(delta) {
    // The order on screen, not the order the page arrived in — "next message"
    // has to mean the row below the one you are reading.
    const rows = visualOrder(get());
    const i = rows.indexOf(get().openId ?? '');
    const target = rows[Math.min(rows.length - 1, Math.max(0, i + delta))];
    if (target && target !== get().openId) await get().open(target, 'replace');
  },

  setMailOverride(dark) {
    set({ mailOverride: dark });
  },

  setMailRemote(show) {
    set({ mailRemote: show });
  },

  printOpen(colors) {
    const { openMessage, prefs } = get();
    if (!openMessage) return;
    printMessage(openMessage, {
      colors: colors ?? prefs?.printColors ?? 'paper',
      // The printer gets exactly what the reader has already agreed to see.
      // Fetching a remote image for the print job would announce the open to
      // the sender through the back door, having just been told no at the
      // front one.
      loadRemote: showRemoteNow(get()),
    });
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
        set({
      openId: survivor?.id ?? null,
      openMessage: null,
      openThread: null,
      mailOverride: null,
      mailRemote: null,
      nav: 'replace',
    });
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

  async markAccountsRead(accountIds, label, folderIds) {
    if (!accountIds.length) return;
    const api = await getApi();
    const ids: Id[] = [];
    try {
      // One scope per mailbox rather than a unified scope filtered down to
      // them: a unified query drops hidden accounts, and a hidden mailbox is
      // still in the group, still counted in the number this menu just showed,
      // and still expected to go quiet when you ask the group to.
      for (const accountId of accountIds) {
        let cursor: string | null = null;
        do {
          const page: ListResult = await api.list({
            scope: { kind: 'account', value: accountId, role: null },
            sort: 'date',
            dir: 'desc',
            group: 'none',
            filters: { ...emptyFilters(), unreadOnly: true, folderIds: folderIds ?? [] },
            // Threads would collapse a conversation to one row and leave its
            // other unread members behind, which is the one thing "mark all
            // read" must not do.
            threaded: false,
            limit: MARK_READ_PAGE,
            cursor,
          });
          for (const m of page.messages) ids.push(m.id);
          cursor = page.nextCursor;
        } while (cursor && ids.length < MARK_READ_MAX);
      }
    } catch (e) {
      get().toast(e instanceof Error ? e.message : 'Could not read that mailbox');
      return;
    }

    if (!ids.length) {
      get().toast(`Nothing unread in ${label}`);
      return;
    }

    const write = async (seen: boolean) => {
      for (let i = 0; i < ids.length; i += MARK_READ_CHUNK) {
        await api.act(ids.slice(i, i + MARK_READ_CHUNK), {
          type: 'flag',
          add: seen ? ['seen'] : [],
          remove: seen ? [] : ['seen'],
        });
      }
      await get().resync();
    };

    try {
      await write(true);
    } catch (e) {
      get().toast(e instanceof Error ? e.message : 'Could not mark those read');
      void get().resync();
      return;
    }

    // Undoable, because the ids are already in hand and "mark 400 read" is
    // exactly the action someone fires at the wrong group.
    get().toast(`Marked ${ids.length} read · ${label}`, () => void write(false));
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
          tintMembers: true,
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

  async toggleAccountGroupTint(id) {
    await patchGroup(get, id, (g) => ({ ...g, tintMembers: !groupTintsMembers(g) }));
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
  setHelp(guide) {
    set({ help: guide });
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

/**
 * The ids of every row, in the order they are drawn.
 *
 * A range selection has to mean "everything between these two *on screen*".
 * `result.messages` is the sorted page; grouping reorders it — group by sender
 * and the twelve rows between two clicks are a different twelve. Reusing
 * `groupMessages` rather than mirroring it means the list and the selection
 * cannot disagree about what is between what.
 */
function visualOrder(state: State): Id[] {
  const messages = state.result?.messages ?? [];
  if (state.query.group === 'none') return messages.map((m) => m.id);
  const groups = groupMessages(messages, state.query.group, {
    accountLabel: (id) => state.accounts.find((a) => a.id === id)?.label ?? id,
    accountDomain: (id) => state.accounts.find((a) => a.id === id)?.domain ?? '',
    folderName: (id) => state.folders.find((f) => f.id === id)?.name ?? id,
  });
  return groups.flatMap((g) => g.messages.map((m) => m.id));
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
  root.dataset.weight = theme.fontWeight;
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--radius', `${theme.radius}px`);
  root.style.fontSize = `${16 * theme.fontScale}px`;
  if (theme.reduceMotion) root.dataset.motion = 'reduced';
  else delete root.dataset.motion;

  // Everything the pre-paint script in index.html can act on before React
  // exists. Type size and weight belong here for the same reason the colours
  // do: they change how big the first frame is, and reflowing the list one
  // frame in is the jump this cache was written to prevent.
  localStorage.setItem(
    'mail.theme',
    JSON.stringify({
      mode: theme.mode,
      accent: theme.accent,
      density: theme.density,
      radius: theme.radius,
      scale: theme.fontScale,
      weight: theme.fontWeight,
    }),
  );
}

/* ── Derived selectors ──────────────────────────────────────────────────────── */

/**
 * How the open message should be coloured, resolved.
 *
 * One definition, two entry points, because the question is asked from two
 * kinds of code: `useMailDark` for anything rendering, `mailDarkNow` for the
 * keyboard handler and the command palette, which have a store snapshot and no
 * hooks. They must never be able to disagree, so neither of them contains the
 * rule — `mailDarkFor` does.
 */
export function mailDarkFor(colors: MailColors, mode: ThemeMode, osDark: boolean): boolean {
  if (colors === 'sent') return false;
  if (colors === 'dark') return true;
  return mode === 'system' ? osDark : mode === 'dark';
}

/** The reader's own surface, resolved. What a mail body is put down on, which
 *  is not the same question as whether it gets re-lit. */
export function useThemeIsDark(): boolean {
  const mode = useStore((s) => s.prefs?.theme.mode ?? 'system');
  const osDark = usePrefersDark();
  return mode === 'system' ? osDark : mode === 'dark';
}

export function useMailDark(): boolean {
  const override = useStore((s) => s.mailOverride);
  const colors = useStore((s) => s.prefs?.mailColors ?? 'follow');
  const mode = useStore((s) => s.prefs?.theme.mode ?? 'system');
  const osDark = usePrefersDark();
  return override ?? mailDarkFor(colors, mode, osDark);
}

export function mailDarkNow(s: State & Actions): boolean {
  return (
    s.mailOverride ??
    mailDarkFor(
      s.prefs?.mailColors ?? 'follow',
      s.prefs?.theme.mode ?? 'system',
      matchMedia('(prefers-color-scheme: dark)').matches,
    )
  );
}

/** Whether the open message's remote images are showing — the per-message
 *  answer where there is one, the sender's standing permission otherwise. */
export function useShowRemote(): boolean {
  const override = useStore((s) => s.mailRemote);
  const prefs = useStore((s) => s.prefs);
  const from = useStore((s) => s.openMessage?.from ?? null);
  return override ?? remoteImagesAllowed(prefs, from);
}

export function showRemoteNow(s: State & Actions): boolean {
  return s.mailRemote ?? remoteImagesAllowed(s.prefs, s.openMessage?.from);
}

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

/**
 * accountId → the colour its group lends it.
 *
 * Built once per hook call rather than per row: this is asked for every line of
 * a thousand-row list. First group wins, matching `useSidebarGroups`, so a
 * mailbox named by two groups is drawn the same colour it is filed under.
 */
function groupTints(groups: AccountGroup[] | undefined): Map<Id, string> {
  const map = new Map<Id, string>();
  for (const g of groups ?? []) {
    const tint = groupMemberTint(g);
    if (!tint) continue;
    for (const id of g.accountIds) if (!map.has(id)) map.set(id, tint);
  }
  return map;
}

/**
 * What colour a mailbox is, everywhere it is drawn.
 *
 * Most specific wins: a colour set on the mailbox itself, then the one its
 * group lends it, then its domain's. The group sits in the middle because it is
 * a choice the user made about *these* mailboxes, where the domain colour is a
 * fact about the address — but a colour typed against one mailbox is more
 * specific still, and cascading over it would throw away an instruction.
 */
export const useAccountColor = () => {
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.prefs);
  const tints = useMemo(() => groupTints(prefs?.accountGroups), [prefs?.accountGroups]);
  return (accountId: Id): string => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return 'var(--n-5)';
    return a.color ?? tints.get(a.id) ?? prefs?.theme.domainColors[a.domain] ?? 'var(--n-5)';
  };
};

export { collapseThreads };
