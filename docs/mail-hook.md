# Mail hook

**Have your Dovecot server tell mainly which mailboxes changed, as they change,
instead of mainly polling for them.**

Optional, and off unless you install it. Without it, mainly learns about new
mail through IMAP `IDLE` on each account's inbox and polls everything else
(other folders every 15 minutes, accounts without IDLE every 2). With it, every
change on the server — delivery, a move or flag from your phone, a folder made
in another client, a Sieve rule filing mail — reaches mainly within a second or
two, for every folder of every account on that server.

```sh
./mainly.sh hook connect <ssh-host>
```

One command, run on the machine running mainly. It reaches the mail server over
SSH, installs a small Lua script into Dovecot, and tests the whole path before
it says it is done.

---

## Is this for you

**Yes, if** you run your own Dovecot 2.3 server, have SSH with root or
passwordless sudo on it, and want mail filed into folders other than the inbox
(by Sieve, by another client, by server-side rules) to show up without waiting
for a poll.

**No, if** your mail is with a provider you do not administer. IDLE and polling
keep working exactly as before.

**What it changes on the mail server.** Two files next to Dovecot's config and a
reload. It does not touch mail, Postfix, Sieve scripts or any existing Dovecot
setting; it adds plugins to the protocols that change mail and leaves every
plugin list it found in place. `hook remove` takes both files out again.

---

## Setting it up

```sh
./mainly.sh hook connect <ssh-host> [--url URL] [--imap-host HOST]… [--user LOGIN]
./dev.sh hook connect <ssh-host> --url URL        # against a dev checkout
```

`<ssh-host>` is how `ssh` reaches the mail server: an alias from
`~/.ssh/config`, or `user@host`. Key authentication is required.

| Option | Default |
| --- | --- |
| `--url` | `APP_ORIGIN`, then this host's Tailscale and LAN addresses, each tried *from the mail server*. The first that answers `/api/health` is used. |
| `--imap-host` | The only IMAP host your accounts use; with several, the ones the server's TLS certificates name (one server often has a name per domain). Name them yourself when the certificates do not. Repeatable. |
| `--user` | The first working account on those hosts. Used only for the test. |

What it does:

1. Works out which IMAP hostnames the hook speaks for.
2. Finds an address of this install the mail server can reach.
3. Checks the server: root, Dovecot 2.3, the Lua push plugins present
   (Debian and Ubuntu ship them in `dovecot-core`), a free
   `push_notification_driver` slot.
4. Mints a hook token here.
5. Writes `mainly-hook.lua` and `conf.d/99-mainly-hook.conf` (or
   `mainly-hook.conf` plus an include line, when Dovecot's config does not read
   `conf.d/`), checks the result with `doveconf`, and reloads Dovecot. If any of
   that fails, the server is put back as it was and the token is removed.
6. Flips one login's INBOX subscription and flips it back — no mail is
   touched — and waits for the notice to arrive.

Run it again at any time: it replaces the token and the files.

```sh
./mainly.sh hook list                         # hooks, their hosts, last notice
./mainly.sh hook remove <ssh-host> [--imap-host HOST]
```

---

## How it works

The Lua script runs inside Dovecot's own processes (`imap`, `lmtp`, `lda`,
`pop3`, `doveadm`) as a `push_notification` driver. At the end of each mailbox
transaction it sends one request:

```http
POST /api/hooks/mail
Authorization: Bearer mh_…
Content-Type: application/json

{"user":"you@example.com","mailboxes":["INBOX","Receipts"],"folders":false}
```

mainly answers `202` at once, finds the accounts with that login on the hook's
hosts, and runs a pass over just those folders — the same pass IDLE triggers
for the inbox (`backend/src/sync/folder-pass.ts`). Bursts are coalesced: a
client moving fifty messages one at a time causes one pass, not fifty.
`"folders": true` (a folder was made, deleted, renamed or subscribed) re-reads
the folder list first.

Polling does not stop; it becomes the floor beneath push. While a hook has been
heard from in the last hour, accounts on its hosts are polled every
`SYNC_IDLE_INTERVAL_MS` (15 minutes) instead of every `SYNC_INTERVAL_MS`. IDLE
keeps running alongside it.

### What it costs the mail server

The request is made inside Dovecot, in the path of delivery and of every other
client's commands, so the script is written never to slow them down:

- The whole request, connecting included, is abandoned after one second.
- After a failure, an IMAP session stops sending for a minute, so a phone
  flagging messages while mainly is down waits at most one second per minute.
  Each delivery has its own session, so while mainly is *unreachable* each
  delivered message waits at most one second. A refused connection (mainly
  stopped, host up) fails at once.
