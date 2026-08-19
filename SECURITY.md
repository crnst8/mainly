# Security

## Threat model, stated plainly

mainly holds the credentials to every mailbox you add to it, and it renders HTML
written by strangers. Those are the two things worth being careful about, and
they shape everything below.

It is **single-tenant software**. There is no open registration; users are
created from the host. Every query is scoped by user id, but the design goal is
"the operator and their mail", not "isolate mutually hostile tenants".

### Two things that are your call, and are off by default

1. **`BIND_ADDRESS` defaults to `127.0.0.1`.** Setting it to `0.0.0.0` puts a
   login form and a session cookie on your network in plaintext. Terminate TLS
   in front of it instead — see
   [docs/self-hosting.md](docs/self-hosting.md#putting-it-on-the-internet).
2. **`ALLOW_PRIVATE_IMAP_HOSTS` defaults to `false`.** Adding an account makes an
   outbound connection to a hostname you type in, so that endpoint is a
   request-forgery surface. Private, loopback, link-local and reserved
   destinations are refused unless you turn this on, which self-hosted setups
   reaching a mail server over a LAN or a VPN legitimately need to do.

---

## What it defends against

**Mailbox credentials** are sealed with AES-256-GCM using `SECRET_KEY`, with a
unique nonce per record and the auth tag stored separately. They are decrypted
only inside the sync worker, into a short-lived buffer. No endpoint returns
them, and logs redact cookies, authorization headers and anything named
`password` unconditionally. A `secret_key_version` column exists so the key can
be rotated with a dual-read pass.

**Application sessions** are argon2id-hashed passwords and an httpOnly,
SameSite, Secure cookie. There is deliberately no JWT in `localStorage`: this
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

**Rate limits** apply to login per IP and to the account-verify endpoint per
user, that being the endpoint that makes outbound connections on user input.

**Agent tokens** are scoped (`read`, `write`, `unsubscribe`) and mintable only
from a shell on the host — a credential granting API access must not be
mintable through the API. Adding an account, changing a mailbox password and
deleting an account are closed to tokens at every scope. Bulk operations are
capped at 200 messages per call and support `dryRun`.

**Unsubscribe** POSTs to an HTTPS target only when the sender marked it
one-click (RFC 8058). Anything else comes back as a link for you to open.
Targets resolving to private or loopback addresses are refused. Every attempt is
recorded.

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
