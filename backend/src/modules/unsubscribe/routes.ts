/**
 * Unsubscribe endpoints.
 *
 * Two, deliberately asymmetric:
 *
 *   GET  /messages/:id/unsubscribe   what is possible. Reads. Safe to call.
 *   POST /messages/:id/unsubscribe   do it. Needs `unsubscribe` scope and
 *                                    `confirm: true` in the body.
 *
 * The scope is its own, not folded into `write`. An agent told to file and
 * label mail should not also be able to remove the user from mailing lists
 * because both happen to be "changes".
 */

import type { FastifyInstance } from 'fastify';
import { executeUnsubscribe, planUnsubscribe } from './index.ts';

export async function unsubscribeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/messages/:id/unsubscribe', async (req) =>
    planUnsubscribe(req.userId, req.params.id),
  );

  app.post<{ Params: { id: string }; Body: { confirm?: boolean; target?: string } }>(
    '/messages/:id/unsubscribe',
    {
      config: {
        scope: 'unsubscribe',
        // Reaches a third party. A loop that has gone wrong should hit a wall
        // long before it has worked through a mailbox.
        rateLimit: { max: 20, timeWindow: '1 hour' },
      },
    },
    async (req) =>
      executeUnsubscribe(req.userId, req.params.id, {
        confirm: req.body?.confirm === true,
        target: req.body?.target,
        // Who to blame, in the audit row. A session is a person; a token has a
        // name its operator chose.
        actor: req.actor.kind === 'token' ? req.actor.name : 'session',
      }),
  );
}
