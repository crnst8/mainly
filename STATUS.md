---
summary: Self-hosted webmail client (React + Fastify + Postgres + MCP) that mirrors IMAP metadata into Postgres and serves every read from it.
state: active
priority: 1
updated: 2026-11-16
next: Review the uncommitted diff (`git diff`) and commit it in three parts — mark-all-read menus, mobile fit-to-width, IDLE default — then test the mobile reader on a real iPhone with a newsletter.
---

# mainly status

## Where it stands
Released 1.5.0 (`5c322f8`: Assist, recap, kind labels, sender logos, Filtered
study, Hermes connection). Today's work is uncommitted on `main`.
`./dev.sh check` passes (typechecks, audit, contract, URL/search/store suites,
unit tests, smoke, query, index, 47 consistency checks).

## Done today (uncommitted)
- Right-click on the unified rows (Inbox, Filtered, Drafts, Sent, Archive,
  Junk, Trash) opens Open / Mark all read, with the same unread count as the
  row and Undo. The rail's domain menu also has Mark all read. Folders,
  accounts and groups already had it. `shell/FolderMenu.tsx`, `Sidebar.tsx`,
  `RailMenu.tsx`. Checked in the browser with mock data.
- Mobile reader: bodies fit the screen without horizontal scroll. New `fit`
  prop on `reader/MessageBody.tsx` scales content wider than the column with
  CSS `zoom` (refits on resize and image load). Links can break anywhere, long
  plain-text URLs wrap. Desktop reader keeps the sideways scroll. Checked at
  390px in Playwright with a 640px table newsletter.
- Polling vs push: the UI already uses SSE and never polls. IMAP IDLE was capped
  at 12 accounts, and the rest polled every 2 minutes. That cap was based on
  Dovecot's `mail_max_userip_connections`, which is a per-login limit, so it
  does not limit how many accounts can be watched. Default
  `IMAP_IDLE_MAX_ACCOUNTS` raised to 100 (every account on a typical install),
  watcher starts staggered 250ms apart. Docs: configuration, architecture,
  self-hosting, both `.env.example`, `docker-compose.yml`.

## Next
1. Review and commit the diff in three parts (menus, mobile fit, IDLE default).
2. Open a wide newsletter in the installed iPhone app and confirm no sideways
   scroll and readable scaling (only tested in headless Chromium).
3. After deploying, check `idle supervisor started (up to 100 connections)` and
   that the mail server accepts one IDLE connection per mailbox.
4. Write the CHANGELOG entry and release (`./publish.sh`).

## Waiting on you
- Optional push for folders other than the inbox: imapflow has no IMAP NOTIFY,
  so those are still caught by the 15-minute poll. Options: Dovecot
  `push_notification` webhook (needs mail-server config and a new inbound
  endpoint) or a second IDLE connection per account. Not built.
- A real OpenRouter key to confirm the Assist success path (from 2026-11-11).
- Running `./mainly.sh hermes <ssh-host> <email>` against production.

## Loose ends
- Uncommitted: frontend (FolderMenu, Sidebar, RailMenu, MessageBody,
  MobileReader, reader.css), backend (config.ts, sync/idle.ts), config
  (`.env.example`, `backend/.env.example`, `docker-compose.yml`), docs
  (architecture, configuration, self-hosting).
- Split `ROLE=api` / `ROLE=sync` deployments get no live SSE updates from sync:
  `modules/events/bus.ts` is in-process only (no LISTEN/NOTIFY bridge yet).
  `ROLE=all` (the default) is unaffected.
- CI does not run consistency-check; it runs only in `./dev.sh check`.
- Dev web and API running on :5273 / :5274.
