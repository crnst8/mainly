-- 002_folder_facets — precompute non-search facet counts with folder totals.
--
-- Message lists are read far more often than mail is synced. Aggregating every
-- message for every ordinary inbox request makes that read path linear in the
-- mailbox size, so the remaining facet counters live beside unread/total and
-- are refreshed by the same write-side pass.

BEGIN;

ALTER TABLE folders
  ADD COLUMN facet_flagged int NOT NULL DEFAULT 0,
  ADD COLUMN facet_with_attachments int NOT NULL DEFAULT 0,
  ADD COLUMN facet_labels jsonb NOT NULL DEFAULT '{}';

WITH grouped AS MATERIALIZED (
  SELECT f.id AS folder_id,
         coalesce(m.labels, '{}') AS labels,
         count(m.id)::int AS total,
         count(m.id) FILTER (WHERE NOT m.seen)::int AS unread,
         count(m.id) FILTER (WHERE m.flagged)::int AS flagged,
         count(m.id) FILTER (WHERE m.has_attachments)::int AS with_attachments
    FROM folders f
    LEFT JOIN messages m ON m.folder_id = f.id
   GROUP BY f.id, m.labels
), totals AS (
  SELECT folder_id,
         sum(total)::int AS total,
         sum(unread)::int AS unread,
         sum(flagged)::int AS flagged,
         sum(with_attachments)::int AS with_attachments
    FROM grouped
   GROUP BY folder_id
), label_values AS (
  SELECT folder_id, label, sum(total)::int AS n
    FROM grouped
    CROSS JOIN LATERAL unnest(labels) AS label
   GROUP BY folder_id, label
), label_maps AS (
  SELECT folder_id, jsonb_object_agg(label, n) AS labels
    FROM label_values
   GROUP BY folder_id
)
UPDATE folders f
   SET total = t.total,
       unread = t.unread,
       facet_flagged = t.flagged,
       facet_with_attachments = t.with_attachments,
       facet_labels = coalesce(l.labels, '{}')
  FROM totals t
  LEFT JOIN label_maps l ON l.folder_id = t.folder_id
 WHERE f.id = t.folder_id;

-- Snoozed rows are time-dependent and therefore cannot be folded permanently
-- into the folder counters. They are normally a tiny subset; this index makes
-- subtracting the currently-hidden rows proportional to that subset.
CREATE INDEX messages_snoozed_idx
  ON messages (folder_id, snoozed_until)
  WHERE snoozed_until IS NOT NULL;

COMMIT;
