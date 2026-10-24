/**
 * What the filter looks at in a message.
 *
 * Only what the index already holds: sender, recipients, subject, the 200
 * character preview, and the list headers the envelope pass reads. No body
 * fetch, so classifying an arrival costs no IMAP round trip and the filter
 * works the same on a message whose body was never downloaded.
 *
 * Each feature is a short string with a prefix saying what it is, so a word
 * in a subject and the same word in a sender's name are different evidence.
 * The set is deliberately small and literal: the classifier is fitted per user
 * on a few hundred examples, where a handful of strong signals (who sent it,
 * whether it was mailed to a list, whether you were addressed directly)
 * outweigh any amount of vocabulary.
 */

import type { Addr } from '../contract/types.ts';

export interface FilterInput {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  preview: string;
  listId: string | null;
  bulk: boolean;
  to: Addr[];
  cc: Addr[];
  /** The mailbox's own address, to tell direct mail from a blind copy. */
  account: string;
  hasAttachments: boolean;
}

/** Shared local parts that say "this address is a system, not a person". */
const ROLE_LOCALPART =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|news(letter)?s?|marketing|promo(tions)?|offers?|deals|hello|hi|info|team|updates?|digest|mailer|bounces?|support|billing|receipts?|orders?|shop|store|community|events?|feedback|survey)([-_.+].*)?$/;

/** Second-level labels under which the registrable name is one further left,
 *  e.g. example.co.uk. Not the public suffix list, which would be a dependency
 *  for a feature that only has to group a sender's subdomains together. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'ne', 'or', 'go']);

/** Too common to say anything about one sender's mail versus another's. */
const STOPWORDS = new Set(
  `the and for you your with this that from are was were have has had not but all any can our out
  its it's into about will would there their them they what when where which who how more new now
  just get got one two off per via than then also only been being over very here see may please
  thanks thank dear hello re fw fwd`
    .split(/\s+/)
    .filter(Boolean),
);

const MAX_SUBJECT_WORDS = 12;
const MAX_PREVIEW_WORDS = 30;

export function featuresOf(m: FilterInput): string[] {
  const out = new Set<string>();
  const address = m.fromAddress.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  const local = at > 0 ? address.slice(0, at) : address;
  const domain = at > 0 ? address.slice(at + 1) : '';

  if (address) out.add(`from:${address}`);
  if (domain) {
    out.add(`domain:${domain}`);
    const org = organisation(domain);
    if (org !== domain) out.add(`org:${org}`);
  }
  if (ROLE_LOCALPART.test(local)) {
    out.add('local:role');
    out.add(`local:${local.split(/[-_.+]/)[0]}`);
  }

  if (m.listId) out.add(`list:${m.listId}`);
  out.add(m.bulk ? 'bulk' : 'personal');

  // How the mailbox was addressed. Mail sent to you by name is the strongest
  // "keep" signal there is; mail where you are in neither To nor Cc reached
  // you through a list or a blind copy.
  const me = m.account.trim().toLowerCase();
  if (m.to.some((a) => a.address.toLowerCase() === me)) out.add('to:direct');
  else if (m.cc.some((a) => a.address.toLowerCase() === me)) out.add('to:cc');
  else out.add('to:hidden');
  const recipients = m.to.length + m.cc.length;
  if (recipients > 5) out.add('to:many');

  if (/^\s*(re|aw|sv|antw)\s*:/i.test(m.subject)) out.add('reply');
  if (/^\s*(fwd?|wg|tr)\s*:/i.test(m.subject)) out.add('forward');
  if (m.hasAttachments) out.add('attach');

  // Promotional tells: prices, percentages, shouting, emoji. Each is weak on
  // its own; the classifier learns how much each one is worth for this user.
  const text = `${m.subject} ${m.preview}`;
  if (/[$€£¥]\s?\d|\d+\s?%|\bfree\b/i.test(text)) out.add('money');
  if (/\p{Extended_Pictographic}/u.test(m.subject)) out.add('emoji');
  if (/\b[A-Z]{4,}\b.*\b[A-Z]{4,}\b/.test(m.subject)) out.add('caps');

  for (const w of words(m.fromName ?? '', 4)) out.add(`name:${w}`);
  for (const w of words(m.subject, MAX_SUBJECT_WORDS)) out.add(`s:${w}`);
  for (const w of words(m.preview, MAX_PREVIEW_WORDS)) out.add(`p:${w}`);
  return [...out];
}

/** The part of a domain an organisation registers: mail.example.com and
 *  news.example.com are both example.com. */
export function organisation(domain: string): string {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const take = SECOND_LEVEL.has(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Distinct lower-cased words, in order, without numbers or stopwords. */
function words(text: string, max: number): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}'’-]*/gu)) {
    const w = match[0].replace(/['’-]+$/, '');
    if (w.length < 3 || w.length > 24 || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The rule key for a message: its list when it has one, otherwise its sender.
 *
 * A list is the better key whenever there is one. One address often sends
 * several kinds of mail — a code host sends review requests and marketing from
 * the same `noreply` — and the List-Id is what tells them apart, so filtering
 * one list does not take the others with it.
 */
export function ruleKey(m: { fromAddress: string; listId: string | null }): {
  kind: 'sender' | 'list';
  value: string;
} {
  return m.listId
    ? { kind: 'list', value: m.listId }
    : { kind: 'sender', value: m.fromAddress.trim().toLowerCase() };
}
