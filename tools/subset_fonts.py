#!/usr/bin/env python3
"""
Cut the self-hosted webfonts down to the glyphs this site actually renders.

    python3 tools/build.py && python3 tools/subset_fonts.py

Google's "latin" subset carries far more than these pages use, and the site
loads twelve faces, so the full set costs more than four hundred kilobytes of
font on a first visit. The pages are generated, so the exact character set is
knowable at build time; this keeps those glyphs plus a conservative safety
margin and drops the rest.

The margin matters: an operator editing a product name must not discover a
missing glyph. Every printable ASCII and Latin-1 character is kept whether the
current copy uses it or not, so ordinary edits are always covered. Adding
genuinely new symbols means re-running this.
"""
from __future__ import annotations

import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "tools/fonts-src"
OUT_DIR = ROOT / "assets/fonts"
SKIP_DIRS = {"dist", "node_modules", ".claude"}

TAG = re.compile(r"<(script|style)\b.*?</\1>|<[^>]+>", re.S | re.I)
ENTITY = re.compile(r"&(#\d+|#x[0-9a-fA-F]+|\w+);")
ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'",
            "nbsp": " ", "times": "×", "copy": "©",
            "deg": "°", "mdash": "—", "ndash": "–"}


def unescape(m: re.Match) -> str:
    e = m.group(1)
    if e.startswith("#x"):
        return chr(int(e[2:], 16))
    if e.startswith("#"):
        return chr(int(e[1:]))
    return ENTITIES.get(e, " ")


def site_charset() -> set[str]:
    chars: set[str] = set()
    for page in ROOT.rglob("*.html"):
        if SKIP_DIRS & set(page.parts):
            continue
        text = TAG.sub(" ", page.read_text(encoding="utf-8"))
        chars |= set(ENTITY.sub(unescape, text))
    # JSON data can reach the page through the catalog script.
    for data in (ROOT / "assets/data").glob("*.json"):
        chars |= set(data.read_text(encoding="utf-8"))
    return chars


def main() -> int:
    if not any(SRC_DIR.glob("*.woff2")):
        print("no source fonts — run tools/fetch_fonts.py first", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Safety margin: anything an ordinary copy edit could introduce.
    keep = {chr(c) for c in range(0x20, 0x7F)}                  # printable ASCII
    keep |= {chr(c) for c in range(0xA0, 0x100)}                # Latin-1 supplement
    keep |= set("‘’“”–—…•·°×÷±≤≥≈→←↑↓™®©αβγδμΩ†‡′″€£¥")
    keep |= site_charset()
    keep = {c for c in keep if c.isprintable() or c == " "}

    before = after = 0
    for path in sorted(SRC_DIR.glob("*.woff2")):
        size_in = path.stat().st_size
        before += size_in

        font = TTFont(str(path))
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.desubroutinize = True
        opts.layout_features = ["kern", "liga", "clig", "calt", "ccmp",
                                "locl", "mark", "mkmk", "tnum", "onum"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        s = subset.Subsetter(options=opts)
        s.populate(unicodes={ord(c) for c in keep})
        s.subset(font)
        font.flavor = "woff2"
        out = OUT_DIR / path.name
        font.save(str(out))
        font.close()

        size_out = out.stat().st_size
        after += size_out
        print(f"  {path.name:44s} {size_in/1024:6.1f} -> {size_out/1024:6.1f} KB")

    print(f"\n{len(keep)} glyphs kept   {before/1024:.0f} KB -> {after/1024:.0f} KB "
          f"({100 - after * 100 / before:.0f}% smaller)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
