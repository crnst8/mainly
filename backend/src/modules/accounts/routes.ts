/**
 * Account CRUD and onboarding endpoints.
 *
 * The credential never leaves this module in plaintext: it arrives on the
 * request, is verified, is sealed, and the row that goes to the database has
 * only ciphertext. No SELECT in this file lists the secret columns.
 */

import type { FastifyInstance } from 'fastify';
import { one, query } from '../../db/index.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { seal } from '../../lib/crypto.ts';
import type {
  Account,
  BulkAccountInput,
  BulkOnboardInput,
  BulkOnboardResult,
  BulkOnboardRow,
  Priority,
  ServerConfig,
  ServerTemplate,
} from '../../contract/types.ts';
import { discover } from '../onboarding/autoconfig.ts';
import { verify, type VerifyInput } from '../onboarding/verify.ts';
import { syncNow } from '../../sync/engine.ts';

/** Columns safe to return. The secret_* columns are absent on purpose. */
const PUBLIC_COLUMNS = `
  a.id, a.address, a.domain, a.label, a.display_name, a.priority, a.status,
  a.color, a.hidden, a.signature, a.position, a.last_sync_at, a.error,
  coalesce(c.unread, 0)::int AS unread,
  coalesce(c.total, 0)::int  AS total
`;

const WITH_COUNTS = `
  FROM accounts a
  LEFT JOIN LATERAL (
    SELECT sum(unread)::int AS unread, sum(total)::int AS total
      FROM folders WHERE account_id = a.id
  ) c ON true
`;

