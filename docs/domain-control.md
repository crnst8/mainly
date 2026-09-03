# Domain control

**Let mainly create and remove email addresses on your own mail server.**

Optional, and off by default. An install that connects no mail server behaves
exactly as it always has: it holds one credential per mailbox and never writes
back.

Two machines, two commands.

```sh
# 1. on the mail server
sudo mainly-provision setup

# 2. on the machine running mainly — it prints this line for you
./mainly.sh domain connect <the string it printed>
```

The first is a wizard. It reads your mail server's own configuration rather than
asking you to recite it, checks that the server is in a state it can safely
write to, asks two questions, installs everything, tests itself end to end, and
hands you the second command. Nothing is copied between machines by hand except
that one line.

---

## Contents

1. [Is this for you](#is-this-for-you)
2. [Setting it up](#setting-it-up)
3. [Using it](#using-it)
4. [What decides what](#what-decides-what)
5. [When something is wrong](#when-something-is-wrong)
6. [Turning it off](#turning-it-off)
7. [Doing it by hand](#doing-it-by-hand)
8. [Supporting another mail server](#supporting-another-mail-server)

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
constraint is not removed; it is opted out of, per mail server, deliberately.

---

## Setting it up

You need root on the mail server, a shell on the machine running mainly, and a
mail server of the shape [mailstack](https://github.com/crnst8/mailstack)
produces: Postfix with `virtual_mailbox_maps` as a hash map, delivering over
LMTP to Dovecot, with Dovecot authenticating from a `passwd-file`. The wizard
checks all of that and says so if it is not what it finds.

### 1. On the mail server

Copy [`scripts/mainly-provision`](../scripts/mainly-provision) from this
repository to that machine, then:

```sh
sudo sh mainly-provision setup
```

It works through eight steps and shows you each one:

| | |
| --- | --- |
| 1 | **What is here** — Postfix and Dovecot versions, the four file paths it found, the hashing scheme it will use. Every path can be typed over. |
| 2 | **Are the two files in agreement** — an address in one map and not the other is a broken host, and it stops rather than starting on one. |
| 3 | **Which domains** — it lists the ones this server already has addresses for, and offers all of them. |
| 4 | **What may it do** — `full`, `keep`, `read`, or a list. Default is `full`. |
| 5 | **Installing** — itself into `/usr/local/sbin`, the config, the `mailprov` account, one sudoers line. |
| 6 | **The key** — generated here, installed here, pinned to one command. |
| 7 | **Checking it works** — it calls itself over the same path mainly will use. |
| 8 | **Where mainly reaches this machine** — an address (an IP is fine, and usual) and a port. |

Then it prints the command for step 2.

**Choosing a scope.** `full` is everything; `keep` is everything except
destroying stored mail; `read` only sees which addresses exist. The difference
between `full` and `keep` is one grant, `purge`: with it, removing an address
may also delete its Maildir. Without it, a removed address stops receiving and
its mail stays on disk, so recreating the address brings everything back.

**The string it prints carries a private key.** Paste it into that other
terminal and nowhere else — not a chat, not an issue, not a paste service. It is
not kept on the mail server; if you lose it, run `setup` again, which issues a
new key and revokes the old one in the same step.

### 2. On the machine running mainly

```sh
./mainly.sh domain connect <the string>
```

Or with no argument, which prompts for it:

```sh
./mainly.sh domain connect
```

This checks the mail server's host key against the fingerprints that machine
reported for itself, connects every domain the string names, asks each one what
the server permits, and grants exactly that. There is no second step and no
staged widening: the server already decided, and asking you to re-enter its
answer here would only be a chance to get it wrong.

Then:

```sh
./mainly.sh domain status
```

```
Mail servers  you@example.com

  ● example.com  mailprov@203.0.113.10:22
      list, create, delete, password, alias, purge
```

That is the whole setup.

---

## Using it

### In the browser

**Settings → Mail server.** Each connected domain shows its host, when it was
last checked, the grant switches, and the addresses that exist.

A grant the mail server will not permit is shown switched off and disabled, with
the reason, rather than hidden. A control that vanishes sends someone hunting
for a setting that is working exactly as intended.

Creating an address offers to add the mailbox to this install in the same step,
because that is the one moment the password is known. Removing one asks for the
address to be typed back, and says plainly whether the mail is being kept or
destroyed.

### From the command line

```sh
./mainly.sh domain status                 what is connected, and what it may do
./mainly.sh domain doctor                 check every layer, name the broken one
./mainly.sh domain addresses              what exists on the mail server
./mainly.sh domain new hello@example.com  create one
./mainly.sh domain rm  hello@example.com  remove one   [--purge]
./mainly.sh domain add another.com        another domain on the same server
./mainly.sh domain scope example.com keep change what it may do
./mainly.sh domain history                every attempt, successful or not
./mainly.sh domain forget example.com     drop the key here
```

**Your login address is not an argument.** It is inferred, because an install
almost always has one account. So is the domain, when only one is connected. Say
which only when it is genuinely ambiguous — `--as you@example.com`, and the
domain by name:

```sh
./mainly.sh domain --as you@example.com addresses example.com
```

`new` prints a generated password once, or reads one from stdin. Only the
password goes to stdout, so it can be piped:

```sh
./mainly.sh domain new hello@example.com | pbcopy
echo 'a-password-you-chose' | ./mainly.sh domain new hello@example.com
```

`add` connects a second domain on a mail server that is already connected. It
reuses that server's key rather than asking for another, and refuses a domain
the server has no addresses for:

```sh
$ ./mainly.sh domain add nothere.com
203.0.113.10 has no addresses for nothere.com.
It serves: example.com, other.example
```

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

## What decides what

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
name. That is why `connect` grants what the server permits and no more: the
answer is not mainly's to give.

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

`restrict` denies port forwarding, agent forwarding, a PTY, X11 and `~/.ssh/rc`,
so the key cannot open a shell or tunnel — only cause that one script to run.
`setup`, `status`, `doctor` and `uninstall` are reachable only from a real argv
on the mail server itself; nothing arriving over that connection can administer
the host.

### The grants

| Grant | Allows |
| --- | --- |
| `list` | See which addresses exist |
| `create` | Create new addresses |
| `delete` | Remove addresses — the delivered mail stays on disk |
| `password` | Change a mailbox password |
| `alias` | Add and remove aliases |
| `purge` | *Also* delete the stored mail when removing an address |

### The audit trail

Every attempt to change something on a mail server is recorded, successful or
not — the same reasoning as the unsubscribe log: it reaches something outside
mainly, and it is not undoable.

```sh
./mainly.sh domain history
```

```
2026-09-03T00:33:50.642Z  ok      delete     hello@example.com  (session)
2026-09-03T00:33:13.610Z  ok      create     hello@example.com  (session)
2026-09-03T00:32:39.191Z  FAILED  create     hello@example.com  (provisioner)
      example.com grants: list
```

`(session)` is a person in a browser or at the CLI; anything else is the name of
the API token that did it. Records outlive the domain — "who deleted that
address, and when" is most often asked after it has been disconnected.

Also in **Settings → Mail server → History**.

---

## When something is wrong

Each machine can diagnose its own half, and each says which half it is.

```sh
./mainly.sh domain doctor            # here
sudo mainly-provision doctor         # on the mail server
```

`domain doctor` walks every layer for every connected domain — host key,
reachability, the helper's reply, map parity, what the server permits versus
what is granted here — and prints the fix for the first thing that fails. Start
there. If it says the fault is on the other machine, run the other one.

`mainly-provision doctor` does the same for the mail server: the install, the
config's ownership and mode, both map files, parity, the `mailprov` account and
its shell, the key and its forced command, the sudoers line, and finally a real
call through the same path mainly uses.

A few failures worth naming, because the message alone does not say what to do:

| What you see | What it means | Fix |
| --- | --- | --- |
| *"did not answer with a provisioning reply"* | The key reached a shell rather than the script. Almost always `mailprov`'s shell is `nologin`, which accepts the connection, prints *"This account is currently not available"*, and never runs anything. | `sudo mainly-provision doctor` names it. `sudo chsh -s /bin/sh mailprov`. |
| `the mail server permits nothing for this domain` | The domain is not in `/etc/mainly-provision.conf`, or is not on that server at all. `doctor` says which, because it knows what the server serves. | Re-run `setup` there, or add the `domain` line by hand. |
| *"points at a private or reserved address"* | The mail server is on a LAN or a tailnet. | `ALLOW_PRIVATE_IMAP_HOSTS=true` in `.env`, then restart. |
| Host key mismatch | The server's key changed, or something is in the way. | Confirm with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server *before* reconnecting. |
| `lock_busy` | Another operation is running. | Try again. There is no queue, deliberately. |
| `parity_broken` | The two maps disagree. Both were restored. | See below. |
| `Connection refused`, intermittently | sshd is socket-activated and its burst limit tripped. | It clears on its own in a minute. mainly reuses one connection precisely to avoid this; something else is likely also connecting. |

### Parity

An address in `vmaps` but not in the passwd-file accepts mail nobody can read.
An address in the passwd-file but not in `vmaps` is a login to a mailbox that
will never receive. Either is worse than the change not happening, so every
write verifies the two agree and restores both if they do not.

A host that is *already* out of parity cannot be provisioned at all — every
write would roll itself back. `setup` refuses to start on one, and `doctor`
prints the difference:

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

### Narrow it, without disconnecting

```sh
./mainly.sh domain scope example.com read     # only see what exists
./mainly.sh domain scope example.com keep     # everything but destroying mail
```

### One domain, from mainly

```sh
./mainly.sh domain forget example.com
```

Removes the key and the grants from mainly's database. Touches no address and no
mail.

### Everything, from the mail server

The authoritative off switch, because it does not depend on mainly behaving:

```sh
sudo mainly-provision uninstall
```

It removes the key, the config, the sudoers line, the account and the script,
after asking. It removes no address, no mailbox, and no byte of mail; everything
created through domain control stays exactly as it is.

To revoke access without uninstalling:

```sh
sudo truncate -s 0 /home/mailprov/.ssh/authorized_keys
```

---

## Doing it by hand

The wizard is not privileged — it writes files any operator could write, and
`mainly-provision status` shows you what they are. If you would rather place
them yourself, or you are configuring a host from Ansible:

```sh
sudo install -m 0755 -o root -g root mainly-provision /usr/local/sbin/

sudo tee /etc/mainly-provision.conf >/dev/null <<'EOF'
vmaps    /etc/postfix/vmaps
users    /etc/dovecot/users
aliases  /etc/postfix/virtual_aliases
mailroot /var/mail
scheme   ARGON2ID
reload   postfix

domain example.com list,create,delete,password,alias,purge
EOF
sudo chmod 0644 /etc/mainly-provision.conf

# /bin/sh, not nologin: sshd runs the forced command through the login shell.
sudo adduser --system --group --shell /bin/sh \
     --home /home/mailprov --disabled-password mailprov

echo 'mailprov ALL=(root) NOPASSWD: /usr/local/sbin/mainly-provision' \
  | sudo tee /etc/sudoers.d/mainly-provision
sudo chmod 0440 /etc/sudoers.d/mainly-provision
sudo visudo -c

sudo mkdir -p /home/mailprov/.ssh
printf 'command="sudo /usr/local/sbin/mainly-provision --stdin",restrict %s\n' \
  "$(cat mainly_provision.pub)" | sudo tee /home/mailprov/.ssh/authorized_keys
sudo chown -R mailprov:mailprov /home/mailprov/.ssh
sudo chmod 700 /home/mailprov/.ssh
sudo chmod 600 /home/mailprov/.ssh/authorized_keys

sudo mainly-provision doctor
```

Then, on the mainly host — `connect` takes the same string a `setup` would have
printed, so build one, or use the flags directly:

```sh
./mainly.sh domain connect "$(printf '%s' '{
  "host":"203.0.113.10","port":22,"user":"mailprov",
  "fingerprints":["sha256:…"],
  "domains":["example.com"],
  "key":"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n"
}' | base64 | tr -d '\n')"
```

`fingerprints` may be empty, in which case the key the server presents is pinned
unverified — which is what trust on first use means, and why `setup` does not do
it. Get them with `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` on the server.

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

The server-side script has its own reference:
[`scripts/mainly-provision.md`](../scripts/mainly-provision.md).
