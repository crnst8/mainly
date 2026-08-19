/**
 * Deterministic fixture data.
 *
 * The frontend must run, and look real, with no backend. Same seed → same
 * mailbox every reload, so screenshots and visual diffs are stable.
 *
 * The mailbox belongs to Dale Bunbury, who owns seven domains and is using all
 * of them to sell Big Chungus. What Big Chungus is, is never established. The
 * fixture is a joke; the *shape* of it is not. Twelve addresses across seven
 * domains at five priority tiers, with real reply chains, is the load this
 * interface exists to survive, and inventing a friendlier fixture would have
 * hidden every layout problem worth finding.
 */

import type {
  Account,
  Addr,
  DomainConfig,
  Folder,
  FolderRole,
  Message,
  MessageSummary,
  Priority,
  SavedView,
} from '../types';

/* ── PRNG: mulberry32. Small, fast, good enough for fixtures. ─────────────── */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(0x5eed1e);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const chance = (p: number) => r() < p;
const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/* ── Accounts ─────────────────────────────────────────────────────────────── */

interface AccountSpec {
  address: string;
  label: string;
  displayName: string;
  priority: Priority;
}

const ACCOUNT_SPECS: AccountSpec[] = [
  { address: 'dale@dalebunbury.com', label: 'Personal', displayName: 'Dale Bunbury', priority: 'critical' },
  { address: 'dale@bigchungus.holdings', label: 'Chungus HQ', displayName: 'Dale Bunbury', priority: 'critical' },
  { address: 'sales@bigchungus.holdings', label: 'Chungus Sales', displayName: 'Big Chungus Holdings', priority: 'high' },
  { address: 'billing@bigchungus.holdings', label: 'Chungus Billing', displayName: 'Big Chungus Holdings', priority: 'high' },
  { address: 'partnerships@chungusglobal.com', label: 'Global Partnerships', displayName: 'Chungus Global', priority: 'high' },
  { address: 'dale@chungusglobal.com', label: 'Global — Me', displayName: 'Dale Bunbury', priority: 'normal' },
  { address: 'hello@thechungusgroup.co', label: 'The Chungus Group', displayName: 'The Chungus Group', priority: 'normal' },
  { address: 'orders@chungusdirect.shop', label: 'Direct Orders', displayName: 'Chungus Direct', priority: 'normal' },
  { address: 'support@chungusdirect.shop', label: 'Direct Support', displayName: 'Chungus Direct Support', priority: 'low' },
  { address: 'noreply@chungus-logistics.net', label: 'Logistics System', displayName: 'Chungus Logistics', priority: 'low' },
  { address: 'dispatch@chungus-logistics.net', label: 'Dispatch', displayName: 'Chungus Logistics', priority: 'high' },
  { address: 'newsletter@notchungus.xyz', label: 'Newsletter', displayName: 'Not Chungus', priority: 'muted' },
];

export const DOMAIN_ORDER = [
  'dalebunbury.com',
  'bigchungus.holdings',
  'chungusglobal.com',
  'thechungusgroup.co',
  'chungusdirect.shop',
  'chungus-logistics.net',
  'notchungus.xyz',
];

/** Distinct default hues, evenly spread. The user can override any of them. */
const DOMAIN_HUES: Record<string, number> = {
  'dalebunbury.com': 258,
  'bigchungus.holdings': 292,
  'chungusglobal.com': 28,
  'thechungusgroup.co': 168,
  'chungusdirect.shop': 88,
  'chungus-logistics.net': 338,
  'notchungus.xyz': 218,
};

export const domainColor = (domain: string) =>
  `oklch(64% 0.16 ${DOMAIN_HUES[domain] ?? 258})`;

export const accounts: Account[] = ACCOUNT_SPECS.map((spec, i) => {
  const domain = spec.address.split('@')[1]!;
  const unread = spec.priority === 'muted' ? int(40, 220) : int(0, 24);
  return {
    id: `acc_${i + 1}`,
    address: spec.address,
    domain,
    label: spec.label,
    displayName: spec.displayName,
    priority: spec.priority,
    status: i === 9 ? 'auth_error' : 'ok',
    color: null,
    hidden: false,
    unread,
    total: int(400, 14000),
    lastSyncAt: new Date(Date.now() - int(4, 900) * 1000).toISOString(),
    error: i === 9 ? 'IMAP login failed: [AUTHENTICATIONFAILED] Invalid credentials' : null,
    signature: null,
    position: i,
  };
});

