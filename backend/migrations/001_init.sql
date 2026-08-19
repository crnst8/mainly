-- 001_init — schema baseline.
-- Forward-only. Never edit an applied migration; add a new one.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Declared least-important first. Postgres orders enums by declaration order,
-- so this makes `ORDER BY priority DESC` put critical at the top — matching
-- PRIORITY_WEIGHT in the contract. Declaring it the intuitive way round
-- (critical first) silently inverts every priority sort.
CREATE TYPE priority_t AS ENUM ('muted', 'low', 'normal', 'high', 'critical');
CREATE TYPE account_status_t AS ENUM ('ok', 'syncing', 'auth_error', 'connect_error', 'disabled', 'pending');
CREATE TYPE folder_role_t AS ENUM ('inbox', 'drafts', 'sent', 'trash', 'junk', 'archive', 'flagged', 'all', 'custom');
CREATE TYPE security_t AS ENUM ('tls', 'starttls', 'none');

-- ── Users ───────────────────────────────────────────────────────────────────
-- App users. Distinct from mailbox credentials: one person may own twelve
-- mailboxes, and mailbox passwords are never used to sign in here.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citext so sign-in is case-insensitive without a functional index everywhere.
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Accounts ────────────────────────────────────────────────────────────────

CREATE TABLE accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address           text NOT NULL,
  domain            text NOT NULL,
  label             text NOT NULL,
  display_name      text NOT NULL DEFAULT '',
  priority          priority_t NOT NULL DEFAULT 'normal',

  imap_host         text NOT NULL,
  imap_port         int  NOT NULL,
  imap_security     security_t NOT NULL DEFAULT 'tls',
  smtp_host         text NOT NULL,
  smtp_port         int  NOT NULL,
  smtp_security     security_t NOT NULL DEFAULT 'starttls',
  username          text NOT NULL,

  -- AES-256-GCM. Never selected by any read path outside the sync worker.
  secret_ciphertext bytea NOT NULL,
  secret_nonce      bytea NOT NULL,
  secret_tag        bytea NOT NULL,
  secret_key_version int NOT NULL DEFAULT 1,

  status            account_status_t NOT NULL DEFAULT 'pending',
  error             text,
  color             text,
  hidden            bool NOT NULL DEFAULT false,
  signature         text,
  position          int NOT NULL DEFAULT 0,
  last_sync_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, address)
);

CREATE INDEX accounts_user_idx ON accounts (user_id, position);
CREATE INDEX accounts_domain_idx ON accounts (user_id, domain);

-- ── Folders ─────────────────────────────────────────────────────────────────

CREATE TABLE folders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path           text NOT NULL,
  name           text NOT NULL,
  role           folder_role_t NOT NULL DEFAULT 'custom',
  parent_id      uuid REFERENCES folders(id) ON DELETE SET NULL,
  depth          int NOT NULL DEFAULT 0,

  -- IMAP sync cursors. See docs/architecture.md.
  uidvalidity    bigint,
  uidnext        bigint,
  highest_modseq bigint,

  unread         int NOT NULL DEFAULT 0,
  total          int NOT NULL DEFAULT 0,
  color          text,
  pinned         bool NOT NULL DEFAULT false,
  subscribed     bool NOT NULL DEFAULT true,
  position       int NOT NULL DEFAULT 0,
  last_sync_at   timestamptz,

  UNIQUE (account_id, path)
);

CREATE INDEX folders_account_idx ON folders (account_id, position);
CREATE INDEX folders_role_idx ON folders (role);

