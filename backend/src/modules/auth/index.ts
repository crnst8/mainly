/**
 * Application authentication.
 *
 * Session cookie, not a bearer token in JS. This app renders untrusted HTML
 * from strangers; a credential reachable from JavaScript is a credential an
 * XSS walks away with. httpOnly + SameSite=Strict (+ Secure over TLS) closes
 * that path, and CSRF is handled by a double-submit token instead.
 *
 * Sessions live in Postgres so a single-container deployment needs no Redis.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { one, query } from '../../db/index.ts';
import { randomToken, safeEqual, sessionDigest } from '../../lib/crypto.ts';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.ts';
import { MIN_APP_PASSWORD } from '../../contract/types.ts';
import { resolveToken, TOKEN_SCOPES, type TokenScope } from './tokens.ts';

const SESSION_COOKIE = 'mail_session';
const CSRF_COOKIE = 'mail_csrf';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/** Ceiling, because argon2 will cheerfully hash a megabyte if asked to. The
 *  floor is `MIN_APP_PASSWORD`, in the contract, because the form enforces it too. */
const MAX_PASSWORD = 256;

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

/*
 * Decided per request rather than per install, because one instance is often
 * reachable both ways at once: https through a proxy or `tailscale serve`, and
 * plain http on its LAN address at the same time. `Secure` is required for the
 * first and fatal to the second — browsers discard a Secure cookie that arrives
 * over plain HTTP, so the sign-in appears to work and the next request is
 * anonymous. `req.protocol` reads X-Forwarded-Proto (the server sets
 * trustProxy), which is what a TLS-terminating proxy in front of this sends.
 */
const cookieOptions = (req: FastifyRequest) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: req.protocol === 'https',
  path: '/',
  maxAge: SESSION_TTL_MS / 1000,
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          /* Keyed on the account, not the caller.
             `req.ip` is only as trustworthy as the proxy configuration behind
             it, and an IP-keyed limit protects nothing once a caller can pick
             their own address. The account being attacked cannot be spoofed, so
             five attempts a minute is five attempts a minute however many
             sources they arrive from. Lowercased so case rotation is not five
             more attempts, and falls back to the address for a body with no
             email in it to key on. */
          hook: 'preValidation' as const,
          keyGenerator: (req: FastifyRequest) => {
            const email = (req.body as { email?: unknown } | undefined)?.email;
            return typeof email === 'string' && email.trim()
              ? `login:${email.trim().toLowerCase()}`
              : `login-ip:${req.ip}`;
          },
        },
      },
    },
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

      /* The cookie value never reaches the database. What is stored is its
         sha256, so a dump of this table is a list of sessions rather than a set
         of usable credentials — the same rule api_tokens has always followed. */
      const sessionId = randomToken();
      const csrf = randomToken(24);
      await query(
        'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + $4::interval)',
        [sessionDigest(sessionId), user.id, csrf, `${SESSION_TTL_MS} milliseconds`],
      );

      const cookie = cookieOptions(req);
      reply
        .setCookie(SESSION_COOKIE, sessionId, cookie)
        // Readable by JS on purpose: the client echoes it back in a header,
        // which is the whole double-submit mechanism.
        .setCookie(CSRF_COOKIE, csrf, { ...cookie, httpOnly: false })
        .header('x-csrf-token', csrf);

      return { ok: true };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) await query('DELETE FROM sessions WHERE id = $1', [sessionDigest(sid)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}

/**
 * The authenticated half of auth.
 *
 * Registered inside the `requireAuth` context, unlike `authRoutes` above:
 * signing in and signing out are things you do without a session, and these are
 * things you do to the session you already have. Two functions rather than one
 * with a per-route guard, so the boundary is visible at the call site in
 * `server.ts` rather than buried in a config flag.
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/session', async (req) => {
    const user = await one<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      req.userId,
    ]);
    // A live session whose user row is gone is not a 404 — the credential is
    // what is invalid, and the client's 401 handling already knows what to do.
    if (!user) throw unauthorized('Session expired');
    return { email: user.email };
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/auth/password',
    {
      config: {
        // Bound the current-password oracle for authenticated callers.
        rateLimit: { max: 10, timeWindow: '1 minute' },
        // App credentials are unavailable to API tokens.
        sessionOnly: true,
      },
    },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body ?? {};
      if (!currentPassword || !newPassword) {
        throw badRequest('Both the current and the new password are required');
      }
      if (newPassword.length < MIN_APP_PASSWORD) {
        throw badRequest(`The new password must be at least ${MIN_APP_PASSWORD} characters`);
      }
      if (newPassword.length > MAX_PASSWORD) {
        throw badRequest(`The new password must be at most ${MAX_PASSWORD} characters`);
      }
      if (newPassword === currentPassword) {
        throw badRequest('The new password is the same as the current one');
      }

      const user = await one<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [req.userId],
      );
      if (!user) throw unauthorized('Session expired');

      const ok = await argon2.verify(user.password_hash, currentPassword).catch(() => false);
      // 401 rather than 403: the credential presented in the body is what was
      // rejected. The session itself is untouched and stays valid.
      if (!ok) throw unauthorized('That is not your current password');

      const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.userId]);

      // Revoke other sessions; API tokens have an independent lifecycle.
      const sid = req.cookies[SESSION_COOKIE] ?? '';
      await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [
        req.userId,
        sessionDigest(sid),
      ]);

      return reply.code(204).send();
    },
  );
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
    [sessionDigest(sid)],
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

/** Set a password without checking the current one. For the setup CLI and the
 *  seed fixture only — a person changing their own password goes through
 *  `/auth/password`, which verifies before it writes. */
export async function setPassword(userId: string, password: string): Promise<void> {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
}

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
