/**
 * Acting on a mail hook's notice: fetch the folders it named.
 *
 * modules/hooks/service.ts has already decided the notice is genuine. This
 * finds the accounts it is about — the login, on one of the hook's hosts — and
 * asks each one's scheduler for a pass over those mailboxes. The scheduler
 * coalesces bursts and shares the account lock with polling and IDLE, so a
 * notice can never race another writer.
 *
 * Runs in whichever process received the HTTP request, as a manual refresh
 * does (`syncNow` in engine.ts). The advisory lock is what keeps that safe
 * when sync runs elsewhere too.
 */

import { query } from '../db/index.ts';
import type { Priority } from '../contract/types.ts';
import type { HookNotice, MailHook } from '../modules/hooks/service.ts';
import { FolderPassScheduler } from './folder-pass.ts';

interface NoticeAccount {
  id: string;
  user_id: string;
  address: string;
  priority: Priority;
  imap_host: string;
  imap_port: number;
  imap_security: 'tls' | 'starttls' | 'none';
  username: string;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_key_version: number;
}

/** One per account that has had a notice. Bounded by the number of accounts. */
const schedulers = new Map<string, FolderPassScheduler>();

/**
 * Accounts a notice is about.
 *
 * The login is matched against both the username and the address, ignoring
 * case: Dovecot reports the login after its own normalisation
 * (`auth_username_format`), which may lower-case it, and an account here may
 * log in with either form. Only accounts whose last sync worked: one whose
 * password is being refused must not be retried on every notice, which is how
 * a mailbox gets locked out.
 */
export async function accountsForNotice(hook: MailHook, login: string): Promise<NoticeAccount[]> {
  return query<NoticeAccount>(
    `SELECT id, user_id, address, priority,
            imap_host, imap_port, imap_security, username,
            secret_ciphertext, secret_nonce, secret_tag, secret_key_version
       FROM accounts
      WHERE lower(imap_host) = ANY($1::text[])
        AND (lower(username) = lower($2) OR lower(address) = lower($2))
        AND status IN ('ok', 'syncing')`,
    [hook.hosts, login],
  );
}

/** Schedule passes for a notice. Returns how many accounts it concerned. */
export async function receiveNotice(hook: MailHook, notice: HookNotice): Promise<number> {
  const accounts = await accountsForNotice(hook, notice.user);
  for (const row of accounts) {
    const account = {
      creds: {
        id: row.id,
        address: row.address,
        imapHost: row.imap_host,
        imapPort: row.imap_port,
        imapSecurity: row.imap_security,
        username: row.username,
        secretCiphertext: row.secret_ciphertext,
        secretNonce: row.secret_nonce,
        secretTag: row.secret_tag,
        secretKeyVersion: row.secret_key_version,
      },
      userId: row.user_id,
      priority: row.priority,
    };
    let scheduler = schedulers.get(row.id);
    if (scheduler) scheduler.setAccount(account);
    else {
      scheduler = new FolderPassScheduler(account, 'hook');
      schedulers.set(row.id, scheduler);
    }
    scheduler.request(notice.mailboxes, notice.folders);
  }
  return accounts.length;
}

export function stopMailHook(): void {
  for (const s of schedulers.values()) s.stop();
  schedulers.clear();
}
