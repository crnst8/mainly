-- 005_agent_access — API tokens for agents, and an audit trail for unsubscribes.
--
-- Two tables, added together because they exist for the same reason: an agent
-- acting on this mailbox from outside the browser needs a credential that is
-- not a session cookie, and the one action it can take that reaches a third
-- party has to leave a record.

BEGIN;

-- ── API tokens ──────────────────────────────────────────────────────────────
--
-- The plaintext token is shown once, at creation, and never stored. What is
-- stored is a SHA-256 of it: this is a random 256-bit secret, not a password,
-- so there is nothing for a slow KDF to protect against and a lookup by digest
-- has to stay a single index probe.
--
-- Scopes are a text array rather than an enum. The set will grow, and an enum
-- costs a migration every time it does for no checking a `?? []` does not
-- already give.

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What this token is for, in the operator's words. Shown in `token list`.
  name         text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  -- The first few characters of the secret, so two tokens are distinguishable
  -- in a listing without any of them being recoverable from it.
  prefix       text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  -- NULL is a token that does not expire. Allowed, and discouraged in the docs.
  expires_at   timestamptz
);

CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at DESC);

-- ── Unsubscribe attempts ────────────────────────────────────────────────────
--
-- Unsubscribing is the only thing this application does that reaches a server
-- nobody here controls, and it is not undoable. Every attempt is recorded
-- whether it succeeded or not.
--
-- `from_address` is denormalised deliberately: the record has to outlive the
-- message, and "did I already unsubscribe from this sender" is the question
-- that gets asked.

CREATE TABLE unsubscribe_attempts (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  from_address text NOT NULL,
  list_id      text,
  -- 'http' for an RFC 8058 one-click POST, 'mailto' for a message sent to the
  -- address the list published.
  method       text NOT NULL,
  target       text NOT NULL,
  -- 'ok' | 'failed'
  status       text NOT NULL,
  detail       text,
  -- 'session' when a person did it, otherwise the API token's name.
  actor        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX unsubscribe_attempts_user_idx ON unsubscribe_attempts (user_id, created_at DESC);
CREATE INDEX unsubscribe_attempts_sender_idx ON unsubscribe_attempts (user_id, from_address);

COMMIT;
