/**
 * Search syntax.
 *
 * The second file of the contract. `backend/src/contract/search.ts` is a
 * byte-identical copy and `npm run contract:check` fails the build on drift,
 * for the same reason `types.ts` is copied: a query syntax that means one thing
 * in the mock adapter and another in Postgres is worse than no syntax at all.
 *
 * The parser is shared; execution is not. `matchesSearch` below is what the
 * mock adapter runs, and `backend/src/modules/messages/search-sql.ts` mirrors it
 * in SQL — the same arrangement as `query.ts`, with `query-check.mjs` standing
 * between the two.
 *
 *   from:anna to:me subject:invoice label:tax folder:receipts
 *   is:unread is:read is:flagged is:answered has:attachment
 *   before:2026-01-01 after:"last week" after:7d
 *   larger:5mb smaller:100kb
 *   "quoted phrase"   -negated   a OR b   a | b
 *
 * Ranking is shared too, and for the same reason. A query is classified into an
 * intent (`classifyIntent`), the intent picks a `RankingProfile`, and the user's
 * `SearchWeights` scale it. `relevanceScore` runs that profile in TypeScript;
 * `search-sql.ts` hands the same numbers to `ts_rank_cd` and the same
 * multipliers to Postgres. Neither side owns the policy.
 *
 * Postel, hard: **nothing here throws and nothing is rejected.** An operator
 * that is not understood — a bad date, an unknown field, an unbalanced quote —
 * degrades to a plain text term. A search box that answers a typo with an error
 * is a search box people stop using.
 *
 * What free text actually searches: `messages.search` covers subject (A),
 * sender name and address (B) and the 200-character preview (C), and
 * `messages.body_search` covers body text (D) for every message whose body has
 * been fetched. Bodies are fetched on demand and indexed asynchronously, so a
 * message nobody has opened is matchable on its envelope and its preview but
 * not yet on its full text.
 */

import type { FolderRole, MessageSummary, Priority } from './types.ts';

export type SearchField =
  | 'text'
  | 'from'
  | 'to'
  | 'subject'
  | 'label'
  | 'folder'
  | 'unread'
  | 'read'
  | 'flagged'
  | 'answered'
  | 'attachment'
  | 'before'
  | 'after'
  | 'larger'
  | 'smaller';

export interface Clause {
  field: SearchField;
  /** Text fields hold the needle; dates hold ISO-8601; sizes hold bytes as a
   *  decimal string; flag fields hold ''. */
  value: string;
  negated: boolean;
  /** The value arrived quoted, so it is a phrase rather than loose words. */
  phrase: boolean;
}

export interface SearchQuery {
  /** Exactly what the user typed. The URL carries this, not the parse tree. */
  raw: string;
  /** Alternatives, ORed. Every clause within one group must match. An empty
   *  list means "no constraint" — the whole corpus. */
  groups: Clause[][];
}

/** Field names the parser answers to, and what they mean. Also drives the
 *  suggestion dropdown, so a new operator becomes discoverable by existing. */
export const OPERATORS: { token: string; field: SearchField; hint: string }[] = [
  { token: 'from:', field: 'from', hint: 'Sender name or address' },
  { token: 'to:', field: 'to', hint: 'Recipient' },
  { token: 'subject:', field: 'subject', hint: 'Words in the subject' },
  { token: 'label:', field: 'label', hint: 'One of your labels' },
  { token: 'folder:', field: 'folder', hint: 'Folder name or role' },
  { token: 'is:unread', field: 'unread', hint: 'Not yet read' },
  { token: 'is:read', field: 'read', hint: 'Already read' },
  { token: 'is:flagged', field: 'flagged', hint: 'Flagged' },
  { token: 'is:answered', field: 'answered', hint: 'You replied' },
  { token: 'has:attachment', field: 'attachment', hint: 'Carries a file' },
  { token: 'after:', field: 'after', hint: 'Date, or “last week”' },
  { token: 'before:', field: 'before', hint: 'Date, or “2026-01-01”' },
  { token: 'larger:', field: 'larger', hint: 'Size, e.g. 5mb' },
  { token: 'smaller:', field: 'smaller', hint: 'Size, e.g. 100kb' },
];

