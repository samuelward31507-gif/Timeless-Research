#!/usr/bin/env python3
"""Emit copy-paste metadata blocks for manual Studio uploads."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from schedule import read_tracks, build_plan
from zoneinfo import ZoneInfo

cfg = json.loads(Path(sys.argv[1]).read_text())
tracks = read_tracks(Path(sys.argv[2]))
plan = build_plan(tracks, Path(sys.argv[3]), cfg)
tz = ZoneInfo(cfg["schedule"]["timezone"])

for p in plan:
    local = p.publish_at.astimezone(tz)
    print("=" * 78)
    print(f"FILE      {p.video_path.name}")
    print(f"SCHEDULE  {local.strftime('%a %d %b %Y, %I:%M %p')} {cfg['schedule']['timezone']}")
    print("-" * 78)
    print("TITLE")
    print(p.title)
    print()
    print("DESCRIPTION")
    print(p.description)
    print()
    print("TAGS")
    print(", ".join(p.tags))
    print()
