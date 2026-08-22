#!/usr/bin/env node
/**
 * MCP client for the browser HTTP API.
 * Mutations accept ids or a search selector, require `dryRun`, and cap targets.
 * Destructive annotations support client confirmation; errors return text.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { MailApiError, MailClient, type MessageSummary, type Scope } from './client.ts';
import {
  formatAccounts,
  formatFolders,
  formatList,
  formatMessage,
  formatPlan,
  formatSummary,
} from './format.ts';

/* ── Configuration ──────────────────────────────────────────────────────────*/

const token = process.env.MAIL_API_TOKEN?.trim();
if (!token) {
  // stderr, not stdout: stdout is the JSON-RPC channel and a stray line on it
  // breaks the client's parser before it can show anything.
  console.error(
    'MAIL_API_TOKEN is not set.\n\n' +
      'Mint one on the machine running the backend:\n' +
      '  ./mainly.sh token create you@example.com "agent" --scopes read,write\n',
  );
  process.exit(1);
}

const client = new MailClient(process.env.MAIL_API_URL, token);

/** How much of a body one `mail_read_message` call is allowed to spend. */
const MAX_BODY_CHARS = Number(process.env.MAIL_MCP_MAX_BODY_CHARS ?? 8000);

/** Maximum messages selected by one mutating MCP call. */
const MAX_TARGETS = 200;

/* ── Result plumbing ────────────────────────────────────────────────────────*/

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });

const failure = (body: string): ToolResult => ({
  content: [{ type: 'text', text: body }],
  isError: true,
});

/** Convert handler exceptions into MCP text results. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailApiError) return failure(`${err.code}: ${err.message}`);
    return failure((err as Error).message);
  }
}

/* ── Selectors ──────────────────────────────────────────────────────────────*/

const selectorShape = {
  ids: z
    .array(z.string())
    .optional()
    .describe('Exact message ids, as returned by mail_search. Use this or `query`, not both.'),
  query: z
    .string()
    .optional()
    .describe(
      'A search in the app syntax — from: to: subject: label: folder: is:unread is:flagged ' +
        'has:attachment before: after: larger: smaller:, quoted phrases, -negation, OR. ' +
        'Everything it matches is acted on, so run it through mail_search first.',
    ),
  max: z
    .number()
    .int()
    .min(1)
    .max(MAX_TARGETS)
    .default(50)
    .describe(`Ceiling on how many messages one call may touch. Hard maximum ${MAX_TARGETS}.`),
  dryRun: z
    .boolean()
    .default(false)
    .describe('List what would be affected and change nothing.'),
};

interface Selector {
  ids?: string[];
  query?: string;
  max: number;
  dryRun: boolean;
}

/**
 * The messages a selector names.
 *
 * Summaries rather than bare ids, because the callers that need an account —
 * moving into a folder by name — would otherwise have to fetch them one at a
 * time. The `ids` path pays that cost only when it is unavoidable.
 */
async function resolve(sel: Selector, needSummaries: boolean): Promise<MessageSummary[]> {
  if (sel.ids?.length && sel.query) {
    throw new Error('Pass either `ids` or `query`, not both — they would silently disagree.');
  }

  if (sel.ids?.length) {
    if (sel.ids.length > sel.max) {
      throw new Error(`${sel.ids.length} ids given but max is ${sel.max}. Raise max or split the call.`);
    }
    if (!needSummaries) {
      // A stand-in: the caller only needs the ids back, and fetching each
      // message to build a full summary would be N requests for nothing.
      return sel.ids.map((id) => ({ id }) as MessageSummary);
    }
    const out: MessageSummary[] = [];
    // Bounded concurrency. Forty parallel requests at a Fastify instance with a
    // ten-connection pool is a self-inflicted outage.
    for (let i = 0; i < sel.ids.length; i += 8) {
      out.push(...(await Promise.all(sel.ids.slice(i, i + 8).map((id) => client.message(id)))));
    }
    return out;
  }

  if (!sel.query?.trim()) {
    throw new Error('Nothing selected. Pass `ids` or a `query`.');
  }

  const result = await client.list({
    scope: { kind: 'search', value: sel.query, role: null },
    limit: sel.max,
  });
  if (!result.messages.length) throw new Error(`Nothing matched: ${sel.query}`);
  return result.messages;
}

