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
| Learn | Step 3. Off: skips the classifier; the optional language model can still run. |
| Sensitivity | The classifier and model thresholds above. |
| Inbox mail from filtered senders → File now | Applies your rules to up to 5,000 of the newest messages in each inbox. Rules only; the classifier and the model never move existing mail. |
| Learned | How many examples you have given, whether the classifier is trained, how much it filed by itself and how much of that you took back, and the threshold it currently needs. |
| Ask a model when unsure | Step 4. Available once you have saved an API key, or the server has one configured. |
| Provider · API key | Your own provider and key. See [Your own key](#your-own-key). |
| Model | Any model the provider lists. **Try** sends one made-up message (never your mail) and shows the model's answer and how long it took. |
| Filtered senders and lists / Kept in the inbox | Every rule, newest first. The bin forgets all examples from that sender or list. |
| Filter in | Mailboxes the filter leaves alone. |

## Language model

Each user turns the feature on for themselves and chooses a model from the
provider's list. The provider is the user's own, from **Settings → Filtered**,
or else the one the server operator configured. See
[configuration.md](configuration.md#filtered-folder) for the variables.

Any OpenAI-compatible `chat/completions` endpoint works:

| Provider | `FILTER_LLM_URL` |
| --- | --- |
| OpenCode Go (default) | unset |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Ollama | `http://<host>:11434/v1` |
| LM Studio | `http://<host>:1234/v1` |

The default is `minimax-m3.1-flash`. On 2026-10-24 it classified all ten
synthetic messages correctly in each of three runs (2.4–2.9 s per batch),
including keeping personal mail, security alerts, deliveries and bills.
`glm-5.3-flash` and `mimo-v2.6-flash` also passed all three runs, taking
4.6–8.7 s and 6.5–7.7 s respectively. This small fixture checks compatibility
and basic behavior; it does not establish accuracy on your mailbox.

Single runs of `deepseek-v4.1-flash`, `longcat-2.5-preview-free`, `mimo-v2.5`
and `qwen3.8-flash` also passed, but Qwen took longer than the default timeout.
`hy3` returned no readable verdicts. Availability depends on the provider and
workspace settings; use **Try** before selecting another model. The model list
shows the provider’s advertised ids; **Try** checks whether each one can return
a usable classification through chat completions.

To repeat the synthetic benchmark without sending any mail, export
`FILTER_LLM_KEY` in your shell, then run from the repository root:

```sh
node --experimental-strip-types backend/scripts/filter-benchmark.mjs minimax-m3.1-flash glm-5.3-flash mimo-v2.6-flash
```

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

### Your own key

**Settings → Filtered → Provider · API key** saves a provider for your user
only. It replaces the server's provider for you, and works on a server that has
none configured.

| Provider | URL sent |
| --- | --- |
| OpenCode Go | OpenCode Go's own endpoints; default model `minimax-m3.1-flash` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Other | Any OpenAI-compatible base URL you type, such as `http://<host>:11434/v1` for Ollama |

- **Save** checks the key by listing the provider's models with it. A key the
  provider refuses is not saved, and the provider's error is shown.
- The key is encrypted under `SECRET_KEY` (AES-256-GCM, as mailbox passwords
  are) and never returned by any endpoint. The screen shows only that a key is
  saved and the host it goes to. Enter a new key to replace it; the bin removes
  it, and the server's provider, if any, applies again.
- With **Other**, the key may be left empty for a local server that needs none.
  A URL on a private or reserved address is refused unless the operator set
  `ALLOW_PRIVATE_IMAP_HOSTS`, and the address is checked again on every request.
- With **Other** there is no default model; choose one from the list.
- The routes that save, remove, list or try are session only. An agent token
  cannot reach them at any scope.
- Changing provider clears the chosen model when the new host differs.

### Limits

- At most `FILTER_LLM_HOURLY_MAX` messages per user per hour (default 120).
- Requests time out after `FILTER_LLM_TIMEOUT_MS` (default 12 s).
- A timeout, an error, or an answer the filter cannot read leaves the mail in
  the inbox.
- The key is sent only to the provider's host; redirects are refused.
- The hourly cap applies to your own key too.

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
