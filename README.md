<div align="center">

<img src="site/logo.png#gh-light-mode-only" width="64" alt="">
<img src="site/logo-light.png#gh-dark-mode-only" width="64" alt="">

# mainly

**A mail client optimized for multiple inboxes across multiple domains.**

  #### [Try the demo](https://mainly.crnst8.com/demo)


<img src="site/sc.png#gh-light-mode-only" width="820" alt="Twelve mailboxes across seven domains in one message list">
<img src="site/sc-dark.png#gh-dark-mode-only" width="820" alt="Twelve mailboxes across seven domains in one message list">



</div>

---

<br />

## What does it do?

### It does everything you expect a mail client to do, but designed for users that handle multiple inboxes across multiple domains.

Most clients aren’t optimised to handle for users who handle lots of mailboxes and domains at once, both visually and structurally. 

Instead of leaning on IMAP, Mainly uses Postgres to store metadata from the mail-server to make it faster to store & search instead of querying constantly across all the accounts. This works particularly well for those who self-host their own email servers with Postfix & Dovecot.


- A unified query across twelve mailboxes is 5–20ms of SQL instead of 3–8 seconds of sequential `SELECT`/`SEARCH`/`FETCH` , and there’s no client-side MTA, DNS, DKIM, or Sieve. 

- Things like labels, snooze and saved views are implemented in the app precisely so that nothing has to be reconfigured on the mail host.

- Zero telemetry, advertising, scraping, tracking or server-side calls that you do not control. 


#### there’s also a lot of visual & workflow optimizations for the multi-domain user:

- fast and/or bulk account onboarding (and optional server-side plugin)
- every domain has a **colour**, editable per domain or as groups
- **account groups** to create folders for mailboxes, not mail
- **sender identities** can be customised, quickly assign images or custom labels to senders.
- ranks accounts by **priority tier**, so critical mail outranks a newsletter
- makes sort, grouping, density and the row contents **yours to set**
- is **keyboard-first**, with `⌘K` for anything you have not memorised
- most things have a **right-click-to-change** for customisation and settings



## Get Started

> Docker is required for this application
> 

### Quick start script

```bash
git clone <https://github.com/crnst8/mainly> && cd mainly
./mainly.sh start
./mainly.sh user you@yourdomain.com # client login user, doesnt have to be a real email
```

### Without start script

```bash
cp .env.example .env
# fill in SECRET_KEY, SESSION_SECRET and POSTGRES_PASSWORD — the file says how
docker compose up -d
docker compose exec app node dist/cli/create-user.js you@yourdomain.com
```

To build from source instead of pulling the published image, add `--build`.

### Installing as an app

The frontend is a PWA, so it can be installed to a home screen or a dock and run
without browser chrome. 

| Platform | How |
| --- | --- |
| iOS / iPadOS | Safari → Share → **Add to Home Screen** |
| Android | Chrome → menu → **Install app** |
| Desktop | Chrome or Edge → install icon in the address bar |

> If hosting on a server, you’ll need `https://` for Chrome PWA installation. Check  self_hosting.md for more detail.
> 

## Managing an install

```bash
./mainly.sh start | stop | restart | status
./mainly.sh bind [what]           # where it listens, and every URL that reaches it
                                  # all | tailscale | lan | local | <address>
./mainly.sh origin <url>          # the URL browsers open, when a proxy fronts this
./mainly.sh tls [tailscale|off]   # HTTPS, which is what installing it as an app needs
./mainly.sh logs [app|db]
./mainly.sh user <email>          # create a login (no open registration)
./mainly.sh update                # pull the current image and restart
./mainly.sh backup [dir]          # pg_dump to ./backups
./mainly.sh restore <file>        # replace the database. asks first
./mainly.sh reset                 # delete the database volume. asks twice
```

---

### Mobile

