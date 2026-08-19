# Multi-stage. The runtime image carries no compiler and no dev dependencies.

FROM node:22-alpine AS build
WORKDIR /app
# argon2 builds a native module; it needs a toolchain that the runtime does not.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini && \
    addgroup -S app && adduser -S app -G app

COPY --from=deps  --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app package.json ./

USER app
EXPOSE 5274

# tini reaps zombies and forwards SIGTERM, so the graceful shutdown in
# server.ts actually runs on `docker stop`.
ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5274)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
