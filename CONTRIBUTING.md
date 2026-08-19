# Contributing

mainly is an opinionated personal tool that happens to be open source. Issues
and pull requests are welcome; so are forks, if the opinions do not suit you.

## Good things to send

- **Mail server compatibility.** A server whose folders it mis-maps, whose
  `SPECIAL-USE` it misreads, or that it simply cannot talk to is the most
  useful bug report there is. Include the server and version, and what happened
  instead.
- **Self-hosting friction.** Anything that made the install harder than
  "clone, one command" is a bug.
- **Small, focused fixes** with a clear before and after.

## Things that probably will not land

A mail server. Calendar, contacts or chat. Open registration. Multi-tenancy.
Read receipts or tracking of any kind. A rewrite in another framework. Anything
requiring the mail server to be reconfigured — labels, snooze and rules are
app-side precisely so that they do not.

---

## Working on it

```sh
git clone https://github.com/crnst8/mainly && cd mainly
./dev.sh start        # Postgres in Docker, API and web on the host, both reloading
./dev.sh user you@example.com
```

Then <http://localhost:5273>.

No Docker, no backend, no database — the whole UI against seeded in-memory data:

```sh
./dev.sh mock
```

Node 22+ is required (the backend runs TypeScript directly with
`--experimental-strip-types`). Docker is required for Postgres unless you bring
your own.

### Before opening a pull request

```sh
./dev.sh check
```

That is typecheck across all three workspaces, the contract hash check, the URL
codec suite, the search syntax suite, the backend unit tests, and then a reseed
followed by smoke, query-correctness and index checks against a real Postgres.
It is the whole gate; if it passes, CI passes.

---

## How this repository is put together

Three npm workspaces — `frontend/`, `backend/`, `mcp/` — with no root package.
Each installs independently, which is what lets the frontend build with no
backend present.

### The contract

`frontend/src/lib/types.ts` and `frontend/src/lib/search.ts` are copied
**byte-for-byte** into `backend/src/contract/`. `./dev.sh check` fails if they
drift.

Edit one and copy it over the other:

```sh
cp frontend/src/lib/types.ts backend/src/contract/types.ts
```

This is the one piece of ceremony here and it earns its place: it is what lets
the frontend and backend deploy and roll back independently.

### Executable specifications

Four files are specifications that happen to run. Change behaviour by changing
them and their check suite together, never one alone.

| File | Suite |
| --- | --- |
| `frontend/src/lib/search.ts` | `frontend/scripts/search-check.mjs` |
| `frontend/src/lib/url.ts` | `frontend/scripts/url-check.mjs` |
| `frontend/src/lib/query.ts` | `backend/scripts/query-check.mjs` |
| `backend/src/modules/messages/query.ts` | the same |

`query-check.mjs` asserts absolute counts against the fixture in
`backend/src/cli/seed.ts`. If you change the fixture you will change those
numbers, and that is fine — just change them deliberately.

### Conventions

- **Business logic never imports Fastify. Transport never imports `imapflow`.**
  The seam is a plain function signature.
- **Every visual value is a token.** `frontend/src/styles/tokens.css` is the
  source of truth; runtime theming is a `setProperty` call, not a rebuild.
- **Migrations are forward-only and additive.** Add a column, backfill, switch
  reads, drop it in a *later* release, so any two adjacent versions run against
  the same schema.
- **Comments explain why, not what.** The existing ones are long where the
  reasoning is non-obvious and absent where it is not. Match that.
- **No new dependency without a reason in the pull request.** The frontend is
  React, Zustand and one animation library; the backend is Fastify, `imapflow`,
  `nodemailer`, `mailparser`, `pg` and `argon2`. That is the whole list and it
  is deliberate.

### Layout

| Path | What |
| --- | --- |
| `frontend/src/lib/` | Types, adapters, store, query engine, URL codec |
| `frontend/src/features/` | shell · mail-list · reader · compose · accounts · settings |
| `frontend/src/lib/mock/` | The in-memory adapter and its fixture |
| `backend/src/modules/` | HTTP-facing modules; `messages/query.ts` is the hot path |
| `backend/src/sync/` | IMAP pool, sync engine, envelopes, threading, bodies, replay, idle |
| `backend/migrations/` | Numbered, forward-only SQL |
| `mcp/src/index.ts` | Every MCP tool |
| `site/` | The landing page. `scripts/build-site.sh` builds it and the demo |

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).
