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
| `provision` | Create and remove addresses on a connected mail server. Deliberately separate from `write`: filing mail and minting an address are not the same authority. Does nothing unless a domain has been connected — see [domain control](domain-control.md). |

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

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAIL_API_URL` | `http://127.0.0.1:5274/api` | Where the API is. Use your public URL if the agent is not on the same host. |
| `MAIL_API_TOKEN` | — | Required. No default. |
| `MAIL_MCP_MAX_BODY_CHARS` | `8000` | How much of a body one read may return. |

---

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
