-- 006_thread_index — collapse threads from a maintained index, not a full scan.
--
-- The threaded list is the default view and had no bounded path: DISTINCT ON
-- over the scope had to see every message before the outer LIMIT applied. These
-- tables move that work to the write side, where it is proportional to what
-- changed rather than to the mailbox.
--
-- thread_folders.last_date is the thread's global last_date, deliberately
-- denormalised onto every folder row. Identical values across a thread's leaves
-- make keyset pagination exact.

BEGIN;

CREATE TABLE threads (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id         text NOT NULL,
  last_date         timestamptz NOT NULL,
  last_message      uuid NOT NULL,
  msg_count         int NOT NULL DEFAULT 0,
  unread_count      int NOT NULL DEFAULT 0,
  flagged_count     int NOT NULL DEFAULT 0,
  attachment_count  int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, thread_id)
);

-- There is intentionally no foreign key on last_message. Removing one message
-- must not remove the thread row while other messages in it still exist.

CREATE TABLE thread_folders (
  user_id           uuid NOT NULL,
  thread_id         text NOT NULL,
  folder_id         uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  last_date         timestamptz NOT NULL,
  msg_count         int NOT NULL DEFAULT 0,
  unread_count      int NOT NULL DEFAULT 0,
  flagged_count     int NOT NULL DEFAULT 0,
  attachment_count  int NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, thread_id),
  FOREIGN KEY (user_id, thread_id) REFERENCES threads(user_id, thread_id) ON DELETE CASCADE
);

CREATE INDEX thread_folders_seek_idx
  ON thread_folders (folder_id, last_date DESC, thread_id DESC);

COMMIT;
