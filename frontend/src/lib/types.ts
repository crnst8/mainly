/**
 * The API contract.
 *
 * This file is the single source of truth for the shape of everything that
 * crosses the wire. `backend/src/contract/types.ts` is a byte-identical copy;
 * `pnpm contract:check` fails the build if they drift.
 *
 * Design notes that matter downstream:
 *  - IDs are opaque strings. Never parse them, never sort by them.
 *  - Dates are ISO-8601 UTC strings, not Date objects — they survive JSON.
 *  - The list endpoint returns `MessageSummary`, never `Message`. Bodies are
 *    fetched one at a time. This is the difference between a list that paints
 *    in 40ms and one that paints in 4s.
 */

/* The one sibling import in the contract. Search ranking is policy shared by
   the mock adapter and Postgres, so it lives with the search syntax in
   `search.ts` — but it is also a stored preference, so `Preferences` has to
   name it. `search.ts` imports back from here type-only, which erases, so there
   is no runtime cycle. */
import {
  DEFAULT_SEARCH_PREFERENCES,
  withSearchDefaults,
  type SearchPreferences,
} from './search.ts';

export type Id = string;
export type IsoDate = string;

/* ──────────────────────────────────────────────────────────────────────────
   Session
   ────────────────────────────────────────────────────────────────────────── */

/** App-login identity, distinct from a connected mailbox. */
export interface Session {
  email: string;
}

/** App-password minimum enforced by both client and server. */
export const MIN_APP_PASSWORD = 10;

/* ──────────────────────────────────────────────────────────────────────────
   Accounts & domains
   ────────────────────────────────────────────────────────────────────────── */

/** Priority tier. Drives default sort weight, grouping, and notifications. */
export type Priority = 'critical' | 'high' | 'normal' | 'low' | 'muted';

export const PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low', 'muted'];

/** Numeric weight for sorting. Higher sorts first. */
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
  muted: 0,
};

export type AccountStatus =
  | 'ok'
  | 'syncing'
  | 'auth_error'
  | 'connect_error'
  | 'disabled'
  | 'pending';

export interface Account {
  id: Id;
  /** Full address, e.g. colby@cmr.my */
  address: string;
  /** Cached from address for grouping without parsing on every render. */
  domain: string;
  /** What the user calls it. Falls back to address. */
  label: string;
  /** Name used on outgoing mail. */
  displayName: string;
  priority: Priority;
  status: AccountStatus;
  /** Colour override. Null = inherit the domain's colour. */
  color: string | null;
  /** Hidden from unified views but still syncing. */
  hidden: boolean;
  unread: number;
  total: number;
  lastSyncAt: IsoDate | null;
  /** Present only when status is an error — surfaced verbatim in the UI. */
  error: string | null;
  signature: string | null;
  /** Sort position in the sidebar. */
  position: number;
}

/** A domain is derived from accounts, not stored independently — except for
 *  its presentation, which the user owns. */
export interface DomainConfig {
  domain: string;
  label: string | null;
  color: string | null;
  priority: Priority | null;
  collapsed: boolean;
  position: number;
}

/**
 * A user-made folder in the sidebar that holds mailboxes.
 *
 * Forty-five mailboxes across eight domains is more than the domain grouping
 * can carry on its own: "work", "clients", "dormant" are distinctions the
 * addresses do not encode. So this is a second, manual axis over the same
 * accounts.
 *
 * It lives in preferences rather than in a table because it is presentation and
 * nothing else — no message, folder or sync path reads it, and putting it in the
 * one blob the client already reads whole means it arrives with everything else
 * on boot and survives a reload without a second request.
 *
 * `accountIds` may name an account that no longer exists; the sidebar ignores
 * strays rather than the store pruning them, because a removed account that
 * comes back should land where it was.
 */
export interface AccountGroup {
  id: Id;
  name: string;
  /** Null inherits the neutral folder tint. */
  color: string | null;
  collapsed: boolean;
  /** Members, in the order the user dragged them. */
  accountIds: Id[];
  position: number;
  /**
   * Whether `color` also stands as the colour of the mailboxes inside.
   *
   * Colouring a group and then colouring each mailbox in it to match is the
   * same decision typed once per mailbox, so the cascade is the default and
   * this is the way out of it. Optional because groups stored before the
   * option existed do not carry it, and those read as on — see
   * `groupTintsMembers`.
   */
  tintMembers?: boolean;
}

