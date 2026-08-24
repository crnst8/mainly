#!/usr/bin/env bash
# publish.sh — review, commit and release work made directly in this checkout.
#
#   ./publish.sh          the whole thing, one step at a time
#
# Extras, rarely needed:
#   ./publish.sh status   show the branch, version, tag and working-tree state
#   ./publish.sh commit   review and commit, but do not release
#   ./publish.sh release  cut a release from the current clean main branch
#   ./publish.sh demo     skip everything, just republish the demo site
#   ./publish.sh --dry-run
#                        review the pending commit without writing anything
#
# Cloudflare credentials for the demo may be read from .env.cloudflare, which
# is ignored by git. CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in the
# environment win over it, and an interactive `wrangler login` covers neither.
#
# This workflow assumes the work already happened in this public checkout. It
# needs no copy, sync base or second commit: changes are reviewed here,
# committed here, and released from here.

set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD

REPO_NAME="$(basename "$ROOT")"
DEMO_URL="https://mainly.crnst8.com/demo/"
DRY_RUN=0

for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=1
done

TMP="$(mktemp -d -t publish.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# ── output ──────────────────────────────────────────────────────────────────

say()  { printf "%s\n" "$*"; }
info() { printf "   %s\n" "$*"; }
ok()   { printf "   ✓ %s\n" "$*"; }
warn() { printf "   ! %s\n" "$*" >&2; }
err()  { printf "   ✗ %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }

TOTAL_STEPS=4
step() {
  printf "\n\n\033[1mStep %s of %s — %s\033[0m\n" "$1" "$TOTAL_STEPS" "$2"
  printf "%s\n" "──────────────────────────────────────────────────────────────"
}

heading() {
  printf "\n\033[1m%s\033[0m\n" "$*"
  printf "%s\n" "──────────────────────────────────────────────────────────────"
}

usage() {
  awk 'NR == 1 { next } /^# ?/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
require_tty() { [[ -r /dev/tty && -w /dev/tty ]] || die "this is interactive and needs a terminal"; }

# Yes/no. Default is what pressing Enter chooses.
yes_no() {
  local prompt="$1" default="${2:-y}" reply hint="[Y/n]"
  [[ "$default" == "n" ]] && hint="[y/N]"
  printf "\n   %s %s " "$prompt" "$hint" >/dev/tty
  read -r reply </dev/tty || return 1
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

ask() {
  local prompt="$1" default="${2:-}" reply
  if [[ -n "$default" ]]; then
    printf "\n   %s [%s] " "$prompt" "$default" >/dev/tty
    read -r reply </dev/tty || return 1
    reply="${reply:-$default}"
  else
    printf "\n   %s " "$prompt" >/dev/tty
    read -r reply </dev/tty || return 1
  fi
  printf "%s" "$reply"
}

editor_cmd() { printf "%s" "${EDITOR:-$(command -v nano || command -v vi)}"; }
pager() { if [[ -t 1 ]]; then ${PAGER:-less -R}; else cat; fi; }

# ── setup ───────────────────────────────────────────────────────────────────

preflight() {
  require_cmd git
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository: $ROOT"
  [[ -x "$ROOT/scripts/release.sh" ]] || die "$ROOT/scripts/release.sh is missing"
}

# The public history must never carry a personal address. Check the identity
# git would actually use in this checkout before making either kind of commit.
assert_public_identity() {
  local ident email
  ident="$(git var GIT_AUTHOR_IDENT)"
  email="$(printf "%s" "$ident" | sed -n 's/.*<\(.*\)>.*/\1/p')"
  [[ "$email" == "dev@crnst8.com" ]] && return 0

  err "$REPO_NAME would commit as: $ident"
  info "the public repo must commit as crnst8 <dev@crnst8.com>"
  if yes_no "Fix that now?" "y"; then
    git config user.name "crnst8"
    git config user.email "dev@crnst8.com"
    ok "identity set"
  else
    die "not committing to a public repo as $email"
  fi
}

pick_commit_type() {
  {
    say
    say "   What kind of change is this?"
    say "     1) feat    a new capability"
    say "     2) fix     something was broken"
    say "     3) chore   housekeeping, deps, config"
    say "     4) docs    documentation only"
    say "     5) refactor"
    say "     6) style   formatting, naming, no behaviour change"
  } >/dev/tty
  local pick
  pick="$(ask "Pick 1-6" "1")"
  case "$pick" in
    1) printf "feat" ;;  2) printf "fix" ;;      3) printf "chore" ;;
    4) printf "docs" ;;  5) printf "refactor" ;; 6) printf "style" ;;
    *) printf "%s" "$pick" ;;
  esac
}

