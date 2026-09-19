#!/usr/bin/env python3
"""
Build the product vial asset from the studio photograph.

    python3 tools/make_vial.py            # regenerate assets/img/vial.{png,webp}

The source (vial.png at the repo root) is a real photograph of a crimp-top
glass vial carrying a *blank paper label*, shot on black. Two problems had to
be solved to use it on a light page:

1. The background is opaque black, so the vial sat in a visible dark box.
2. The glass is transparent, so simply cutting out the background left the
   glass interior black — it read as a dark blob pasted onto white, because a
   real vial on a light surface shows that surface *through* the glass.

The fix is a luminance-derived alpha inside the subject silhouette: bright
regions (cap, label) stay opaque while the dark glass becomes translucent, so
the page shows through it as light would. The baked-in surface shadow below
the vial is cut, since it belongs to the black studio backdrop.

The site then prints label text into the real paper label with CSS
`mix-blend-mode: multiply`, so the type inherits the photographed label's own
curvature shading instead of sitting on a flat synthetic rectangle. The label
geometry printed by this script is what assets/css/main.css uses.

Requires: pillow, numpy  (pip install pillow numpy)
"""
from __future__ import annotations

import pathlib
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "vial.png"
OUT_DIR = ROOT / "assets/img"

BG_LUM      = 26     # below this counts as studio backdrop
GLASS_DIV   = 128.0  # luminance that maps to fully opaque
GLASS_GAMMA = 1.15   # >1 pushes midtones down so the glass reads clear, not milky
ALPHA_FLOOR = 0.07   # never fully transparent inside the silhouette

# The glass carries fine white dust specks. On the original black backdrop they
# read as sparkle, but a luminance-derived alpha makes each speck OPAQUE while
# the dark glass around it goes transparent — on a light page they turn into
# visible dirt. Deriving alpha from a despeckled copy removes them while the
# RGB stays sharp, so the cap's brushed metal and the label's paper texture are
# untouched (their alpha is 1 either way).
DESPECKLE   = 5      # median radius for the alpha source only
BASE_Y      = 972    # last row of the vial itself; below is surface shadow
FEATHER     = 10
TARGET_H    = 880    # 2x the largest on-page render (470px hero)
WEBP_Q      = 88

# The photographed crimp cap is bare aluminium. CAP_TINT recolours it by
# remapping the cap's own luminance onto a colour ramp, so the metal's
# highlights, shadow and brushed texture all survive — a flat colour fill
# would kill the specular and read as plastic. Set to None to keep silver.
CAP_TINT: "tuple[str, str, str] | None" = None   # bare aluminium, as photographed
# Both in SOURCE image rows (vial.png is 1184 tall), applied before the crop.
CAP_BOTTOM  = 322    # last row of the crimp cap; the glass neck starts ~336
CAP_FEATHER = 12     # fade out over the crimp shoulder so there is no seam


def luminance(a: np.ndarray) -> np.ndarray:
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


def _hex(c: str) -> np.ndarray:
    return np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)], dtype=float)


