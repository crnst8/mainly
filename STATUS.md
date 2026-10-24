---
summary: Self-hosted webmail client; Filtered-folder feature reviewed and verified on branch sort.
state: active
priority: 1
updated: 2026-10-24
next: Review and commit the Filtered-folder follow-up, then push/open a PR when requested.
---

# mainly status

## Where it stands
Released version remains 1.3.8. Branch `sort` contains `8b6893c` (Filtered folder);
this session's fixes remain uncommitted. Nothing pushed or released.

## Done today
- Read `SORT-HANDOFF.md` and reviewed filtering, learning, replay, settings and model transport.
- Verified OpenCode model discovery and eight models using synthetic mail only.
  MiniMax M3.1 Flash is the new default: 30/30 correct across three batches,
  zero wrongly filed, 2.4–2.9 seconds. Added a repeatable synthetic benchmark.
- Fixed folder parents for server delimiters, automatic filing after a user
  archived mail, and Filter out from an already-filtered reader outside the list.
- Bounded provider responses while streaming, validated model-list shape, and
  surfaced failures when forgetting rules.
- Updated vulnerable backend/MCP dependencies; no audit blockers. MCP initializes
  and lists all 14 tool schemas with Zod 4.
- Verified real Dovecot 2.3 with dot and slash delimiters: folder creation,
  Filter out, replay, Undo, arrival rules, rescue and sweep.
- Verified live HTTP settings on desktop and mobile, including OpenCode's model
  dropdown and Try (Filter, 99%, about 2.9 seconds).
- Removed the duplicate 1.3.7 changelog entry.
- Full `./dev.sh check` passed: 56 backend tests, 42 consistency checks,
  10 store checks, plus typechecks, audit, contract, URL/search, static/auth,
  smoke, query and index checks. Two nonblocking frontend audit warnings remain.

## Next
Review the working-tree changes; keep dependency maintenance identifiable when
committing. Push, PR and release only when requested.

## Waiting on you
A persistent operator key is needed to enable the optional LLM after the temporary
key expires. The temporary key was used only in process environments, never files.

## Loose ends
The synthetic benchmark is small; it is not a mailbox accuracy measurement.
Moves from other IMAP clients still do not teach the filter. The original
handoff's scale/cache follow-ups remain future work, not release blockers.
