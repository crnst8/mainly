---
summary: Self-hosted webmail client: React frontend, Fastify/Postgres backend and MCP server; mirrors IMAP metadata into Postgres.
state: active
priority: 1
updated: 2026-10-06
next: Remove the duplicate `## 1.3.7` entry at the top of `mainly/CHANGELOG.md`.
---

# mainly status

## Where it stands
Released 1.3.8 on 2026-10-05 (notifications and custom bins). 1.3.7 (2026-10-04) cut IMAP sync requests to about a tenth and bumped fastify, nodemailer and mailparser past high advisories.

## Done recently
- `ac4fb71` notifications and custom bins (1.3.8).
- `7f0a788` sync sends far fewer IMAP requests (1.3.7).
- `9533866` dependency bumps past high advisories (1.3.7).

## Next
1. Remove the duplicate `## 1.3.7` entry at the top of `mainly/CHANGELOG.md`.
2. Watch sync logs for a day to confirm the 1.3.7 request reduction holds with push accounts (15-minute poll).

## Waiting on you
- None.

## Loose ends
- None. Tree clean, nothing unpushed.
