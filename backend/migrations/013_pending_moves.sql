-- Logical filing changes immediately; an IMAP UID only names a message in its
-- confirmed server folder. NULL prevents destination UID collisions in flight.
ALTER TABLE messages ALTER COLUMN uid DROP NOT NULL;
ALTER TABLE messages ADD COLUMN remote_folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN remote_uid bigint;
CREATE INDEX messages_remote_location_idx ON messages (remote_folder_id, remote_uid)
  WHERE remote_folder_id IS NOT NULL;

-- Recover locations captured by older queued moves before they changed folder_id.
WITH sources AS (
  SELECT DISTINCT ON (m.id) m.id, f.id AS folder_id, (t.target->>'uid')::bigint AS uid
    FROM sync_ops o
    CROSS JOIN LATERAL jsonb_array_elements(o.payload->'targets') WITH ORDINALITY t(target, n)
    JOIN messages m ON m.id::text = o.payload->'ids'->>((t.n - 1)::int)
    JOIN folders f ON f.account_id = o.account_id AND f.path = t.target->>'path'
   WHERE o.kind IN ('move', 'delete')
   ORDER BY m.id, o.id
)
UPDATE messages m SET remote_folder_id = s.folder_id, remote_uid = s.uid, uid = NULL
  FROM sources s WHERE m.id = s.id;
