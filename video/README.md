# 432 Hz video background pipeline

Rebuilds the 432 Hz track videos over generated nature scenes, replacing the
original background while leaving the source audio **bit-for-bit untouched**.

Backgrounds are drawn procedurally (canvas: layered noise ridges, atmospheric
haze, drifting fog, star fields). Nothing is stock footage, so there is no
licensing exposure and no Content ID risk on the visuals.

## Files

| File | Purpose |
|---|---|
| `scene.html` | The 1920×1080 screen + scene engine. Driven entirely by query params. |
| `tracks.tsv` | One row per video: `idx · note · chord · texture · duration · scene · source filename` |
| `render_screens.sh` | Renders a still PNG per track (thumbnails, stills, review). |
| `build_videos.sh` | Full rebuild: animated screen + original audio → MP4. |
| `fonts/`, `gf-local.css` | Inter + Cormorant Garamond, vendored so renders are deterministic offline. |

## Usage

```bash
./render_screens.sh [outdir]                    # stills only
./build_videos.sh <source_video_dir> [outdir]   # finished videos
```

To add the remaining tracks, append rows to `tracks.tsv` and re-run. Nothing else changes.

## Screen parameters

`scene.html?scene=forest&note=B2&chord=minor%20triad&texture=Wood&dur=2:00&phase=0`

15 scenes: `forest` `dawn` `alpine` `ocean` `dunes` `aurora` `lake` `mist`
`canyon` `cloudsea` `birch` `snowfall` `marsh` `tundra` `glacier`. Add more by
appending a palette + layer spec to the `SCENES` map — no other code changes needed.

Layer primitives: `ridges` (with `jag` peaks, `dune` crests, `mesa` benches),
`trees` (conifers), `birch`, `reeds`, `water` + `mirror` (reflection), `clouds`,
`aurora`, `stars`, `snow`, `fog`, `ground`.

`phase` is `[0,1)` and drives one full breath cycle of the core glow. `build_videos.sh`
renders 80 frames across that range and loops them, so the animation is seamless at the
join (verified: luminance at `phase=0` and the loop seam match to within 0.01).

## Four things that will bite you

1. **Headless Chrome reserves 87px of window height for browser chrome.** `--window-size=1920,1080`
   yields a *993px* viewport, silently cutting everything anchored to the bottom of the page.
   Use `--window-size=1920,1167` and crop back to 1080 — which is what these scripts do.

2. **Per-frame noise destroys the encode.** Seeding the dither from the animation
   phase makes every frame unique, which h.264 cannot exploit — one 2-minute track
   came out at **376 MB**. The dither seed is deliberately constant; keep it that way.
   With a fixed seed the same track is ~39 MB.

3. **Anything symmetric and hard-edged reads as an artifact.** The water glint
   started as flat `fillRect` rows of constant width; stacked up they cut a hard
   silhouette that looked like a christmas tree sitting on the lake. Each row now
   fills with a horizontal transparent→colour→transparent gradient. Same lesson
   sank the first mesa pass (4 quantisation steps = a bar chart) and the first
   birch pass (6px trunks = a barcode).

4. **`ffmpeg` reads stdin one byte at a time.** Inside a `while read` loop it eats characters
   from the loop's input (it was swallowing the leading `0` of each `NN` index). Every `ffmpeg`
   call here passes `-nostdin`; keep it that way if you edit these scripts.

## Encoding

H.264, CRF 20, `preset slow`, yuv420p, 10 fps, `+faststart`, audio stream-copied.
CRF 20 with a static dither keeps the dark gradients free of banding at roughly
39 MB per 2-minute track (~1.2 GB for all 30). YouTube re-encodes on upload, so the
source should stay as clean as is practical.

Ridge frequency (`fr`) is **cycles per pixel** — around `0.0015` gives ~3 undulations
across the frame. Values a couple of orders of magnitude higher turn terrain into
what looks like an audio waveform.

## Channel art

`brand.html` renders the YouTube banner and avatar from the same scene engine
as the videos, so the channel reads as one thing.

```bash
# banner — 2560x1440 window must be 1440+87 tall (chrome's reserve)
chrome --headless --window-size=2560,1527 --screenshot=banner.png \
  "file://$PWD/brand.html?mode=banner&scene=dawn&name=Two+Minute+Tones"
# then crop back: ffmpeg -i banner.png -vf crop=2560:1440:0:0 out.png

# avatar — 800x800
chrome --headless --window-size=800,887 --screenshot=pfp.png \
  "file://$PWD/brand.html?mode=pfp&scene=alpine"
```

Params: `mode` (banner|pfp), `scene` (dawn|alpine|ocean|forest|dunes),
`name`, `tag`, `guides=1` to overlay the safe-area boxes.

**YouTube's banner sizing is the thing to get right.** Upload is 2560x1440,
but only the centred **1546x423** is visible on every device — TV shows the
whole 2560x1440, desktop shows a 2560x423 strip, phones show just the safe box.
All type sits inside 1546x423. `banner_guides.png` shows the boxes.

The avatar is cropped to a **circle** at display time and renders as small as
48px in comments, so it carries one word ("432") and nothing that dies when
shrunk. `brand/` has renders at 48/88/800 to check.
