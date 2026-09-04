---
name: mainly
description: >-
  Orientation for the "mainly" repo — a self-hosted webmail client for people
  running mail across many domains, built as three npm workspaces (React
  frontend, Fastify + Postgres backend, MCP server) that mirror IMAP metadata
  into Postgres and serve every read from that index. Consult this skill BEFORE
  reading or changing code here, and whenever a request touches: the message
  list or query engine, search syntax, IMAP sync / threading / replay, accounts
  and mailbox credentials, the reader / printing / sender colour relighting,
  compose or SMTP, the mobile touch shell, settings or design tokens, the MCP
  tools, agent tokens, domain control, migrations, `dev.sh` / `mainly.sh` /
  `publish.sh`, the demo site, or releases. It tells you what the app is, the
  one decision the architecture follows from, where each concern lives, what
  the gate is, and which rules are non-negotiable — so you change the right
  file and do not break a contract. It does NOT restate current code; always
  read the file named below for implementation detail.
---

# mainly — repo orientation

A **webmail client** for self-hosted email across multiple domains. Not a mail
server: no MTA, no DNS, no DKIM, no Sieve. It talks IMAP and SMTP to mail
servers you already run, and everything else — labels, snooze, saved views,
priority tiers, per-domain colour — is implemented app-side so nothing has to
be reconfigured on the mail host.

Single author, MIT, published as a Docker image; the repo is also the install
(`./mainly.sh start`) and the dev environment (`./dev.sh start`).

> **Why this skill exists and how to keep it useful.** It describes only the
> *stable* shape — purpose, architecture, layout, contracts, workflow,
> conventions, gotchas. Those change slowly. Implementation details (function
> names, line numbers, SQL, exact formats) change every release, so they are
> **not** duplicated here. When you need them, read the file named below. Never
> paste code into this skill; point at the file. That is what keeps it true.

## First move, every time

1. Read this skill.
2. Read `README.md` for the product surface, `CONTRIBUTING.md` for the rules,
   `docs/architecture.md` for the reasoning. Where those and the code
   disagree, **the code is right** — architecture.md says so itself.
3. Open the specific file from the maps below. Do not grep the whole tree
   first; this skill is the index.

## The one decision everything follows from

**IMAP is not a query engine, so this app does not query it.**

The backend mirrors message *metadata* into Postgres and serves every read from
that index. IMAP is used for exactly three things: sync in (folders, envelopes,
bodies on demand), sync out (replay flags/moves/deletes), and fetching one body.

A unified query across a dozen mailboxes is 5–20ms of SQL instead of 3–8
seconds of sequential `SELECT`/`SEARCH`/`FETCH`. Everything else in the design
is downstream of that: staleness mitigated by IMAP `IDLE`, bodies cached with a
TTL rather than stored, `UIDVALIDITY`/`HIGHESTMODSEQ` reconciliation, and a
database that is **not precious** — it is a cache of mail that lives on the
mail server. `SECRET_KEY` matters more than the dump.

Service shape: one Node process, two roles chosen by env — `ROLE=api` (Fastify,
never opens IMAP), `ROLE=sync` (workers, never serve HTTP), `ROLE=all` (the
self-hosted default). Sync workers claim accounts with a Postgres advisory
lock, so N replicas need no scheduler.

## Layout — three workspaces, no root package

`frontend/`, `backend/`, `mcp/` each install independently (that is what lets
the frontend build with no backend present). Node 22+; the backend runs
TypeScript directly with `--experimental-strip-types`.

```
frontend/   React 19 + Zustand + Vite + motion. PWA.
  src/lib/          types (API contract), api adapters, store, query engine,
                    search, url/router, mail-html, relight, print, keyboard
  src/lib/mock/     in-memory adapter + fixture (mock-api.ts, seed.ts)
  src/components/   shared primitives — ui, icons, glyphs, context menus
  src/features/     shell · mail-list · reader · compose · accounts ·
                    settings · mobile · help
  src/styles/       tokens.css is the source of truth for every visual value
  scripts/          url-check · search-check · sender-check (executable specs)
backend/    Fastify + pg + imapflow + nodemailer + mailparser + argon2
  src/contract/     byte-identical copies of frontend types.ts and search.ts
  src/modules/      auth · accounts · messages · unsubscribe · domains ·
                    onboarding · events · misc
  src/sync/         pool · engine · folders · envelopes · threading · threads ·
                    bodies · body-index · replay · idle · mailboxes · parse
  src/smtp/         outbound send
  src/cli/          create-user · token · domain · seed
  migrations/       numbered, forward-only SQL (001…012)
  scripts/          smoke · query-check · index-check · check-contract ·
                    static-check · auth-check · database-benchmark
mcp/        MCP server over stdio — the same HTTP API, exposed to agents
site/       landing page + hosted demo shell
scripts/    build-site · deploy-site · release · mainly-provision (+ its .md)
docs/       architecture · configuration · self-hosting · search · mcp ·
            domain-control
```

