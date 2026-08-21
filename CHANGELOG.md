## 1.1.1 — 2026-08-21

**Backend:**
- GET /auth/session → returns your email
- POST /auth/password → verifies current, sets new, deletes every other session. Rate-limited, refuses API tokens
- Both registered behind requireAuth
- Logger redacts the new password fields
- Seed resets the fixture password so smoke can't poison it

**Frontend:**
- Rail bottom: account menu → email, Change password, Sign out
- Settings → new Sign-in tab: email, 3-field change form, Sign out (with confirm)
- Command palette: two new entries
- MailApi gained session / changePassword / signOut, implemented in both http and mock adapters
- Store: user state, sign-out reloads the document

- feat: auth mgmt for account page, closes #1

## 1.1.0 — 2026-08-21

Sender identities, mobile updates & general UI/UX tweaks for readability, spacing, fonts etc.

Sender identities: lets you define a sender profile (name, one-or-more domains incl. their subdomains, optional HTTPS logo URL, per-sender remote-image trust). Shown as logos in place of monograms via a new SenderAvatar component, managed in a new "Senders" settings tab, with "Always allow" buttons in both the desktop and mobile readers. Backed by new lib/sender.ts policy code, contract/preferences additions (senderProfiles), and a new sender-check.mjs wired into dev.sh check.

Mobile compose screen: a new full-screen MobileComposer (replaces the docked composer on mobile), plus a useKeyboardInset hook so the keyboard never covers the send bar. Recipient parsing was hoisted into a shared parseAddrs used by both composers; mobile row layout was reworked (sender/subject/date on separate lines).

Small UI/UX tweaks: reader header drops the "to/cc" line and gets tighter padding; sidebar header/account-count removed and group icons now tinted via icon fill; empty-state typography restyled; a --danger button variant added.

- feat: add sender identities (+ general ui tweak)
- feat: full-screen mobile composer
- site: label the quick start command
- feat: touch shell and installable PWA

