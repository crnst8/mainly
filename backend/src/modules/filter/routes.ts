/**
 * The Filtered folder's settings surface: what it knows, forgetting a sender,
 * sweeping the inbox, and choosing a language model.
 *
 * Teaching the filter has no endpoint. It learns from moves into and out of
 * Filtered, through `/messages/actions` like any other move.
 *
 * The model routes are session only. Listing and trying models spends the
 * operator's key on a request the caller chooses the timing of; an agent token
 * has no reason to.
 */

import type { FastifyInstance } from 'fastify';
import { one, query } from '../../db/index.ts';
import { badRequest, upstream } from '../../lib/errors.ts';
import {
  withPreferenceDefaults,
  type FilterModelTrial,
  type FilterSource,
  type FilterStatus,
  type Preferences,
} from '../../contract/types.ts';
import { config } from '../../config.ts';
import { BASE_THRESHOLD, effectiveThreshold, trained } from '../../filter/classifier.ts';
import { decide, fileDecisions } from '../../filter/decide.ts';
import { classify, listModels, llmAvailable, llmHost, LlmError } from '../../filter/llm.ts';
import { FILTER_ROW_COLUMNS, modelFor, trackRecord, type FilterRow } from '../../filter/model.ts';
import { publishCounts } from '../../sync/folders.ts';
import { syncNow } from '../../sync/engine.ts';

const sessionOnly = { config: { sessionOnly: true } };

/** Inbox messages examined per account by one sweep. */
const SWEEP_MAX = 5000;

async function prefsOf(userId: string): Promise<Preferences> {
  const row = await one<{ data: Partial<Preferences> | null }>('SELECT data FROM preferences WHERE user_id = $1', [
    userId,
  ]);
  return withPreferenceDefaults(row?.data);
}