export const domainConfigs: DomainConfig[] = DOMAIN_ORDER.map((domain, i) => ({
  domain,
  label: null,
  color: domainColor(domain),
  priority: null,
  collapsed: false,
  position: i,
}));

/* ── Folders ──────────────────────────────────────────────────────────────── */

const CORE: { name: string; role: FolderRole; path: string }[] = [
  { name: 'Inbox', role: 'inbox', path: 'INBOX' },
  { name: 'Drafts', role: 'drafts', path: 'INBOX.Drafts' },
  { name: 'Sent', role: 'sent', path: 'INBOX.Sent' },
  { name: 'Archive', role: 'archive', path: 'INBOX.Archive' },
  { name: 'Junk', role: 'junk', path: 'INBOX.Junk' },
  { name: 'Trash', role: 'trash', path: 'INBOX.Trash' },
];

const CUSTOM: Record<string, string[]> = {
  'dalebunbury.com': ['Receipts', 'Family', 'Do Not Show Wife'],
  'bigchungus.holdings': ['Leads', 'Leads/Receptive', 'Leads/Confused', 'Testimonials'],
  'chungusglobal.com': ['Enterprise', 'Enterprise/Pending', 'Legal'],
  'chungusdirect.shop': ['Orders/Pending', 'Orders/Shipped', 'Returns'],
};

export const folders: Folder[] = [];
let folderSeq = 0;

for (const account of accounts) {
  const roots = new Map<string, string>();
  for (const [i, core] of CORE.entries()) {
    const id = `fld_${++folderSeq}`;
    roots.set(core.name, id);
    folders.push({
      id,
      accountId: account.id,
      path: core.path,
      name: core.name,
      role: core.role,
      parentId: null,
      depth: 0,
      unread: core.role === 'inbox' ? account.unread : core.role === 'junk' ? int(0, 60) : 0,
      total: core.role === 'inbox' ? int(200, 9000) : int(0, 1200),
      color: null,
      pinned: false,
      subscribed: true,
      position: i,
    });
  }

  for (const [i, name] of (CUSTOM[account.domain] ?? []).entries()) {
    const parts = name.split('/');
    const leaf = parts.at(-1)!;
    const parentName = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
    const id = `fld_${++folderSeq}`;
    roots.set(name, id);
    folders.push({
      id,
      accountId: account.id,
      path: `INBOX.${parts.join('.')}`,
      name: leaf,
      role: 'custom',
      parentId: parentName ? (roots.get(parentName) ?? null) : null,
      depth: parts.length - 1,
      unread: chance(0.4) ? int(1, 12) : 0,
      total: int(10, 800),
      color: null,
      pinned: false,
      subscribed: true,
      position: CORE.length + i,
    });
  }
}

/* ── Messages ─────────────────────────────────────────────────────────────── */

/**
 * The cast.
 *
 * Each correspondent has a `kind`, and subjects, previews and labels are drawn
 * from that kind rather than from one shared pool. Pairing them at random was
 * the first version and it read as noise — a payment processor writing a
 * testimonial, a father asking about wholesale terms. Coherent senders make the
 * list scannable, which is the only property of it worth testing.
 */
type Kind = 'receptive' | 'confused' | 'hostile' | 'legal' | 'platform' | 'money' | 'family';

interface Sender {
  name: string;
  address: string;
  kind: Kind;
}

const SENDERS: Sender[] = [
  { name: 'Marguerite Vole', address: 'm.vole@heronbrook.example', kind: 'receptive' },
  { name: 'Gary Pardoe', address: 'gary@gary-does-chungus.example', kind: 'receptive' },
  { name: 'Beverly Chidgey', address: 'bev@chidgey-and-daughters.example', kind: 'receptive' },
  { name: 'Wholesale Enquiries', address: 'buying@vantridge-retail.example', kind: 'receptive' },

  { name: 'Trevor Nunnley', address: 'trev@nunnley-plumbing.example', kind: 'confused' },
  { name: 'Sofia Marchetti', address: 'sofia@atelier-mrc.example', kind: 'confused' },
  { name: 'Daniel Okafor', address: 'd.okafor@meridian.example', kind: 'confused' },
  { name: 'Yolanda Kertesz', address: 'y.kertesz@meridian-ventures.example', kind: 'confused' },

  { name: 'Someone Who Has Asked Twice', address: 'stop@please-stop.example', kind: 'hostile' },
  { name: 'Neil Prosser', address: 'n.prosser@prosser-household.example', kind: 'hostile' },
  { name: 'Trading Standards', address: 'enquiries@tradingstandards.example', kind: 'hostile' },

  { name: 'Braddock & Fenn LLP', address: 'notices@braddockfenn.example', kind: 'legal' },
  { name: 'Hollis Wray, Solicitor', address: 'h.wray@wraylegal.example', kind: 'legal' },

  { name: 'Trust & Safety', address: 'no-reply@marketplace.example', kind: 'platform' },
  { name: 'Sending Platform', address: 'no-reply@sendmail-provider.example', kind: 'platform' },
  { name: 'Registrar', address: 'support@domains.example', kind: 'platform' },
  { name: 'Ops Alerts', address: 'alerts@chungus-logistics.net', kind: 'platform' },

  { name: 'Payments', address: 'receipts@payments.example', kind: 'money' },
  { name: 'Priya Ramaswamy', address: 'priya@ramaswamy-accounting.example', kind: 'money' },

  { name: 'Dad', address: 'ken.bunbury@bigpond.example', kind: 'family' },
];

