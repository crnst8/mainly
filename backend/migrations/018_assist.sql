-- 018_assist — the default model for a user's own provider, what the filter
-- has worked out about a user's filing, and sender logos.
--
-- See docs/filtering.md and docs/assist.md.

-- The model chosen from the provider's own list when the key was saved. NULL
-- keeps the provider's built-in default (OpenCode Go) or, for a provider
-- offering none of the preferred models, asks the user to choose one.
ALTER TABLE filter_llm_keys ADD COLUMN model text;

-- A periodic summary of what one user files and keeps, by kind of mail rather
-- than by sender, written by the language model from the user's Filtered
-- folder and inbox (filter/study.ts) and read back into every filing prompt.
-- `attempted_at` is the claim: a sync worker sets it before asking the model,
-- so two workers never build the same profile at once.
CREATE TABLE filter_profiles (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  filter_lines  text[] NOT NULL DEFAULT '{}',
  keep_lines    text[] NOT NULL DEFAULT '{}',
  -- How many messages the profile was written from, for the settings screen.
  basis         int NOT NULL DEFAULT 0,
  model         text,
  built_at      timestamptz,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  error         text
);

-- One logo per sender domain, found by BIMI or the domain's own site icon.
-- Shared across users: a logo is public, and fetching it once per install is
-- one request to that domain instead of one per person. `image` NULL records
-- a domain with no logo, so it is not asked again until `fetched_at` ages out.
CREATE TABLE sender_logos (
  domain        text PRIMARY KEY,
  content_type  text,
  image         bytea,
  source        text CHECK (source IN ('bimi', 'icon')),
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
