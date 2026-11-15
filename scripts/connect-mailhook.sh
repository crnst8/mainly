#!/usr/bin/env bash
#
# Install the mail hook on a Dovecot server, over SSH, in one command: the
# server then tells this install which mailboxes changed, as they change,
# instead of waiting to be polled.
#
#   ./mainly.sh hook connect <ssh-host> [options]     against an install
#   ./dev.sh hook connect <ssh-host> --url URL         against a dev checkout
#   ./mainly.sh hook remove <ssh-host> [--imap-host H]
#   ./mainly.sh hook list
#   ./mainly.sh hook create <imap-host>…   token only, for installing by hand
#
# What `connect` does, in order, stopping at the first thing that fails:
#
#   1. Works out which IMAP hostnames the server answers to: --imap-host, or
#      the only host accounts here use.
#   2. Finds an API URL the mail server can reach (--url, else APP_ORIGIN and
#      this host's own addresses), tried *from the mail server*.
#   3. Checks the server: root or passwordless sudo, Dovecot 2.3, the Lua push
#      plugins present, a free push_notification_driver slot.
#   4. Mints a hook token here.
#   5. Writes mainly-hook.lua and a config file next to Dovecot's own config,
#      checks the result with doveconf, and reloads Dovecot. Any failure puts
#      the server back as it was and removes the token.
#   6. Tests the whole path: re-subscribes one login to INBOX (no change to
#      any mail) and waits for the notice to arrive here.
#
# The token crosses SSH on stdin only and is never printed or put on a command
# line. It is stored in the Dovecot config file, readable by root and the
# dovecot group only. See docs/mail-hook.md.
#
# The hook CLI is passed after `--` by mainly.sh or dev.sh, because the two run
# it differently (inside the container, or from source).

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: hook connect <ssh-host> [options]
       hook remove  <ssh-host> [--imap-host HOST]…
       hook list
       hook create <imap-host> [<imap-host>…]   print a token, to install by hand

  <ssh-host>        how `ssh` reaches the mail server: an alias from
                    ~/.ssh/config, or user@host. Key authentication, and root
                    or passwordless sudo there.

connect options:
  --url URL         this install's API as the mail server reaches it, e.g.
                    https://mail.example.com/api. Repeatable; the first that
                    answers is used. Default: APP_ORIGIN, then this host's
                    Tailscale and LAN addresses.
  --imap-host HOST  an IMAP hostname this server answers to, as accounts here
                    name it. Repeatable. Default: the only host accounts use.
  --user LOGIN      the login to test with. Default: the first working
                    account on those hosts.
EOF
}

