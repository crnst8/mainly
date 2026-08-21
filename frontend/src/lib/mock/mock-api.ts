/**
 * In-memory MailApi. Runs the whole interface with no backend.
 *
 * It deliberately simulates latency (and occasionally fails) because a UI that
 * only ever sees instant, successful responses grows optimistic-update bugs
 * that surface on the first real network.
 */

import type { MailApi } from '../api';
import { collapseThreads, filterCount, matchesFilters, sortMessages } from '../query';
import {
  classifyIntent,
  matchesSearch,
  parseSearch,
  relevanceScore,
  resolveProfile,
} from '../search';
import { DEFAULT_PREFERENCES, MIN_APP_PASSWORD, withPreferenceDefaults } from '../types';
import type {
  Account,
  Autoconfig,
  BulkOnboardInput,
  BulkOnboardResult,
  BulkOnboardRow,
  Draft,
  Folder,
  Id,
  ListQuery,
  ListResult,

  MessageAction,
  Preferences,
  Priority,
  SavedView,
  ServerConfig,
  ServerEvent,
  Session,
  SyncState,
  Thread,
  VerifyResult,
} from '../types';
import { accounts, folders, messages, savedViews, summaries, domainColor } from './seed';

const LATENCY = { fast: 24, normal: 90, slow: 260 };
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms + Math.random() * ms * 0.4));

// Same defaults the real backend serves — from the contract, not a second copy.
const DEFAULT_PREFS: Preferences = DEFAULT_PREFERENCES;

export class MockApi implements MailApi {
  private accounts = structuredClone(accounts);
  private folders = structuredClone(folders);
  private messages = structuredClone(messages);
  private summaries = structuredClone(summaries);
  private views = structuredClone(savedViews);
  private drafts: Draft[] = [];
  private prefs: Preferences = structuredClone(DEFAULT_PREFS);
  private listeners = new Set<(e: ServerEvent) => void>();
  private seq = 10_000;
  /**
   * The app password, once it has been changed.
   *
   * `null` means "not set yet", and any input of four or more characters is
   * accepted as the current one — otherwise the success path would be
   * unreachable in mock mode, because nobody can guess a secret the fixture
   * invented. After a change it is the string that was actually typed, so the
   * second attempt exercises the real "wrong current password" branch against
   * something the user knows.
   */
  private appPassword: string | null = null;

  private emit(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }

  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  /* ── Session ────────────────────────────────────────────────────────────── */

  async session(): Promise<Session> {
    await sleep(LATENCY.fast);
    return { email: 'you@cmr.my' };
  }

  async changePassword(currentPassword: string, newPassword: string) {
    await sleep(LATENCY.slow);
    const currentOk = this.appPassword === null
      ? currentPassword.length >= 4
      : currentPassword === this.appPassword;
    // Same words the backend uses, so the inline error is not a surprise the
    // first time it appears against a real server.
    if (!currentOk) throw new Error('That is not your current password');
    if (newPassword.length < MIN_APP_PASSWORD) {
      throw new Error(`The new password must be at least ${MIN_APP_PASSWORD} characters`);
    }
    if (newPassword === currentPassword) {
      throw new Error('The new password is the same as the current one');
    }
    this.appPassword = newPassword;
  }

  async signOut() {
    await sleep(LATENCY.fast);
    // Nothing to end. The mock has no session, which is also why `Login` never
    // appears in mock mode — the reload the caller does next lands straight
    // back in the app rather than on the sign-in screen.
  }

  /* ── Accounts ───────────────────────────────────────────────────────────── */

  async listAccounts() {
    await sleep(LATENCY.fast);
    return structuredClone(this.accounts);
  }

