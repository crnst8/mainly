# Security

## Threat model, stated plainly

mainly holds the credentials to every mailbox you add to it, and it renders HTML
written by strangers. Those are the two things worth being careful about, and
they shape everything below.

It is **single-tenant software**. There is no open registration; users are
created from the host. Every query is scoped by user id, but the design goal is
"the operator and their mail", not "isolate mutually hostile tenants".

### Two things that are your call, and are off by default

1. **A first run listens on every interface, unless this machine has a public
   address.** `./mainly.sh start` sets `BIND_ADDRESS=0.0.0.0` on a laptop, a NAS
   or a home server, so LAN and Tailscale devices reach it without TLS — those
   networks are the trust boundary, and the login form and session cookie cross
   them in plaintext. On a machine that holds an internet-routable address, the
   first run binds that machine's private address instead and never `0.0.0.0`;
   published Docker ports sit in front of most host firewalls, so this is the
   decision that keeps a plaintext login form off the internet. `./mainly.sh
   bind local` narrows it to this machine. To go public, terminate TLS in front
   of it — see
   [docs/self-hosting.md](docs/self-hosting.md#putting-it-on-the-internet).
2. **`ALLOW_PRIVATE_IMAP_HOSTS` defaults to `false`.** Adding an account makes an
   outbound connection to a hostname you type in, so that endpoint is a
   request-forgery surface. Private, loopback, link-local and reserved
   destinations are refused unless you turn this on, which self-hosted setups
   reaching a mail server over a LAN or a VPN legitimately need to do. The
   refusal resolves the name first and compares addresses as bytes, so
   `localtest.me`, `2130706433` and `::ffff:7f00:1` are refused for the same
   reason `127.0.0.1` is — see `backend/src/lib/ip.ts`.
3. **`TRUST_PROXY` defaults to unset, meaning nothing.** `X-Forwarded-For` is a
   header anyone can send, so the client address is only as trustworthy as
   whatever is allowed to assert it — and the rate limits are keyed on it. Set
   it to the number of proxies in front (usually `1`) when you put one there;
   the app warns at boot if `APP_ORIGIN` is https and this is unset.

---

## What it defends against

**Mailbox credentials** are sealed with AES-256-GCM using `SECRET_KEY`, with a
unique nonce per record and the auth tag stored separately. They are decrypted
only inside the sync worker, into a short-lived buffer. No endpoint returns
them, and logs redact cookies, authorization headers and anything named
`password` unconditionally. A `secret_key_version` column exists so the key can
be rotated with a dual-read pass.

**Application sessions** are argon2id-hashed passwords and an httpOnly,
SameSite cookie, marked `Secure` when `APP_ORIGIN` is an `https://` URL. The
session id is stored as its sha256, never as the cookie value, so a database
dump records that sessions existed rather than handing over usable ones — the
rule `api_tokens` has always followed. Expired rows are swept hourly. A
plaintext install on a private network cannot use `Secure` — browsers discard
such a cookie — which is the cost of running one without TLS: anything on that
network path can read the session. There is deliberately no JWT in `localStorage`: this
app renders untrusted HTML, and a token reachable from JavaScript is a token an
XSS steals.

**Message HTML** is sanitised server-side on ingest, before storage, against an
explicit allow-list — no `<script>`, `<style>`, `<object>` or `<form>`, no `on*`
handlers, no `javascript:` or `data:` URIs except `data:image/*`, and every link
forced to `rel="noopener noreferrer nofollow"`. Remote image URLs are rewritten
to `data-src` so nothing loads until the reader asks. The client renders into a
shadow root on top of that.

**CSRF** uses a double-submit token, rotated per response, required on every
non-GET request. **CORS** is locked to `APP_ORIGIN` — never a wildcard, because
credentials ride on cookies.

**Rate limits** on login are keyed on the *account*, not the caller: there is no
lockout behind them, so the one thing that must hold is that five attempts a
minute stays five however many addresses they arrive from. The account-verify
endpoint — the one that makes outbound connections on user input — is limited
per user, and everything address-keyed depends on `TRUST_PROXY` being set
honestly.

**Agent tokens** are scoped (`read`, `write`, `unsubscribe`) and mintable only
from a shell on the host — a credential granting API access must not be
mintable through the API. Adding an account, changing a mailbox password and
deleting an account are closed to tokens at every scope. Bulk operations are
capped at 200 messages per call and support `dryRun`.

**Unsubscribe** POSTs to an HTTPS target only when the sender marked it
one-click (RFC 8058). Anything else comes back as a link for you to open.
Targets resolving to private or loopback addresses are refused. Every attempt is
recorded.

## Dependencies

The runtime image is the part that matters — a vulnerable package in `backend`
is reachable by anything that reaches the app, and `mailparser` in particular
runs against attacker-supplied bytes on every incoming message.

Three things keep that current, and none of them need anyone to remember:

- **`scripts/audit-check.mjs`** audits all three lockfiles and fails the build on
  a high in the runtime tree. Build-time-only advisories warn instead of
  blocking, because a gate that fails every open PR over a transitive dev
  dependency is a gate someone eventually deletes. It runs in `ci.yml` on every
  push and in `./dev.sh check` locally.
- **A weekly sweep** (`.github/workflows/audit.yml`) runs the same script on a
  schedule and files one issue, because advisories are published whether or not
  anyone has opened a PR that week. A clean run closes it again.
- **Dependabot** opens security PRs the moment an advisory lands, and grouped
  version PRs weekly. Majors come one at a time, since those need a changelog
  read rather than a rubber stamp.

Waiving one is deliberate: an entry in `.github/audit-allowlist.json` needs a
reason and an expiry, and the gate fails again once that date passes. There is
no way to permanently silence an advisory without saying why in the repo.

## What it does not defend against

- Someone with your `SECRET_KEY` and a copy of the database. That is the whole
  point of the key, and why it should live somewhere the database backups do
  not.
- Someone with shell access to the host.
- A malicious mail server you deliberately added an account on.
- Traffic analysis, or anything at the network layer that TLS does not cover.

---

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub's
[private vulnerability reporting](https://github.com/crnst8/mainly/security/advisories/new),
or email the address on <https://github.com/crnst8> with "mainly" in the
subject.

Expect an acknowledgement within a week. This is a personal project maintained
in spare time — there is no SLA, but reports are taken seriously and credited
unless you would rather not be.