/** Whether a group lends its colour to the mailboxes in it. Absent means on:
 *  a group saved before the flag existed must behave like a new one. */
export function groupTintsMembers(group: AccountGroup): boolean {
  return group.tintMembers !== false;
}

/** The colour a group lends its members, or null when it has none to lend.
 *  One place decides, so the sidebar hairline, the list stripe and the reader
 *  cannot disagree about what colour a mailbox is. */
export function groupMemberTint(group: AccountGroup): string | null {
  return groupTintsMembers(group) ? group.color : null;
}

/* ──────────────────────────────────────────────────────────────────────────
   Folders
   ────────────────────────────────────────────────────────────────────────── */

/** IMAP SPECIAL-USE, normalised. `custom` covers everything else. */
export type FolderRole =
  | 'inbox'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'flagged'
  | 'all'
  | 'custom';

export interface Folder {
  id: Id;
  accountId: Id;
  /** Raw IMAP path, e.g. "INBOX.Receipts" */
  path: string;
  /** Leaf name for display. */
  name: string;
  role: FolderRole;
  /** Parent folder id, for the tree. Null at root. */
  parentId: Id | null;
  depth: number;
  unread: number;
  total: number;
  color: string | null;
  /** User pinned this folder to the top of the rail. */
  pinned: boolean;
  /** Subscribed in IMAP. Unsubscribed folders sync but stay collapsed. */
  subscribed: boolean;
  position: number;
}

/* ──────────────────────────────────────────────────────────────────────────
   Messages
   ────────────────────────────────────────────────────────────────────────── */

export interface Addr {
  name: string | null;
  address: string;
}

export interface Attachment {
  id: Id;
  filename: string;
  mimeType: string;
  size: number;
  /** True for images referenced by cid: in the HTML body. */
  inline: boolean;
  contentId: string | null;
}

export type Flag = 'seen' | 'flagged' | 'answered' | 'draft' | 'deleted' | 'recent';

/** What the list renders. Deliberately small — no bodies, no attachments blob. */
export interface MessageSummary {
  id: Id;
  accountId: Id;
  folderId: Id;
  threadId: Id;
  /** RFC Message-ID, for dedupe across accounts receiving the same mail. */
  messageId: string;
  from: Addr;
  to: Addr[];
  subject: string;
  /** First ~200 chars of the text body, pre-computed at index time. */
  preview: string;
  date: IsoDate;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  /** Number of messages in this thread within the current scope. */
  threadCount: number;
  /** Bytes, for the size column. */
  size: number;
  /** User + rule labels, not IMAP folders. */
  labels: string[];
  /** Computed server-side: priority tier of the owning account, denormalised
   *  so the list can sort without joining. */
  priority: Priority;
}

export interface Message extends MessageSummary {
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  /** Sanitised HTML. Null when the message is text-only. */
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: Attachment[];
  /** Selected headers, for the "show original" panel. */
  headers: Record<string, string>;
  inReplyTo: string | null;
  references: string[];
  /** True when the HTML referenced remote images that were blocked. */
  hasBlockedRemoteContent: boolean;
  /**
   * Why the body is missing, in the mail server's own words.
   *
   * Bodies are fetched on demand, so reading a message can fail in ways that
   * listing it cannot. When it does, the envelope is still real and still worth
   * showing — sender, subject, date and thread all come from the local index.
   * Failing the whole read instead would mean an unreachable mail server takes
   * away mail we already hold, which is the opposite of what a local index is
   * for. Null when the body loaded, or when there was nothing to load.
   */
  bodyError: string | null;
}

export interface Thread {
  id: Id;
  subject: string;
  messages: Message[];
  participants: Addr[];
  lastDate: IsoDate;
  unread: number;
}

/* ──────────────────────────────────────────────────────────────────────────
   Querying
   ────────────────────────────────────────────────────────────────────────── */

/** What the list is currently looking at. Serialisable → it lives in the URL. */
export interface Scope {
  kind: 'unified' | 'account' | 'domain' | 'folder' | 'search' | 'saved';
  /** accountId | domain | folderId | query string | savedViewId */
  value: string | null;
  /** Restrict a unified/domain scope to one folder role. */
  role: FolderRole | null;
}

