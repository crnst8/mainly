#!/usr/bin/env bash
#
# mainly — install, run and maintain a self-hosted instance.
#
#   ./mainly.sh start                  bring everything up (generates .env on first run)
#   ./mainly.sh user you@example.com   create a login
#
# Run it with no arguments to see everything else it does.
#
# It is deliberately chatty and deliberately refuses rather than guesses. The
# person running this is usually running it once, on a machine they care about,
# and a script that silently does the wrong thing to a database is worse than
# one that stops and says why.

set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env
COMPOSE_PROJECT=mainly

# ── Output ───────────────────────────────────────────────────────────────────
# Colour only when a terminal is actually attached, so piping to a file or a
# CI log produces something readable.
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────

compose() { docker compose "$@"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die \
"Docker is not installed.

  macOS / Windows   https://docs.docker.com/desktop/
  Linux             curl -fsSL https://get.docker.com | sh

Install it, start it, then run this script again."

  docker info >/dev/null 2>&1 || die \
"Docker is installed but not running. Start Docker Desktop (or 'sudo systemctl
start docker' on Linux) and run this script again."

  docker compose version >/dev/null 2>&1 || die \
"This Docker is too old — it has no 'docker compose' subcommand. Upgrade to
Docker 20.10.13 or newer, or install the compose plugin."
}

# openssl ships with macOS and every mainstream Linux, but a slim container
# image may not have it. Node is not assumed either, so fall back to /dev/urandom.
random_b64() {
  local bytes=$1
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes"
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '\n'
  fi
}

# Every IPv4 address this machine owns, one per line. Prefers `ip` (Linux);
# falls back to `ifconfig` (macOS, and net-tools on Linux) which prints the
# address in two different formats depending on the flavour. Match on the
# space after the address, not on ' netmask' — a point-to-point interface, which
# is what Tailscale is on macOS, prints the peer address in between.
local_addresses() {
  if command -v ip >/dev/null 2>&1; then
    # Skip the bridges Docker and libvirt bring up. They are addresses this
    # machine owns that no other device can route to, and offering one as
    # "open this from your phone" wastes the reader's time.
    ip -o -4 addr show scope global 2>/dev/null |
      awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }'
  else
    ifconfig 2>/dev/null | sed -n \
      -e 's/.*inet addr:\([0-9.]*\) .*/\1/p' \
      -e 's/.*inet \([0-9.]*\) .*/\1/p'
  fi
}

is_tailscale() {
  local IFS=. a b
  read -r a b _ <<<"$1"
  [[ "$a" == "100" && "$b" -ge 64 && "$b" -le 127 ]]
}

is_private() {
  local IFS=. a b
  read -r a b _ <<<"$1"
  [[ "$a" == "10" ]] && return 0
  [[ "$a" == "172" && "$b" -ge 16 && "$b" -le 31 ]] && return 0
  [[ "$a" == "192" && "$b" == "168" ]] && return 0
  return 1
}

# Anything that is not loopback, link-local, LAN or Tailscale — which on a real
# machine means an address the internet can reach. A VPS has one. A laptop, a
# NAS or a home server behind NAT does not.
is_public() {
  local IFS=. a b
  read -r a b _ <<<"$1"
  [[ "$a" == "127" || "$a" == "0" ]] && return 1
  [[ "$a" == "169" && "$b" == "254" ]] && return 1
  is_tailscale "$1" && return 1
  is_private "$1" && return 1
  return 0
}

has_public_address() {
  local addr
  while IFS= read -r addr; do
    [[ -n "$addr" ]] || continue
    if is_public "$addr"; then return 0; fi
  done < <(local_addresses)
  return 1
}

# The first local address the predicate accepts. Prints nothing and fails when
# there is none, so callers fall back in order: Tailscale, then LAN, then
# localhost.
pick_address() {
  local pred=$1 addr
  while IFS= read -r addr; do
    [[ -n "$addr" ]] || continue
    if "$pred" "$addr"; then printf '%s' "$addr"; return 0; fi
  done < <(local_addresses)
  return 1
}

# ── .env ─────────────────────────────────────────────────────────────────────

