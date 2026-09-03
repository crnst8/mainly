#!/usr/bin/env bash
#
# Local development. Postgres in Docker, the API and the web UI on the host so
# both reload on save.
#
#   ./dev.sh start            database + backend + frontend
#   ./dev.sh check            typecheck, audit, contract, url, search, static, auth, smoke, query
#
# To run without Docker or a backend at all — the whole UI against seeded
# in-memory data:
#
#   ./dev.sh mock
#
# `./mainly.sh` is the other script here; that one runs the built product.
# This one is for changing it.

set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD

ENV_FILE=.env
PID_DIR=.dev
mkdir -p "$PID_DIR"

WEB_PORT=5273
API_PORT=5274
# `check` runs its own API here rather than on API_PORT, so a running dev stack
# neither blocks a check run nor gets asserted against by mistake.
CHECK_PORT=${CHECK_PORT:-5284}
DB_PORT=${DB_PORT:-54329}

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }

random_b64() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"
  else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi
}

# ── Environment ──────────────────────────────────────────────────────────────
# One .env for both scripts. `mainly.sh` reads the same file, so a checkout that
# has been started either way already has its secrets.

if [[ ! -f "$ENV_FILE" ]]; then
  say "creating $ENV_FILE with generated secrets"
  cat > "$ENV_FILE" <<EOF
APP_ORIGIN=http://localhost:${WEB_PORT}
PORT=${API_PORT}
BIND_ADDRESS=127.0.0.1
SECRET_KEY=$(random_b64 32)
SESSION_SECRET=$(random_b64 32)
POSTGRES_PASSWORD=$(random_b64 24 | tr -d '/+=')
ALLOW_PRIVATE_IMAP_HOSTS=true
MAIL_HOST_OVERRIDE=
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# The API runs on the host in development, so it reaches Postgres through the
# published port rather than the compose network name.
export DATABASE_URL="postgres://mainly:${POSTGRES_PASSWORD}@localhost:${DB_PORT}/mainly"
export HOST=127.0.0.1
export PORT=$API_PORT
export APP_ORIGIN="http://localhost:${WEB_PORT}"
export ROLE=${ROLE:-all}

# ── Process control ──────────────────────────────────────────────────────────

db_up() {
  need docker
  docker compose up -d db >/dev/null
  printf 'waiting for postgres'
  for _ in $(seq 1 60); do
    if docker compose exec -T db pg_isready -U mainly -d mainly >/dev/null 2>&1; then
      echo " ready"; return 0
    fi
    printf '.'; sleep 1
  done
  echo; die "postgres did not become ready. 'docker compose logs db' has the reason."
}

# Kill a process and everything it spawned, children first.
#
# This matters more than it looks. `npm run dev` spawns vite, and `node --watch`
# spawns the actual server as a child. Killing only the recorded pid orphans the
# child, which keeps the port bound — so the next `start` finds 5273 taken and
# the browser goes on talking to a process from a previous session with a
# previous environment. That is exactly how an afternoon gets spent looking at
# mock data while believing it is the real backend.
kill_tree() {
  local pid=$1 kid
  for kid in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$kid"; done
  kill "$pid" 2>/dev/null || true
}

stop_pid() {
  local file="$PID_DIR/$1.pid"
  [[ -f "$file" ]] || return 0
  local pid; pid=$(cat "$file")
  if kill -0 "$pid" 2>/dev/null; then kill_tree "$pid"; fi
  rm -f "$file"
}

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true
  fi
}

# Backstop for anything the pid files lost track of — a crashed script, a
# manually started server, a stale process from before this file existed.
free_port() {
  local pid
  for pid in $(port_pids "$1"); do
    say "  freeing port $1 (pid $pid)"
    kill_tree "$pid"
  done
}

assert_port_free() {
  if [[ -n "$(port_pids "$1")" ]]; then
    die "port $1 is already in use ($2). Run ./dev.sh stop first."
  fi
}

install_deps() {
  need node
  for w in frontend backend mcp; do
    [[ -d "$w/node_modules" ]] || { say "installing $w dependencies"; (cd "$w" && npm install --no-audit --no-fund); }
  done
}

start() {
  install_deps
  assert_port_free $WEB_PORT web
  assert_port_free $API_PORT api

  local mode=${VITE_API_MODE:-http}

  if [[ "$mode" == "http" ]]; then
    db_up
    (cd backend && npm run migrate >/dev/null)
  fi

  # Written to a file rather than passed as an env prefix. Vite reads .env.local
  # itself, which means the adapter choice survives however vite ends up being
  # started — including a manual `npm run dev` in the frontend directory. An env
  # prefix only reaches the process this script spawns, and being wrong about
  # which adapter is live is a very expensive kind of wrong.
  printf 'VITE_API_MODE=%s\n' "$mode" > frontend/.env.local

  if [[ "$mode" == "http" ]]; then
    # Detached: stdin from /dev/null, both streams to a file, so the children
    # never hold this script's terminal open.
    (
      cd backend
      nohup node --watch --experimental-strip-types src/server.ts \
        < /dev/null > "$ROOT/$PID_DIR/api.log" 2>&1 &
      echo $! > "$ROOT/$PID_DIR/api.pid"
    )
  fi

  (
    cd frontend
    nohup npm run dev < /dev/null > "$ROOT/$PID_DIR/web.log" 2>&1 &
    echo $! > "$ROOT/$PID_DIR/web.pid"
  )

  sleep 3
  echo
  say "  web   http://localhost:$WEB_PORT    (VITE_API_MODE=$mode)"
  if [[ "$mode" == "http" ]]; then
    say "  api   http://localhost:$API_PORT/api/health"
    say "  db    localhost:$DB_PORT"
    echo
    say "  no user yet?  ./dev.sh user you@example.com"
    say "  no backend?   ./dev.sh mock"
  else
    echo
    say "  Mock adapter — no backend, no database. Seeded in-memory data."
  fi
  echo
}