/** `relevance` only means anything under a search scope — everywhere else
 *  every row scores the same and it degrades to a date sort. */
export type SortKey =
  | 'date'
  | 'priority'
  | 'sender'
  | 'subject'
  | 'size'
  | 'unread'
  | 'relevance';
export type SortDir = 'asc' | 'desc';

export type GroupKey = 'none' | 'date' | 'account' | 'domain' | 'priority' | 'sender' | 'folder';

export interface ListQuery {
  scope: Scope;
  sort: SortKey;
  dir: SortDir;
  group: GroupKey;
  /** Facet filters, ANDed together. */
  filters: {
    unreadOnly: boolean;
    flaggedOnly: boolean;
    hasAttachments: boolean;
    /** Empty = all. */
    accountIds: Id[];
    domains: string[];
    /** Narrows within the scope rather than replacing it — this is how "search
     *  in this folder only" stays a filter instead of a second scope. */
    folderIds: Id[];
    priorities: Priority[];
    labels: string[];
    /** ISO dates. */
    since: IsoDate | null;
    before: IsoDate | null;
  };
  /** Collapse threads into one row. */
  threaded: boolean;
  limit: number;
  /** Opaque cursor from the previous page. */
  cursor: string | null;
}

export interface ListResult {
  messages: MessageSummary[];
  /** Null when there are no more pages. */
  nextCursor: string | null;
  /** Total matching, capped — exact counts on huge mailboxes are not worth
   *  the table scan. `approximate` says which one you got. */
  total: number;
  approximate: boolean;
  /** Facet counts for the filter bar, computed over the whole scope. */
  facets: {
    accounts: Record<Id, number>;
    domains: Record<string, number>;
    priorities: Record<Priority, number>;
    labels: Record<string, number>;
    unread: number;
    flagged: number;
    withAttachments: number;
  };
}

/** A named ListQuery. The user's "smart folders". */
export interface SavedView {
  id: Id;
  name: string;
  /** Single character or short string rendered in the rail. */
  glyph: string;
  color: string | null;
  query: ListQuery;
  pinned: boolean;
  position: number;
}

/* ──────────────────────────────────────────────────────────────────────────
   Composition
   ────────────────────────────────────────────────────────────────────────── */

export interface Draft {
  id: Id;
  accountId: Id;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** Set when replying/forwarding. */
  inReplyTo: Id | null;
  forwardOf: Id | null;
  attachments: Attachment[];
  updatedAt: IsoDate;
  /** Set when the user schedules the send. */
  sendAt: IsoDate | null;
}

/* ──────────────────────────────────────────────────────────────────────────
   Onboarding
   ────────────────────────────────────────────────────────────────────────── */

export type Security = 'tls' | 'starttls' | 'none';

export interface ServerConfig {
  host: string;
  port: number;
  security: Security;
  username: string;
}

export interface Autoconfig {
  /** How we found it — shown to the user so nothing feels like magic. */
  source: 'srv' | 'autoconfig' | 'autodiscover' | 'wellknown' | 'guess' | 'known';
  imap: ServerConfig;
  smtp: ServerConfig;
  /** Confidence 0–1. Below 0.5 the wizard pre-opens the manual fields. */
  confidence: number;
}

export interface VerifyResult {
  imap: { ok: boolean; error: string | null; latencyMs: number | null; capabilities: string[] };
  smtp: { ok: boolean; error: string | null; latencyMs: number | null };
}

/* ── Bulk onboarding ────────────────────────────────────────────────────────
   Adding twelve mailboxes by running a three-step wizard twelve times is not a
   feature, it is an apology. Bulk import exists because these mailboxes all live
   on one server: the ports, the security and the auth method are identical for
   every one of them, so they are stated once and the per-mailbox part shrinks to
   an address and a password. */

/** One row of the import. Everything optional falls back to the shared settings
 *  or to a value derived from the address. */
export interface BulkAccountInput {
  address: string;
  password: string;
  /** Overrides the domain preset. */
  priority: Priority | null;
  label: string | null;
  displayName: string | null;
}

/**
 * A host, possibly templated.
 *
 * `{domain}` is substituted with each address's own domain, which is what makes
 * one entry cover eight domains whose certificates are all `mail.<domain>`. A
 * host with no placeholder is used verbatim for every row — equally valid here,
 * since Dovecot authenticates on the full address regardless of which hostname
 * the connection arrived on.
 */
