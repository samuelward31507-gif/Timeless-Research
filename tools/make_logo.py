#!/usr/bin/env python3
"""
Generate the Timeless Research flame mark as clean SVG.

    python3 tools/make_logo.py     # writes assets/img/mark.svg

The supplied logo raster is 128x106, with the mark itself only ~14x38px —
far too small to scale into a site header or a vial label. The mark is
redrawn here as vector so it stays crisp at any size.

Construction: two tapered ribbons sharing one centreline family, related by
180-degree rotation about the centre. Each ribbon follows a sine S-curve and
carries a width profile that tapers to a point at both tips, swells at the
quarter points and pinches at the waist where the two strokes cross. One
ribbon is copper, the other dark brown, matching the source artwork.

Standard library only.
"""
from __future__ import annotations

import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/img/mark.svg"
FAVICON = ROOT / "assets/img/favicon.svg"

W, H = 100.0, 206.0      # viewBox; matches the source mark's 14:38 proportion
CX = W / 2
AMP = 27.0               # how far each stroke bulges sideways
THICK = 30.0             # maximum ribbon width
STEPS = 140              # enough for a smooth outline without bloating the file

# sampled from the supplied artwork
COPPER_LIGHT = "#F0E3D2"
COPPER_DEEP  = "#A87C52"
DARK_TOP     = "#6B5747"
DARK_DEEP    = "#382E26"


def centreline(t: float, flip: bool) -> tuple[float, float]:
    """S-curve: bulges one way above the waist, the other way below."""
    s = math.sin(2 * math.pi * t)
    x = CX + (AMP * s if flip else -AMP * s)
    return x, t * H


def width(t: float) -> float:
    """Pointed at both tips, widest at the quarters, pinched at the waist."""
    taper = math.sin(math.pi * t) ** 0.5
    swell = 0.25 + 0.75 * abs(math.sin(2 * math.pi * t)) ** 0.8
    return THICK * taper * swell


def ribbon(flip: bool) -> str:
    """Offset the centreline by half the width along its normal."""
    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []
    eps = 1e-4
    for i in range(STEPS + 1):
        t = i / STEPS
        x, y = centreline(t, flip)
        x2, y2 = centreline(min(t + eps, 1.0), flip)
        x1, y1 = centreline(max(t - eps, 0.0), flip)
        dx, dy = x2 - x1, y2 - y1
        n = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / n, dx / n          # unit normal
        h = width(t) / 2
        left.append((x + nx * h, y + ny * h))
        right.append((x - nx * h, y - ny * h))

    pts = left + right[::-1]
    d = "M " + " L ".join(f"{px:.2f} {py:.2f}" for px, py in pts) + " Z"
    return d


def main() -> None:
    copper = ribbon(flip=False)   # bulges left above the waist
    dark = ribbon(flip=True)      # its 180-degree partner

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" role="img" aria-label="Timeless Research">
  <defs>
    <linearGradient id="tr-copper" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="{COPPER_LIGHT}"/>
      <stop offset="0.45" stop-color="#D9BC9A"/>
      <stop offset="1" stop-color="{COPPER_DEEP}"/>
    </linearGradient>
    <linearGradient id="tr-dark" x1="1" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="{DARK_TOP}"/>
      <stop offset="0.5" stop-color="#4A3B2E"/>
      <stop offset="1" stop-color="{DARK_DEEP}"/>
    </linearGradient>
  </defs>
  <path d="{copper}" fill="url(#tr-copper)"/>
  <path d="{dark}" fill="url(#tr-dark)"/>
</svg>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(svg, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}  ({len(svg) // 1024} KB, viewBox {W:.0f}x{H:.0f})")

    # favicon: the same mark, centred on the brand paper tile
    pad = 26.0
    scale = (64.0 - 2 * pad / 2) / H
    fav = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="c" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="{COPPER_LIGHT}"/><stop offset="0.45" stop-color="#D9BC9A"/><stop offset="1" stop-color="{COPPER_DEEP}"/>
    </linearGradient>
    <linearGradient id="d" x1="1" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="{DARK_TOP}"/><stop offset="0.5" stop-color="#4A3B2E"/><stop offset="1" stop-color="{DARK_DEEP}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#F9F8F6"/>
  <g transform="translate({32 - W * scale / 2:.2f} {32 - H * scale / 2:.2f}) scale({scale:.4f})">
    <path d="{copper}" fill="url(#c)"/>
    <path d="{dark}" fill="url(#d)"/>
  </g>
</svg>
"""
    FAVICON.write_text(fav, encoding="utf-8")
    print(f"wrote {FAVICON.relative_to(ROOT)}  ({len(fav) // 1024} KB)")


if __name__ == "__main__":
    main()
