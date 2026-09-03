/**
 * The HTTP client for the mail API.
 *
 * This process is a *client*, not a second server. It owns no database, no
 * IMAP connection, and no business logic — every tool below resolves to calls
 * the browser already makes, with a bearer token in place of a session cookie.
 * That is the whole reason the MCP server is a separate workspace: an agent
 * cannot reach anything a person could not, because it is going through the
 * same door.
 *
 * No CSRF header is sent, and none is expected. See `modules/auth/index.ts`:
 * the check exists because cookies are ambient, and an `Authorization` header
 * is not.
 */

const DEFAULT_BASE = 'http://127.0.0.1:5274/api';

/** A stalled request must not wedge the agent's turn. */
const TIMEOUT_MS = 30_000;

export interface Addr {
  name: string | null;
  address: string;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  folderId: string;
  threadId: string;
  from: Addr;
  to: Addr[];
  subject: string;
  preview: string;
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  threadCount: number;
  size: number;
  labels: string[];
  priority: 'critical' | 'high' | 'normal' | 'low' | 'muted';
}

export interface Message extends MessageSummary {
  cc: Addr[];
  bodyText: string | null;
  bodyHtml: string | null;
  headers: Record<string, string>;
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
  bodyError: string | null;
}

export interface Account {
  id: string;
  address: string;
  domain: string;
  label: string;
  priority: MessageSummary['priority'];
  hidden: boolean;
  status: string;
}

export interface Folder {
  id: string;
  accountId: string;
  path: string;
  name: string;
  role: string;
  unread: number;
  total: number;
}

/** A domain this install may write to. Only present when someone has opted in;
 *  most installs have none. */
export interface ManagedDomain {
  id: string;
  domain: string;
  status: string;
  /** What will actually work — this install's grants intersected with what the
   *  mail server itself permits. The only field worth branching on. */
  effective: string[];
}

export interface ManagedMailbox {
  localpart: string;
  address: string;
  /** True when this install already syncs the address. */
  linked: boolean;
}

export interface ListResult {
  messages: MessageSummary[];
  nextCursor: string | null;
  total: number;
  approximate: boolean;
}

export interface UnsubscribeOption {
  method: 'http' | 'mailto';
  target: string;
  automatic: boolean;
  blockedReason?: string;
}

export interface UnsubscribePlan {
  messageId: string;
  from: Addr;
  listId: string | null;
  options: UnsubscribeOption[];
  history: { at: string; method: string; target: string; status: string; actor: string }[];
}

export interface UnsubscribeResult {
  ok: boolean;
  method: 'http' | 'mailto';
  target: string;
  detail: string | null;
}

export type Scope =
  | { kind: 'unified'; value: null; role: string | null }
  | { kind: 'account'; value: string; role: string | null }
  | { kind: 'domain'; value: string; role: string | null }
  | { kind: 'folder'; value: string; role: null }
  | { kind: 'search'; value: string; role: null };

const NO_FILTERS = {
  unreadOnly: false,
  flaggedOnly: false,
  hasAttachments: false,
  accountIds: [] as string[],
  domains: [] as string[],
  folderIds: [] as string[],
  priorities: [] as string[],
  labels: [] as string[],
  since: null as string | null,
  before: null as string | null,
};

/** The message the API sent, or something honest about why there wasn't one. */
export class MailApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MailApiError';
    this.status = status;
    this.code = code;
  }
}

export class MailClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string | undefined, token: string) {
    // A trailing slash here turns every path into a double slash, which Fastify
    // answers with the 404 handler and nothing useful.
    this.baseUrl = (baseUrl?.trim() || DEFAULT_BASE).replace(/\/+$/, '');
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new MailApiError(
        0,
        'unreachable',
        `Could not reach the mail API at ${this.baseUrl}: ${(err as Error).message}. ` +
          'Is the backend running?',
      );
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const payload = text ? safeJson(text) : null;

    if (!res.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new MailApiError(
        res.status,
        err?.code ?? 'http_error',
        err?.message ?? `${res.status} ${res.statusText}`,
      );
    }
    return payload as T;
  }

  /* ── Reads ──────────────────────────────────────────────────────────────── */

  list(input: {
    scope: Scope;
    sort?: string;
    dir?: 'asc' | 'desc';
    threaded?: boolean;
    limit?: number;
    cursor?: string | null;
    filters?: Partial<typeof NO_FILTERS>;
  }): Promise<ListResult> {
    return this.request<ListResult>('/messages/query', {
      method: 'POST',
      body: JSON.stringify({
        scope: input.scope,
        sort: input.sort ?? 'date',
        dir: input.dir ?? 'desc',
        group: 'none',
        threaded: input.threaded ?? false,
        filters: { ...NO_FILTERS, ...input.filters },
        limit: input.limit ?? 25,
        cursor: input.cursor ?? null,
      }),
    });
  }

  message(id: string): Promise<Message> {
    return this.request<Message>(`/messages/${encodeURIComponent(id)}`);
  }

  accounts(): Promise<Account[]> {
    return this.request<Account[]>('/accounts');
  }

  folders(accountId?: string): Promise<Folder[]> {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return this.request<Folder[]>(`/folders${qs}`);
  }

  /* ── Domain control ─────────────────────────────────────────────────────── */

  domains(): Promise<ManagedDomain[]> {
    return this.request<ManagedDomain[]>('/domains');
  }

  domainMailboxes(id: string): Promise<ManagedMailbox[]> {
    return this.request<ManagedMailbox[]>(`/domains/${encodeURIComponent(id)}/mailboxes`);
  }

  createMailbox(id: string, body: { localpart: string; password: string }): Promise<ManagedMailbox> {
    return this.request<ManagedMailbox>(`/domains/${encodeURIComponent(id)}/mailboxes`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  deleteMailbox(id: string, localpart: string, purge: boolean): Promise<void> {
    return this.request<void>(
      `/domains/${encodeURIComponent(id)}/mailboxes/${encodeURIComponent(localpart)}` +
        `?purge=${purge ? 'true' : 'false'}`,
      { method: 'DELETE' },
    );
  }

  /* ── Writes ─────────────────────────────────────────────────────────────── */

  act(ids: string[], action: Record<string, unknown>): Promise<void> {
    return this.request<void>('/messages/actions', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    });
  }

  unsubscribePlan(id: string): Promise<UnsubscribePlan> {
    return this.request<UnsubscribePlan>(`/messages/${encodeURIComponent(id)}/unsubscribe`);
  }

  unsubscribe(id: string, body: { confirm: boolean; target?: string }): Promise<UnsubscribeResult> {
    return this.request<UnsubscribeResult>(`/messages/${encodeURIComponent(id)}/unsubscribe`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

/** A non-JSON body from an endpoint that promised JSON is a proxy or a crash,
 *  not a payload. Return null and let the status code do the talking. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