interface AccountRow {
  id: string;
  address: string;
  domain: string;
  label: string;
  display_name: string;
  priority: Priority;
  status: Account['status'];
  color: string | null;
  hidden: boolean;
  signature: string | null;
  position: number;
  last_sync_at: Date | null;
  error: string | null;
  unread: number;
  total: number;
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  address: r.address,
  domain: r.domain,
  label: r.label,
  displayName: r.display_name,
  priority: r.priority,
  status: r.status,
  color: r.color,
  hidden: r.hidden,
  unread: r.unread,
  total: r.total,
  lastSyncAt: r.last_sync_at?.toISOString() ?? null,
  error: r.error,
  signature: r.signature,
  position: r.position,
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', async (req) => {
    const rows = await query<AccountRow>(
      `SELECT ${PUBLIC_COLUMNS} ${WITH_COUNTS} WHERE a.user_id = $1 ORDER BY a.position, a.address`,
      [req.userId],
    );
    return rows.map(toAccount);
  });

  app.patch<{ Params: { id: string }; Body: Partial<Account> }>(
    '/accounts/:id',
    async (req) => {
      const patch = req.body;
      const sets: string[] = [];
      const values: unknown[] = [req.userId, req.params.id];
      const bind = (v: unknown) => `$${values.push(v)}`;

      // Explicit allow-list. A generic patch loop here would let a client set
      // secret_ciphertext or user_id.
      if (patch.label !== undefined) sets.push(`label = ${bind(patch.label)}`);
      if (patch.displayName !== undefined) sets.push(`display_name = ${bind(patch.displayName)}`);
      if (patch.priority !== undefined) sets.push(`priority = ${bind(patch.priority)}::priority_t`);
      if (patch.color !== undefined) sets.push(`color = ${bind(patch.color)}`);
      if (patch.hidden !== undefined) sets.push(`hidden = ${bind(patch.hidden)}`);
      if (patch.signature !== undefined) sets.push(`signature = ${bind(patch.signature)}`);
      if (patch.position !== undefined) sets.push(`position = ${bind(patch.position)}`);
      if (!sets.length) throw badRequest('Nothing to update');

      const updated = await one<{ id: string }>(
        `UPDATE accounts SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2 RETURNING id`,
        values,
      );
      if (!updated) throw notFound('Account');

      // Priority is denormalised onto messages so the list sort stays
      // index-only. Keep it in step. See docs/architecture.md.
      if (patch.priority !== undefined) {
        await query(
          `UPDATE messages SET priority = $2::priority_t WHERE account_id = $1 AND priority <> $2::priority_t`,
          [req.params.id, patch.priority],
        );
      }

      const row = await one<AccountRow>(
        `SELECT ${PUBLIC_COLUMNS} ${WITH_COUNTS} WHERE a.user_id = $1 AND a.id = $2`,
        [req.userId, req.params.id],
      );
      return toAccount(row!);
    },
  );

  /**
   * Replace a mailbox password.
   *
   * The one repair this application must offer. A mailbox password changes, or is
   * mistyped during a bulk import, and the account lands in `auth_error` — and
   * until this existed, the sidebar's "fix credentials" affordance opened a
   * settings page with no field to fix them in. Forty-five mailboxes means this
   * happens regularly.
   *
   * Server settings are reused from the stored row rather than re-sent by the
   * client: this is a credential repair, not a reconfiguration, and accepting
   * hosts here would make it a second SSRF surface for no reason.
   */
  app.put<{ Params: { id: string }; Body: { password: string } }>(
    '/accounts/:id/password',
    // Handles a plaintext mailbox password, so a person has to be present for
    // it. An API token cannot reach this however it is scoped.
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' }, sessionOnly: true } },
    async (req) => {
      const password = req.body?.password;
      if (!password) throw badRequest('A password is required');

      const row = await one<{
        address: string;
        username: string;
        imap_host: string;
        imap_port: number;
        imap_security: 'tls' | 'starttls' | 'none';
        smtp_host: string;
        smtp_port: number;
        smtp_security: 'tls' | 'starttls' | 'none';
      }>(
        `SELECT address, username, imap_host, imap_port, imap_security,
                smtp_host, smtp_port, smtp_security
           FROM accounts WHERE user_id = $1 AND id = $2`,
        [req.userId, req.params.id],
      );
      if (!row) throw notFound('Account');

      // Verify before storing, exactly as account creation does. Sealing an
      // unverified password just moves the failure to the next sync pass.
      const result = await verify({
        address: row.address,
        password,
        imap: {
          host: row.imap_host,
          port: row.imap_port,
          security: row.imap_security,
          username: row.username,
        },
        smtp: {
          host: row.smtp_host,
          port: row.smtp_port,
          security: row.smtp_security,
          username: row.username,
        },
      });
      if (!result.imap.ok) {
        throw badRequest(result.imap.error ?? 'The server rejected that password', result);
      }

      const sealed = seal(password);
      await query(
        `UPDATE accounts
            SET secret_ciphertext = $3, secret_nonce = $4, secret_tag = $5,
                secret_key_version = $6,
                -- Back to work: the stored error described the old password.
                status = 'syncing', error = NULL
          WHERE user_id = $1 AND id = $2`,
        [
          req.userId,
          req.params.id,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
          sealed.keyVersion,
        ],
      );

    syncNow(req.userId, req.params.id);

      const updated = await one<AccountRow>(
        `SELECT ${PUBLIC_COLUMNS} ${WITH_COUNTS} WHERE a.user_id = $1 AND a.id = $2`,
        [req.userId, req.params.id],
      );
      return toAccount(updated!);
    },
  );

  // Removing an account is not something an agent should be able to do while
  // sorting mail, whatever it has been asked to tidy up.
  app.delete<{ Params: { id: string } }>('/accounts/:id', { config: { sessionOnly: true } }, async (req, reply) => {
    const deleted = await one<{ id: string }>(
      'DELETE FROM accounts WHERE user_id = $1 AND id = $2 RETURNING id',
      [req.userId, req.params.id],
    );
    if (!deleted) throw notFound('Account');
    return reply.code(204).send();
  });

  app.post<{ Body: { ids: string[] } }>('/accounts/reorder', async (req, reply) => {
    await query(
      `UPDATE accounts SET position = idx.i
         FROM unnest($2::uuid[]) WITH ORDINALITY AS idx(id, i)
        WHERE accounts.id = idx.id AND accounts.user_id = $1`,
      [req.userId, req.body.ids],
    );
    return reply.code(204).send();
  });

  /* ── Onboarding ─────────────────────────────────────────────────────────── */

  app.get<{ Querystring: { address: string } }>('/onboarding/autoconfig', async (req) => {
    const address = req.query.address?.trim();
    if (!address?.includes('@')) throw badRequest('A full email address is required');
    return discover(address, req.userId);
  });

  app.post<{ Body: VerifyInput }>(
    '/onboarding/verify',
    // Makes outbound connections on user-supplied input. Rate limited hard, and
    // closed to tokens: the body carries a plaintext mailbox password.
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' }, sessionOnly: true } },
    async (req) => verify(req.body),
  );

  app.post<{
    Body: VerifyInput & { displayName: string; label: string; priority: Priority };
  }>('/accounts', { config: { sessionOnly: true } }, async (req, reply) => {
    const b = req.body;

    // Verify before storing. An account that cannot connect is worse than no
    // account: it sits in the sidebar looking broken.
    const result = await verify(b);
    if (!result.imap.ok) {
      throw badRequest(result.imap.error ?? 'Could not sign in to the mail server', result);
    }

    const id = await insertAccount(req.userId, {
      address: b.address,
      password: b.password,
      label: b.label,
      displayName: b.displayName,
      priority: b.priority,
      imap: b.imap,
      smtp: b.smtp,
    });

    // Kick off the first sync immediately; the wizard's final screen watches
    // the SSE stream for progress.
    syncNow(req.userId, id);

    const created = await one<AccountRow>(
      `SELECT ${PUBLIC_COLUMNS} ${WITH_COUNTS} WHERE a.id = $1`,
      [id],
    );
    return reply.code(201).send(toAccount(created!));
  });

  /**
   * Bulk import.
   *
   * Verify-then-create, per row, independently. Partial success is the whole
   * point: one mistyped password out of forty must not discard the thirty-nine
   * that worked, so this answers 200 with a row-by-row outcome and never fails
   * the request as a whole.
   *
   * Rows run with bounded concurrency. Sequential means a forty-five mailbox
   * import takes as long as forty-five IMAP handshakes end to end. Unbounded
   * means opening forty-five simultaneous connections to a server that limits
   * connections per IP, which fails in a way that reads like bad credentials.
   *
   * Rate limited like `/onboarding/verify` — it opens outbound connections to
   * user-supplied hostnames and is the same SSRF surface — but counted per
   * request rather than per mailbox, since one request covering many is the
   * feature.
   */
  app.post<{ Body: BulkOnboardInput }>(
    '/accounts/bulk',
    { config: { rateLimit: { max: 40, timeWindow: '1 hour' }, sessionOnly: true } },
    async (req) => {
      const { imap, smtp, accounts } = req.body ?? {};
      if (!imap?.hostTemplate || !smtp?.hostTemplate) {
        throw badRequest('Both an IMAP and an SMTP host are required');
      }
      if (!accounts?.length) throw badRequest('No mailboxes to add');
      if (accounts.length > MAX_BULK_ROWS) {
        throw badRequest(`At most ${MAX_BULK_ROWS} mailboxes per request`);
      }

      const rows: BulkOnboardRow[] = [];
      let anyCreated = false;

      for (let i = 0; i < accounts.length; i += BULK_CONCURRENCY) {
        const settled = await Promise.all(
          accounts.slice(i, i + BULK_CONCURRENCY).map((row) => addOne(req.userId, row, imap, smtp)),
        );
        for (const r of settled) {
          rows.push(r);
          if (r.accountId) anyCreated = true;
        }
      }

      // One trigger for the batch, not one per account: forty-five simultaneous
      // claims would spend the whole import queueing behind the connection pool.
    if (anyCreated) syncNow(req.userId);

      return { rows } satisfies BulkOnboardResult;
    },
  );
}

