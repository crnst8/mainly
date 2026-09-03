<div align="center">

<img src="site/logo.png#gh-light-mode-only" width="64" alt="">
<img src="site/logo-light.png#gh-dark-mode-only" width="64" alt="">

# mainly

**A webmail client optimized for self-hosted email across multiple domains.**

[Try the demo](https://mainly.crnst8.com/demo/) · [mainly.crnst8.com](https://mainly.crnst8.com)

<img src="site/sc.png#gh-light-mode-only" width="820" alt="Twelve mailboxes across seven domains in one message list">
<img src="site/sc-dark.png#gh-dark-mode-only" width="820" alt="Twelve mailboxes across seven domains in one message list">


</div>


---

## Quick start

> Docker is required for this application
### Quick start script

```sh
git clone https://github.com/crnst8/mainly && cd mainly
./mainly.sh start 
./mainly.sh user you@yourdomain.com # client login user
```

`./mainly.sh start` prints every URL that reaches it. Open one, sign in with the
password the second command printed, then add your mailboxes from the account
screen.

Unless this machine has an address the internet can reach, that list is more
than localhost: mainly listens on every interface, so your LAN address and your
Tailscale address work too, from your phone or any other device, over plain
HTTP with nothing else to configure.

```
  Open it at:
    http://100.64.0.2:5274
    http://192.168.1.20:5274
    http://localhost:5274
```

`./mainly.sh bind` prints that list again later, and narrows it — `bind local`,
`bind tailscale`, `bind lan`, or an address you name. One thing plain HTTP
cannot do is offer to **install mainly as an app** — browsers gate that on
`https://` or `localhost` — so `./mainly.sh tls` explains where you stand, and
`./mainly.sh tls tailscale` puts a real certificate in front on a tailnet that
issues them. [docs/self-hosting.md](docs/self-hosting.md#installing-it-as-an-app)
has the route for everywhere else. A machine that *does* hold
a public address is treated differently: the first run binds its private address
only, because a plaintext login form does not belong on the internet.

`mainly.sh start` generates its own secrets into `.env`, pulls the image, brings
up Postgres, runs migrations and waits until the app answers. Re-running it is
safe.


### Without start script

```sh
cp .env.example .env
# fill in SECRET_KEY, SESSION_SECRET and POSTGRES_PASSWORD — the file says how
docker compose up -d
docker compose exec app node dist/cli/create-user.js you@yourdomain.com
```

To build from source instead of pulling the published image, add `--build`.



---

## What does it do?

This is a **webmail client** specifically built for those that self-host multiple email domains.


- puts **everything in one list**, with the owning address always legible
- gives every **domain a colour**, and lets you change all of them
- ranks accounts by **priority tier**, so critical mail outranks a newsletter
- makes sort, grouping, density and the row contents **yours to set**
- is **keyboard-first**, with `⌘K` for anything you have not memorised



 The backend mirrors message *metadata* into Postgres and serves every read from
that index. IMAP is used only to sync in, sync out, and fetch a body on demand.
 
 - no MTA, no DNS, no DKIM, no Sieve
- Labels, snooze and saved views are implemented in the app precisely so that nothing has to be reconfigured on the mail host.
- A unified query across twelve mailboxes is 5–20ms of SQL instead of 3–8 seconds of sequential `SELECT`/`SEARCH`/`FETCH`.



---

## Features

### Fast visibility across domains
Unified across every account, or scoped to a domain, an account, a folder or a
saved view. Sort by date, priority, sender, subject, size or unread. Group by
date, account, domain, priority, sender or folder. Threaded or flat. Three
densities. Facet counts on every filter.

### Optimal Search
One syntax, executed identically on the client and in Postgres:
`from:`, `to:`, `subject:`, `body:`, `label:`, `folder:`, `domain:`,
`account:`, `has:attachment`, `is:unread`, `before:`, `after:`, `larger:`.
Bare words match subject, sender and body. See [docs/search.md](docs/search.md).

### Account Management
Add one at a time with autoconfig discovery, or bulk-import many mailboxes that
share a server in a single pass. Five priority tiers. Per-domain colour. A
mailbox whose password stops working reports the mail server's own error text
and offers to fix it, without stopping the other eleven.



### Reading in the dark, and on paper
A message is drawn for white paper, and that assumption breaks in two opposite
directions. In dark mode Mainly re-lights the sender's colours to sit on a dark
surface — hues kept, lightness moved — including the common case of a message
that declares no background at all and hardcodes dark grey text, which is
otherwise unreadable. A message already designed dark is left as it is. One
button in the reader, or `i`, shows any message exactly as it was sent and back
again, for that message only.

Most mail declares no background at all, which is not the same as declaring
white: it means the message is standing on whatever the reader put behind it.
When its ink was written for the opposite surface — light text from a dark
template, read on a light page, or the reverse when a message is shown as sent
in dark mode — it is given the surface it was drawn for, on its own card, and
every colour the sender chose survives untouched. A message that paints its own
background is never touched this way.

`p` prints. Printing builds a page holding the message and nothing of the mail
client, titled with the subject line, in black on white — dark bands and pale
small print lifted, everything else untouched. This is the answer to receipts
that arrive *in the body* with nothing attached and no file to save: print it,
choose **Save as PDF**, and the subject is already the filename. **As sent**
prints the sender's own colours instead.

### Housekeeping Tools
Flags, labels, moves, archive, trash and snooze, all replayed to IMAP where they
have an IMAP meaning and kept app-side where they do not. One-click unsubscribe
via `List-Unsubscribe`, with every attempt recorded.


### Mobile
Below 720px the app mounts a separate touch shell rather than reflowing the
desktop one: a single full-bleed list, an account colour stripe on every row,
pull to refresh, and swipe actions on every row.

Swipes are one action per side, both configurable in **Settings → Mobile**:
archive, trash, pin, read, or nothing. Archive left and read right by default.
A short swipe reveals the action as a button; carrying it past 40% of the row
arms it — the pane fills and names what it is about to do — and letting go there
commits without a second tap. Destructive actions keep the same undo window as
the desktop.

Composing is a full screen of its own rather than the desktop's docked card:
recipient chips, a From row that is never collapsed, and a send bar that tracks
the on-screen keyboard so nothing is ever typed underneath it. Backing out of a
draft with anything in it asks before discarding.

### Install as an app
The frontend is a PWA, so it can be installed to a home screen or a dock and run
without browser chrome. Nothing needs enabling; it is served with the app.

| Platform | How |
| --- | --- |
| iOS / iPadOS | Safari → Share → **Add to Home Screen** |
| Android | Chrome → menu → **Install app** |
| Desktop | Chrome or Edge → install icon in the address bar |

A service worker caches the app shell, so a cold launch paints without waiting
on the network. The API is never cached: the message list is either current or
visibly absent, never quietly stale. Installing changes nothing on the server
and is not required to use the app in a browser tab.

### MCP
An MCP server exposing the same mailbox over the same HTTP API with scoped
tokens. See [docs/mcp.md](docs/mcp.md).

### Domain control
Optional, and off unless you turn it on. If you run your own Postfix + Dovecot
server, mainly can create and remove addresses on it — per domain, and only the
operations you allow.

```sh
./mainly.sh domain add   you@example.com example.com --host mail.example.com --key ~/.ssh/k
./mainly.sh domain grant you@example.com example.com list,create
```

The permission that decides lives on the mail server, in a file mainly cannot
write, so connecting a domain never grants more than you set there. Setup takes
about 15 minutes per server and is written out step by step in
**[docs/domain-control.md](docs/domain-control.md)**; the server-side script has
its own reference in
[scripts/mainly-provision.md](scripts/mainly-provision.md).

---

## Configuration

Every setting is an environment variable, and every one has a default except the
three secrets. `.env.example` documents all of them;
[docs/configuration.md](docs/configuration.md) is the reference.

The ones that matter on day one:

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

---

## Managing an install

```sh
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

## Development

```sh
./dev.sh start          # Postgres in Docker, API and web on the host, both reloading
./dev.sh mock           # the whole UI against seeded data — no backend, no Docker
./dev.sh check          # typecheck + contract + url + search + smoke + query
```

Then <http://localhost:5273>.

> `./dev.sh mock` exists because the frontend ships a complete in-memory adapter
implementing the same `MailApi` interface as the real one. The UI cannot tell
them apart, which is what let the interface be built and demoed before the
backend existed — and is exactly why `dev.sh` writes the choice to
`frontend/.env.local` and the app logs which adapter it built. 

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

More in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Please do not
open a public issue.

## License

MIT © Current State Projects 2026. See [LICENSE](LICENSE).
