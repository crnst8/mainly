-- 017_filter_llm_keys — a user's own language-model provider for the filter.
--
-- The server's FILTER_LLM_* variables configure one provider for everyone. A
-- row here replaces it for one user: their key, their bill, and optionally
-- their own OpenAI-compatible endpoint. See docs/filtering.md.

CREATE TABLE filter_llm_keys (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The API base, ending before /chat/completions. NULL is OpenCode Go.
  base_url           text,

  -- AES-256-GCM, as accounts.secret_*. Never selected by a read that serves a
  -- response. May seal an empty string: a local server that needs no key.
  secret_ciphertext  bytea NOT NULL,
  secret_nonce       bytea NOT NULL,
  secret_tag         bytea NOT NULL,
  secret_key_version int NOT NULL DEFAULT 1,

  updated_at         timestamptz NOT NULL DEFAULT now()
);
