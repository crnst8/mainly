/**
 * The API surface the UI is allowed to touch.
 *
 * Two implementations satisfy it: `mock/mock-api.ts` (in-memory, seeded) and
 * `http-api.ts` (the real backend). The UI cannot tell them apart, which means
 * the whole interface is buildable and demoable before the backend is written,
 * and the backend has an exact spec to implement.
 */

import type {
  Account,
  Autoconfig,
  BulkOnboardInput,
  BulkOnboardResult,
  Draft,
  Folder,
  Id,
  ListQuery,
  ListResult,
  Message,
  MessageAction,
  Preferences,
  SavedView,
  ServerEvent,
  DomainGrant,
  DomainOp,
  DomainProbe,
  ManagedDomain,
  ManagedMailbox,
  ServerConfig,
  Session,
  SyncState,
  Thread,
  VerifyResult,
} from './types';

export interface MailApi {
  /* Session — the app login, not a mailbox. See `Session` in types.ts. */

  /** Who is signed in. */
  session(): Promise<Session>;
  /** Change the app password. Resolves on success; rejects with the server's
   *  own words when the current password is wrong or the new one is refused.
   *  Every other browser session is signed out as a side effect. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** End this session server-side. The caller is responsible for what the
   *  browser does next. */
  signOut(): Promise<void>;

  /* Accounts */
  listAccounts(): Promise<Account[]>;
  updateAccount(id: Id, patch: Partial<Account>): Promise<Account>;
  deleteAccount(id: Id): Promise<void>;
  reorderAccounts(ids: Id[]): Promise<void>;

  /* Onboarding */
  autoconfig(address: string): Promise<Autoconfig>;
  verify(input: {
    address: string;
    password: string;
    imap: ServerConfig;
    smtp: ServerConfig;
  }): Promise<VerifyResult>;
  createAccount(input: {
    address: string;
    password: string;
    displayName: string;
    label: string;
    priority: Account['priority'];
    imap: ServerConfig;
    smtp: ServerConfig;
  }): Promise<Account>;
  /** Verify and create many mailboxes in one call, sharing one server template.
   *  Always resolves: per-row failures come back in the result, because one bad
   *  password must not discard the rest of the import. */
  bulkCreateAccounts(input: BulkOnboardInput): Promise<BulkOnboardResult>;
  /** Replace a mailbox password after it stops working. Verifies before storing,
   *  and rejects with the server's own words when the new one is wrong too. */
  updatePassword(id: Id, password: string): Promise<Account>;

  /* Folders */
  listFolders(accountId?: Id): Promise<Folder[]>;
  updateFolder(id: Id, patch: Partial<Folder>): Promise<Folder>;
  /** Create a folder on the mail server. Resolves once the folder pass has seen
   *  it, so the returned row is what the server actually made — name, path and
   *  nesting included. */
  createFolder(input: { accountId: Id; name: string; parentId: Id | null }): Promise<Folder>;

  /* Messages */
  list(query: ListQuery): Promise<ListResult>;
  get(id: Id): Promise<Message>;
  getThread(threadId: Id): Promise<Thread>;
  act(ids: Id[], action: MessageAction): Promise<void>;
  /** A URL the browser can navigate to in order to download an attachment.
   *  Not a fetch: letting the browser own the download means it also owns the
   *  save dialog, the progress, and the resume, none of which we should rebuild. */
  attachmentUrl(messageId: Id, attachmentId: Id): string;

  /* Composition */
  listDrafts(): Promise<Draft[]>;
  saveDraft(draft: Partial<Draft> & { id?: Id }): Promise<Draft>;
  send(draftId: Id): Promise<{ messageId: string }>;
  deleteDraft(id: Id): Promise<void>;

  /* Views & preferences */
  listViews(): Promise<SavedView[]>;
  saveView(view: Partial<SavedView> & { id?: Id }): Promise<SavedView>;
  deleteView(id: Id): Promise<void>;
  getPreferences(): Promise<Preferences>;
  savePreferences(prefs: Preferences): Promise<Preferences>;


