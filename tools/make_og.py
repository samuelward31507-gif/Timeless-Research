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
import json
import math
import pathlib

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/img/og-card.jpg"

W, H = 1200, 630

SECTIONS = [
    ("catalog", "The catalog.", ["Thirty-four compounds across seven research areas,",
                                 "each released against a certificate of analysis."]),
    ("quality", "Analytical programme.", ["Identity, purity, water and counter-ion content,",
                                          "reviewed and signed before a lot is released."]),
    ("about", "About us.", ["A reference-material supplier for institutional",
                            "and qualified-research accounts."]),
    ("faq", "Questions.", ["Accounts, documentation, shipping and storage,",
                           "answered plainly."]),
    ("contact", "Open an account.", ["Verified institutional and qualified-research",
                                     "accounts only."]),
    ("compliance", "Research use policy.", ["The conditions on which material is supplied,",
                                            "and the uses that are prohibited."]),
    ("specimen-coa", "Specimen certificate.", ["A worked example of the document released",
                                               "with every lot."]),
]
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


def print_label(card: Image.Image, vx: int, vy: int, vw: int, vh: int,
                name: str = "BPC-157", dose: str = "5 MG", purity: str = "\u226598%") -> None:
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
    # a long compound name has to shrink to fit rather than run off the label
    size = round(base)
    avail = lw - pad_l - pad_r
    while size > round(base * 0.5):
        f = load_font(700, size)
        if draw.textlength(name, font=f) <= avail:
            break
        size -= 1
    draw_text(draw, (x, y), name, load_font(700, size), INK, round(size * 0.92))

    # Strength: plain and large under the name, matching the site. It used to be
    # drawn in a rounded outline chip; no pharmaceutical vial prints a strength
    # that way, and the card must not disagree with the page it links to.
    f_dose = load_font(700, round(base * 0.82))
    draw.text((x, y + base * 1.02), dose, font=f_dose, fill=INK)

    # release block along the bottom, under a hairline as on the site
    by = ly + lh - base * 1.42
    rule_w = lw * 0.62
    draw.line([(x, by), (x + rule_w, by)], fill=INK_3, width=1)

    f_pill = load_font(600, round(base * 0.45))
    pt = f"Purity {purity}"
    fb_size = round(base * 0.40)
    draw_text(draw, (x, by + base * 0.16), pt, f_pill, INK, fb_size)
    draw.text((x, by + base * 0.74), "Research Use Only",
              font=load_font(500, round(base * 0.41)), fill=INK_3)

    # brand lockup running up the right edge
    f_side = load_font(600, round(base * 0.255))
    strip = Image.new("RGBA", (round(lh * 0.8), round(base * 0.5)), (0, 0, 0, 0))
    tracked(ImageDraw.Draw(strip), (0, 0), "TIMELESS RESEARCH", f_side, INK, base * 0.08)
    strip = strip.rotate(90, expand=True)
    card.paste(strip, (round(lx + lw - pad_r * 0.75), round(ly + lh * 0.1)), strip)


def render(headline: list[str], sub: list[str], label: dict, out: pathlib.Path) -> int:
    """One 1200x630 card. Layout is fixed; only the words and the label change."""
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
    ImageDraw.Draw(shadow).ellipse([pad + 6, 28, pad + vial.width - 6, 62], fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    tint = Image.new("RGB", shadow.size, (28, 26, 23))
    card.paste(tint, (vx - pad, vy + vh - 42), shadow)

    card.paste(vial, (vx, vy), vial)
    print_label(card, vx, vy, vial.width, vh, **label)

    # brand lockup
    draw_mark(card, 110, 96, 62)
    f_brand = load_font(700, 25)
    tracked(draw, (186, 100), "TIMELESS", f_brand, INK, 5.2)
    f_sub = load_font(600, 15)
    tracked(draw, (186, 132), "RESEARCH", f_sub, COPPER, 6.4)

    # headline — size steps down as the line count grows, so three short lines
    # and two long ones both sit in the same optical block
    head_px = {1: 68, 2: 62, 3: 62}.get(len(headline), 52)
    avail = vx - 150
    while head_px > 30:
        f_head = load_font(700, head_px)
        if max(draw.textlength(l, font=f_head) for l in headline) <= avail:
            break
        head_px -= 2
    f_head = load_font(700, head_px)
    top = 236 if len(headline) >= 3 else 268
    for i, line in enumerate(headline):
        draw_text(draw, (110, top + i * (head_px + 8)), line, f_head, INK, round(head_px * 0.92))

    # strapline + compliance line
    f_body = load_font(500, 23)
    for i, line in enumerate(sub):
        draw_text(draw, (110, 470 + i * 30), line, f_body, INK_3, 21)
    f_small = load_font(600, 15)
    draw.line([(110, 548), (150, 548)], fill=COPPER, width=2)
    tracked(draw, (166, 541), "RESEARCH USE ONLY", f_small, COPPER, 2.6)

    out.parent.mkdir(parents=True, exist_ok=True)
    # JPEG rather than PNG: the card is mostly a photograph, and at 1200x630 a
    # lossless encode costs five times the bytes for no visible gain. Every
    # platform that reads og:image accepts JPEG.
    card.save(out, "JPEG", quality=86, optimize=True, progressive=True)
    return out.stat().st_size


def wrap(text: str, per_line: int = 22) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        if cur and len(cur) + 1 + len(word) > per_line:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    if cur:
        lines.append(cur)
    return lines[:3]


def main() -> None:
    total = size = 0

    size += render(["Characterised.", "Documented.", "Released."],
                   ["Analytical-grade peptide reference material",
                    "for institutional laboratories."],
                   {}, OUT)
    total += 1

    # A shared link should preview the thing that was shared, not the home page.
    products = json.loads((ROOT / "assets/data/products.json").read_text())
    products = products if isinstance(products, list) else products.get("products", products)
    for p in products:
        size += render(
            wrap(p["name"], 18),
            [(p.get("synonyms") or [p.get("form", "")])[0][:46],
             f"CAS {p['cas']}" if p.get("cas") else p.get("form", "")],
            {"name": p.get("label") or p["name"], "dose": p["sizes"][0].upper(),
             "purity": p.get("purity", "\u226598%")},
            ROOT / f"assets/img/og/{p['id']}.jpg")
        total += 1

    for slug, head, sub in SECTIONS:
        size += render(wrap(head, 18), sub, {}, ROOT / f"assets/img/og/{slug}.jpg")
        total += 1

    print(f"wrote {total} cards, {size // 1024} KB total")


if __name__ == "__main__":
    main()