# ── public-install invariants ───────────────────────────────────────────────
#
# These behaviours let a self-hosted install work over plain HTTP on a LAN or
# tailnet. Direct work can remove them accidentally, so the tripwires run before
# both commit and release.

FORK_INVARIANTS=(
  "backend/src/modules/auth/index.ts|secure: req.protocol === 'https'|the session cookie goes back to being Secure for every request or for none. Browsers discard a Secure cookie that arrives over plain HTTP, so a private-network install signs in and is signed straight back out."
  "backend/src/server.ts|upgradeInsecureRequests: null|helmet's default CSP adds upgrade-insecure-requests, which rewrites every stylesheet, script and font on a plaintext install to https:// and makes them fail."
)

check_fork_invariants() {
  local entry file pat why lost=0
  for entry in "${FORK_INVARIANTS[@]}"; do
    IFS='|' read -r file pat why <<<"$entry"
    if [[ ! -f "$ROOT/$file" ]]; then
      err "$file is gone from $REPO_NAME"
      lost=1
      continue
    fi
    grep -qF -- "$pat" "$ROOT/$file" && continue
    err "$file no longer contains:  $pat"
    info "$why"
    say
    lost=1
  done
  return "$lost"
}

# ── step 1: review ──────────────────────────────────────────────────────────

step_review() {
  step 1 "Review the work"

  if [[ -z "$(git status --porcelain)" ]]; then
    ok "the working tree is clean — nothing to commit"
    return 1
  fi

  info "This is everything the commit will contain. Nothing is pushed yet."
  say
  git -c color.status=always status --short | sed 's/^/   /'
  say
  git -c color.ui=always diff --stat HEAD | sed 's/^/   /'

  while yes_no "See the full diff before deciding?" "n"; do
    git -c color.ui=always diff HEAD | pager
    break
  done

  if ! check_fork_invariants; then
    heading "This change removes something the public install needs"
    info "Put the lines above back, or explicitly choose to carry on."
    say
    yes_no "Commit without them anyway?" "n" || exit 1
  fi

  yes_no "Happy with it?" "y" || {
    say
    info "Nothing was committed. The changes are still in $ROOT."
    exit 0
  }
}

# ── step 2: commit ──────────────────────────────────────────────────────────

step_commit() {
  step 2 "Commit in $REPO_NAME"

  if [[ "$DRY_RUN" == "1" ]]; then
    warn "dry run — nothing was committed"
    return 0
  fi

  assert_public_identity

  local type msg
  type="$(pick_commit_type)"
  msg="$(ask "One line describing it")"
  [[ -n "$msg" ]] || die "need a message"

  git add -A
  git commit -q -m "${type}: ${msg}"
  ok "committed here: ${type}: ${msg}"
  info "Still local. Nothing is on GitHub until the release step."
}

# ── step 3: release ─────────────────────────────────────────────────────────

current_version() {
  node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/frontend/package.json"
}

valid_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }

bump_version() {
  local cur="${1%%-*}" kind="$2" major minor patch
  IFS='.' read -r major minor patch <<<"$cur"
  case "$kind" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
  esac
  printf "%d.%d.%d" "$major" "$minor" "$patch"
}

# Notes start as commit subjects since the last tag. Usually most of the way
# there, and always faster than opening a blank buffer.
compose_notes() {
  local version="$1" last_tag
  last_tag="$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
  {
    if [[ -n "$last_tag" ]]; then
      git log --format='- %s' "$last_tag..HEAD" | grep -v '^- release ' || true
    else
      git log --format='- %s' -20
    fi
    printf "\n"
    printf "# Release notes for %s.\n" "$version"
    printf "# Above are the commits since the last release — edit them into\n"
    printf "# something a user would want to read, then save and close.\n"
    printf "# Lines starting with # are dropped.\n"
  } > "$TMP/notes"

  "$(editor_cmd)" "$TMP/notes" </dev/tty >/dev/tty 2>&1 || true
  grep -v '^[[:space:]]*#' "$TMP/notes" | sed -e 's/[[:space:]]*$//' \
    | awk 'NF{p=1} p' \
    | awk '{ l[NR]=$0 } END { last=NR; while (last>0 && l[last]=="") last--; for (i=1;i<=last;i++) print l[i] }'
}

prepend_changelog() {
  local version="$1" notes="$2" file="$ROOT/CHANGELOG.md"
  {
    printf "## %s — %s\n\n%s\n\n" "$version" "$(date +%Y-%m-%d)" "$notes"
    [[ -f "$file" ]] && cat "$file"
  } > "$TMP/changelog"
  mv "$TMP/changelog" "$file"
}

