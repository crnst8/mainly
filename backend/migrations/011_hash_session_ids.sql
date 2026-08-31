-- Session ids are stored hashed, the way api_tokens already stores its secrets.
--
-- `sessions.id` used to be the cookie value in the clear, which made any read of
-- this table — a pg_dump left in ./backups, a replica, a support copy — a set of
-- live credentials rather than a record that sessions existed. `api_tokens` got
-- this right from the start (`token_hash bytea`); sessions did not, and there is
-- no reason for the two to disagree.
--
-- The column stays the primary key and stays `text`; what changes is that it now
-- holds sha256(cookie) in hex. Hashing is not a KDF here for the same reason it
-- is not one for api_tokens: the value is 32 bytes from randomBytes, so there is
-- no dictionary to run and nothing for a slow hash to buy.
--
-- Existing rows cannot be converted — the whole point is that the cookie value
-- is not recoverable from what is stored — so they go. Everyone signs in once
-- more. That is the entire migration cost, and it is paid once.
DELETE FROM sessions;

COMMENT ON COLUMN sessions.id IS
  'sha256 of the session cookie, hex. Never the cookie value itself.';
