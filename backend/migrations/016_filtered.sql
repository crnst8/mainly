-- 016_filtered — the Filtered folder and what it learns from.
--
-- Each account gets a Filtered folder under its inbox. Mail the user files
-- there teaches the filter, mail they take back out corrects it, and new
-- inbox mail that looks like the first kind is filed there on arrival.
-- See docs/filtering.md.

-- A role of its own, so the folder is found on every account the way Trash and
-- Junk are, and the sidebar can show one Filtered row across all of them. Not
-- used anywhere in this file: a value added in a transaction cannot be.
ALTER TYPE folder_role_t ADD VALUE IF NOT EXISTS 'filtered';

-- Two headers the filter reads, captured in the envelope pass alongside
-- References. `List-Id` names a mailing list across every address it sends
-- from; `bulk` is "this came from a sender that mails many people at once"
-- (List-Unsubscribe, List-Id or Precedence: bulk/list/junk). Older rows keep
-- NULL and false, which reads as "not known to be bulk".
ALTER TABLE messages ADD COLUMN list_id text;
ALTER TABLE messages ADD COLUMN bulk boolean NOT NULL DEFAULT false;

-- One row per decision the user made: this message belongs in Filtered
-- (`filter`), or it does not (`keep`). The sender, list and features are copied
-- out of the message because the example has to outlive it — mail gets
-- deleted, the lesson should not. `message_id` is kept while the message
-- exists so that Undo can find and withdraw the example it just made.
CREATE TABLE filter_examples (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  verdict      text NOT NULL CHECK (verdict IN ('filter', 'keep')),
  from_address text NOT NULL,
  from_name    text,
  subject      text NOT NULL DEFAULT '',
  list_id      text,
  features     text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX filter_examples_user_idx ON filter_examples (user_id, id);
CREATE INDEX filter_examples_sender_idx ON filter_examples (user_id, from_address, id);
CREATE INDEX filter_examples_list_idx ON filter_examples (user_id, list_id, id) WHERE list_id IS NOT NULL;
CREATE INDEX filter_examples_message_idx ON filter_examples (message_id) WHERE message_id IS NOT NULL;

-- Every message the filter filed by itself, and why. Read back for two things:
-- telling a rescue (the filter was wrong) from an undo (the user changed their
-- mind), and measuring how often the filter is wrong so it can be more careful.
-- `rescued_at` is set when the user moves one back out. The row outlives its
-- message, because deleting filtered mail unread is the filter being right,
-- and dropping those rows would make it look wrong more often than it is.
CREATE TABLE filter_decisions (
  id          bigserial PRIMARY KEY,
  message_id  uuid UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage       text NOT NULL CHECK (stage IN ('rule', 'model', 'llm')),
  score       real,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rescued_at  timestamptz
);

CREATE INDEX filter_decisions_user_idx ON filter_decisions (user_id, created_at);
