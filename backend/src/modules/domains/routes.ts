/**
 * Domain control endpoints.
 *
 * The SSH key never leaves this module in plaintext: it arrives on the request,
 * is sealed, and no SELECT that serves a response names the secret columns.
 * Same rule, and for the same reason, as accounts/routes.ts.
 *
 * Two access decisions are made here rather than in the service:
 *
 *  - **`sessionOnly` on anything that handles the key.** An API token may
 *    create an address; it may never install, replace, or exercise the
 *    credential that would let it grant itself more. Minting a token already
 *    requires shell on the host, and this keeps a stolen one from widening its
 *    own reach.
 *  - **`scope: 'provision'`** on the routes that change the mail server, so an
 *    agent that files and flags mail cannot also mint addresses.
 */

import type { FastifyInstance } from 'fastify';
import { badRequest } from '../../lib/errors.ts';
import { MIN_APP_PASSWORD } from '../../contract/types.ts';
import { DOMAIN_RE, LOCALPART_RE } from './grants.ts';
import {
  addAlias,
  connectDomain,
  createMailbox,
  disconnectDomain,
  getDomain,
  listAliases,
  listDomains,
  listMailboxes,
  listOps,
  probeDomain,
  readHostKey,
  removeAlias,
  removeMailbox,
  setMailboxPassword,
  updateDomain,
  type Actor,
} from './service.ts';

/** `req.actor` carries more than the audit trail needs. Narrowed here so the
 *  service takes the smallest thing that answers "who did this". */
const actorOf = (req: { actor: { kind: 'session' } | { kind: 'token'; name: string } }): Actor =>
  req.actor.kind === 'session' ? { kind: 'session' } : { kind: 'token', name: req.actor.name };

function localpart(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!LOCALPART_RE.test(value)) {
    throw badRequest(
      'The part before the @ may use lowercase letters, digits, dot, underscore, plus and ' +
        'hyphen, and must start and end with a letter or digit.',
    );
  }
  return value;
}

/**
 * A full address, both halves validated.
 *
 * The alias target used to be checked only for containing an `@`. The helper
 * would still have refused anything malformed — every token it receives is
 * matched against a character class before it is looked at — so nothing got
 * through. But leaving it to the far end means the guarantee lives in a POSIX
 * shell script on another machine, and the next driver to be written would have
 * to rediscover that it needs one. Validate what we send.
 */
function address(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const at = value.indexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (at === -1 || !LOCALPART_RE.test(local) || !DOMAIN_RE.test(domain)) {
    throw badRequest(`'${value}' is not an address this can forward to. Use user@domain.`);
  }
  return value;
}

/** The floor the mail server's helper also enforces. Checked here so the
 *  message is a sentence rather than a relayed refusal. */
