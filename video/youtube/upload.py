#!/usr/bin/env python3
"""Schedule a batch of 432 Hz videos to YouTube.

Uploads every track once as PRIVATE with a `publishAt` timestamp. YouTube
flips each one public itself at the scheduled time, so nothing needs to be
running on the publish days — this is a single batch, not a daily cron.

    python upload.py plan                 # print the schedule, touch nothing
    python upload.py auth                 # one-time browser consent
    python upload.py upload --dry-run     # validate everything, no API writes
    python upload.py upload               # do it
    python upload.py status               # what has been uploaded so far

Re-running `upload` skips tracks already recorded in state.json, so an
interrupted run resumes instead of double-posting.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from schedule import build_plan, read_tracks, to_request_body  # noqa: E402

HERE = Path(__file__).parent
SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly"]

# HTTP statuses worth retrying. 403 is deliberately NOT here: it is almost
# always quota exhaustion or a permissions problem, and retrying burns quota.
RETRY_STATUS = {500, 502, 503, 504, 429}
MAX_ATTEMPTS = 5


# ----------------------------------------------------------------- state

def load_state(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {"uploaded": {}}


def save_state(path: Path, state: dict) -> None:
    """Write via a temp file + replace so an interrupt cannot truncate state."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
    tmp.replace(path)


# ------------------------------------------------------------------ auth

def get_credentials(cfg_dir: Path, interactive: bool):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    token_path = cfg_dir / "token.json"
    secret_path = cfg_dir / "client_secret.json"
    creds = None

    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            token_path.write_text(creds.to_json())
            return creds
        except Exception as exc:
            print(f"  token refresh failed ({exc}); re-authorising", file=sys.stderr)
            creds = None

    if not interactive:
        raise SystemExit(
            "No valid credentials. Run:  python upload.py auth\n"
            "(needs a browser once; after that the refresh token is reused)"
        )
    if not secret_path.exists():
        raise SystemExit(
            f"Missing {secret_path}.\n"
            "Create an OAuth client (type: Desktop app) in Google Cloud Console,\n"
            "download the JSON, and save it there."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(secret_path), SCOPES)
    creds = flow.run_local_server(port=0)
    token_path.write_text(creds.to_json())
    print(f"  saved {token_path}")
    return creds


def build_service(creds):
    from googleapiclient.discovery import build
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


# ---------------------------------------------------------------- upload

def upload_one(youtube, item, chunk_mb: int = 8) -> str:
    """Resumable upload of a single video. Returns the new video id.

    Resumable matters: these files are ~39MB each and a non-resumable upload
    that drops at 90% starts over from zero.
    """
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    media = MediaFileUpload(
        str(item.video_path),
        chunksize=chunk_mb * 1024 * 1024,
        resumable=True,
        mimetype="video/mp4",
    )
    request = youtube.videos().insert(
        part="snippet,status",
        body=to_request_body(item),
        media_body=media,
    )

    attempt = 0
    response = None
    last_pct = -10
    while response is None:
        try:
            status, response = request.next_chunk()
            if status:
                pct = int(status.progress() * 100)
                if pct - last_pct >= 10:
                    print(f"      {pct}%", flush=True)
                    last_pct = pct
            attempt = 0                      # progress resets the backoff
        except HttpError as exc:
            code = exc.resp.status
            if code not in RETRY_STATUS:
                raise
            attempt += 1
            if attempt >= MAX_ATTEMPTS:
                raise
            nap = min(60, 2 ** attempt) + random.random()
            print(f"      HTTP {code}; retry {attempt}/{MAX_ATTEMPTS - 1} in {nap:.1f}s",
                  flush=True)
            time.sleep(nap)
        except (ConnectionError, OSError) as exc:
            attempt += 1
            if attempt >= MAX_ATTEMPTS:
                raise
            nap = min(60, 2 ** attempt) + random.random()
            print(f"      {type(exc).__name__}; resuming in {nap:.1f}s", flush=True)
            time.sleep(nap)

    return response["id"]


def set_thumbnail(youtube, video_id: str, path: Path) -> None:
    from googleapiclient.http import MediaFileUpload
    youtube.thumbnails().set(
        videoId=video_id,
        media_body=MediaFileUpload(str(path), mimetype="image/png"),
    ).execute()


# ----------------------------------------------------------------- cmds

