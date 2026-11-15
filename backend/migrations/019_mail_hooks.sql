-- 019_mail_hooks — a mail server that tells this install when mailboxes change.
--
-- One row per mail server running scripts/mainly-hook.lua. The server sends
-- the login and the mailbox names that changed; the row says which IMAP
-- hostnames it speaks for, so a notice can only ever start a sync of accounts
-- on those hosts. See docs/mail-hook.md.
--
-- Operator-level, not per user: one mail server carries mailboxes for any
-- number of users here, and the hook is installed once on it.

CREATE TABLE mail_hooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- IMAP hostnames this server answers to, lower-cased, as accounts store
  -- them. One server often has a name per domain.
  hosts         text[] NOT NULL CHECK (cardinality(hosts) > 0),
  -- SHA-256 of the bearer token. The token itself exists only in the mail
  -- server's Dovecot config.
  token_hash    bytea NOT NULL UNIQUE,
  -- First characters of the token, to tell two hooks apart in a listing.
  prefix        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Written at most every few seconds. Recent enough means the hook works, and
  -- accounts on these hosts are polled on the slow interval.
  last_event_at timestamptz
);

CREATE INDEX mail_hooks_hosts_idx ON mail_hooks USING gin (hosts);
