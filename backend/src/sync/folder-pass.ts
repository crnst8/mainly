/**
 * The sync a push asks for: one account, only the folders that changed.
 *
 * Two things push here. IMAP IDLE (sync/idle.ts) says the inbox changed; the
 * mail hook (sync/mail-hook.ts) says which mailboxes changed, any of them, and
 * whether the folder list did. Both want the same pass — replay, then the
 * envelopes of those folders, then arrivals, counts and threads — and the same
 * handling of bursts, so it lives here once.
 *
 * A full account pass (sync/engine.ts) re-reads every folder's status. This
 * does not: a notice about the inbox is not a reason to look at an archive of
 * forty thousand messages.
 */

import { claimAccount } from '../db/index.ts';
import type { Priority } from '../contract/types.ts';
import { withConnection, type AccountCredentials } from './pool.ts';
import { replayAccount } from './replay.ts';
import { handleArrivals } from './arrivals.ts';
import { syncEnvelopes } from './envelopes.ts';
import { syncFolders, refreshCounts, publishCounts } from './folders.ts';
import { refreshAccountThreads } from './threads.ts';
import { publish } from '../modules/events/bus.ts';
import { accountQueue } from './account-queue.ts';

export interface PassAccount {
  creds: AccountCredentials;
  userId: string;
  priority: Priority;
}

/** Collapse bursts: a delivery run can notify several times in a second, and
 *  a client moving fifty messages one at a time notifies fifty times. */
const DEBOUNCE_MS = 1_500;
/** A pass that failed for a reason other than credentials is tried once more
 *  after this long. Without it a failed pass is lost until the next poll, which
 *  for a pushed account is 15 minutes away. */
const RETRY_MS = 30_000;

/**
 * Coalesces requests for one account into passes.
 *
 * Folders asked for while a pass runs are remembered and fetched by the next
 * one, never dropped: the pass in flight may have read a mailbox before the
 * change that prompted the request landed in it.
 */
export class FolderPassScheduler {
  private paths = new Set<string>();
  private folders = false;
  private debounce: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** The pending request has already failed once. */
  private retried = false;
  private account: PassAccount;
  /** Prefixes log lines, so IDLE and hook passes can be told apart. */
  private source: string;

  // Assigned explicitly: type stripping cannot synthesise the assignments a
  // constructor parameter property implies. See the same note in idle.ts.
  constructor(account: PassAccount, source: string) {
    this.account = account;
    this.source = source;
  }

  /** Ask for a pass over these folders, and the folder list if `folders`. */
  request(paths: Iterable<string>, folders = false): void {
    if (this.stopped) return;
    for (const p of paths) this.paths.add(p);
    if (folders) this.folders = true;
    this.arm();
  }

  /** Replace the credentials and tier the next pass uses: a password change
   *  or retiering must not leave a long-lived scheduler on the old ones. */
  setAccount(account: PassAccount): void {
    this.account = account;
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private arm(delay = DEBOUNCE_MS): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run();
    }, delay);
  }

  /** Run one pass in the shared queue, so it counts against the process-wide
   *  bound on account work. */
  private queued(paths: string[], folders: boolean): Promise<boolean> {
    return new Promise((resolve, reject) => {
      accountQueue.enqueue(`pass:${this.account.creds.id}`, () =>
        runPass(this.account, paths, folders, this.source).then(resolve, reject),
      );
    });
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let paths: string[] = [];
    let folders = false;
    try {
      while (!this.stopped && (this.paths.size || this.folders)) {
        paths = [...this.paths];
        folders = this.folders;
        this.paths.clear();
        this.folders = false;
        const done = await this.queued(paths, folders);
        if (done) this.retried = false;
        if (!done) {
          // Another pass holds the account. Put the request back and try after
          // the debounce, by which time the holder has usually finished — and
          // may well have fetched these folders already, which costs nothing.
          for (const p of paths) this.paths.add(p);
          if (folders) this.folders = true;
          this.arm();
          return;
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      // Retry once, unless the server refused the login: retrying a refused
      // password on every notice is how a mailbox gets locked out.
      const retry = !this.retried && !/authenticat|credential|login/i.test(message);
      console.warn(
        { account: this.account.creds.address, err: message, retryInMs: retry ? RETRY_MS : null },
        `${this.source}-triggered sync failed`,
      );
      if (retry && !this.stopped) {
        this.retried = true;
        for (const p of paths) this.paths.add(p);
        if (folders) this.folders = true;
        this.arm(RETRY_MS);
      } else {
        this.retried = false;
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * One pass. False when the account is claimed elsewhere and nothing ran.
 *
 * IDLE, the hook and polling share one writer per account (the advisory lock).
 * Otherwise a stale fetch can land after replay removed the operation that
 * protected local flags.
 */
async function runPass(
  account: PassAccount,
  paths: string[],
  folders: boolean,
  source: string,
): Promise<boolean> {
  const { creds, userId, priority } = account;
  const claim = await claimAccount(creds.id);
  if (!claim) return false;
  try {
    const result = await withConnection(creds, async (client) => {
      await replayAccount(creds, client);
      // A new or renamed folder has no row yet, and a path with no row is
      // skipped by the envelope pass. List first so it has one.
      if (folders) await syncFolders(creds, client);
      if (!paths.length) return { indexed: 0, updated: 0, removed: 0 };
      const pass = await syncEnvelopes(creds, userId, priority, { folderPaths: paths, client });
      await handleArrivals(creds, userId, client, pass.arrivals);
      return pass;
    });
    if (folders || result.indexed || result.updated || result.removed) {
      await refreshCounts(creds.id);
      await refreshAccountThreads(creds.id);
      if (result.indexed || result.updated || result.removed) {
        publish(userId, { type: 'messages:changed', ids: [], patch: {} });
      }
      await publishCounts(userId, creds.id);
    }
    if (result.indexed || result.removed) {
      const { indexed, updated, removed } = result;
      console.log({ account: creds.address, folders: paths, indexed, updated, removed }, `${source} pass indexed changes`);
    }
    return true;
  } finally {
    await claim.release();
  }
}
