"""Schedule + metadata construction for the 432 Hz upload run.

Kept free of network and API imports so it can be tested directly.
"""
from __future__ import annotations

import csv
import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

# YouTube category 10 = Music.
DEFAULT_CATEGORY_ID = "10"

# videos.insert caps a title at 100 characters and a description at 5000.
# Tags are capped at 500 characters TOTAL across the list, which is the limit
# people usually miss — a long tag list is rejected outright, not truncated.
TITLE_MAX = 100
DESC_MAX = 5000
TAGS_TOTAL_MAX = 500


@dataclass
class Track:
    idx: str
    note: str
    chord: str
    texture: str
    dur: str
    scene: str
    src: str


@dataclass
class PlannedUpload:
    track: Track
    video_path: Path
    title: str
    description: str
    tags: list[str]
    publish_at: dt.datetime           # timezone-aware, UTC
    category_id: str = DEFAULT_CATEGORY_ID
    warnings: list[str] = field(default_factory=list)


def read_tracks(path: Path) -> list[Track]:
    """Read tracks.tsv. Blank lines and #-comments are skipped."""
    tracks: list[Track] = []
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.reader(fh, delimiter="\t"):
            if not row or not row[0].strip() or row[0].lstrip().startswith("#"):
                continue
            if len(row) < 7:
                raise ValueError(
                    f"tracks.tsv row needs 7 tab-separated fields, got {len(row)}: {row!r}"
                )
            tracks.append(Track(*[c.strip() for c in row[:7]]))
    return tracks


def publish_times(
    tracks: list[Track],
    start_date: str,
    publish_time: str,
    timezone: str,
    interval_days: int = 1,
) -> list[dt.datetime]:
    """One publish slot per track, `interval_days` apart, at a fixed LOCAL wall time.

    The local time is fixed and converted per-date, so a run spanning a DST
    change keeps publishing at (say) 09:00 local rather than drifting an hour.
    Returned values are timezone-aware UTC, which is what the API wants.
    """
    tz = ZoneInfo(timezone)
    d0 = dt.date.fromisoformat(start_date)
    hh, mm = (int(p) for p in publish_time.split(":"))

    out: list[dt.datetime] = []
    for i in range(len(tracks)):
        day = d0 + dt.timedelta(days=i * interval_days)
        naive = dt.datetime(day.year, day.month, day.day, hh, mm)
        # fold=0 resolves the ambiguous hour when clocks go back to the first
        # (pre-transition) occurrence; a skipped hour shifts forward naturally.
        local = naive.replace(tzinfo=tz, fold=0)
        out.append(local.astimezone(dt.timezone.utc))
    return out


def _fields(track: Track) -> dict[str, str]:
    return {
        "idx": track.idx,
        "note": track.note,
        "chord": track.chord,
        "chord_title": track.chord.title(),
        "texture": track.texture,
        "texture_lower": track.texture.lower(),
        "dur": track.dur,
        "scene": track.scene,
    }


def build_plan(
    tracks: list[Track],
    video_dir: Path,
    config: dict,
) -> list[PlannedUpload]:
    """Turn tracks + config into concrete, validated upload requests."""
    times = publish_times(
        tracks,
        config["schedule"]["start_date"],
        config["schedule"]["publish_time"],
        config["schedule"]["timezone"],
        int(config["schedule"].get("interval_days", 1)),
    )

    title_tpl = config["metadata"]["title_template"]
    desc_tpl = config["metadata"]["description_template"]
    base_tags = list(config["metadata"].get("tags", []))
    category = str(config["metadata"].get("category_id", DEFAULT_CATEGORY_ID))

    plan: list[PlannedUpload] = []
    for track, when in zip(tracks, times):
        f = _fields(track)
        warnings: list[str] = []

        title = title_tpl.format(**f)
        if len(title) > TITLE_MAX:
            warnings.append(f"title {len(title)} chars, truncated to {TITLE_MAX}")
            title = title[:TITLE_MAX].rstrip()
        # A title containing < or > is rejected by the API.
        if "<" in title or ">" in title:
            warnings.append("title contained <> which the API rejects; stripped")
            title = title.replace("<", "").replace(">", "")

        description = desc_tpl.format(**f)
        if len(description) > DESC_MAX:
            warnings.append(f"description {len(description)} chars, truncated")
            description = description[:DESC_MAX]

        tags = [t.format(**f) for t in base_tags]
        tags = _fit_tags(tags, warnings)

        video_path = video_dir / f"TR_{track.idx}_{track.note}.mp4"
        plan.append(
            PlannedUpload(
                track=track,
                video_path=video_path,
                title=title,
                description=description,
                tags=tags,
                publish_at=when,
                category_id=category,
                warnings=warnings,
            )
        )
    return plan


def _fit_tags(tags: list[str], warnings: list[str]) -> list[str]:
    """Drop tags from the end until the list fits YouTube's 500-char total budget.

    YouTube counts the combined length; a tag containing a space is quoted and
    so costs 2 extra characters. Overflowing rejects the whole insert.
    """
    def cost(ts: list[str]) -> int:
        return sum(len(t) + (2 if " " in t else 0) for t in ts) + max(0, len(ts) - 1)

    kept = list(tags)
    while kept and cost(kept) > TAGS_TOTAL_MAX:
        kept.pop()
    if len(kept) != len(tags):
        warnings.append(f"dropped {len(tags) - len(kept)} tag(s) to fit the 500-char budget")
    return kept


def to_request_body(item: PlannedUpload) -> dict:
    """The videos.insert body.

    publishAt REQUIRES privacyStatus 'private' — YouTube flips it public itself
    at the scheduled time. Setting 'public' here with publishAt is rejected.
    """
    return {
        "snippet": {
            "title": item.title,
            "description": item.description,
            "tags": item.tags,
            "categoryId": item.category_id,
        },
        "status": {
            "privacyStatus": "private",
            "publishAt": item.publish_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            # Required declaration; omitting it leaves the video in limbo.
            "selfDeclaredMadeForKids": False,
        },
    }
