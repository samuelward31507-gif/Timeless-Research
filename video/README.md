# Resonance Series — video screen pipeline

Rebuilds the 432 Hz track videos with the Timeless Research screen, replacing the
original background while leaving the source audio **bit-for-bit untouched**.

## Files

| File | Purpose |
|---|---|
| `screen.html` | The 1920×1080 screen. Driven entirely by query params. |
| `tracks.tsv` | One row per video: `idx · note · chord · texture · duration · source filename` |
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

`screen.html?note=B2&chord=minor%20triad&texture=Wood&dur=2:00&idx=02&phase=0`

`phase` is `[0,1)` and drives one full breath cycle of the core glow. `build_videos.sh`
renders 80 frames across that range and loops them, so the animation is seamless at the
join (verified: luminance at `phase=0` and the loop seam match to within 0.01).

## Two things that will bite you

1. **Headless Chrome reserves 87px of window height for browser chrome.** `--window-size=1920,1080`
   yields a *993px* viewport, silently cutting everything anchored to the bottom of the page.
   Use `--window-size=1920,1167` and crop back to 1080 — which is what these scripts do.

2. **`ffmpeg` reads stdin one byte at a time.** Inside a `while read` loop it eats characters
   from the loop's input (it was swallowing the leading `0` of each `NN` index). Every `ffmpeg`
   call here passes `-nostdin`; keep it that way if you edit these scripts.

## Encoding

H.264, CRF 18, `preset slow`, yuv420p, 10 fps, `+faststart`, audio stream-copied.
CRF 18 is deliberately generous — the near-black gradients band badly at lower bitrates,
and YouTube re-encodes anyway, so the upload should be the best available source.