/* ── Parse ────────────────────────────────────────────────────────────────── */

interface Token {
  text: string;
  quoted: boolean;
  /** Where the first quote opened, so `"a:b"` stays a phrase while `from:"a b"`
   *  still splits on its operator. -1 when unquoted. */
  quoteAt: number;
}

export function parseSearch(raw: string, now: number = Date.now()): SearchQuery {
  const groups: Clause[][] = [[]];

  for (const tok of tokenize(raw)) {
    // Uppercase only. Accepting `or` would silently break a literal search for
    // the word "or", which is a worse failure than requiring a shift key.
    if (!tok.quoted && (tok.text === 'OR' || tok.text === '|')) {
      if (groups[groups.length - 1]!.length) groups.push([]);
      continue;
    }
    const clause = toClause(tok, now);
    if (clause) groups[groups.length - 1]!.push(clause);
  }

  return { raw, groups: groups.filter((g) => g.length > 0) };
}

function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  let buf = '';
  let quoted = false;
  let quoteAt = -1;
  let open = false;

  const flush = () => {
    if (buf.length || quoted) out.push({ text: buf, quoted, quoteAt });
    buf = '';
    quoted = false;
    quoteAt = -1;
  };

  for (const ch of raw) {
    if (ch === '"') {
      // An unbalanced quote just runs to the end of the input. There is no
      // error to report; the user is mid-typing.
      if (!open && quoteAt === -1) quoteAt = buf.length;
      open = !open;
      quoted = true;
      continue;
    }
    if (!open && (ch === ' ' || ch === '\t' || ch === '\n')) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function toClause(tok: Token, now: number): Clause | null {
  let text = tok.text;
  let negated = false;
  let quoteAt = tok.quoteAt;

  if (text.startsWith('-') && text.length > 1) {
    negated = true;
    text = text.slice(1);
    if (quoteAt > 0) quoteAt -= 1;
  }
  if (!text.length) return null;

  const plain = (): Clause => ({ field: 'text', value: text, negated, phrase: tok.quoted });

  const colon = text.indexOf(':');
  // No colon, or the colon sits inside a quoted run, so there is no operator to
  // read — `"time: 4pm"` is a phrase, not a `time` field.
  if (colon <= 0 || (quoteAt !== -1 && quoteAt <= colon)) return plain();

  const field = text.slice(0, colon).toLowerCase();
  const value = text.slice(colon + 1);
  if (!value.length) return plain();

  const clause = (f: SearchField, v: string): Clause => ({
    field: f,
    value: v,
    negated,
    phrase: tok.quoted,
  });

  switch (field) {
    case 'from':
      return clause('from', value.toLowerCase());
    case 'to':
    case 'cc':
      return clause('to', value.toLowerCase());
    case 'subject':
    case 'title':
      return clause('subject', value.toLowerCase());
    case 'label':
    case 'tag':
      return clause('label', value.toLowerCase());
    case 'folder':
    case 'in':
      return clause('folder', value.toLowerCase());

    case 'is': {
      const flag = value.toLowerCase();
      if (flag === 'unread' || flag === 'new') return clause('unread', '');
      if (flag === 'read' || flag === 'seen') return clause('read', '');
      if (flag === 'flagged' || flag === 'starred') return clause('flagged', '');
      if (flag === 'answered' || flag === 'replied') return clause('answered', '');
      return plain();
    }

    case 'has': {
      const what = value.toLowerCase();
      if (what.startsWith('attach') || what === 'file' || what === 'files') {
        return clause('attachment', '');
      }
      return plain();
    }

    case 'before':
    case 'until': {
      const iso = parseDateish(value, now);
      return iso ? clause('before', iso) : plain();
    }
    case 'after':
    case 'since': {
      const iso = parseDateish(value, now);
      return iso ? clause('after', iso) : plain();
    }

    case 'larger':
    case 'bigger': {
      const bytes = parseSize(value);
      return bytes === null ? plain() : clause('larger', String(bytes));
    }
    case 'smaller':
    case 'less': {
      const bytes = parseSize(value);
      return bytes === null ? plain() : clause('smaller', String(bytes));
    }

    default:
      // `foo:bar` is not an operator we know, so it is two words the user
      // typed. Searching for it beats telling them off.
      return plain();
  }
}

/* ── Values ───────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;

/**
 * A date, however it was written.
 *
 * Everything resolves to the *start* of the period it names, so `after:monday`
 * includes Monday and `before:today` excludes today. Returns null when the
 * input is not a date at all, which is the caller's cue to treat it as text.
 */
export function parseDateish(input: string, now: number = Date.now()): string | null {
  const v = input.trim().toLowerCase();
  if (!v) return null;

  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  // 2026-08-07 | 2026-08 | 2026
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(v);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Number(y), m ? Number(m) - 1 : 0, d ? Number(d) : 1);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // 7d | 2w | 3m | 1y — "within the last N", so it resolves to a point in the
  // past and reads naturally after `after:`.
  const rel = /^(\d+)\s*([dwmy])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const d = startOfDay(now);
    if (unit === 'd') d.setDate(d.getDate() - n);
    if (unit === 'w') d.setDate(d.getDate() - n * 7);
    if (unit === 'm') d.setMonth(d.getMonth() - n);
    if (unit === 'y') d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  }

  switch (v) {
    case 'today':
      return startOfDay(now).toISOString();
    case 'yesterday':
      return startOfDay(now - DAY_MS).toISOString();
    case 'this week': {
      const d = startOfDay(now);
      // Monday-first: an inbox week starts when work does.
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return d.toISOString();
    }
    case 'last week': {
      const d = startOfDay(now);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
      return d.toISOString();
    }
    case 'this month': {
      const d = startOfDay(now);
      d.setDate(1);
      return d.toISOString();
    }
    case 'last month': {
      const d = startOfDay(now);
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString();
    }
    case 'this year': {
      const d = startOfDay(now);
      d.setMonth(0, 1);
      return d.toISOString();
    }
    case 'last year': {
      const d = startOfDay(now);
      d.setMonth(0, 1);
      d.setFullYear(d.getFullYear() - 1);
      return d.toISOString();
    }
    default:
      return null;
  }
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/** `5mb` → 5242880. Bare numbers are bytes. Null when it is not a size. */
export function parseSize(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb?|mb?|gb?)?$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (SIZE_UNITS[(m[2] ?? 'b').toLowerCase()] ?? 1));
}

