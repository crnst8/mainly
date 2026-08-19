<div align="center">

<img src="site/logo.png#gh-light-mode-only" width="64" alt="">
<img src="site/logo-light.png#gh-dark-mode-only" width="64" alt="">

# mainly

**A self-hosted webmail client for people who run a lot of addresses across a lot of domains.**

[Try the demo](https://mainly.crnst8.com/demo/) · [mainly.crnst8.com](https://mainly.crnst8.com)

<img src="site/sc.png#gh-light-mode-only" width="820" alt="Twelve mailboxes across seven domains in one message list">
<img src="site/sc-dark.png#gh-dark-mode-only" width="820" alt="Twelve mailboxes across seven domains in one message list">

</div>

---

## Quick start

You need [Docker](https://docs.docker.com/get-started/get-docker/). Nothing else.

```sh
git clone https://github.com/crnst8/mainly && cd mainly
./mainly.sh start
./mainly.sh user you@yourdomain.com
```

Open <http://localhost:5274> and sign in with the password the second command
printed. Add your mailboxes from the account screen.

`mainly.sh start` generates its own secrets into `.env`, pulls the image, brings
up Postgres, runs migrations and waits until the app answers. Re-running it is
safe.

<details>
<summary>Without the script</summary>

```sh
cp .env.example .env
# fill in SECRET_KEY, SESSION_SECRET and POSTGRES_PASSWORD — the file says how
docker compose up -d
docker compose exec app node dist/cli/create-user.js you@yourdomain.com
```

To build from source instead of pulling the published image, add `--build`.

</details>

Putting it on the internet, TLS, backups and updates are all in
**[docs/self-hosting.md](docs/self-hosting.md)**.

---

## What it is

Standard webmail assumes one mailbox. With twelve addresses across seven
domains, a flat folder list is unusable and a per-account switcher means
checking mail twelve times. So mainly:

- puts **everything in one list**, with the owning address always legible
- gives every **domain a colour**, and lets you change all of them
- ranks accounts by **priority tier**, so critical mail outranks a newsletter
- makes sort, grouping, density and the row contents **yours to set**
- is **keyboard-first**, with `⌘K` for anything you have not memorised

It talks IMAP and SMTP to a mail server you already own. **It does not run a
mail server, and it never changes one** — no MTA, no DNS, no DKIM, no Sieve.
Labels, snooze and saved views are implemented in the app precisely so that
nothing has to be reconfigured on the mail host.

### Try it before installing anything

<https://mainly.crnst8.com/demo/> is the real interface running against seeded
in-memory data. Every message lives in your browser tab — there is no server, no
account and nothing stored. Reload to reset.

The demo mailbox belongs to a man attempting to sell Big Chungus across seven
domains. What Big Chungus is, is never established.

---

## The one architectural decision

**IMAP is not a query engine, so this app does not query it.**

The backend mirrors message *metadata* into Postgres and serves every read from
that index. IMAP is used only to sync in, sync out, and fetch a body on demand.
A unified query across twelve mailboxes is 5–20ms of SQL instead of 3–8 seconds
of sequential `SELECT`/`SEARCH`/`FETCH`.

Everything else follows from that: cross-account search, faceting, grouping and
priority sort are all just SQL, and the list still answers when the mail server
is unreachable. The reasoning, the costs and the rejected alternatives are in
**[docs/architecture.md](docs/architecture.md)**.

---

## Features

**The list**
Unified across every account, or scoped to a domain, an account, a folder or a
saved view. Sort by date, priority, sender, subject, size or unread. Group by
date, account, domain, priority, sender or folder. Threaded or flat. Three
densities. Facet counts on every filter.

**Search**
One syntax, executed identically on the client and in Postgres:
`from:`, `to:`, `subject:`, `body:`, `label:`, `folder:`, `domain:`,
`account:`, `has:attachment`, `is:unread`, `before:`, `after:`, `larger:`.
Bare words match subject, sender and body. See [docs/search.md](docs/search.md).

**Accounts**
Add one at a time with autoconfig discovery, or bulk-import many mailboxes that
share a server in a single pass. Five priority tiers. Per-domain colour. A
mailbox whose password stops working reports the mail server's own error text
and offers to fix it, without stopping the other eleven.

**Reading and writing**
Bodies fetched on demand and sanitised server-side before storage, rendered into
a shadow root. Remote images blocked until asked for. Reply, reply-all, forward,
drafts, SMTP send with a filed `Sent` copy.

**Housekeeping**
Flags, labels, moves, archive, trash and snooze, all replayed to IMAP where they
have an IMAP meaning and kept app-side where they do not. One-click unsubscribe
via `List-Unsubscribe`, with every attempt recorded.

**Live**
IMAP `IDLE` for push on the accounts that warrant it, a bounded poll for the
rest, and server-sent events to the browser.

**Agents**
An MCP server exposing the same mailbox over the same HTTP API with scoped
tokens. See [docs/mcp.md](docs/mcp.md).

---

## Configuration

Every setting is an environment variable, and every one has a default except the
three secrets. `.env.example` documents all of them;
[docs/configuration.md](docs/configuration.md) is the reference.

The ones that matter on day one:

| Variable | Default | What it does |
| --- | --- | --- |
| `APP_ORIGIN` | `http://localhost:5274` | The address you open in a browser. Cookies and CORS are checked against it, so it must match exactly. |
| `PORT` | `5274` | Host port. |
| `BIND_ADDRESS` | `127.0.0.1` | Set to `0.0.0.0` only if you are not putting a reverse proxy in front. |
| `SECRET_KEY` | — | 32 random bytes, base64. Encrypts stored mailbox passwords. **Back this up.** |
| `SESSION_SECRET` | — | Session cookie signing key. |
| `POSTGRES_PASSWORD` | — | Generated for you on first run. |
| `ALLOW_PRIVATE_IMAP_HOSTS` | `false` | Turn on only if your mail server is on a LAN, a VPN or Tailscale. |
| `MAIL_HOST_OVERRIDE` | — | `mail.example.com=100.64.0.1` — reach a server by private address while still validating its public certificate. |

---

## Managing an install

```sh
./mainly.sh start | stop | restart | status
./mainly.sh logs [app|db]
./mainly.sh user <email>          # create a login (no open registration)
./mainly.sh update                # pull the current image and restart
./mainly.sh backup [dir]          # pg_dump to ./backups
./mainly.sh restore <file>        # replace the database. asks first
./mainly.sh reset                 # delete the database volume. asks twice
```

**What is worth backing up**, in order: `SECRET_KEY` from `.env` (lose it and
every mailbox password must be re-entered), then the Postgres volume (accounts,
preferences, saved views, labels, drafts). Message metadata is a cache — your
mail server holds the mail, and a full loss of this database costs a resync, not
mail.

---

## Development

```sh
./dev.sh start          # Postgres in Docker, API and web on the host, both reloading
./dev.sh mock           # the whole UI against seeded data — no backend, no Docker
./dev.sh check          # typecheck + contract + url + search + smoke + query
```

Then <http://localhost:5273>.

`./dev.sh mock` exists because the frontend ships a complete in-memory adapter
implementing the same `MailApi` interface as the real one. The UI cannot tell
them apart, which is what let the interface be built and demoed before the
backend existed — and is exactly why `dev.sh` writes the choice to
`frontend/.env.local` and the app logs which adapter it built. A stale dev
server serving the mock looks precisely like a working backend, and every
conclusion drawn from it is worthless.

### Layout

```
frontend/
  src/lib/          types (the API contract), api adapters, store, query engine
  src/components/   shared primitives — buttons, popovers, fields, icons
  src/features/     shell · mail-list · reader · compose · accounts · settings
  src/styles/       tokens.css is the source of truth for every visual value
backend/
  src/contract/     byte-identical copies of the frontend's types.ts and search.ts
  src/modules/      auth · accounts · messages · unsubscribe · folders · drafts · views · prefs
  src/sync/         IMAP pool, sync engine, folders, envelopes, threads, bodies, replay, idle
  src/smtp/         outbound send
  migrations/       numbered, forward-only SQL
mcp/                MCP server — the same HTTP API, exposed to agents over stdio
site/               the landing page and the hosted demo's shell
scripts/            site build and deploy, release
```

### Entry points

| What | Where |
| --- | --- |
| API contract | `frontend/src/lib/types.ts` |
| Search syntax (shared, executable spec) | `frontend/src/lib/search.ts` |
| List semantics (executable spec) | `frontend/src/lib/query.ts` |
| URL ⇄ view state | `frontend/src/lib/url.ts` · `router.ts` |
| Design tokens | `frontend/src/styles/tokens.css` |
| App state | `frontend/src/lib/store.ts` |
| Server composition root | `backend/src/server.ts` |
| The hot path | `backend/src/modules/messages/query.ts` |
| Sync loop | `backend/src/sync/engine.ts` |
| Threading | `backend/src/sync/threading.ts` |
| MCP tools | `mcp/src/index.ts` |

`frontend/src/lib/types.ts` and `search.ts` are copied byte-for-byte into
`backend/src/contract/`. `./dev.sh check` fails if they drift, which is what
lets the frontend and backend be deployed and rolled back independently.

More in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Non-goals

- Not a mail server. No MTA, no MDA, no DNS, no DKIM management.
- No calendar, contacts, tasks or chat.
- No tracking pixels, read receipts or analytics of any kind in the app.
- No open registration. Users are created by the operator.
- No mobile app. The web UI is responsive; that is the whole mobile story.
- Not a Gmail or Outlook aggregator. It speaks IMAP to servers you control.

---

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Please do not
open a public issue.

## License

MIT © Current State Projects 2026. See [LICENSE](LICENSE).
