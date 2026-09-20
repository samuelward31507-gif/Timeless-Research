#!/usr/bin/env python3
"""
Assemble the publishable site into dist/.

    python3 tools/build.py && python3 tools/dist.py

The generator writes pages next to its own source, which is convenient to work
on but wrong to deploy: a host told to publish the repository root would also
serve tools/, README.md and the source photograph. This copies out only what
belongs on the public site, so the publish directory contains the site and
nothing else.
"""
from __future__ import annotations

import html
import pathlib
import re
import shutil
import sys

ATTR = re.compile(r'(?:href|src)="([^"]+)"')

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Everything the deployed site needs, and nothing else.
# `legal` was missing from this list for as long as it existed, so the three
# documents the footer links from every page were never published: the links
# resolved in the repository, where tools/check.py looks, and 404'd on the
# deployed site, where nobody was looking. The link sweep at the end of this
# file is the actual fix — a list like this will go stale again.
TREES = ["assets", "products", "legal"]
FILES = ["sitemap.xml", "robots.txt", "_redirects"]


def main() -> int:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    copied = 0
    for page in sorted(ROOT.glob("*.html")):
        shutil.copy2(page, DIST / page.name)
        copied += 1

    for tree in TREES:
        src = ROOT / tree
        if not src.is_dir():
            print(f"missing directory: {tree} (run tools/build.py first)", file=sys.stderr)
            return 1
        shutil.copytree(src, DIST / tree)
        copied += sum(1 for f in src.rglob("*") if f.is_file())

    for name in FILES:
        src = ROOT / name
        if not src.exists():
            print(f"missing file: {name} (run tools/build.py first)", file=sys.stderr)
            return 1
        shutil.copy2(src, DIST / name)
        copied += 1

    if not (DIST / "index.html").exists():
        print("dist/index.html was not produced", file=sys.stderr)
        return 1

    # Every internal link, resolved inside dist/ rather than inside the
    # repository. tools/check.py walks the source tree, so it cannot see a page
    # that was built correctly and then left out of the publish directory —
    # which is exactly how the legal documents went missing. This is the only
    # check that looks at what is actually about to be served.
    missing = set()
    for page in DIST.rglob("*.html"):
        for raw in ATTR.findall(page.read_text(encoding="utf-8")):
            ref = html.unescape(raw)
            if ref.startswith(("http://", "https://", "mailto:", "data:", "#", "tel:")):
                continue
            target = ref.split("#")[0].split("?")[0]
            if not target:
                continue
            base = DIST if target.startswith("/") else page.parent
            if not (base / target.lstrip("/")).exists():
                missing.add(f"{page.relative_to(DIST)} -> {ref}")

    if missing:
        print(f"{len(missing)} link(s) resolve in the repository but not in dist/:",
              file=sys.stderr)
        for m in sorted(missing):
            print(f"  {m}", file=sys.stderr)
        print("something the site links to was not copied into the publish "
              "directory — check TREES and FILES above", file=sys.stderr)
        return 1

    print(f"dist/  {copied} files, every internal link resolves")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