create_env() {
  step "First run — writing $ENV_FILE with freshly generated secrets"

  local secret session pgpw origin_addr bind_addr=127.0.0.1
  secret=$(random_b64 32)
  session=$(random_b64 32)
  # No '/', '+' or '=' — this password is interpolated into a URL.
  pgpw=$(random_b64 24 | tr -d '/+=')

  # A first install should be openable from the devices the person actually
  # uses — a phone on the same wifi, a laptop on the tailnet — with no proxy, no
  # certificate and no second setup step. So when nothing on this machine faces
  # the internet, listen on everything: localhost, the LAN address and the
  # Tailscale address all answer, and no other network can route here anyway.
  #
  # A machine that does hold a public address is a different question, and the
  # answer is no: it binds its private address only, so a plaintext login form
  # is never published to the internet by a default. './mainly.sh bind' changes
  # either decision after the fact.
  origin_addr="$(pick_address is_tailscale || true)"
  [[ -n "$origin_addr" ]] || origin_addr="$(pick_address is_private || true)"
  if has_public_address; then
    bind_addr="${origin_addr:-127.0.0.1}"
  else
    bind_addr=0.0.0.0
  fi

  cat > "$ENV_FILE" <<EOF
# Generated by ./mainly.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC').
# Keep this file. Back up SECRET_KEY somewhere that is not this machine.

# The address you open in a browser, and the one CORS is checked against. Only
# the scheme really binds you: an https:// origin is what marks the session
# cookie Secure. Behind a reverse proxy, set this to the public URL —
# './mainly.sh origin https://mail.example.com'.
APP_ORIGIN=http://${origin_addr:-localhost}:5274

# What the host port listens on. 0.0.0.0 is every interface — localhost, LAN and
# Tailscale — which is what a machine with no public address gets on first run.
# A single address narrows it to that one; 127.0.0.1 is localhost-only.
# './mainly.sh bind all|tailscale|lan|local|<address>' rewrites this.
PORT=5274
BIND_ADDRESS=${bind_addr:-127.0.0.1}

# ── Secrets. Generated once. Never commit this file. ────────────────────────
# SECRET_KEY encrypts stored mailbox passwords. Lose it and every account has
# to be re-added by hand. It is the one value here worth backing up.
SECRET_KEY=${secret}
SESSION_SECRET=${session}
POSTGRES_PASSWORD=${pgpw}

# ── Optional ────────────────────────────────────────────────────────────────
# Set to true only if your mail server is on a LAN, a VPN or Tailscale. It
# lets the "verify these settings" step connect to private addresses, which is
# also what makes it a request-forgery surface. Off is the safe default.
ALLOW_PRIVATE_IMAP_HOSTS=false

# Reach a mail server by private address while still validating its public
# certificate:  MAIL_HOST_OVERRIDE=mail.example.com=100.64.0.1
MAIL_HOST_OVERRIDE=

LOG_LEVEL=info
EOF

  chmod 600 "$ENV_FILE"
  ok "Wrote $ENV_FILE (mode 600)"
  say "${DIM}  Back up SECRET_KEY. Without it, stored mailbox passwords are unrecoverable.${RESET}"
  say ""
  if [[ "$bind_addr" == "0.0.0.0" ]]; then
    if [[ -z "$(local_addresses)" ]]; then
      # Neither `ip` nor `ifconfig` answered, so "no public address" is an
      # assumption rather than a finding. Say which one it is.
      say "  This machine's addresses could not be listed, so mainly listens on every"
      say "  interface. Check that this machine is not on the open internet, or run"
      say "  '${BOLD}./mainly.sh bind local${RESET}' to keep it to this machine."
    else
      say "  Nothing on this machine faces the internet, so mainly listens on every"
      say "  interface: this machine, your LAN, and Tailscale if you run it. Any device"
      say "  that can reach this machine can open it — plain HTTP, no certificate."
    fi
  else
    say "  This machine has an address the internet can reach, so mainly listens on"
    say "  ${BOLD}${bind_addr}${RESET} only — a plaintext login form is not something to publish."
    say "  Put TLS in front of it to go further: docs/self-hosting.md."
  fi
  say ""
  say "${DIM}  ./mainly.sh bind          what it listens on, and every URL that reaches it${RESET}"
  say "${DIM}  ./mainly.sh bind local    narrow it to this machine${RESET}"
  say ""
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "No $ENV_FILE. Run './mainly.sh start' first."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

app_url() {
  printf '%s' "${APP_ORIGIN:-http://localhost:${PORT:-5274}}"
}

# Where the app actually answers, for checks run from this host. APP_ORIGIN may
# name a public URL behind a proxy; the bound address never does. 0.0.0.0 is a
# listen address, not a destination — curl it on the loopback instead.
health_url() {
  local bind="${BIND_ADDRESS:-127.0.0.1}"
  [[ "$bind" == "0.0.0.0" ]] && bind=127.0.0.1
  printf 'http://%s:%s' "$bind" "${PORT:-5274}"
}

# Every URL that reaches this instance directly, most useful first: Tailscale
# before LAN because it survives changing networks, localhost last because it
# only works from here. A specific BIND_ADDRESS answers on exactly one.
reachable_urls() {
  local port="${PORT:-5274}" bind="${BIND_ADDRESS:-127.0.0.1}" addr
  if [[ "$bind" != "0.0.0.0" ]]; then
    printf 'http://%s:%s\n' "$bind" "$port"
    return 0
  fi
  addr="$(pick_address is_tailscale || true)"
  if [[ -n "$addr" ]]; then printf 'http://%s:%s\n' "$addr" "$port"; fi
  addr="$(pick_address is_private || true)"
  if [[ -n "$addr" ]]; then printf 'http://%s:%s\n' "$addr" "$port"; fi
  printf 'http://localhost:%s\n' "$port"
}

# The list a person should read, indented and with the one to try first in bold.
# APP_ORIGIN leads when it names something this script cannot derive — a proxy's
# hostname — because that is the URL the cookies are scoped to.
print_urls() {
  local origin="${APP_ORIGIN:-}" first=1 url urls
  # Collected once, and read from a here-string rather than a pipe: `grep -q`
  # closes the pipe on its first match, and under `pipefail` that SIGPIPE reads
  # as the whole pipeline failing.
  urls="$(reachable_urls)"
  if [[ -n "$origin" ]] && ! grep -qxF "$origin" <<<"$urls"; then
    say "    ${BOLD}${origin}${RESET}  ${DIM}(APP_ORIGIN)${RESET}"
    first=0
  fi
  while IFS= read -r url; do
    if [[ $first -eq 1 ]]; then say "    ${BOLD}${url}${RESET}"; first=0
    else say "    ${url}"; fi
  done <<<"$urls"
}

# Rewrite one key in .env, keeping the order, the comments and the 0600 mode.
# Appends the key when the file predates it.
set_env_var() {
  local key=$1 value=$2 tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" \
      'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  # Truncate in place rather than mv, so the file keeps its mode and inode.
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# Docker without the lecture: 'bind' and 'origin' still do their job when it is
# not installed or not running — the new value simply takes effect at the next
# start, which is exactly what someone configuring before the first start wants.
docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# Recreate the container when the published port changed. Only when it is
# already running: 'bind' before the first start just edits .env.
apply_to_running() {
  local running
  running="$(compose ps --status running --format '{{.Service}}' 2>/dev/null || true)"
  if grep -q '^app$' <<<"$running"; then
    step "Restarting the app on the new address"
    compose up -d app >/dev/null
    return 0
  fi
  return 1
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_start() {
  require_docker
  [[ -f "$ENV_FILE" ]] || create_env
  load_env

  # Refuse rather than collide. A half-started stack on a taken port fails much
  # later and much more confusingly than this does.
  local port="${PORT:-5274}"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    if ! compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^app$'; then
      die "Port $port is already in use by something else.
Set a different PORT in $ENV_FILE, or stop whatever is holding it."
    fi
  fi

  step "Starting mainly (this pulls or builds images on the first run)"
  # Try the published image first, and fall back to building from this checkout.
  # A tag that does not exist yet — a fork, an unreleased commit, an air-gapped
  # host — should not be the difference between "it works" and a registry error.
  if [[ " $* " == *" --build "* ]] || ! compose pull --quiet app 2>/dev/null; then
    if [[ " $* " != *" --build "* ]]; then
      say "${DIM}  no published image for this version — building from source${RESET}"
      set -- "$@" --build
    fi
  fi
  compose up -d "$@"

  step "Waiting for the app to answer"
  local url; url=$(health_url)
  for _ in $(seq 1 60); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then
      say ""
      ok "mainly is running"
      say ""
      say "  Open it at:"
      print_urls
      say ""
      if ! has_users; then
        say "  No login exists yet. Create one:"
        say "    ${BOLD}./mainly.sh user you@yourdomain.com${RESET}"
        say ""
      fi
      say "${DIM}  ./mainly.sh bind      change what it listens on${RESET}"
      say "${DIM}  ./mainly.sh logs      follow the log${RESET}"
      say "${DIM}  ./mainly.sh stop      shut it down${RESET}"
      return 0
    fi
    sleep 2
  done

  warn "The app did not answer within two minutes. The last 40 lines of its log:"
  compose logs --tail 40 app >&2
  die "Startup failed. 'docker compose logs -f app' has the rest."
}

has_users() {
  compose exec -T db psql -U mainly -d mainly -tAc \
    'SELECT count(*) > 0 FROM users' 2>/dev/null | grep -q '^t$'
}

cmd_stop() {
  require_docker
  step "Stopping"
  compose down --remove-orphans
  ok "Stopped. Your data is still in the 'mainly_db-data' volume."
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_status() {
  require_docker
  compose ps
  if [[ -f "$ENV_FILE" ]]; then
    load_env
    say ""
    if curl -fsS "$(health_url)/api/health" 2>/dev/null; then
      say ""
      say "  Reachable at:"
      print_urls
      say ""
    else
      warn "The app is not answering on $(health_url)"
    fi
  fi
}

# ── Where it listens ─────────────────────────────────────────────────────────

cmd_bind() {
  load_env
  local want="${1:-}" addr

  if [[ -z "$want" ]]; then
    say ""
    say "  BIND_ADDRESS=${BOLD}${BIND_ADDRESS:-127.0.0.1}${RESET}   ${DIM}(what the host port listens on)${RESET}"
    say "  APP_ORIGIN=${BOLD}${APP_ORIGIN:-http://localhost:${PORT:-5274}}${RESET}   ${DIM}(what browsers open)${RESET}"
    say ""
    say "  Reachable at:"
    print_urls
    say ""
    say "${DIM}  ./mainly.sh bind all         every interface — LAN, Tailscale and this machine${RESET}"
    say "${DIM}  ./mainly.sh bind tailscale   the Tailscale address only${RESET}"
    say "${DIM}  ./mainly.sh bind lan         the LAN address only${RESET}"
    say "${DIM}  ./mainly.sh bind local       this machine only${RESET}"
    say "${DIM}  ./mainly.sh bind 10.0.0.4    one address you name${RESET}"
    say ""
    return 0
  fi

  case "$want" in
    all|any|0.0.0.0)
      addr=0.0.0.0
      # Every interface includes the public one on a machine that has one. That
      # is a real decision, not a default, so it is made out loud.
      if has_public_address; then
        warn "This machine has an address the internet can reach, and 'all' publishes"
        warn "an unencrypted login form and session cookie there."
        read -r -p "Type 'yes' to do it anyway: " reply
        [[ "$reply" == "yes" ]] || { say "Cancelled. 'bind lan' or 'bind tailscale' keeps it private."; exit 0; }
      fi
      ;;
    tailscale|ts)
      addr="$(pick_address is_tailscale || true)"
      [[ -n "$addr" ]] || die "No Tailscale address on this machine. Is tailscaled running?"
      ;;
    lan|private)
      addr="$(pick_address is_private || true)"
      [[ -n "$addr" ]] || die "No private LAN address on this machine."
      ;;
    local|localhost|loopback|127.0.0.1)
      addr=127.0.0.1
      ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*)
      addr="$want"
      if ! grep -qxF "$addr" <<<"$(local_addresses)"; then
        die "This machine has no address $addr. './mainly.sh bind' lists what it has."
      fi
      ;;
    *)
      die "usage: ./mainly.sh bind [all|tailscale|lan|local|<address>]"
      ;;
  esac

  set_env_var BIND_ADDRESS "$addr"
  BIND_ADDRESS="$addr"

  # APP_ORIGIN follows along while it still names an address — that value was
  # derived, not chosen. A hostname or an https:// URL was set on purpose,
  # usually for a proxy, and moving it would break the cookies. './mainly.sh
  # origin' is how that one changes.
  if [[ "${APP_ORIGIN:-}" =~ ^http://([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|localhost)(:[0-9]+)?/?$ ]]; then
    local primary; primary="$(reachable_urls)"; primary="${primary%%$'\n'*}"
    set_env_var APP_ORIGIN "$primary"
    APP_ORIGIN="$primary"
  fi

  if docker_ready; then apply_to_running || true; fi
  ok "Listening on ${BOLD}${addr}${RESET}"
  say ""
  say "  Reachable at:"
  print_urls
  say ""
}

# ── HTTPS, and the install-as-an-app prompt that hangs off it ────────────────
#
# A browser offers "install this app" only where the page may register a service
# worker, and only a secure origin may: https, or localhost. A LAN or tailnet
# address over plain http is not one, however private that network actually is,
# and no manifest or header changes it. A home-screen install needs a hostname
# and a certificate — that is the whole story.
#
# On a tailnet run by Tailscale itself, `tailscale serve` is the entire answer:
# it terminates TLS with a certificate every device already trusts, reachable
# from the tailnet and nowhere else. A self-hosted control server — Headscale —
# issues no certificates, so that path does not exist there; docs/self-hosting.md
# has the DNS-01 route, which works for any private address.

tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then printf 'tailscale'; return 0; fi
  local app='/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  if [[ -x "$app" ]]; then printf '%s' "$app"; return 0; fi
  return 1
}