export interface ServerTemplate {
  hostTemplate: string;
  port: number;
  security: Security;
}

export interface BulkOnboardInput {
  imap: ServerTemplate;
  smtp: ServerTemplate;
  accounts: BulkAccountInput[];
}

/** Per-row outcome. Partial success is the normal case — one wrong password out
 *  of forty must not discard the thirty-nine that worked. */
export interface BulkOnboardRow {
  address: string;
  ok: boolean;
  accountId: Id | null;
  /** The server's own words when `ok` is false. */
  error: string | null;
  /** True when IMAP verified but SMTP did not: the account is created and can
   *  receive, but sending from it will fail until it is fixed. */
  smtpWarning: string | null;
}

export interface BulkOnboardResult {
  rows: BulkOnboardRow[];
}

/** Set once, before the import, and applied to every mailbox in that domain.
 *  Priority lands on the account; the colour lands in preferences. */
export interface DomainPreset {
  priority: Priority;
  color: string | null;
}

/** How many rows one bulk request carries. The client chunks to this so the grid
 *  fills in visibly instead of hanging on one request for forty-five mailboxes,
 *  each of which needs its own IMAP and SMTP round trip. */
export const BULK_CHUNK = 5;

/* ──────────────────────────────────────────────────────────────────────────
   Preferences — everything the user can customise
   ────────────────────────────────────────────────────────────────────────── */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'cosy' | 'relaxed';

/**
 * How heavy the interface's type is drawn.
 *
 * Three steps rather than a free number, and three is not a round figure — it
 * is all there is. The UI face is three static weights, not a variable one, so
 * body type can be drawn Regular or Medium and no third thing, and every step
 * is a pair of (body, emphasis) taken from what remains once emphasis is
 * required to outweigh body. `regular` is the ramp the app was drawn at.
 *
 * A value this build does not recognise resolves to `regular` in both places
 * that read it — the stylesheet matches no `[data-weight]` block and falls back
 * to the base ramp, and the settings slider parks on the same step — so a
 * downgrade shows the default rather than disagreeing with itself.
 */
export type FontWeight = 'light' | 'regular' | 'bold';

/**
 * What to do with the colours a sender chose.
 *
 * A message is drawn for white paper. On a dark surface that is at best a
 * floodlight and at worst unreadable — the common failure is a body that
 * declares no background at all and hardcodes dark grey text, which then lands
 * on the reader's dark grey. `follow` re-lights those for the current theme,
 * which means it does nothing at all in light mode.
 *
 * `sent` is the escape hatch, and it exists because re-lighting is a judgement:
 * when a colour *is* the content — a swatch, a chart, a brand proof — the only
 * correct rendering is the sender's own.
 */
export type MailColors = 'follow' | 'dark' | 'sent';

/** How a message is coloured on its way to a printer. `paper` re-lights it for
 *  black ink on white; `original` prints what the sender drew. */
export type PrintColors = 'paper' | 'original';
export type LayoutMode = 'columns' | 'stacked' | 'list';
export type PreviewPosition = 'right' | 'bottom' | 'off';

/** What a mobile swipe reveals on a row. `pin` is the \Flagged bit — the same
 *  one the desktop calls Flag. `move` and `label` need a target picker and are
 *  offered for forward-compatibility; the swipe itself only commits the four
 *  actions that have a single existing store function. */
export type SwipeAction = 'none' | 'archive' | 'trash' | 'read' | 'pin' | 'move' | 'label';

export interface MobilePreferences {
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  /** A swipe past the commit threshold fires without lifting into a button. */
  longSwipeCommits: boolean;
}

/** A user-defined sender identity. Every authorised domain also covers its
 * subdomains, but no other domain is inferred to belong to the same sender. */
export interface SenderProfile {
  id: string;
  name: string | null;
  domains: string[];
  /** A user-supplied HTTPS logo URL. Null keeps the generated monogram. */
  imageUrl: string | null;
  allowRemoteImages: boolean;
}

