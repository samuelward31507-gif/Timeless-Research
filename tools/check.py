#!/usr/bin/env python3
"""
Structural checks over the generated site. Standard library only, no server
and no browser required.

    python3 tools/check.py

Verifies: internal links resolve, no unresolved template placeholders, every
page has the required landmarks and metadata, images carry alt text, form
controls are labelled, and the compliance notice is present on key pages.
Exits non-zero if anything fails, so it can gate a deploy.
"""
from __future__ import annotations

import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# dist/ is a copy of these same pages assembled for deployment; checking it
# too would double every count and report every fault twice.
SKIP_DIRS = {".claude", "dist", "node_modules"}
PAGES = sorted(p for p in ROOT.rglob("*.html") if not SKIP_DIRS & set(p.parts))

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


# --------------------------------------------------------------- links
ATTR = re.compile(r'(?:href|src)="([^"]+)"')
checked = 0
for page in PAGES:
    txt = page.read_text(encoding="utf-8")
    for raw in ATTR.findall(txt):
        ref = html.unescape(raw)
        if ref.startswith(("http://", "https://", "mailto:", "data:", "#", "tel:")):
            continue
        target = ref.split("#")[0].split("?")[0]
        if not target:
            continue
        checked += 1
        base = ROOT if target.startswith("/") else page.parent
        if not (base / target.lstrip("/")).resolve().exists():
            fail(f"broken link  {page.relative_to(ROOT)} -> {ref}")

# --------------------------------------------------------- per-page rules
NEEDS_NOTICE = {"index.html", "catalog.html", "quality.html", "about.html",
                "faq.html", "contact.html", "compliance.html"}

for page in PAGES:
    rel = page.relative_to(ROOT).as_posix()
    txt = page.read_text(encoding="utf-8")

    if "{PREFIX}" in txt or "{p}" in txt:
        fail(f"unresolved placeholder in {rel}")
    if "<title>" not in txt:
        fail(f"missing <title> in {rel}")
    if 'name="description"' not in txt:
        fail(f"missing meta description in {rel}")
    if 'rel="canonical"' not in txt:
        fail(f"missing canonical link in {rel}")
    if "<main" not in txt:
        fail(f"missing <main> landmark in {rel}")
    if "skip-link" not in txt:
        fail(f"missing skip link in {rel}")
    if txt.count("<h1") > 1:
        fail(f"more than one <h1> in {rel}")

    for img in re.findall(r"<img\b[^>]*>", txt):
        if "alt=" not in img:
            fail(f"<img> without alt in {rel}: {img[:70]}")

    # every input/select/textarea needs a label, aria-label or aria-labelledby
    for ctrl in re.findall(r'<(?:input|select|textarea)\b[^>]*>', txt):
        if re.search(r'type="(hidden|submit|button)"', ctrl):
            continue
        cid = re.search(r'id="([^"]+)"', ctrl)
        # explicit (for=), ARIA, or implicit (control wrapped in its <label>)
        wrapped = False
        pos = txt.find(ctrl)
        if pos != -1:
            before = txt.rfind("<label", 0, pos)
            if before != -1 and txt.find("</label>", before) > pos:
                wrapped = True
        labelled = ("aria-label" in ctrl or "aria-labelledby" in ctrl or wrapped
                    or (cid and f'for="{cid.group(1)}"' in txt))
        if not labelled:
            fail(f"unlabelled form control in {rel}: {ctrl[:70]}")

    if rel in NEEDS_NOTICE and "For laboratory research use only" not in txt:
        fail(f"compliance notice missing from {rel}")

# ------------------------------------------------------- claims hygiene
# The site must not publish dosing guidance or human-use framing.
BANNED = [
    (r"\bdosage\b", "dosing language"),
    (r"\bhow to (?:use|take|inject)\b", "administration guidance"),
    (r"\bfor human (?:use|consumption)\b(?!\s*,? *(?:food|or))", "human-use framing"),
    (r"\bcures?\b|\btreats\s+(?:your|the\s+\w+\s+condition)", "therapeutic claim"),
]
for page in PAGES:
    low = page.read_text(encoding="utf-8").lower()
    for pattern, label in BANNED:
        if re.search(pattern, low):
            # "not for human use" phrasing is expected; flag for review only
            notes.append(f"review {page.relative_to(ROOT).as_posix()}: possible {label}")

# --------------------------------------------------- button colour isolation
# A descendant rule like `.prose a { color: ... }` beats `.btn--primary` on
# specificity, so a button placed inside that container gets repainted — once
# badly enough that the label came out the same colour as its own background.
# Any such rule that sets a colour must therefore exclude buttons.
CSS = (ROOT / "assets/css/main.css").read_text(encoding="utf-8")
CSS = re.sub(r"/\*.*?\*/", "", CSS, flags=re.S)
LAST_A = re.compile(r"\s(a(?::[\w-]+(?:\([^)]*\))?|\[[^\]]*\])*)$")

for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", CSS):
    if not re.search(r"(?:^|;)\s*color\s*:", body):
        continue
    for sel in selectors.split(","):
        sel = sel.strip()
        m = LAST_A.search(sel)
        if m and ":not(.btn)" not in m.group(1):
            fail(f"CSS rule `{sel}` colours descendant links without excluding .btn")

# ------------------------------------------------------------- generated
for extra in ("sitemap.xml", "robots.txt", "assets/img/favicon.svg",
              "assets/data/products.json", "assets/css/main.css",
              "assets/js/site.js", "assets/js/catalog.js", "assets/js/contact.js",
              "assets/css/fonts.css"):
    if not (ROOT / extra).exists():
        fail(f"missing generated asset: {extra}")

# ----------------------------------------------------------------- report
print(f"pages checked      {len(PAGES)}")
print(f"internal links     {checked}")
if notes:
    print(f"\nnotes ({len(notes)}):")
    for n in notes[:20]:
        print("  ", n)
if failures:
    print(f"\nFAILURES ({len(failures)}):")
    for f in failures:
        print("  ", f)
    sys.exit(1)
print("\nall structural checks passed")