/** Mailboxes verified at once. Four is quick and stays well under Dovecot's
 *  `mail_max_userip_connections`, which an unbounded fan-out would trip. */
const BULK_CONCURRENCY = 4;
/** Rows per request. The client chunks to well under this; the cap is here so a
 *  hand-made request cannot hold a connection open for ten minutes. */
const MAX_BULK_ROWS = 100;

/** Substitute `{domain}` when the template has it; otherwise the host is literal
 *  and used for every row. */
const resolveHostTemplate = (template: string, domain: string): string =>
  template.includes('{domain}') ? template.replaceAll('{domain}', domain) : template;

/** Verified and created, or the reason it was not. Never throws: the caller owes
 *  an outcome for every row, including the bad ones. */
async function addOne(
  userId: string,
  row: BulkAccountInput,
  imapTemplate: ServerTemplate,
  smtpTemplate: ServerTemplate,
): Promise<BulkOnboardRow> {
  const address = row.address?.trim().toLowerCase() ?? '';
  const fail = (error: string): BulkOnboardRow => ({
    address,
    ok: false,
    accountId: null,
    error,
    smtpWarning: null,
  });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return fail('Not a valid email address');
  if (!row.password) return fail('No password given');
  const domain = address.split('@')[1]!;

  const imap = {
    host: resolveHostTemplate(imapTemplate.hostTemplate, domain),
    port: imapTemplate.port,
    security: imapTemplate.security,
    username: address,
  };
  const smtp = {
    host: resolveHostTemplate(smtpTemplate.hostTemplate, domain),
    port: smtpTemplate.port,
    security: smtpTemplate.security,
    username: address,
  };

  try {
    const result = await verify({ address, password: row.password, imap, smtp });
    if (!result.imap.ok) return fail(result.imap.error ?? 'Could not sign in');

    const id = await insertAccount(userId, {
      address,
      password: row.password,
      label: row.label ?? address,
      displayName: row.displayName ?? address.split('@')[0]!,
      priority: row.priority ?? 'normal',
      imap,
      smtp,
    });

    return {
      address,
      ok: true,
      accountId: id,
      error: null,
      // IMAP works, so the mailbox reads. Sending will fail until this is fixed,
      // which is worth saying now rather than when someone first hits send.
      smtpWarning: result.smtp.ok ? null : (result.smtp.error ?? 'SMTP check failed'),
    };
  } catch (err) {
    const message = (err as Error).message;
    // Already added is a mistake, not a failure. Say which.
    if (/duplicate key/.test(message)) return fail('This mailbox has already been added');
    return fail(message);
  }
}

/** The one INSERT both the wizard and the bulk import go through, so the two
 *  cannot drift on defaults, sealing, or sidebar position. */
async function insertAccount(
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
