#!/usr/bin/env python3
"""Plan a month: 6 volumes x 5 tracks.

A volume is one place and one tonic. The five tracks in it share a root note
and an environment family, and move through variants 0-4 — same location,
light travelling across the evening. That reads as a series; five identical
frames in a channel grid read as a content farm.

    python plan_month.py --month 1                 # print the plan
    python plan_month.py --month 1 --tsv tracks.tsv
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from synth import CHORDS, NOTES, TEXTURES  # noqa: E402

# All 15 environments. A month consumes 6, so families don't repeat for 2.5
# months — long enough that the channel never looks like it's cycling.
SCENES = ["alpine", "marsh", "forest", "cloudsea", "dunes", "lake",
          "aurora", "mist", "canyon", "birch", "snowfall", "ocean",
          "tundra", "glacier", "dawn"]

# Which texture suits which place. Bell for water and ice, wood for trees.
SCENE_TEXTURE = {
    "alpine": "bowed", "marsh": "bell", "forest": "wood", "cloudsea": "breath",
    "dunes": "hollow", "lake": "bell", "aurora": "breath", "mist": "breath",
    "canyon": "hollow", "birch": "wood", "snowfall": "bell", "ocean": "bell",
    "tundra": "hollow", "glacier": "bell", "dawn": "breath",
}

# Roots cycle so consecutive volumes don't sit on the same tonic.
# Nothing below ~95 Hz: C2 is 64 Hz and D2 is 72 Hz at A=432, and those
# fundamentals barely reproduce on phone or laptop speakers. For a video whose
# whole content is a sustained tone, that is the difference between hearing it
# and not. Octave 2 is only safe from G2 up.
ROOTS = ["G2", "C3", "A2", "E3", "D3", "F3", "B2", "A3", "D#3", "G3", "F#3", "A#3"]

# Five chord shapes per volume, rotated so volume 1 and volume 2 don't open
# the same way. Each set moves dark -> open.
CHORD_SETS = [
    ["minor triad", "sus2", "minor seventh", "sus4", "major triad"],
    ["open fifth", "sus4", "minor ninth", "add9", "major seventh"],
    ["quartal", "sus2", "minor triad", "sixth", "major triad"],
    ["diminished", "minor seventh", "sus4", "add9", "major seventh"],
]

VARIANT_NAME = ["deep night", "late night", "small hours", "first light", "dawn"]


def plan_month(month: int, start_idx: int = 1) -> list[dict]:
    """month is 1-based and just rotates the scene/root/chord pools."""
    rows = []
    idx = start_idx
    for v in range(6):
        scene = SCENES[((month - 1) * 6 + v) % len(SCENES)]
        root = ROOTS[((month - 1) * 6 + v) % len(ROOTS)]
        texture = SCENE_TEXTURE[scene]
        chords = CHORD_SETS[(month - 1 + v) % len(CHORD_SETS)]
        for k in range(5):
            rows.append({
                "idx": f"{idx:02d}",
                "volume": f"{v+1}",
                "note": root,
                "chord": chords[k],
                "texture": texture.title(),
                "dur": "2:00",
                "scene": scene,
                "variant": str(k),
                "src": f"A{idx:02d}.m4a",
            })
            idx += 1
    return rows


COLUMNS = ["idx", "volume", "note", "chord", "texture", "dur", "scene", "variant", "src"]


def write_tsv(rows: list[dict], path: Path) -> None:
    with path.open("w", encoding="utf-8") as fh:
        fh.write("\t".join(COLUMNS) + "\n")
        for r in rows:
            fh.write("\t".join(r[c] for c in COLUMNS) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", type=int, default=1)
    ap.add_argument("--start-idx", type=int, default=1)
    ap.add_argument("--tsv", default=None)
    a = ap.parse_args()

    rows = plan_month(a.month, a.start_idx)

    # sanity: nothing here should be unrenderable
    bad = [r for r in rows if r["chord"] not in CHORDS
           or r["texture"].lower() not in TEXTURES
           or r["note"][:-1] not in NOTES]
    if bad:
        raise SystemExit(f"plan contains {len(bad)} invalid row(s): {bad[:2]}")

    cur = None
    for r in rows:
        if r["volume"] != cur:
            cur = r["volume"]
            print(f"\n  VOLUME {cur} — {r['scene']}, tonic {r['note'][:-1]}, "
                  f"{r['texture'].lower()}")
            print(f"  {'idx':<5}{'chord':<16}{'variant':<14}")
            print("  " + "-" * 36)
        print(f"  {r['idx']:<5}{r['chord']:<16}"
              f"{VARIANT_NAME[int(r['variant'])]:<14}")

    print(f"\n{len(rows)} tracks, {len(set(r['volume'] for r in rows))} volumes, "
          f"{len(set(r['scene'] for r in rows))} environments")
    combos = {(r["note"], r["chord"], r["texture"]) for r in rows}
    print(f"{len(combos)} unique note/chord/texture combinations "
          f"({'no repeats' if len(combos) == len(rows) else 'REPEATS PRESENT'})")

    if a.tsv:
        write_tsv(rows, Path(a.tsv))
        print(f"wrote {a.tsv}")


if __name__ == "__main__":
    main()
