/**
 * The fixture the check suite runs against.
 *
 *   ./dev.sh seed
 *
 * `scripts/query-check.mjs` asserts absolute counts — 65 messages, 13 invoice
 * subjects, 10 labelled rows, 40/25 across two domains. Those rows used to exist
 * only as whatever happened to be in the local database, which meant
 * `./dev.sh rebuild` silently turned 46 correctness checks into 46 failures with
 * no relationship to the code. The fixture is code now.
 *
 * It belongs to its own user. Every query in this application is scoped by
 * `user_id`, so the fixture and a real mailbox can share a database without
 * either being able to see the other — which is what makes it safe to run the
 * checks on the same Postgres that holds live mail.
 */

import { pool, query } from '../db/index.ts';
import { createUser, setPassword } from '../modules/auth/index.ts';
import { seal } from '../lib/crypto.ts';
import { refreshCounts } from '../sync/folders.ts';
import { refreshAccountThreads } from '../sync/threads.ts';

export const FIXTURE_EMAIL = 'smoke@example.test';
export const FIXTURE_PASSWORD = 'smoke-password-1234';

interface Spec {
  address: string;
  domain: string;
  priority: 'critical' | 'muted';
  count: number;
  idPrefix: string;
  threadPrefix: string;
  senderPrefix: string;
  subjectFor: (i: number) => string;
  previewFor: (i: number) => string;
  sizeFor: (i: number) => number;
  /** Hours back from the seed instant. */
  agoHours: (i: number) => number;
  /** Labels and attachments live on the first account only. The checks assert
   *  absolute counts — 10 labelled, 5 with attachments — and spreading them
   *  across both accounts silently changes both numbers. */
  decorated: boolean;
}

const SPECS: Spec[] = [
  {
    address: 'dale@bigchungus.holdings',
    domain: 'bigchungus.holdings',
    priority: 'critical',
    count: 40,
    idPrefix: 'm',
    threadPrefix: 'thr-',
    senderPrefix: 'Sender',
    // Every third message, giving the 13 the search checks look for.
    subjectFor: (i) => (i % 3 === 0 ? 'Invoice payment received' : `Subject ${i}`),
    previewFor: (i) => `Preview text for message ${i}`,
    sizeFor: (i) => i * 1000,
    agoHours: (i) => i,
    decorated: true,
  },
  {
    address: 'newsletter@notchungus.xyz',
    domain: 'notchungus.xyz',
    priority: 'muted',
    count: 25,
    idPrefix: 'n',
    threadPrefix: 'nthr-',
    senderPrefix: 'News',
    subjectFor: (i) => `Newsletter ${i}`,
    previewFor: (i) => `Weekly digest ${i}`,
    sizeFor: (i) => i * 500,
    // Days apart, so the priority check has a muted account whose mail is older
    // in places and newer in others than the critical one.
    agoHours: (i) => i * 24,
    decorated: false,
  },
];

async function ensureUser(): Promise<string> {
  const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    FIXTURE_EMAIL,
  ]);
  if (!existing[0]) return createUser(FIXTURE_EMAIL, FIXTURE_PASSWORD);
  // The password is reset, not just the mail.
  //
  // The smoke suite rotates it to prove `/auth/password` works and rotates it
  // back. If it is interrupted between the two — a 429, a killed process — the
  // fixture is left holding a password nothing knows, and every later run fails
  // at sign-in for a reason that has nothing to do with the code under test.
  // Reseeding is the reset; it should reset all of it.
  await setPassword(existing[0].id, FIXTURE_PASSWORD);
  return existing[0].id;
}

