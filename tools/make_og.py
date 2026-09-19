#!/usr/bin/env python3
"""
Generate the social sharing card (assets/img/og-card.png, 1200x630).

    python3 tools/make_og.py

Before this existed, og:image pointed at the raw studio photograph: 831 KB,
shot on black, and nothing like the site it represents. This composes a card
from the same pieces the site is built from — the flame mark, the wordmark and
the matted vial — so a shared link previews as the brand rather than a stock
product shot.

Everything is drawn from committed assets, so the card is reproducible offline:
the mark is redrawn with the same parametric geometry as tools/make_logo.py,
and the type comes from the self-hosted woff2 in assets/fonts/.

Requires: pillow, fonttools, brotli
"""
from __future__ import annotations

import io
import math
import pathlib

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/img/og-card.png"

W, H = 1200, 630
PAPER = (250, 249, 247)
INK = (28, 26, 23)
INK_3 = (92, 87, 78)
COPPER = (168, 124, 82)

# mark geometry, matching tools/make_logo.py
MARK_W, MARK_H, AMP, THICK, STEPS = 100.0, 206.0, 27.0, 30.0, 140
COPPER_RAMP = ((240, 227, 210), (217, 188, 154), (168, 124, 82))
DARK_RAMP = ((107, 87, 71), (74, 59, 46), (56, 46, 38))


# Barlow ships no maths or Greek glyphs. The browser falls back per glyph; the
# same is done here so the card matches the site instead of drawing tofu boxes.
_FALLBACK_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arial.ttf",
)


def _brand_cmap() -> set:
    return set(TTFont(ROOT / "assets/fonts/barlow-semi-condensed-700-latin.woff2").getBestCmap())


_BRAND_GLYPHS = None


def fallback_font(size: int) -> ImageFont.FreeTypeFont:
    for path in _FALLBACK_CANDIDATES:
        if pathlib.Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit(
        "No fallback font found for glyphs Barlow lacks (\u2265, \u03b1). "
        "Install DejaVu or Liberation, or extend _FALLBACK_CANDIDATES."
    )


def draw_text(draw: ImageDraw.ImageDraw, xy, text: str, font, fill, fb_size: int) -> float:
    """Draw text, switching to a fallback font for glyphs the brand face lacks."""
    global _BRAND_GLYPHS
    if _BRAND_GLYPHS is None:
        _BRAND_GLYPHS = _brand_cmap()
    x, y = xy
    fb = None
    for ch in text:
        use = font
        if ch != " " and ord(ch) not in _BRAND_GLYPHS:
            fb = fb or fallback_font(fb_size)
            use = fb
        draw.text((x, y), ch, font=use, fill=fill)
        x += draw.textlength(ch, font=use)
    return x - xy[0]


def load_font(weight: int, size: int) -> ImageFont.FreeTypeFont:
    """Pillow cannot open woff2 directly; convert in memory."""
    src = ROOT / f"assets/fonts/barlow-semi-condensed-{weight}-latin.woff2"
    tt = TTFont(src)
    buf = io.BytesIO()
    tt.flavor = None
    tt.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def _ribbon(flip: bool) -> list[tuple[float, float]]:
    def centre(t: float) -> tuple[float, float]:
        s = math.sin(2 * math.pi * t)
        return MARK_W / 2 + (AMP * s if flip else -AMP * s), t * MARK_H

    def width(t: float) -> float:
        return THICK * (math.sin(math.pi * t) ** 0.5) * (
            0.25 + 0.75 * abs(math.sin(2 * math.pi * t)) ** 0.8)

    left, right, eps = [], [], 1e-4
    for i in range(STEPS + 1):
        t = i / STEPS
        x, y = centre(t)
        x2, y2 = centre(min(t + eps, 1.0))
        x1, y1 = centre(max(t - eps, 0.0))
        dx, dy = x2 - x1, y2 - y1
        n = math.hypot(dx, dy) or 1.0
        nx, ny, h = -dy / n, dx / n, width(t) / 2
        left.append((x + nx * h, y + ny * h))
        right.append((x - nx * h, y - ny * h))
    return left + right[::-1]


def _gradient(size: tuple[int, int], ramp) -> Image.Image:
    """Vertical three-stop gradient."""
    w, h = size
    top, mid, bottom = ramp
    grad = Image.new("RGB", (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        a, b, k = (top, mid, t / 0.5) if t < 0.5 else (mid, bottom, (t - 0.5) / 0.5)
        px[0, y] = tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))
    return grad.resize((w, h))


def draw_mark(canvas: Image.Image, x: int, y: int, height: int) -> None:
    scale = height / MARK_H
    w = round(MARK_W * scale)
    for ribbon, ramp in ((_ribbon(False), COPPER_RAMP), (_ribbon(True), DARK_RAMP)):
        ss = 4  # supersample, so the curve edges stay smooth
        mask = Image.new("L", (w * ss, height * ss), 0)
        ImageDraw.Draw(mask).polygon(
            [(px * scale * ss, py * scale * ss) for px, py in ribbon], fill=255)
        mask = mask.resize((w, height), Image.LANCZOS)
        canvas.paste(_gradient((w, height), ramp), (x, y), mask)