def load_config(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Missing config: {path}\nCopy config.example.json and edit it.")
    return json.loads(path.read_text())


def make_plan(args):
    cfg = load_config(Path(args.config))
    tracks = read_tracks(Path(args.tracks))
    return cfg, build_plan(tracks, Path(args.video_dir), cfg)


def cmd_plan(args):
    cfg, plan = make_plan(args)
    state = load_state(Path(args.state))
    missing = warn = 0

    print(f"\n{len(plan)} tracks — publishing {cfg['schedule']['publish_time']} "
          f"{cfg['schedule']['timezone']}, every "
          f"{cfg['schedule'].get('interval_days', 1)} day(s)\n")
    print(f"{'idx':<5}{'publishes (UTC)':<22}{'size':>8}  title")
    print("-" * 92)
    for item in plan:
        done = " [uploaded]" if item.track.idx in state["uploaded"] else ""
        if item.video_path.exists():
            size = f"{item.video_path.stat().st_size / 1048576:.0f}M"
        else:
            size, missing = "MISSING", missing + 1
        print(f"{item.track.idx:<5}"
              f"{item.publish_at.strftime('%Y-%m-%d %H:%M'):<22}"
              f"{size:>8}  {item.title}{done}")
        for w in item.warnings:
            print(f"       ! {w}")
            warn += 1

    print("-" * 92)
    print(f"last publish: {plan[-1].publish_at.strftime('%Y-%m-%d %H:%M UTC')}")
    if warn:
        print(f"{warn} metadata warning(s)")
    if missing:
        print(f"{missing} video file(s) MISSING — upload would fail on those")
        return 1
    return 0


def cmd_auth(args):
    get_credentials(Path(args.config).parent, interactive=True)
    print("  authorised")
    return 0


def cmd_status(args):
    state = load_state(Path(args.state))
    up = state["uploaded"]
    if not up:
        print("nothing uploaded yet")
        return 0
    print(f"{len(up)} uploaded\n")
    for idx in sorted(up):
        rec = up[idx]
        print(f"  {idx}  {rec['video_id']}  publishes {rec['publish_at']}"
              f"  https://youtu.be/{rec['video_id']}")
    return 0


def cmd_upload(args):
    cfg, plan = make_plan(args)
    state_path = Path(args.state)
    state = load_state(state_path)

    todo = [i for i in plan if i.track.idx not in state["uploaded"]]
    skipped = len(plan) - len(todo)
    if skipped:
        print(f"skipping {skipped} already uploaded")

    missing = [i for i in todo if not i.video_path.exists()]
    if missing:
        for i in missing:
            print(f"  MISSING {i.video_path}", file=sys.stderr)
        raise SystemExit("refusing to start with missing files")

    if args.limit:
        todo = todo[: args.limit]

    # videos.insert has its own daily bucket (100/day as of Jun 2026).
    if len(todo) > 100:
        print(f"WARNING: {len(todo)} uploads exceeds the 100/day bucket; "
              "the tail will fail with quotaExceeded. Use --limit.", file=sys.stderr)

    if not todo:
        print("nothing to do")
        return 0

    print(f"\n{len(todo)} to upload"
          f"{' (DRY RUN — no API writes)' if args.dry_run else ''}\n")

    if args.dry_run:
        for item in todo:
            body = to_request_body(item)
            print(f"  {item.track.idx}  {item.title}")
            print(f"        file      {item.video_path} "
                  f"({item.video_path.stat().st_size / 1048576:.1f} MB)")
            print(f"        publishAt {body['status']['publishAt']}  "
                  f"privacy={body['status']['privacyStatus']}")
            print(f"        tags      {', '.join(item.tags) or '(none)'}")
        print("\ndry run OK — nothing was sent")
        return 0

    youtube = build_service(get_credentials(Path(args.config).parent, interactive=False))

    failures = 0
    for n, item in enumerate(todo, 1):
        print(f"[{n}/{len(todo)}] {item.track.idx} — {item.title}", flush=True)
        try:
            video_id = upload_one(youtube, item, chunk_mb=args.chunk_mb)
        except Exception as exc:
            failures += 1
            print(f"      FAILED: {exc}", file=sys.stderr, flush=True)
            if args.stop_on_error:
                raise
            continue

        # Record before the thumbnail: the upload is the expensive, quota-bearing
        # half, and losing the id would mean re-uploading the whole file.
        state["uploaded"][item.track.idx] = {
            "video_id": video_id,
            "title": item.title,
            "publish_at": item.publish_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        save_state(state_path, state)
        print(f"      https://youtu.be/{video_id}", flush=True)

        thumb = Path(args.thumb_dir) / f"screen_{item.track.idx}.png" if args.thumb_dir else None
        if thumb and thumb.exists():
            try:
                set_thumbnail(youtube, video_id, thumb)
                print("      thumbnail set", flush=True)
            except Exception as exc:
                # Non-fatal: needs a phone-verified channel, and the video is fine without.
                print(f"      thumbnail skipped: {exc}", file=sys.stderr, flush=True)

    print(f"\ndone — {len(todo) - failures} uploaded, {failures} failed")
    return 1 if failures else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["plan", "auth", "upload", "status"])
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--tracks", default=str(HERE.parent / "tracks.tsv"))
    ap.add_argument("--video-dir", default=str(HERE.parent / "out"))
    ap.add_argument("--thumb-dir", default=None,
                    help="directory of screen_NN.png thumbnails (optional)")
    ap.add_argument("--state", default=str(HERE / "state.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="upload at most N this run")
    ap.add_argument("--chunk-mb", type=int, default=8)
    ap.add_argument("--stop-on-error", action="store_true")
    args = ap.parse_args()

    return {"plan": cmd_plan, "auth": cmd_auth,
            "upload": cmd_upload, "status": cmd_status}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
