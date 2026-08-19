-- 010_sort_index_direction — make the sort indexes match the order they serve.
--
-- 007 declared three of these as (sort_column ASC, id DESC). A btree serves an
-- ordering forwards or backwards as a whole, so a mixed-direction index answers
-- `expr ASC, id DESC` and `expr DESC, id ASC` — while the list query asks for
-- `expr DESC, id DESC` or `expr ASC, id ASC`, and gets neither. EXPLAIN showed a
-- Sort above the scan for sender, subject and unread; size and priority were
-- already consistent (both columns DESC) and are left alone.
--
-- Either direction works as long as both columns agree, because the backward
-- scan then covers the other one. ASC is used here so the expression reads the
-- way the sort key does.
--
-- The unread index also carried `date` between `seen` and `id`. The query orders
-- on `seen, id`, so the extra column split the ordering and forced an
-- incremental sort inside each seen bucket.

BEGIN;

DROP INDEX messages_folder_sender_idx;
CREATE INDEX messages_folder_sender_idx
  ON messages (folder_id, lower(coalesce(from_name, from_address)), id);

DROP INDEX messages_folder_subject_idx;
CREATE INDEX messages_folder_subject_idx
  ON messages (folder_id, subject_normalised, id);

DROP INDEX messages_folder_unread_idx;
CREATE INDEX messages_folder_unread_idx
  ON messages (folder_id, seen, id);

COMMIT;
