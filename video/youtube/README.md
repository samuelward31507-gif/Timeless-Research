# YouTube upload

## Uploading by hand? Skip all of this.

Manual upload through YouTube Studio does **not** require the compliance audit
below — that restriction only applies to `videos.insert` via the API. Studio
uploads publish normally, and Studio's own **Schedule** option gives the same
one-per-day result. For a batch this size that is usually the faster path.

Generate copy-paste metadata for a manual run:

```bash
python youtube/sheet.py youtube/config.json ../tracks.tsv ../out > upload_sheet.txt
```

The rest of this document is for the scripted path.

# Scheduled upload via the API

Uploads every track once, as **private with a `publishAt` timestamp**. YouTube
publishes each one itself at the scheduled time.

There is deliberately **no daily cron and no long-running agent**. A month of
daily posts is one batch run: 30 chances for an expired token or a missed job
collapse into one. Nothing needs to be running on the publish days — if your
machine is off for the next month, the videos still go out.

## Before anything works

Two gates, both outside this code. The first takes weeks, so start it now.

**1. YouTube API compliance audit.** Any Google Cloud project created after
28 July 2020 that has not passed the audit has **every video it uploads locked
to private, permanently**. The upload returns `200`, the video appears, and you
cannot make it public — not through this script, not through the Studio UI, and
`publishAt` will not release it. Apply, wait for approval, then run this.

**2. OAuth consent screen set to "In production."** Left on *Testing*, Google
expires the refresh token after exactly 7 days on a fixed clock regardless of
use. One dropdown in the Cloud Console.

## Setup

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt

# Cloud Console -> Credentials -> OAuth client -> Desktop app -> download JSON
cp ~/Downloads/client_secret_*.json youtube/client_secret.json
cp youtube/config.example.json youtube/config.json   # edit the schedule
```

## Use

```bash
python youtube/upload.py plan                  # print the schedule, touch nothing
python youtube/upload.py auth                  # one-time browser consent
python youtube/upload.py upload --dry-run      # validate everything, no API writes
python youtube/upload.py upload                # go
python youtube/upload.py status                # what went up, with links
```

Useful flags: `--limit N` (upload at most N this run), `--video-dir`,
`--thumb-dir` (looks for `screen_NN.png`), `--stop-on-error`, `--chunk-mb`.

Run `plan` and `--dry-run` first. `plan` fails if any video file is missing,
before a single byte is sent.

## Safety properties

- **Idempotent.** Each successful upload is written to `state.json` immediately.
  Re-running `upload` skips anything already there, so an interrupted run
  resumes rather than double-posting. To genuinely re-upload one, delete its
  entry.
- **Resumable.** Files are ~39 MB; a non-resumable upload that dies at 90%
  starts over. Chunks are 8 MB by default.
- **Bounded retries.** 5xx and 429 back off exponentially with jitter, 5
  attempts, and the counter resets whenever a chunk makes progress. `403` is
  deliberately *not* retried — it is nearly always quota exhaustion or
  permissions, and retrying just burns more quota.
- **State written before thumbnails.** The video is the expensive half; a
  thumbnail failure must never cost you a re-upload. Thumbnail errors are
  logged and skipped (they need a phone-verified channel).

## Quota

`videos.insert` moved to its own bucket on 1 June 2026: **100 uploads/day**,
separate from the 10,000-unit general pool. 30 videos fits in one run. The
script warns if a run would exceed 100.

Guides still quoting 1,600 units per upload are two revisions out of date.

## Metadata

`config.json` holds the schedule and title/description/tag templates. Fields
available: `{idx} {note} {chord} {chord_title} {texture} {texture_lower} {dur}
{scene}`.

Limits are enforced before sending, because the API rejects rather than
truncates: title 100 chars, description 5000, and **tags 500 chars in total
across the whole list** — the one people miss. A tag containing a space is
quoted and costs 2 extra characters. Over-long titles are truncated and `<`/`>`
stripped, both with a warning in `plan`.

`publishAt` requires `privacyStatus: "private"`. Sending `public` alongside it
is rejected. `selfDeclaredMadeForKids` is set explicitly — omitting the
audience declaration leaves videos in limbo.

## Scheduling across DST

`publish_time` is a **local wall time** and is converted per-date, so a run
spanning a DST change keeps publishing at 09:00 local instead of drifting an
hour. `test_schedule.py` covers both directions (US fall-back, Sydney
spring-forward) — a naive `+24h` loop fails these.

```bash
python youtube/test_schedule.py
```

## What is NOT tested

Everything above the API boundary is tested. **No call has ever been made
against real YouTube from here** — this environment has no credentials and no
channel. The request bodies, auth flow, resume and retry paths are written from
the documented API contract but have not executed against it.

So: run `--dry-run`, then a real `--limit 1`, and confirm that one video looks
right in Studio before turning it loose on the rest.
