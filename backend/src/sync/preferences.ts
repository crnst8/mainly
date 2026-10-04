/**
 * The owning user's preferences, as the sync worker sees them.
 *
 * Read per pass rather than cached: a setting turned off in the browser has to
 * stop the next pass, and one indexed row read per account per pass is cheaper
 * than any invalidation scheme that would make that true.
 */

import { one } from '../db/index.ts';
import { withPreferenceDefaults, type Preferences } from '../contract/types.ts';

export async function preferencesOf(accountId: string): Promise<Preferences> {
  const row = await one<{ data: Partial<Preferences> | null }>(
    `SELECT p.data FROM accounts a LEFT JOIN preferences p ON p.user_id = a.user_id
      WHERE a.id = $1`,
    [accountId],
  );
  return withPreferenceDefaults(row?.data);
}
