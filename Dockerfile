# One image: the API, the sync worker, and the built web UI.
#
# Self-hosting is the whole reason this file exists. Splitting the frontend onto
# a CDN and the API behind nginx is a better shape at scale and a worse one for
# the person who wants mail working before dinner, so the default is a single
# container that answers on a single port. `ROLE` still splits API from sync
# across replicas when that day comes, and `WEB_ROOT` can be unset to make this
# an API-only image.

# ── The web UI ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/public ./public
COPY frontend/src ./src

# Said explicitly, though a production build already defaults to it. A bundle
# that quietly serves seeded fake data is indistinguishable from a working
# install right up until someone trusts it.
ENV VITE_API_MODE=http
RUN npm run build

# ── The server ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /app
# argon2 compiles a native module. The toolchain stays in this stage.
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5274 \
    WEB_ROOT=/app/web

RUN apk add --no-cache tini && \
    addgroup -S app && adduser -S app -G app

COPY --from=deps         --chown=app:app /app/node_modules ./node_modules
COPY --from=server-build --chown=app:app /app/dist ./dist
COPY --from=web          --chown=app:app /web/dist ./web
COPY --chown=app:app backend/migrations ./migrations
COPY --chown=app:app backend/package.json ./

USER app
EXPOSE 5274

# tini reaps zombies and forwards SIGTERM, so the graceful shutdown in
# server.ts actually runs on `docker stop` instead of being killed mid-sync.
ENTRYPOINT ["/sbin/tini", "--"]

# A real database round trip, not a TCP accept. A wedged pool is the failure
# worth restarting for and it answers 200 to anything shallower.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5274)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
