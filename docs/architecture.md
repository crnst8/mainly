# Architecture

Where the code disagrees with this document, the code is right.

---

## The single decision everything else follows from

**IMAP is not a query engine, so this app does not query it.**

IMAP4rev1 is stateful, connection-oriented, and has no concept of "the 200
newest unread messages across twelve mailboxes, grouped by domain, sorted by
priority". Doing that over IMAP means `SELECT`-ing each of ~90 folders in turn,
`SEARCH`-ing each one, `FETCH`-ing envelopes and merging client-side. On a warm
connection that is 3–8 seconds. On a cold one it is worse. The Doherty threshold
is 400ms.

So the backend maintains a **local index in Postgres** that mirrors message
metadata, and the API serves every read from that index. IMAP is used for
exactly three things:

1. **Sync in** — discover folders, pull new and changed envelopes, pull bodies
   on demand.
2. **Sync out** — replay flag changes, moves and deletes as IMAP commands.
3. **Fetch a body** — one message at a time, cached after first read.

This is the same architecture every fast mail client uses, for the same reason.
It is not an optimisation; it is the only way the product works.

### What it costs

- **Index staleness** between passes. Mitigated by IMAP `IDLE` — a long-lived
  connection per account, push-notified on new mail — for as many accounts as
  `IMAP_IDLE_MAX_ACCOUNTS` allows. The poll is the floor beneath it.
- **Storage.** Metadata for ~46 mailboxes at ~10k messages each is roughly 500k
  rows and 400MB with indexes. Bodies are **not** stored permanently, only
  cached with a TTL.
- **Reconciliation** when a change happens in another client. Handled with
  `UIDVALIDITY` and `HIGHESTMODSEQ` checks.

### What it buys

- List queries in 5–20ms regardless of mailbox size.
- Full-text search across every account at once, which IMAP cannot do at all.
- Cross-account grouping, faceting and priority sort — all just SQL.
- A UI that still answers when the mail server is unreachable.

---

## Constraints this was designed against

