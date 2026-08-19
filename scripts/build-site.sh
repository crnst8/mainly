#!/usr/bin/env bash
#
# Build the public site: the landing page at /, and a live demo of the app at
# /demo.
#
#   ./scripts/build-site.sh          → site/dist
#
# The demo is the real frontend built against the mock adapter, so it is the
# actual interface running on invented data rather than a set of screenshots.
# Every message lives in the visitor's tab; there is no API, no database and no
# state shared between visitors. Reloading resets it.
#
# This is not part of self-hosting. Nobody running their own copy needs it.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=site/dist

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

echo "→ Cleaning $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "→ Copying the landing page"
# Everything in site/ except the build output and the working files.
tar -cf - -C site \
  --exclude dist \
  --exclude 'sc-reference.png' \
  . | tar -xf - -C "$OUT"

echo "→ Building the demo"
(
  cd frontend
  [[ -d node_modules ]] || npm ci --no-audit --no-fund
  # VITE_BASE   the demo is mounted at /demo, beside the landing page
  # VITE_API_MODE=mock   no backend exists; the adapter is the seeded fixture
  # VITE_DEMO   renders the "none of this is real" badge
  VITE_BASE=/demo/ VITE_API_MODE=mock VITE_DEMO=1 npm run build
)
mkdir -p "$OUT/demo"
cp -R frontend/dist/. "$OUT/demo/"

echo "→ Writing Cloudflare Pages headers and redirects"

# The demo is a single-page app: every client route has to resolve to its
# index.html, or a shared link like /demo/d/example.com/inbox is a 404.
cat > "$OUT/_redirects" <<'EOF'
/demo     /demo/            301
/demo/*   /demo/index.html  200
EOF

cat > "$OUT/_headers" <<'EOF'
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=(), interest-cohort=()

# Vite hashes these filenames, so a given URL's bytes never change.
/demo/assets/*
  Cache-Control: public, max-age=31536000, immutable

# These do change on every deploy, and a stale one is an invisible release.
/demo/index.html
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
EOF

echo
echo "✓ Built $OUT"
du -sh "$OUT" | sed 's/^/  /'
echo
echo "  Preview it:  npx wrangler pages dev $OUT"
echo "  Ship it:     ./scripts/deploy-site.sh"