/* ── Match ────────────────────────────────────────────────────────────────── */

export interface SearchContext {
  /**
   * The names a folder answers to: its leaf name and its role.
   *
   * Deliberately *not* the IMAP path. Dovecot nests everything under `INBOX.`,
   * so matching on the path would make `folder:inbox` return the entire
   * mailbox — the one query where a wrong answer is least likely to be noticed.
   */
  folderNames(folderId: string): string[];
}

/** True when the message satisfies the query. An empty query matches
 *  everything, which is what makes an empty search box harmless. */
export function matchesSearch(
  m: MessageSummary,
  q: SearchQuery,
  ctx: SearchContext,
): boolean {
  if (!q.groups.length) return true;
  return q.groups.some((group) => group.every((c) => (hit(m, c, ctx) ? !c.negated : c.negated)));
}

function hit(m: MessageSummary, c: Clause, ctx: SearchContext): boolean {
  const v = c.value;
  switch (c.field) {
    case 'text': {
      const needle = v.toLowerCase();
      return (
        m.subject.toLowerCase().includes(needle) ||
        m.preview.toLowerCase().includes(needle) ||
        m.from.address.toLowerCase().includes(needle) ||
        (m.from.name?.toLowerCase().includes(needle) ?? false) ||
        m.to.some(
          (a) =>
            a.address.toLowerCase().includes(needle) ||
            (a.name?.toLowerCase().includes(needle) ?? false),
        ) ||
        m.labels.some((l) => l.toLowerCase().includes(needle))
      );
    }
    case 'from':
      return (
        m.from.address.toLowerCase().includes(v) ||
        (m.from.name?.toLowerCase().includes(v) ?? false)
      );
    case 'to':
      return m.to.some(
        (a) => a.address.toLowerCase().includes(v) || (a.name?.toLowerCase().includes(v) ?? false),
      );
    case 'subject':
      return m.subject.toLowerCase().includes(v);
    case 'label':
      return m.labels.some((l) => l.toLowerCase().includes(v));
    case 'folder':
      return ctx.folderNames(m.folderId).some((n) => n.toLowerCase().includes(v));
    case 'unread':
      return !m.seen;
    case 'read':
      return m.seen;
    case 'flagged':
      return m.flagged;
    case 'answered':
      return m.answered;
    case 'attachment':
      return m.hasAttachments;
    case 'before':
      return Date.parse(m.date) < Date.parse(v);
    case 'after':
      return Date.parse(m.date) >= Date.parse(v);
    case 'larger':
      return m.size > Number(v);
    case 'smaller':
      return m.size < Number(v);
  }
}

