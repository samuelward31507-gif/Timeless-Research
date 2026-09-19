#!/usr/bin/env bash
# Render one 1920x1080 screen per track from tracks.tsv
# Usage: ./render_screens.sh [outdir]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$DIR/screens}"
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
# headless chrome reserves 87px of window height for browser chrome;
# 1167 yields an exact 1080px viewport, which we then crop to.
WIN_H=1167

mkdir -p "$OUT"

urlenc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

while IFS=$'\t' read -r idx note chord texture dur src; do
  [ -z "${idx:-}" ] && continue
  q="note=$(urlenc "$note")&chord=$(urlenc "$chord")&texture=$(urlenc "$texture")&dur=$(urlenc "$dur")&idx=$(urlenc "$idx")"
  raw="$OUT/.raw_$idx.png"
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1920,$WIN_H --virtual-time-budget=4000 \
    --screenshot="$raw" "file://$DIR/screen.html?$q" >/dev/null 2>&1 </dev/null
  ffmpeg -nostdin -v error -i "$raw" -vf "crop=1920:1080:0:0" "$OUT/screen_$idx.png" -y
  rm -f "$raw"
  echo "rendered screen_$idx.png  ($note · $chord · $texture)"
done < "$DIR/tracks.tsv"

echo "--- done -> $OUT ---"
