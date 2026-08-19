/**
 * Turning API objects into text a model can act on.
 *
 * Two rules, and they pull against each other:
 *
 *  1. **Every row carries its id.** A tool result the agent cannot follow up on
 *     is a dead end — it will guess an id, or re-search, or ask the user.
 *  2. **Nothing else is included twice.** A 25-row search that prints full
 *     previews, every label and both addresses spends the context window on
 *     text the next tool call does not need.
 *
 * So: one line per message, id first, and the fields that decide what to do
 * with it — who, when, what, and the flags that change the answer.
 */

import type { Account, Folder, Message, MessageSummary, UnsubscribePlan } from './client.ts';

/** `2026-08-11` — the resolution anyone actually triages at. */
const day = (iso: string): string => iso.slice(0, 10);

const who = (a: { name: string | null; address: string }): string =>
  a.name ? `${a.name} <${a.address}>` : a.address;

const bytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;

/** Only what is unusual. A line of `read no-flag no-attachment` on every row is
 *  noise; the absence of a marker says the same thing for free. */
function marks(m: MessageSummary): string {
  const out: string[] = [];
  if (!m.seen) out.push('unread');
  if (m.flagged) out.push('flagged');
  if (m.answered) out.push('answered');
  if (m.hasAttachments) out.push('attachment');
  if (m.threadCount > 1) out.push(`thread:${m.threadCount}`);
  if (m.priority !== 'normal') out.push(m.priority);
  if (m.labels.length) out.push(`labels:${m.labels.join('/')}`);
  return out.length ? `  [${out.join(' ')}]` : '';
}

export function formatSummary(m: MessageSummary): string {
  return `${m.id}  ${day(m.date)}  ${who(m.from)}  ${m.subject || '(no subject)'}${marks(m)}`;
}

export function formatList(
  messages: MessageSummary[],
  total: number,
  approximate: boolean,
  nextCursor: string | null,
): string {
  if (!messages.length) return 'No messages matched.';
  const head = `${messages.length} shown of ${approximate ? `${total}+` : total} matching`;
  const tail = nextCursor
    ? `\n\nMore results available. Pass cursor: ${nextCursor}`
    : '';
  return `${head}\n\n${messages.map(formatSummary).join('\n')}${tail}`;
}

/**
 * A whole message.
 *
 * The plain-text body is preferred and the HTML is never included: it is
 * mostly layout, it is frequently ten times longer, and a model reading a
 * table-based newsletter's markup learns nothing the text part does not say.
 * When there is only HTML, that is stated rather than silently dropped.
 */
export function formatMessage(m: Message, maxBodyChars: number): string {
  const lines = [
    `id:       ${m.id}`,
    `account:  ${m.accountId}`,
    `folder:   ${m.folderId}`,
    `from:     ${who(m.from)}`,
    `to:       ${m.to.map(who).join(', ') || '(none)'}`,
  ];
  if (m.cc?.length) lines.push(`cc:       ${m.cc.map(who).join(', ')}`);
  lines.push(
    `date:     ${m.date}`,
    `subject:  ${m.subject || '(no subject)'}`,
    `state:    ${m.seen ? 'read' : 'unread'}${m.flagged ? ', flagged' : ''}${m.answered ? ', answered' : ''}`,
  );
  if (m.labels?.length) lines.push(`labels:   ${m.labels.join(', ')}`);
  if (m.attachments?.length) {
    lines.push(
      `files:    ${m.attachments.map((a) => `${a.filename} (${a.mimeType}, ${bytes(a.size)})`).join(', ')}`,
    );
  }
  // The one header an agent asked to unsubscribe needs to see before it commits
  // to anything. The rest are available through the message endpoint if needed.
  if (m.headers?.['list-unsubscribe']) {
    lines.push(`list-unsubscribe: ${m.headers['list-unsubscribe']}`);
  }

  if (m.bodyError) {
    lines.push('', `body could not be loaded: ${m.bodyError}`);
    return lines.join('\n');
  }

  const body = m.bodyText?.trim();
  if (body) {
    const clipped = body.length > maxBodyChars;
    lines.push(
      '',
      clipped ? `${body.slice(0, maxBodyChars)}\n\n[…truncated at ${maxBodyChars} characters]` : body,
    );
  } else if (m.bodyHtml) {
    lines.push('', '(This message has an HTML part only. Open it in the app to read it.)');
  } else {
    lines.push('', '(No body.)');
  }
  return lines.join('\n');
}

export const formatAccounts = (accounts: Account[]): string =>
  accounts.length
    ? accounts
        .map(
          (a) =>
            `${a.id}  ${a.address}  domain:${a.domain}  priority:${a.priority}  status:${a.status}` +
            (a.hidden ? '  [hidden from combined views]' : ''),
        )
        .join('\n')
    : 'No accounts are connected.';

export const formatFolders = (folders: Folder[]): string =>
  folders.length
    ? folders
        .map((f) => `${f.id}  ${f.accountId}  ${f.path}  role:${f.role}  ${f.unread}/${f.total} unread`)
        .join('\n')
    : 'No folders.';

export function formatPlan(plan: UnsubscribePlan): string {
  const lines = [
    `message:  ${plan.messageId}`,
    `sender:   ${who(plan.from)}`,
    `list-id:  ${plan.listId ?? '(none)'}`,
    '',
  ];
  if (!plan.options.length) {
    lines.push('This message published no unsubscribe method. There is nothing to act on.');
  } else {
    lines.push('options, best first:');
    for (const o of plan.options) {
      lines.push(
        `  ${o.automatic ? 'CAN DO' : 'MANUAL'}  ${o.method}  ${o.target}` +
          (o.blockedReason ? `\n          ${o.blockedReason}` : ''),
      );
    }
  }
  if (plan.history.length) {
    lines.push('', 'earlier attempts against this sender:');
    for (const h of plan.history) {
      lines.push(`  ${h.at}  ${h.status}  ${h.method}  by ${h.actor}`);
    }
  }
  return lines.join('\n');
}