function mailboxPassword(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  if (value.length < MIN_APP_PASSWORD) {
    throw badRequest(`A mailbox password needs at least ${MIN_APP_PASSWORD} characters.`);
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw badRequest('A mailbox password cannot contain a line break.');
  }
  return value;
}

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  /* ── Configuration ─────────────────────────────────────────────────────── */

  app.get('/domains', async (req) => listDomains(req.userId));

  app.get<{ Params: { id: string } }>('/domains/:id', async (req) =>
    getDomain(req.userId, req.params.id),
  );

  app.post<{
    Body: {
      domain?: string;
      driver?: string;
      host?: string;
      port?: number;
      user?: string;
      hostKey?: string | null;
      privateKey?: string;
    };
  }>('/domains', { config: { sessionOnly: true } }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.domain || !b.host || !b.privateKey) {
      throw badRequest('A domain, a host, and a private key are all required.');
    }
    const created = await connectDomain(req.userId, {
      domain: b.domain,
      driver: b.driver ?? 'ssh',
      host: b.host,
      port: b.port,
      user: b.user,
      hostKey: b.hostKey ?? null,
      privateKey: b.privateKey,
    });
    return reply.code(201).send(created);
  });

  app.patch<{
    Params: { id: string };
    Body: {
      grants?: string[];
      host?: string;
      port?: number;
      user?: string;
      hostKey?: string | null;
      privateKey?: string;
    };
  }>('/domains/:id', { config: { sessionOnly: true } }, async (req) =>
    updateDomain(req.userId, req.params.id, req.body ?? {}),
  );

  app.delete<{ Params: { id: string } }>(
    '/domains/:id',
    { config: { sessionOnly: true } },
    async (req, reply) => {
      // App-side only. No address and no mail is touched by this.
      await disconnectDomain(req.userId, req.params.id);
      return reply.code(204).send();
    },
  );

  /**
   * Read a host's SSH key so it can be pinned.
   *
   * The one unauthenticated moment in the whole flow, which is why it is a
   * visible step someone approves rather than trust-on-first-use hidden inside
   * the first real connection. Session only: it makes an outbound connection to
   * a hostname the caller supplies.
   */
  app.post<{ Body: { host?: string; port?: number } }>(
    '/domains/host-key',
    { config: { sessionOnly: true } },
    async (req) => {
      const host = req.body?.host?.trim();
      if (!host) throw badRequest('A host is required');
      return { hostKey: await readHostKey(host, req.body?.port ?? 22) };
    },
  );

  /* ── Probe ─────────────────────────────────────────────────────────────── */

  // A POST that only reads, so the scope is declared rather than inferred from
  // the verb — the same case `/messages/query` makes.
  app.post<{ Params: { id: string } }>(
    '/domains/:id/probe',
    { config: { scope: 'read' } },
    async (req) => probeDomain(req.userId, req.params.id, actorOf(req)),
  );

  /* ── Mailboxes ─────────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>('/domains/:id/mailboxes', async (req) =>
    listMailboxes(req.userId, req.params.id),
  );

  app.post<{ Params: { id: string }; Body: { localpart?: string; password?: string } }>(
    '/domains/:id/mailboxes',
    { config: { scope: 'provision' } },
    async (req, reply) => {
      const created = await createMailbox(
        req.userId,
        req.params.id,
        { localpart: localpart(req.body?.localpart), password: mailboxPassword(req.body?.password) },
        actorOf(req),
      );
      return reply.code(201).send(created);
    },
  );

  app.delete<{ Params: { id: string; localpart: string }; Querystring: { purge?: string } }>(
    '/domains/:id/mailboxes/:localpart',
    { config: { scope: 'provision' } },
    async (req, reply) => {
      await removeMailbox(
        req.userId,
        req.params.id,
        {
          localpart: localpart(req.params.localpart),
          // Opt-in, and spelled out. Anything other than an explicit `true`
          // keeps the mail.
          purge: req.query.purge === 'true',
        },
        actorOf(req),
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string; localpart: string }; Body: { password?: string } }>(
    '/domains/:id/mailboxes/:localpart/password',
    { config: { scope: 'provision' } },
    async (req, reply) => {
      await setMailboxPassword(
        req.userId,
        req.params.id,
        {
          localpart: localpart(req.params.localpart),
          password: mailboxPassword(req.body?.password),
        },
        actorOf(req),
      );
      return reply.code(204).send();
    },
  );

  /* ── Aliases ───────────────────────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>('/domains/:id/aliases', async (req) =>
    listAliases(req.userId, req.params.id),
  );

  app.post<{ Params: { id: string }; Body: { localpart?: string; target?: string } }>(
    '/domains/:id/aliases',
    { config: { scope: 'provision' } },
    async (req, reply) => {
      const target = address(req.body?.target);
      await addAlias(
        req.userId,
        req.params.id,
        { localpart: localpart(req.body?.localpart), target },
        actorOf(req),
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; localpart: string } }>(
    '/domains/:id/aliases/:localpart',
    { config: { scope: 'provision' } },
    async (req, reply) => {
      await removeAlias(
        req.userId,
        req.params.id,
        { localpart: localpart(req.params.localpart) },
        actorOf(req),
      );
      return reply.code(204).send();
    },
  );

  /* ── Audit ─────────────────────────────────────────────────────────────── */

  app.get<{ Querystring: { limit?: number } }>('/domain-ops', async (req) =>
    listOps(req.userId, req.query.limit ?? 100),
  );
}
