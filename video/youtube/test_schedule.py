"""Tests for the parts that can be verified without touching the API."""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from schedule import (  # noqa: E402
    Track, read_tracks, publish_times, build_plan, to_request_body, _fit_tags,
)

FAILED = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


def mk(n):
    return [Track(f"{i+2:02d}", "B2", "minor triad", "Wood", "2:00", "forest", f"x{i}.mp4")
            for i in range(n)]


print("\nschedule: one slot per track, correct spacing")
t = publish_times(mk(5), "2026-10-01", "09:00", "America/New_York")
check("returns one time per track", len(t) == 5, f"got {len(t)}")
check("all timezone-aware UTC", all(x.tzinfo == dt.timezone.utc for x in t))
check("spaced 24h apart", all((t[i+1]-t[i]) == dt.timedelta(days=1) for i in range(4)))
check("09:00 EDT == 13:00 UTC", t[0].hour == 13, f"got {t[0].hour}")

print("\nschedule: interval_days")
t2 = publish_times(mk(3), "2026-10-01", "09:00", "UTC", interval_days=3)
check("3-day spacing", (t2[1]-t2[0]) == dt.timedelta(days=3))

print("\nschedule: DST — the case a naive +24h loop gets wrong")
# US DST ends 2026-11-01. A run crossing it must stay at 09:00 LOCAL,
# which means the UTC hour has to shift 13 -> 14.
t3 = publish_times(mk(4), "2026-10-30", "09:00", "America/New_York")
local = [x.astimezone(__import__("zoneinfo").ZoneInfo("America/New_York")) for x in t3]
check("local wall time constant at 09:00", all(x.hour == 9 for x in local),
      f"got {[x.hour for x in local]}")
check("UTC hour shifts across the transition", [x.hour for x in t3] == [13, 13, 14, 14],
      f"got {[x.hour for x in t3]}")
check("spacing is 25h across fall-back", (t3[2]-t3[1]) == dt.timedelta(hours=25),
      f"got {t3[2]-t3[1]}")

print("\nschedule: southern-hemisphere DST (opposite direction)")
t4 = publish_times(mk(3), "2026-10-03", "09:00", "Australia/Sydney")
syd = [x.astimezone(__import__("zoneinfo").ZoneInfo("Australia/Sydney")) for x in t4]
check("local stays 09:00", all(x.hour == 9 for x in syd), f"got {[x.hour for x in syd]}")

print("\ntags: 500-char total budget")
warn = []
kept = _fit_tags(["432hz"]*10, warn)
check("short list untouched", len(kept) == 10 and not warn)
warn = []
kept = _fit_tags([f"a-very-long-tag-number-{i:03d}-padding-padding" for i in range(40)], warn)
cost = sum(len(t)+(2 if " " in t else 0) for t in kept) + max(0, len(kept)-1)
check("trimmed under budget", cost <= 500, f"cost {cost}")
check("warned about the drop", bool(warn))
warn = []
kept = _fit_tags(["two words"]*60, warn)
cost = sum(len(t)+(2 if " " in t else 0) for t in kept) + max(0, len(kept)-1)
check("quoted (spaced) tags counted", cost <= 500, f"cost {cost}")

print("\nplan: templating, limits, request body")
cfg = {
    "schedule": {"start_date": "2026-10-01", "publish_time": "09:00",
                 "timezone": "UTC", "interval_days": 1},
    "metadata": {
        "title_template": "{note} · {chord_title} — 432 Hz",
        "description_template": "{note} {chord}, {texture_lower} texture. {dur}.",
        "tags": ["432hz", "{texture_lower}", "sound bath"],
        "category_id": "10",
    },
}
plan = build_plan(mk(2), Path("/videos"), cfg)
check("title templated", plan[0].title == "B2 · Minor Triad — 432 Hz", plan[0].title)
check("description templated",
      plan[0].description == "B2 minor triad, wood texture. 2:00.", plan[0].description)
check("video path derived", plan[0].video_path == Path("/videos/TR_02_B2.mp4"),
      str(plan[0].video_path))

body = to_request_body(plan[0])
check("privacyStatus is private (required with publishAt)",
      body["status"]["privacyStatus"] == "private")
check("publishAt is RFC3339 Z", body["status"]["publishAt"] == "2026-10-01T09:00:00Z",
      body["status"]["publishAt"])
check("madeForKids declared", body["status"]["selfDeclaredMadeForKids"] is False)
check("categoryId present", body["snippet"]["categoryId"] == "10")

print("\nplan: over-long title is truncated, not rejected")
cfg2 = dict(cfg)
cfg2["metadata"] = dict(cfg["metadata"], title_template="X"*150)
p2 = build_plan(mk(1), Path("/v"), cfg2)
check("truncated to 100", len(p2[0].title) <= 100, f"len {len(p2[0].title)}")
check("warning recorded", any("title" in w for w in p2[0].warnings), str(p2[0].warnings))

print("\nplan: angle brackets stripped (API rejects them)")
cfg3 = dict(cfg)
cfg3["metadata"] = dict(cfg["metadata"], title_template="a <b> c")
p3 = build_plan(mk(1), Path("/v"), cfg3)
check("brackets gone", "<" not in p3[0].title and ">" not in p3[0].title, p3[0].title)

print("\ntracks.tsv parsing")
tmp = Path("/tmp/_t.tsv")
tmp.write_text("# comment\n\n02\tB2\tminor triad\tWood\t2:00\tforest\ta.mp4\n")
got = read_tracks(tmp)
check("comments and blanks skipped", len(got) == 1, f"got {len(got)}")
check("leading zero preserved", got[0].idx == "02", got[0].idx)
tmp.write_text("02\tB2\tshort\n")
try:
    read_tracks(tmp); check("short row raises", False)
except ValueError:
    check("short row raises", True)

print()
if FAILED:
    print(f"{len(FAILED)} FAILED: {FAILED}")
    sys.exit(1)
print("all tests passed")