watch_release_run() {
  local tag="$1" run_id="" tries=0
  info "waiting for the build to start"
  while (( tries < 45 )); do
    run_id="$(gh -R crnst8/mainly run list --workflow=release.yml --limit=30 \
      --json databaseId,headBranch,event \
      --jq ".[] | select((.event==\"push\") and (.headBranch==\"$tag\")) | .databaseId" \
      2>/dev/null | head -n 1 || true)"
    [[ -n "$run_id" ]] && break
    tries=$((tries + 1)); sleep 2
  done
  [[ -n "$run_id" ]] || { warn "no build found for $tag yet"; return 1; }
  gh -R crnst8/mainly run watch "$run_id" --exit-status --interval 5
}

step_release() {
  step 3 "Release"
  require_cmd node
  [[ "$DRY_RUN" == "0" ]] || die "release cannot run with --dry-run"
  [[ -x "$ROOT/scripts/release.sh" ]] || die "$ROOT/scripts/release.sh is missing"

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "main" ]] || die "$REPO_NAME is on '$branch' — releases come off main"
  [[ -z "$(git status --porcelain)" ]] || {
    git -c color.status=always status --short | sed 's/^/   /'
    die "$REPO_NAME has uncommitted changes"
  }
  if ! check_fork_invariants; then
    heading "This release is missing a public-install safeguard"
    info "The release can continue only with an explicit override."
    yes_no "Release without it anyway?" "n" || return 0
  fi
  assert_public_identity

  git fetch --tags --quiet origin 2>/dev/null || warn "could not reach origin for tags"

  local cur unreleased
  cur="$(current_version)"
  unreleased="$(git log --oneline "v$cur..HEAD" 2>/dev/null | wc -l | tr -d ' ')"
  info "$REPO_NAME is at v$cur, with $unreleased commit(s) since."
  if [[ "$unreleased" == "0" ]]; then
    yes_no "Nothing new since v$cur. Release anyway?" "n" || return 0
  fi

  say
  say "   Pick the new version number:"
  say "     $(bump_version "$cur" patch)   a fix, nothing new"
  say "     $(bump_version "$cur" minor)   new features, nothing broken"
  say "     $(bump_version "$cur" major)   something people relied on changed"
  local version
  while true; do
    version="$(ask "New version" "$(bump_version "$cur" patch)")"
    valid_semver "$version" || { warn "needs to look like 1.2.0"; continue; }
    git rev-parse --verify --quiet "v$version" >/dev/null \
      && { warn "v$version already exists"; continue; }
    break
  done

  heading "Release notes"
  info "Opening $(basename "$(editor_cmd)") with the commits since v$cur."
  info "These become CHANGELOG.md and the GitHub release page."
  yes_no "Ready?" "y" || return 0
  local notes
  notes="$(compose_notes "$version")"
  if [[ -z "${notes//[[:space:]]/}" ]]; then
    notes="- Release $version."
    warn "no notes written — using a placeholder"
  fi

  local write_changelog=1
  if [[ ! -f "$ROOT/CHANGELOG.md" ]]; then
    yes_no "There is no CHANGELOG.md yet. Start one?" "y" || write_changelog=0
  fi

  heading "About to do this"
  say "   version    $cur → $version"
  say "   tag        v$version"
  say "   changelog  $([[ $write_changelog -eq 1 ]] && echo "CHANGELOG.md" || echo "skipped")"
  say "   then       the full check suite, version bump, tag, and push to GitHub"
  say "   result     ghcr.io/crnst8/mainly:$version"
  say
  say "   notes:"
  while IFS= read -r line; do say "     $line"; done <<<"$notes"
  say
  warn "this is the point of no return — it pushes"
  yes_no "Go?" "y" || { info "stopped. Nothing was pushed."; return 0; }

  if [[ $write_changelog -eq 1 ]]; then
    prepend_changelog "$version" "$notes"
    git add CHANGELOG.md
    git commit -q -m "docs: release notes for $version"
    ok "CHANGELOG.md updated"
  fi

  heading "Running the check suite and pushing"
  info "this takes a few minutes"
  "$ROOT/scripts/release.sh" "$version"

  printf "%s" "$notes" > "$TMP/gh-notes"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if yes_no "Publish the GitHub release page for v$version?" "y"; then
      gh -R crnst8/mainly release create "v$version" \
        --title "v$version" --notes-file "$TMP/gh-notes" >/dev/null \
        && ok "release page published"
    fi
    heading "Watching the image build"
    if watch_release_run "v$version"; then
      ok "build green"
    else
      warn "check https://github.com/crnst8/mainly/actions"
    fi
  else
    warn "gh is not set up — skipping the release page and the build watch"
    info "https://github.com/crnst8/mainly/actions"
  fi

  heading "Done"
  ok "$version is out"
  info "self-hosted installs pick it up with:  ./mainly.sh update"

  step_demo "$version"
}

