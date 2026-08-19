/**
 * Application authentication.
 *
 * Session cookie, not a bearer token in JS. This app renders untrusted HTML
 * from strangers; a credential reachable from JavaScript is a credential an
 * XSS walks away with. httpOnly + SameSite=Strict + Secure closes that path,
 * and CSRF is handled by a double-submit token instead.
 *
 * Sessions live in Postgres so a single-container deployment needs no Redis.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { one, query } from '../../db/index.ts';
import { config } from '../../config.ts';
import { randomToken, safeEqual } from '../../lib/crypto.ts';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.ts';
import { resolveToken, TOKEN_SCOPES, type TokenScope } from './tokens.ts';

const SESSION_COOKIE = 'mail_session';
const CSRF_COOKIE = 'mail_csrf';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    /** How this request authenticated. A route that must never be reachable by
     *  an agent checks this rather than trying to infer it. */
    actor: { kind: 'session' } | { kind: 'token'; name: string; scopes: TokenScope[] };
  }

  interface FastifyContextConfig {
    /**
     * The scope a token needs for this route, when the HTTP verb does not say.
     * `/messages/query` is the case that exists: a POST that reads.
     */
    scope?: TokenScope;
    /** Refuse API tokens outright. For routes that handle mailbox credentials. */
    sessionOnly?: boolean;
  }
}

const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: config.isProd,
  path: '/',
  maxAge: SESSION_TTL_MS / 1000,
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = req.body ?? {};
      if (!email || !password) throw badRequest('Email and password are required');

      const user = await one<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE email = $1',
        [email],
      );

      // Verify against a dummy hash when the user does not exist, so the
      // response time does not leak which addresses are registered.
      const ok = user
        ? await argon2.verify(user.password_hash, password).catch(() => false)
        : await argon2
            .verify('$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', password)
            .catch(() => false);

      if (!user || !ok) throw unauthorized('Wrong email or password');

      const sessionId = randomToken();
      const csrf = randomToken(24);
      await query(
        'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + $4::interval)',
        [sessionId, user.id, csrf, `${SESSION_TTL_MS} milliseconds`],
      );

      reply
        .setCookie(SESSION_COOKIE, sessionId, cookieOptions)
        // Readable by JS on purpose: the client echoes it back in a header,
        // which is the whole double-submit mechanism.
        .setCookie(CSRF_COOKIE, csrf, { ...cookieOptions, httpOnly: false })
        .header('x-csrf-token', csrf);

      return { ok: true };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) await query('DELETE FROM sessions WHERE id = $1', [sid]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}

/**
 * The scope a request needs.
 *
 * Reads are `read`; anything that changes state is `write`. Deriving it from
 * the verb rather than annotating fifty routes means a route added tomorrow is
 * covered by default, and a route whose verb lies about what it does says so in
 * its own config.
 */
function requiredScope(req: FastifyRequest): TokenScope {
  const declared = req.routeOptions?.config?.scope;
  if (declared) return declared;
  return req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
}

/**
 * Registered as a preHandler on every route below /api except auth and health.
 *
 * Accepts either credential:
 *
 *  - **Session cookie.** A person, in a browser. Carries every scope, and is
 *    held to the CSRF check because a cookie is ambient.
 *  - **Bearer token.** An agent. Carries only the scopes it was minted with,
 *    and is not held to CSRF because nothing attaches an `Authorization` header
 *    on its behalf. See `tokens.ts`.
 *
 * A request that presents both is treated as a session — the cookie is the
 * stronger claim and the more restrictive path.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return requireBearer(req);

  const session = await one<{ user_id: string; csrf_token: string }>(
    'SELECT user_id, csrf_token FROM sessions WHERE id = $1 AND expires_at > now()',
    [sid],
  );
  if (!session) throw unauthorized('Session expired');

  // Synchroniser token, checked against the session rather than against the
  // cookie. Comparing header-to-cookie alone would still pass if an attacker
  // could set both; comparing to server-side state cannot.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !safeEqual(header, session.csrf_token)) {
      throw unauthorized('CSRF token missing or invalid');
    }
  }

  req.userId = session.user_id;
  req.actor = { kind: 'session' };

  // Echo the session's token so a client that reloaded, or that never saw the
  // login response, can pick it up from any read. Stable, so concurrent
  // requests never disagree about which token is current.
  reply.header('x-csrf-token', session.csrf_token);
}

/** The agent path. Separate function so the two credentials never share a
 *  branch and a change to one cannot silently loosen the other. */
async function requireBearer(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!presented) throw unauthorized();

  const token = await resolveToken(presented);
  // Deliberately the same message an expired session gets. A caller learning
  // whether a token exists but is out of scope is a caller enumerating tokens.
  if (!token) throw unauthorized('Token invalid or expired');

  if (req.routeOptions?.config?.sessionOnly) {
    throw forbidden('This endpoint is not available to API tokens');
  }

  const needed = requiredScope(req);
  if (!token.scopes.includes(needed)) {
    throw forbidden(
      `Token is missing the '${needed}' scope. It has: ${token.scopes.join(', ') || 'none'}`,
    );
  }

  req.userId = token.userId;
  req.actor = { kind: 'token', name: token.name, scopes: token.scopes };
}

/** Every scope a token could hold. Re-exported so route modules do not have to
 *  reach into `tokens.ts` for the type alone. */
export { TOKEN_SCOPES, type TokenScope };

/** Used by the setup CLI and tests. Not exposed as an endpoint — this app does
 *  not have open registration. */
export async function createUser(email: string, password: string): Promise<string> {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const row = await one<{ id: string }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  await query('INSERT INTO preferences (user_id, data) VALUES ($1, $2)', [row!.id, '{}']);
  return row!.id;
}