- Every failure is caught and logged as `mainly-hook:` in Dovecot's log; mail
  is always delivered.

A missed notice is safe. The next poll picks the change up.

---

## Security

- **What is sent:** the login, mailbox names, and whether the folder list
  changed. Never a sender, subject, flag or body; mainly reads those over IMAP
  as it always has.
- **The token** (`mh_…`) is minted only from a shell on mainly's host
  (`backend/src/cli/hook.ts`), crosses SSH on stdin, is never printed, and is
  stored only in the Dovecot config file (`0640 root:dovecot`). mainly keeps
  its SHA-256.
- **What a token can do:** make mainly look at folders on the hosts it was
  created for, sooner than it would have. It cannot read or change mail, name a
  different host, or tell whether a login has an account here — an unknown
  login is answered `202` like any other.
- **Accounts whose password is being refused are skipped**, so a notice cannot
  retry a failing login into a lockout.
- The endpoint is rate limited (1,200 a minute) and sits outside session and
  agent-token auth: the only credential it accepts is a hook token.
- Use `https` or a Tailscale address for `--url`; over plain http on a network
  you do not control, the token travels in the clear. The installer warns.

---

## When something is wrong

| Symptom | Check |
| --- | --- |
| `None of those addresses answer from <host>` | The mail server cannot reach mainly. Pass the address it can reach with `--url`, e.g. a Tailscale address. |
| `lacks the Lua push plugins` | Install your distribution's Dovecot Lua package. Debian and Ubuntu: `dovecot-core` has them. |
| `Dovecot 2.4 …` | Not supported yet; see [Doing it by hand](#doing-it-by-hand). |
| `Something later in Dovecot's config replaces mail_plugins` | A file read after `99-mainly-hook.conf` (often `local.conf`) sets `mail_plugins` for `imap` or `lmtp` without `$mail_plugins`. Add `$mail_plugins` there and run `hook connect` again. |
| `no notice arrived here within 10 seconds` | `doveadm log errors \| grep mainly-hook` on the mail server shows what the script saw: a status of `401` is a stale token (run `connect` again), a 9000-range status is a connection failure. |
| `hook list` shows an old "last notice" | Nothing has changed on the server since, or the hook stopped. Deliver a message and look again. |

---

## Doing it by hand

For Dovecot 2.4, or a server the installer cannot reach. Mint a token on
mainly's host:

```sh
./mainly.sh hook create mail.example.com     # prints the token once; ./dev.sh hook create in a checkout
```

Copy `scripts/mainly-hook.lua` to `/etc/dovecot/mainly-hook.lua`, then for 2.3
write `/etc/dovecot/conf.d/99-mainly-hook.conf`, mode `0640 root:dovecot`:

```
protocol imap {
  mail_plugins = $mail_plugins notify push_notification mail_lua push_notification_lua
}
protocol lmtp {
  mail_plugins = $mail_plugins notify push_notification mail_lua push_notification_lua
}
protocol doveadm {
  mail_plugins = $mail_plugins notify push_notification mail_lua push_notification_lua
}
plugin {
  push_notification_driver = lua:file=/etc/dovecot/mainly-hook.lua
  mainly_hook_url = https://mainly.example.com/api/hooks/mail
  mainly_hook_token = mh_…
}
```

Use protocol blocks, not a global `mail_plugins` line: a global line written
after the protocol blocks in `20-lmtp.conf` and friends does not reach them,
and `$mail_plugins` inside a protocol block keeps that protocol's own plugins
(Sieve on LMTP, for one). Then `doveconf -n >/dev/null && doveadm reload`.

Dovecot 2.4 changed how plugins are configured (there is no `plugin {}`
block). The script and installer have been tested on 2.3 only (2.3.19 from
Debian 12, and 2.3.21), so the installer stops on 2.4 rather than guess.

---

## Files

| File | What |
| --- | --- |
| `scripts/mainly-hook.lua` | The Dovecot side. |
| `scripts/connect-mailhook.sh` | The installer behind `mainly.sh hook` and `dev.sh hook`. |
| `backend/src/modules/hooks/` | Tokens, the route, which notices to believe. |
| `backend/src/sync/mail-hook.ts` | Which accounts a notice is about; schedules passes. |
| `backend/src/sync/folder-pass.ts` | The pass, shared with IDLE. |
| `backend/src/cli/hook.ts` | Token administration. |
| `backend/migrations/019_mail_hooks.sql` | The table. |
