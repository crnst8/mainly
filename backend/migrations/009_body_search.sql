-- 009_body_search — searchable body text, independent of the body cache.
--
-- message_bodies is evictable and is populated by reads, so it cannot be the
-- source of search results. Body text is indexed separately as it arrives from
-- the normal preview fetch and from a bounded backfill.

BEGIN;

ALTER TABLE messages ADD COLUMN body_search tsvector;
ALTER TABLE messages ADD COLUMN body_indexed_at timestamptz;

-- Keep this expression byte-identical to SEARCHABLE in search-sql.ts.
CREATE INDEX messages_search_all_idx
  ON messages USING gin ((search || coalesce(body_search, ''::tsvector)));

CREATE INDEX messages_unindexed_idx
  ON messages (folder_id, date DESC)
  WHERE body_indexed_at IS NULL;

COMMIT;