  async updateAccount(id: Id, patch: Partial<Account>) {
    await sleep(LATENCY.fast);
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`No account ${id}`);
    Object.assign(a, patch);
    // Priority is denormalised onto messages; keep it consistent.
    if (patch.priority) {
      for (const m of this.summaries) if (m.accountId === id) m.priority = patch.priority;
      for (const m of this.messages) if (m.accountId === id) m.priority = patch.priority;
    }
    this.emit({ type: 'account:changed', account: structuredClone(a) });
    return structuredClone(a);
  }

  async deleteAccount(id: Id) {
    await sleep(LATENCY.normal);
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.folders = this.folders.filter((f) => f.accountId !== id);
    this.messages = this.messages.filter((m) => m.accountId !== id);
    this.summaries = this.summaries.filter((m) => m.accountId !== id);
  }

  async reorderAccounts(ids: Id[]) {
    await sleep(LATENCY.fast);
    for (const [i, id] of ids.entries()) {
      const a = this.accounts.find((x) => x.id === id);
      if (a) a.position = i;
    }
    this.accounts.sort((a, b) => a.position - b.position);
  }

  /* ── Onboarding ─────────────────────────────────────────────────────────── */

  async autoconfig(address: string): Promise<Autoconfig> {
    await sleep(LATENCY.slow);
    const domain = address.split('@')[1] ?? '';
    const known = this.accounts.some((a) => a.domain === domain);
    return {
      source: known ? 'known' : 'wellknown',
      confidence: known ? 1 : 0.72,
      imap: { host: `mail.${domain}`, port: 993, security: 'tls', username: address },
      smtp: { host: `mail.${domain}`, port: 587, security: 'starttls', username: address },
    };
  }

  async verify(input: { address: string; password: string; imap: ServerConfig; smtp: ServerConfig }): Promise<VerifyResult> {
    await sleep(LATENCY.slow * 3);
    // Mirrors the real failure mode: wrong password fails IMAP, not SMTP.
    const bad = input.password.length < 4;
    return {
      imap: {
        ok: !bad,
        error: bad ? '[AUTHENTICATIONFAILED] Invalid credentials' : null,
        latencyMs: bad ? null : 38,
        capabilities: bad ? [] : ['IMAP4rev1', 'IDLE', 'MOVE', 'SORT', 'THREAD=REFERENCES', 'CONDSTORE', 'QRESYNC'],
      },
      smtp: { ok: !bad, error: bad ? 'Authentication failed' : null, latencyMs: bad ? null : 52 },
    };
  }

  async createAccount(input: {
    address: string;
    password: string;
    displayName: string;
    label: string;
    priority: Priority;
    imap: ServerConfig;
    smtp: ServerConfig;
  }) {
    await sleep(LATENCY.normal);
    const domain = input.address.split('@')[1]!;
    const account: Account = {
      id: this.id('acc'),
      address: input.address,
      domain,
      label: input.label || input.address,
      displayName: input.displayName,
      priority: input.priority,
      status: 'syncing',
      color: null,
      hidden: false,
      unread: 0,
      total: 0,
      lastSyncAt: null,
      error: null,
      signature: null,
      position: this.accounts.length,
    };
    this.accounts.push(account);

    for (const [i, spec] of (
      [
        ['Inbox', 'inbox', 'INBOX'],
        ['Drafts', 'drafts', 'INBOX.Drafts'],
        ['Sent', 'sent', 'INBOX.Sent'],
        ['Archive', 'archive', 'INBOX.Archive'],
        ['Junk', 'junk', 'INBOX.Junk'],
        ['Trash', 'trash', 'INBOX.Trash'],
      ] as const
    ).entries()) {
      this.folders.push({
        id: this.id('fld'),
        accountId: account.id,
        path: spec[2],
        name: spec[0],
        role: spec[1],
        parentId: null,
        depth: 0,
        unread: 0,
        total: 0,
        color: null,
        pinned: false,
        subscribed: true,
        position: i,
      });
    }

    // Simulate the initial sync so the onboarding "done" state is honest.
    void this.fakeInitialSync(account.id);
    return structuredClone(account);
  }

  async updatePassword(id: Id, password: string) {
    await sleep(LATENCY.slow * 2);
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`No account ${id}`);
    // Same rule the mock verify uses, so the failure path is reachable here too.
    if (password.length < 4) throw new Error('[AUTHENTICATIONFAILED] Invalid credentials');
    a.status = 'ok';
    a.error = null;
    this.emit({ type: 'account:changed', account: structuredClone(a) });
    return structuredClone(a);
  }

  /**
   * Bulk import, mocked.
   *
   * Two rows fail deliberately: an address that is already added, and any
   * password shorter than four characters. A bulk importer whose mock always
   * succeeds means the partial-failure UI — which is most of the interesting
   * design in it — is never once seen while building.
   */
  async bulkCreateAccounts(input: BulkOnboardInput): Promise<BulkOnboardResult> {
    const rows: BulkOnboardRow[] = [];
    for (const row of input.accounts) {
      await sleep(LATENCY.normal);
      const address = row.address.trim().toLowerCase();
      const fail = (error: string) =>
        rows.push({ address, ok: false, accountId: null, error, smtpWarning: null });

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        fail('Not a valid email address');
        continue;
      }
      if (this.accounts.some((a) => a.address === address)) {
        fail('This mailbox has already been added');
        continue;
      }
      if (!row.password || row.password.length < 4) {
        fail('Authentication failed.');
        continue;
      }

      const domain = address.split('@')[1]!;
      const account = await this.createAccount({
        address,
        password: row.password,
        displayName: row.displayName ?? address.split('@')[0]!,
        label: row.label ?? address,
        priority: row.priority ?? 'normal',
        imap: {
          host: input.imap.hostTemplate.replaceAll('{domain}', domain),
          port: input.imap.port,
          security: input.imap.security,
          username: address,
        },
        smtp: {
          host: input.smtp.hostTemplate.replaceAll('{domain}', domain),
          port: input.smtp.port,
          security: input.smtp.security,
          username: address,
        },
      });
      rows.push({
        address,
        ok: true,
        accountId: account.id,
        error: null,
        // One in five, so the "receives but cannot send" state is visible too.
        smtpWarning: rows.length % 5 === 4 ? 'Invalid login: 535 authentication failed' : null,
      });
    }
    return { rows };
  }

  private async fakeInitialSync(accountId: Id) {
    const steps = ['Connecting', 'Listing folders', 'Indexing INBOX', 'Indexing Sent', 'Done'];
    for (const [i, step] of steps.entries()) {
      await sleep(LATENCY.slow * 2);
      this.emit({
        type: 'sync',
        state: {
          busy: i < steps.length - 1,
          accounts: {
            [accountId]: {
              status: i < steps.length - 1 ? 'syncing' : 'ok',
              progress: (i + 1) / steps.length,
              step,
              lastSyncAt: new Date().toISOString(),
              error: null,
            },
          },
          bodySearch: { indexed: this.messages.length, total: this.messages.length },
        },
      });
    }
    const a = this.accounts.find((x) => x.id === accountId);
    if (a) {
      a.status = 'ok';
      a.lastSyncAt = new Date().toISOString();
      this.emit({ type: 'account:changed', account: structuredClone(a) });
    }
  }

  /* ── Folders ────────────────────────────────────────────────────────────── */

  async listFolders(accountId?: Id) {
    await sleep(LATENCY.fast);
    const list = accountId ? this.folders.filter((f) => f.accountId === accountId) : this.folders;
    return structuredClone(list);
  }

  async updateFolder(id: Id, patch: Partial<Folder>) {
    await sleep(LATENCY.fast);
    const f = this.folders.find((x) => x.id === id);
    if (!f) throw new Error(`No folder ${id}`);
    Object.assign(f, patch);
    return structuredClone(f);
  }

  async createFolder(input: { accountId: Id; name: string; parentId: Id | null }) {
    await sleep(LATENCY.normal);
    const name = input.name.trim();
    if (!name) throw new Error('A folder name is required');
    const parent = input.parentId ? this.folders.find((f) => f.id === input.parentId) : null;
    const path = parent ? `${parent.path}.${name}` : `INBOX.${name}`;
    if (this.folders.some((f) => f.accountId === input.accountId && f.path === path)) {
      throw new Error('A folder with that name already exists here');
    }
    const folder: Folder = {
      id: this.id('fld'),
      accountId: input.accountId,
      path,
      name,
      role: 'custom',
      parentId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      unread: 0,
      total: 0,
      color: null,
      pinned: false,
      subscribed: true,
      // After the role folders, which is where the real folder pass puts a new
      // custom folder too.
      position: 100 + this.folders.filter((f) => f.accountId === input.accountId).length,
    };
    this.folders.push(folder);
    return structuredClone(folder);
  }

  /* ── Messages ───────────────────────────────────────────────────────────── */

  async list(query: ListQuery): Promise<ListResult> {
    await sleep(LATENCY.normal);
    const scoped = this.applyScope(this.summaries, query);
    const filtered = scoped.filter((m) => matchesFilters(m, query, this.filterContext()));
    const parsed = query.scope.kind === 'search' ? parseSearch(query.scope.value ?? '') : null;
    const indexedThreadPath =
      query.threaded &&
      query.scope.kind !== 'search' &&
      filterCount(query.filters) === 0 &&
      (query.sort === 'date' || query.sort === 'relevance');
    const threaded = query.threaded
      ? collapseThreads(filtered, indexedThreadPath ? this.summaries : undefined)
      : filtered;
    // One profile per request, exactly as the backend resolves it — intent from
    // the query, dials from the stored preferences. Ranking a search here with
    // anything else would make the mock a different product.
    const profile = parsed ? resolveProfile(classifyIntent(parsed), this.prefs.search) : null;
    const now = Date.now();
    const sorted = sortMessages(
      threaded,
      query.sort,
      query.dir,
      parsed && profile
        ? (m) =>
            relevanceScore(m, parsed, now, {
              profile,
              folderRole: this.folders.find((f) => f.id === m.folderId)?.role ?? null,
            })
        : undefined,
    );

    const start = query.cursor ? Number(query.cursor) : 0;
    const page = sorted.slice(start, start + query.limit);
    const nextCursor = start + query.limit < sorted.length ? String(start + query.limit) : null;

    // Facets are computed over the scope *before* filters, so the filter bar
    // shows what turning a filter on would give you, not what is already on.
    const facets: ListResult['facets'] = {
      accounts: {},
      domains: {},
      priorities: { critical: 0, high: 0, normal: 0, low: 0, muted: 0 },
      labels: {},
      unread: 0,
      flagged: 0,
      withAttachments: 0,
    };
    for (const m of scoped) {
      facets.accounts[m.accountId] = (facets.accounts[m.accountId] ?? 0) + 1;
      const d = this.accounts.find((a) => a.id === m.accountId)?.domain ?? '?';
      facets.domains[d] = (facets.domains[d] ?? 0) + 1;
      facets.priorities[m.priority]++;
      for (const l of m.labels) facets.labels[l] = (facets.labels[l] ?? 0) + 1;
      if (!m.seen) facets.unread++;
      if (m.flagged) facets.flagged++;
      if (m.hasAttachments) facets.withAttachments++;
    }

    return { messages: structuredClone(page), nextCursor, total: sorted.length, approximate: false, facets };
  }

  private applyScope(list: ListResult['messages'], query: ListQuery) {
    const { scope } = query;
    const roleFolderIds = (predicate: (f: Folder) => boolean) =>
      new Set(this.folders.filter(predicate).map((f) => f.id));

    switch (scope.kind) {
      case 'folder': {
        return list.filter((m) => m.folderId === scope.value);
      }
      case 'account': {
        const ids = scope.role
          ? roleFolderIds((f) => f.accountId === scope.value && f.role === scope.role)
          : null;
        return list.filter((m) => m.accountId === scope.value && (!ids || ids.has(m.folderId)));
      }
      case 'domain': {
        const accountIds = new Set(
          this.accounts.filter((a) => a.domain === scope.value).map((a) => a.id),
        );
        const ids = scope.role ? roleFolderIds((f) => f.role === scope.role) : null;
        return list.filter((m) => accountIds.has(m.accountId) && (!ids || ids.has(m.folderId)));
      }
      case 'search': {
        // Search runs over every non-hidden account, exactly like the unified
        // view. Narrowing to one place is a *filter* the user turns on, not a
        // property of being a search.
        const hidden = new Set(this.accounts.filter((a) => a.hidden).map((a) => a.id));
        const parsed = parseSearch(scope.value ?? '');
        const ctx = this.searchContext();
        return list.filter((m) => !hidden.has(m.accountId) && matchesSearch(m, parsed, ctx));
      }
      case 'unified':
      default: {
        const hidden = new Set(this.accounts.filter((a) => a.hidden).map((a) => a.id));
        const ids = scope.role ? roleFolderIds((f) => f.role === scope.role) : null;
        return list.filter((m) => !hidden.has(m.accountId) && (!ids || ids.has(m.folderId)));
      }
    }
  }

  private filterContext() {
    return {
      domainOf: (accountId: Id) => this.accounts.find((a) => a.id === accountId)?.domain ?? '',
    };
  }

  private searchContext() {
    return {
      folderNames: (folderId: Id) => {
        const f = this.folders.find((x) => x.id === folderId);
        return f ? [f.name, f.role] : [];
      },
    };
  }

  async get(id: Id) {
    await sleep(LATENCY.fast);
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error(`No message ${id}`);
    return structuredClone(m);
  }

  /** There is nothing behind this in mock mode. A data: URL keeps the reader's
   *  download affordance real rather than inert, and says so when clicked. */
  attachmentUrl(messageId: Id, attachmentId: Id) {
    const text = `Mock adapter: attachment ${attachmentId} of message ${messageId} has no bytes.\n`;
    return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  }

  async getThread(threadId: Id): Promise<Thread> {
    await sleep(LATENCY.normal);
    const msgs = this.messages
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const first = msgs[0];
    if (!first) throw new Error(`No thread ${threadId}`);
    const seen = new Set<string>();
    const participants = msgs
      .map((m) => m.from)
      .filter((p) => (seen.has(p.address) ? false : (seen.add(p.address), true)));
    return {
      id: threadId,
      subject: first.subject,
      messages: structuredClone(msgs),
      participants,
      lastDate: msgs.at(-1)!.date,
      unread: msgs.filter((m) => !m.seen).length,
    };
  }

  async act(ids: Id[], action: MessageAction) {
    await sleep(LATENCY.fast);
    const set = new Set(ids);
    const touched = [...this.summaries, ...this.messages].filter((m) => set.has(m.id));

    switch (action.type) {
      case 'flag': {
        for (const m of touched) {
          for (const f of action.add) {
            if (f === 'seen') m.seen = true;
            if (f === 'flagged') m.flagged = true;
            if (f === 'answered') m.answered = true;
          }
          for (const f of action.remove) {
            if (f === 'seen') m.seen = false;
            if (f === 'flagged') m.flagged = false;
          }
        }
        break;
      }
      case 'move': {
        for (const m of touched) m.folderId = action.folderId;
        break;
      }
      case 'delete': {
        const trash = this.folders.find(
          (f) => f.role === 'trash' && f.accountId === touched[0]?.accountId,
        );
        if (action.permanent || !trash) {
          this.messages = this.messages.filter((m) => !set.has(m.id));
          this.summaries = this.summaries.filter((m) => !set.has(m.id));
        } else {
          for (const m of touched) m.folderId = trash.id;
        }
        this.emit({ type: 'messages:deleted', ids });
        break;
      }
      case 'label': {
        for (const m of touched) {
          const next = new Set(m.labels);
          for (const l of action.add) next.add(l);
          for (const l of action.remove) next.delete(l);
          m.labels = [...next];
        }
        break;
      }
      case 'copy':
      case 'snooze':
        break;
    }

    this.recount();
  }

  private recount() {
    const counts: Record<Id, { unread: number; total: number }> = {};
    for (const a of this.accounts) {
      const own = this.summaries.filter((m) => m.accountId === a.id);
      a.unread = own.filter((m) => !m.seen).length;
      a.total = own.length;
      counts[a.id] = { unread: a.unread, total: a.total };
    }
    const folderCounts: Record<Id, { unread: number; total: number }> = {};
    for (const f of this.folders) {
      const own = this.summaries.filter((m) => m.folderId === f.id);
      f.unread = own.filter((m) => !m.seen).length;
      f.total = own.length;
      folderCounts[f.id] = { unread: f.unread, total: f.total };
    }
    this.emit({ type: 'counts', accounts: counts, folders: folderCounts });
  }

  /* ── Drafts ─────────────────────────────────────────────────────────────── */

  async listDrafts() {
    await sleep(LATENCY.fast);
    return structuredClone(this.drafts);
  }

  async saveDraft(patch: Partial<Draft> & { id?: Id }) {
    await sleep(LATENCY.fast);
    const existing = patch.id ? this.drafts.find((d) => d.id === patch.id) : undefined;
    if (existing) {
      Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
      return structuredClone(existing);
    }
    const draft: Draft = {
      id: this.id('drf'),
      accountId: patch.accountId ?? this.accounts[0]!.id,
      to: patch.to ?? [],
      cc: patch.cc ?? [],
      bcc: patch.bcc ?? [],
      subject: patch.subject ?? '',
      bodyText: patch.bodyText ?? '',
      bodyHtml: patch.bodyHtml ?? null,
      inReplyTo: patch.inReplyTo ?? null,
      forwardOf: patch.forwardOf ?? null,
      attachments: patch.attachments ?? [],
      updatedAt: new Date().toISOString(),
      sendAt: patch.sendAt ?? null,
    };
    this.drafts.push(draft);
    return structuredClone(draft);
  }

  async send(draftId: Id) {
    await sleep(LATENCY.slow * 2);
    const draft = this.drafts.find((d) => d.id === draftId);
    if (!draft) throw new Error(`No draft ${draftId}`);
    this.drafts = this.drafts.filter((d) => d.id !== draftId);
    if (draft.inReplyTo) {
      await this.act([draft.inReplyTo], { type: 'flag', add: ['answered'], remove: [] });
    }
    return { messageId: `<${this.id('sent')}@local>` };
  }

  async deleteDraft(id: Id) {
    await sleep(LATENCY.fast);
    this.drafts = this.drafts.filter((d) => d.id !== id);
  }

  /* ── Views & prefs ──────────────────────────────────────────────────────── */

  async listViews() {
    await sleep(LATENCY.fast);
    return structuredClone(this.views);
  }

  async saveView(patch: Partial<SavedView> & { id?: Id }) {
    await sleep(LATENCY.fast);
    const existing = patch.id ? this.views.find((v) => v.id === patch.id) : undefined;
    if (existing) {
      Object.assign(existing, patch);
      return structuredClone(existing);
    }
    const view: SavedView = {
      id: this.id('view'),
      name: patch.name ?? 'Untitled view',
      glyph: patch.glyph ?? '•',
      color: patch.color ?? null,
      query: patch.query!,
      pinned: patch.pinned ?? true,
      position: this.views.length,
    };
    this.views.push(view);
    return structuredClone(view);
  }

  async deleteView(id: Id) {
    await sleep(LATENCY.fast);
    this.views = this.views.filter((v) => v.id !== id);
  }

  async getPreferences() {
    await sleep(LATENCY.fast);
    const stored = localStorage.getItem('mail.prefs');
    if (stored) {
      try {
        // Through the contract's merge, not a spread: preferences written before
        // a new nested group existed would otherwise arrive with that group
        // missing, and every reader would have to guard for it.
        this.prefs = withPreferenceDefaults({ ...this.prefs, ...JSON.parse(stored) });
      } catch {
        /* corrupt local state is not worth crashing over */
      }
    }
    if (!Object.keys(this.prefs.theme.domainColors).length) {
      for (const a of this.accounts) {
        this.prefs.theme.domainColors[a.domain] ??= domainColor(a.domain);
      }
    }
    return structuredClone(this.prefs);
  }

  async savePreferences(prefs: Preferences) {
    this.prefs = structuredClone(prefs);
    localStorage.setItem('mail.prefs', JSON.stringify(prefs));
    return structuredClone(prefs);
  }

  /* ── Sync ───────────────────────────────────────────────────────────────── */

  async syncState(): Promise<SyncState> {
    await sleep(LATENCY.fast);
    const state: SyncState = {
      accounts: {},
      busy: false,
      // The mock has no IMAP body source, so its fixture is considered complete.
      bodySearch: { indexed: this.messages.length, total: this.messages.length },
    };
    for (const a of this.accounts) {
      state.accounts[a.id] = {
        status: a.status,
        progress: null,
        step: null,
        lastSyncAt: a.lastSyncAt,
        error: a.error,
      };
    }
    return state;
  }

  async triggerSync(accountId?: Id) {
    const targets = accountId ? [accountId] : this.accounts.map((a) => a.id);
    for (const id of targets) void this.fakeInitialSync(id);
  }

  subscribe(onEvent: (e: ServerEvent) => void) {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }
}
