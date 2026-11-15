/**
 * The one bound on concurrent account work in this process.
 *
 * Every account pass holds a database connection for its advisory lock and an
 * IMAP connection while it runs. Polling (engine.ts), IDLE and the mail hook
 * (folder-pass.ts) all go through this queue, so together they never use more
 * than `SYNC_MAX_CONCURRENT_ACCOUNTS` database connections and the rest of the
 * pool stays free for API requests. Before folder passes shared it, IDLE on
 * every account meant every watcher's catch-up pass started at once on boot
 * and drained the pool.
 *
 * Keys: the account id for a full pass, `pass:<id>` for a folder pass, so a
 * folder pass never replaces a pending full one. The account lock still
 * serialises the two.
 */

import { config } from '../config.ts';
import { KeyedWorkQueue } from './work-queue.ts';

export const accountQueue = new KeyedWorkQueue(config.sync.maxConcurrentAccounts, (key, err) => {
  console.error({ key, err: err.message }, 'queued account sync failed');
});