/* ── Ranking ──────────────────────────────────────────────────────────────── */

/**
 * What the query is *for*.
 *
 * One ranking cannot serve every search. Digging a PDF out of 2023 and finding
 * the reply someone sent this morning want opposite things from recency, and a
 * scoring function that splits the difference is wrong for both. So the query
 * is classified first and the weights follow from the classification.
 *
 * The classification reads the **parse tree only** — no model, no history, no
 * word lists. That is what makes it a contract: the same query lands in the
 * same bucket in the mock adapter and in Postgres, forever, without the two
 * having to agree about anything but this function.
 */
export type SearchIntent =
  /** Nothing textual to rank — `is:unread has:attachment`. A sweep, not a search. */
  | 'triage'
  /** A file hunt: `has:attachment`, `larger:`, `smaller:`. */
  | 'file'
  /** A quoted phrase. The user knows the words, so age matters little. */
  | 'phrase'
  /** Dominated by `from:` / `to:`. Looking for a person's mail. */
  | 'person'
  /** `subject:` with no loose terms. */
  | 'subject'
  /** A date window the user pinned themselves. */
  | 'dated'
  /** Loose words. The default. */
  | 'general';

export const SEARCH_INTENTS: SearchIntent[] = [
  'triage',
  'file',
  'phrase',
  'person',
  'subject',
  'dated',
  'general',
];

/** Clause fields that put words on screen and can therefore be ranked. */
const TEXTUAL: SearchField[] = ['text', 'subject', 'from', 'to'];

/**
 * Which bucket a query falls in. Order is precedence, and it is deliberate:
 * `from:anna has:attachment` is a file hunt that happens to name a person, not
 * a person search that happens to mention files.
 */
export function classifyIntent(q: SearchQuery): SearchIntent {
  // Negated clauses say what to exclude. They never say what the search is for.
  const live = q.groups.flat().filter((c) => !c.negated);
  const n = (...fields: SearchField[]) => live.filter((c) => fields.includes(c.field)).length;

  if (n(...TEXTUAL) === 0) return 'triage';
  if (n('attachment', 'larger', 'smaller') > 0) return 'file';
  if (live.some((c) => c.phrase)) return 'phrase';
  if (n('from', 'to') >= n('text', 'subject')) return 'person';
  if (n('subject') > 0 && n('text') === 0) return 'subject';
  if (n('before', 'after') > 0) return 'dated';
  return 'general';
}

/**
 * Everything that decides the order of a result set.
 *
 * The four field weights mirror the `search` tsvector's setweight() labels —
 * subject A, sender B, preview C — and are handed to `ts_rank_cd` as its
 * weights array on the SQL side, so the mock and Postgres weight the same text
 * the same way rather than merely similarly.
 *
 * Everything below the weights is a *multiplier on the finished text score*.
 * They are multiplicative and not additive on purpose: a junk-folder demotion
 * has to survive a strong text match, and an additive penalty does not.
 */
