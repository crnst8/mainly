## 1.2.3 — 2026-08-29

- feat: text weight setting

Appearance gains a Text weight slider under Text size (Light, Regular,
Bold).

Every font-weight in the app's own CSS now resolves through a
five-rung token ramp that [data-weight] shifts as a unit, anchored on
body so elements that never name a weight ride it too.

Three steps because three is all there is: the UI face ships three
static files, and a list only works while emphasis outweighs body text,
so body type can be Regular or Medium and nothing else. Paper resets the
ramp, matching print.ts. Slider now requires an ariaLabel and announces
its readout, as Segmented already did.

Closes #2

## Unreleased

fix(security): close an SSRF, a rate-limit bypass, and plaintext session ids

A follow-up audit of the code rather than the dependency tree. Nine findings,
each reproduced before it was changed and re-run after.

**Rate limits were bypassable with one header.** `trustProxy: true` made `req.ip`
the leftmost `X-Forwarded-For` value — which anyone can set — and every limiter
keys on `req.ip`. Eight login attempts with a rotating header drew zero 429s.
There is no account lockout behind that limiter, so it was the only thing
bounding password guessing. Two changes: `TRUST_PROXY` now says who may assert a
client address and defaults to nobody, and the login limiter keys on the
*account* rather than the caller, lowercased, because the account is the thing
that cannot be spoofed. An https `APP_ORIGIN` with no `TRUST_PROXY` warns at boot.

**`/onboarding/autoconfig` fetched anything it was pointed at.** The domain came
from `address.split('@')[1]` unvalidated, so `you@127.0.0.1:9200` reached an
internal port and `you@localtest.me` reached loopback through an ordinary public
DNS record — with `redirect: 'follow'` on top. Authenticated, but reachable with
a read-scoped agent token and rate limited by nothing.

**The two SSRF guards disagreed, and the weaker one covered mail servers.** The
unsubscribe path resolved a name and checked every answer; `assertHostAllowed`
pattern-matched the string, so `2130706433`, `0x7f000001`, `017700000001` and
`localtest.me` all walked through it to loopback. There is now one guard,
`lib/ip.ts` plus `lib/net-guard.ts`: addresses are compared as bytes so no
spelling helps, and names are resolved before they are judged. It also picks up
the ranges the old v4 list omitted (198.18/15, 224/4, 192.0.0/24, broadcast) and
the v6 spellings of loopback the old regex missed — `0:0:0:0:0:0:0:1`,
`::ffff:7f00:1`, `::127.0.0.1`. Unparseable input is now private rather than
public, because failing open on input you did not understand is a hole shaped
like that input.

**Session ids were stored in the clear.** `sessions.id` *was* the cookie, so any
read of that table — a `pg_dump` in `./backups`, a replica, a support copy — was
a set of live credentials rather than a record that sessions existed.
`api_tokens` has always hashed; sessions now do the same, sha256, for the same
reason (32 random bytes have no dictionary to defend against). Existing sessions
end at migration `011`: everyone signs in once more. Backups are written 600 into
a 700 directory instead of inheriting umask 022, and expired rows are swept
hourly rather than kept forever.

Smaller: `ci.yml` had no `permissions` block while `release.yml` scoped all three
of its jobs; the Docker base is pinned by digest, with Dependabot watching it so
the pin cannot rot into a stale base; and `<img src="data:...">` is narrowed to
`data:image/*`, which is what SECURITY.md already claimed.

Regression cover for all of it: `lib/ip.test.ts` is the table of spellings,
`lib/crypto.test.ts` covers what must not be recoverable from storage, and
`scripts/auth-check.mjs` drives the real app and fails if either half of the
rate-limit fix is reverted. Unit tests 21 → 31.

fix(security): patch three upstream advisories, and stop finding them by hand

Reported from an external security review. `npm audit` was clean on integrity —
every one of the 355 packages resolved to `registry.npmjs.org` with a matching
hash — so this was dependency freshness, not anything malicious.

`@fastify/static` 8.3.0 → 10.1.3 closes a path-traversal and two route-guard
bypasses via non-canonical and percent-encoded paths (GHSA-83w8-p2f5-377r high,
plus three moderates). This one is only load-bearing when `WEB_ROOT` is set and
the API also serves the SPA, which is the default single-container install. The
v10 `setHeaders` callback takes a `FastifyReply` rather than a Node response, so
the immutable-asset and no-cache-index rules in `server.ts` now go through
`reply.header`.

`mailparser` 3.9.14 → 3.9.17 pulls `html-to-text` 10.0.1 and `deepmerge-ts` 8,
closing a stack exhaustion when merging recursive object graphs
(GHSA-ggr8-5vv4-36mx). This is the one worth having: `simpleParser` runs on
bytes a stranger mailed you, so a crafted message could stall the sync worker.
A parser DoS, not RCE and not disclosure.

`nanoid` → 3.3.18 in backend and frontend, transitive through postcss
(GHSA-2v37-7h3g-55p8). An infinite loop that needs a custom generator and size
0, which nothing here does — taken because it costs a lockfile bump.

The part that matters more than the three bumps: `scripts/audit-check.mjs` now
gates all three lockfiles in `ci.yml` and `./dev.sh check`, a weekly workflow
runs the same script and files one issue when nobody has opened a PR, and
Dependabot watches all three workspaces. Runtime advisories block; build-time
ones warn, because a gate that fails every PR over a dev-tree transitive is a
gate that gets deleted. Waivers live in `.github/audit-allowlist.json` and need
a reason and an expiry.

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

