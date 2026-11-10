/**
 * Assist: the recap, and sender logos. Kind labels have no route; they are
 * applied by the sync worker on arrival (sync/arrivals.ts).
 *
 * The recap is session only for the same reason the filter's model routes
 * are: it spends the user's provider allowance at a time the caller picks.
 * Logos are readable with any token that can read mail, since the list an
 * agent renders is the same list.
 */

import type { FastifyInstance } from 'fastify';
import { one } from '../../db/index.ts';
import { badRequest, notFound, upstream } from '../../lib/errors.ts';
import { withPreferenceDefaults, type Preferences, type Recap } from '../../contract/types.ts';
import { recapFor } from '../../assist/recap.ts';
import { cachedLogo, findLogo, hasMailFrom, logoDomain, type Logo } from '../../assist/logos.ts';
import { LlmError } from '../../filter/llm.ts';

async function prefsOf(userId: string): Promise<Preferences> {
  const row = await one<{ data: Partial<Preferences> | null }>('SELECT data FROM preferences WHERE user_id = $1', [
    userId,
  ]);
  return withPreferenceDefaults(row?.data);
}

/** How far back a recap may reach. A week of mail is already more than one
 *  prompt reads; the recap takes the newest of it. */
const RECAP_MAX_DAYS = 7;

/** An image from someone else's server, served from this origin. The policy
 *  makes an SVG opened directly an inert document rather than a page that
 *  runs script with this app's cookies. */
const LOGO_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  'x-content-type-options': 'nosniff',
  'content-disposition': 'inline',
  'cache-control': 'private, max-age=86400',
};

export async function assistRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { since?: string } }>(
    '/assist/recap',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' }, sessionOnly: true } },
    async (req) => {
      const since = new Date(String(req.body?.since ?? ''));
      if (Number.isNaN(since.getTime())) throw badRequest('since must be a date');
      const earliest = Date.now() - RECAP_MAX_DAYS * 86_400_000;
      if (since.getTime() < earliest) throw badRequest(`A recap reaches back at most ${RECAP_MAX_DAYS} days`);
      const prefs = await prefsOf(req.userId);
      try {
        return (await recapFor(req.userId, prefs.filtering.llmModel, since)) satisfies Recap;
      } catch (err) {
        if (err instanceof LlmError) throw upstream(err.message);
        throw err;
      }
    },
  );

  app.get<{ Querystring: { domain?: string } }>('/senders/logo', async (req, reply) => {
    const domain = logoDomain(req.query.domain);
    if (!domain || !(await hasMailFrom(req.userId, domain))) {
      return reply.code(404).header('cache-control', 'private, max-age=3600').send();
    }
    let logo: Logo | null | undefined = await cachedLogo(domain);
    // Not looked up yet: only BIMI, and only when the user turned automatic
    // logos on. A logo found by hand is in the cache already.
    if (logo === undefined && (await prefsOf(req.userId)).assist.senderLogos) {
      logo = await findLogo(domain, false).catch(() => null);
    }
    if (!logo) return reply.code(404).header('cache-control', 'private, max-age=3600').send();
    return reply.headers(LOGO_HEADERS).type(logo.contentType).send(logo.image);
  });

  /** Look for one sender's logo now, BIMI first and then the site's icon. */
  app.post<{ Body: { domain?: string } }>(
    '/senders/logo',
    { config: { rateLimit: { max: 60, timeWindow: '1 hour' }, sessionOnly: true } },
    async (req) => {
      const domain = logoDomain(req.body?.domain);
      if (!domain) throw badRequest('Not a sender domain a logo can be found for');
      if (!(await hasMailFrom(req.userId, domain))) throw notFound('Mail from that domain');
      const logo = await findLogo(domain, true).catch(() => null);
      if (!logo) throw notFound('A logo for that domain');
      return { url: `/api/senders/logo?domain=${encodeURIComponent(domain)}`, source: logo.source };
    },
  );
}