export interface RankingProfile {
  subject: number;
  sender: number;
  preview: number;
  label: number;
  /** The share of a text score that survives any amount of age, 0–1. */
  decayFloor: number;
  /** Days over which the perishable remainder falls by 1/e. */
  decayDays: number;
  /** Multiplier per account priority tier — the app's own priority, applied to
   *  search for the first time here. */
  priority: Record<Priority, number>;
  unread: number;
  flagged: number;
  attachment: number;
  /** Multiplier per folder role. Anything absent scores 1. */
  folder: Partial<Record<FolderRole, number>>;
}

/**
 * The shipped weights.
 *
 * `general` is the old behaviour, preserved to the digit: subject 1.0 / sender
 * 0.4 / preview 0.2, a 0.35 floor and a 45-day curve. Every other profile is
 * expressed as a change from it, so a reader can see what each intent actually
 * buys.
 */
const GENERAL: RankingProfile = {
  subject: 1.0,
  sender: 0.4,
  preview: 0.2,
  label: 0.2,
  decayFloor: 0.35,
  decayDays: 45,
  priority: { critical: 1.35, high: 1.15, normal: 1, low: 0.9, muted: 0.75 },
  unread: 1.08,
  flagged: 1.15,
  attachment: 1,
  // Junk and trash are not results, they are places results go to die. Drafts
  // and sent are yours, so they are shaded rather than buried.
  folder: { junk: 0.35, trash: 0.3, drafts: 0.6, sent: 0.85 },
};

export const SEARCH_PROFILES: Record<SearchIntent, RankingProfile> = {
  general: GENERAL,

  // Nothing to rank on, so recency is the ranking. A near-zero floor and a
  // short curve turn the score into "how new is it", with priority still
  // breaking ties across accounts.
  triage: {
    ...GENERAL,
    decayFloor: 0.05,
    decayDays: 10,
    priority: { critical: 1.6, high: 1.25, normal: 1, low: 0.85, muted: 0.6 },
    unread: 1.25,
  },

  // Files are dug out of the past. Decay is nearly flat, the attachment flag
  // is a real signal rather than a tiebreak, and the preview matters more
  // because filenames land there.
  file: {
    ...GENERAL,
    preview: 0.35,
    decayFloor: 0.55,
    decayDays: 120,
    attachment: 1.7,
    unread: 1,
    folder: { ...GENERAL.folder, sent: 1 },
  },

  // The user typed the words in quotes. They know what they are after; a 2022
  // hit is the right answer if it is the only one.
  phrase: {
    ...GENERAL,
    subject: 1.2,
    decayFloor: 0.75,
    decayDays: 180,
    unread: 1,
  },

  // The sender *is* the query. Weighting subject above it would rank a stranger
  // quoting Anna's name above Anna.
  person: {
    ...GENERAL,
    subject: 0.7,
    sender: 1.0,
    decayDays: 60,
    folder: { ...GENERAL.folder, sent: 1 },
  },

  // An explicit subject: search. The other fields are noise the user opted out of.
  subject: { ...GENERAL, subject: 1.4, sender: 0.15, preview: 0.1 },

  // The user pinned the window. Re-sorting inside it by age just undoes that.
  dated: { ...GENERAL, decayFloor: 0.8, decayDays: 365 },
};

/**
 * The user-facing dials, in the app's own vocabulary.
 *
 * One layer, not two: these scale whichever profile the intent chose, rather
 * than letting every profile be edited separately. Seven sliders a person can
 * reason about beat forty-nine they cannot.
 *
 * 1 is "as shipped". 0 removes the signal from the ranking entirely. 2 doubles
 * its distance from neutral.
 */
export interface SearchWeights {
  subject: number;
  sender: number;
  preview: number;
  /** Higher pulls recent mail up. 0 ranks on text alone, ignoring age. */
  recency: number;
  /** How far an account's priority tier moves its mail. */
  accountPriority: number;
  /** How far unread and flagged lift a result. */
  unread: number;
  /** How hard junk, trash and drafts are pushed down. */
  demoteNoise: number;
}

export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  subject: 1,
  sender: 1,
  preview: 1,
  recency: 1,
  accountPriority: 1,
  unread: 1,
  demoteNoise: 1,
};

