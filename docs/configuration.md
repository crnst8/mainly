# Configuration reference

Every setting is an environment variable read once at boot and validated hard.
A missing `DATABASE_URL`, a `SECRET_KEY` that is not 32 bytes, or an
out-of-range pool setting **refuses to start**, rather than failing at 3am
during the first sync.

Set them in `.env` next to `docker-compose.yml`. `./mainly.sh start` writes that
file on first run with generated secrets; `.env.example` is the annotated
template.

---

## Required

| Variable | Notes |
| --- | --- |
| `SECRET_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored mailbox passwords with AES-256-GCM. Validated at boot; must decode to exactly 32 bytes. **Losing it means re-entering every mailbox password.** Back it up off the machine. |
| `SESSION_SECRET` | Signs the session cookie. Rotating it logs everyone out and costs nothing else. |
| `POSTGRES_PASSWORD` | Generated on first run. Avoid `/`, `+` and `=` — it is interpolated into a connection URL. |

`DATABASE_URL` is built from `POSTGRES_PASSWORD` by `docker-compose.yml`. Set it
directly only if you are pointing at a Postgres you manage yourself.

## Addressing

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_ORIGIN` | `http://localhost:5274` | The address you open in a browser. Cookies and CORS are checked against it, so it must match exactly — scheme, host and port. Behind a proxy this is the public URL. A mismatch presents as being signed out immediately after signing in. |
| `PORT` | `5274` | Host port. |
| `BIND_ADDRESS` | `127.0.0.1` | What the host port binds to. Setting it to `0.0.0.0` publishes a login form over plaintext HTTP; put a reverse proxy in front instead. |
| `WEB_ROOT` | `/app/web` in the image | Where the built web UI is served from. Unset it to run this process as an API only. |

## Mail server reachability

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOW_PRIVATE_IMAP_HOSTS` | `false` | Lets the verify step connect to private, loopback, link-local and reserved addresses. That endpoint opens a connection to a hostname the user supplies, so it is the request-forgery surface — which is exactly why turning it on is explicit. Also governs whether an unsubscribe link resolving to a private address is followed. |
| `MAIL_HOST_OVERRIDE` | — | `host=address`, comma separated. Reach a server at a private address while still validating its real certificate. See [self-hosting](self-hosting.md#mail-servers-on-a-private-network). |

## Sync and IMAP

| Variable | Default | Notes |
| --- | --- | --- |
| `IMAP_POOL_MAX` | `8` | Concurrent IMAP connections across all accounts. |
| `IMAP_PER_ACCOUNT_MAX` | `2` | Per account. Dovecot's `mail_max_userip_connections` defaults to 10. |
| `IMAP_CONNECT_TIMEOUT_MS` | `15000` | |
| `IMAP_IDLE_MAX_ACCOUNTS` | `12` | Accounts held on a live `IDLE` connection for push. The rest poll. Which accounts get one is chosen by priority and traffic, not arbitrarily. |
| `SYNC_INTERVAL_MS` | `120000` | The poll floor beneath `IDLE`. |
| `SYNC_FOLDER_INTERVAL_MS` | `600000` | How often folders are re-listed. |
| `BODY_CACHE_TTL_DAYS` | `30` | Bodies are cached, not stored. |
| `SYNC_MAX_CONCURRENT_ACCOUNTS` | `min(4, DATABASE_POOL_MAX - 2)` | Must be a positive integer below `DATABASE_POOL_MAX`. Each account sync holds an advisory-lock connection, so this leaves reserved capacity for API queries. |

## Database

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | `10` | Minimum 2. |
| `DB_PORT` | `54329` | Host port Postgres is exposed on, bound to `127.0.0.1` for `pg_dump` and inspection. Remove the mapping in compose if you want neither. |

## Runtime

| Variable | Default | Notes |
| --- | --- | --- |
| `ROLE` | `all` | `api`, `sync` or `all`. `all` runs the HTTP server and the sync workers in one process — the self-hosted default. Splitting them needs no other change: workers claim accounts with Postgres advisory locks, so there is no scheduler to run. |
| `LOG_LEVEL` | `info` | Credentials, authorization headers, cookies and passwords are redacted from logs unconditionally. |
| `NODE_ENV` | `production` in the image | Makes the session cookie `Secure`. |
| `APP_VERSION` | `dev` | Reported by `/api/health`. Set from the image tag by compose. |
| `MAINLY_VERSION` | `latest` | Which image tag compose pulls. Pin it to stop `./mainly.sh update` moving you forward unexpectedly. |
| `REDIS_URL` | — | Only needed once more than one API replica exists. Sessions live in Postgres so a single-container install needs no Redis. |

## Secret rotation

`SECRET_KEY_VERSION` (default `1`) records which key sealed each stored
credential. To rotate: keep the old key available as `SECRET_KEY_V1`, set the
new one as `SECRET_KEY`, raise `SECRET_KEY_VERSION` to `2`, and restart. Records
still on the old version are read with the old key and re-sealed as they are
touched.

## MCP server

These belong to the `mcp/` process rather than the API, and are normally set in
the MCP client's own configuration. See [mcp.md](mcp.md).

| Variable | Default |
| --- | --- |
| `MAIL_API_URL` | `http://127.0.0.1:5274/api` |
| `MAIL_API_TOKEN` | — (required) |
| `MAIL_MCP_MAX_BODY_CHARS` | `8000` |

## Frontend build-time

Only relevant if you build the web UI yourself. These are baked into the bundle.

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_API_MODE` | `http` in a production build, `mock` in dev | Which adapter is compiled in. A production bundle that quietly serves seeded fake data is the worst failure this seam can produce, so the production default is the real one and asking for `mock` has to be deliberate. |
| `VITE_API_BASE` | `/api` | Where the API is, relative to the page. |
| `VITE_BASE` | `/` | Where the app is mounted. The hosted demo uses `/demo/`. |
| `VITE_DEMO` | — | `1` renders the "none of this is real" badge. |
