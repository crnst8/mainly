/**
 * The learned half of the filter: "does this look like mail I filtered?"
 *
 * A two-class token classifier in the SpamBayes design — Gary Robinson's
 * per-feature probabilities, combined with Fisher's chi-squared method. It was
 * chosen over a plain naive Bayes product for one property: it says "unsure"
 * when the evidence disagrees, instead of being confidently wrong. Plain naive
 * Bayes multiplies hundreds of dependent probabilities and lands at 0 or 1 on
 * almost everything; chi-squared combining lands near 0.5 when strong evidence
 * points both ways, which is exactly the case to leave in the inbox or hand to
 * the language model. It also needs no tuning and trains in one pass over a
 * few hundred examples, which is the corpus a single person's filing gives it.
 *
 * Pure: counts in, probability out. Where the counts come from, and what is
 * done with the answer, live in model.ts and decide.ts.
 */

import type { FilterSensitivity } from '../contract/types.ts';

export interface Counts {
  /** Examples of each class. */
  filter: number;
  keep: number;
  /** Feature → how many examples of each class contained it. */
  features: Map<string, { filter: number; keep: number }>;
}

export const emptyCounts = (): Counts => ({ filter: 0, keep: 0, features: new Map() });

/** Add one example. `weight` lets a deliberate correction count for more than
 *  mail that merely sat in the inbox. */
export function train(counts: Counts, features: readonly string[], verdict: 'filter' | 'keep', weight = 1): void {
  counts[verdict] += weight;
  for (const f of new Set(features)) {
    const c = counts.features.get(f) ?? { filter: 0, keep: 0 };
    c[verdict] += weight;
    counts.features.set(f, c);
  }
}

/* SpamBayes defaults, which its authors arrived at by testing on real mail.
   `S` and `X` pull a rarely-seen feature toward "no opinion" until it has been
   seen often enough to mean something; `MIN_DIST` ignores features too close
   to neutral to be evidence; `MAX_CLUES` caps how many features vote. */
const S = 0.45;
const X = 0.5;
const MIN_DIST = 0.1;
const MAX_CLUES = 150;

/** The minimum training before the classifier acts at all. Below this a
 *  single filed newsletter would make every newsletter look filterable. */
export const MIN_FILTER_EXAMPLES = 3;
export const MIN_KEEP_EXAMPLES = 20;

export function trained(counts: Counts): boolean {
  return counts.filter >= MIN_FILTER_EXAMPLES && counts.keep >= MIN_KEEP_EXAMPLES;
}

/** Robinson's probability that a message containing `f` belongs in Filtered. */
function featureProb(counts: Counts, c: { filter: number; keep: number }): number {
  const filterRatio = counts.filter ? Math.min(1, c.filter / counts.filter) : 0;
  const keepRatio = counts.keep ? Math.min(1, c.keep / counts.keep) : 0;
  if (filterRatio + keepRatio === 0) return X;
  const p = filterRatio / (filterRatio + keepRatio);
  const n = c.filter + c.keep;
  return (S * X + n * p) / (S + n);
}

/** Survival function of chi-squared with `v` (even) degrees of freedom. */
function chi2Q(x2: number, v: number): number {
  const m = x2 / 2;
  let term = Math.exp(-m);
  let sum = term;
  for (let i = 1; i < v / 2; i++) {
    term *= m / i;
    sum += term;
  }
  return Math.min(sum, 1);
}

export interface Score {
  /** 0 = certainly inbox, 1 = certainly Filtered, 0.5 = no idea. */
  p: number;
  /** The features that moved it most, strongest first, for the log and for
   *  anyone asking why. */
  clues: { feature: string; p: number }[];
}

export function score(counts: Counts, features: readonly string[]): Score {
  const clues: { feature: string; p: number }[] = [];
  for (const f of new Set(features)) {
    const c = counts.features.get(f);
    if (!c) continue;
    const p = featureProb(counts, c);
    if (Math.abs(p - X) >= MIN_DIST) clues.push({ feature: f, p });
  }
  clues.sort((a, b) => Math.abs(b.p - X) - Math.abs(a.p - X));
  const used = clues.slice(0, MAX_CLUES);
  if (!used.length) return { p: X, clues: [] };

  // Sums of logs rather than products: 150 probabilities multiplied together
  // underflow a double long before they mean anything.
  let lnFilter = 0;
  let lnKeep = 0;
  for (const { p } of used) {
    lnFilter += Math.log(Math.max(1 - p, 1e-12));
    lnKeep += Math.log(Math.max(p, 1e-12));
  }
  const v = 2 * used.length;
  const filterness = 1 - chi2Q(-2 * lnFilter, v);
  const keepness = 1 - chi2Q(-2 * lnKeep, v);
  return { p: (filterness - keepness + 1) / 2, clues: used.slice(0, 8) };
}

/** The probability each sensitivity needs before mail is filed. */
export const BASE_THRESHOLD: Record<FilterSensitivity, number> = {
  cautious: 0.97,
  balanced: 0.92,
  eager: 0.85,
};

/** Below this the classifier is confident the mail belongs in the inbox, and
 *  nothing else is asked. Between this and the threshold it is unsure. */
export const KEEP_BELOW = 0.35;

/** The rescue rate at which the threshold has risen as far as it will. */
const RESCUE_CEILING = 0.1;
/** Auto-filed messages needed before their rescue rate is taken seriously. */
const MIN_FILED_FOR_FEEDBACK = 10;

/**
 * The threshold, raised by how often the user has had to take mail back out.
 *
 * This is the feedback loop that keeps the filter honest. Every message the
 * filter moved by itself is a prediction; every one the user moves back is a
 * prediction that was wrong. Each stage that predicts (the classifier and the
 * language model) is held to its own record. Past ten filed, the rescue rate pushes the
 * threshold toward 1 — at a 10% rescue rate, most of the way — so a filter
 * that is getting it wrong files less until it is getting it right. It never
 * lowers the threshold below the chosen sensitivity: hiding more mail on the
 * strength of a good record is a decision for the user, not the filter.
 */
export function effectiveThreshold(base: number, autoFiled: number, rescued: number): number {
  if (autoFiled < MIN_FILED_FOR_FEEDBACK) return base;
  const rate = Math.min(1, rescued / autoFiled);
  return base + (1 - base) * 0.8 * Math.min(1, rate / RESCUE_CEILING);
}

/** The language model's confidence each sensitivity needs. */
export const LLM_THRESHOLD: Record<FilterSensitivity, number> = {
  cautious: 0.9,
  balanced: 0.8,
  eager: 0.7,
};