export interface SearchPreferences {
  /** Read the query's shape and pick a profile. Off pins every query to
   *  `general`, which is exactly the ranking this app shipped with. */
  adaptive: boolean;
  weights: SearchWeights;
}

export const DEFAULT_SEARCH_PREFERENCES: SearchPreferences = {
  adaptive: true,
  weights: DEFAULT_SEARCH_WEIGHTS,
};

/** Merge stored search preferences over the defaults. Same contract as
 *  `withPreferenceDefaults`: a user who has never opened Settings still gets a
 *  fully-populated object, so no ranker has to guard against a missing dial. */
export function withSearchDefaults(
  stored: Partial<SearchPreferences> | null | undefined,
): SearchPreferences {
  return {
    adaptive: stored?.adaptive ?? DEFAULT_SEARCH_PREFERENCES.adaptive,
    weights: { ...DEFAULT_SEARCH_WEIGHTS, ...stored?.weights },
  };
}

const clamp = (n: unknown, lo: number, hi: number, fallback = 1): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

/** Moves a multiplier toward or away from 1. `dial` 0 flattens it to no effect,
 *  1 leaves it alone, 2 doubles its distance from neutral. */
const lever = (multiplier: number, dial: number): number => 1 + (multiplier - 1) * dial;

/** The profile a query actually runs under: its intent's weights, scaled by the
 *  user's dials. Pure, so both sides can call it and get the same numbers. */
export function resolveProfile(
  intent: SearchIntent,
  prefs: SearchPreferences = DEFAULT_SEARCH_PREFERENCES,
): RankingProfile {
  const base = SEARCH_PROFILES[prefs?.adaptive === false ? 'general' : intent] ?? GENERAL;
  const w = { ...DEFAULT_SEARCH_WEIGHTS, ...prefs?.weights };

  const recency = clamp(w.recency, 0, 2);
  const priority = clamp(w.accountPriority, 0, 2);
  const unread = clamp(w.unread, 0, 2);
  const noise = clamp(w.demoteNoise, 0, 2);

  const folder: Partial<Record<FolderRole, number>> = {};
  for (const [role, m] of Object.entries(base.folder) as [FolderRole, number][]) {
    folder[role] = lever(m, noise);
  }

  return {
    subject: base.subject * clamp(w.subject, 0, 3),
    sender: base.sender * clamp(w.sender, 0, 3),
    preview: base.preview * clamp(w.preview, 0, 3),
    label: base.label,
    // Turning recency up eats into the floor and shortens the curve. At 0 the
    // floor is 1 — age is removed from the ranking rather than inverted.
    decayFloor: recency === 0 ? 1 : clamp(1 - (1 - base.decayFloor) * recency, 0, 1),
    decayDays: base.decayDays / clamp(recency, 0.25, 2),
    priority: {
      critical: lever(base.priority.critical, priority),
      high: lever(base.priority.high, priority),
      normal: lever(base.priority.normal, priority),
      low: lever(base.priority.low, priority),
      muted: lever(base.priority.muted, priority),
    },
    unread: lever(base.unread, unread),
    flagged: lever(base.flagged, unread),
    attachment: base.attachment,
    folder,
  };
}

/** Everything the ranker needs that a `MessageSummary` does not carry. */
export interface RankInput {
  /** Skip resolution when the caller already has the profile — the list query
   *  resolves once per request, not once per row. */
  profile?: RankingProfile;
  /** The role of the folder the message sits in, when the caller knows it. */
  folderRole?: FolderRole | null;
}

/**
 * The multipliers a row earns for what it *is*, as opposed to what it says.
 *
 * Separate from the text score so the SQL mirror has one expression to match
 * rather than a formula spread through a loop.
 */
export function boostFactor(
  m: MessageSummary,
  p: RankingProfile,
  folderRole: FolderRole | null = null,
): number {
  let f = p.priority[m.priority] ?? 1;
  if (!m.seen) f *= p.unread;
  if (m.flagged) f *= p.flagged;
  if (m.hasAttachments) f *= p.attachment;
  if (folderRole) f *= p.folder[folderRole] ?? 1;
  return f;
}