export interface Theme {
  mode: ThemeMode;
  accent: string;
  density: Density;
  /** Corner radius in px. 0 is flat. */
  radius: number;
  contrast: 'normal' | 'high';
  /** Honour prefers-reduced-motion regardless; this is an extra opt-out. */
  reduceMotion: boolean;
  /** Domain → colour. Accounts inherit unless overridden. */
  domainColors: Record<string, string>;
  /**
   * Domain → glyph id from the pickable set (see `components/glyphs.tsx`).
   *
   * Presentation for the rail, where a domain is otherwise two letters of its
   * own name. At eight domains the letters start colliding — "chungus.holdings"
   * and "chungus.group" are both CH — and a picture is the fastest way out of
   * that without widening the rail. An id nothing resolves falls back to the
   * letters, so a glyph removed in a later version breaks nothing.
   */
  domainIcons: Record<string, string>;
  /** Folder role → colour. */
  folderColors: Partial<Record<FolderRole, string>>;
  /** Label → colour. */
  labelColors: Record<string, string>;
  fontScale: number;
  /** Interface type weight. Scale and weight are separate dials because they
   *  fail separately: small type is a reach problem, thin type is a contrast
   *  one, and a phone in daylight can have the second without the first. */
  fontWeight: FontWeight;
}

export interface Preferences {
  theme: Theme;
  layout: LayoutMode;
  preview: PreviewPosition;
  /** Default list query applied when the app opens. */
  defaultQuery: Pick<ListQuery, 'sort' | 'dir' | 'group' | 'threaded'>;
  /** Show sender avatars / monograms in the list. */
  showAvatars: boolean;
  /** Show the account colour stripe on each row. */
  showAccountStripe: boolean;
  /** Which columns the list renders, in order. */
  listColumns: ListColumn[];
  /** Mark read after N ms of the message being open. -1 = never auto-mark. */
  markReadDelayMs: number;
  /** Undo window for destructive actions. */
  undoWindowMs: number;
  /** Load remote images without asking, per sender trust. */
  remoteImages: 'always' | 'never' | 'trusted';
  /** Default treatment of a sender's colours in the reader. Overridable per
   *  message, and the override never outlives the message. */
  mailColors: MailColors;
  /** Which colour mode the print control reaches for first. */
  printColors: PrintColors;
  /** Explicit sender identities used for image permission and branding. */
  senderProfiles: SenderProfile[];
  /** Confirm before sending with an empty subject etc. */
  sendGuards: boolean;
  /** How search results are ranked. See `search.ts`. */
  search: SearchPreferences;
  /** User-made sidebar folders holding mailboxes. Empty = group by domain only. */
  accountGroups: AccountGroup[];
  /** Touch-shell behaviour. */
  mobile: MobilePreferences;
}

/** Touch-shell defaults: swipe left to archive, right to mark read. */
export const DEFAULT_MOBILE_PREFERENCES: MobilePreferences = {
  swipeLeft: 'archive',
  swipeRight: 'read',
  longSwipeCommits: true,
};

/**
 * The complete default preference set.
 *
 * Lives in the contract because both sides need it and they must not disagree:
 * the backend merges stored preferences over these before responding, and the
 * client merges again on receipt. A user who has never opened settings still
 * gets a fully-populated object, which means no component ever has to guard
 * against a missing field.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  theme: {
    mode: 'system',
    accent: 'oklch(62% 0.19 258)',
    density: 'cosy',
    radius: 4,
    contrast: 'normal',
    reduceMotion: false,
    domainColors: {},
    domainIcons: {},
    folderColors: {},
    labelColors: {},
    fontScale: 1,
    fontWeight: 'regular',
  },
  layout: 'columns',
  preview: 'right',
  defaultQuery: { sort: 'date', dir: 'desc', group: 'date', threaded: true },
  showAvatars: true,
  showAccountStripe: true,
  listColumns: [
    'stripe',
    'unread',
    'avatar',
    'sender',
    'subject',
    'preview',
    'labels',
    'attachment',
    'date',
  ],
  markReadDelayMs: 900,
  undoWindowMs: 6000,
  remoteImages: 'trusted',
  // Follow the theme. Anyone who has read mail in a dark client knows the
  // alternative, and it is not "faithful" — it is a white rectangle at 2am.
  mailColors: 'follow',
  // Paper, because the whole reason to print a message is that the receipt is
  // in the body and there is no attachment to save. That job wants black ink.
  printColors: 'paper',
  senderProfiles: [],
  sendGuards: true,
  search: DEFAULT_SEARCH_PREFERENCES,
  accountGroups: [],
  mobile: DEFAULT_MOBILE_PREFERENCES,
};

/** Merge stored preferences over the defaults. Nested objects are merged one
 *  level deep — `theme` is the only nested shape and it is flat below that.
 *  `search` is two deep, so it brings its own merge from `search.ts`. */
