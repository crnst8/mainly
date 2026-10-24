/**
 * Which new inbox mail goes to Filtered, and on whose say-so.
 *
 * In order, and the first that answers decides:
 *
 *  1. A rule — the user's own latest decision about this list or sender.
 *  2. Correspondence — mail from someone the user writes to, or in a
 *     conversation they have written in, stays.
 *  3. The classifier, when it is trained and sure. "Sure" is a threshold the
 *     user's sensitivity sets and their rescue rate raises.
 *  4. The language model, when the user turned it on, for what the classifier
 *     could not decide — including everything, before it has enough examples.
 *
 * Anything still undecided stays in the inbox. Every step that is unsure, slow
 * or broken fails toward the inbox, because mail wrongly left there costs a
 * glance and mail wrongly hidden can cost a missed bill.
 */

import type { FilterPreferences } from '../contract/types.ts';
import {
  BASE_THRESHOLD,
  KEEP_BELOW,
  LLM_THRESHOLD,
  effectiveThreshold,
  score,
  trained,
} from './classifier.ts';
import { featuresOf } from './features.ts';
import { LLM_BATCH, classify, llmAvailable, takeBudget, type LlmMessage } from './llm.ts';
import { correspondence, inputOf, keyOf, modelFor, rulesFor, trackRecord, type FilterRow } from './model.ts';
import { config } from '../config.ts';
import { fileByRole } from '../sync/filing.ts';

export interface Candidate {
  row: FilterRow;
  /** Arrived since the folder was last indexed. Only fresh mail is offered to
   *  the classifier and the model; a new account's backlog is filed by rules
   *  alone, which are the user's own words and safe to apply to old mail. */
  fresh: boolean;
}

export interface Decision {
  id: string;
  stage: 'rule' | 'model' | 'llm';
  score: number | null;
  model: string | null;
}

export async function decide(
  userId: string,
  prefs: FilterPreferences,
  candidates: readonly Candidate[],
): Promise<Decision[]> {
  if (!candidates.length) return [];
  const out: Decision[] = [];

  /* 1. Rules. */
  const rules = await rulesFor(userId, candidates.map((c) => c.row));
  const open: Candidate[] = [];
  for (const c of candidates) {
    const verdict = rules.get(keyOf(c.row));
    if (verdict === 'filter') out.push({ id: c.row.id, stage: 'rule', score: null, model: null });
    else if (verdict === undefined && c.fresh) open.push(c);
  }
  if (!open.length || (!prefs.learn && !prefs.llm)) return out;

  /* 2. Correspondence. */
  const known = await correspondence(
    userId,
    [...new Set(open.map((c) => c.row.from_address))],
    [...new Set(open.map((c) => c.row.thread_id))],
  );
  const strangers = open.filter(
    (c) => !known.addresses.has(c.row.from_address) && !known.threads.has(c.row.thread_id),
  );
  if (!strangers.length) return out;

  /* 3. The classifier. */
  const model = await modelFor(userId);
  const record = await trackRecord(userId);
  const unsure: Candidate[] = [];
  if (prefs.learn && trained(model.counts)) {
    const threshold = effectiveThreshold(
      BASE_THRESHOLD[prefs.sensitivity],
      record.model.autoFiled,
      record.model.rescued,
    );
    for (const c of strangers) {
      const { p } = score(model.counts, featuresOf(inputOf(c.row)));
      if (p >= threshold) out.push({ id: c.row.id, stage: 'model', score: p, model: null });
      else if (p >= KEEP_BELOW) unsure.push(c);
    }
  } else {
    // Untrained, the classifier has no opinion, so everything is unsure. The
    // model covers that period, until there are enough examples.
    unsure.push(...strangers);
  }

  /* 4. The language model. */
  const examples = model.examples;
  if (!prefs.llm || !llmAvailable() || !unsure.length || !examples.some((e) => e.verdict === 'filter')) return out;
  const granted = takeBudget(userId, unsure.length);
  const asked = unsure.slice(0, granted);
  const name = prefs.llmModel || config.filter.llm.model;
  const needed = effectiveThreshold(LLM_THRESHOLD[prefs.sensitivity], record.llm.autoFiled, record.llm.rescued);
  for (let i = 0; i < asked.length; i += LLM_BATCH) {
    const batch = asked.slice(i, i + LLM_BATCH);
    try {
      const verdicts = await classify(userId, name, batch.map((c) => llmMessage(c.row)), examples);
      verdicts.forEach((v, j) => {
        if (v?.filter && v.confidence >= needed)
          out.push({ id: batch[j]!.row.id, stage: 'llm', score: v.confidence, model: name });
      });
    } catch (err) {
      // The filter works without the model. A provider outage leaves the
      // rest of this batch in the inbox and stops asking for this pass.
      console.warn({ model: name, err: (err as Error).message }, 'filter model unavailable');
      break;
    }
  }
  return out;
}

export function llmMessage(r: FilterRow): LlmMessage {
  const me = r.account.toLowerCase();
  return {
    from: { name: r.from_name, address: r.from_address },
    subject: r.subject,
    preview: r.preview,
    addressed: (r.to_addrs ?? []).some((a) => a.address === me)
      ? 'direct'
      : (r.cc_addrs ?? []).some((a) => a.address === me)
        ? 'cc'
        : 'hidden',
    bulk: r.bulk,
  };
}

/** File what `decide` chose, and record why, in one transaction. Rules are
 *  recorded too: a rescue of rule-filed mail has to be told apart from an
 *  undo of the user's own filing, and only this row can tell them apart. */
export async function fileDecisions(userId: string, accountId: string, decisions: readonly Decision[]): Promise<string[]> {
  if (!decisions.length) return [];
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return fileByRole(userId, accountId, [...byId.keys()], 'filtered', async (tx, ids) => {
    const rows = ids.flatMap((id) => byId.get(id) ?? []);
    await tx.query(
      `INSERT INTO filter_decisions (message_id, user_id, stage, score, model)
       SELECT r.id, $1, r.stage, r.score, r.model
         FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, stage text, score real, model text)
       ON CONFLICT (message_id) DO UPDATE
         SET stage = EXCLUDED.stage, score = EXCLUDED.score, model = EXCLUDED.model,
             created_at = now(), rescued_at = NULL`,
      [userId, JSON.stringify(rows)],
    );
  });
}
