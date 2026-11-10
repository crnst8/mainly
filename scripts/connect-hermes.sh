#!/usr/bin/env bash
#
# Connect a Hermes agent (https://github.com/NousResearch/hermes-agent) to this
# mail install, over SSH, in one command.
#
#   ./mainly.sh hermes <ssh-host> <email> [options]     against an install
#   ./dev.sh hermes <ssh-host> <email> --api-url URL     against a dev checkout
#
# What it does, in order, stopping at the first thing that fails:
#
#   1. Finds Hermes and Node 22+ on the agent's host (Hermes bundles a Node).
#   2. Finds an API URL that the agent's host can actually reach: --api-url if
#      given, else APP_ORIGIN and this host's own addresses, each tried *from
#      the agent's host* against /api/health.
#   3. Copies the MCP server (mcp/) there and installs its two dependencies.
#   4. Mints a token for <email> with the scopes asked for (read,write by
#      default) and an expiry (90 days by default).
#   5. Writes the token into Hermes's own secret file (~/.hermes/.env, mode
#      0600) and registers the server in Hermes's config with a ${VAR}
#      reference, so the token never appears in config.yaml.
#   6. Tests the connection with `hermes mcp test`, installs a short Hermes
#      skill for using it, and revokes earlier tokens of the same name.
#
# The token crosses the SSH connection on stdin only — never in a command
# line, where any user on either host could read it from the process list —
# and is never printed. Nothing about either host is written into this repo.
#
# The token CLI is passed after `--` by mainly.sh or dev.sh, because the two
# run it differently (inside the container, or from source).

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
usage: hermes <ssh-host> <email> [options]

  <ssh-host>        how `ssh` reaches the machine Hermes runs on: an alias from
                    ~/.ssh/config, or user@host. Key authentication required.
  <email>           the mail user the agent acts as.

options:
  --api-url URL     the API as the agent's host reaches it, e.g.
                    https://mail.example.com/api. Repeatable; the first that
                    answers is used. Default: APP_ORIGIN, then this host's
                    Tailscale and LAN addresses.
  --scopes LIST     token scopes, default read,write. Add unsubscribe only if
                    the agent should act on List-Unsubscribe.
  --days N          token lifetime in days, default 90. Run again to renew.
  --name NAME       the server's name in Hermes and the token's name here,
                    default mainly.
  --remote-dir DIR  where the MCP server goes on the agent's host,
                    default ~/.local/share/mainly-mcp.
  --no-skill        do not install the Hermes skill.
EOF
}

[[ $# -ge 2 && "$1" != -* ]] || { usage; exit 2; }
HOST=$1 EMAIL=$2
shift 2

API_URLS=() SCOPES=read,write DAYS=90 NAME=mainly REMOTE_DIR='~/.local/share/mainly-mcp' SKILL=1 TOKEN_CLI=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URLS+=("${2:?--api-url needs a URL}"); shift 2 ;;
    --scopes) SCOPES=${2:?--scopes needs a list}; shift 2 ;;
    --days) DAYS=${2:?--days needs a number}; shift 2 ;;
    --name) NAME=${2:?--name needs a name}; shift 2 ;;
    --remote-dir) REMOTE_DIR=${2:?--remote-dir needs a path}; shift 2 ;;
    --no-skill) SKILL=0; shift ;;
    --) shift; TOKEN_CLI=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ ${#TOKEN_CLI[@]} -gt 0 ]] || die "Run this through ./mainly.sh hermes or ./dev.sh hermes."
[[ "$NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--name must be lower-case letters, digits, - or _."
[[ "$REMOTE_DIR" =~ ^[~A-Za-z0-9/._-]+$ ]] || die "--remote-dir must be a plain path."
# The env var Hermes stores the token under: MAINLY_MCP_TOKEN for the default.
VAR="$(printf '%s' "$NAME" | tr 'a-z-' 'A-Z_')_MCP_TOKEN"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

# Run a script on the agent's host: `remote "$SCRIPT" args... < data`.
#
# The script travels base64-encoded inside the command, so the remote login
# shell (often sh, not bash) never has to parse it, and stdin stays free for
# data — the MCP server's files, or the token. Arguments are single-quoted for
# that shell; nothing secret is ever one of them.
quote() { local a out=''; for a in "$@"; do out+=" '${a//\'/\'\\\'\'}'"; done; printf '%s' "$out"; }
remote() {
  local script=$1 b64
  shift
  b64=$(printf '%s' "$script" | base64 | tr -d '\n')
  "${SSH[@]}" "bash -c \"\$(printf %s $b64 | base64 -d)\" connect-hermes$(quote "$@")"
}

# ── 1. Hermes and Node ──────────────────────────────────────────────────────
FIND=$(cat <<'REMOTE'
set -e
hermes=$(command -v hermes || true)
if [ -z "$hermes" ] && [ -x "$HOME/.local/bin/hermes" ]; then hermes="$HOME/.local/bin/hermes"; fi
[ -n "$hermes" ] || { echo nohermes; exit 0; }
node=""
for n in "$(command -v node || true)" "$HOME/.hermes/node/bin/node"; do
  [ -n "$n" ] && [ -x "$n" ] || continue
  major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 22 ]; then node=$n; break; fi
done
[ -n "$node" ] || { echo nonode; exit 0; }
printf '%s\n%s\n' "$hermes" "$node"
"$hermes" config env-path
REMOTE
)

step "Looking for Hermes on $HOST"
found=$(remote "$FIND" </dev/null) || die "Could not reach $HOST over SSH with a key. Check: ssh $HOST true"
case "$found" in
  nohermes) die "Hermes is not installed on $HOST (no 'hermes' on PATH or in ~/.local/bin)." ;;
  nonode) die "Node 22 or later is needed on $HOST. Hermes's installer bundles one; or install Node 22+." ;;