export function withPreferenceDefaults(stored: Partial<Preferences> | null | undefined): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    theme: { ...DEFAULT_PREFERENCES.theme, ...stored?.theme },
    defaultQuery: { ...DEFAULT_PREFERENCES.defaultQuery, ...stored?.defaultQuery },
    search: withSearchDefaults(stored?.search),
    mobile: { ...DEFAULT_MOBILE_PREFERENCES, ...stored?.mobile },
    // Arrays replace rather than merge, but a stored `null` must not become
    // `null` on a field every caller maps over.
    accountGroups: stored?.accountGroups ?? [],
    senderProfiles: stored?.senderProfiles ?? [],
  };
}

export type ListColumn =
  | 'stripe'
  | 'select'
  | 'unread'
  | 'flag'
  | 'avatar'
  | 'sender'
  | 'subject'
  | 'preview'
  | 'labels'
  | 'account'
  | 'attachment'
  | 'size'
  | 'date';

/* ──────────────────────────────────────────────────────────────────────────
   Actions & sync
   ────────────────────────────────────────────────────────────────────────── */

export type MessageAction =
  | { type: 'flag'; add: Flag[]; remove: Flag[] }
  | { type: 'move'; folderId: Id }
  | { type: 'copy'; folderId: Id }
  | { type: 'delete'; permanent: boolean }
  | { type: 'label'; add: string[]; remove: string[] }
  | { type: 'snooze'; until: IsoDate };

/* ──────────────────────────────────────────────────────────────────────────
   Unsubscribe

   The only action in this application that reaches a server nobody here
   controls, and the only one that cannot be undone. So it is split in two: a
   plan you can look at, and an execution you have to ask for by name.
   ────────────────────────────────────────────────────────────────────────── */

export interface UnsubscribeOption {
  /** `http` is an RFC 8058 POST; `mailto` is a message sent from your account. */
  method: 'http' | 'mailto';
  /** The URL or address the sender published. */
  target: string;
  /**
   * True when this can be done without a person.
   *
   * For `http` that means the message carried `List-Unsubscribe-Post` — the
   * sender's own statement that a bare POST is the intended flow. An HTTPS
   * target *without* it is a web page to visit, not an endpoint to call, and
   * this app will not POST to it.
   */
  automatic: boolean;
  /** Why `automatic` is false, in words the UI can show. */
  blockedReason?: string;
}

export interface UnsubscribePlan {
  messageId: Id;
  accountId: Id;
  /** The sender being asked to stop. */
  from: Addr;
  /** `List-Id`, when the message had one. */
  listId: string | null;
  /** Ordered best-first. Empty when the message published no way to unsubscribe. */
  options: UnsubscribeOption[];
  /** Earlier attempts against this same sender, newest first. */
  history: UnsubscribeAttempt[];
}

export interface UnsubscribeAttempt {
  at: IsoDate;
  method: 'http' | 'mailto';
  target: string;
  status: 'ok' | 'failed';
  detail: string | null;
  /** `session` when a person did it, otherwise the API token's name. */
  actor: string;
}

export interface UnsubscribeResult {
  /** False means nothing was sent or posted; `detail` says why. */
  ok: boolean;
  method: 'http' | 'mailto';
  target: string;
  detail: string | null;
}

export interface SyncState {
  /** Per account. */
  accounts: Record<
    Id,
    {
      status: AccountStatus;
      /** 0–1, or null when the length is unknown. */
      progress: number | null;
      /** Human-readable current step, e.g. "Indexing INBOX 4,120/12,900". */
      step: string | null;
      lastSyncAt: IsoDate | null;
      error: string | null;
    }
  >;
  /** True while any account is mid-sync. */
  busy: boolean;
  /** Progress of the bounded body-search backfill. */
  bodySearch: { indexed: number; total: number };
}