[[ $# -ge 1 ]] || { usage; exit 2; }
ACTION=$1; shift
case "$ACTION" in
  connect|remove) [[ $# -ge 1 && "$1" != -* ]] || { usage; exit 2; }; HOST=$1; shift ;;
  list) ;;
  create)
    CREATE_HOSTS=()
    while [[ $# -gt 0 && "$1" != -- ]]; do CREATE_HOSTS+=("$1"); shift; done
    [[ ${#CREATE_HOSTS[@]} -gt 0 ]] || { usage; exit 2; }
    ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

URLS=() IMAP_HOSTS=() TEST_USER='' HOOK_CLI=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URLS+=("${2:?--url needs a URL}"); shift 2 ;;
    --imap-host) IMAP_HOSTS+=("$(printf '%s' "${2:?--imap-host needs a host}" | tr 'A-Z' 'a-z')"); shift 2 ;;
    --user) TEST_USER=${2:?--user needs a login}; shift 2 ;;
    --) shift; HOOK_CLI=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ ${#HOOK_CLI[@]} -gt 0 ]] || die "Run this through ./mainly.sh hook or ./dev.sh hook."

if [[ "$ACTION" == list ]]; then
  "${HOOK_CLI[@]}" list
  exit 0
fi
if [[ "$ACTION" == create ]]; then
  exec "${HOOK_CLI[@]}" create "${CREATE_HOSTS[@]}"
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

# Run a script on the mail server: `remote [root] "$SCRIPT" args... < data`.
#
# As in connect-hermes.sh: the script travels base64-encoded inside the
# command so the remote login shell never parses it, stdin stays free for
# data, and arguments are single-quoted. `root` runs it as root, through
# `sudo -n` unless the SSH user already is root.
quote() { local a out=''; for a in "$@"; do out+=" '${a//\'/\'\\\'\'}'"; done; printf '%s' "$out"; }
remote() {
  local as='' script b64
  if [[ "$1" == root ]]; then as=root; shift; fi
  script=$1; shift
  b64=$(printf '%s' "$script" | base64 | tr -d '\n')
  if [[ -n "$as" ]]; then
    "${SSH[@]}" "s=\$(printf %s $b64 | base64 -d); if [ \"\$(id -u)\" -eq 0 ]; then bash -c \"\$s\" mainly-hook$(quote "$@"); else sudo -n bash -c \"\$s\" mainly-hook$(quote "$@"); fi"
  else
    "${SSH[@]}" "bash -c \"\$(printf %s $b64 | base64 -d)\" mainly-hook$(quote "$@")"
  fi
}

# Removes everything the installer writes, and reloads Dovecot. Used by
# `remove` and to roll back a failed `connect`. Prints nothing on success.
UNINSTALL=$(cat <<'REMOTE'
set -e
conf=$(doveconf -n 2>/dev/null | head -1 | sed -n 's/^#.*: //p')
[ -n "$conf" ] || conf=/etc/dovecot/dovecot.conf
dir=$(dirname "$conf")
rm -f "$dir/conf.d/99-mainly-hook.conf" "$dir/mainly-hook.conf" "$dir/mainly-hook.lua"
if grep -q '^!include_try mainly-hook.conf' "$conf" 2>/dev/null; then
  sed -i '/^!include_try mainly-hook.conf/d' "$conf"
fi
doveadm reload 2>/dev/null || true
REMOTE
)

# ── remove ──────────────────────────────────────────────────────────────────
if [[ "$ACTION" == remove ]]; then
  step "Removing the hook from $HOST"
  remote root "$UNINSTALL" </dev/null || die "Could not remove the hook files on $HOST."
  ok "Removed from Dovecot on $HOST"
  if [[ ${#IMAP_HOSTS[@]} -eq 0 ]]; then
    # Which hook belonged to that server is only known by its hosts. With one
    # hook there is no question to ask.
    ids=()
    while IFS= read -r id; do ids+=("$id"); done < <("${HOOK_CLI[@]}" list | awk '/^[0-9a-f-]+  / { print $1 }')
    [[ ${#ids[@]} -eq 1 ]] || die "More than one hook here. Name the server's hosts with --imap-host to remove its token too (./mainly.sh hook list)."
    "${HOOK_CLI[@]}" remove "${ids[0]}" >/dev/null && ok "Removed its token here"
  else
    for h in "${IMAP_HOSTS[@]}"; do "${HOOK_CLI[@]}" remove "$h" >/dev/null 2>&1 || true; done
    ok "Removed its token here"
  fi
  exit 0
fi

# ── 1. Which hosts ──────────────────────────────────────────────────────────
if [[ ${#IMAP_HOSTS[@]} -eq 0 ]]; then
  known=()
  while IFS= read -r line; do [[ -n "$line" ]] && known+=("$line"); done < <("${HOOK_CLI[@]}" hosts)
  [[ ${#known[@]} -gt 0 ]] || die "No accounts here yet. Add the mailboxes on this server first."
  if [[ ${#known[@]} -gt 1 ]]; then
    say "Accounts here use more than one IMAP host:"
    printf '  %s accounts  %s\n' $(printf '%s\n' "${known[@]}" | awk '{ print $2, $1 }')
    die "Name the ones this mail server answers to: --imap-host HOST (repeatable)."
  fi
  IMAP_HOSTS=("${known[0]%% *}")
fi
for h in "${IMAP_HOSTS[@]}"; do
  [[ "$h" =~ ^[a-z0-9.-]+$ ]] || die "Not a hostname: $h"
done
ok "For IMAP host${IMAP_HOSTS[1]:+s}: ${IMAP_HOSTS[*]}"

if [[ -z "$TEST_USER" ]]; then
  TEST_USER=$("${HOOK_CLI[@]}" login "${IMAP_HOSTS[@]}" 2>/dev/null) \
    || die "No working account on ${IMAP_HOSTS[*]} to test with. Pass --user LOGIN."
fi

# ── 2. A URL the mail server can reach ──────────────────────────────────────
PROBE=$(cat <<'REMOTE'
if command -v curl >/dev/null 2>&1; then
  curl -s -o /dev/null -m 5 -w '%{http_code}' "$1/health" || echo 0
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 5 -O /dev/null "$1/health" && echo 200 || echo 0
else
  echo none
fi
REMOTE
)

step "Finding an API address $HOST can reach"
[[ ${#URLS[@]} -gt 0 ]] || die "No API address to try. Pass --url https://your-mainly-host/api"
API=""
for url in "${URLS[@]}"; do
  url=${url%/}
  [[ "$url" =~ ^https?://[A-Za-z0-9.:/_~%-]+$ ]] || { warn "Skipping $url: not a plain http(s) URL"; continue; }
  status=$(remote "$PROBE" "$url" </dev/null) || die "Could not reach $HOST over SSH with a key. Check: ssh $HOST true"
  if [[ "$status" == 200 ]]; then API=$url; break; fi
  if [[ "$status" == none ]]; then
    warn "Neither curl nor wget on $HOST to check addresses with; using $url and testing at the end."
    API=$url; break
  fi
  say "  $url: no answer from $HOST"
done
[[ -n "$API" ]] || die "None of those addresses answer from $HOST. Pass the right one with --url."
case "$API" in
  https://* | http://localhost* | http://127.*) ;;
  http://100.*) ;; # Tailscale: the tunnel is encrypted even when HTTP is not.
  *) warn "$API is plain http, so the hook token crosses the network unencrypted. Prefer https or a Tailscale address." ;;
esac
HOOK_URL="$API/hooks/mail"
ok "Using $API"

# ── 3. The server ───────────────────────────────────────────────────────────
DETECT=$(cat <<'REMOTE'
set -e
command -v doveconf >/dev/null 2>&1 || { echo "error=Dovecot is not installed (no doveconf)."; exit 0; }
echo "version=$(dovecot --version 2>/dev/null | awk '{ print $1 }')"
conf=$(doveconf -n 2>/dev/null | head -1 | sed -n 's/^#.*: //p')
echo "conf=${conf:-/etc/dovecot/dovecot.conf}"
if grep -Eq '^[[:space:]]*!include(_try)?[[:space:]]+([^[:space:]]*/)?conf\.d/\*\.conf' "${conf:-/etc/dovecot/dovecot.conf}"; then
  echo "confd=yes"
else
  echo "confd=no"
fi
dir=$(doveconf -h mail_plugin_dir 2>/dev/null || echo /usr/lib/dovecot/modules)
for p in lib20_push_notification_plugin lib01_mail_lua_plugin lib22_push_notification_lua_plugin; do
  [ -f "$dir/$p.so" ] || echo "missing=$p"
done
echo "protocols=$(doveconf -h protocols 2>/dev/null)"
free=''
for k in push_notification_driver push_notification_driver2 push_notification_driver3 \
         push_notification_driver4 push_notification_driver5 push_notification_driver6; do
  v=$(doveconf -h "plugin/$k" 2>/dev/null || true)
  case "$v" in
    *mainly-hook.lua*) free=$k; break ;;
    '') [ -n "$free" ] || free=$k ;;
  esac
done
echo "slot=$free"
getent group dovecot >/dev/null 2>&1 && echo "group=dovecot" || echo "group="
REMOTE
)

step "Checking Dovecot on $HOST"
facts=$(remote root "$DETECT" </dev/null) \
  || die "Could not run as root on $HOST. The SSH user needs root or passwordless sudo."
fact() { printf '%s\n' "$facts" | sed -n "s/^$1=//p" | head -1; }
err=$(fact error); [[ -z "$err" ]] || die "$err"
VERSION=$(fact version) CONF=$(fact conf) CONFD=$(fact confd) SLOT=$(fact slot) GROUP=$(fact group)
PROTOCOLS=$(fact protocols)
case "$VERSION" in
  2.3.*) ;;
  2.4.*) die "Dovecot $VERSION: 2.4 changed how plugins are configured, and the hook is tested on 2.3 only. Nothing was changed on $HOST." ;;
  *) die "Dovecot ${VERSION:-of unknown version} on $HOST; the hook needs 2.3." ;;
esac
missing=$(printf '%s\n' "$facts" | sed -n 's/^missing=//p' | tr '\n' ' ')
[[ -z "$missing" ]] || die "Dovecot on $HOST lacks the Lua push plugins ($missing). Debian and Ubuntu ship them in dovecot-core; elsewhere install your distribution's Dovecot Lua package."
[[ -n "$SLOT" ]] || die "Every push_notification_driver slot on $HOST is in use."
ok "Dovecot $VERSION, Lua push plugins present, using $SLOT"

# ── 4. The token ────────────────────────────────────────────────────────────
step "Minting a hook token"
TOKEN=$("${HOOK_CLI[@]}" create "${IMAP_HOSTS[@]}" --replace 2>/dev/null) \
  || die "Could not create the hook here."
[[ "$TOKEN" =~ ^mh_[A-Za-z0-9_-]+$ ]] || die "The hook CLI printed something unexpected; nothing was installed."
ok "Minted"

forget_token() {
  for h in "${IMAP_HOSTS[@]}"; do "${HOOK_CLI[@]}" remove "$h" >/dev/null 2>&1 || true; done
}

# ── 5. Install ──────────────────────────────────────────────────────────────
# Arguments: conf path, conf.d included (yes/no), Lua (base64), hook URL,
# driver slot, protocols, group. The token arrives on stdin.
#
# Protocol blocks only, never a global mail_plugins line: Dovecot does not let
# a global setting written last reach protocol blocks written earlier (and
# warns), while `$mail_plugins` inside a protocol block keeps that protocol's
# earlier value — so Sieve on LMTP, quota on IMAP and the rest stay as they
# are. Plugins already loaded are not listed twice.
INSTALL=$(cat <<'REMOTE'
set -e
IFS= read -r token
conf=$1 confd=$2 lua_b64=$3 url=$4 slot=$5 protocols=$6 group=$7
dir=$(dirname "$conf")
if [ "$confd" = yes ]; then target="$dir/conf.d/99-mainly-hook.conf"; else target="$dir/mainly-hook.conf"; fi

# Start from no hook at all, so the plugin lists below are read without ours.
rm -f "$dir/conf.d/99-mainly-hook.conf" "$dir/mainly-hook.conf"
sed -i '/^!include_try mainly-hook.conf/d' "$conf"

printf '%s' "$lua_b64" | base64 -d > "$dir/mainly-hook.lua.tmp"
chmod 644 "$dir/mainly-hook.lua.tmp"
mv "$dir/mainly-hook.lua.tmp" "$dir/mainly-hook.lua"

umask 077
tmp="$target.tmp"
{
  echo "# Written by mainly (scripts/connect-mailhook.sh): tells mainly which"
  echo "# mailboxes changed. Remove with ./mainly.sh hook remove. Holds a token."
  for p in imap lmtp lda pop3 doveadm; do
    case " $protocols doveadm lda " in *" $p "*) ;; *) continue ;; esac
    have=" $(doveconf -f protocol=$p -h mail_plugins 2>/dev/null) "
    add=''
    for plugin in notify push_notification mail_lua push_notification_lua; do
      case "$have" in *" $plugin "*) ;; *) add="$add $plugin" ;; esac
    done
    [ -n "$add" ] || continue
    printf 'protocol %s {\n  mail_plugins = $mail_plugins%s\n}\n' "$p" "$add"
  done
  printf 'plugin {\n  %s = lua:file=%s/mainly-hook.lua\n  mainly_hook_url = %s\n  mainly_hook_token = %s\n}\n' \
    "$slot" "$dir" "$url" "$token"
} > "$tmp"
if [ -n "$group" ]; then chgrp "$group" "$tmp"; chmod 640 "$tmp"; fi
mv "$tmp" "$target"
if [ "$confd" != yes ]; then echo '!include_try mainly-hook.conf' >> "$conf"; fi

if ! out=$(doveconf -n 2>&1 >/dev/null); then echo "doveconf rejected the config: $out"; exit 3; fi
for p in imap lmtp; do
  case " $protocols " in *" $p "*) ;; *) continue ;; esac
  case " $(doveconf -f protocol=$p -h mail_plugins) " in
    *" push_notification_lua "*) ;;
    *) echo "Something later in Dovecot's config replaces mail_plugins for $p, so the hook would not load there."; exit 3 ;;
  esac
done
doveadm reload
REMOTE
)

step "Installing the hook on $HOST"
LUA_B64=$(base64 < scripts/mainly-hook.lua | tr -d '\n')
if ! out=$(printf '%s\n' "$TOKEN" | remote root "$INSTALL" "$CONF" "$CONFD" "$LUA_B64" "$HOOK_URL" "$SLOT" "$PROTOCOLS" "$GROUP" 2>&1); then
  remote root "$UNINSTALL" </dev/null >/dev/null 2>&1 || warn "Could not undo the partial install on $HOST; run: ./mainly.sh hook remove $HOST"
  forget_token
  die "Installing on $HOST failed, and it was put back as it was. ${out:-}"
fi
unset TOKEN
ok "Installed and Dovecot reloaded"

# ── 6. Test ─────────────────────────────────────────────────────────────────
# Flip one login's INBOX subscription and flip it back: no mail is touched and
# the subscription ends as it started, but Dovecot reports each change through
# the same plugin path a delivery takes. (Re-subscribing alone is not enough:
# Dovecot reports only a subscription that actually changes.)
PROBE_SUB=$(cat <<'REMOTE'
set -e
if doveadm mailbox list -s -u "$1" INBOX 2>/dev/null | grep -qx INBOX; then
  doveadm mailbox unsubscribe -u "$1" INBOX
  doveadm mailbox subscribe -u "$1" INBOX
else
  doveadm mailbox subscribe -u "$1" INBOX
  doveadm mailbox unsubscribe -u "$1" INBOX
fi
REMOTE
)
step "Testing: asking Dovecot to notify for $TEST_USER"
before=$("${HOOK_CLI[@]}" last "${IMAP_HOSTS[0]}")
remote root "$PROBE_SUB" "$TEST_USER" </dev/null \
  || die "doveadm could not act as $TEST_USER on $HOST. Pass a login Dovecot knows with --user."
for _ in $(seq 1 20); do
  sleep 0.5
  now=$("${HOOK_CLI[@]}" last "${IMAP_HOSTS[0]}")
  if [[ "$now" != "$before" && "$now" != 0 ]]; then
    ok "Notice received. $HOST now tells this install when mail changes."
    exit 0
  fi
done

logs=$(remote root 'doveadm log errors 2>/dev/null | grep mainly-hook | tail -3' </dev/null || true)
warn "Dovecot loaded the hook, but no notice arrived here within 10 seconds."
[[ -z "$logs" ]] || say "$logs"
say "  Check that $HOST can reach $API, then run this again."
exit 1