# The names this tailnet can get a certificate for. Empty when it issues none,
# which is what a "CertDomains": null in the status means.
tailscale_cert_domains() {
  local ts
  ts="$(tailscale_cli)" || return 0
  "$ts" status --json 2>/dev/null | tr -d ' \n' |
    grep -oE '"CertDomains":\[[^]]*\]' | grep -oE '[A-Za-z0-9._-]+\.[A-Za-z]{2,}' || true
}

cmd_tls() {
  load_env
  local ts serve_status url

  case "${1:-status}" in
    status|'')
      say ""
      if [[ "${APP_ORIGIN:-}" == https://* ]]; then
        ok "HTTPS — ${BOLD}${APP_ORIGIN}${RESET}"
        say "${DIM}  A secure origin, so a browser will offer to install mainly as an app.${RESET}"
      else
        say "  ${BOLD}${APP_ORIGIN:-http://localhost:${PORT:-5274}}${RESET} — plain HTTP."
        say ""
        say "  Everything works over it but one thing: installing mainly as an app."
        say "  Browsers gate that on a secure origin — https, or localhost — so a LAN"
        say "  or tailnet address will not offer it, however private that network is."
      fi
      if ts="$(tailscale_cli)"; then
        serve_status="$("$ts" serve status 2>/dev/null || true)"
        if [[ -n "$serve_status" && "$serve_status" != *"No serve config"* ]]; then
          say ""
          say "  tailscale serve:"
          printf '%s\n' "$serve_status" | sed 's/^/    /'
        elif [[ -n "$(tailscale_cert_domains)" ]]; then
          say ""
          say "${DIM}  This tailnet issues certificates — './mainly.sh tls tailscale' is one step.${RESET}"
        fi
      fi
      say ""
      say "${DIM}  docs/self-hosting.md — HTTPS on a private network${RESET}"
      say ""
      ;;

    tailscale|ts|on)
      ts="$(tailscale_cli)" || die "No 'tailscale' command on this machine."
      [[ -n "$(tailscale_cert_domains)" ]] || die \
"This tailnet issues no HTTPS certificates, so there is nothing for serve to
terminate TLS with.

  On tailscale.com   admin console → DNS → HTTPS Certificates → Enable
  On Headscale       they do not exist; use the route below

docs/self-hosting.md has the one that always works: a hostname you own, a
certificate over DNS-01, and a proxy in front of this. It needs no inbound
port, so a private address is no obstacle."

      step "Putting tailscale serve in front of port ${PORT:-5274}"
      "$ts" serve --bg "http://127.0.0.1:${PORT:-5274}" \
        || die "tailscale serve refused — its output above says why."

      url="$("$ts" serve status 2>/dev/null | grep -oE 'https://[A-Za-z0-9._-]+' | head -n 1 || true)"
      [[ -n "$url" ]] || die "serve took the config but reported no URL. './mainly.sh tls' shows what it has."

      set_env_var APP_ORIGIN "$url"
      APP_ORIGIN="$url"
      if docker_ready; then apply_to_running || true; fi

      say ""
      ok "Serving at ${BOLD}${url}${RESET}"
      say ""
      say "  Tailnet devices only, with a certificate they already trust. Open it on a"
      say "  phone and the browser will offer to install mainly as an app."
      say ""
      say "${DIM}  Plain HTTP on ${BIND_ADDRESS:-127.0.0.1}:${PORT:-5274} keeps working for anything off the tailnet —${RESET}"
      say "${DIM}  the session cookie is marked Secure per request, not per install.${RESET}"
      say ""
      ;;

    off)
      ts="$(tailscale_cli)" || die "No 'tailscale' command on this machine."
      step "Taking the serve config down"
      "$ts" serve reset || warn "tailscale serve reset did not succeed — check 'tailscale serve status'"
      local back
      back="$(reachable_urls)"; back="${back%%$'\n'*}"
      set_env_var APP_ORIGIN "$back"
      APP_ORIGIN="$back"
      if docker_ready; then apply_to_running || true; fi
      ok "Back to ${BOLD}${back}${RESET}"
      say ""
      ;;

    *)
      die "usage: ./mainly.sh tls [tailscale|off]"
      ;;
  esac
}