const SUBJECTS: Record<Kind, string[]> = {
  receptive: [
    'I would like to order {n} Big Chungus',
    'Big Chungus changed my life',
    'Re: can Big Chungus be shipped to Norway',
    'RE: BIG CHUNGUS!!!!',
    'Re: wholesale terms — we will take the pallet',
    'Put me down for another {n}',
  ],
  confused: [
    'Re: Big Chungus — what is it, though',
    'Re: Re: Re: still not clear on what Big Chungus actually is',
    'Re: is Big Chungus a physical object',
    'Re: sizing chart (there are no units on it)',
    'Re: Q{q} allocation — sorry, allocation of what',
    'Re: intro — Yolanda <> Dale',
    'Re: those numbers from Tuesday',
  ],
  hostile: [
    'Please stop emailing my wife about Big Chungus',
    'Unsubscribe (I have now said this {n} times)',
    'Re: your six previous emails',
    'Following up ({n}th attempt) — please do not',
    'Complaint lodged — reference #{n}',
  ],
  legal: [
    'Cease and desist — unsolicited correspondence',
    'Re: use of the word “Chungus” in trade',
    'Formal notice — {d}',
    'Response required within 14 days',
  ],
  platform: [
    'Your listing has been removed',
    'Account suspended — bulk sending policy',
    'Action required: domain {d} expires in 14 days',
    'Certificate renewal completed for {d}',
    'Weekly digest — {n} people opened “Big Chungus”',
    'Delivery to 47 recipients was deferred',
  ],
  money: [
    'Invoice #{n} — Big Chungus (1 unit)',
    'Payment declined — Big Chungus Holdings',
    'Order #{n} has shipped',
    'Reminder: BAS lodgement due',
    'Re: the projections, honestly',
    'Your monthly statement is ready',
  ],
  family: [
    'Fwd: Fwd: Fwd: Big Chungus',
    'Your mother is asking what you do now',
    'Re: Sunday',
    'son. what is it',
  ],
};