def tint_cap(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Remap the cap's luminance onto a three-stop colour ramp."""
    if CAP_TINT is None:
        return rgb
    shadow, mid, high = (_hex(c) for c in CAP_TINT)
    h = rgb.shape[0]

    lum = luminance(rgb)
    lo, hi = 20.0, 235.0
    t = np.clip((lum - lo) / (hi - lo), 0.0, 1.0)[..., None]

    lower = shadow + (mid - shadow) * (t / 0.5)
    upper = mid + (high - mid) * ((t - 0.5) / 0.5)
    tinted = np.where(t < 0.5, lower, upper)

    # let the brightest specular keep blowing out to white
    spec = np.clip((t - 0.86) / 0.14, 0.0, 1.0)
    tinted = tinted + (255.0 - tinted) * spec

    rows = np.arange(h)[:, None, None]
    region = np.clip((CAP_BOTTOM + CAP_FEATHER - rows) / CAP_FEATHER, 0.0, 1.0)
    region = region * (alpha[..., None] > 8)

    return rgb * (1 - region) + tinted * region


def background_mask(lum: np.ndarray) -> np.ndarray:
    """Flood-fill dark pixels inward from the border.

    A plain luminance threshold would also eat the vial's own dark glass, so
    only darkness *connected to the edge of the frame* counts as backdrop.
    """
    h, w = lum.shape
    dark = lum < BG_LUM
    seen = np.zeros((h, w), bool)
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        for y in (0, h - 1):
            if dark[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if dark[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))

    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and dark[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def report_label_geometry(rgba: Image.Image) -> None:
    """Print the paper label's box, which main.css positions the type against."""
    a = np.asarray(rgba).astype(float)
    h, w, _ = a.shape
    rgb, al = a[:, :, :3], a[:, :, 3]
    lum = luminance(rgb)
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    label = (al > 248) & (lum > 150) & ((mx - mn) < 30)

    widths = np.array([
        (np.where(label[y])[0].max() - np.where(label[y])[0].min())
        if label[y].sum() > 4 else 0
        for y in range(h)
    ])
    rows = np.where(widths > w * 0.70)[0]
    runs: list[list[int]] = []
    cur = [int(rows[0])]
    for v in rows[1:]:
        if v == cur[-1] + 1:
            cur.append(int(v))
        else:
            runs.append(cur)
            cur = [int(v)]
    runs.append(cur)
    main = max(runs, key=len)
    y0, y1 = main[0], main[-1]
    xs = np.where(label[(y0 + y1) // 2])[0]
    x0, x1 = xs.min(), xs.max()

    print("\nPaper-label geometry — keep .vial-label in main.css in sync:")
    print(f"  left:   {x0 / w * 100:.2f}%")
    print(f"  top:    {y0 / h * 100:.2f}%")
    print(f"  width:  {(x1 - x0) / w * 100:.2f}%")
    print(f"  height: {(y1 - y0) / h * 100:.2f}%")


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source photograph not found: {SRC}")

    im = Image.open(SRC).convert("RGB")
    a = np.asarray(im).astype(float)
    h, w, _ = a.shape
    lum = luminance(a)

    # alpha comes from a despeckled copy; RGB stays sharp
    clean = Image.fromarray(lum.astype(np.uint8), "L").filter(ImageFilter.MedianFilter(DESPECKLE))
    lum_a = np.asarray(clean).astype(float)

    subject = ~background_mask(lum)

    alpha = np.clip((lum_a / GLASS_DIV) ** GLASS_GAMMA, 0.0, 1.0)
    alpha = np.where(subject, np.clip(alpha, ALPHA_FLOOR, 1.0), 0.0)

    # drop the surface shadow: it is part of the black backdrop, not the vial
    rows = np.arange(h)[:, None]
    alpha *= np.clip((BASE_Y + FEATHER - rows) / FEATHER, 0.0, 1.0)

    a = tint_cap(a, alpha * 255)

    mask = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.1))
    rgba = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    rgba.putalpha(mask)

    box = rgba.getbbox()
    pad = 6
    rgba = rgba.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                      min(w, box[2] + pad), min(h, box[3] + pad)))
    rgba = rgba.resize((round(rgba.width * TARGET_H / rgba.height), TARGET_H), Image.LANCZOS)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png, webp = OUT_DIR / "vial.png", OUT_DIR / "vial.webp"
    rgba.save(png, optimize=True)
    rgba.save(webp, "WEBP", quality=WEBP_Q, method=6)

    print(f"wrote {png.relative_to(ROOT)}  {rgba.size}  {png.stat().st_size // 1024} KB")
    print(f"wrote {webp.relative_to(ROOT)}  {rgba.size}  {webp.stat().st_size // 1024} KB")
    print("\nIntrinsic size for the <img> tag: "
          f'width="{rgba.width}" height="{rgba.height}"')
    report_label_geometry(rgba)


if __name__ == "__main__":
    main()
