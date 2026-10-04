# Notifications, spam and missing folders

Three things the sync worker does for you after it indexes new mail. All three
are set in **Settings → Notifications** and **Settings → Spam & folders**, and
stored in your preferences, so they apply to every browser you sign in from.

## New-mail notifications

Mainly sends Web Push notifications to each browser that turns them on. Nothing
is sent until a device opts in.

### Turning them on

Open **Settings → Notifications** on the device and switch on **This device**.
The browser asks for permission once. **Send test** confirms the device
receives them.

| Platform | Requirement |
| --- | --- |
| iPhone / iPad | iOS 16.4 or later, and Mainly added to the Home Screen and opened from there. Safari tabs cannot receive web push. |
| Android, desktop Chrome / Edge / Firefox | Works in a tab or as an installed app. |
| macOS Safari | Safari 16 or later. |

Push needs the app on `https://` (or `localhost`). It is not available in a
development build (`./dev.sh start`), because the service worker is registered
only in production builds.

### What you can set

| Setting | Effect |
| --- | --- |
| Notify | Master switch for every device. |
| Show | `Subject`: sender, subject and preview. `Sender`: sender and mailbox. `Count`: only how many arrived. |
| Folders | `Inbox`, or `All` folders except Sent, Drafts, Junk and Trash. |
| Group by mailbox | One notification per mailbox that counts up ("5 new messages"), instead of one per message. |
| Silent | No sound or vibration. |
| Priority | Which account priority tiers notify. Default: critical, high, normal. |
| Quiet hours | A daily window with no notifications. It uses the time zone of the device that last changed it. |
| Mailboxes | Turn notifications off for single mailboxes. |
| Other devices | Every subscribed browser, with a test button and remove. |

Only mail that arrives after a folder's first sync notifies. A new account's
backlog does not, and neither does unread mail older than 48 hours that another
client moves into the inbox. Spam never notifies.

When the app is open and in front on a device, that device's notification is
skipped, except on Safari, which requires every push to show one. Opening the
app clears its notifications and the app-icon badge.

### Privacy

Each notification is encrypted on the server to the receiving browser's own key
(RFC 8291) before it leaves. The push service that carries it — Google's FCM
for Chrome and Android, Apple's for Safari, Mozilla's for Firefox, Microsoft's
for Edge on Windows — sees only ciphertext, the time it was sent, and the
device it is for. If that is still more than you want, leave notifications off,
or set **Show** to `Count`.

The server only sends to endpoints on those push services. Agent tokens cannot
register a device.

The server's VAPID key pair is created on first use and stored sealed under
`SECRET_KEY`. Restoring a database without its `SECRET_KEY` means turning
notifications on again on each device.

## Spam filing

With **Move spam to Junk** on (the default), new Inbox mail that the receiving
server marked as spam is moved to the account's Junk folder, through the same
queue as a move you make yourself. A message counts as marked when:

- its subject starts with `***SPAM***` (SpamAssassin and Rspamd subject
  rewriting), or
- it carries `X-Spam-Flag: YES` (SpamAssassin).

Mainly makes no spam judgement of its own. A message you move back out of Junk
stays where you put it. Individual mailboxes can be excluded.

## Missing Trash and Junk

With **Create missing Trash and Junk** on (the default), the folder pass creates
`Trash` and `Junk` on any mailbox that has neither, with an ordinary IMAP
`CREATE` as the mailbox's own user. Without a Trash folder, Move to trash is
refused; without Junk, spam has nowhere to go.

Many servers declare these folders but create them only when a client asks. On
Dovecot that is a `mailbox` block without `auto = create`. A server that refuses
the `CREATE` is asked once per process, and the refusal is logged.