  /* Domain control — optional, off unless a domain has been connected from a
     shell on the host. See docs/domain-control.md. */

  /** Connected domains, with what this install may do and what the mail server
   *  actually permits. Empty on every install that has not opted in. */
  listDomains(): Promise<ManagedDomain[]>;
  /** Ask the mail server what it is and what it allows, and cache the answer. */
  probeDomain(id: Id): Promise<DomainProbe>;
  /** Change which operations are permitted. Replaces the whole set. */
  updateDomainGrants(id: Id, grants: DomainGrant[]): Promise<ManagedDomain>;
  /** The addresses the mail server has, not the ones this app has indexed. */
  listDomainMailboxes(id: Id): Promise<ManagedMailbox[]>;
  createDomainMailbox(id: Id, input: { localpart: string; password: string }): Promise<ManagedMailbox>;
  /** `purge` also destroys the stored mail, and needs its own grant. Without it
   *  the address stops receiving and the Maildir stays on disk. */
  deleteDomainMailbox(id: Id, localpart: string, purge: boolean): Promise<void>;
  setDomainMailboxPassword(id: Id, localpart: string, password: string): Promise<void>;
  /** Every attempt to change something on a mail server, successful or not. */
  listDomainOps(limit?: number): Promise<DomainOp[]>;

  /* Sync */
  syncState(): Promise<SyncState>;
  triggerSync(accountId?: Id): Promise<void>;
  /** Server-sent events. Returns an unsubscribe function. */
  subscribe(onEvent: (e: ServerEvent) => void): () => void;
}

/* ── Adapter selection ─────────────────────────────────────────────────────
   VITE_API_MODE picks the adapter. The *default* depends on the build:

   - dev: mock, so a fresh clone runs with `npm run dev` and nothing else.
   - production: http, because a production bundle that quietly serves seeded
     in-memory data is the worst failure this seam can produce. `.env.local` is
     gitignored, so the deploy instructions' `VITE_API_MODE=http npm run build`
     was the only thing standing between a fresh clone and shipping the mock to
     a server — one forgotten variable and the site looks perfect and is a
     demo. Explicitly asking for mock still works; forgetting no longer does. */

let instance: MailApi | null = null;
/**
 * The in-flight construction, memoised.
 *
 * Memoising the instance alone is not enough: two callers that arrive before
 * the dynamic import resolves both see a null instance and both build an
 * adapter, and only one of them ends up stored. The adapter holds the session's
 * CSRF token, so the loser's token is thrown away and the next write goes out
 * without one — which the backend correctly answers 401, and the app reads as
 * "signed out". Memoising the promise makes the race impossible.
 */
let pending: Promise<MailApi> | null = null;

export function getApi(): Promise<MailApi> {
  if (instance) return Promise.resolve(instance);
  pending ??= (async () => {
    const mode = import.meta.env.VITE_API_MODE ?? (import.meta.env.PROD ? 'http' : 'mock');
    if (mode === 'http') {
      const { HttpApi } = await import('./http-api');
      instance = new HttpApi(import.meta.env.VITE_API_BASE ?? '/api');
    } else {
      const { MockApi } = await import('./mock/mock-api');
      instance = new MockApi();
    }
    // Said out loud, once, in development.
    //
    // Mock and real are deliberately indistinguishable to the UI, which is the
    // point of the seam — and precisely why silence here is dangerous. A stale
    // dev server serving the mock looks exactly like a working backend, and
    // every conclusion drawn from it is worthless. One line removes the whole
    // class of mistake.
    if (import.meta.env.DEV) {
      console.info(
        `%c mail %c ${mode === 'http' ? 'real backend' : 'MOCK adapter — no backend'} `,
        'background:#111;color:#fff',
        mode === 'http' ? 'background:#0a5;color:#fff' : 'background:#c60;color:#fff',
      );
    }
    return instance;
  })();
  return pending;
}

/** Test seam — lets stories and tests inject a stub. */
export function setApi(api: MailApi) {
  instance = api;
  pending = Promise.resolve(api);
}