Ignore `frontend/backend/` — empty directories left by `tsc -b`, not source.

## Where each concern lives

| Concern | File |
| --- | --- |
| API contract (types) | `frontend/src/lib/types.ts` |
| Search syntax (executable spec) | `frontend/src/lib/search.ts` |
| List semantics (executable spec) | `frontend/src/lib/query.ts` |
| URL ⇄ view state | `frontend/src/lib/url.ts` · `router.ts` |
| App state | `frontend/src/lib/store.ts` (large; the hub) |
| API adapters | `frontend/src/lib/api.ts` (`MailApi`) · `http-api.ts` · `mock/mock-api.ts` |
| Design tokens | `frontend/src/styles/tokens.css` |
| Mail sanitising (reader + printer) | `frontend/src/lib/mail-html.ts` |
| Sender colours → dark screen / paper | `frontend/src/lib/relight.ts` · `print.ts` |
| Touch shell (below 720px) | `frontend/src/features/mobile/` |
| Server composition root | `backend/src/server.ts` |
| The hot path | `backend/src/modules/messages/query.ts` · `search-sql.ts` |
| Sync loop | `backend/src/sync/engine.ts` |
| Threading | `backend/src/sync/threading.ts` |
| Credential encryption | `backend/src/lib/crypto.ts` |
| Request-forgery guard | `backend/src/lib/net-guard.ts` · `ip.ts` |
| Domain control (optional) | `backend/src/modules/domains/` + `scripts/mainly-provision` |
| MCP tools | `mcp/src/index.ts` |
| Config / env | `backend/src/config.ts` · `.env.example` · `docs/configuration.md` |

## The contract — the one piece of ceremony

`frontend/src/lib/types.ts` and `frontend/src/lib/search.ts` are copied
**byte-for-byte** into `backend/src/contract/`. Edit one, copy it over the
other:

```sh
cp frontend/src/lib/types.ts backend/src/contract/types.ts
cp frontend/src/lib/search.ts backend/src/contract/search.ts
```

`./dev.sh check` fails if they drift. It earns its place: it is what lets the
frontend and backend deploy and roll back independently, and it is why both
sides run the same search parser instead of agreeing in prose.

## Executable specifications

Four files are specs that happen to run. Change behaviour by changing the file
**and its suite together**, never one alone.

| File | Suite |
| --- | --- |
| `frontend/src/lib/search.ts` | `frontend/scripts/search-check.mjs` |
| `frontend/src/lib/url.ts` | `frontend/scripts/url-check.mjs` |
| `frontend/src/lib/query.ts` | `backend/scripts/query-check.mjs` |
| `backend/src/modules/messages/query.ts` | the same |

`query-check.mjs` asserts **absolute counts** against the fixture in
`backend/src/cli/seed.ts`. Change the fixture and those numbers change — that
is fine, change them deliberately.

## Working on it

```sh
./dev.sh start          # Postgres in Docker, API + web on the host, reloading
./dev.sh mock           # whole UI against seeded data — no backend, no Docker
./dev.sh user <email>   # create a login
./dev.sh seed           # reseed the fixture database
./dev.sh migrate
./dev.sh token …        # agent tokens (host shell only, on purpose)
./dev.sh domain …       # domain control CLI
./dev.sh logs [api|db|web]
./dev.sh rebuild        # DROPS the local database, asks first
./dev.sh check          # the gate
```

Dev UI on <http://localhost:5273>; dev API on 5274; `check` runs its own API on
its own port so it can never grade the wrong database.

**`./dev.sh check` is the whole gate — run it before claiming anything works.**
It is typecheck across three workspaces, the dependency audit, the contract
hash, the URL and search suites, backend unit tests, then reseed + smoke +
query-correctness + index checks against real Postgres. If it passes, CI
(`.github/workflows/ci.yml`) passes; CI is the same gate with a network.