const PREVIEWS: Record<Kind, string[]> = {
  receptive: [
    'The sample arrived today. I opened the box. I sat with it for some time. I have no notes and no questions. Whatever this is, I am in for the full',
    'Look, I do not understand it either, but three of my staff have one now and morale is the best it has been in years, so put me down for another',
    'I showed it to my sister and she went very quiet and then asked where she could get one, so make that two, and send the invoice to the shop rather',
    'We have cleared shelf space. I am not going to pretend I can describe it to a customer yet but the photographs did something to me and I trust',
  ],
  confused: [
    'Thanks for the quick reply. I have now read all four attachments and I still cannot work out whether Big Chungus is a product, a service, or a',
    'I do not want to be rude, but the sizing chart has no units on it. Is Big Chungus measured in centimetres, in kilograms, or in some third thing',
    'Following our call — genuinely one of the more memorable pitches this quarter. The partners had questions. Most of the questions were “what is it”,',
    'Apologies for the slow response. I forwarded your deck to two colleagues and neither of them could tell me what we would be buying, so before we',
    'You have written to me from four different addresses this week and each one describes Big Chungus slightly differently. Could you send one version',
  ],
  hostile: [
    'Mate. It is eleven at night. My wife has now had nine emails about Big Chungus from four different addresses and she has never met you. Please',
    'Understood, and thank you for the detailed response, but I asked to be removed from this list in March. Then again in April. Then twice in May. I',
    'This is the last time I am going to write this politely. Remove every address associated with this household from every list you operate, and do',
    'We have received a number of complaints regarding unsolicited commercial correspondence originating from domains registered to you. Please respond',
  ],
  legal: [
    'This is a formal notice. Our client requires that you cease all correspondence concerning Big Chungus, including but not limited to the letterhead,',
    'Our client does not accept that the term is descriptive, and reserves all rights. We invite your undertaking in writing within fourteen days of the',
    'We act for the recipient named above. Further contact of any kind will be treated as a breach of the undertaking you gave on the twelfth, and we',
  ],
  platform: [
    'Your listing was removed following reports from other users. The category “Big Chungus” is not one we currently support, and the photograph you',
    'We detected unusual activity on your sending domain: a 4,100% increase in outbound volume against a single recurring subject line. Sending has',
    'Automated notice: the domain above renews in fourteen days. Three other domains on this account renew in the same window, so treat this as a',
    'Delivery was deferred for 47 recipients because the receiving server applied a rate limit. We will retry for 48 hours before returning them to',
  ],
  money: [
    'Your payment of $1,240.00 has been received and applied to the account. A copy of the receipt is attached. Please note the descriptor on the',
    'I am going to be honest with you, Dale. The projections assume every household buys 1.4 Big Chungus and I cannot make that number work against any',
    'The card was declined. This is the third attempt this month and the issuer is now flagging the merchant name, which is not a thing I can fix from',
    'Attached is the statement for the period. The freight line is the one worth looking at — shipping something of that shape is not cheap and it has',
  ],
  family: [
    'Your mother asked me what you do for work and I said you sell Big Chungus and she asked what that is and I said I would find out. So. What is it.',
    'Sunday still fine? Bring nothing. Do not bring one. Your brother has asked specifically that you do not bring one.',
    'I forwarded your email to Ray at the club because he asked and now he has ordered four. I do not know what he thinks he has bought. Neither does',
  ],
};

const LABEL_BY_KIND: Record<Kind, string[]> = {
  receptive: ['receptive', 'believer', 'lead'],
  confused: ['confused', 'lead', 'follow-up'],
  hostile: ['hostile', 'follow-up'],
  legal: ['legal'],
  platform: ['follow-up'],
  money: ['lead'],
  family: [],
};

const fill = (s: string) =>
  s
    .replace('{n}', String(int(100, 9999)))
    .replace('{q}', String(int(1, 4)))
    .replace('{d}', pick(DOMAIN_ORDER));

/**
 * Preview strings are deliberately cut off mid-clause — that is what a preview
 * looks like. A body has to finish the sentence, so each paragraph gets a
 * closing clause rather than another truncated preview glued onto the end.
 * Concatenating two previews was the first version and every paragraph in the
 * reader was a visible run-on.
 */
const TAILS = [
  'before we go any further.',
  'if that is all right with you.',
  'and I would rather ask than assume.',
  'so please treat this as the final word on it.',
  'at your earliest convenience.',
  'when you get a moment.',
  'which is where we have got stuck.',
];

function body(subject: string, from: Addr, kind: Kind): string {
  const pool = PREVIEWS[kind];
  // Distinct paragraphs: the same sentence twice in one email reads as a bug.
  const chosen = [...pool].sort(() => r() - 0.5).slice(0, int(2, Math.min(3, pool.length)));
  return `<p>Hi Dale,</p>${chosen
    .map((line) => `<p>${line} ${pick(TAILS)}</p>`)
    .join('')}<p>Best,<br/>${from.name ?? from.address}</p><p style="color:#888;font-size:12px">Re: ${subject}</p>`;
}

const inboxOf = (accountId: string) =>
  folders.find((f) => f.accountId === accountId && f.role === 'inbox')!;

export const messages: Message[] = [];
const now = Date.now();
let msgSeq = 0;
const threadPool: Record<string, string> = {};