/** Pushed over SSE so the UI never polls. */
export type ServerEvent =
  | { type: 'sync'; state: SyncState }
  | { type: 'messages:new'; accountId: Id; folderId: Id; messages: MessageSummary[] }
  | { type: 'messages:changed'; ids: Id[]; patch: Partial<MessageSummary> }
  | { type: 'messages:deleted'; ids: Id[] }
  /**
   * Aggregates, after something changed them.
   *
   * Folders travel with accounts because the sidebar reads both and they must
   * never disagree: the unified role rows sum folder counts while the account
   * rows read the account total, so shipping one without the other leaves two
   * numbers on screen describing the same mail differently.
   */
  | {
      type: 'counts';
      accounts: Record<Id, { unread: number; total: number }>;
      folders: Record<Id, { unread: number; total: number }>;
    }
  | { type: 'account:changed'; account: Account };

/* ── Domain control ───────────────────────────────────────────────────────── */

/**
 * What may be done to a domain on the mail server.
 *
 * `DomainConfig` above is a domain's *presentation* — its label and colour in
 * the sidebar. This is a different axis entirely: whether this install may
 * write to the mail server that hosts the domain, and how far.
 *
 * Every one of these is off until something turns it on, and the only thing that
 * does is the mail server's own answer about what it permits — `domain connect`
 * asks and stores exactly that. `purge` is separate from `delete` because
 * retiring an address and destroying its mail are different decisions that
 * happen to share a button.
 */
export type DomainGrant = 'list' | 'create' | 'delete' | 'password' | 'alias' | 'purge';

export const DOMAIN_GRANTS: DomainGrant[] = [
  'list',
  'create',
  'delete',
  'password',
  'alias',
  'purge',
];

export const isDomainGrant = (v: string): v is DomainGrant =>
  (DOMAIN_GRANTS as string[]).includes(v);

/** One line each, in the operator's words, for the settings screen. */
export const DOMAIN_GRANT_LABELS: Record<DomainGrant, string> = {
  list: 'See which addresses exist',
  create: 'Create new addresses',
  delete: 'Remove addresses (mail is kept on disk)',
  password: 'Change a mailbox password',
  alias: 'Add and remove aliases',
  purge: 'Also delete the stored mail when removing an address',
};

export type DomainStatus = 'pending' | 'ok' | 'unreachable' | 'error';

export interface ManagedDomain {
  id: Id;
  domain: string;
  /** Only 'ssh' today. See docs/domain-control.md. */
  driver: string;
  /** Non-secret connection detail. Never contains the key. */
  config: { host: string; port: number; user: string; hostKey: string | null };
  /** What this install has been told it may do. */
  grants: DomainGrant[];
  /**
   * What the mail server said it would allow, at the last probe.
   *
   * Held separately from `grants` because the two are independent, and the
   * server is the one that decides. A grant set here but absent there is shown
   * as unavailable rather than offered as a button that fails.
   */
  serverGrants: DomainGrant[];
  /** `grants` ∩ `serverGrants` — what will actually work. */
  effective: DomainGrant[];
  status: DomainStatus;
  error: string | null;
  lastCheckedAt: IsoDate | null;
}

/** A mailbox as the mail server reports it, not as this app has indexed it. */
export interface ManagedMailbox {
  localpart: string;
  address: string;
  /** True when an account in this install already syncs this address. */
  linked: boolean;
}

export interface ManagedAlias {
  alias: string;
  target: string;
}

export interface DomainProbe {
  status: DomainStatus;
  error: string | null;
  /** Mail server versions, when the helper could report them. */
  postfix: string | null;
  dovecot: string | null;
  /**
   * False when the server's own maps disagree with each other. Reported because
   * a host in that state cannot be provisioned at all — every write rolls
   * itself back at the commit check — and finding out here beats finding out
   * from a failed create.
   */
  parity: boolean;
  serverGrants: DomainGrant[];
  /**
   * Every domain that has an address on that mail server, permitted or not.
   *
   * Separate from `serverGrants` because "this server will not let mainly touch
   * that domain" and "that domain is not on this server at all" are the same
   * refusal and opposite fixes. Empty from a helper too old to report it.
   */
  serves: string[];
}

/** One attempt to change something on a mail server. Written whether it worked
 *  or not, and kept after the domain is disconnected. */
export interface DomainOp {
  id: number;
  domain: string;
  action: string;
  target: string;
  status: 'ok' | 'failed';
  detail: string | null;
  /** 'session' when a person did it, otherwise the API token's name. */
  actor: string;
  createdAt: IsoDate;
}

export interface ApiError {
  error: { code: string; message: string; detail?: unknown };
}