Operating an install (not development): `./mainly.sh start|stop|restart|status|
bind|origin|tls|logs|user|token|domain|update|backup|restore|reset`.

Releasing: `./publish.sh` (review → commit → release, with `status`, `commit`,
`release`, `demo`, `--dry-run`), which calls `scripts/release.sh <version>` —
clean tree on main, full check, version into the three package.json files,
commit, tag `v<version>`, push. `CHANGELOG.md` gets release notes; the site and
demo are built by `scripts/build-site.sh` and deployed by `deploy-site.sh`.

## Conventions — treat as non-negotiable

- **Business logic never imports Fastify. Transport never imports `imapflow`.**
  The seam is a plain function signature. That seam is why the entire API could
  be swapped for the in-memory adapter without the UI noticing.
- **Every visual value is a token.** `frontend/src/styles/tokens.css` is the
  source of truth; runtime theming is a `setProperty` call, not a rebuild.
- **Migrations are forward-only and additive.** Add a column, backfill, switch
  reads, drop it in a *later* release, so any two adjacent versions run against
  the same schema.
- **Comments explain why, not what** — long where the reasoning is non-obvious,
  absent where it is not. Match the existing density.
- **No new dependency without a reason.** Frontend is React, Zustand, motion.
  Backend is Fastify, `imapflow`, `nodemailer`, `mailparser`, `pg`, `argon2`,
  `sanitize-html`, `ssh2`. That is the whole list, deliberately.
- Search, list and URL behaviour is defined by the spec files above, not by the
  component that happens to call them.

## Security rules that constrain design

- Mailbox credentials: AES-256-GCM under `SECRET_KEY`, unique nonce per record,
  decrypted only inside the sync worker, never logged, never returned by any
  endpoint. `secret_key_version` exists for rotation.
- App auth: own users table, argon2id, httpOnly + SameSite session cookie,
  `Secure` when `APP_ORIGIN` is https. **No token in `localStorage`** — this app
  renders untrusted HTML.
- HTML is sanitised **server-side on ingest**, before storage; the client then
  renders into a shadow root. Remote images are rewritten to `data-src`.
- CSRF double-submit token on every non-GET. CORS locked to `APP_ORIGIN`, never
  wildcard. Login and verify are rate limited.
- Outbound connections on user-supplied hosts refuse private ranges unless
  `ALLOW_PRIVATE_IMAP_HOSTS` is on — that endpoint is the request-forgery
  surface.
- Agent tokens are scoped (`read`, `write`, `unsubscribe`) and mintable only
  from a shell on the host. Adding an account, changing a mailbox password and
  deleting an account are closed to tokens at every scope.
- Domain control is off unless connected, and the allowlist that decides lives
  on the mail server in a file this app cannot write.
- Vulnerabilities go through `SECURITY.md`, never a public issue.

## Gotchas

1. **The mock adapter is a loaded gun.** A stale dev server serving mock data
   looks exactly like a working backend and every conclusion from it is
   worthless. Production defaults to http; `dev.sh` writes the choice into
   `frontend/.env.local`; the app logs which adapter it built. Check that log
   before debugging "wrong data".
2. **The contract drifts silently until `check` runs.** Copy both files.
3. **`query-check.mjs` asserts absolute counts** — reseed before running
   suites, and expect number churn when the fixture changes.
4. **Failure behaviour is per-account by design**: one bad credential stops
   that account only and surfaces the mail server's own error text. Do not
   "simplify" that into a global error state.
5. **Postgres is the only hard dependency.** Mail server unreachable means
   reads still work from the index and sends queue — preserve that.

## Docs index

| Doc | For |
| --- | --- |
| `docs/architecture.md` | The reasoning, service shape, failure table |
| `docs/configuration.md` | Every environment variable |
| `docs/self-hosting.md` | Install, TLS, proxies, private-network mail, backups |
| `docs/search.md` | The query syntax users type |
| `docs/mcp.md` | MCP server and agent tokens |
| `docs/domain-control.md` | Optional address create/remove on Postfix+Dovecot |
| `scripts/mainly-provision.md` | The mail-server half of domain control |

## Keeping this skill current

Update it when the repo's **shape** changes, not when code changes: a new
workspace or top-level directory, a new module or feature area, a new
executable spec or check, a change to the contract mechanism, a new `dev.sh` /
`mainly.sh` / `publish.sh` subcommand, a new dependency, a changed
non-negotiable, or a new doc. Keep the maps as pointers — if you are tempted to
add code, add a path instead.