cmd_origin() {
  load_env
  if [[ -z "${1:-}" ]]; then
    say ""
    say "  APP_ORIGIN=${BOLD}${APP_ORIGIN:-http://localhost:${PORT:-5274}}${RESET}"
    say ""
    say "${DIM}  The URL browsers open. CORS is checked against it, and an https:// origin${RESET}"
    say "${DIM}  is what marks the session cookie Secure — so a proxy that terminates TLS${RESET}"
    say "${DIM}  needs this set, and a plaintext install on a private network must not${RESET}"
    say "${DIM}  claim https:// it does not have.${RESET}"
    say ""
    say "${DIM}  ./mainly.sh origin https://mail.example.com${RESET}"
    say ""
    return 0
  fi

  local url="${1%/}"
  [[ "$url" =~ ^https?://[^/]+$ ]] || die \
"An origin is a scheme, a host and an optional port — nothing after it:
  ./mainly.sh origin https://mail.example.com
  ./mainly.sh origin http://100.64.0.2:5274"

  set_env_var APP_ORIGIN "$url"
  APP_ORIGIN="$url"
  if docker_ready; then apply_to_running || true; fi
  ok "APP_ORIGIN=${BOLD}${url}${RESET}"
  if [[ "$url" == https://* ]]; then
    say "${DIM}  The session cookie is now Secure, so this only works over TLS.${RESET}"
  fi
  say ""
}

cmd_logs() {
  require_docker
  compose logs -f "${1:-app}"
}

cmd_user() {
  [[ -n "${1:-}" ]] || die "usage: ./mainly.sh user <email>   (or PASSWORD=… ./mainly.sh user <email>)"
  require_docker
  step "Creating $1"
  # The password is generated and printed, or taken from $PASSWORD. Never from
  # argv, which is visible to every process on the host through `ps`.
  #
  # The env var is forwarded only when it is actually set. Passing `-e PASSWORD=`
  # would define it as the empty string, and the CLI's `??` treats "" as a value
  # — which would quietly create an account with a blank password.
  if [[ -n "${PASSWORD:-}" ]]; then
    compose exec -e PASSWORD app node dist/cli/create-user.js "$1"
  else
    compose exec app node dist/cli/create-user.js "$1"
  fi
  load_env
  say ""
  ok "Sign in at $(app_url)"
}

cmd_token() {
  require_docker
  compose exec app node dist/cli/token.js "$@"
}

# Connecting a domain hands this install an SSH key to a mail server, so it is
# done from a shell here rather than through the API. Same bar as `token`.
cmd_domain() {
  require_docker
  compose exec -T app node dist/cli/domain.js "$@"
}

cmd_update() {
  require_docker
  load_env
  step "Pulling the current image"
  compose pull app
  step "Restarting"
  # Migrations run themselves: the server awaits them before it listens.
  compose up -d app
  ok "Updated. './mainly.sh logs' to watch it come back."
}

cmd_backup() {
  require_docker
  load_env
  local dir="${1:-./backups}"
  mkdir -p "$dir"
  # A dump holds account rows, preferences and drafts. Under the usual umask it
  # would land 644 — readable by every account on the host — so the directory and
  # the file are narrowed before anything is written into them.
  chmod 700 "$dir"
  local file="$dir/mainly-$(date -u +%Y%m%d-%H%M%S).sql.gz"
  step "Dumping the database to $file"
  ( umask 077; compose exec -T db pg_dump -U mainly mainly | gzip > "$file" )
  chmod 600 "$file"
  ok "Wrote $file ($(du -h "$file" | cut -f1))"
  say ""
  say "${DIM}  Message metadata is a cache — your mail server still holds the mail.${RESET}"
  say "${DIM}  What this protects is accounts, preferences, saved views, labels and drafts.${RESET}"
  say "${DIM}  Back up SECRET_KEY from $ENV_FILE separately; it is not in this dump.${RESET}"
}

cmd_restore() {
  [[ -n "${1:-}" ]] || die "usage: ./mainly.sh restore <file.sql.gz>"
  [[ -f "$1" ]] || die "No such file: $1"
  require_docker
  warn "This REPLACES the current database with $1."
  read -r -p "Type 'restore' to continue: " reply
  [[ "$reply" == "restore" ]] || { say "Cancelled."; exit 0; }
  step "Restoring"
  gunzip -c "$1" | compose exec -T db psql -U mainly -d mainly
  compose restart app
  ok "Restored."
}

cmd_reset() {
  require_docker
  warn "This DELETES the database volume. Accounts, preferences and saved views go with it."
  warn "Your mail is untouched — it lives on your mail server."
  read -r -p "Type 'delete' to continue: " reply
  [[ "$reply" == "delete" ]] || { say "Cancelled."; exit 0; }
  compose down -v --remove-orphans
  ok "Gone. './mainly.sh start' begins again from empty."
}

usage() {
  cat <<EOF
${BOLD}mainly${RESET} — self-hosted multi-domain mail client

  ${BOLD}./mainly.sh start${RESET}              Start everything. Writes .env on the first run.
  ${BOLD}./mainly.sh user <email>${RESET}       Create a login. Prints a generated password.
                                 Set your own with PASSWORD=… in front of it.
  ./mainly.sh stop               Stop. Data is kept.
  ./mainly.sh restart
  ./mainly.sh status             Container state, health check, and its URLs.
  ${BOLD}./mainly.sh bind [what]${RESET}        Where it listens: all, tailscale, lan, local,
                                 or an address. No argument shows the current
                                 one and every URL that reaches it.
  ./mainly.sh origin <url>       The URL browsers open. Set it when a reverse
                                 proxy fronts this.
  ./mainly.sh tls [tailscale]    HTTPS, which is what installing mainly as an
                                 app needs. No argument explains where you are.
  ./mainly.sh logs [app|db]      Follow the log.
  ./mainly.sh update             Pull the current image and restart.
  ./mainly.sh backup [dir]       pg_dump to ./backups by default.
  ./mainly.sh restore <file>     Replace the database from a backup. Asks first.
  ./mainly.sh token <args>       Mint or revoke an API token for an agent.
  ./mainly.sh domain <args>      Optional: let this install create and remove
                                 addresses on your mail server. Off until you
                                 connect a domain and grant something.
  ./mainly.sh reset              Delete the database volume. Asks twice.

  ${BOLD}./mainly.sh start --build${RESET}      Build from this checkout instead of pulling.

Configuration lives in .env. Everything it accepts is in .env.example.
EOF
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  bind)    shift; cmd_bind "$@" ;;
  origin)  shift; cmd_origin "$@" ;;
  tls)     shift; cmd_tls "$@" ;;
  logs)    shift; cmd_logs "$@" ;;
  user)    shift; cmd_user "$@" ;;
  token)   shift; cmd_token "$@" ;;
  domain)  shift; cmd_domain "$@" ;;
  update)  cmd_update ;;
  backup)  shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  reset)   cmd_reset ;;
  ''|help|-h|--help) usage ;;
  *) die "Unknown command: $1  (run './mainly.sh' for the list)" ;;
esac