case "${1:-start}" in
  start) start ;;

  mock) VITE_API_MODE=mock start ;;

  stop)
    stop_pid api
    stop_pid web
    free_port $WEB_PORT
    free_port $API_PORT
    docker compose stop db >/dev/null 2>&1 || true
    say "stopped"
    ;;

  restart) "$0" stop && "$0" "${2:-start}" ;;

  rebuild)
    read -r -p "This DROPS the local database. Continue? [y/N] " reply
    [[ "$reply" == "y" ]] || { say "cancelled"; exit 0; }
    "$0" stop
    docker compose down -v >/dev/null
    "$0" start
    ;;

  migrate) db_up; (cd backend && npm run migrate) ;;

  user)
    [[ -n "${2:-}" ]] || die "usage: ./dev.sh user <email>"
    (cd backend && node --experimental-strip-types src/cli/create-user.ts "$2")
    ;;

  seed) db_up; (cd backend && node --experimental-strip-types src/cli/seed.ts) ;;

  # API tokens for agents. Minting needs shell on the host on purpose — a
  # credential that grants API access must not be mintable through the API.
  token) db_up; shift; (cd backend && node --experimental-strip-types src/cli/token.ts "$@") ;;

# Domain control. Same reasoning as `token`: it installs a credential.
domain) db_up; shift; (cd backend && node --experimental-strip-types src/cli/domain.ts "$@") ;;

  check)
    install_deps
    (cd frontend && npx tsc -b --noEmit && node scripts/url-check.mjs && node scripts/search-check.mjs)
    (cd backend && npx tsc -b --noEmit && npm test && node scripts/check-contract.mjs \
      && node --experimental-strip-types scripts/static-check.mjs \
      && node --experimental-strip-types scripts/auth-check.mjs)
    # The MCP server is a third workspace and typechecks with the rest. It has
    # no runtime checks of its own: everything it does is an HTTP call the smoke
    # and query suites already exercise from the other side.
    (cd mcp && npx tsc -b --noEmit)
    # Known advisories across all three lockfiles. Needs the registry, so it is
    # skipped when offline rather than failing a check run that is otherwise
    # fine: CI is the copy of this gate that always has a network.
    if curl -fsS --max-time 5 https://registry.npmjs.org/ >/dev/null 2>&1; then
      node scripts/audit-check.mjs
    else
      echo "audit-check: skipped, no registry reachable"
    fi
    db_up
    (cd backend && npm run migrate >/dev/null)
    # Reseed first. The query checks assert absolute counts, and the smoke run
    # before them mutates flags and moves messages — running twice without a
    # reset fails on data, not on code.
    (cd backend && node --experimental-strip-types src/cli/seed.ts)

    # The integration suites talk HTTP, so they need an API — and this starts
    # its own rather than using whatever happens to hold the dev port.
    #
    # Reusing a running server is how a check run silently grades the wrong
    # thing: a dev API left up from another checkout answers on 5274 against
    # *its* database, so the suite seeds one database and asserts against
    # another. Every failure it reports is then about data, not code, and every
    # pass is meaningless. A dedicated port and a server this script owns makes
    # that impossible.
    assert_port_free $CHECK_PORT 'check api'
    (
      cd backend
      PORT=$CHECK_PORT HOST=127.0.0.1 \
        nohup node --experimental-strip-types src/server.ts \
        < /dev/null > "$ROOT/$PID_DIR/check-api.log" 2>&1 &
      echo $! > "$ROOT/$PID_DIR/check-api.pid"
    )
    # Kill it however this exits — a failing suite must not leave a server behind.
    trap 'stop_pid check-api' EXIT

    printf 'waiting for the check api'
    for _ in $(seq 1 45); do
      curl -fsS "http://127.0.0.1:$CHECK_PORT/api/health" >/dev/null 2>&1 && break
      printf '.'; sleep 1
    done
    echo
    curl -fsS "http://127.0.0.1:$CHECK_PORT/api/health" >/dev/null 2>&1 || {
      cat "$PID_DIR/check-api.log" >&2
      die "the check api never answered on $CHECK_PORT"
    }

    export SMOKE_BASE="http://127.0.0.1:$CHECK_PORT/api"
    (cd backend && node scripts/smoke.mjs && node scripts/query-check.mjs && node scripts/index-check.mjs)
    ;;

  logs)
    case "${2:-api}" in
      db) docker compose logs -f db ;;
      web) tail -f "$PID_DIR/web.log" ;;
      *) tail -f "$PID_DIR/api.log" ;;
    esac
    ;;

  *)
    cat <<EOF
usage: ./dev.sh <command>

  start              database + backend + frontend
  mock               frontend only, seeded in-memory data, no backend
  stop | restart
  rebuild            drop the local database and re-migrate
  migrate
  user <email>       create a login
  seed               (re)create the fixture ./dev.sh check asserts against
  token <args>       mint or revoke an agent token
  domain <args>      connect a mail server domain, and grant what it may do
  check              typecheck + contract + url + search + smoke + query
  logs [api|db|web]
EOF
    exit 1
    ;;
esac
