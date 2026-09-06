/**
 * Account creation — everything except the HTTP.
 *
 * The INSERT used to live in `routes.ts`, next to its two callers. It has a
 * third now: domain control, which creates an address on the mail server and at
 * that moment holds the one thing adding an account needs and can never ask for
 * afterwards — the password, in plaintext, once. Business logic here, transport
 * there, so `domains/service.ts` can reach it without importing Fastify.
 */

import { one } from '../../db/index.ts';
import { badRequest } from '../../lib/errors.ts';
import { seal } from '../../lib/crypto.ts';
import type { Priority, ServerConfig } from '../../contract/types.ts';
import { discover } from '../onboarding/autoconfig.ts';
import { verify } from '../onboarding/verify.ts';
import { syncNow } from '../../sync/engine.ts';

/** The one INSERT the wizard, the bulk import and domain control all go
 *  through, so the three cannot drift on defaults, sealing, or sidebar
 *  position. */
export async function insertAccount(
  userId: string,
  input: {
    address: string;
    password: string;
    label: string;
    displayName: string;
    priority: Priority;
    imap: ServerConfig;
    smtp: ServerConfig;
  },
): Promise<string> {
  const domain = input.address.split('@')[1];
  if (!domain) throw badRequest('Address has no domain part');

  const sealed = seal(input.password);

  const row = await one<{ id: string }>(
    `
    INSERT INTO accounts (
      user_id, address, domain, label, display_name, priority,
      imap_host, imap_port, imap_security,
      smtp_host, smtp_port, smtp_security, username,
      secret_ciphertext, secret_nonce, secret_tag, secret_key_version,
      status, position
    ) VALUES (
      $1, $2, $3, $4, $5, $6::priority_t,
      $7, $8, $9::security_t,
      $10, $11, $12::security_t, $13,
      $14, $15, $16, $17,
      'syncing',
      (SELECT coalesce(max(position) + 1, 0) FROM accounts WHERE user_id = $1)
    )
    RETURNING id
    `,
    [
      userId,
      input.address,
      domain,
      input.label || input.address,
      input.displayName,
      input.priority,
      input.imap.host,
      input.imap.port,
      input.imap.security,
      input.smtp.host,
      input.smtp.port,
      input.smtp.security,
      input.imap.username || input.address,
      sealed.ciphertext,
      sealed.nonce,
      sealed.tag,
      sealed.keyVersion,
    ],
  );
  return row!.id;
}

/** Added, already there, or the reason it is not. Never throws: the caller has
 *  already done something irreversible on the mail server, and a failure to
 *  link is not a failure to create. */
export interface LinkOutcome {
  accountId: string | null;
  error: string | null;
}

/**
 * A mailbox that exists on the server, added to this install.
 *
 * Discovery first, because the domain almost always has a sibling account
 * already syncing and nothing beats a configuration known to work; then the
 * same verify-before-store the wizard does, so a mailbox that cannot be signed
 * into never reaches the sidebar looking broken.
 *
 * The retry is for one specific case: this is called moments after the mail
 * server was told to create the address, and a server that has committed its
 * maps but not finished reloading answers the first login with a refusal that
 * is indistinguishable from a wrong password. One more attempt, a couple of
 * seconds later, is the difference between "added" and "add it yourself".
 *
 * `startSync: false` is for a process that cannot finish one — a CLI enqueues
 * into a queue that dies with it. The account is still added; the server it was
 * added beside picks it up on its next pass.
 */
export async function linkAddress(
  userId: string,
  address: string,
  password: string,
  options: { startSync?: boolean } = {},
): Promise<LinkOutcome> {
  try {
    const existing = await one<{ id: string }>(
      'SELECT id FROM accounts WHERE user_id = $1 AND lower(address) = lower($2)',
      [userId, address],
    );
    if (existing) return { accountId: existing.id, error: null };

    const config = await discover(address, userId);
    const input = { address, password, imap: config.imap, smtp: config.smtp };

    let result = await verify(input);
    if (!result.imap.ok) {
      await new Promise((resolve) => setTimeout(resolve, LINK_RETRY_MS));
      result = await verify(input);
    }
    if (!result.imap.ok) {
      return { accountId: null, error: result.imap.error ?? 'Could not sign in to the mail server' };
    }

    const accountId = await insertAccount(userId, {
      address,
      password,
      label: address,
      displayName: address.split('@')[0]!,
      priority: 'normal',
      imap: config.imap,
      smtp: config.smtp,
    });

    if (options.startSync ?? true) syncNow(userId, accountId);
    return { accountId, error: null };
  } catch (err) {
    return { accountId: null, error: (err as Error).message };
  }
}

/** Long enough for a `postfix reload` to finish, short enough that a genuinely
 *  wrong password still answers the request rather than a spinner. */
const LINK_RETRY_MS = 2000;
