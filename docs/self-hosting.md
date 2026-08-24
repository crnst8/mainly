# Self-hosting

Everything past `./mainly.sh start`: putting it on the internet, keeping it
alive, and getting it back when something breaks.

- [What you need](#what-you-need)
- [Install](#install)
- [Adding mailboxes](#adding-mailboxes)
- [Putting it on the internet](#putting-it-on-the-internet)
- [Mail servers on a private network](#mail-servers-on-a-private-network)
- [Backups](#backups)
- [Updating](#updating)
- [When something is wrong](#when-something-is-wrong)
- [Running it bigger](#running-it-bigger)

---

## What you need

- **Docker**, version 20.10.13 or newer, with the `compose` plugin. That is the
  only requirement. The image covers amd64 and arm64, so a Raspberry Pi 4, an
  x86 VPS and an Apple Silicon Mac all work.
- **An IMAP/SMTP mail server you already have.** mainly is a client. It will not
  create mailboxes, change DNS, or touch your mail server's configuration.
- **About 1GB of RAM** for the two containers, and disk proportional to your
  mail: roughly 400MB of index per half-million messages. Bodies are cached with
  a TTL rather than stored.

You do **not** need Node, Postgres, nginx or a build toolchain. If you want to
run it without Docker at all, see [Contributing](../CONTRIBUTING.md) — the same
two processes run directly, but you are then maintaining Postgres yourself.

---

## Install

```sh
git clone https://github.com/crnst8/mainly && cd mainly
./mainly.sh start
./mainly.sh user you@yourdomain.com
```

The first run writes `.env` with generated secrets, pulls the image, starts
Postgres, applies migrations and waits until `/api/health` answers with a real
database round trip. The second prints a generated password; set your own with
`PASSWORD='…' ./mainly.sh user you@yourdomain.com`.

It then prints every URL that reaches it. On a machine with no internet-facing
address — a laptop, a NAS, a home server — that is **every interface**: the LAN
address, the Tailscale address and localhost all answer, over plain HTTP, with
no proxy and no certificate. Open one from your phone and sign in.

```sh
./mainly.sh bind             # the current setting, and every URL that reaches it
./mainly.sh bind tailscale   # narrow it to the tailnet
./mainly.sh bind local       # narrow it to this machine
./mainly.sh bind 10.0.0.4    # or one address you name
```

A machine that *does* hold a public address is the exception: the first run
binds its private address only. Docker's published ports are inserted ahead of
most host firewalls, so `0.0.0.0` there would put an unencrypted login form on
the internet — never a default.

Two things that only work over HTTPS, whatever you bind: installing the app to
a home screen (a service worker needs a secure context), and the `Secure` flag
on the session cookie. Over plain HTTP the cookie is still `HttpOnly` and
`SameSite=Strict`, but anything on the network path can read it.

There is no open registration. Every user of a self-hosted mail client is its
operator, so accounts are created from the host.

**Back up `SECRET_KEY` from `.env` now.** It encrypts every stored mailbox
password. Losing it does not lose mail, but it does mean re-entering every
mailbox credential by hand.

---

## Adding mailboxes

From the account screen. Type an address and mainly attempts autoconfig
discovery; correct anything it guessed wrong, and it verifies the settings by
actually connecting before it stores anything.

If many mailboxes share one server — the usual case for a domain you own —
use the bulk importer instead. One server template, a list of addresses and
passwords, verified and created in a single pass. Rows that fail come back
individually, so one wrong password does not discard the rest.

Each account gets a **priority tier** (critical, high, normal, low, muted) and
inherits a colour from its domain. Both are what make a twelve-account unified
list readable, and both are worth setting deliberately rather than leaving at
the default.

---

## Installing it as an app

A browser offers "install this app" only where the page may register a service
worker, and only a **secure origin** may: `https://`, or `localhost`. A LAN
address or a tailnet address over plain HTTP is not one, however private that
network actually is — so on `http://100.64.0.2:5274` the install option simply
does not appear, and nothing in the app can conjure it.

That leaves one requirement: a hostname with a certificate. Two routes get
there without exposing anything to the internet.

### Tailscale, if Tailscale runs your tailnet

```sh
./mainly.sh tls tailscale
```

`tailscale serve` terminates TLS in front of mainly using your tailnet's own
certificate, on your node's MagicDNS name, reachable by tailnet devices and
nothing else. The command points `APP_ORIGIN` at it and restarts the container.

It needs HTTPS certificates enabled for the tailnet — admin console → **DNS** →
**HTTPS Certificates**. A self-hosted control server (Headscale) issues no
certificates at all, so use the next route there.

Plain HTTP on the LAN keeps working alongside it: the session cookie is marked
`Secure` per request, not per install, so the same instance can serve a
certificate to one device and plaintext to another.

### A hostname you own, on any private address

This works everywhere — Headscale, a plain LAN, a VPN — and needs no inbound
port, because the certificate is proved over DNS rather than over HTTP.

1. Point a hostname you own at the private address: an `A` record for
   `mail.example.com` → `100.64.0.2`. Public DNS answering with a private
   address is fine, and unreachable to anyone not on that network.
2. Put Caddy in front, with a DNS-01 certificate. `docker-compose.override.yml`
   beside the main compose file:

   ```yaml
   services:
     proxy:
       image: ghcr.io/caddybuilds/caddy-cloudflare:latest
       restart: unless-stopped
       depends_on: [app]
       environment:
         CF_API_TOKEN: ${CF_API_TOKEN:?a Cloudflare token with DNS:Edit on the zone}
         MAINLY_HOSTNAME: ${MAINLY_HOSTNAME:?the hostname above}
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile:ro
         - caddy-data:/data
       ports:
         - '${BIND_ADDRESS:-0.0.0.0}:443:443'

   volumes:
     caddy-data:
   ```

   ```caddyfile
   # Caddyfile
   {$MAINLY_HOSTNAME} {
       tls {
           dns cloudflare {$CF_API_TOKEN}
       }
       reverse_proxy app:5274
   }
   ```

   The image is Caddy built with the Cloudflare DNS module; other providers have
   equivalents, and `caddy-dns/*` on GitHub lists them.
3. Add `CF_API_TOKEN` and `MAINLY_HOSTNAME` to `.env`, then:

   ```sh
   ./mainly.sh origin https://mail.example.com
   ./mainly.sh start
   ```

Open the hostname from a phone on that network and the install prompt is there.

## Putting it on the internet

A private network is one thing; the internet is another. **Do not leave it on
plaintext and open the port** — that publishes a login form and a session cookie
to anyone who looks. Terminate TLS in front of it instead.

Narrow the binding to the loopback first, so the proxy is the only way in and
always has a stable target:

```sh
./mainly.sh bind local
```

Then point `APP_ORIGIN` at the public URL — `https://` is also what marks the
session cookie `Secure`:

```sh
./mainly.sh origin https://mail.example.com
```

Both rewrite `.env` and restart the container. CORS is checked against
`APP_ORIGIN`, and naming a host the app does not actually answer on presents as
"signed out immediately after signing in".

### Caddy

The shortest path — it obtains and renews the certificate itself.

```caddyfile
mail.example.com {
    reverse_proxy 127.0.0.1:5274
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mail.example.com;

    ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;

    # Attachments.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:5274;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Live updates are server-sent events. Buffering here holds every event
    # until the buffer fills, which presents as "new mail takes minutes to
    # appear". The app also sends X-Accel-Buffering: no; this makes it explicit
    # so it cannot regress behind a config change.
    location /api/events {
        proxy_pass http://127.0.0.1:5274;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        chunked_transfer_encoding off;
        proxy_read_timeout 24h;
    }
}
```

### Traefik, Tailscale, Cloudflare Tunnel

All fine. Anything that terminates TLS and forwards to `127.0.0.1:5274` works.
Two requirements, whatever you pick:

1. `APP_ORIGIN` matches the public URL exactly.
2. Response buffering is off for `/api/events`, or live updates arrive in
   batches when a buffer happens to fill.

A Tailscale-only deployment is a legitimate answer here: no public exposure, and
the mail client is reachable from every device you own — `./mainly.sh tls
tailscale` sets that up in one command, and
[Installing it as an app](#installing-it-as-an-app) covers what a certificate
buys you beyond privacy.

---

## Mail servers on a private network

If your mail server is on a LAN, a VPN or Tailscale, two settings apply.

```sh
ALLOW_PRIVATE_IMAP_HOSTS=true
MAIL_HOST_OVERRIDE=mail.example.com=100.64.0.1
```

`ALLOW_PRIVATE_IMAP_HOSTS` lets the verify step connect to private addresses.
It is off by default because that endpoint takes a hostname you supply and opens
a connection to it, which is a request-forgery surface. Turning it on is
reasonable and deliberate; leaving it on when your mail server is public is not.

`MAIL_HOST_OVERRIDE` is the part people get wrong. Connecting to a mail server
by IP fails TLS hostname validation, because the certificate is for
`mail.example.com` and not for `100.64.0.1`. The fix is to pin the hostname to
the address, so SNI and certificate validation both use the real name while the
packets take the private route. The other fix — disabling certificate
verification — is not a trade worth making for the credential that opens your
mail.

---

## Backups

**In order of how much it hurts to lose:**

1. **`SECRET_KEY`** from `.env`. Not in any database dump. Store it somewhere
   that is not this machine.
2. **The Postgres volume** — accounts, preferences, saved views, labels, drafts.
3. Nothing else. Message metadata is a *cache*; your mail server holds the mail,
   and a full loss of this database costs a resync.

```sh
./mainly.sh backup              # → ./backups/mainly-<timestamp>.sql.gz
./mainly.sh restore backups/mainly-20260819-131500.sql.gz
```

Nightly, from cron:

```cron
15 3 * * * cd /opt/mainly && ./mainly.sh backup /var/backups/mainly >/dev/null
20 3 * * * find /var/backups/mainly -name '*.sql.gz' -mtime +30 -delete
```

Test a restore into a throwaway copy once a quarter. An untested backup is a
hope, not a backup.

---

## Updating

```sh
./mainly.sh update
```

Pulls the current image and restarts. Migrations run themselves — the server
awaits them before it listens — so there is no separate step and no window where
the app is running against an older schema.

Migrations are **forward-only and additive**: a column is added, backfilled, and
read from in one release, and dropped in a later one. Any two adjacent versions
therefore run against the same schema, so rolling the image back is safe.
Rolling back across several versions is a restore from backup.

To pin a version rather than tracking `latest`:

```sh
# .env
MAINLY_VERSION=1.2.0
```

Releases are at <https://github.com/crnst8/mainly/releases>.

---

## When something is wrong

```sh
./mainly.sh status      # container state and a health check
./mainly.sh logs        # follow the app
./mainly.sh logs db     # follow Postgres
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signed out immediately after signing in | `APP_ORIGIN` does not match the URL in the address bar | Correct it in `.env`, `./mainly.sh restart` |
| One account shows **Sign-in failed** | That mailbox's password changed or was revoked | Fix credentials on the account. The other accounts are unaffected by design |
| One account shows **Cannot connect** | Mail server unreachable from the container | Check the host and port; if it is on a private network see the section above |
| Everything 503s | Postgres is down. It is the one hard dependency | `./mainly.sh logs db` |
| New mail takes minutes to appear | A reverse proxy is buffering `/api/events` | Turn buffering off for that path |
| The app will not start, log says `SECRET_KEY must decode to 32 bytes` | The key is truncated or not base64 | `openssl rand -base64 32`, and re-add accounts if the old key is gone |
| Container restarts in a loop | Healthcheck failing — it does a real database round trip | `./mainly.sh logs` will say which dependency |

Account-level failures surface **in the app**, on the account, carrying the mail
server's own error text. That is deliberate: it is the alert that matters, and
it reaches the only person who can act on it.

---

## Running it bigger

One container handles a personal install with dozens of mailboxes comfortably.
The path out, in order, without a rewrite:

1. **Split the roles.** `ROLE=api` behind a load balancer, `ROLE=sync` as a
   separate deployment. Sync workers claim accounts with Postgres advisory
   locks, so more than one worker needs no coordination and no scheduler.
2. **Redis for sessions**, once more than one API replica exists. Sessions live
   in Postgres today precisely so a single-container install needs no Redis.
3. **A Postgres read replica** for the list query; sync keeps the primary.

The knobs that actually matter under load are `IMAP_POOL_MAX`,
`IMAP_PER_ACCOUNT_MAX`, `SYNC_INTERVAL_MS` and `IMAP_IDLE_MAX_ACCOUNTS`. The
IMAP ones are bounded by what your mail server permits — Dovecot's
`mail_max_userip_connections` defaults to 10.
