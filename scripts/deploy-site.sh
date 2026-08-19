#!/usr/bin/env bash
#
# Publish the landing page and the demo to Cloudflare Pages.
#
#   ./scripts/deploy-site.sh              build, then deploy to production
#   ./scripts/deploy-site.sh --preview    deploy to a preview URL instead
#   ./scripts/deploy-site.sh --skip-build use whatever is already in site/dist
#
# Credentials come from the environment, in wrangler's own order: an interactive
# `wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID. Nothing is
# read from a file in this repository and nothing is written to one.
#
# This deploys the public site only. It has nothing to do with self-hosting the
# application — see docs/self-hosting.md for that.

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PAGES_PROJECT:-mainly}
BRANCH=main
BUILD=1

for arg in "$@"; do
  case "$arg" in
    --preview) BRANCH=preview ;;
    --skip-build) BUILD=0 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

wrangler() { npx --yes wrangler@4 "$@"; }

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (wrangler runs on it)" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && ! wrangler whoami >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Not authenticated with Cloudflare.

  Interactive:  npx wrangler login
  Or export:    CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…

The token needs the "Cloudflare Pages: Edit" permission.
EOF
  exit 1
fi

if [[ "$BUILD" == 1 ]]; then
  ./scripts/build-site.sh
fi

[[ -f site/dist/index.html ]] || {
  echo "site/dist/index.html is missing — run without --skip-build" >&2
  exit 1
}

echo
echo "→ Deploying site/dist to Pages project '$PROJECT' (branch: $BRANCH)"
wrangler pages deploy site/dist \
  --project-name "$PROJECT" \
  --branch "$BRANCH" \
  --commit-dirty=true
