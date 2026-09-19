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

import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Everything the deployed site needs, and nothing else.
TREES = ["assets", "products"]
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

    print(f"dist/  {copied} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
