/**
 * Composition root.
 *
 * Builds the Fastify app, registers modules, and starts whichever roles this
 * process is configured for. Nothing else in the codebase imports Fastify —
 * business logic takes plain arguments and returns plain values, so the
 * transport can change without touching it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { config, runsSync, servesHttp } from './config.ts';
import { close as closeDb, pool } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { AppError } from './lib/errors.ts';
import { authRoutes, requireAuth, sessionRoutes } from './modules/auth/index.ts';
import { accountRoutes } from './modules/accounts/routes.ts';
import { messageRoutes } from './modules/messages/routes.ts';
import {
  draftRoutes,
  eventRoutes,
  folderRoutes,
  preferenceRoutes,
  syncRoutes,
  viewRoutes,
} from './modules/misc/routes.ts';
import { unsubscribeRoutes } from './modules/unsubscribe/routes.ts';
import { startSyncLoop, stopSyncLoop } from './sync/engine.ts';
import { startIdle, stopIdle } from './sync/idle.ts';

export async function build() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Never let a credential or a message body reach the log.
      // `*.password` matches a key called exactly that. The password-change
      // body names neither field that, so both are listed explicitly.
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.body.password',
        '*.password',
        '*.currentPassword',
        '*.newPassword',
      ],
    },
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // attachments
  });

  /* Does this process also serve the built SPA?
     Checked once, here, because three separate decisions depend on it: the
     CSP, the 404 handler, and whether @fastify/static is registered at all. */
  const webRoot =
    config.webRoot && existsSync(join(config.webRoot, 'index.html')) ? config.webRoot : null;
  if (config.webRoot && !webRoot) {
    app.log.warn(
      `WEB_ROOT=${config.webRoot} has no index.html — serving the API only. ` +
        'Build the frontend (npm run build in frontend/) or unset WEB_ROOT.',
    );
  }

  /* Headers that only mean anything over TLS are sent only when there is TLS.
     HSTS, COOP and origin-keying are inert on an insecure origin — sending them
     there just fills the console with warnings that they were ignored. */
  const httpsOrigin = config.appOrigin.startsWith('https://');

  await app.register(helmet, {
    // A CSP is worth having only when this process serves the HTML. As an API
    // it answers JSON, and the policy would apply to nothing.
    contentSecurityPolicy: webRoot
      ? {
          directives: {
            defaultSrc: ["'self'"],
            // Message bodies are sanitised server-side, but they still carry
            // author styling, and the theme is applied through inline custom
            // properties before first paint.
            styleSrc: ["'self'", "'unsafe-inline'"],
            // The pre-paint theme script in index.html is inline. It is ours,
            // it is three lines, and the alternative is a flash of the wrong
            // theme on every load.
            scriptSrc: ["'self'", "'unsafe-inline'"],
            // Remote images in mail are blocked by the app until the reader
            // asks for them; once asked, they come from anywhere.
            imgSrc: ["'self'", 'data:', 'https:'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            /* Never. helmet adds `upgrade-insecure-requests` to every CSP by
               default, and it rewrites every stylesheet, script and font on the
               page to https:// — which a plaintext install does not serve, so
               the document loads and everything on it fails with
               ERR_SSL_PROTOCOL_ERROR. It buys nothing here either way: every
               asset this page asks for is same-origin and relative, so it is
               already fetched over whatever scheme the page arrived on. An
               instance reachable both ways at once — https through a proxy,
               plain http on the LAN — needs it gone rather than merely gated.
               `null` removes a helmet default; `[]` would emit it. */
            upgradeInsecureRequests: null,
          },
        }
      : false,
    strictTransportSecurity: httpsOrigin && { maxAge: 31536000, includeSubDomains: true },
    crossOriginOpenerPolicy: httpsOrigin && { policy: 'same-origin' as const },
    originAgentCluster: httpsOrigin,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    // Exact origin. Never a wildcard — credentials ride on cookies.
    origin: config.appOrigin,
    credentials: true,
    exposedHeaders: ['x-csrf-token'],
  });

  await app.register(cookie, { secret: config.secrets.session });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  /* ── One error shape, everywhere ──────────────────────────────────────────
     Registered *before* the route plugins, not after. Fastify child contexts
     capture the parent's error handler when `register` creates them, so setting
     it afterwards leaves every encapsulated route on the default handler — which
     answers `{statusCode, code, error, message}` instead of the contract's
     `{error: {code, message, detail?}}`. The client reads `payload.error.code`,
     finds a status string where an object should be, and reports every failure
     as "unknown". Ordering is the whole fix. */

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send(err.toJSON());
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    // Postgres rejecting a malformed literal means the *request* was malformed,
    // not that the server broke. Without this, a hand-edited URL with a
    // non-UUID id answers 500 and lands in the error log as if it were a bug.
    if ((err as { code?: string }).code === '22P02') {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Malformed identifier' } });
    }
    // Fastify's own validation and parsing errors carry a 4xx and are the
    // client's fault, so they are reported rather than swallowed as a 500.
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    const status = fastifyErr.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: { code: fastifyErr.code ?? 'bad_request', message: fastifyErr.message ?? 'Bad request' },
      });
    }
    req.log.error({ err }, 'unhandled error');
    // Never leak an internal message to the client in production.
    return reply.code(500).send({
      error: {
        code: 'internal',
        message: config.isProd ? 'Something went wrong' : (fastifyErr.message ?? 'Unknown error'),
      },
    });
  });

  /* ── The SPA, when this process is also the web server ────────────────────
     Registered before the routes so `/api/*` still wins: @fastify/static with
     `wildcard: false` claims only paths that exist on disk, and the 404 handler
     below decides what an unmatched path means. Client routes are not 404s;
     unmatched `/api` paths are. */

  if (webRoot) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      // Vite hashes asset filenames, so those are immutable. index.html is not
      // hashed and must never be cached, or a deploy is invisible until the
      // browser feels like revalidating.
      setHeaders(res, path) {
        if (path.endsWith('index.html')) res.setHeader('cache-control', 'no-cache');
        else if (path.includes('/assets/')) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (webRoot && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } });
  });

  /* ── Unauthenticated ────────────────────────────────────────────────────── */

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, role: config.role, version: process.env.APP_VERSION ?? 'dev' };
  });

  await app.register(async (unauthed) => authRoutes(unauthed), { prefix: '/api' });

  /* ── Authenticated ──────────────────────────────────────────────────────── */

  await app.register(
    async (authed) => {
      authed.addHook('preHandler', requireAuth);
      await sessionRoutes(authed);
      await accountRoutes(authed);
      await folderRoutes(authed);
      await messageRoutes(authed);
      await unsubscribeRoutes(authed);
      await draftRoutes(authed);
      await viewRoutes(authed);
      await preferenceRoutes(authed);
      await syncRoutes(authed);
      await eventRoutes(authed);
    },
    { prefix: '/api' },
  );

  return app;
}

async function main() {
  await migrate();

  const app = servesHttp ? await build() : null;
  if (app) {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `${config.webRoot ? 'app' : 'api'} listening on http://${config.host}:${config.port}`,
    );
  }

  if (runsSync) {
    startSyncLoop();
    // Push, on top of the poll. The poll is the floor — IDLE is bounded and not
    // every account gets a connection, so the interval still has to catch up on
    // the ones that do not.
    startIdle();
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    await stopSyncLoop();
    await stopIdle();
    // Drain in-flight requests before closing the pool underneath them.
    if (app) await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
