-- 008_trgm — index the substring operators search already offers.
--
-- from:, subject: and free text use ILIKE '%value%'. pg_trgm indexes that
-- leading-wildcard shape without changing its substring semantics.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX messages_subject_trgm_idx
  ON messages USING gin (subject gin_trgm_ops);

CREATE INDEX messages_from_address_trgm_idx
  ON messages USING gin (from_address gin_trgm_ops);

CREATE INDEX messages_from_name_trgm_idx
  ON messages USING gin ((coalesce(from_name, '')) gin_trgm_ops);

CREATE INDEX messages_preview_trgm_idx
  ON messages USING gin (preview gin_trgm_ops);

COMMIT;
