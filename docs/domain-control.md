# Domain control

**Let mainly create and remove email addresses on your own mail server.**

Optional, off by default, and turned on one domain at a time. An install that
connects no domain behaves exactly as it always has: it holds one credential per
mailbox and never writes to the mail server.

- **Setting it up?** Start at [Before you start](#before-you-start) and work
  down. About 15 minutes, once per mail server.
- **Already set up?** [Using it](#using-it).
- **Writing the server side?** [`scripts/mainly-provision.md`](../scripts/mainly-provision.md).

---

## Contents

1. [Is this for you](#is-this-for-you)
2. [How it works](#how-it-works)
3. [Before you start](#before-you-start)
4. [Part 1 — the mail server](#part-1--the-mail-server)
5. [Part 2 — mainly](#part-2--mainly)
6. [Using it](#using-it)
7. [The audit trail](#the-audit-trail)
8. [Troubleshooting](#troubleshooting)
9. [Turning it off](#turning-it-off)
10. [Supporting another mail server](#supporting-another-mail-server)

---

## Is this for you

**Yes, if** you run your own Postfix + Dovecot server, you add or retire
addresses often enough that doing it by hand is a chore, and you have root on
that machine.

**No, if** your mail is with a provider you do not administer (Fastmail, Migadu,
Google), or you add an address twice a year. Nothing else in mainly depends on
this, and skipping it costs you nothing.

**What it changes.** [architecture.md](architecture.md) lists *"the mail server
is read-only infrastructure"* as a founding constraint — it is why mainly runs
against anything. This makes that the **default** rather than the only mode. The
constraint is not removed; it is opted out of, per domain, deliberately.

---

## How it works

Three gates. An operation has to pass all three, and they are deliberately not
stored in the same place.

| Gate | Lives in | Decides |
| --- | --- | --- |
| Driver capability | This codebase | What this kind of mail server can do at all |
| App grants | `mail_domains.grants`, in mainly's Postgres | What this install has been told it may do |
| **Server allowlist** | `/etc/mainly-provision.conf`, on the mail server | What the mail server will actually agree to |

**The third gate is the one that matters**, because it is the one mainly cannot
write. If mainly's database were compromised and every grant in it switched on,
the mail server would still refuse every domain and verb its own file does not
name.

```
mainly                          your mail server
  │                                │
  │  ssh — key pinned to           │  ~mailprov/.ssh/authorized_keys
  │  one forced command            │    command="sudo mainly-provision --stdin",restrict
  ├───────────────────────────────►│      │
  │  verb on stdin                 │      ▼
  │  password on the next line     │  /usr/local/sbin/mainly-provision
  │                                │      │  validates every token
  │◄───────────────────────────────┤      │  checks /etc/mainly-provision.conf
        one JSON object            │      ▼
                                   │  vmaps + dovecot users, under flock,
                                   │  atomic, rolled back if they disagree
```

### The grants

| Grant | Allows |
| --- | --- |
| `list` | See which addresses exist |
| `create` | Create new addresses |
| `delete` | Remove addresses — the delivered mail stays on disk |
| `password` | Change a mailbox password |
| `alias` | Add and remove aliases |
| `purge` | *Also* delete the stored mail when removing an address |

Connecting a domain grants **none** of these.

`purge` is separate from `delete` because retiring an address and destroying
years of mail are different decisions that happen to share a button. `delete`
alone stops the address receiving and leaves the Maildir untouched, so
recreating the address brings everything back.

---

## Before you start

You will need:

- **Root on the mail server**, and the mail server running Postfix with
  `virtual_mailbox_maps` (a hash map), delivering over LMTP to Dovecot, with
  Dovecot authenticating from a `passwd-file`. This is what
  [mailstack](https://github.com/crnst8/mailstack) produces.
- **A shell on the machine running mainly.** Connecting a domain installs an SSH
  key, so it cannot be done from a browser.

Confirm the mail server is the right shape:

```sh
postconf -h virtual_mailbox_maps virtual_transport
# hash:/etc/postfix/vmaps
# lmtp:unix:private/dovecot-lmtp

doveconf -n passdb
# passdb {
#   args = scheme=PLAIN username_format=%u /etc/dovecot/users
#   driver = passwd-file          ← this is the line that matters
# }
```

Different paths are fine — they are configurable. A different *shape* (SQL or
LDAP backed) is not supported by the `ssh` driver; see
[Supporting another mail server](#supporting-another-mail-server).

Check the two files agree with each other before you begin. If they do not,
fix that first — provisioning refuses to run on a host in that state, for
[good reason](#parity):

```sh
diff <(awk 'NF{print $1}' /etc/postfix/vmaps | sort) \
     <(awk -F: 'NF{print $1}' /etc/dovecot/users | sort) && echo "in parity"
```

---

## Part 1 — the mail server

Every command in this part runs **on the mail server**, as a user with sudo.

### 1.1 Install the helper

Copy `scripts/mainly-provision` from this repository to the mail server, then:

```sh
sudo install -m 0755 -o root -g root mainly-provision /usr/local/sbin/
```

### 1.2 Say what it may do

```sh
sudo tee /etc/mainly-provision.conf >/dev/null <<'EOF'
# Paths only need a line when they differ from these defaults:
# vmaps    /etc/postfix/vmaps
# users    /etc/dovecot/users
# aliases  /etc/postfix/virtual_aliases
# mailroot /var/mail
# scheme   SHA512-CRYPT
# reload   postfix

# domain <name> <comma-separated grants>
domain example.com  list
EOF
sudo chmod 0644 /etc/mainly-provision.conf
```

**Start with `list` alone.** It proves the whole path works while nothing is
able to change anything. Widen it in [step 2.5](#25-grant-something), once you
have seen it work.

**Choosing `scheme`.** It applies only to passwords set from now on; existing
entries keep whatever they were hashed with, and a passwd-file holding a mix is
normal and works fine. So pick the strongest your Dovecot supports rather than
matching the majority:

```sh
doveadm pw -l                     # what this Dovecot can do
sudo awk -F: '{print $2}' /etc/dovecot/users \
  | grep -o '^{[^}]*}' | sort | uniq -c     # what is in use now
#   7 {ARGON2ID}
#  31 {SHA512-CRYPT}
```

`ARGON2ID` if it is listed, `SHA512-CRYPT` otherwise. Both are verified against
this helper.

**Verify:**

```sh
echo probe | sudo /usr/local/sbin/mainly-provision --stdin
```

You should get one line of JSON naming your Postfix and Dovecot versions,
`"parity":true`, and your domain with its grants.

### 1.3 Create the account it runs as

```sh
sudo adduser --system --group --shell /bin/sh \
     --home /home/mailprov --disabled-password mailprov
```

> ### ⚠ `--shell /bin/sh`, not `/usr/sbin/nologin`
>
> sshd runs a forced command **through the account's login shell**. With
> `nologin` the connection is accepted, the shell prints `This account is
> currently not available.`, and the script never runs — so everything looks
> correctly configured and every call fails with *"did not answer with a
> provisioning reply"*.
>
> The account is still locked down. `--disabled-password` means no password
> login, and the forced command below means the only thing its key can do is run
> one script.

### 1.4 Give it sudo for exactly one path

```sh
echo 'mailprov ALL=(root) NOPASSWD: /usr/local/sbin/mainly-provision' \
  | sudo tee /etc/sudoers.d/mainly-provision
sudo chmod 0440 /etc/sudoers.d/mainly-provision
```

**Verify** — this must print `parsed OK` before you log out, or you risk a
broken sudoers file:

```sh
sudo visudo -c
```

---

## Part 2 — mainly

Every command in this part runs **on the machine running mainly**.

### 2.1 Make a key for it

```sh
ssh-keygen -t ed25519 -f ~/.ssh/mainly_provision -N '' -C mainly-provision
```

No passphrase: mainly uses this unattended. Its power is bounded by the forced
command and the server's allowlist, not by a passphrase nobody is present to
type.

### 2.2 Pin it to the command

Copy `~/.ssh/mainly_provision.pub` to the mail server, then **on the mail
server**:

```sh
sudo mkdir -p /home/mailprov/.ssh
printf 'command="sudo /usr/local/sbin/mainly-provision --stdin",restrict %s\n' \
  "$(cat mainly_provision.pub)" | sudo tee /home/mailprov/.ssh/authorized_keys
sudo chown -R mailprov:mailprov /home/mailprov/.ssh
sudo chmod 700 /home/mailprov/.ssh
sudo chmod 600 /home/mailprov/.ssh/authorized_keys
```

`restrict` denies port forwarding, agent forwarding, a PTY, X11 and
`~/.ssh/rc`, so the key cannot open a shell or tunnel — only cause that one
script to run.

**Verify, from the mainly host:**

```sh
echo probe | ssh -i ~/.ssh/mainly_provision mailprov@mail.example.com
```

JSON means the whole chain works. Anything else — see
[Troubleshooting](#troubleshooting).

### 2.3 Connect the domain

```sh
./mainly.sh domain add you@example.com example.com \
  --host mail.example.com --key ~/.ssh/mainly_provision
```

Add `--port 2222` if sshd is not on 22, and `--user` if the account is not
`mailprov`.

The host key is read and pinned here, and printed so you can compare it against
the server:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # on the mail server
```

An unpinned domain is refused rather than trusted — trust on first use is a
decision to make once, visibly, not something to do silently on every
connection.

### 2.4 Ask the server what it allows

```sh
./mainly.sh domain probe you@example.com example.com
```

```
example.com: ok
  postfix 3.8.6 · dovecot 2.3.21
  server allows: list
```

### 2.5 Grant something

Nothing is granted yet. `list` is the safe first step:

```sh
./mainly.sh domain grant you@example.com example.com list
./mainly.sh domain mailboxes you@example.com example.com
```

Seeing your real addresses means every layer works. Now widen — **on the mail
server first**, because it is the gate that decides:

```sh
sudo sed -i 's/^domain example.com .*/domain example.com list,create,delete/' \
  /etc/mainly-provision.conf
```

Then in mainly:

```sh
./mainly.sh domain probe you@example.com example.com
./mainly.sh domain grant you@example.com example.com list,create,delete
```

Granting more here than the server permits is harmless — the extra simply never
takes effect, and the settings screen shows it greyed out with the reason.

---

## Using it

### In the browser

**Settings → Mail server.** Each connected domain shows its host, when it was
last checked, the grant switches, and — once `list` is on — the addresses that
exist.

A grant the mail server will not permit is shown switched off and disabled, with
the reason, rather than hidden. A control that vanishes sends someone hunting
for a setting that is working exactly as intended.

Creating an address offers to add the mailbox to this install in the same step,
because that is the one moment the password is known. Removing one asks for the
address to be typed back, and says plainly whether the mail is being kept or
destroyed.

### From the command line

```sh
./mainly.sh domain list      you@example.com
./mainly.sh domain probe     you@example.com example.com
./mainly.sh domain mailboxes you@example.com example.com
./mainly.sh domain create    you@example.com hello@example.com
./mainly.sh domain delete    you@example.com hello@example.com [--purge]
./mainly.sh domain grant     you@example.com example.com list,create
./mainly.sh domain ops       you@example.com
./mainly.sh domain forget    you@example.com example.com
./mainly.sh domain hostkey   --host mail.example.com
```

`create` prints a generated password once, or reads one from stdin:

```sh
echo 'a-password-you-chose' | ./mainly.sh domain create you@example.com hello@example.com
```

`forget` removes the credential and the grants from mainly's database. It
touches no address and no mail.

In development, `./dev.sh domain …` is the same thing against a local checkout.

### From an agent

Needs a token with the `provision` scope — separate from `write` on purpose, so
an agent that files and flags mail cannot also mint addresses.

```sh
./mainly.sh token create you@example.com "provisioner" --scopes read,provision
```

Tools: `mail_domains`, `mail_addresses`, `mail_create_address`,
`mail_delete_address`. See [mcp.md](mcp.md).

Installing or replacing the SSH key is closed to tokens at **any** scope. A
credential that widens what the application can do must not be installable by
something that already holds API access.

---

## The audit trail

Every attempt to change something on a mail server is recorded, successful or
not — the same reasoning as the unsubscribe log: it reaches something outside
mainly, and it is not undoable.

```sh
./mainly.sh domain ops you@example.com
```

```
2026-09-03T00:33:50.642Z  ok      delete       hello@example.com  (session)
2026-09-03T00:33:13.610Z  ok      create       hello@example.com  (session)
2026-09-03T00:32:39.191Z  FAILED  create       hello@example.com  (provisioner)
  example.com grants: list
```

`(session)` is a person in a browser or at the CLI; anything else is the name of
the API token that did it. Records outlive the domain — "who deleted that
address, and when" is most often asked after the domain has been disconnected.

Also in **Settings → Mail server → History**.

---

## Troubleshooting

### Start here

```sh
./mainly.sh domain probe you@example.com example.com
```

That one command exercises the whole chain and names the layer that failed.

| What you see | What it means | Fix |
| --- | --- | --- |
| `domain_not_allowed` | The domain is not in `/etc/mainly-provision.conf`. | Add a `domain` line there. |
| `verb_not_granted` | Listed, but not that verb. **This is the server refusing, not mainly.** | Widen the server's line, then `domain probe`. |
| `'x' is not granted` | mainly's own grants, before anything reaches the wire. | `./mainly.sh domain grant …` |
| *"did not answer with a provisioning reply"* | The key reached a shell rather than the script. | Check `command=` in `authorized_keys`, and that the account's shell is **not** `nologin`. |
| `lock_busy` | Another operation is running. | Try again. There is no queue, deliberately. |
| `parity_broken` | The two files disagree. Both were restored. | See [Parity](#parity). |
| Host key mismatch | The server's key changed, or something is in the way. | Confirm with `ssh-keygen -lf` on the server *before* re-pinning. |
| `No host key is pinned` | The domain was added without one. | `./mainly.sh domain forget …` then add it again. |
| `Connection refused`, intermittently | sshd is socket-activated and its burst limit tripped. | It clears on its own in a minute. mainly reuses one connection precisely to avoid this; something else is likely also connecting. |
| `permission denied` from `doveadm` | The helper is not running as root. | Check the `sudoers.d` line and that `command=` includes `sudo`. |
| `postmap_failed`, and `postmap` says `Permission denied` even as root | Postfix refuses to write a `.db` into a directory root does not own — it happens when the maps have been pointed somewhere like `/tmp`. | Keep the maps in a root-owned directory. `/etc/postfix` and `/etc/dovecot` already are. |

### Isolating which half is broken

Work outwards. Each step tests one more layer than the last:

```sh
# 1. The script, on the mail server, alone.
echo probe | sudo /usr/local/sbin/mainly-provision --stdin

# 2. The forced command, over SSH, from the mainly host.
echo probe | ssh -i ~/.ssh/mainly_provision mailprov@mail.example.com

# 3. mainly's driver, its stored key, and its grants.
./mainly.sh domain probe you@example.com example.com
```

The first that fails is the layer to fix.

### Parity

An address in `vmaps` but not in the passwd-file accepts mail nobody can read.
An address in the passwd-file but not in `vmaps` is a login to a mailbox that
will never receive. Either is worse than the change not happening, so every
write verifies the two agree and restores both if they do not.

A host that is *already* out of parity cannot be provisioned at all — every
write would roll itself back. `probe` reports it, so you find out before a
failed create rather than during one.

```sh
diff <(awk 'NF{print $1}' /etc/postfix/vmaps | sort) \
     <(awk -F: 'NF{print $1}' /etc/dovecot/users | sort)
```

Reconcile by hand: delete the orphan, or add the missing half. Then re-run
`postmap hash:/etc/postfix/vmaps`.

### Backups

Every mutating operation writes `<file>.bak.YYYYMMDDHHMMSS` beside each file it
touches, keeps the last 20, and restores from them on failure. They are on the
mail server, in the same directories as the files themselves.

```sh
ls -t /etc/postfix/vmaps.bak.* | head
```

---

## Turning it off

### One domain, from mainly

```sh
./mainly.sh domain forget you@example.com example.com
```

Removes the key and the grants from mainly's database. Touches no address and no
mail.

### Everything, from the mail server

The authoritative off switch, because it does not depend on mainly behaving:

```sh
sudo truncate -s 0 /home/mailprov/.ssh/authorized_keys
```

Or narrow rather than revoke — takes effect on the next call, no restart:

```sh
sudo sed -i 's/^domain example.com .*/domain example.com list/' \
  /etc/mainly-provision.conf
```

### Uninstall completely

```sh
sudo rm -f /usr/local/sbin/mainly-provision \
           /etc/mainly-provision.conf \
           /etc/sudoers.d/mainly-provision
sudo deluser --remove-home mailprov
```

None of this removes an address, a mailbox, or a byte of mail. Everything
created through domain control stays exactly as it is.

---

## Supporting another mail server

`DomainDriver` in `backend/src/modules/domains/drivers/types.ts` is five verbs
behind a transport:

```ts
capabilities()   probe()   list()   create?()   remove?()   setPassword?()
```

Every mutating method is optional. A driver that cannot delete omits `remove`
and leaves `'delete'` out of `capabilities()`; nothing above it needs a special
case, because the service checks capability before it dispatches.

`ssh` is the only driver today. mailcow, Mailu and Migadu expose the same shape
behind an HTTP API and should drop in without touching anything outside
`drivers/`. Add the driver, register it in `drivers/index.ts`, and the settings
screen, CLI and MCP tools work unchanged.