Below 720px the app mounts a separate touch shell rather than reflowing the
desktop one: a single full-bleed list, an account colour stripe on every row,
pull to refresh, and swipe actions on every row.

Swipes are one action per side, both configurable in **Settings → Mobile**:
archive, trash, pin, read, or nothing. 

### MCP

An MCP server exposing the same mailbox over the same HTTP API with scoped
tokens. See docs/mcp.md.

### Server Plugin for Postfix + Dovecot users

Optional, and off unless you turn it on. If you run your own Postfix + Dovecot
server, this allows you to  create and remove addresses on it. This can be scoped as wide or tight as you need on install. 

```bash
# 1. copy from scripts/ -> mail server, runs a stepped wizard
sudo mainly-provision setup

# 2. back on the machine running mainly
./mainly.sh domain connect <the string it printed>
```

 See **docs/domain-control.md**; the server-side script has its own reference in
scripts/mainly-provision.md.

---

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `APP_ORIGIN` | the address detected on first run, else `http://localhost:5274` | The frontend, cookies and CORS are checked against it, so it must match exactly. An `https://` origin is what turns on the `Secure` cookie flag. |
| `PORT` | `5274` | Host port. |
| `BIND_ADDRESS` | `0.0.0.0` on a machine with no public address, else its private address | What the host port listens on. `0.0.0.0` is every interface, which is what makes LAN and Tailscale work with no further setup; `127.0.0.1` is localhost-only. Change it with `./mainly.sh bind`. |
| `SECRET_KEY` | — | 32 random bytes, base64. Encrypts stored mailbox passwords. **Back this up.** |
| `SESSION_SECRET` | — | Session cookie signing key. |
| `POSTGRES_PASSWORD` | — | Generated for you on first run. |
| `ALLOW_PRIVATE_IMAP_HOSTS` | `false` | Turn on only if your mail server is on a LAN, a VPN or Tailscale. |
| `MAIL_HOST_OVERRIDE` | — | `mail.example.com=100.64.0.1`  reach a server by private address while still validating its public certificate. |

See docs/configuration.md for more info.

---

## Development

```bash
./dev.sh start          # Postgres in Docker, API and web on the host, both reloading
./dev.sh mock           # the whole UI against seeded data — no backend, no Docker
./dev.sh check          # typecheck + contract + url + search + smoke + query
```

Then http://localhost:5273.

> `./dev.sh mock` exists because the frontend ships a complete in-memory adapter
implementing the same `MailApi` interface as the real one. The UI cannot tell
them apart, which is what let the interface be built and demoed before the
backend existed — and is exactly why `dev.sh` writes the choice to
`frontend/.env.local` and the app logs which adapter it built.
> 

### Layout

```
frontend/
  src/lib/          types (the API contract), api adapters, store, query engine
  src/components/   shared primitives — buttons, popovers, fields, icons
  src/features/     shell · mail-list · reader · compose · accounts · settings · mobile
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
| Mail sanitising, shared by reader and printer | `frontend/src/lib/mail-html.ts` |
| Sender colours → dark screen or paper | `frontend/src/lib/relight.ts` · `print.ts` |
| Touch shell (below 720px) | `frontend/src/features/mobile/` |
| App state | `frontend/src/lib/store.ts` |
| Server composition root | `backend/src/server.ts` |
| The hot path | `backend/src/modules/messages/query.ts` |
| Sync loop | `backend/src/sync/engine.ts` |
| Threading | `backend/src/sync/threading.ts` |
| MCP tools | `mcp/src/index.ts` |

`frontend/src/lib/types.ts` and `search.ts` are copied byte-for-byte into
`backend/src/contract/`. `./dev.sh check` fails if they drift, which is what
lets the frontend and backend be deployed and rolled back independently.

More in CONTRIBUTING.md.

---

## Security

Report vulnerabilities privately — see SECURITY.md. Please do not
open a public issue.

## License

MIT © Current State Projects 2026. See LICENSE.