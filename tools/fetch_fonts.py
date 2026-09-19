#!/usr/bin/env python3
"""
Download the site's webfonts from Google Fonts and write assets/css/fonts.css.

    python3 tools/fetch_fonts.py

Downloads the full faces into tools/fonts-src/, which is not served. Run
tools/subset_fonts.py afterwards to cut them down and write the files the site
actually loads. Both outputs are committed, so a normal build and a normal
deploy never touch the network. Self-hosting is not
only a performance choice: fetching fonts from a third party sends every
visitor's IP address to that third party on every page load, which is a
disclosure the privacy policy would otherwise have to carry.
"""
from __future__ import annotations

import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "tools/fonts-src"
CSS = ROOT / "assets/css/fonts.css"

# A browser UA is required, or Google serves the ttf stylesheet for old clients.
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/120.0.0.0 Safari/537.36")

# Inter and Cormorant Garamond are served as variable fonts, so one file covers
# a whole weight range: five static Inter cuts become one, and a real italic
# arrives with it. The site was synthesising Inter's italic before, which is a
# sheared upright, not a typeface. Barlow Semi Condensed has no variable version
# on Google, so its three weights stay static.
FAMILIES = [
    ("Barlow Semi Condensed", "barlow-semi-condensed",
     "Barlow+Semi+Condensed:wght@500;600;700"),
    ("Cormorant Garamond", "cormorant-garamond",
     "Cormorant+Garamond:ital,wght@0,300..400;1,300..400"),
    ("Inter", "inter", "Inter:ital,wght@0,300..700;1,300..700"),
]

HEADER = """/* Self-hosted webfonts. Regenerate with tools/fetch_fonts.py.

   Three reasons these are not loaded from Google:

   1. The vial label's type sizing is calibrated to Barlow Semi Condensed's
      metrics, so a failed webfont load does not merely look different — a
      wider fallback overruns the label.
   2. A third-party font request puts two extra origins on the critical path
      of every page: a DNS lookup, a TLS handshake and a stylesheet before a
      single glyph is requested.
   3. It sends every visitor's IP address to a third party on every page load,
      which is a disclosure the privacy policy would otherwise have to carry.

   Subset: latin. Unicode ranges are Google's own, preserved so the browser
   still skips a file it has no glyphs for. */
"""


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    blocks, saved = [HEADER], 0

    for label, slug, spec in FAMILIES:
        css = fetch(f"https://fonts.googleapis.com/css2?family={spec}&display=swap").decode()
        # Google emits one @font-face per (style, weight, subset); keep latin only.
        for face in re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S):
            subset, block = face
            if subset != "latin":
                continue
            weight = re.search(r"font-weight:\s*([\d ]+?)\s*;", block).group(1)
            style = re.search(r"font-style:\s*(\w+)", block).group(1)
            variable = " " in weight
            rng = re.search(r"unicode-range:\s*([^;]+);", block).group(1).strip()
            src = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)

            stem = "var" if variable else weight
            name = f"{slug}-{stem}{'-italic' if style == 'italic' else ''}-latin.woff2"
            data = fetch(src)
            (OUT_DIR / name).write_bytes(data)
            saved += 1
            print(f"  {name:48s} {len(data)/1024:6.1f} KB")

            blocks.append(
                "@font-face {\n"
                f"  font-family: '{label}';\n"
                f"  font-style: {style};\n"
                f"  font-weight: {weight};\n"
                "  font-display: swap;\n"
                f"  src: url('../fonts/{name}') format('woff2');\n"
                f"  unicode-range: {rng};\n"
                "}"
            )

    if saved == 0:
        print("no faces written — refusing to overwrite fonts.css", file=sys.stderr)
        return 1

    CSS.write_text("\n".join(blocks) + "\n", encoding="utf-8")
    total = sum(f.stat().st_size for f in OUT_DIR.glob("*.woff2"))
    print(f"\n{saved} faces, {total/1024:.0f} KB total -> {OUT_DIR.relative_to(ROOT)}")
    print("now run: python3 tools/subset_fonts.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
