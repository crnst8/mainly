/** Assertions for the maintained thread index. */

import { pool, query } from '../src/db/index.ts';

try {
  const countMismatches = await query(
    `SELECT t.user_id, t.thread_id, t.msg_count, count(m.id)::int AS actual
       FROM threads t
       JOIN accounts a ON a.user_id = t.user_id
       JOIN messages m ON m.thread_id = t.thread_id AND m.account_id = a.id
      GROUP BY t.user_id, t.thread_id, t.msg_count
     HAVING t.msg_count <> count(m.id)`,
  );
  const dateMismatches = await query(
    `SELECT tf.user_id, tf.thread_id
       FROM thread_folders tf
       JOIN threads t ON t.user_id = tf.user_id AND t.thread_id = tf.thread_id
      WHERE tf.last_date <> t.last_date`,
  );
  const orphaned = await query(
    `SELECT t.user_id, t.thread_id
       FROM threads t
      WHERE NOT EXISTS (
        SELECT 1 FROM messages m
        JOIN accounts a ON a.id = m.account_id
       WHERE a.user_id = t.user_id AND m.thread_id = t.thread_id
      )`,
  );

  if (countMismatches.length || dateMismatches.length || orphaned.length) {
    console.error(JSON.stringify({ countMismatches, dateMismatches, orphaned }, null, 2));
    process.exitCode = 1;
  } else {
    console.log('thread index consistency passed');
  }
} finally {
  await pool.end();
}