def tracked(draw: ImageDraw.ImageDraw, xy, text, font, fill, tracking: float) -> int:
    """Pillow has no letter-spacing; step glyph by glyph."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return round(x - tracking)


def print_label(card: Image.Image, vx: int, vy: int, vw: int, vh: int) -> None:
    """Print the label onto the vial.

    The site draws this as a DOM layer over the photograph, so the asset itself
    carries a blank label. Left as-is the card shows an unbranded vial, so the
    same geometry is reproduced here — measured from the asset's alpha channel
    by tools/make_vial.py.
    """
    draw = ImageDraw.Draw(card)
    lx, ly = vx + 0.1145 * vw, vy + 0.3977 * vh
    lw, lh = 0.8241 * vw, 0.4170 * vh
    base = vh * 0.058
    pad_l, pad_r, pad_t = 0.085 * vw, 0.11 * vw, 0.065 * vw

    x, y = lx + pad_l, ly + pad_t
    draw.text((x, y), "BPC-157", font=load_font(700, round(base)), fill=INK)

    # pack size, in an outlined pill
    f_dose = load_font(600, round(base * 0.34))
    dy = y + base * 1.15
    tw = draw.textlength("5 MG", font=f_dose)
    draw.rounded_rectangle([x, dy, x + tw + base * 0.42, dy + base * 0.52],
                           radius=base * 0.26, outline=INK, width=1)
    draw.text((x + base * 0.21, dy + base * 0.1), "5 MG", font=f_dose, fill=INK)

    # purity pill and research line along the bottom
    f_pill = load_font(500, round(base * 0.34))
    by = ly + lh - base * 1.5
    pt = "Purity \u226598%"
    fb_size = round(base * 0.30)
    probe = Image.new("RGB", (1, 1))
    pw = draw_text(ImageDraw.Draw(probe), (0, 0), pt, f_pill, INK, fb_size)
    draw.rounded_rectangle([x, by, x + pw + base * 0.42, by + base * 0.52],
                           radius=base * 0.26, outline=INK, width=1)
    draw_text(draw, (x + base * 0.21, by + base * 0.1), pt, f_pill, INK, fb_size)
    draw.text((x, by + base * 0.72), "Research Use Only",
              font=load_font(500, round(base * 0.3)), fill=INK_3)

    # brand lockup running up the right edge
    f_side = load_font(600, round(base * 0.255))
    strip = Image.new("RGBA", (round(lh * 0.8), round(base * 0.5)), (0, 0, 0, 0))
    tracked(ImageDraw.Draw(strip), (0, 0), "TIMELESS RESEARCH", f_side, INK, base * 0.08)
    strip = strip.rotate(90, expand=True)
    card.paste(strip, (round(lx + lw - pad_r * 0.75), round(ly + lh * 0.1)), strip)


def main() -> None:
    card = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(card)

    # vial on the right, with a contact shadow so it sits on the surface
    vial = Image.open(ROOT / "assets/img/vial.png").convert("RGBA")
    vh = 500
    vial = vial.resize((round(vial.width * vh / vial.height), vh), Image.LANCZOS)
    vx, vy = W - vial.width - 110, (H - vh) // 2

    # one soft ellipse, blurred; stacking hard ellipses left visible banding
    pad = 40
    shadow = Image.new("L", (vial.width + pad * 2, 90), 0)
    ImageDraw.Draw(shadow).ellipse(
        [pad + 6, 28, pad + vial.width - 6, 62], fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    tint = Image.new("RGB", shadow.size, (28, 26, 23))
    card.paste(tint, (vx - pad, vy + vh - 42), shadow)

    card.paste(vial, (vx, vy), vial)
    print_label(card, vx, vy, vial.width, vh)

    # brand lockup
    draw_mark(card, 110, 96, 62)
    f_brand = load_font(700, 25)
    end = tracked(draw, (186, 100), "TIMELESS", f_brand, INK, 5.2)
    f_sub = load_font(600, 15)
    tracked(draw, (186, 132), "RESEARCH", f_sub, COPPER, 6.4)

    # headline
    f_head = load_font(700, 62)
    draw.text((110, 236), "Characterised.", font=f_head, fill=INK)
    draw.text((110, 306), "Documented.", font=f_head, fill=INK)
    draw.text((110, 376), "Released.", font=f_head, fill=INK)

    # strapline + compliance line
    f_body = load_font(500, 23)
    draw.text((110, 470), "Analytical-grade peptide reference material", font=f_body, fill=INK_3)
    draw.text((110, 500), "for institutional laboratories.", font=f_body, fill=INK_3)
    f_small = load_font(600, 15)
    draw.line([(110, 548), (150, 548)], fill=COPPER, width=2)
    tracked(draw, (166, 541), "RESEARCH USE ONLY", f_small, COPPER, 2.6)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    card.save(OUT, optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)}  {card.size}  {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
