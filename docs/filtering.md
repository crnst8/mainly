# The Filtered folder

Every mailbox gets a **Filtered** folder under its inbox. **Filter out** moves a
message there, and new mail from the same sender or mailing list goes there
instead of the inbox. Filtered mail does not notify.

The filter learns from where you put mail. There is no separate training step:
filing a message teaches it, taking one back out corrects it.

## Using it

| Where | How |
| --- | --- |
| Keyboard | `⌘⌫` / `Ctrl+⌫`, or `-`. `g f` opens Filtered. |
| List row | The Filter out button in the row's hover actions. |
| Reader | The Filter out button after Trash. |
| Selection | The Filter out button in the bulk bar, or right-click → Filter out. |
| Command palette | `⌘K` → Filter out. |
| Phone | The reader's **⋯** sheet, or set a swipe to Filter out in **Settings → Mobile**. |

Undo (`z`, or the toast) moves the message back and withdraws what it taught.
Filter out on a message that is already in Filtered moves it to Trash.

The sidebar's **Filtered** row shows every mailbox's Filtered folder together,
the same way **Inbox** does.

## How it decides

New inbox mail goes through four checks in order. The first that answers
decides; anything left undecided stays in the inbox.

1. **Your rules.** Filing a message records its mailing list (`List-Id`) when
   it has one, otherwise its sender address. The newest decision about a list or
   sender wins: file one and its next mail is filed; take one back out and its
   next mail stays. Rules apply to every mailbox, including ones added later.
   A list is preferred over a sender because one address often sends several
   kinds of mail: filtering one repository's notifications from a code host
   does not filter the others.
2. **People you write to.** Mail from an address in any Sent folder, or in a
   conversation you have written in, is never filed by the next two steps.
   Only an explicit rule from step 1 overrides this.
3. **The classifier.** With **Learn** on, a per-user statistical classifier
   scores mail from senders it has not seen. It reads sender, domain, how you
   were addressed (To, Cc or neither), whether the mail was sent in bulk
   (`List-Unsubscribe`, `List-Id`, `Precedence`), and words in the sender name,
   subject and preview. It is trained on mail you filed, mail you took back
   out, and mail you read and left in your inbox or archive. It acts once it
   has at least 3 filed and 20 kept examples, and only when its score reaches
   the **Sensitivity** threshold: 97% cautious, 92% balanced, 85% eager.
4. **A language model** (optional, off by default). Mail the classifier was
   unsure about, or all new mail before the classifier has enough examples, is
   sent to a model with your most recent examples. It files only at 90% / 80% /
   70% confidence for the three sensitivities.

Only mail that arrives after a folder's first sync goes through steps 2–4. A
newly added mailbox's existing inbox is filed by rules alone.

The classifier uses the SpamBayes method (Robinson's per-word probabilities
combined with Fisher's chi-squared test). It is used here because it reports
"unsure" when strong evidence points both ways, rather than a confident wrong
answer, and it needs no tuning to work on a few hundred examples.

### Correction

Every message the filter files by itself is recorded. If you move one back
out, that counts against the step that filed it, and its sender or list gets a
"keep" rule. Once a step has filed 10 or more messages in the last 60 days, its
rescue rate raises its threshold: at a 10% rescue rate the threshold has moved
80% of the way to certainty. A good record never lowers the threshold below the
sensitivity you chose.

Moving filtered mail to Trash or Junk teaches nothing. Deleting it is what the
folder is for.

## Settings → Filtered

| Setting | Effect |
| --- | --- |
| Filter new mail | Master switch. Off: no Filtered folder is created and nothing is filed on arrival. Filter out still moves mail into an existing Filtered folder. |
| Learn | Step 3. Off: rules and correspondence only. |
| Sensitivity | The classifier and model thresholds above. |
| Inbox mail from filtered senders → File now | Applies your rules to up to 5,000 of the newest messages in each inbox. Rules only; the classifier and the model never move existing mail. |
| Learned | How many examples you have given, whether the classifier is trained, how much it filed by itself and how much of that you took back, and the threshold it currently needs. |
| Ask a model when unsure | Step 4. Available only when the server has a model configured. |
| Model | Any model the provider lists. **Try** sends one made-up message (never your mail) and shows the model's answer and how long it took. |
| Filtered senders and lists / Kept in the inbox | Every rule, newest first. The bin forgets all examples from that sender or list. |
| Filter in | Mailboxes the filter leaves alone. |

## Language model

The server operator configures the provider; each user only chooses a model
from its list and turns the feature on for themselves. See
[configuration.md](configuration.md#filtered-folder) for the variables.

Any OpenAI-compatible `chat/completions` endpoint works:

| Provider | `FILTER_LLM_URL` |
| --- | --- |
| OpenCode Go (default) | unset |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Ollama | `http://<host>:11434/v1` |
| LM Studio | `http://<host>:1234/v1` |

On OpenCode Go only models served on its chat completions endpoint work; models
it serves only through its Messages or Responses endpoints fail in **Try**. The
default, `mimo-v2.6-flash`, was the cheapest chat completions model with the
largest monthly allowance in October 2026 ($0.14 in / $0.28 out per million
tokens). `glm-5.3-flash` is the alternative at a similar price.

### What is sent

For each message asked about: sender name and address, subject, the first 200
characters of the preview, whether you were addressed directly, and whether it
was sent in bulk. With it, up to 20 senders and subjects you filed and up to 20
you kept. Never a body, an attachment, or another recipient. Text is cut to
length and stripped of line breaks before it is sent.

Requests carry a `mainly/<version>` user agent. OpenCode Go refuses requests
without an `x-opencode-session` header, so requests to it also carry one per
user: an HMAC of the user id under this install's `SESSION_SECRET`. It is the
same for every request from that user and means nothing outside this install.
Other providers do not receive it.

### Limits

- At most `FILTER_LLM_HOURLY_MAX` messages per user per hour (default 120).
- Requests time out after `FILTER_LLM_TIMEOUT_MS` (default 12 s).
- A timeout, an error, or an answer the filter cannot read leaves the mail in
  the inbox.
- The key is sent only to the configured host; redirects are refused.

Mail text is untrusted input to the model. A message written to manipulate the
model can at most move itself into or out of Filtered, which you can see and
undo.

## Folders on the mail server

The folder is created with an ordinary IMAP `CREATE` as `INBOX.Filtered` (or
`INBOX/Filtered`, with the server's own delimiter). A server that refuses
folders under the inbox gets a top-level `Filtered` instead. A folder already
named `Filtered` anywhere is used as it is. Other mail clients see it as an
ordinary folder.

Filing is an ordinary IMAP move, so other clients see filed mail in Filtered.
Moves made in another client are not seen as teaching: the filter only learns
from moves made in Mainly or through its API.

## Agents

An agent token with `write` scope that moves mail into or out of Filtered
through `/messages/actions` teaches the filter exactly as a person does.
`GET /api/filter/status`, `POST /api/filter/forget` and `POST /api/filter/sweep`
follow the usual token scopes. The model list and **Try** are session only.
