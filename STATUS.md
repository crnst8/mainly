---
summary: Self-hosted webmail client (React + Fastify + Postgres + MCP) that mirrors IMAP metadata into Postgres and serves every read from it.
state: active
priority: 1
updated: 2026-11-16
next: Review the uncommitted diff (`git diff`, `git status`) and commit it in four parts — mark-all-read menus, mobile fit-to-width, IDLE default, mail hook — then run `./mainly.sh hook connect <mail-server>` against the real Dovecot.
---

# mainly status

## Where it stands
Released 1.5.0 (`5c322f8`). Today's work is uncommitted on `main`.
`./dev.sh check` passes (typechecks, audit, contract, URL/search/store suites,
unit tests, smoke, query, index, 50 consistency checks).

## Done today (uncommitted)
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

## Next
1. Review and commit in four parts.
2. Run `./mainly.sh hook connect <mail-server-ssh-alias>` on the real install;
   check `./mainly.sh hook list` shows a recent notice.
3. Open a wide newsletter in the installed iPhone app (fit tested only in
   headless Chromium).
4. CHANGELOG entry and release (`./publish.sh`).

## Waiting on you
- Running the hook installer against your mail server (it edits Dovecot config
  there, so it was not run from this session).
- A real OpenRouter key to confirm the Assist success path (from 2026-11-11).
- Running `./mainly.sh hermes <ssh-host> <email>` against production.

## Loose ends
- Uncommitted: frontend (FolderMenu, Sidebar, RailMenu, MessageBody,
  MobileReader, reader.css); backend (config, server, engine, idle,
  folder-pass, mail-hook, modules/hooks, cli/hook, migration 019,
  consistency-check); scripts (connect-mailhook.sh, mainly-hook.lua);
  mainly.sh, dev.sh, compose and env examples; docs and the skill.
- Dovecot 2.4 is refused by the installer (untested; Debian 13 ships 2.4).
- Split `ROLE=api` / `ROLE=sync` deployments get no live SSE updates from sync
  (`modules/events/bus.ts` is in-process only). `ROLE=all` is unaffected.
- CI does not run consistency-check; it runs only in `./dev.sh check`.
- Dev web and API running on :5273 / :5274.
