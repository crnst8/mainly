/**
 * Thread assignment.
 *
 * IMAP `THREAD=REFERENCES` is optional and, worse, per-mailbox: it cannot see
 * that the reply landed in Archive or that the same conversation reached two of
 * your addresses. So we thread ourselves, at index time, into `thread_id`, and
 * every read after that is a plain equality lookup on an indexed column.
 *
 * Union-find over Message-ID / In-Reply-To / References, with a deliberately
 * narrow subject fallback for the clients that drop References. Threads are
 * resolved across the whole *user*, not one account: mail cc'd to two of your
 * own addresses is one conversation, and scoping this per account is how you get
 * the same thread twice in a unified view.
 */

import { query } from '../db/index.ts';

export interface Threadable {
  /** Cleaned, bracket-free, never empty — envelopes.ts synthesises one when the
   *  message has no Message-ID header at all. */
  messageId: string;
  inReplyTo: string | null;
  /** Root-first, as the header orders them. */
  references: string[];
  subjectNormalised: string;
  /** True when the subject carried a Re:/Fwd: prefix, or In-Reply-To is set.
   *  Gates the subject fallback — see below. */
  isReply: boolean;
  date: Date;
  /** Lowercase addresses: from, to, cc. Used only by the subject fallback. */
  participants: string[];
}

/* ── Union-find over id strings ────────────────────────────────────────────── */

class Sets {
  private parent = new Map<string, string>();

  /** Every id this structure has seen. Not the same as the ids the caller asked
   *  about: linking pulls in thread roots we never received. */
  keys(): Iterable<string> {
    return this.parent.keys();
  }

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)) root = this.parent.get(root)!;
    // Path compression, so a long reply chain does not degrade to a linked list.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/* ── Resolution ────────────────────────────────────────────────────────────── */

interface ExistingRow {
  message_id: string | null;
  thread_id: string;
}

/**
 * Resolve a `thread_id` for every message in `batch`.
 *
 * Returns a map keyed by `messageId`. Callers hold the batch, so a map is
 * cheaper than threading the value back through the row objects.
 */
export async function assignThreads(
  userId: string,
  batch: Threadable[],
): Promise<Map<string, string>> {
  const sets = new Sets();
  const byId = new Map<string, Threadable>();

  // 1. Link every message to everything it cites.
  for (const m of batch) {
    byId.set(m.messageId, m);
    sets.find(m.messageId);
    if (m.inReplyTo) sets.union(m.messageId, m.inReplyTo);
    for (const ref of m.references) sets.union(m.messageId, ref);
  }

  // 2. Pull in the threads those ids already belong to. Both directions matter:
  //    the cited id may be a message we have (message_id), or it may be the root
  //    of a thread whose root message we never received (thread_id).
  const mentioned = new Set<string>();
  for (const m of batch) {
    mentioned.add(m.messageId);
    if (m.inReplyTo) mentioned.add(m.inReplyTo);
    for (const ref of m.references) mentioned.add(ref);
  }

  const existingThreadIds = new Set<string>();
  if (mentioned.size) {
    const rows = await query<ExistingRow>(
      `SELECT DISTINCT m.message_id, m.thread_id
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
        WHERE a.user_id = $1
          AND (m.message_id = ANY($2::text[]) OR m.thread_id = ANY($2::text[]))`,
      [userId, [...mentioned]],
    );
    for (const r of rows) {
      existingThreadIds.add(r.thread_id);
      if (r.message_id) sets.union(r.message_id, r.thread_id);
      else sets.find(r.thread_id);
    }
  }

  // 3. Subject fallback, for Outlook and anything else that drops References.
  //
  //    Gated on `isReply`. A message with no References that is not a reply is a
  //    thread *start*, and merging those by subject is how "Your daily digest"
  //    becomes one thread with four hundred messages in it. Only a reply whose
  //    headers went missing needs rescuing.
  const orphans = batch.filter(
    (m) =>
      m.isReply &&
      !m.inReplyTo &&
      m.references.length === 0 &&
      m.subjectNormalised.length >= 6,
  );

  if (orphans.length) {
    const subjects = [...new Set(orphans.map((m) => m.subjectNormalised))];
    const candidates = await query<{
      subject_normalised: string;
      thread_id: string;
      date: Date;
      participants: string[];
    }>(
      `SELECT m.subject_normalised, m.thread_id, m.date,
              array_remove(
                array[m.from_address] ||
                array(SELECT jsonb_array_elements(m.to_addrs) ->> 'address') ||
                array(SELECT jsonb_array_elements(m.cc_addrs) ->> 'address'),
                NULL
              ) AS participants
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
        WHERE a.user_id = $1
          AND m.subject_normalised = ANY($2::text[])
          AND m.date > now() - interval '28 days'`,
      [userId, subjects],
    );

    const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
    for (const m of orphans) {
      for (const c of candidates) {
        if (c.subject_normalised !== m.subjectNormalised) continue;
        if (Math.abs(c.date.getTime() - m.date.getTime()) > WINDOW_MS) continue;
        // Same subject alone is a coincidence; same subject plus a shared
        // participant inside two weeks is a conversation.
        if (!c.participants.some((p) => m.participants.includes(p.toLowerCase()))) continue;
        existingThreadIds.add(c.thread_id);
        sets.union(m.messageId, c.thread_id);
        break;
      }
    }

    // The same rescue within the batch itself: a first sync sees the whole
    // broken chain at once, and none of it is in the database yet.
    for (let i = 0; i < orphans.length; i++) {
      for (let j = i + 1; j < orphans.length; j++) {
        const a = orphans[i]!;
        const b = orphans[j]!;
        if (a.subjectNormalised !== b.subjectNormalised) continue;
        if (Math.abs(a.date.getTime() - b.date.getTime()) > WINDOW_MS) continue;
        if (!a.participants.some((p) => b.participants.includes(p))) continue;
        sets.union(a.messageId, b.messageId);
      }
    }
  }

  // 4. Pick one canonical id per component.
  //
  //    An id that is already a thread_id always wins, so re-syncing never
  //    renumbers a thread the user is looking at. Otherwise the root as the
  //    References header names it — element zero is the root by definition —
  //    and failing that, the oldest message's own id.
  //    Iterated over every id the structure knows, not just the cited ones:
  //    linking to an existing message drags in that message's thread_id, and
  //    that id is the whole point — miss it and a reply to a live thread starts
  //    a second one beside it.
  const components = new Map<string, string[]>();
  for (const id of sets.keys()) {
    const root = sets.find(id);
    const members = components.get(root);
    if (members) members.push(id);
    else components.set(root, [id]);
  }

  const canonical = new Map<string, string>();
  for (const [root, members] of components) {
    const existing = members.filter((id) => existingThreadIds.has(id)).sort();
    if (existing.length) {
      canonical.set(root, existing[0]!);
      continue;
    }

    const present = members
      .map((id) => byId.get(id))
      .filter((m): m is Threadable => !!m)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const withRoot = present.find((m) => m.references.length > 0);
    canonical.set(root, withRoot?.references[0] ?? present[0]?.messageId ?? members.sort()[0]!);
  }

  const out = new Map<string, string>();
  for (const m of batch) out.set(m.messageId, canonical.get(sets.find(m.messageId)) ?? m.messageId);
  return out;
}
