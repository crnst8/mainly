# `mainly-provision`

The server-side half of [domain control](../docs/domain-control.md). A POSIX
shell script that creates and removes virtual mailboxes on a flat-file Postfix +
Dovecot host, on behalf of a mainly install that reaches it over SSH.

**This file documents the script next to it.** If you are setting the feature up
for the first time you do not need it: copy the script to your mail server and
run

```sh
sudo sh mainly-provision setup
```

which does everything below, checks its own work, and prints the one command to
paste on the machine running mainly. [docs/domain-control.md](../docs/domain-control.md)
covers both halves in order.

This is the reference for what that wizard produces, for anyone configuring a
host by hand or from Ansible, and for the wire protocol.

---

## Administration

Four subcommands, all interactive, all requiring root and a terminal on the mail
server itself:

| | |
| --- | --- |
| `setup` | Detect, ask two questions, install everything, self-test, print the handover string |
| `status` | What is installed here, and whether it is healthy |
| `doctor` | Every check, each with the fix for its failure |
| `uninstall` | Remove all of it. No address, no mailbox and no mail is touched |

**They are reachable only from a real argv on this machine.** A request arriving
over SSH is `--stdin`, which the administration dispatcher does not match, and
the verb it then carries is matched against the wire grammar below, which names
none of them. There is no path from the wire to the administration of the host.

`setup` generates the SSH keypair here, installs the public half into
`~mailprov/.ssh/authorized_keys` pinned to the forced command, prints the
private half inside the handover string, and then removes it from this machine.
Nothing that has to stay secret is left behind; re-running `setup` issues a new
key and revokes the old one in the same step.

---

## Why it exists

mainly could edit those files over SSH directly. That would mean handing the
application an SSH key with `sudo`, and a compromise of the app would be root on
the mail server.

Instead the key is pinned to *this script only*, and this script answers to its
own config file:

```
mainly ──ssh──► mailprov@mailhost ──forced command──► mainly-provision
                                                            │
                                                  /etc/mainly-provision.conf
                                                  (the domains and verbs allowed)
```

**The application cannot write that config.** If mainly's database were
compromised and every domain in it flipped to full access, this script would
still refuse every domain and verb its own file does not name.

That is the entire point. Authority does not live where the application can
reach it.

### What is still trusted

This runs as root and edits root-owned files, so a bug here is a root bug. It is
kept small, dependency-free, and auditable in one sitting — that is what putting
it on the server buys. The alternative, a client that sends arbitrary commands,
leaves nothing to audit.

---

## Requirements

- POSIX `sh` (dash, bash, busybox ash — all fine)
- `flock`, and coreutils
- `postmap` and `postfix` (Postfix)
- `doveadm` (Dovecot)
- Postfix using `virtual_mailbox_maps` (a hash map) and delivering over LMTP to
  Dovecot, with Dovecot authenticating from a `passwd-file`

Verified against Postfix 3.8.6 and Dovecot 2.3.21 on Ubuntu 24.04.

---

## Install

`mainly-provision setup` does all of this. What follows is what it writes, for a
host being configured by hand.

```sh
sudo install -m 0755 -o root -g root mainly-provision /usr/local/sbin/
```

### The account it runs as

```sh
sudo adduser --system --group --shell /bin/sh \
     --home /home/mailprov --disabled-password mailprov
```

> **`--shell /bin/sh`, not `/usr/sbin/nologin`.**
>
> sshd runs a forced command *through the account's login shell*. With
> `nologin` the connection is accepted, the shell prints `This account is
> currently not available.`, and the command never runs — so the setup looks
> correct and every call fails with a reply that is not JSON.
>
> The account is still locked down: `--disabled-password` means no password
> login, and the forced command means the only thing its key can do is run this
> script.

### Sudo, for exactly one path

```sh
echo 'mailprov ALL=(root) NOPASSWD: /usr/local/sbin/mainly-provision' \
  | sudo tee /etc/sudoers.d/mainly-provision
sudo chmod 0440 /etc/sudoers.d/mainly-provision
sudo visudo -c        # must print "parsed OK"
```

### The key, pinned to the command

With the public key from the mainly host:

