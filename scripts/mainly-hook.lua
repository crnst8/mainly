-- mainly mail hook: tells a mainly install which mailboxes changed, as they
-- change, so it can fetch those folders instead of polling for them.
--
-- Runs inside Dovecot's own processes (imap, lmtp, lda, pop3, doveadm) as a
-- push_notification Lua driver. Installed by `./mainly.sh hook connect`; see
-- docs/mail-hook.md. The URL and token come from Dovecot's config
-- (plugin { mainly_hook_url, mainly_hook_token }), so this file holds no
-- secret and can be world-readable.
--
-- What is sent: the login, the names of the mailboxes that changed, and
-- whether the folder list changed. Never a sender, subject, flag or body:
-- mainly reads all of that over IMAP itself, so the hook only has to say where
-- to look.
--
-- This code runs in the path of mail delivery and of every other client's
-- IMAP commands, so it must never slow them down or fail them:
--   * every call is wrapped in pcall, and a failure is logged and dropped;
--   * the whole request, connecting included, is abandoned after one second;
--   * after a failure the session stops calling for a minute. Dovecot gives
--     each mail user its own Lua state, so this holds for an IMAP session
--     (one user, many commands) but not across deliveries: while mainly is
--     unreachable, each delivered message waits at most one second. A refused
--     connection fails at once and costs nothing.
-- Missing a notification is safe: mainly still polls, more slowly, as a floor.

local TIMEOUT_MS = 1000
local PAUSE_AFTER_FAILURE_S = 60

-- Key names matter: the binding ignores keys it does not know, so a misspelt
-- timeout silently leaves Dovecot's 60-second default in place. Connecting is
-- bounded by the request timeout because no connect timeout is exposed.
local http_client = dovecot.http.client {
  request_timeout_msecs = TIMEOUT_MS;
  request_absolute_timeout_msecs = TIMEOUT_MS;
  max_attempts = 1;
  max_connect_attempts = 1;
  no_auto_retry = true;
}

local paused_until = 0

local ESCAPES = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function json_string(s)
  local escaped = tostring(s):gsub('[%c"\\]', function(c)
    return ESCAPES[c] or string.format('\\u%04x', c:byte())
  end)
  return '"' .. escaped .. '"'
end

local function warn(message)
  pcall(dovecot.i_warning, 'mainly-hook: ' .. message)
end

function dovecot_lua_notify_begin_txn(user)
  return {
    user = user.username,
    url = user:plugin_getenv('mainly_hook_url'),
    token = user:plugin_getenv('mainly_hook_token'),
    boxes = {},
    folders = false,
  }
end

local function changed(ctx, event)
  if event.mailbox then ctx.boxes[event.mailbox] = true end
end

local function renamed(ctx, event)
  ctx.folders = true
  changed(ctx, event)
end

dovecot_lua_notify_event_message_new = changed
dovecot_lua_notify_event_message_append = changed
dovecot_lua_notify_event_message_expunge = changed
dovecot_lua_notify_event_message_read = changed
dovecot_lua_notify_event_message_trash = changed
dovecot_lua_notify_event_flags_set = changed
dovecot_lua_notify_event_flags_clear = changed
dovecot_lua_notify_event_mailbox_create = renamed
dovecot_lua_notify_event_mailbox_delete = renamed
dovecot_lua_notify_event_mailbox_rename = renamed
dovecot_lua_notify_event_mailbox_subscribe = renamed
dovecot_lua_notify_event_mailbox_unsubscribe = renamed

local function send(ctx)
  local names = {}
  for name in pairs(ctx.boxes) do names[#names + 1] = json_string(name) end
  if #names == 0 and not ctx.folders then return end

  local body = '{"user":' .. json_string(ctx.user)
    .. ',"mailboxes":[' .. table.concat(names, ',') .. ']'
    .. ',"folders":' .. tostring(ctx.folders) .. '}'

  local request = http_client:request { url = ctx.url; method = 'POST'; }
  request:add_header('content-type', 'application/json')
  request:add_header('authorization', 'Bearer ' .. ctx.token)
  request:set_payload(body)
  local status = request:submit():status()
  if status < 200 or status >= 300 then
    error('mainly answered ' .. tostring(status))
  end
end

function dovecot_lua_notify_end_txn(ctx)
  if not ctx.url or ctx.url == '' or not ctx.token or ctx.token == '' then return end
  if os.time() < paused_until then return end
  local ok, err = pcall(send, ctx)
  if not ok then
    paused_until = os.time() + PAUSE_AFTER_FAILURE_S
    warn(tostring(err) .. '; pausing for ' .. PAUSE_AFTER_FAILURE_S .. 's')
  end
end
