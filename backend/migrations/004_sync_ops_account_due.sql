-- 004_sync_ops_account_due — match replay's account-first lookup order.

BEGIN;

DROP INDEX sync_ops_due_idx;
CREATE INDEX sync_ops_due_idx ON sync_ops (account_id, next_attempt_at, id);

COMMIT;
