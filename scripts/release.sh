#!/usr/bin/env bash
#
# Cut a release.
#
#   ./scripts/release.sh 1.2.0
#
# What it does, in order, stopping at the first thing that fails:
#
#   1. refuses unless the working tree is clean and on main
#   2. runs the full check suite
#   3. writes the version into the three package.json files
#   4. commits, tags v<version>, pushes both
#
# Pushing the tag is what publishes the image: .github/workflows/release.yml
# builds ghcr.io/crnst8/mainly for amd64 and arm64 and tags it :<version>,
# :<major>.<minor> and :latest.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${1:-}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
step() { printf '→ %s\n' "$*"; }

[[ -n "$VERSION" ]] || die "usage: ./scripts/release.sh <version>   e.g. 1.2.0"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "'$VERSION' is not a semver version (1.2.0, or 1.2.0-rc.1)"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"

branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == "main" ]] || die "on branch '$branch' — releases are cut from main"

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty. Commit or stash first."

git fetch --tags --quiet
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  die "tag v$VERSION already exists"
fi

step "Running the check suite"
./dev.sh check

step "Setting version to $VERSION"
for pkg in frontend/package.json backend/package.json mcp/package.json; do
  node -e '
    const fs = require("node:fs");
    const [file, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$pkg" "$VERSION"
  echo "  $pkg"
done

step "Committing and tagging"
git add frontend/package.json backend/package.json mcp/package.json
git commit -m "release $VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

step "Pushing"
git push origin main
git push origin "v$VERSION"

cat <<EOF

✓ Released $VERSION

  The image build is running:
  https://github.com/crnst8/mainly/actions

  Once it is green, self-hosted installs update with:
  ./mainly.sh update
EOF
