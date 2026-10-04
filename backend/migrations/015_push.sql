-- 015_push — Web Push for new-mail notifications.
--
-- A device opts in from the browser; nothing here sends anything until one has.

-- One row per browser that subscribed. The endpoint is the push service's URL
-- for that browser and is unique to it, so subscribing again replaces rather
-- than duplicates. p256dh and auth are the browser's public half of the
-- payload encryption; they are not secrets, and nothing that reads them can
-- decrypt anything.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  label        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- The install's VAPID key pair, generated on first use. One row: every
-- subscription is bound to the public key it was made with, so replacing it
-- silently orphans every device. The private key is sealed under SECRET_KEY
-- like a mailbox password.
CREATE TABLE push_vapid (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key         text NOT NULL,
  secret_ciphertext  bytea NOT NULL,
  secret_nonce       bytea NOT NULL,
  secret_tag         bytea NOT NULL,
  secret_key_version int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now()
);
