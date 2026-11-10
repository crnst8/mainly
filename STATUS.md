---
summary: Self-hosted webmail client; uncommitted work fixes OpenRouter keys and adds Assist, Hermes connection and Filtered-folder study.
state: active
priority: 1
updated: 2026-11-11
next: Review the uncommitted diff on main (`git status`, `git diff`), branch, and commit it in three parts (OpenRouter fix, Assist + study, Hermes script).
---

# mainly status

## Where it stands
Released 1.4.0 (Filtered folder, provider and key in Settings), plus `15cc402`
(installed iPhone app fills the screen). This session's work is in the working
tree on `main`, uncommitted. `./dev.sh check` passes: 71 unit tests, 47
consistency checks (5 new), typechecks, audit, contract, URL/search/store,
smoke, query and index checks.

## Done today (uncommitted)
- OpenRouter keys now save. The model list cap (256 KB) refused OpenRouter's
  842 KB list, which showed as "did not accept it". Model lists now read up to
  8 MB; OpenRouter keys are checked against `/key` (its model list is public);
  errors name the host. Saving picks a default model from the provider's list
  (migration 018 adds `filter_llm_keys.model`).
- Settings → Assist: provider, key and model moved here from Filtered, shared
  by every model task.
- Kind labels on arrival (`action`, `bill`, `receipt`, `shipping`, `travel`,
  `security`, `event`): `backend/src/assist/kinds.ts`.
- Recap of today / since yesterday / last 7 days: `backend/src/assist/recap.ts`,
  `frontend/src/features/recap/`; topbar, palette, mobile header, Assist.
- Sender logos: BIMI auto (opt-in) and "Find logo" (BIMI, then site icon),
  fetched by the server and cached: `backend/src/assist/logos.ts`.
- Filtered study: mail filed by other clients or server rules now trains the
  classifier; daily model-written filing profile feeds every filing prompt:
  `backend/src/filter/study.ts`.
- `./mainly.sh hermes <ssh-host> <email>` / `./dev.sh hermes`: installs the
  MCP server on the agent's host, token via SSH stdin into Hermes's `.env`,
  registers, tests, installs a skill. Tested end to end against the dev API
  through a reverse tunnel, including renewal; the test entry, token, secret
  line and files were removed from the agent host afterwards.
- Docs: `docs/assist.md` (new), `docs/filtering.md`, `docs/mcp.md`, README,
  skill.

## Next
1. Review the uncommitted diff on main, branch, and commit it in three parts.
2. Save a real OpenRouter key in Settings → Assist and press Try (only a bogus
   key was tested live: it fails with "openrouter.ai did not accept it: 401").
3. Run `./mainly.sh hermes <ssh-host> <email>` against the real install.
4. Release when ready (`./publish.sh`); CHANGELOG entry not yet written.

## Waiting on you
- A real OpenRouter (or other) key to confirm the success path end to end.
- Running the Hermes command against the production install (it mints a token
  there, so it was not run from this session).

## Loose ends
- Uncommitted: backend (assist module, study.ts, migration 018, llm.ts,
  routes, arrivals, consistency-check + fake-llm.mjs), frontend (Assist
  settings, recap, sender avatar/menu, store, types), scripts
  (connect-hermes.sh, mainly.sh, dev.sh), mcp/hermes/SKILL.md, docs.
- CI (`.github/workflows/ci.yml`) does not run consistency-check, so the new
  integration checks run only in `./dev.sh check`.
- Dev API and web are running on :5274 / :5273.
