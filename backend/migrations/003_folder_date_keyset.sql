-- 003_folder_date_keyset — make per-folder date pagination a complete index seek.

BEGIN;

DROP INDEX messages_folder_date_idx;
CREATE INDEX messages_folder_date_idx
  ON messages (folder_id, date DESC, id DESC);

COMMIT;
