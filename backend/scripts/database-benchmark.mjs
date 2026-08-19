/**
 * Repeatable database baseline for the message-list hot path.
 *
 * The fixture is a disabled, script-owned user and is always removed. No IMAP
 * connection is made and no real user's rows are read or changed.
 *
 *   DB_BENCH_ROWS=120000 node --experimental-strip-types scripts/database-benchmark.mjs
 */

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/db/index.ts';
import { listMessages } from '../src/modules/messages/query.ts';
import { refreshCounts } from '../src/sync/folders.ts';
import { refreshAccountThreads } from '../src/sync/threads.ts';

const EMAIL = 'database-benchmark@example.test';
const ROWS = Math.max(12, Number(process.env.DB_BENCH_ROWS ?? 120_000));
const ITERATIONS = Math.max(3, Number(process.env.DB_BENCH_ITERATIONS ?? 8));
const ACCOUNT_COUNT = 12;

const EMPTY_FILTERS = {
  unreadOnly: false,
  flaggedOnly: false,
  hasAttachments: false,
  accountIds: [],
  domains: [],
  folderIds: [],
  priorities: [],
  labels: [],
  since: null,
  before: null,
};

const quantile = (samples, fraction) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
};

const summarise = (samples, acquisitions, requests = samples.length) => ({
  runs: samples.length,
  p50Ms: Number(quantile(samples, 0.5).toFixed(2)),
  p95Ms: Number(quantile(samples, 0.95).toFixed(2)),
  acquisitions,
  acquisitionsPerRequest: Number((acquisitions / requests).toFixed(2)),
});

async function resetFixture() {
  const users = await query('SELECT id FROM users WHERE email = $1', [EMAIL]);
  if (!users.length) return;
  // The thread index has its own per-user rows. Removing them explicitly keeps
  // cleanup bounded instead of making the composite foreign-key cascade scan
  // every thread leaf after a large benchmark.
  await query('DELETE FROM thread_folders WHERE user_id = $1', [users[0].id]);
  await query('DELETE FROM threads WHERE user_id = $1', [users[0].id]);
  await query('DELETE FROM users WHERE id = $1', [users[0].id]);
}

async function createFixture() {
  await resetFixture();
  const userId = randomUUID();
  await query(
    'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
    [userId, EMAIL, 'benchmark-user-cannot-login'],
  );

  const accountIds = [];
  const rowsPerAccount = Math.ceil(ROWS / ACCOUNT_COUNT);
  let inserted = 0;

  for (let position = 0; position < ACCOUNT_COUNT && inserted < ROWS; position++) {
    const accountId = randomUUID();
    const folderId = randomUUID();
    const priority = ['critical', 'high', 'normal', 'low', 'muted'][position % 5];
    const count = Math.min(rowsPerAccount, ROWS - inserted);

    await query(
      `INSERT INTO accounts (
         id, user_id, address, domain, label, priority,
         imap_host, imap_port, smtp_host, smtp_port, username,
         secret_ciphertext, secret_nonce, secret_tag, status, position
       ) VALUES (
         $1, $2, $3, $4, $3, $5::priority_t,
         'invalid.example.test', 993, 'invalid.example.test', 587, $3,
         decode(repeat('00', 32), 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 'disabled', $6
       )`,
      [accountId, userId, `bench-${position}@example.test`, `domain-${position}.test`, priority, position],
    );
    await query(
      `INSERT INTO folders (id, account_id, path, name, role, position)
       VALUES ($1, $2, 'INBOX', 'Inbox', 'inbox', 0)`,
      [folderId, accountId],
    );

    await query(
      `INSERT INTO messages (
         account_id, folder_id, uid, message_id, thread_id,
         from_name, from_address, to_addrs, subject, subject_normalised,
         preview, date, body_search, body_indexed_at,
         seen, flagged, has_attachments, attachment_count,
         size, labels, priority
       )
       SELECT $1, $2, g,
              concat('<bench-', $3::int, '-', g, '@example.test>'),
              concat('thread-', $3::int, '-', g),
              concat('Sender ', g), concat('sender', g % 1000, '@example.test'),
              jsonb_build_array(jsonb_build_object('name', NULL, 'address', $4::text)),
              CASE WHEN g % 10 = 0 THEN concat('Invoice ', g) ELSE concat('Subject ', g) END,
              CASE WHEN g % 10 = 0 THEN concat('invoice ', g) ELSE concat('subject ', g) END,
               concat('Benchmark preview text ', g),
               now() - (($5::int + g) * interval '1 second'),
               CASE WHEN $3::int = 0 AND g = 1
                    THEN setweight(to_tsvector('english', 'benchmark xylophone body'), 'D')
                    ELSE NULL END,
               CASE WHEN $3::int = 0 AND g = 1 THEN now() ELSE NULL END,
               g % 3 <> 0, g % 17 = 0, g % 23 = 0,
              CASE WHEN g % 23 = 0 THEN 1 ELSE 0 END,
              500 + (g % 100000),
              CASE
                WHEN g % 20 = 0 THEN ARRAY['receipts', 'finance']::text[]
                WHEN g % 5 = 0 THEN ARRAY['bulk']::text[]
                ELSE '{}'::text[]
              END,
              $6::priority_t
         FROM generate_series(1, $7::int) AS g`,
      [
        accountId,
        folderId,
        position,
        `bench-${position}@example.test`,
        inserted,
        priority,
        count,
      ],
    );

    accountIds.push(accountId);
    inserted += count;
  }

  await refreshCounts(accountIds);
  await refreshAccountThreads(accountIds);
  await query('ANALYZE messages');
  return { userId, folderIds: await query(
    `SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id
      WHERE a.user_id = $1 AND f.role = 'inbox' ORDER BY f.id`,
    [userId],
  ).then((rows) => rows.map((row) => row.id)) };
}