esac
{ read -r HERMES; read -r NODE; read -r ENV_PATH; } <<<"$found"
[[ -n "${ENV_PATH:-}" ]] || die "Hermes on $HOST did not report where its .env is."
ok "Hermes found, with Node at $NODE"

# ── 2. An API URL the agent's host can reach ────────────────────────────────
PROBE=$(cat <<'REMOTE'
"$2" -e 'fetch(process.argv[1] + "/health", { signal: AbortSignal.timeout(5000) })
  .then((r) => console.log(r.status)).catch(() => console.log(0))' "$1"
REMOTE
)

step "Finding an API address $HOST can reach"
[[ ${#API_URLS[@]} -gt 0 ]] || die "No API address to try. Pass --api-url https://your-mail-host/api"
API=""
for url in "${API_URLS[@]}"; do
  url=${url%/}
  [[ "$url" =~ ^https?://[A-Za-z0-9.:/_~%-]+$ ]] || { warn "Skipping $url: not a plain http(s) URL"; continue; }
  status=$(remote "$PROBE" "$url" "$NODE" </dev/null || true)
  if [[ "$status" == 200 ]]; then API=$url; break; fi
  say "  $url: no answer from $HOST"
done
[[ -n "$API" ]] || die "None of those addresses answer from $HOST. Pass the right one with --api-url."
case "$API" in
  https://* | http://localhost* | http://127.*) ;;
  http://100.*) ;; # Tailscale: the tunnel is encrypted even when HTTP is not.
  *) warn "$API is plain http, so the token crosses the network unencrypted. Prefer https or a Tailscale address." ;;
esac
ok "Using $API"

# ── 3. The MCP server ───────────────────────────────────────────────────────
INSTALL=$(cat <<'REMOTE'
set -e
dir=$(eval echo "$1")
mkdir -p "$dir"
rm -rf "$dir/src"
tar -C "$dir" -xf -
cd "$dir"
PATH="$(dirname "$2"):$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error
REMOTE
)

step "Installing the MCP server on $HOST"
tar -C mcp -cf - package.json package-lock.json tsconfig.json src \
  | remote "$INSTALL" "$REMOTE_DIR" "$NODE" >/dev/null \
  || die "Installing the MCP server on $HOST failed."
ok "Installed"

# ── 4. The token ────────────────────────────────────────────────────────────
step "Minting a token for $EMAIL ($SCOPES, $DAYS days)"
# `token list` prints "<id>  <prefix>…  <name>" per token.
old_ids=$("${TOKEN_CLI[@]}" list "$EMAIL" 2>/dev/null | awk -v n="$NAME" '$3 == n { print $1 }' || true)
TOKEN=$("${TOKEN_CLI[@]}" create "$EMAIL" "$NAME" --scopes "$SCOPES" --days "$DAYS" 2>/dev/null) \
  || die "Could not mint a token. Is $EMAIL a user here?"
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || die "The token CLI printed something unexpected; nothing was installed."
ok "Minted"

# ── 5. Secret and config ────────────────────────────────────────────────────
STORE=$(cat <<'REMOTE'
set -e
IFS= read -r token
umask 077
f=$1 var=$2
touch "$f"
grep -v "^$var=" "$f" > "$f.mainly-tmp" || true
printf '%s=%s\n' "$var" "$token" >> "$f.mainly-tmp"
chmod 600 "$f.mainly-tmp"
mv "$f.mainly-tmp" "$f"
REMOTE
)

step "Storing the token in Hermes's secret file"
printf '%s\n' "$TOKEN" | remote "$STORE" "$ENV_PATH" "$VAR" || die "Could not write Hermes's .env on $HOST."
unset TOKEN
ok "Stored as $VAR"

REGISTER=$(cat <<'REMOTE'
set -e
dir=$(eval echo "$6")
# Answers Hermes's two questions: "overwrite?" (asked only when the server is
# already configured) and "enable all tools?". Every tool is enabled: the
# token's scopes are what limit the agent, and a tool list kept here would
# drift from them.
printf 'y\n\n' | "$1" mcp add "$2" --command "$3" \
  --env "MAIL_API_URL=$4" "MAIL_API_TOKEN=\${$5}" \
  --args --experimental-strip-types "$dir/src/index.ts"
REMOTE
)

step "Registering '$NAME' with Hermes"
remote "$REGISTER" "$HERMES" "$NAME" "$NODE" "$API" "$VAR" "$REMOTE_DIR" </dev/null >/dev/null \
  || die "hermes mcp add failed on $HOST."

step "Testing the connection"
remote '"$1" mcp test "$2"' "$HERMES" "$NAME" </dev/null || die "Hermes registered the server, but the test failed (output above)."
ok "Hermes can reach your mail"

# ── 6. Skill, and the old tokens ────────────────────────────────────────────
SKILL_INSTALL=$(cat <<'REMOTE'
set -e
d="$HOME/.hermes/skills/email/$1"
mkdir -p "$d"
cat > "$d/SKILL.md"
REMOTE
)

if [[ $SKILL -eq 1 ]]; then
  if sed "s/{{name}}/$NAME/g" mcp/hermes/SKILL.md | remote "$SKILL_INSTALL" "$NAME"; then
    ok "Installed the Hermes skill"
  else
    warn "Could not install the Hermes skill; the tools work without it."
  fi
fi

for id in $old_ids; do
  if "${TOKEN_CLI[@]}" revoke "$EMAIL" "$id" >/dev/null 2>&1; then ok "Revoked the previous '$NAME' token"; fi
done

say ""
ok "Done. Start a new Hermes session, or run /reload-mcp in an open one."
say "   Run this again to renew the token before it expires."