-- ── Messages ────────────────────────────────────────────────────────────────
-- Metadata only. Bodies live in message_bodies and are evictable.

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id           uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid                 bigint NOT NULL,

  message_id          text,
  thread_id           text NOT NULL,
  in_reply_to         text,
  references_         text[] NOT NULL DEFAULT '{}',

  from_name           text,
  from_address        text NOT NULL,
  to_addrs            jsonb NOT NULL DEFAULT '[]',
  cc_addrs            jsonb NOT NULL DEFAULT '[]',

  subject             text NOT NULL DEFAULT '',
  -- Re:/Fwd: stripped. Used for subject-fallback threading and subject sort.
  subject_normalised  text NOT NULL DEFAULT '',
  preview             text NOT NULL DEFAULT '',
  date                timestamptz NOT NULL,

  seen                bool NOT NULL DEFAULT false,
  flagged             bool NOT NULL DEFAULT false,
  answered            bool NOT NULL DEFAULT false,
  draft_flag          bool NOT NULL DEFAULT false,

  has_attachments     bool NOT NULL DEFAULT false,
  attachment_count    int NOT NULL DEFAULT 0,
  size                int NOT NULL DEFAULT 0,

  labels              text[] NOT NULL DEFAULT '{}',
  -- Denormalised from accounts so priority sort stays index-only.
  -- Kept in step by a bulk UPDATE when the account's tier changes.
  priority            priority_t NOT NULL DEFAULT 'normal',

  snoozed_until       timestamptz,
  body_cached_at      timestamptz,

  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(from_name, '')), 'B') ||
    setweight(to_tsvector('simple',  coalesce(from_address, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(preview, '')), 'C')
  ) STORED,

  UNIQUE (folder_id, uid)
);

-- The unified list query: scope by folder, order by date. INCLUDE keeps the
-- common projection index-only.
CREATE INDEX messages_list_idx
  ON messages (account_id, folder_id, date DESC) INCLUDE (seen, flagged);

CREATE INDEX messages_folder_date_idx ON messages (folder_id, date DESC);
CREATE INDEX messages_priority_idx    ON messages (priority DESC, date DESC);
CREATE INDEX messages_thread_idx      ON messages (thread_id, date DESC);
CREATE INDEX messages_msgid_idx       ON messages (message_id);

-- Unread is a small slice of the table and is recomputed on every sidebar
-- render, so it gets its own partial index.
CREATE INDEX messages_unread_idx  ON messages (folder_id) WHERE NOT seen;
CREATE INDEX messages_flagged_idx ON messages (folder_id) WHERE flagged;

CREATE INDEX messages_search_idx ON messages USING gin (search);
CREATE INDEX messages_labels_idx ON messages USING gin (labels);

-- ── Bodies (cache) ──────────────────────────────────────────────────────────

CREATE TABLE message_bodies (
  message_id  uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  body_html   text,
  body_text   text,
  headers     jsonb NOT NULL DEFAULT '{}',
  attachments jsonb NOT NULL DEFAULT '[]',
  has_blocked_remote bool NOT NULL DEFAULT false,
  bytes       int NOT NULL DEFAULT 0,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_bodies_fetched_idx ON message_bodies (fetched_at);

-- ── Drafts ──────────────────────────────────────────────────────────────────

CREATE TABLE drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_addrs    jsonb NOT NULL DEFAULT '[]',
  cc_addrs    jsonb NOT NULL DEFAULT '[]',
  bcc_addrs   jsonb NOT NULL DEFAULT '[]',
  subject     text NOT NULL DEFAULT '',
  body_text   text NOT NULL DEFAULT '',
  body_html   text,
  in_reply_to uuid REFERENCES messages(id) ON DELETE SET NULL,
  forward_of  uuid REFERENCES messages(id) ON DELETE SET NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  send_at     timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX drafts_user_idx ON drafts (user_id, updated_at DESC);
CREATE INDEX drafts_scheduled_idx ON drafts (send_at) WHERE send_at IS NOT NULL;

-- ── Saved views & preferences ───────────────────────────────────────────────

CREATE TABLE saved_views (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     text NOT NULL,
  glyph    text NOT NULL DEFAULT '•',
  color    text,
  query    jsonb NOT NULL,
  pinned   bool NOT NULL DEFAULT true,
  position int NOT NULL DEFAULT 0
);

CREATE INDEX saved_views_user_idx ON saved_views (user_id, position);

CREATE TABLE preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    jsonb NOT NULL DEFAULT '{}'
);

-- ── Outbound queue ──────────────────────────────────────────────────────────
-- Every mutation we owe the IMAP server. Written in the same transaction as the
-- local change, drained asynchronously. See docs/architecture.md.

CREATE TABLE sync_ops (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_ops_due_idx ON sync_ops (next_attempt_at, account_id);

-- ── Sessions ────────────────────────────────────────────────────────────────
-- Postgres-backed so a single-container deployment needs no Redis.

CREATE TABLE sessions (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Bound to the session and stable for its lifetime. Rotating this per
  -- response looks stronger but breaks the moment a client issues concurrent
  -- requests: each response sets a different cookie, they race, and the header
  -- the client kept no longer matches whichever cookie landed last.
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

COMMIT;
