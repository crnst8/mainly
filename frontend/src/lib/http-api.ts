/**
 * The real backend adapter. Same surface as MockApi, no UI changes required.
 *
 * Auth is a same-site httpOnly session cookie, so there is no token to hold in
 * JS and nothing to leak via XSS. Every mutating call sends the CSRF header the
 * backend hands out at bootstrap.
 */

import type { MailApi } from './api';
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
  ServerConfig,
  ServerEvent,
  SyncState,
  Thread,
  VerifyResult,
} from './types';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class HttpApi implements MailApi {
  private csrf: string | null = null;

  constructor(private readonly base: string) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (method !== 'GET' && this.csrf) headers.set('x-csrf-token', this.csrf);

    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
    });

    // The backend echoes the session's CSRF token on every response, so a
    // reload picks it up from the first read without a dedicated bootstrap
    // call. It is stable for the session, so concurrent requests cannot race.
    const next = res.headers.get('x-csrf-token');
    if (next) this.csrf = next;

    if (res.status === 204) return undefined as T;
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const err = payload?.error ?? {};
      throw new ApiRequestError(res.status, err.code ?? 'unknown', err.message ?? res.statusText, err.detail);
    }
    return payload as T;
  }

  private post<T>(path: string, body?: unknown) {
    return this.req<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  }

  private patch<T>(path: string, body: unknown) {
    return this.req<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  /* Accounts */
  listAccounts = () => this.req<Account[]>('/accounts');
  updateAccount = (id: Id, patch: Partial<Account>) => this.patch<Account>(`/accounts/${id}`, patch);
  deleteAccount = (id: Id) => this.req<void>(`/accounts/${id}`, { method: 'DELETE' });
  reorderAccounts = (ids: Id[]) => this.post<void>('/accounts/reorder', { ids });

  /* Onboarding */
  autoconfig = (address: string) =>
    this.req<Autoconfig>(`/onboarding/autoconfig?address=${encodeURIComponent(address)}`);
  verify = (input: { address: string; password: string; imap: ServerConfig; smtp: ServerConfig }) =>
    this.post<VerifyResult>('/onboarding/verify', input);
  createAccount = (input: Parameters<MailApi['createAccount']>[0]) =>
    this.post<Account>('/accounts', input);
  bulkCreateAccounts = (input: BulkOnboardInput) =>
    this.post<BulkOnboardResult>('/accounts/bulk', input);
  updatePassword = (id: Id, password: string) =>
    this.req<Account>(`/accounts/${id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });

  /* Folders */
  listFolders = (accountId?: Id) =>
    this.req<Folder[]>(`/folders${accountId ? `?accountId=${accountId}` : ''}`);
  updateFolder = (id: Id, patch: Partial<Folder>) => this.patch<Folder>(`/folders/${id}`, patch);
  createFolder = (input: { accountId: Id; name: string; parentId: Id | null }) =>
    this.post<Folder>('/folders', input);

  /* Messages — POST because the query object is well past a sane URL length. */
  list = (query: ListQuery) => this.post<ListResult>('/messages/query', query);
  get = (id: Id) => this.req<Message>(`/messages/${id}`);
  getThread = (threadId: Id) => this.req<Thread>(`/threads/${threadId}`);
  act = (ids: Id[], action: MessageAction) => this.post<void>('/messages/actions', { ids, action });

  // A plain URL, authenticated by the same session cookie every other request
  // uses. The download is the browser's job from here.
  attachmentUrl = (messageId: Id, attachmentId: Id) =>
    `${this.base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;

  /* Composition */
  listDrafts = () => this.req<Draft[]>('/drafts');
  saveDraft = (draft: Partial<Draft> & { id?: Id }) =>
    draft.id ? this.patch<Draft>(`/drafts/${draft.id}`, draft) : this.post<Draft>('/drafts', draft);
  send = (draftId: Id) => this.post<{ messageId: string }>(`/drafts/${draftId}/send`);
  deleteDraft = (id: Id) => this.req<void>(`/drafts/${id}`, { method: 'DELETE' });

  /* Views & prefs */
  listViews = () => this.req<SavedView[]>('/views');
  saveView = (view: Partial<SavedView> & { id?: Id }) =>
    view.id ? this.patch<SavedView>(`/views/${view.id}`, view) : this.post<SavedView>('/views', view);
  deleteView = (id: Id) => this.req<void>(`/views/${id}`, { method: 'DELETE' });
  getPreferences = () => this.req<Preferences>('/preferences');
  savePreferences = (prefs: Preferences) => this.req<Preferences>('/preferences', {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });

  /* Sync */
  syncState = () => this.req<SyncState>('/sync');
  triggerSync = (accountId?: Id) => this.post<void>('/sync', { accountId });

  subscribe(onEvent: (e: ServerEvent) => void) {
    // One handle, reassigned across reconnects.
    //
    // Reconnecting used to call `subscribe` again, which built a second stream
    // that nothing held: the unsubscribe returned to the caller still closed the
    // *first* source, so every hard failure left another open connection
    // delivering events into a store that thought it had stopped listening.
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = () => {
      if (closed) return;
      const es = new EventSource(`${this.base}/events`, { withCredentials: true });
      source = es;
      es.onmessage = (ev) => {
        try {
          onEvent(JSON.parse(ev.data) as ServerEvent);
        } catch {
          /* a malformed frame is not worth tearing the stream down for */
        }
      };
      // EventSource reconnects on its own; this is only for hard failures,
      // where it has given up and closed.
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED || closed) return;
        es.close();
        retry = setTimeout(open, 2000);
      };
    };

    open();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }
}
