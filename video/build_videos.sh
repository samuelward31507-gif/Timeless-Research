#!/usr/bin/env bash
# Rebuild each source video with the new Timeless Research screen,
# keeping the original audio untouched.
#
#   ./build_videos.sh <source_video_dir> [outdir]
#
# Reads tracks.tsv:  idx <TAB> note <TAB> chord <TAB> texture <TAB> dur <TAB> source_filename
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRCDIR="${1:?usage: build_videos.sh <source_video_dir> [outdir]}"
OUT="${2:-$DIR/out}"
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

WIN_H=1167        # headless chrome reserves 87px; this yields a true 1080px viewport
FPS=10            # match the source cadence
CYCLE=8           # seconds per breath
NFRAMES=$((FPS * CYCLE))

mkdir -p "$OUT"
urlenc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

while IFS=$'\t' read -r idx note chord texture dur src; do
  [ -z "${idx:-}" ] && continue
  SRC="$SRCDIR/$src"
  if [ ! -f "$SRC" ]; then echo "SKIP $idx — missing $src"; continue; fi

  FRAMES="$OUT/.frames_$idx"; rm -rf "$FRAMES"; mkdir -p "$FRAMES"
  base="note=$(urlenc "$note")&chord=$(urlenc "$chord")&texture=$(urlenc "$texture")&dur=$(urlenc "$dur")&idx=$(urlenc "$idx")"

  for ((i=0; i<NFRAMES; i++)); do
    p=$(python3 -c "print($i/$NFRAMES)")
    raw="$FRAMES/.raw.png"
    "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
      --force-device-scale-factor=1 --window-size=1920,$WIN_H --virtual-time-budget=1500 \
      --screenshot="$raw" "file://$DIR/screen.html?$base&phase=$p" </dev/null >/dev/null 2>&1
    ffmpeg -nostdin -v error -i "$raw" -vf "crop=1920:1080:0:0" \
      "$(printf "%s/f_%04d.png" "$FRAMES" "$i")" -y
  done
  rm -f "$FRAMES/.raw.png"

  # exact source duration so the loop never over- or under-runs the audio
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")

  ffmpeg -nostdin -v error -stats \
    -stream_loop -1 -framerate $FPS -i "$FRAMES/f_%04d.png" \
    -i "$SRC" \
    -map 0:v -map 1:a \
    -t "$DUR" \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r $FPS -g $((FPS*2)) \
    -c:a copy \
    -movflags +faststart \
    "$OUT/TR_${idx}_$(echo "$note" | tr -d ' ').mp4" -y

  rm -rf "$FRAMES"
  echo "built $OUT/TR_${idx}_$(echo "$note" | tr -d ' ').mp4"
done < "$DIR/tracks.tsv"

echo "--- done -> $OUT ---"