```sh
sudo mkdir -p /home/mailprov/.ssh
printf 'command="sudo /usr/local/sbin/mainly-provision --stdin",restrict %s\n' \
  "$(cat mainly_provision.pub)" | sudo tee /home/mailprov/.ssh/authorized_keys
sudo chown -R mailprov:mailprov /home/mailprov/.ssh
sudo chmod 700 /home/mailprov/.ssh
sudo chmod 600 /home/mailprov/.ssh/authorized_keys
```

`restrict` (OpenSSH 7.2+) denies port forwarding, agent forwarding, a PTY, X11
and `~/.ssh/rc`. The key cannot open a shell and cannot tunnel — it can only
cause this script to run.

`--stdin` rather than `$SSH_ORIGINAL_COMMAND` because `sudo` resets the
environment and would drop it. The script still honours
`$SSH_ORIGINAL_COMMAND` where it survives, if you prefer
`Defaults:mailprov env_keep += "SSH_ORIGINAL_COMMAND"`.

---

## Configuration

`/etc/mainly-provision.conf`, root-owned, mode `0644`. Read with `awk`, never
sourced — a config file that is sourced as shell is a config file that is an
execution path.

```sh
# ── Paths. Shown with their defaults; omit any line that already matches. ──
vmaps    /etc/postfix/vmaps
users    /etc/dovecot/users
aliases  /etc/postfix/virtual_aliases
mailroot /var/mail

# Hash for passwords set from here on. Existing entries keep their own, and a
# passwd-file holding a mix is normal — so pick the strongest `doveadm pw -l`
# offers rather than matching the majority. ARGON2ID and SHA512-CRYPT are both
# verified against this script.
scheme   SHA512-CRYPT

# `postfix` runs `postfix reload`. `none` skips it. An absolute path runs that
# executable with no arguments — for a Postfix that lives in a container.
reload   postfix

lock         /run/lock/mainly-provision.lock
backup_keep  20

# ── The allowlist. This is the part that matters. ──────────────────────────
# domain <name> <comma-separated grants>
domain example.com   list,create
domain example.net   list,create,delete,password
```

**A domain absent from this file cannot be touched**, whatever mainly believes.
This is the gate that decides, and it is the reason `./mainly.sh domain connect`
grants whatever this file permits and no more: the answer is not the
application's to give, so there is nothing for it to widen.

Narrowing a line takes effect on the next call. There is nothing to restart.

### Grants

| Grant | Allows |
| --- | --- |
| `list` | Reading which addresses exist |
| `create` | Creating an address |
| `delete` | Removing an address; the delivered mail stays on disk |
| `password` | Changing a mailbox password |
| `alias` | Adding and removing aliases |
| `purge` | *Also* deleting the Maildir when removing an address |

`purge` is separate from `delete` on purpose, and `delete` alone never touches
mail. Granting `purge` without `delete` does nothing — deletion is the only
thing that purges.

---

## Grammar

