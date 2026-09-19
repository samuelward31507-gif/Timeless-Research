"""Exercise retry / resume / idempotency against a fake YouTube service.

No network. Verifies the behaviour that matters when a 1.2GB batch run
hits a flaky connection halfway through.
"""
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import upload as U  # noqa: E402
from schedule import Track  # noqa: E402
from googleapiclient.errors import HttpError  # noqa: E402

FAILED = []
U.time.sleep = lambda *_: None      # no real backoff waits in tests


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


def http_error(status):
    resp = types.SimpleNamespace(status=status, reason="x")
    return HttpError(resp, b'{"error":{"message":"boom"}}')


class FakeRequest:
    """next_chunk() replays a scripted sequence of outcomes."""
    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def next_chunk(self):
        self.calls += 1
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeVideos:
    def __init__(self, script):
        self._script = script
        self.bodies = []

    def insert(self, part, body, media_body):
        self.bodies.append(body)
        return FakeRequest(self._script)


class FakeYouTube:
    def __init__(self, script):
        self._videos = FakeVideos(script)

    def videos(self):
        return self._videos


def item(idx="02", path="/tmp/_fake.mp4"):
    p = Path(path)
    p.write_bytes(b"\0" * 1024)
    from schedule import build_plan
    cfg = {"schedule": {"start_date": "2026-10-01", "publish_time": "09:00",
                        "timezone": "UTC", "interval_days": 1},
           "metadata": {"title_template": "{note}", "description_template": "d",
                        "tags": ["t"], "category_id": "10"}}
    tr = Track(idx, "B2", "minor triad", "Wood", "2:00", "forest", "a.mp4")
    pl = build_plan([tr], p.parent, cfg)[0]
    pl.video_path = p
    return pl


# stub MediaFileUpload so we never touch real chunking
class _Media:
    def __init__(self, *a, **k): pass


U_media = types.ModuleType("googleapiclient.http")
U_media.MediaFileUpload = _Media
sys.modules["googleapiclient.http"] = U_media

print("\nupload_one: retry behaviour")
progress = types.SimpleNamespace(progress=lambda: 0.5)
yt = FakeYouTube([http_error(503), http_error(503), (None, {"id": "VID123"})])
vid = U.upload_one(yt, item())
check("recovers from repeated 503", vid == "VID123", vid)
check("retried the right number of times", yt.videos().insert("", {}, None).calls == 0)

yt = FakeYouTube([http_error(429), (progress, None), (None, {"id": "VID2"})])
check("retries 429 and finishes", U.upload_one(yt, item()) == "VID2")

yt = FakeYouTube([http_error(403)])
try:
    U.upload_one(yt, item())
    check("403 is NOT retried", False, "should have raised")
except HttpError as e:
    check("403 is NOT retried", e.resp.status == 403)

yt = FakeYouTube([http_error(500)] * 10)
try:
    U.upload_one(yt, item())
    check("gives up after MAX_ATTEMPTS", False, "should have raised")
except HttpError:
    check("gives up after MAX_ATTEMPTS", True)

yt = FakeYouTube([ConnectionError("reset"), (None, {"id": "VID3"})])
check("resumes after a dropped connection", U.upload_one(yt, item()) == "VID3")

print("\nupload_one: progress reporting does not end the loop")
yt = FakeYouTube([(progress, None), (progress, None), (None, {"id": "VID4"})])
check("keeps pumping chunks until response", U.upload_one(yt, item()) == "VID4")

print("\nstate: atomic write + reload")
sp = Path("/tmp/_state_test.json")
if sp.exists():
    sp.unlink()
st = U.load_state(sp)
check("missing state starts empty", st == {"uploaded": {}}, str(st))
st["uploaded"]["02"] = {"video_id": "A", "publish_at": "x", "title": "t", "uploaded_at": "u"}
U.save_state(sp, st)
check("state round-trips", U.load_state(sp)["uploaded"]["02"]["video_id"] == "A")
check("no .tmp left behind", not sp.with_suffix(".tmp").exists())
check("valid json on disk", isinstance(json.loads(sp.read_text()), dict))

print("\nstate: leading-zero indices survive JSON")
st["uploaded"]["07"] = {"video_id": "B", "publish_at": "x", "title": "t", "uploaded_at": "u"}
U.save_state(sp, st)
check("'07' stays a string key", "07" in U.load_state(sp)["uploaded"])

print("\nidempotency: cmd_upload skips what state already has")
tsv = Path("/tmp/_t2.tsv")
tsv.write_text(
    "02\tB2\tminor triad\tWood\t2:00\tforest\ta.mp4\n"
    "03\tC3\tmajor triad\tBreath\t2:00\tdawn\tb.mp4\n")
vdir = Path("/tmp/_vids")
vdir.mkdir(exist_ok=True)
for n in ("TR_02_B2.mp4", "TR_03_C3.mp4"):
    (vdir / n).write_bytes(b"\0" * 2048)
cfgp = Path("/tmp/_cfg.json")
cfgp.write_text(json.dumps({
    "schedule": {"start_date": "2026-10-01", "publish_time": "09:00",
                 "timezone": "UTC", "interval_days": 1},
    "metadata": {"title_template": "{note}", "description_template": "d",
                 "tags": ["t"], "category_id": "10"}}))
sp2 = Path("/tmp/_state2.json")
sp2.write_text(json.dumps({"uploaded": {"02": {"video_id": "OLD", "title": "t",
                                               "publish_at": "x", "uploaded_at": "u"}}}))

args = types.SimpleNamespace(config=str(cfgp), tracks=str(tsv), video_dir=str(vdir),
                             state=str(sp2), dry_run=True, limit=0, chunk_mb=8,
                             thumb_dir=None, stop_on_error=False)
rc = U.cmd_upload(args)
check("dry run exits 0", rc == 0, str(rc))
check("state untouched by dry run",
      json.loads(sp2.read_text())["uploaded"]["02"]["video_id"] == "OLD")

print("\nmissing files abort before any upload")
(vdir / "TR_03_C3.mp4").unlink()
sp2.write_text(json.dumps({"uploaded": {}}))
try:
    U.cmd_upload(args)
    check("aborts when a file is missing", False, "should have raised SystemExit")
except SystemExit:
    check("aborts when a file is missing", True)

print()
if FAILED:
    print(f"{len(FAILED)} FAILED: {FAILED}")
    sys.exit(1)
print("all tests passed")