export async function seed(): Promise<void> {
  const userId = await ensureUser();

  // Accounts cascade to folders and messages, so this is the whole reset.
  await query('DELETE FROM accounts WHERE user_id = $1', [userId]);
  await query('DELETE FROM saved_views WHERE user_id = $1', [userId]);

  // A real sealed secret, not a placeholder. These accounts are never connected,
  // but a row whose ciphertext cannot be opened makes every error message in the
  // logs a decrypt failure rather than whatever actually went wrong.
  const sealed = seal('fixture-account-not-connected');

  for (const [position, spec] of SPECS.entries()) {
    const account = await query<{ id: string }>(
      `INSERT INTO accounts (
         user_id, address, domain, label, display_name, priority,
         imap_host, imap_port, imap_security,
         smtp_host, smtp_port, smtp_security, username,
         secret_ciphertext, secret_nonce, secret_tag, secret_key_version,
         -- Disabled so the sync loop never tries to reach a host that does not
         -- exist. The query engine does not filter on status, so every row is
         -- still visible to the checks.
         status, position
       ) VALUES ($1, $2, $3, $4, $5, $6::priority_t,
                 $7, 993, 'tls', $8, 587, 'starttls', $2,
                 $9, $10, $11, $12, 'disabled', $13)
       RETURNING id`,
      [
        userId,
        spec.address,
        spec.domain,
        spec.address,
        spec.address.split('@')[0],
        spec.priority,
        `imap.${spec.domain}.invalid`,
        `smtp.${spec.domain}.invalid`,
        sealed.ciphertext,
        sealed.nonce,
        sealed.tag,
        sealed.keyVersion,
        position,
      ],
    );
    const accountId = account[0]!.id;

    const folder = await query<{ id: string }>(
      `INSERT INTO folders (account_id, path, name, role, depth, subscribed, position,
                            uidvalidity, uidnext)
       VALUES ($1, 'INBOX', 'Inbox', 'inbox', 0, true, 0, 1, $2)
       RETURNING id`,
      [accountId, spec.count + 1],
    );
    const folderId = folder[0]!.id;

    const rows = [];
    for (let i = 1; i <= spec.count; i++) {
      rows.push({
        uid: i,
        message_id: `<${spec.idPrefix}${i}@x>`,
        // The first two messages of the first account share a thread, which is
        // what makes 65 messages collapse to 64 rows.
        thread_id: spec.idPrefix === 'm' && i <= 2 ? 'thr-a' : `${spec.threadPrefix}${i}`,
        from_name: `${spec.senderPrefix} ${i}`,
        from_address: `${spec.senderPrefix.toLowerCase()}${i}@example.com`,
        to_addrs: [{ name: null, address: spec.address }],
        subject: spec.idPrefix === 'm' && i === 2 ? 'Xylophone Subject 2' : spec.subjectFor(i),
        // xylophone occurs only in m1's body and m2's subject. It proves body
        // search and the D-vs-A ranking without inventing bodies in the mock.
        body_text: spec.idPrefix === 'm' && i === 1 ? 'A body-only xylophone word' : null,
        preview: spec.previewFor(i),
        date: new Date(Date.now() - spec.agoHours(i) * 3600_000).toISOString(),
        // Read state alternates. Only the read/unread partition is asserted, not
        // an absolute count.
        seen: i % 2 === 0 || i <= 4,
        flagged: i % 5 === 0,
        // Five total on the first account, with one inside thr-a so collapsed
        // attachment rollups are observable in the query checks.
        attachment_count: spec.decorated && (i === 2 || (i % 7 === 0 && i !== 35)) ? 1 : 0,
        size: spec.sizeFor(i),
        // Every fourth of forty: the 10 receipt rows the checks expect. Every
        // twentieth also has `finance`, proving facet counts do not multiply a
        // message merely because it carries two labels.
        labels: spec.decorated && i % 4 === 0
          ? i % 20 === 0 ? ['receipts', 'finance'] : ['receipts']
          : [],
      });
    }

    await query(
      `
      INSERT INTO messages (
        account_id, folder_id, uid, message_id, thread_id,
        from_name, from_address, to_addrs, subject, subject_normalised,
         preview, date, body_search, body_indexed_at,
         seen, flagged, has_attachments, attachment_count,
        size, labels, priority
      )
      SELECT $1::uuid, $2::uuid, r.uid, r.message_id, r.thread_id,
             r.from_name, r.from_address, r.to_addrs, r.subject, r.subject,
              r.preview, r.date,
              CASE WHEN r.body_text IS NULL THEN NULL
                   ELSE setweight(to_tsvector('english', r.body_text), 'D') END,
              CASE WHEN r.body_text IS NULL THEN NULL ELSE now() END,
              r.seen, r.flagged,
             r.attachment_count > 0, r.attachment_count,
             r.size, r.labels, $3::priority_t
        FROM jsonb_to_recordset($4::jsonb) AS r(
          uid bigint, message_id text, thread_id text,
          from_name text, from_address text, to_addrs jsonb,
           subject text, preview text, date timestamptz, body_text text,
          seen bool, flagged bool, attachment_count int, size int, labels text[]
        )
      `,
      [accountId, folderId, spec.priority, JSON.stringify(rows)],
    );

    await refreshCounts(accountId);
    await refreshAccountThreads(accountId);
  }

  const total = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages m
       JOIN accounts a ON a.id = m.account_id WHERE a.user_id = $1`,
    [userId],
  );
  console.log(`seeded ${FIXTURE_EMAIL} with ${total[0]?.n ?? 0} messages`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await seed();
  } finally {
    await pool.end();
  }
}