`setup`, `status`, `doctor` and `uninstall` are administration and are not part
of this grammar — see [Administration](#administration). What follows is the
wire protocol, and the whole of what a client can ask for.

One verb per invocation. Read from argv, then `$SSH_ORIGINAL_COMMAND`, then the
first line of stdin.

```
probe
list        <domain>
create      <localpart> <domain>            password on the next stdin line
delete      <localpart> <domain> [--purge]
password    <localpart> <domain>            password on the next stdin line
alias-list  <domain>
alias-add   <alias> <domain> <target@domain>
alias-del   <alias> <domain>
```

Secrets are read from stdin and never appear in argv, because `/proc/<pid>/cmdline`
is readable by every user on the host.

Before the grammar is even considered, every token is checked against a
character class — anything containing a character outside
`[A-Za-z0-9._+@-]` is refused. After that check no argument can carry a shell
metacharacter, a newline, a colon, or a space. Nothing is ever interpolated
into a shell.

Local parts must match `^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$`. Narrower than
RFC 5321 deliberately: an address this refuses can still be made by hand, and an
address it accepts cannot surprise a Postfix map or a passwd-file's
colon-separated fields.

---

## Output

One JSON object on stdout, always, success or failure.

```json
{"ok":true,"version":1,"action":"create","address":"hello@example.com"}
{"ok":false,"version":1,"error":"domain_not_allowed","detail":"example.net is not listed in /etc/mainly-provision.conf"}
```

`probe` is the one with a shape worth knowing:

```json
{"ok":true,"version":1,"action":"probe",
 "postfix":"3.8.6","dovecot":"2.3.21","scheme":"ARGON2ID","parity":true,
 "domains":[{"domain":"example.com","grants":["list","create"]}],
 "serves":["example.com","other.example"]}
```

`domains` is this file's allowlist. `serves` is every domain that has an address
on the host, permitted or not — the two together are what let the client tell
*"this server will not let mainly touch that domain"* from *"that domain is not
on this server at all"*, which are the same refusal and opposite fixes. A client
too old to read `serves` ignores it; a helper too old to send it leaves the
client with an empty list, which it treats as "unknown" rather than "none".

| Exit | Meaning |
| --- | --- |
| 0 | Done |
| 64 | Bad grammar, or a token that failed validation |
| 65 | Domain not in this host's allowlist |
| 66 | Verb not granted for that domain |
| 67 | Already exists, or does not exist |
| 69 | Another operation holds the lock |
| 70 | Something failed; state was rolled back |

---

## How a write is made safe

Every mutating verb runs this, in order:

1. `flock`, non-blocking — exit 69 rather than queue. A queue of provisioning
   requests is a queue of surprises.
2. Timestamped backups of every file about to change (`<file>.bak.YYYYMMDDHHMMSS`),
   keeping the last `backup_keep`.
3. Edits go to a temp copy which is then `mv`'d into place. Renaming within a
   directory is atomic, so a crash mid-write cannot leave a half-written map.
4. `postmap` on the changed hash map.
5. **Parity check** — the address list and the passwd-file must name exactly the
   same set.
6. Reload, per the `reload` setting.

If 4, 5 or 6 fails, every file is restored from step 2, the maps are rebuilt,
and it exits 70.

### Why parity is the invariant

An address in `vmaps` but not in the passwd-file accepts mail nobody can read.
An address in the passwd-file but not in `vmaps` is a login to a mailbox that
will never receive. Either is worse than the change not happening.

A host whose files are *already* out of parity cannot be provisioned at all —
every write would roll itself back at step 5. `probe` reports it so you find out
before a failed create rather than during one.

```sh
diff <(awk 'NF{print $1}' /etc/postfix/vmaps | sort) \
     <(awk -F: 'NF{print $1}' /etc/dovecot/users | sort)
```

---

## Testing it by hand

On the mail server, as root, without involving mainly at all:

```sh
echo probe | sudo /usr/local/sbin/mainly-provision --stdin
echo 'list example.com' | sudo /usr/local/sbin/mainly-provision --stdin
```

From the mainly host, over SSH, which additionally proves the forced command:

```sh
echo probe | ssh -i ~/.ssh/mainly_provision mailprov@mail.example.com
```

A reply that is not JSON means the key reached a shell rather than the script —
check `command=` in `authorized_keys`, and check the account's login shell is
not `nologin`.

### Against a scratch copy first

Point the config at copies and set `reload none`, and nothing real is at risk:

```sh
mkdir -p /tmp/mp && cp /etc/postfix/vmaps /etc/dovecot/users /tmp/mp/
printf 'vmaps /tmp/mp/vmaps\nusers /tmp/mp/users\nreload none\nlock /tmp/mp/lock\ndomain example.com list,create,delete\n' > /tmp/mp/conf
echo 'create test example.com' | MAINLY_PROVISION_CONF=/tmp/mp/conf /usr/local/sbin/mainly-provision --stdin
```

`MAINLY_PROVISION_CONF` overrides the config path, and exists for exactly this.

Put the scratch copies somewhere **root owns** — `/etc/mainly-scratch`, not
`/tmp`. Postfix refuses to write a `.db` into a directory root does not own, so
`postmap` fails and the helper rolls the write back, which looks like a bug in
the script and is not.

---

## Uninstall

```sh
sudo rm -f /usr/local/sbin/mainly-provision \
           /etc/mainly-provision.conf \
           /etc/sudoers.d/mainly-provision
sudo deluser --remove-home mailprov
```

Removing the key alone is enough to stop mainly reaching this host at all:

```sh
sudo truncate -s 0 /home/mailprov/.ssh/authorized_keys
```

Neither removes an address, a mailbox, or a byte of mail. Everything this script
ever created stays exactly as it is.

To revoke *some* access rather than all of it, narrow the allowlist and change
nothing else — it takes effect on the next call, with no restart:

```sh
sudo sed -i 's/^domain example.com .*/domain example.com list/' /etc/mainly-provision.conf
```
