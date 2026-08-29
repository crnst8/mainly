## Unreleased

feat: text weight setting

Appearance gains a Text weight slider under Text size — Light, Regular, Bold —
reported from a phone, where the mail list read as too thin to scan.

Every `font-weight` in the app's own CSS now resolves through a five-rung token
ramp (`--w-light` … `--w-bold`) that `[data-weight]` shifts as a unit, anchored
on `body` so the elements that never name a weight — preview lines, most body
copy — ride it too rather than sitting on the user agent's 400.

Three steps because three is all there is. The UI face ships three static files,
and a list only works while emphasis outweighs body text, so body type can be
drawn Regular or Medium and nothing else — Bold body means a read row and an
unread row come out of the same file. That leaves exactly three honest pairs of
(body, emphasis), and those are the three steps. A first cut had four; two of
them rendered the message list identically, which measurement caught and the
slider would not have.

All six existing sliders were unlabelled to a screen reader and announced a bare
number — "slider, 2" for a control whose value is "Bold" or "Never". `Slider`
now requires an `ariaLabel`, as `Segmented` already did, and announces its
readout as `aria-valuetext`.

A message body inherits the setting only where its sender declared no weight of
their own; an explicit weight in the mail's CSS still wins, as it already did.
`font-synthesis-weight: none` outside the message keeps Paper Mono — one file —
from being faux-bolded at the top of the ramp, and is turned back on inside the
message, where a sender's `<b>` is not ours to flatten.

Paper resets the ramp. `@media print` already overrules dark mode and the
contrast setting on the grounds that paper is not a screen, and the weight
setting answers a screen problem that three hundred dpi of black on white does
not have. It also keeps this route agreeing with print.ts, which builds its own
document at fixed weights.

The pre-paint script in index.html now also restores text size and weight, so
neither reflows a frame after the first.

## 1.2.2 — 2026-08-27

- docs: release notes for 1.3.0
- feat: inverted colours toggle & print

## 1.3.0 — 2026-08-27

Added a colour engine (`relight.ts`) that keeps a sender's hues and moves only lightness, driving three things: mail bodies re-lit for dark mode with a one-key toggle (i) back to the original.

Also included is a print path (p / ⌘P) that builds a chrome-free document titled with the subject so Save as PDF names receipts properly, and a "borrowed surface" rule that gives a message its assumed background when it declared none, fixing white-on-white in both directions.

## 1.2.1 — 2026-08-26

fix: honour imapflow command results so read marks survive sync

`imapflow` answers a refused `STORE/MOVE/COPY/EXPUNGE` with `false` rather than
throwing. Replay ignored that and deleted the sync_ops row anyway, which also
removed the guard in envelopes.ts that holds local flag state while a change is
in flight, so the next envelope pass wrote the server's still-unread flag back
over the read. Mail marked read came back unread seconds later and survived a
reload; the sidebar counts followed it.

Replay now fails the op on a falsy result, so it retries and then parks with the
server's own words while the guard keeps what the user did. A mailbox whose
PERMANENTFLAGS will not keep \Seen is refused up front instead of eight silent
retries. pool.ts swaps `logger: false` for a logger that remembers only the
refusal text, since that was the sole channel for the server's reason.

Adds replay.test.ts covering the return-value handling.

## 1.2.0 — 2026-08-25

**Features**:

- Sender & domain monograms can be changed to images or icons by right-click
- Help page added with feature walkthroughs & configurations - needs some de-slopificiation but offers some starting guidance
- Tags assigned to emails & senders appear as badges in msg rows

**Fixes:**

- Account group folder colours weren’t showing,
- Shift-select bulk messages was intermittent
- ‘mainly’ removed from header logo
- clicking header logo when in collapsed/half-screen mode now goes back to message list
- html parsing occasionally failed in previews

## 1.1.4 — 2026-08-24

- fix: parsing error, read marks, general swag

## 1.1.3 — 2026-08-22

- fix: publish pipeline fixes

## 1.1.2 — 2026-08-22

- feat: bind to 0.0.0.0 so a fresh install now answers on LAN + Tailscale + localhost, and login works over plain HTTP

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

