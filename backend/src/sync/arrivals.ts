/**
 * What happens to mail after the envelope pass first indexes it.
 *
 * Three things, in order: spam the server marked is filed into Junk, inbox
 * mail the user's filter claims is filed into Filtered, and what is left is
 * offered to notifications. Filing goes first so that a filed message never
 * notifies — the order is the whole reason all three live here.
 *
 * Filing is the same local move and queued `sync_ops` row a click produces
 * (see filing.ts). A message the user later moves back out keeps its row and
 * its id through that move, so the next pass sees an update, not an arrival,
 * and does not file it again.
 */

import type { ImapFlow } from 'imapflow';
import type { Preferences } from '../contract/types.ts';
import { notifyArrivals } from '../push/notify.ts';
import { decide, fileDecisions } from '../filter/decide.ts';
import { filterRows } from '../filter/model.ts';
import { fileByRole } from './filing.ts';
import { replayAccount } from './replay.ts';
import { preferencesOf } from './preferences.ts';
import type { AccountCredentials } from './pool.ts';
import type { Arrival } from './envelopes.ts';

export async function handleArrivals(
  creds: AccountCredentials,
  userId: string,
  client: ImapFlow,
  arrivals: readonly Arrival[],
): Promise<{ filed: number }> {
  if (!arrivals.length) return { filed: 0 };
  const prefs = await preferencesOf(creds.id);
  const moved = new Set<string>();

  const spam = spamFilterApplies(prefs, creds.id)
    ? arrivals.filter((a) => a.spam && a.role === 'inbox').map((a) => a.id)
    : [];
  if (spam.length) {
    const junked = await fileByRole(userId, creds.id, spam, 'junk');
    for (const id of junked) moved.add(id);
    if (junked.length) console.log({ account: creds.address, filed: junked.length }, 'filed server-marked spam into Junk');
  }

  if (filterApplies(prefs, creds.id)) {
    const inbox = arrivals.filter((a) => a.role === 'inbox' && !a.spam && !moved.has(a.id));
    // A failing filter must not cost the user their notifications, or the
    // rest of the pass; the mail stays in the inbox, which is where it was.
    const filtered = await fileFiltered(userId, creds.id, prefs, inbox).catch((err: Error) => {
      console.warn({ account: creds.address, err: err.message }, 'filter skipped');
      return [] as string[];
    });
    for (const id of filtered) moved.add(id);
    if (filtered.length) console.log({ account: creds.address, filed: filtered.length }, 'filed into Filtered');
  }

  if (moved.size) {
    // Tell the server now rather than on the next pass, so other clients
    // stop showing it in the inbox within the same second.
    await replayAccount(creds, client).catch((err: Error) => {
      console.warn({ account: creds.address, err: err.message }, 'filing replay deferred');
    });
  }

  await notifyArrivals(
    userId,
    creds.id,
    arrivals.filter((a) => !moved.has(a.id) && !a.spam),
    prefs,
  ).catch((err: Error) => {
    console.warn({ account: creds.address, err: err.message }, 'new-mail notification failed');
  });
  return { filed: moved.size };
}

function spamFilterApplies(prefs: Preferences, accountId: string): boolean {
  return prefs.mailHandling.spamFilter && !prefs.mailHandling.spamFilterExcluded.includes(accountId);
}

function filterApplies(prefs: Preferences, accountId: string): boolean {
  return prefs.filtering.enabled && !prefs.filtering.excluded.includes(accountId);
}

async function fileFiltered(
  userId: string,
  accountId: string,
  prefs: Preferences,
  arrivals: readonly Arrival[],
): Promise<string[]> {
  if (!arrivals.length) return [];
  const fresh = new Map(arrivals.map((a) => [a.id, a.fresh]));
  const rows = await filterRows(
    userId,
    arrivals.map((a) => a.id),
  );
  const decisions = await decide(
    userId,
    prefs.filtering,
    rows.map((row) => ({ row, fresh: fresh.get(row.id) ?? false })),
  );
  return fileDecisions(userId, accountId, decisions);
}
