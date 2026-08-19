-- 007_sort_indexes — give every column sort key the seek date already had.
--
-- Each index starts with folder_id, then carries the requested sort expression
-- and the id tiebreak. This makes the per-folder lateral page a complete seek.

BEGIN;

CREATE INDEX messages_folder_sender_idx
  ON messages (folder_id, lower(coalesce(from_name, from_address)), id DESC);

CREATE INDEX messages_folder_subject_idx
  ON messages (folder_id, subject_normalised, id DESC);

CREATE INDEX messages_folder_size_idx
  ON messages (folder_id, size DESC, id DESC);

CREATE INDEX messages_folder_unread_idx
  ON messages (folder_id, seen, date DESC, id DESC);

CREATE INDEX messages_folder_priority_idx
  ON messages (folder_id, priority DESC, id DESC);

COMMIT;
