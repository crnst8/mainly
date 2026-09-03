-- 012_domain_control — optional, per-domain, opt-in mailbox provisioning.
--
-- Until now the mail server has been read-only infrastructure: this app held
-- one credential per mailbox and never wrote anything back. That stays the
-- default. A row here is a deliberate exception for one domain, and an install
-- with no rows behaves exactly as it did before this migration existed.
--
-- See docs/domain-control.md.

BEGIN;

CREATE TABLE mail_domains (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain  text NOT NULL,

  -- 'ssh' is the only driver today. Text rather than an enum for the reason
  -- api_tokens.scopes is a text[]: the set will grow (mailcow, Mailu, Migadu)
  -- and an enum costs a migration every time it does, for no checking the
  -- driver registry does not already do at the point of use.
  driver  text NOT NULL,

  -- Non-secret connection detail: host, port, user, and the pinned host key.
  -- Shown in the UI, so nothing that must stay private belongs here.
  config  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The SSH private key, sealed with the same AES-256-GCM helper that seals
  -- mailbox passwords — so it is covered by SECRET_KEY and by the existing key
  -- rotation path, and no read that serves a response ever selects it.
  secret_ciphertext  bytea NOT NULL,
  secret_nonce       bytea NOT NULL,
  secret_tag         bytea NOT NULL,
  secret_key_version int NOT NULL DEFAULT 1,

  -- 'list' | 'create' | 'delete' | 'password' | 'alias' | 'purge'
  --
  -- Empty by default, and that is the point: adding a domain grants nothing.
  -- This is the half of the decision the operator makes here. The other half
  -- lives on the mail server, in the helper's own allowlist, where this
  -- application cannot reach it — so widening a row here cannot widen what the
  -- server will actually do.
  grants  text[] NOT NULL DEFAULT '{}',

  -- 'pending' until the first probe, then 'ok' | 'unreachable' | 'error'.
  status  text NOT NULL DEFAULT 'pending',
  error   text,
  -- What the server said it allowed, at the last probe. Cached so the settings
  -- screen can grey out a grant the server will refuse, rather than offering a
  -- button that fails.
  server_grants   text[] NOT NULL DEFAULT '{}',
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, domain)
);

CREATE INDEX mail_domains_user_idx ON mail_domains (user_id, domain);

-- ── Audit ───────────────────────────────────────────────────────────────────
--
-- Same reasoning as unsubscribe_attempts: this reaches something outside the
-- application, it is not undoable, and every attempt is recorded whether it
-- succeeded or not.
--
-- `domain` and `target` are denormalised on purpose. The record has to outlive
-- the mail_domains row — "who deleted that address, and when" is a question
-- most often asked after the domain has been disconnected.

CREATE TABLE domain_ops (
  id      bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain  text NOT NULL,
  -- 'create' | 'delete' | 'password' | 'alias-add' | 'alias-del' | 'probe'
  action  text NOT NULL,
  -- The address acted on, or the domain itself for a probe.
  target  text NOT NULL,
  status  text NOT NULL,           -- 'ok' | 'failed'
  detail  text,
  -- 'session' when a person did it, otherwise the API token's name — the same
  -- convention unsubscribe_attempts.actor uses.
  actor   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX domain_ops_user_idx ON domain_ops (user_id, created_at DESC);
CREATE INDEX domain_ops_target_idx ON domain_ops (user_id, target);

COMMIT;