export function relevanceScore(
  m: MessageSummary,
  q: SearchQuery,
  now: number = Date.now(),
  input: RankInput = {},
): number {
  const p = input.profile ?? resolveProfile(classifyIntent(q));

  let text = 0;
  for (const group of q.groups) {
    for (const c of group) {
      if (c.negated) continue;
      const v = c.value.toLowerCase();
      if (!v) continue;
      if (c.field === 'text' || c.field === 'subject') {
        if (m.subject.toLowerCase().includes(v)) text += p.subject;
      }
      if (c.field === 'text' || c.field === 'from') {
        if (
          m.from.address.toLowerCase().includes(v) ||
          (m.from.name?.toLowerCase().includes(v) ?? false)
        ) {
          text += p.sender;
        }
      }
      if (c.field === 'text') {
        if (m.preview.toLowerCase().includes(v)) text += p.preview;
        if (m.labels.some((l) => l.toLowerCase().includes(v))) text += p.label;
      }
    }
  }
  // Nothing textual to rank on — a query of pure flags and dates. Fall back to
  // a constant so decay and the boosts decide, rather than declaring every row
  // a tie. Never zero: a zero here would collapse the whole ranking.
  if (text === 0) text = p.preview || 0.1;

  const ageDays = Math.max(0, (now - Date.parse(m.date)) / 86_400_000);
  const decay = p.decayFloor + (1 - p.decayFloor) * Math.exp(-ageDays / p.decayDays);
  return text * decay * boostFactor(m, p, input.folderRole ?? null);
}

/**
 * A number safe to paste into SQL text.
 *
 * Ranking weights come out of a user's stored preferences, which is JSON, which
 * is to say arbitrary. They are interpolated rather than bound because they sit
 * inside an expression Postgres has to plan — so every one of them goes through
 * here first, and `toFixed` guarantees the result is digits and at most one dot.
 *
 * The magnitude clamp is not cosmetic: `toFixed` switches to exponential
 * notation above 1e21, and `1e+21` pasted into SQL is a syntax error at best.
 * No ranking number is ever near the bound.
 */
export const sqlNumber = (n: unknown, fallback = 1): string => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(1e6, Math.max(-1e6, v)).toFixed(6);
};

/**
 * The decay curve, as a SQL fragment over `m.date`. Kept beside the profile it
 * reads so the two cannot drift apart unnoticed.
 *
 * `at` is a SQL expression for the instant to rank against, and it must be a
 * *bound parameter, not `now()`*. A decay that reads the clock re-ranks every
 * row on every request, so the second page of a keyset scan compares this
 * request's ranks against last request's cursor and hands back a row it already
 * showed. The instant therefore travels in the cursor.
 */
export const decaySql = (at: string, p: RankingProfile = GENERAL): string => {
  const floor = clamp(p.decayFloor, 0, 1);
  const days = clamp(p.decayDays, 1, 3650, GENERAL.decayDays);
  return `(${sqlNumber(floor)} + ${sqlNumber(1 - floor)} * exp(-extract(epoch from ${at} - m.date) / ${sqlNumber(days * 86400)}))`;
};

/* ── For the UI ───────────────────────────────────────────────────────────── */

/**
 * The words worth marking in a result row.
 *
 * Only the clauses that put text on screen: `from:`, `subject:` and bare terms.
 * Negated clauses are excluded — highlighting what you asked *not* to see would
 * be actively misleading. Dates, sizes and flags have nothing to mark.
 */
export function searchTerms(q: SearchQuery): string[] {
  const out: string[] = [];
  for (const group of q.groups) {
    for (const c of group) {
      if (c.negated) continue;
      if (c.field === 'text' || c.field === 'from' || c.field === 'subject' || c.field === 'to') {
        if (c.value.length > 1) out.push(c.value);
      }
    }
  }
  return [...new Set(out)];
}

/** True when the query says nothing — an empty box, or only whitespace. */
export const isEmptySearch = (q: SearchQuery): boolean => q.groups.length === 0;
