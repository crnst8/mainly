-- Cascading a thread deletion probes this foreign key once per thread. Without
-- its matching index, a large account removal repeatedly scans every leaf.
CREATE INDEX thread_folders_thread_idx ON thread_folders (user_id, thread_id);
