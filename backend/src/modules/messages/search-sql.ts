/**
 * Search query → SQL.
 *
 * The parser is shared (`contract/search.ts`); execution is not. This file is
 * to `matchesSearch` what `query.ts` is to `frontend/src/lib/query.ts`: a
 * hand-written mirror, with `scripts/query-check.mjs` standing between them.
 *
 * Two rules hold everything together:
 *
 *  1. **Every value is bound, never interpolated.** The only strings that reach
 *     the SQL text are field names this file chose itself.
 *  2. **Matching and ranking read the same clauses.** A row that matches
 *     `from:anna` is a row whose rank includes the sender weight, because the
 *     alternative is a result set ordered by something other than why it
 *     matched.
 *
 * Free text goes through `websearch_to_tsquery` against the envelope and body
 * vectors, so it gets stemming and the A/B/C/D field weights. Field-scoped
 * operators (`from:`, `subject:`) use ILIKE instead: they are substring
 * predicates on one column, and a user typing `from:ann` means the prefix, not
 * the lexeme.
 */

import {
  decaySql,
  sqlNumber,
  type Clause,
  type RankingProfile,
  type SearchQuery,
} from '../../contract/search.ts';
import type { FolderRole } from '../../contract/types.ts';

type Bind = (value: unknown) => string;

/**
 * Everything free text matches: generated envelope text plus independently
 * indexed body text. Keep this byte-identical to migration 009's expression.
 */
const SEARCHABLE = "(m.search || coalesce(m.body_search, ''::tsvector))";

/** Escapes a value for use inside a LIKE pattern, then wraps it in wildcards. */
const contains = (v: string) => `%${v.replace(/([\\%_])/g, '\\$1')}%`;

/**
 * The WHERE fragment for a parsed query, or null when the query constrains
 * nothing. Groups are ORed, clauses within a group ANDed — the same shape the
 * parser produces and the mock evaluates.
 */
export function searchWhere(q: SearchQuery, bind: Bind): string | null {
  if (!q.groups.length) return null;
  const groups = q.groups.map(
    (group) => `(${group.map((c) => clauseSql(c, bind)).join(' AND ')})`,
  );
  return `(${groups.join(' OR ')})`;
}

function clauseSql(c: Clause, bind: Bind): string {
  const sql = predicate(c, bind);
  // NOT over a nullable expression would swallow rows where the predicate is
  // unknown, so every predicate below is written to be strictly true or false.
  return c.negated ? `NOT (${sql})` : sql;
}

function predicate(c: Clause, bind: Bind): string {
  switch (c.field) {
    case 'text':
      return `(${SEARCHABLE} @@ websearch_to_tsquery('english', ${bind(c.value)})
               OR m.subject ILIKE ${bind(contains(c.value))}
               OR m.preview ILIKE ${bind(contains(c.value))}
               OR m.from_address ILIKE ${bind(contains(c.value))}
               OR coalesce(m.from_name, '') ILIKE ${bind(contains(c.value))}
               OR EXISTS (SELECT 1 FROM unnest(m.labels) l WHERE l ILIKE ${bind(contains(c.value))}))`;
    case 'from':
      return `(m.from_address ILIKE ${bind(contains(c.value))}
               OR coalesce(m.from_name, '') ILIKE ${bind(contains(c.value))})`;
    case 'to':
      // to_addrs is jsonb `[{name, address}]`. Casting the whole array to text
      // and matching once beats unnesting per row for a substring test.
      return `(m.to_addrs::text ILIKE ${bind(contains(c.value))})`;
    case 'subject':
      return `(m.subject ILIKE ${bind(contains(c.value))})`;
    case 'label':
      return `EXISTS (SELECT 1 FROM unnest(m.labels) l WHERE l ILIKE ${bind(contains(c.value))})`;
    case 'folder':
      // Leaf name and role only — never `path`. Dovecot nests everything under
      // `INBOX.`, so matching the path makes `folder:inbox` return the mailbox.
      return `(f.name ILIKE ${bind(contains(c.value))} OR f.role::text ILIKE ${bind(contains(c.value))})`;
    case 'unread':
      return 'NOT m.seen';
    case 'read':
      return 'm.seen';
    case 'flagged':
      return 'm.flagged';
    case 'answered':
      return 'm.answered';
    case 'attachment':
      return 'm.has_attachments';
    case 'before':
      return `m.date < ${bind(c.value)}::timestamptz`;
    case 'after':
      return `m.date >= ${bind(c.value)}::timestamptz`;
    case 'larger':
      return `m.size > ${bind(Number(c.value))}`;
    case 'smaller':
      return `m.size < ${bind(Number(c.value))}`;
  }
}

