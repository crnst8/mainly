#!/usr/bin/env bash
# Regenerate every derived logo asset from the two source files.
#
#   ./frontend/scripts/logo.sh
#
# Sources live in `_logo/new/` and are NOT committed — that directory is
# gitignored because the masters are 3000×3000 PNGs and a 4MB PSD. Everything
# under `frontend/public/` is committed, because a checkout has to be able to
# build without them.
#
# Naming, which reads backwards until you know the rule: the file is named for
# the *surface* it sits on, not for the colour of its ink. `logo-*` is the dark
# mark for light backgrounds; `logo-light-*` is the light mark for dark ones.
# That is the convention `shell.css` already switches on, so it stays.

set -euo pipefail
cd "$(dirname "$0")/../.."

SRC_LIGHT=_logo/new/logoRedo-lightmode.png   # dark ink → light surfaces
SRC_DARK=_logo/new/logoRedo-darkmode.png     # light ink → dark surfaces
OUT=frontend/public

for f in "$SRC_LIGHT" "$SRC_DARK"; do
  [[ -f $f ]] || { echo "missing $f — the masters are not committed, ask for them"; exit 1; }
done

png() { sips -s format png -z "$2" "$2" "$1" --out "$3" >/dev/null; }

# In-app mark. 64/128/256 so the topbar's 20px box has a 2x and 3x source.
for size in 64 128 256; do
  png "$SRC_LIGHT" "$size" "$OUT/logo/logo-$size.png"
  png "$SRC_DARK"  "$size" "$OUT/logo/logo-light-$size.png"
done

# Browser and platform icons.
png "$SRC_LIGHT" 32  "$OUT/favicon-32.png"
png "$SRC_LIGHT" 180 "$OUT/apple-touch-icon.png"

# SVG favicon: a wrapper around two 128px rasters, not a vector.
#
# A trace of the mark would be a redraw, and a redraw that is nearly right is
# worse than an honest raster. The wrapper earns its place twice over: browsers
# that prefer `image/svg+xml` scale one file to any size instead of picking the
# nearest PNG, and — because an SVG icon honours CSS — it can carry *both* marks
# and let the browser choose. The PNG fallbacks cannot, so the black mark sits
# invisibly on a dark tab strip; here it does not.
TMP=$(mktemp -d)
png "$SRC_LIGHT" 128 "$TMP/light.png"
png "$SRC_DARK"  128 "$TMP/dark.png"
{
  printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">\n'
  printf '  <!-- The mark, from _logo/new/logoRedo-*.png. Regenerate with\n'
  printf '       frontend/scripts/logo.sh; do not hand-edit. -->\n'
  printf '  <style>.dark{display:none}@media(prefers-color-scheme:dark){.light{display:none}.dark{display:inline}}</style>\n'
  printf '  <image class="light" width="128" height="128" href="data:image/png;base64,'
  base64 < "$TMP/light.png" | tr -d '\n'
  printf '"/>\n'
  printf '  <image class="dark" width="128" height="128" href="data:image/png;base64,'
  base64 < "$TMP/dark.png" | tr -d '\n'
  printf '"/>\n</svg>\n'
} > "$OUT/favicon.svg"
rm -rf "$TMP"

# The macOS launcher icon, if the launcher is being built.
cp "$SRC_LIGHT" _logo/icon.png

echo "wrote:"
ls -1 "$OUT"/logo/*.png "$OUT"/favicon-32.png "$OUT"/favicon.svg "$OUT"/apple-touch-icon.png