| Constraint | Consequence |
| --- | --- |
| The mail server is **read-only infrastructure**. No config changes, no plugins, no Sieve, no ManageSieve. | Labels, snooze, rules and saved views are implemented app-side. Labels are the app's own, not IMAP keywords, unless you opt in. |
| No admin API and no master user on a typical Dovecot install. | One credential is held per mailbox, encrypted at rest. |
| The app host is usually not the mail host. | Mail traffic crosses a network, which is why `MAIL_HOST_OVERRIDE` exists — see [self-hosting](self-hosting.md#mail-servers-on-a-private-network). |
| Small shared hardware is the normal case. | Sync is bounded: a connection pool cap, a global concurrency cap and backpressure. Never "one always-on worker per account". |
| Must run self-hosted **and** scale-hosted from one codebase. | No single-process assumptions. Sync workers claim accounts with a Postgres advisory lock, so N replicas work with no scheduler. |

---

## Service shape

One Node process, two roles, selected by environment so they can be split later
without a rewrite:

```
ROLE=api    Fastify HTTP server. Never opens an IMAP connection.
ROLE=sync   Sync workers. Never serves HTTP.
ROLE=all    Both, in one process. The self-hosted default.
```

The published image also serves the built web UI from the same process when
`WEB_ROOT` is set, which it is by default. One container, one port, no reverse
proxy required to get started. Unset it and the process is an API only, which is
what a split deployment behind a CDN wants.

```
backend/src/
  server.ts            composition root: build app, register modules, listen
  config.ts            environment parsing, fail-fast on anything missing
  contract/            byte-identical copies of the frontend's types.ts and search.ts
  db/                  pool, migration runner, query helpers
  lib/                 crypto, errors, ids
  modules/
    auth/              this app's own users and tokens — not mailbox credentials
    accounts/          CRUD, credential storage, priority, onboarding, verify
    folders/           tree, roles, subscription
    messages/          the query engine — the hot path
    drafts/            compose state
    views/             saved views
    unsubscribe/       List-Unsubscribe handling
    events/            SSE fan-out
  sync/
    pool.ts            IMAP connection pool with per-account limits
    engine.ts          the sync loop: claim → sync → release
    folders.ts         LIST/LSUB → folder rows
    envelopes.ts       incremental envelope fetch — the bulk of the work
    threading.ts       thread assembly
    bodies.ts          on-demand body fetch, sanitise, cache
    replay.ts          outbound flags, moves, deletes
    idle.ts            IDLE connections for push
  smtp/                outbound send
```

**Business logic never imports Fastify. Transport never imports `imapflow`.**
The seam is a plain function signature, which is why the whole API surface could
be swapped for the in-memory adapter without the UI noticing.

---

## The contract

`frontend/src/lib/types.ts` and `frontend/src/lib/search.ts` are copied
byte-for-byte into `backend/src/contract/`. `npm run contract:check` in the
backend fails if they drift.

This is the one piece of ceremony in the repository, and it earns its place: it
is what allows the frontend and the backend to be deployed — and rolled back —
independently. It is also why `search.ts` is an *executable* specification of
the search syntax rather than prose: both sides run the same parser, so a query
typed in the browser and the same query executed as SQL cannot disagree about
what it means.

The same idea covers `frontend/src/lib/query.ts` (list semantics) and
`url.ts` (the address bar), each with a check suite that asserts on exact
strings.

---

## Two adapters, on purpose

`frontend/src/lib/api.ts` defines `MailApi`. Two implementations satisfy it:

- `lib/mock/mock-api.ts` — in-memory, seeded, deterministic.
- `lib/http-api.ts` — the real backend.

The UI cannot tell them apart. That let the entire interface be designed,
built and demonstrated before the backend existed, and it is what the hosted
demo runs on today.

It is also a loaded gun, and the code says so out loud. A production build
defaults to the **http** adapter; `dev.sh` writes the choice into
`frontend/.env.local` rather than passing an env prefix, so it survives however
Vite ends up being started; and the app logs which adapter it built on boot. A
stale dev server serving the mock looks exactly like a working backend, and
every conclusion drawn from it is worthless.

---

## Security

**Mailbox credentials.** AES-256-GCM, key from `SECRET_KEY` (32 bytes, base64,
validated at boot), a unique nonce per record, auth tag stored separately.
Decrypted only inside the sync worker, into a short-lived buffer, never logged
and never returned by any endpoint. A `secret_key_version` column exists so the
key can be rotated with a dual-read pass.

**App auth.** The app's own users table, argon2id, an httpOnly + SameSite
session cookie, `Secure` when `APP_ORIGIN` is `https://`. No JWT in `localStorage` — this app renders untrusted
HTML, and a token reachable from JavaScript is a token an XSS steals.

**HTML sanitisation** happens on ingest, server-side, before anything is stored:
an allow-list of tags and attributes, no `<script>`, `<style>`, `<object>` or
`<form>`, no `on*` handlers, no `javascript:` or `data:` URIs except
`data:image/*`, and every link forced to `rel="noopener noreferrer nofollow"`.
Remote image URLs are rewritten to `data-src` so the client decides whether to
load them. The client renders into a shadow root on top of that.

**Rate limits.** Login is capped per IP. The verify endpoint is capped per user
because it makes outbound connections on user-supplied input — it is the
request-forgery surface, which is why private ranges are refused unless
`ALLOW_PRIVATE_IMAP_HOSTS` is explicitly on.

**CSRF.** Double-submit token, rotated per response, required on every non-GET.

**CORS.** Locked to `APP_ORIGIN`. No wildcard, ever.

**Agent tokens** are scoped (`read`, `write`, `unsubscribe`) and can only be
minted from a shell on the host. A credential that grants API access must not be
mintable through the API. Adding an account, changing a mailbox password and
deleting an account are closed to tokens at every scope, because those handle
credentials and a person should be present.

---

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Mail server unreachable | Reads keep working from the index. Sends queue. The account shows `connect_error` with the server's real error string. |
| Bad mailbox credentials | That account only: `auth_error`, sync stops for it, the sidebar offers a fix. The other accounts are untouched. |
| Postgres down | 503 everywhere. The one hard dependency. |
| Folder deleted server-side | Rows removed on the next folder pass; an open scope falls back to the unified inbox. |
| `UIDVALIDITY` change | That folder is re-indexed from scratch, and it is logged loudly — it usually means a maildir moved. |
| Send fails | The draft is restored in the composer with the SMTP error verbatim. Never silently dropped. |
| Sync worker crash | The advisory lock dies with the connection; another worker claims the account on the next tick. |

---

## Why the database is not precious

Everything in Postgres except your account settings is derivable. The mail lives
on your mail server; this index is a cache of its metadata. A total loss of this
database costs a resync, not mail.

That is the design working, and it is why the backup advice in
[self-hosting](self-hosting.md#backups) puts `SECRET_KEY` above the database
dump: the dump can be rebuilt from IMAP, and the key cannot be rebuilt from
anything.
