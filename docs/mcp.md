# Agents (MCP)

`mcp/` is a stdio [MCP](https://modelcontextprotocol.io) server. It gives an
agent the same mailbox the browser has — search, read, file, label, mark,
snooze, trash, unsubscribe — by calling the same HTTP API with a scoped bearer
token.

It holds no database connection and no IMAP connection of its own. An agent can
never reach anything a person could not.

---

## 1. Mint a token

```sh
./mainly.sh token create you@yourdomain.com "my-agent" --scopes read,write --days 90
```

In a development checkout, `./dev.sh token create …` instead.

The token is printed once and is not recoverable. Minting requires a shell on
the host on purpose: a credential that grants API access must not be mintable
through the API.

```sh
./mainly.sh token list you@yourdomain.com
./mainly.sh token revoke you@yourdomain.com <id>
```

### Scopes are the whole permission model

| Scope | Grants |
| --- | --- |
| `read` | Search, read messages, list accounts and folders. |
| `write` | Mark, flag, label, move, archive, trash, snooze. |
| `unsubscribe` | Act on `List-Unsubscribe`. Deliberately separate from `write`. |
| `provision` | Create and remove addresses on a connected mail server. Deliberately separate from `write`: filing mail and minting an address are not the same authority. An address created this way is not added as an account here — that is closed to tokens, see below. Does nothing unless a domain has been connected — see [domain control](domain-control.md). |

**Adding an account, changing a mailbox password, deleting an account, and
connecting a domain are closed to tokens at any scope.** Those handle
credentials, so a person has to be present — and in the last case, a credential
that widens what the application can do must not be installable by something
that already holds API access.

---

## 2. Point a client at it

The server needs Node 22+ and runs from source. Install its dependencies once:

```sh
cd mcp && npm install
```

Any MCP client works the same way. Two environment variables: where the API is,
and the token.

**Claude Code** — `.mcp.json` in your project, or `claude mcp add`:

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/mainly/mcp/src/index.ts"],
      "env": {
        "MAIL_API_URL": "http://127.0.0.1:5274/api",
        "MAIL_API_TOKEN": "mailt_…"
      }
    }
  }
}
```

**OpenCode** — `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mail": {
      "type": "local",
      "command": ["node", "--experimental-strip-types", "/absolute/path/to/mainly/mcp/src/index.ts"],
      "enabled": true,
      "environment": {
        "MAIL_API_URL": "http://127.0.0.1:5274/api",
        "MAIL_API_TOKEN": "mailt_…"
      }
    }
  }
}
```

**Hermes Agent** — one command from this host, over SSH. See
[Hermes Agent](#hermes-agent) below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAIL_API_URL` | `http://127.0.0.1:5274/api` | Where the API is. Use your public URL if the agent is not on the same host. |
| `MAIL_API_TOKEN` | — | Required. No default. |
| `MAIL_MCP_MAX_BODY_CHARS` | `8000` | How much of a body one read may return. |

---

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) usually runs on
another machine. One command connects it, run on the host this app runs on:

```sh
./mainly.sh hermes <ssh-host> you@yourdomain.com
```

`<ssh-host>` is how `ssh` reaches the agent's machine: an alias from
`~/.ssh/config` or `user@host`, with key authentication. The command
([`scripts/connect-hermes.sh`](../scripts/connect-hermes.sh)):

1. finds Hermes and Node 22+ there (Hermes's installer bundles a Node);
2. picks the API address the agent's machine can reach, by asking that machine
   to call `/api/health` on `APP_ORIGIN`, then this host's Tailscale and LAN
   addresses, and keeping the first that answers;
3. copies `mcp/` to `~/.local/share/mainly-mcp` there and installs its
   dependencies;
4. mints a token here (`read,write`, 90 days);
5. writes it into Hermes's own secret file, `~/.hermes/.env` (mode 0600), as
   `MAINLY_MCP_TOKEN`, and registers the server with `hermes mcp add`, whose
   config refers to it as `${MAINLY_MCP_TOKEN}`;
6. runs `hermes mcp test`, installs a short Hermes skill
   (`~/.hermes/skills/email/mainly/SKILL.md`, from
   [`mcp/hermes/SKILL.md`](../mcp/hermes/SKILL.md)), and revokes earlier
   tokens with the same name.

The token goes over SSH on stdin, never on a command line, and is never
printed. Run the command again to renew it before it expires; the old one is
revoked once the new one works.

| Option | Default | Meaning |
| --- | --- | --- |
| `--api-url URL` | derived | The API as the agent's machine reaches it, e.g. `https://mail.example.com/api`. Repeatable; the first that answers is used. |
| `--scopes LIST` | `read,write` | Add `unsubscribe` only if the agent should act on List-Unsubscribe. |
| `--days N` | `90` | Token lifetime. |
| `--name NAME` | `mainly` | The server's name in Hermes, the token's name here, and the env var (`NAME_MCP_TOKEN`). |
| `--remote-dir DIR` | `~/.local/share/mainly-mcp` | Where the MCP server goes. |
| `--no-skill` | | Skip the Hermes skill. |

Plain `http://` is accepted for loopback and Tailscale (`100.x`) addresses and
warned about otherwise, because the token would cross the network unencrypted.
Prefer `https://`, or Tailscale.

In a development checkout, `./dev.sh hermes <ssh-host> <email> --api-url URL`
does the same. The dev API listens on localhost only, so pass an address the
agent's machine can reach, for example through
`ssh -R 15274:127.0.0.1:5274 <ssh-host>` and `--api-url http://127.0.0.1:15274/api`.

To disconnect: `hermes mcp remove mainly` on the agent's machine, delete the
`MAINLY_MCP_TOKEN` line from `~/.hermes/.env`, and revoke the token here with
`./mainly.sh token list` / `token revoke`.

## 3. The tools

| Tool | Scope | Does |
| --- | --- | --- |
| `mail_search` | `read` | Search in the app's own syntax. Sort, threading, paging. |
| `mail_read_message` | `read` | One message, body truncated to the character budget. |
| `mail_list_accounts` | `read` | Accounts, domains, priorities, sync state. |
| `mail_list_folders` | `read` | The folder tree for an account. |
| `mail_sort` | `write` | Move messages into a folder. |
| `mail_label` | `write` | Add or remove labels. |
| `mail_mark` | `write` | Read, unread, flagged, answered. |
| `mail_snooze` | `write` | Hide until a time. |
| `mail_delete` | `write` | Trash, or permanently with `confirm`. |
| `mail_unsubscribe` | `unsubscribe` | Act on `List-Unsubscribe`. |

### What to expect

Every mutating tool takes either `ids` or a `query` in the app's search syntax,
so *"archive everything from that sender older than a year"* is one call.

Which is also the risk. So:

- all of them accept `dryRun: true`, which reports what would change and changes
  nothing
- a single call is capped at **200 messages**
- `mail_delete --permanent` and `mail_unsubscribe` additionally require
  `confirm: true`
- both declare themselves destructive in their annotations, so a client can
  prompt before running them

Error messages are written to be read by a model as much as a person —
*"needs the 'write' scope"*, *"that folder belongs to a different account"* —
because the agent is what has to recover from them.

---

## Unsubscribing

This is the only thing here that leaves your own infrastructure.

An HTTPS target is POSTed to **only** when the sender marked it one-click
(RFC 8058). Anything else is handed back as a link for you to open yourself.
Links resolving to private or loopback addresses are refused unless
`ALLOW_PRIVATE_IMAP_HOSTS` is on. Every attempt, successful or not, is recorded
in `unsubscribe_attempts`.