/**
 * The relevance expression, mirroring `relevanceScore` in the contract.
 *
 * Three factors, multiplied, in the same order the TypeScript ranker applies
 * them:
 *
 *  1. **Text.** `ts_rank_cd` with the profile's field weights handed in as its
 *     weights array, rather than the built-in defaults. This is the join
 *     between the two implementations: the profile is one object, and both
 *     sides read the same four numbers out of it.
 *  2. **Decay.** `decaySql`, shaped by the profile's floor and curve.
 *  3. **Boosts.** What the row *is* — account priority, unread, flagged,
 *     attachments, and the folder it sits in.
 *
 * Returns null when the query has no text to rank on, which tells the caller to
 * fall back to a date sort rather than order every row by the same constant.
 *
 * `rankedAt` is the instant to decay against. It comes from the request, and
 * from the *cursor* on every page after the first, so a paged scan ranks every
 * page against the same clock.
 *
 * `needsFolders` reports whether the expression referenced `f`. The folders
 * join is not free and most queries do not need it, so the caller adds it on
 * demand rather than carrying it on every list read.
 */
export function relevanceSql(
  q: SearchQuery,
  bind: Bind,
  rankedAt: string,
  profile: RankingProfile,
): { sql: string; needsFolders: boolean } | null {
  const terms = q.groups
    .flat()
    .filter((c) => !c.negated && (c.field === 'text' || c.field === 'subject' || c.field === 'from'))
    .map((c) => c.value);
  if (!terms.length) return null;

  const tsq = `websearch_to_tsquery('english', ${bind(terms.join(' or '))})`;
  // `{D, C, B, A}` — the argument order Postgres expects. Body text is D and
  // keeps the fixed lowest weight; the other three come from the profile.
  const weights =
    `'{0.1, ${sqlNumber(profile.preview)}, ${sqlNumber(profile.sender)}, ${sqlNumber(profile.subject)}}'::float4[]`;
  const boosts = boostSql(profile);

  return {
    sql: `(ts_rank_cd(${weights}, ${SEARCHABLE}, ${tsq})
           * ${decaySql(`${bind(rankedAt)}::timestamptz`, profile)}
           * ${boosts.sql})`,
    needsFolders: boosts.needsFolders,
  };
}

/** Every folder role the enum has. A profile's folder map is built from our own
 *  literals, but it arrives via a JSON preference blob, so the role names that
 *  reach the SQL text are checked against this rather than trusted. */
const FOLDER_ROLES = new Set<string>([
  'inbox',
  'drafts',
  'sent',
  'trash',
  'junk',
  'archive',
  'flagged',
  'all',
  'custom',
] satisfies FolderRole[]);

/**
 * The multipliers a row earns for what it is, mirroring `boostFactor`.
 *
 * Multiplicative, not additive: a junk demotion has to survive a strong text
 * match, and adding a penalty to a rank that is already near zero does nothing.
 */
function boostSql(p: RankingProfile): { sql: string; needsFolders: boolean } {
  const parts = [
    `CASE m.priority
       WHEN 'critical' THEN ${sqlNumber(p.priority.critical)}
       WHEN 'high'     THEN ${sqlNumber(p.priority.high)}
       WHEN 'low'      THEN ${sqlNumber(p.priority.low)}
       WHEN 'muted'    THEN ${sqlNumber(p.priority.muted)}
       ELSE ${sqlNumber(p.priority.normal)} END`,
    `CASE WHEN m.seen THEN 1 ELSE ${sqlNumber(p.unread)} END`,
    `CASE WHEN m.flagged THEN ${sqlNumber(p.flagged)} ELSE 1 END`,
    `CASE WHEN m.has_attachments THEN ${sqlNumber(p.attachment)} ELSE 1 END`,
  ];

  // A role whose multiplier is 1 changes nothing, and a folder map that is all
  // 1s must not drag the join in for a no-op.
  const roles = Object.entries(p.folder).filter(
    ([role, v]) => FOLDER_ROLES.has(role) && typeof v === 'number' && v !== 1,
  );
  if (roles.length) {
    parts.push(
      `CASE f.role::text ${roles
        .map(([role, v]) => `WHEN '${role}' THEN ${sqlNumber(v)}`)
        .join(' ')} ELSE 1 END`,
    );
  }

  return { sql: `(${parts.join(' * ')})`, needsFolders: roles.length > 0 };
}