# ── step 4: demo ────────────────────────────────────────────────────────────

cloudflare_env() {
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && return 0

  local file="$ROOT/.env.cloudflare" account token
  [[ -f "$file" ]] || return 1
  account="$(sed -n 's/^ACCOUNT_ID=//p' "$file" | head -n 1 | tr -d '"'"'"'\r' | xargs)"
  token="$(sed -n 's/^API_TOKEN=//p' "$file" | head -n 1 | tr -d '"'"'"'\r' | xargs)"
  [[ -n "$account" && -n "$token" ]] || return 1

  export CLOUDFLARE_ACCOUNT_ID="$account" CLOUDFLARE_API_TOKEN="$token"
}

step_demo() {
  local version="${1:-}"
  step 4 "Demo"
  require_cmd node

  [[ -x "$ROOT/scripts/deploy-site.sh" ]] || {
    warn "$REPO_NAME has no scripts/deploy-site.sh — nothing to deploy"
    return 0
  }

  info "the landing page and demo will be rebuilt from this checkout and pushed"
  info "to Cloudflare Pages:  $DEMO_URL"
  if [[ -n "$version" ]]; then
    info "this is what puts v$version in front of a visitor"
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    git -c color.status=always status --short | sed 's/^/   /'
    warn "$REPO_NAME has uncommitted changes — the demo would carry them"
    yes_no "Deploy anyway?" "n" || { info "stopped. Nothing was deployed."; return 0; }
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    info "dry run — not deploying"
    return 0
  fi

  yes_no "Republish the demo?" "y" || { info "skipped. Later:  ./publish.sh demo"; return 0; }

  if ! cloudflare_env; then
    warn "no Cloudflare credentials found (ACCOUNT_ID / API_TOKEN in .env.cloudflare)"
    info "wrangler will fall back to an interactive login, if there is one"
  fi

  heading "Building and deploying"
  info "this takes a few minutes"
  "$ROOT/scripts/deploy-site.sh" || { err "the deploy failed"; return 1; }

  ok "demo republished"
  info "$DEMO_URL"
}

# ── status and commands ─────────────────────────────────────────────────────

cmd_status() {
  preflight
  heading "Where things stand"
  say "   repo          $ROOT"
  say "   branch        $(git rev-parse --abbrev-ref HEAD)"
  say "   version       $(current_version 2>/dev/null || echo '?')"
  say "   last tag      $(git tag --list 'v*' --sort=-v:refname | head -n 1 || echo '(none)')"
  say "   uncommitted   $(git status --porcelain | wc -l | tr -d ' ') file(s)"
  say
  if check_fork_invariants >/dev/null 2>&1; then
    say "   invariants    ✓ ${#FORK_INVARIANTS[@]}/${#FORK_INVARIANTS[@]} present"
  else
    say "   invariants    ✗ something the public install needs is missing"
    check_fork_invariants || true
  fi
  say
  say "   Run ./publish.sh to review, commit and release."
}

cmd_commit() {
  require_tty
  preflight
  if step_review; then
    step_commit
  fi
}

cmd_all() {
  require_tty
  preflight

  printf "\n\033[1mpublish\033[0m   %s  →  %s\n" "$REPO_NAME" "github.com/crnst8/mainly"
  say
  say "   1. review the work in this checkout"
  say "   2. commit it here"
  say "   3. cut a release"
  say "   4. republish the demo site"
  say
  say "   Every step asks first. Nothing reaches GitHub before step 3."
  yes_no "Start?" "y" || { say; info "nothing done"; exit 0; }

  if ! step_review; then
    say
    info "Nothing new to commit."
    if [[ "$DRY_RUN" == "0" ]] && yes_no "Cut a release from what is already here?" "n"; then
      step_release
    fi
    return 0
  fi

  step_commit
  if [[ "$DRY_RUN" == "1" ]]; then
    info "dry run complete"
    return 0
  fi

  say
  if yes_no "Cut a release now?" "y"; then
    step_release
  else
    step 3 "Release"
    info "Skipped. Your commit is local and has not been pushed."
    info "When you are ready:  ./publish.sh release"
    info "The demo goes with it, or on its own with:  ./publish.sh demo"
  fi
}

case "${1:-all}" in
  all|""|--dry-run) cmd_all ;;
  status)            cmd_status ;;
  commit)            cmd_commit ;;
  release)           require_tty; preflight; step_release ;;
  demo)              require_tty; preflight; step_demo ;;
  help|-h|--help)    usage ;;
  *)                 err "no such command: $1"; say; usage; exit 1 ;;
esac
