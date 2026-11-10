# Assist

Work the app does for you with a language model, beyond the Filtered folder,
and sender logos. None of it writes mail.

| Feature | Uses the model | Default |
| --- | --- | --- |
| [Kind labels](#kind-labels) | yes | off |
| [Recap](#recap) | yes | on request |
| [Filing profile](filtering.md#filing-profile) | yes | with **Ask a model when unsure** |
| [Sender logos](#sender-logos) | no | off |

Everything is in **Settings → Assist**.

## The model

One provider and one model serve every model task, so they are chosen once,
under **Settings → Assist → Language model**: OpenCode Go, OpenRouter, OpenAI,
or any OpenAI-compatible URL, with your own API key. A server whose operator
configured `FILTER_LLM_*` gives every user a provider without a key of their
own. How keys are checked, stored and limited is in
[filtering.md](filtering.md#your-own-key).

Having a key sends nothing on its own. Each task has its own switch.

### What is sent

The same fields the filter sends: for each message, the sender's name and
address, the subject, the first 200 characters of the preview, whether you were
addressed directly, and whether it was sent in bulk. The recap also sends the
date, the receiving address, read and flagged state, and labels. Never a body,
an attachment, or another recipient. Text is cut to length and stripped of line
breaks first, and the instructions tell the model that the messages are data,
not instructions.

## Kind labels

With **Label new mail by kind** on, each new inbox message is labelled with
what it is, when it clearly is one of these:

| Label | For |
| --- | --- |
| `action` | You have to reply, decide, sign, pay or do something soon. |
| `bill` | An amount you owe, an invoice, a payment due. |
| `receipt` | A payment, order or subscription already made. |
| `shipping` | A parcel on its way, delayed or delivered. |
| `travel` | A booking, ticket, itinerary, boarding pass or check-in. |
| `security` | A sign-in code, password reset, new-device or security alert. |
| `event` | An invitation, appointment or meeting with a date. |

A message gets at most two. They are the app's own labels: `label:bill` finds
them, the sidebar counts them, and you remove one like any other. Labels never
move or hide mail, and a label you added yourself is never replaced.

- Only mail that stays in the inbox after spam and Filtered filing is
  labelled, and only mail that arrives after the folder's first sync.
- Messages are sent in batches of 20, with their own hourly allowance of
  `FILTER_LLM_HOURLY_MAX` messages, separate from the filter's.
- A timeout, an error, or an unreadable answer leaves the mail unlabelled.

Useful searches: `label:action is:unread`, `label:bill after:30d`,
`label:shipping after:7d`.

## Recap

**Recap** (the sparkle button in the top bar once a model task is on, the
command palette, or **Settings → Assist**) summarises your inbox for today,
since yesterday, or the last 7 days:

- **Needs you** — up to eight messages that need a reply, decision, payment or
  action, most urgent first, each with what is needed.
- **Worth knowing** — up to six that need nothing but matter.
- A few lines on the period, and how many messages carry each kind label.

Every item opens its message. The recap reads the newest 120 inbox messages in
the period, skipping snoozed mail. It is kept for 10 minutes, and written
again sooner when new mail arrives or something is read. One recap counts as
20 messages against an hourly allowance of its own. It is session only: agent
tokens cannot spend the allowance.

## Sender logos

Senders show a monogram unless their identity has a logo. Two ways to get one:

- **Find logo**, in the menu on any sender's avatar, looks up that sender's
  domain now: its [BIMI](https://bimigroup.org) record first, then the
  `apple-touch-icon` or largest icon on the domain's home page, then
  `/favicon.ico`. A found logo is attached to the sender identity like a URL you
  typed.
- **Show published logos** (off by default) shows the BIMI logo for every
  sender whose domain publishes one. BIMI is the domain stating "this is our
  mark", so it is the only source used without you asking for a sender.

Lookups are made by this server, never by your browser, and the image is
served from this app's own origin, so the sender's site never learns which
person or device looked. Results, including "none", are cached per domain for
the whole install: 30 days for a logo, 7 for none.

- Only domains you have received mail from are looked up.
- Common personal mail providers (Gmail, Outlook, iCloud, Proton, Fastmail
  and others) are never looked up, so a friend's mail does not get their
  provider's logo.
- Each request goes through the same private-address guard as mail servers,
  redirects are followed by hand with the guard applied to each, images are
  capped at 256 KB and pages at 512 KB.
- Logos are served with a sandboxing `Content-Security-Policy`, so an SVG
  opened directly cannot run script on this origin.
