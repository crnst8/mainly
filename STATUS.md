---
summary: Self-hosted webmail client (React + Fastify + Postgres + MCP) that mirrors IMAP metadata into Postgres and serves every read from it.
state: active
priority: 1
updated: 2026-11-16
next: On the mainly server, run `./mainly.sh hook connect <mail-server-ssh-alias>` (in ~/app/mainly) and check `./mainly.sh hook list` shows a recent notice.
---

# mainly status

## Where it stands
Released 1.5.0 (`5c322f8`). Today's work is committed and pushed to `main`
(`319a365`, `fbdfead`, `d59baf0`, `bc5818c`) and deployed to the `mainly`
server (image `:latest`, migration 019 applied, 24 accounts ok, 24 IDLE
connections, no errors after restart). Backup taken before the deploy in
`~/app/mainly/backups/`. `./dev.sh check` passes (50 consistency checks).

## Done today
- Right-click Mark all read on the unified rows (Inbox, Filtered, Drafts…) and
  on rail domains, with count and Undo. `shell/FolderMenu.tsx`, `Sidebar.tsx`,
  `RailMenu.tsx`.
- Mobile reader fits mail to the screen width (CSS `zoom` on overflow, links
  break anywhere). `reader/MessageBody.tsx` `fit` prop, `MobileReader.tsx`.
- IDLE on every account: `IMAP_IDLE_MAX_ACCOUNTS` default 12 → 100 (the
  Dovecot limit the old cap cited is per login), starts staggered 250ms.
- Mail hook (new, optional): a Dovecot Lua push_notification driver
  (`scripts/mainly-hook.lua`) POSTs login + changed mailbox names to
  `POST /api/hooks/mail`; mainly fetches only those folders. Installer
  `scripts/connect-mailhook.sh` behind `./mainly.sh hook connect|remove|list|create`
  and `./dev.sh hook`. Token minted on the host (`cli/hook.ts`), SHA-256 at rest
  (migration 019). Accounts on a hooked host poll every 15 min while the hook
  is live. IDLE and the hook share `sync/folder-pass.ts`. Doc: `docs/mail-hook.md`.
- Hook verified end to end on Debian 12's packaged Dovecot 2.3.19 in a
  container: install, rerun, remove, rollback-free cleanup; delivery and a move
  into a new folder by another client indexed within 3s with no poll or IDLE.
  Unreachable mainly costs at most 1s per delivery (measured).
- Deploy found a regression: IDLE on all accounts drained the DB pool on boot
  (13 catch-up passes failed). Fixed in `bc5818c`: folder passes share the
  poll queue (`sync/account-queue.ts`) and retry once; redeployed clean.

## Next
1. On the mainly server, run `./mainly.sh hook connect <mail-server-ssh-alias>`
   in ~/app/mainly; check `./mainly.sh hook list` shows a recent notice.
2. Open a wide newsletter in the installed iPhone app (fit tested only in
   headless Chromium).
3. CHANGELOG entry and a tagged release (`./publish.sh release`).

## Waiting on you
- Running the hook installer against your mail server (it edits Dovecot config
  there; that server was not part of the deploy you authorised).
- A real OpenRouter key to confirm the Assist success path (from 2026-11-11).
- Running `./mainly.sh hermes <ssh-host> <email>` against production.

## Loose ends
- Nothing uncommitted; `main` is pushed.
- Dovecot 2.4 is refused by the installer (untested; Debian 13 ships 2.4).
- Split `ROLE=api` / `ROLE=sync` deployments get no live SSE updates from sync
  (`modules/events/bus.ts` is in-process only). `ROLE=all` is unaffected.
- CI does not run consistency-check; it runs only in `./dev.sh check`.
- Dev web and API running on :5273 / :5274.