const request = (userId, overrides = {}) => ({
  userId,
  q: {
    scope: { kind: 'unified', value: null, role: 'inbox' },
    sort: 'date',
    dir: 'desc',
    group: 'none',
    threaded: false,
    filters: EMPTY_FILTERS,
    limit: 100,
    cursor: null,
    ...overrides,
  },
});

async function measure(run, count = ITERATIONS) {
  await run();
  await run();
  acquisitions = 0;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return samples;
}

let acquisitions = 0;
const originalConnect = pool.connect.bind(pool);
pool.connect = (...args) => {
  acquisitions++;
  return originalConnect(...args);
};

try {
  console.log(`creating isolated ${ROWS.toLocaleString()}-message fixture`);
  const { userId, folderIds } = await createFixture();

  if (process.env.DB_BENCH_EXPLAIN === 'true') {
    const explain = async (sql, params) => {
      const rows = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const report = rows[0]['QUERY PLAN'][0];
      const nodes = [];
      const visit = (node) => {
        nodes.push({
          node: node['Node Type'],
          relation: node['Relation Name'],
          index: node['Index Name'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
          totalMs: node['Actual Total Time'],
          sort: node['Sort Method'],
          removed: node['Rows Removed by Filter'],
        });
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(report.Plan);
      return { planningMs: report['Planning Time'], executionMs: report['Execution Time'], nodes };
    };
    const visible = `(m.snoozed_until IS NULL OR m.snoozed_until <= now())`;
    console.log(JSON.stringify({
      plans: {
        page: await explain(
          `SELECT per_folder.*
             FROM unnest($1::uuid[]) AS wanted(folder_id)
             CROSS JOIN LATERAL (
               SELECT m.id, m.date
                 FROM messages m
                WHERE m.folder_id = ANY($1::uuid[])
                  AND m.folder_id = wanted.folder_id AND ${visible}
                ORDER BY m.date DESC, m.id DESC LIMIT 101
             ) per_folder
            ORDER BY per_folder.date DESC, per_folder.id DESC LIMIT 101`,
          [folderIds],
        ),
        count: await explain(
          `SELECT count(*) FROM (
             SELECT 1 FROM messages m
              WHERE m.folder_id = ANY($1::uuid[]) AND ${visible}
              LIMIT 10001
           ) capped`,
          [folderIds],
        ),
        folderFacets: await explain(
          `SELECT f.account_id, a.domain, a.priority, f.total, f.unread,
                  f.facet_flagged, f.facet_with_attachments, f.facet_labels
             FROM folders f JOIN accounts a ON a.id = f.account_id
            WHERE a.user_id = $1 AND f.id = ANY($2::uuid[])`,
          [userId, folderIds],
        ),
        snoozedCorrection: await explain(
          `SELECT m.account_id, a.domain, m.priority, m.labels, count(*)
             FROM messages m JOIN accounts a ON a.id = m.account_id
            WHERE a.user_id = $1 AND m.folder_id = ANY($2::uuid[])
              AND m.snoozed_until > now()
            GROUP BY m.account_id, a.domain, m.priority, m.labels`,
          [userId, folderIds],
        ),
      },
    }, null, 2));
  }

  const scenarios = [
    ['date', () => listMessages(request(userId))],
    ['threaded-date', () => listMessages(request(userId, { threaded: true }))],
    [
      'relevance-search',
      () => listMessages(request(userId, {
        scope: { kind: 'search', value: 'invoice', role: null },
        sort: 'relevance',
      })),
    ],
    ['sender', () => listMessages(request(userId, { sort: 'sender' }))],
    ['subject', () => listMessages(request(userId, { sort: 'subject' }))],
    ['unread', () => listMessages(request(userId, { sort: 'unread' }))],
    [
      'body-search',
      () => listMessages(request(userId, {
        scope: { kind: 'search', value: 'xylophone', role: null },
        sort: 'relevance',
      })),
    ],
  ];

  const results = {};
  for (const [name, run] of scenarios) {
    acquisitions = 0;
    const samples = await measure(run, name === 'threaded-date' ? Math.max(3, Math.floor(ITERATIONS / 2)) : ITERATIONS);
    results[name] = summarise(samples, acquisitions);
  }

  acquisitions = 0;
  let maxWaiting = 0;
  const monitor = setInterval(() => {
    maxWaiting = Math.max(maxWaiting, pool.waitingCount);
  }, 1);
  const concurrentSamples = [];
  for (let batch = 0; batch < Math.max(3, Math.floor(ITERATIONS / 2)); batch++) {
    const started = performance.now();
    await Promise.all(Array.from({ length: 8 }, () => listMessages(request(userId))));
    concurrentSamples.push(performance.now() - started);
  }
  clearInterval(monitor);
  results['eight-concurrent-date'] = {
    ...summarise(concurrentSamples, acquisitions, concurrentSamples.length * 8),
    maxPoolWaiting: maxWaiting,
    poolMax: pool.options.max,
  };

  console.log(JSON.stringify({ rows: ROWS, results }, null, 2));
} finally {
  await resetFixture();
  await query('ANALYZE messages');
  await pool.end();
}