export async function filterRoutes(app: FastifyInstance): Promise<void> {
  app.get('/filter/status', async (req) => {
    const prefs = await prefsOf(req.userId);
    const [examples, model, record, sources] = await Promise.all([
      query<{ verdict: 'filter' | 'keep'; n: number }>(
        `SELECT verdict, count(*)::int AS n FROM filter_examples WHERE user_id = $1 GROUP BY verdict`,
        [req.userId],
      ),
      modelFor(req.userId),
      trackRecord(req.userId),
      query<{
        kind: 'sender' | 'list';
        value: string;
        verdict: 'filter' | 'keep';
        name: string | null;
        n: number;
        last_at: Date;
      }>(
        `SELECT kind, value,
                (array_agg(verdict ORDER BY id DESC))[1] AS verdict,
                (array_agg(from_name ORDER BY id DESC) FILTER (WHERE from_name IS NOT NULL))[1] AS name,
                count(*)::int AS n, max(created_at) AS last_at
           FROM (SELECT CASE WHEN list_id IS NOT NULL THEN 'list' ELSE 'sender' END AS kind,
                        coalesce(list_id, from_address) AS value, verdict, from_name, id, created_at
                   FROM filter_examples WHERE user_id = $1) x
          GROUP BY kind, value
          ORDER BY max(id) DESC
          LIMIT 500`,
        [req.userId],
      ),
    ]);
    const count = (v: 'filter' | 'keep') => examples.find((e) => e.verdict === v)?.n ?? 0;
    return {
      examples: { filter: count('filter'), keep: count('keep') },
      trained: trained(model.counts),
      autoFiled: record.model.autoFiled + record.llm.autoFiled,
      rescued: record.model.rescued + record.llm.rescued,
      threshold: effectiveThreshold(
        BASE_THRESHOLD[prefs.filtering.sensitivity],
        record.model.autoFiled,
        record.model.rescued,
      ),
      llm: {
        available: llmAvailable(),
        host: llmAvailable() ? llmHost() : null,
        defaultModel: llmAvailable() ? config.filter.llm.model : null,
      },
      sources: sources.map(
        (s): FilterSource => ({
          kind: s.kind,
          value: s.value,
          verdict: s.verdict,
          name: s.name,
          count: s.n,
          lastAt: s.last_at.toISOString(),
        }),
      ),
    } satisfies FilterStatus;
  });

  /** Forget everything the filter learned from one sender or list. The
   *  classifier forgets it too, on its next rebuild. */
  app.post<{ Body: { kind: 'sender' | 'list'; value: string } }>('/filter/forget', async (req, reply) => {
    const { kind, value } = req.body ?? ({} as { kind: string; value: string });
    if ((kind !== 'sender' && kind !== 'list') || typeof value !== 'string' || !value)
      throw badRequest('kind and value are required');
    await query(
      kind === 'list'
        ? 'DELETE FROM filter_examples WHERE user_id = $1 AND list_id = $2'
        : 'DELETE FROM filter_examples WHERE user_id = $1 AND list_id IS NULL AND from_address = $2',
      [req.userId, value.toLowerCase()],
    );
    return reply.code(204).send();
  });

  /**
   * Apply the rules to mail already in the inbox.
   *
   * Rules only: they are the user's own decisions about named senders and
   * lists, and safe to apply to old mail. The classifier and the model only
   * ever judge new arrivals, so a sweep cannot hide a year of inbox on the
   * strength of a guess.
   */
  app.post('/filter/sweep', async (req) => {
    const prefs = await prefsOf(req.userId);
    if (!prefs.filtering.enabled) throw badRequest('The filter is off');
    const accounts = (
      await query<{ id: string }>('SELECT id FROM accounts WHERE user_id = $1', [req.userId])
    ).filter((a) => !prefs.filtering.excluded.includes(a.id));

    let filed = 0;
    const touched: string[] = [];
    for (const account of accounts) {
      const rows = await query<FilterRow>(
        `SELECT ${FILTER_ROW_COLUMNS}
           FROM messages m
           JOIN accounts a ON a.id = m.account_id
           JOIN folders f ON f.id = m.folder_id
          WHERE m.account_id = $1 AND f.role = 'inbox'
          ORDER BY m.date DESC
          LIMIT $2`,
        [account.id, SWEEP_MAX],
      );
      const decisions = await decide(
        req.userId,
        prefs.filtering,
        rows.map((row) => ({ row, fresh: false })),
      );
      const moved = await fileDecisions(req.userId, account.id, decisions);
      if (moved.length) {
        filed += moved.length;
        touched.push(account.id);
      }
    }
    if (touched.length) {
      await publishCounts(req.userId, touched);
      for (const id of touched) syncNow(req.userId, id);
    }
    return { filed };
  });

  app.get('/filter/models', sessionOnly, async () => {
    if (!llmAvailable()) return [];
    try {
      return await listModels();
    } catch (err) {
      throw upstream(`The model provider did not list its models: ${(err as Error).message}`);
    }
  });

  /**
   * One classification of a made-up message, to see whether a model answers,
   * how fast, and in a shape the filter can read. Never the user's own mail:
   * trying a model should not send anything of theirs anywhere.
   */
  app.post<{ Body: { model?: string } }>('/filter/models/try', sessionOnly, async (req) => {
    if (!llmAvailable()) throw badRequest('No language model is configured on this server');
    const model = String(req.body?.model || config.filter.llm.model).slice(0, 200);
    const started = Date.now();
    try {
      const [verdict] = await classify(
        req.userId,
        model,
        [
          {
            from: { name: 'Weekend Deals', address: 'deals@shop.example' },
            subject: '40% off everything until Sunday',
            preview: 'Our biggest sale of the season starts now. Shop the collection before it ends.',
            addressed: 'hidden',
            bulk: true,
          },
        ],
        [
          { from: { name: 'Shop Offers', address: 'offers@store.example' }, subject: 'Final hours: 30% off', verdict: 'filter' },
          { from: { name: 'Sam Lee', address: 'sam@friend.example' }, subject: 'Dinner on Friday?', verdict: 'keep' },
        ],
      );
      const ms = Date.now() - started;
      return (
        verdict
          ? { ok: true, model, ms, detail: `${verdict.filter ? 'Filter' : 'Keep'} · ${Math.round(verdict.confidence * 100)}%` }
          : { ok: false, model, ms, detail: 'Answered, but not in a shape the filter can read' }
      ) satisfies FilterModelTrial;
    } catch (err) {
      return {
        ok: false,
        model,
        ms: Date.now() - started,
        detail: err instanceof LlmError ? err.message : 'The request failed',
      } satisfies FilterModelTrial;
    }
  });
}
