/**
 * The endpoint a mail server's hook calls: POST /api/hooks/mail.
 *
 * Outside the session and agent-token auth on purpose: the caller is Dovecot,
 * holding a hook token (modules/hooks/service.ts), and nothing else it could
 * present means anything here. No CSRF — that guard lives in requireAuth and
 * exists for cookies, which this caller never has.
 *
 * Answers 202 before any IMAP work, because the caller is blocking a delivery
 * or another client's command until it hears back.
 */

import type { FastifyInstance } from 'fastify';
import { unauthorized } from '../../lib/errors.ts';
import { hookForToken, type HookNotice } from './service.ts';
import { receiveNotice } from '../../sync/mail-hook.ts';

export async function hookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: HookNotice }>(
    '/hooks/mail',
    {
      config: {
        // One mail server is one caller, and every client's flag change on it
        // is a notice. Generous, so a busy server is never refused; a refusal
        // only pauses that session's notices and polling covers the gap.
        rateLimit: { max: 1200, timeWindow: '1 minute' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['user', 'mailboxes'],
          additionalProperties: false,
          properties: {
            user: { type: 'string', minLength: 1, maxLength: 320 },
            mailboxes: {
              type: 'array',
              maxItems: 1000,
              items: { type: 'string', minLength: 1, maxLength: 1024 },
            },
            folders: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (req, reply) => {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const hook = token ? await hookForToken(token) : null;
      if (!hook) throw unauthorized('Unknown hook token');

      // Not awaited: the caller is waiting on this answer inside Dovecot. The
      // lookup and scheduling are quick, but their failure is ours to log, not
      // a reason to hold up mail delivery.
      void receiveNotice(hook, req.body).catch((err: Error) =>
        req.log.warn({ err: err.message }, 'mail hook notice not scheduled'),
      );
      return reply.code(202).send();
    },
  );
}
