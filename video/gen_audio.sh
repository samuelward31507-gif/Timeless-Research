#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TSV="$1"; OUT="$2"
mkdir -p "$OUT"
tail -n +2 "$TSV" | while IFS=$'\t' read -r idx vol note chord texture dur scene variant src; do
  [ -z "${idx:-}" ] && continue
  if [ -f "$OUT/$src" ]; then echo "  skip $src (exists)"; continue; fi
  "$DIR/.venv/bin/python" "$DIR/synth.py" --note "$note" --chord "$chord" \
    --texture "$(echo "$texture" | tr 'A-Z' 'a-z')" --seconds 120 --out "$OUT/.tmp_$idx.wav" >/dev/null
  ffmpeg -nostdin -v error -i "$OUT/.tmp_$idx.wav" -c:a aac -b:a 192k "$OUT/$src" -y
  rm -f "$OUT/.tmp_$idx.wav"
  echo "  $idx  $note $chord ($texture)"
done