/** The shared preamble every mutating tool prints, and the early exit for a
 *  dry run. Written once so no tool can forget the dry run. */
function preview(targets: MessageSummary[], verb: string, sel: Selector): ToolResult | null {
  if (!sel.dryRun) return null;
  const lines = targets.map((m) => (m.subject === undefined ? m.id : formatSummary(m)));
  return text(`Dry run. ${verb} would affect ${targets.length} message(s):\n\n${lines.join('\n')}`);
}

/* ── The server ─────────────────────────────────────────────────────────────*/

const server = new McpServer({ name: 'mail', version: '0.1.0' });

/* ── Reading ────────────────────────────────────────────────────────────────*/

server.registerTool(
  'mail_search',
  {
    title: 'Search mail',
    description:
      'Search every connected account. Supports from: to: subject: label: folder:, ' +
      'is:unread|read|flagged|answered, has:attachment, before:/after: (dates or "last week" or 7d), ' +
      'larger:/smaller:, "quoted phrases", -negation and OR. ' +
      'Sort by relevance to get the ranking the app itself uses: the query is classified ' +
      '(a person hunt, a file hunt, a phrase, a date window) and weighted accordingly, ' +
      'with the account priority tier and folder taken into account. ' +
      'Message bodies are indexed from the first text part; older messages may remain unindexed while backfill runs.',
    inputSchema: {
      query: z.string().describe('The search, in the syntax above. An empty string matches everything.'),
      sort: z
        .enum(['relevance', 'date', 'priority', 'sender', 'subject', 'size', 'unread'])
        .default('relevance'),
      dir: z.enum(['asc', 'desc']).default('desc'),
      limit: z.number().int().min(1).max(100).default(25),
      threaded: z.boolean().default(false).describe('Collapse each conversation to one row.'),
      cursor: z.string().optional().describe('From a previous result, to get the next page.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, sort, dir, limit, threaded, cursor }) =>
    guard(async () => {
      const scope: Scope = query.trim()
        ? { kind: 'search', value: query, role: null }
        : { kind: 'unified', value: null, role: null };
      // Relevance over a non-search scope has nothing to rank, so it would fall
      // back to date anyway. Saying so beats a silent substitution.
      const effectiveSort = scope.kind === 'search' ? sort : sort === 'relevance' ? 'date' : sort;
      const result = await client.list({
        scope,
        sort: effectiveSort,
        dir,
        limit,
        threaded,
        cursor: cursor ?? null,
      });
      return text(formatList(result.messages, result.total, result.approximate, result.nextCursor));
    }),
);

server.registerTool(
  'mail_read_message',
  {
    title: 'Read a message',
    description:
      'The full message: headers, recipients, attachment list and the plain-text body. ' +
      'Fetches the body from IMAP on a cache miss, so it is slower than search — read what ' +
      'you need, not everything you found.',
    inputSchema: {
      id: z.string().describe('A message id from mail_search.'),
      maxBodyChars: z.number().int().min(200).max(50_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, maxBodyChars }) =>
    guard(async () =>
      text(formatMessage(await client.message(id), maxBodyChars ?? MAX_BODY_CHARS)),
    ),
);

server.registerTool(
  'mail_list_accounts',
  {
    title: 'List accounts',
    description:
      'Every connected mailbox, with its domain, priority tier and sync status. ' +
      'Needed before anything that acts on one account in particular.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => guard(async () => text(formatAccounts(await client.accounts()))),
);

server.registerTool(
  'mail_list_folders',
  {
    title: 'List folders',
    description:
      'Folders, with the account each belongs to. Folder ids are per-account: a folder from ' +
      'one account is not a valid destination for another account’s mail.',
    inputSchema: {
      accountId: z.string().optional().describe('Restrict to one account.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ accountId }) => guard(async () => text(formatFolders(await client.folders(accountId)))),
);

/* ── Sorting and filing ─────────────────────────────────────────────────────*/

server.registerTool(
  'mail_sort',
  {
    title: 'File messages into a folder',
    description:
      'Move messages to a folder — filing, archiving, tidying. Give either an exact `folderId`, ' +
      'or a `folder` name or role (inbox, archive, junk, trash, sent, drafts) which is resolved ' +
      'per account, so one call can file mail across several mailboxes into each one’s own ' +
      '"Receipts". The move is replayed to IMAP, so it shows up in every other mail client.',
    inputSchema: {
      ...selectorShape,
      folderId: z.string().optional().describe('An exact folder id from mail_list_folders.'),
      folder: z
        .string()
        .optional()
        .describe('A folder name or role, matched within each message’s own account.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (args) =>
    guard(async () => {
      const sel = args as unknown as Selector;
      if (!args.folderId && !args.folder) {
        return failure('Give either `folderId` or `folder`.');
      }

      // Resolving by name needs to know which account each message is in;
      // an exact id does not.
      const targets = await resolve(sel, Boolean(args.folder));
      const early = preview(targets, 'Moving', sel);
      if (early) return early;

      if (args.folderId) {
        await client.act(targets.map((m) => m.id), { type: 'move', folderId: args.folderId });
        return text(`Moved ${targets.length} message(s) into ${args.folderId}.`);
      }

      const wanted = args.folder!.toLowerCase();
      const folders = await client.folders();
      const byAccount = new Map<string, MessageSummary[]>();
      for (const m of targets) {
        byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);
      }

      const done: string[] = [];
      const missing: string[] = [];
      for (const [accountId, group] of byAccount) {
        const candidates = folders.filter((f) => f.accountId === accountId);
        const match =
          candidates.find((f) => f.role.toLowerCase() === wanted) ??
          candidates.find((f) => f.name.toLowerCase() === wanted) ??
          candidates.find((f) => f.name.toLowerCase().includes(wanted));
        if (!match) {
          missing.push(`${accountId} (${group.length} message(s))`);
          continue;
        }
        // One call per account: the API refuses a move whose destination
        // belongs to a different account than the mail, which is the check
        // that makes this loop necessary rather than paranoid.
        await client.act(group.map((m) => m.id), { type: 'move', folderId: match.id });
        done.push(`${group.length} → ${match.path} (${accountId})`);
      }

      const report = done.length ? `Moved:\n${done.map((d) => `  ${d}`).join('\n')}` : 'Moved nothing.';
      return missing.length
        ? failure(`${report}\n\nNo folder matching "${args.folder}" in: ${missing.join(', ')}`)
        : text(report);
    }),
);

server.registerTool(
  'mail_label',
  {
    title: 'Add or remove labels',
    description:
      'Labels are stored by this app, not on the mail server, so they are free to invent and ' +
      'nothing is replayed to IMAP. Use them to mark a triage decision without moving mail.',
    inputSchema: {
      ...selectorShape,
      add: z.array(z.string()).default([]),
      remove: z.array(z.string()).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (args) =>
    guard(async () => {
      const sel = args as unknown as Selector;
      if (!args.add.length && !args.remove.length) return failure('Nothing to add or remove.');
      const targets = await resolve(sel, false);
      const early = preview(targets, 'Labelling', sel);
      if (early) return early;
      await client.act(targets.map((m) => m.id), {
        type: 'label',
        add: args.add,
        remove: args.remove,
      });
      return text(
        `Labelled ${targets.length} message(s).` +
          (args.add.length ? ` Added: ${args.add.join(', ')}.` : '') +
          (args.remove.length ? ` Removed: ${args.remove.join(', ')}.` : ''),
      );
    }),
);

server.registerTool(
  'mail_mark',
  {
    title: 'Mark read, unread or flagged',
    description: 'Set read state and flags. Replayed to IMAP, so other clients see it.',
    inputSchema: {
      ...selectorShape,
      read: z.boolean().optional().describe('true marks read, false marks unread.'),
      flagged: z.boolean().optional().describe('true flags, false unflags.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (args) =>
    guard(async () => {
      const sel = args as unknown as Selector;
      const add: string[] = [];
      const remove: string[] = [];
      if (args.read === true) add.push('seen');
      if (args.read === false) remove.push('seen');
      if (args.flagged === true) add.push('flagged');
      if (args.flagged === false) remove.push('flagged');
      if (!add.length && !remove.length) return failure('Set `read` or `flagged`.');

      const targets = await resolve(sel, false);
      const early = preview(targets, 'Marking', sel);
      if (early) return early;
      await client.act(targets.map((m) => m.id), { type: 'flag', add, remove });
      return text(`Updated ${targets.length} message(s).`);
    }),
);

server.registerTool(
  'mail_snooze',
  {
    title: 'Snooze until later',
    description:
      'Hide messages from every view until a time passes. App-side only — nothing changes on ' +
      'the mail server, and there is no wake-up notification; they simply reappear.',
    inputSchema: {
      ...selectorShape,
      until: z.string().describe('An ISO-8601 timestamp, e.g. 2026-08-20T09:00:00Z.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (args) =>
    guard(async () => {
      const sel = args as unknown as Selector;
      const when = new Date(args.until);
      if (Number.isNaN(when.getTime())) return failure(`Not a date: ${args.until}`);
      const targets = await resolve(sel, false);
      const early = preview(targets, 'Snoozing', sel);
      if (early) return early;
      await client.act(targets.map((m) => m.id), { type: 'snooze', until: when.toISOString() });
      return text(`Snoozed ${targets.length} message(s) until ${when.toISOString()}.`);
    }),
);

server.registerTool(
  'mail_delete',
  {
    title: 'Trash or permanently delete',
    description:
      'Moves to trash by default, which is recoverable from any mail client. ' +
      '`permanent: true` deletes from the server and cannot be undone, so it also needs ' +
      '`confirm: true`. Prefer trash.',
    inputSchema: {
      ...selectorShape,
      permanent: z.boolean().default(false),
      confirm: z.boolean().default(false).describe('Required when `permanent` is true.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  async (args) =>
    guard(async () => {
      const sel = args as unknown as Selector;
      if (args.permanent && !args.confirm) {
        return failure(
          'A permanent delete removes mail from the server and cannot be undone. ' +
            'Re-run with confirm: true, or drop `permanent` to use trash instead.',
        );
      }
      const targets = await resolve(sel, false);
      const early = preview(targets, args.permanent ? 'Permanently deleting' : 'Trashing', sel);
      if (early) return early;
      await client.act(targets.map((m) => m.id), { type: 'delete', permanent: args.permanent });
      return text(
        args.permanent
          ? `Permanently deleted ${targets.length} message(s).`
          : `Moved ${targets.length} message(s) to trash.`,
      );
    }),
);

/* ── Unsubscribe ────────────────────────────────────────────────────────────*/

server.registerTool(
  'mail_unsubscribe',
  {
    title: 'Unsubscribe from a sender',
    description:
      'Reads the message’s List-Unsubscribe headers and acts on them. Without `confirm: true` ' +
      'it only reports what is possible, which is the right first call. ' +
      'An HTTPS target is POSTed to only when the sender marked it one-click (RFC 8058); ' +
      'otherwise the URL is handed back for a person to open. A mailto: target is sent from ' +
      'the owning account. Every attempt is recorded and cannot be undone. ' +
      'Requires a token with the `unsubscribe` scope.',
    inputSchema: {
      id: z.string().describe('A message id from the sender you want to stop hearing from.'),
      confirm: z
        .boolean()
        .default(false)
        .describe('false previews and changes nothing. true actually unsubscribes.'),
      target: z
        .string()
        .optional()
        .describe('Pick a specific option from the preview. Omit to use the best automatic one.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, confirm, target }) =>
    guard(async () => {
      if (!confirm) {
        const plan = await client.unsubscribePlan(id);
        return text(
          `${formatPlan(plan)}\n\nNothing has been done. Call again with confirm: true to act.`,
        );
      }
      const result = await client.unsubscribe(id, { confirm: true, target });
      return result.ok
        ? text(`Unsubscribed via ${result.method}: ${result.target}\n${result.detail ?? ''}`)
        : failure(
            `Did not unsubscribe. ${result.detail ?? 'No reason given.'}` +
              (result.target ? `\nTarget: ${result.target}` : ''),
          );
    }),
);

/* ── Go ─────────────────────────────────────────────────────────────────────*/

await server.connect(new StdioServerTransport());