for (const account of accounts) {
  const count = account.priority === 'muted' ? 90 : int(28, 64);
  const inbox = inboxOf(account.id);

  for (let i = 0; i < count; i++) {
    const sender = pick(SENDERS);
    const from: Addr = { name: sender.name, address: sender.address };
    const subject = fill(pick(SUBJECTS[sender.kind]));
    // Recent messages cluster near now; the tail spreads over ~90 days.
    const ageMs = Math.floor(Math.pow(r(), 2.4) * 90 * 864e5) + int(0, 36e5);
    const isReply = subject.startsWith('Re:');
    const threadKey = `${account.id}:${subject.replace(/^(Re|Fwd):\s*/i, '')}`;
    const threadId = isReply && threadPool[threadKey] ? threadPool[threadKey] : `thr_${++msgSeq}`;
    threadPool[threadKey] = threadId;

    const seen = chance(account.priority === 'muted' ? 0.55 : 0.72);
    const attachmentCount = chance(0.22) ? int(1, 3) : 0;
    const id = `msg_${++msgSeq}`;

    messages.push({
      id,
      accountId: account.id,
      folderId: inbox.id,
      threadId,
      messageId: `<${id}.${Date.now()}@${account.domain}>`,
      from,
      to: [{ name: account.displayName, address: account.address }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject,
      preview: pick(PREVIEWS[sender.kind]),
      date: new Date(now - ageMs).toISOString(),
      seen,
      flagged: chance(0.08),
      answered: chance(0.14),
      draft: false,
      hasAttachments: attachmentCount > 0,
      attachmentCount,
      threadCount: isReply ? int(2, 6) : 1,
      size: int(2_400, 480_000),
      labels: LABEL_BY_KIND[sender.kind].length && chance(0.3)
        ? [pick(LABEL_BY_KIND[sender.kind])]
        : [],
      priority: account.priority,
      bodyHtml: body(subject, from, sender.kind),
      bodyText: null,
      attachments: Array.from({ length: attachmentCount }, (_, k) => ({
        id: `att_${id}_${k}`,
        filename: pick([
          'big-chungus-deck-v7.pdf',
          'chungus-sizing-chart.pdf',
          'invoice-4821.pdf',
          'chungus-photo-actual.png',
          'cease-and-desist.pdf',
          'testimonials-collected.docx',
        ]),
        mimeType: 'application/pdf',
        size: int(18_000, 4_200_000),
        inline: false,
        contentId: null,
      })),
      headers: {
        'Message-ID': `<${id}@${account.domain}>`,
        'Return-Path': `<${sender.address}>`,
        'Delivered-To': account.address,
        'DKIM-Signature': 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=' + account.domain,
        'X-Spam-Score': (r() * 3).toFixed(2),
      },
      inReplyTo: null,
      references: [],
      hasBlockedRemoteContent: chance(0.35),
      // The mock never fails to fetch a body; it has them all in memory.
      bodyError: null,
    });
  }
}

messages.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

/** Recompute the unread counts the generator guessed at, so the sidebar and
 *  the list can never disagree. */
for (const account of accounts) {
  const own = messages.filter((m) => m.accountId === account.id);
  account.unread = own.filter((m) => !m.seen).length;
  const inbox = inboxOf(account.id);
  inbox.unread = account.unread;
  inbox.total = own.length;
}

export const summaries: MessageSummary[] = messages.map(
  ({ bodyHtml: _h, bodyText: _t, attachments: _a, headers: _hd, cc: _c, bcc: _b, replyTo: _r, inReplyTo: _i, references: _rf, hasBlockedRemoteContent: _bl, bodyError: _be, ...rest }) => rest,
);

/* ── Saved views ──────────────────────────────────────────────────────────── */

const baseQuery = {
  sort: 'date' as const,
  dir: 'desc' as const,
  group: 'date' as const,
  threaded: true,
  limit: 100,
  cursor: null,
  filters: {
    unreadOnly: false,
    flaggedOnly: false,
    hasAttachments: false,
    accountIds: [],
    domains: [],
    folderIds: [],
    priorities: [],
    labels: [],
    since: null,
    before: null,
  },
};

export const savedViews: SavedView[] = [
  {
    id: 'view_focus',
    name: 'Focus',
    glyph: 'F',
    color: null,
    pinned: true,
    position: 0,
    query: {
      ...baseQuery,
      scope: { kind: 'unified', value: null, role: 'inbox' },
      sort: 'priority',
      group: 'priority',
      filters: { ...baseQuery.filters, unreadOnly: true, priorities: ['critical', 'high'] },
    },
  },
  {
    id: 'view_flagged',
    name: 'Flagged',
    glyph: '★',
    color: null,
    pinned: true,
    position: 1,
    query: {
      ...baseQuery,
      scope: { kind: 'unified', value: null, role: null },
      group: 'account',
      filters: { ...baseQuery.filters, flaggedOnly: true },
    },
  },
  {
    id: 'view_receptive',
    name: 'Receptive',
    glyph: '♥',
    color: null,
    pinned: true,
    position: 2,
    query: {
      ...baseQuery,
      scope: { kind: 'unified', value: null, role: null },
      filters: { ...baseQuery.filters, labels: ['receptive'] },
    },
  },
];
