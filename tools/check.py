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
import json as _json
import os
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
# The full notice block sits on the home page. Every other page still carries
# research-use-only wording in the announcement bar and the footer, so this
# checks the standing wording site-wide and the block only where it belongs.
NEEDS_NOTICE = {"index.html"}
STANDING_RUO = "research use only"

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
    if STANDING_RUO not in txt.lower():
        fail(f"no research-use-only wording anywhere on {rel}")

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

# ------------------------------------------------- unfilled legal details
# build.py renders a missing legal detail as a visible marker instead of a
# blank. Publishing one is a real fault: the document reads as unfinished to
# the customer and the clause it sits in may not do its job.
# A TR_DEMO=1 build is a showcase without a business behind it, so the fields
# are legitimately unfilled; the demo bar on every page says so. Any other build
# is heading for production and must not carry an unfinished legal document.
DEMO = os.environ.get("TR_DEMO", "").strip() in ("1", "true", "yes")
for page in PAGES:
    rel = page.relative_to(ROOT).as_posix()
    for m in re.findall(r'<mark class="fill-me">([^<]*)</mark>',
                        page.read_text(encoding="utf-8")):
        msg = f"{rel} still needs {m} (set TR_LEGAL_* at build time)"
        notes.append("demo build: " + msg) if DEMO else fail(msg)

# ------------------------------------------------ structured data offers
# The published price and the machine-readable price must agree. A page saying
# $26 while its Product schema says something else, or nothing, is the kind of
# fault nobody sees until a search engine acts on it.
for _page in sorted((ROOT / "products").glob("*.html")):
    _txt = _page.read_text(encoding="utf-8")
    _blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', _txt, re.S)
    _prod = None
    for _b in _blocks:
        try:
            _obj = _json.loads(_b)
        except Exception:
            fail(f"{_page.name}: unparseable ld+json")
            continue
        if _obj.get("@type") == "Product":
            _prod = _obj
    if _prod is None:
        fail(f"{_page.name}: no Product structured data")
        continue
    _off = _prod.get("offers")
    if not _off:
        fail(f"{_page.name}: Product carries no offers")
        continue
    _each = _off.get("offers", [_off]) if _off.get("@type") == "AggregateOffer" else [_off]
    for _o in _each:
        for _k in ("price", "priceCurrency", "availability"):
            if not _o.get(_k):
                fail(f"{_page.name}: offer missing {_k}")
    # the figure rendered on the page must be one of the offered prices
    _shown = re.search(r'data-price-display>\$([\d,]+)', _txt)
    if _shown:
        _v = float(_shown.group(1).replace(",", ""))
        if not any(abs(float(_o["price"]) - _v) < .005 for _o in _each):
            fail(f"{_page.name}: shows ${_v:.0f} but no offer matches")

# ------------------------------------------------------- price coverage
# A pack size offered without a price renders an empty price line and puts a
# priceless item in the cart, which then quietly drops out of the
# subtotal. Cheaper to refuse the build.
_data = _json.loads((ROOT / "assets/data/products.json").read_text(encoding="utf-8"))
for _p in _data.get("products", []):
    _prices = _p.get("prices") or {}
    for _s in _p.get("sizes", []):
        if _s not in _prices:
            fail(f"{_p['id']}: pack size {_s!r} has no price")
    for _s in _prices:
        if _s not in _p.get("sizes", []):
            fail(f"{_p['id']}: price for {_s!r}, which is not an offered size")

# ------------------------------------------- claims the site no longer makes
# The site used to gate ordering behind a verified institutional account. It no
# longer does: the catalogue is bought from the page with a card. Any surviving
# sentence promising a check we do not run is a false statement to a customer
# and a term the operator cannot honour, so it fails the build rather than
# waiting to be noticed.
RETIRED = [
    ("verified account", "claims orders need a verified account"),
    ("verified institutional", "claims institutional verification"),
    ("institutional and qualified-research accounts only", "claims accounts-only supply"),
    ("we do not supply individuals", "claims individuals are refused"),
    ("written order confirmation", "claims a pre-sale written confirmation"),
    ("invitation for us to quote", "describes ordering as a quotation request"),
    ("account verification", "claims an account verification step"),
    ("unverified account", "claims accounts are verified"),
    ("apply for an account", "offers an account application"),
    ("we do not ship to residential", "claims residential addresses are refused"),
    ("add to request list", "offers a request list instead of a cart"),
]
for page in PAGES:
    rel = page.relative_to(ROOT).as_posix()
    low = page.read_text(encoding="utf-8").lower()
    for phrase, why in RETIRED:
        if phrase in low:
            fail(f"{rel}: {why} (\"{phrase}\")")

# ------------------------------------- restricted compounds stay out of the cart
# A restricted compound corresponds to an approved or investigational
# pharmaceutical and is released against a stated protocol, so no page may offer
# to put one in the cart. The checkout function refuses it again server-side;
# this catches the markup before it ships.
_restricted = {_p["id"] for _p in
               _json.loads((ROOT / "assets/data/products.json").read_text(encoding="utf-8"))["products"]
               if _p.get("restricted")}
for page in PAGES:
    rel = page.relative_to(ROOT).as_posix()
    for _id in re.findall(r'data-add="([^"]+)"', page.read_text(encoding="utf-8")):
        if _id in _restricted:
            fail(f"{rel}: restricted compound {_id} carries an add-to-cart control")
if not _restricted:
    notes.append("no compound is marked restricted; the enquiry route is unused")

# --------------------------------------------------- checkout price table
# The function charges from netlify/functions/catalog.json, which build.py
# regenerates from products.json. If the two disagree, the page shows one price
# and the card is charged another.
_fn = ROOT / "netlify/functions/create-checkout-session.js"
_cat = ROOT / "netlify/functions/catalog.json"
if not _fn.exists():
    fail("missing netlify/functions/create-checkout-session.js")
if not _cat.exists():
    fail("missing netlify/functions/catalog.json (run tools/build.py)")
else:
    _c = _json.loads(_cat.read_text(encoding="utf-8"))
    _src = _json.loads((ROOT / "assets/data/products.json").read_text(encoding="utf-8"))
    if _c.get("currency") != _src.get("currency", "USD"):
        fail("checkout catalog currency disagrees with products.json")
    for _p in _src["products"]:
        _entry = _c.get("products", {}).get(_p["id"])
        if _entry is None:
            fail(f"checkout catalog is missing {_p['id']}")
            continue
        _want = not _p.get("restricted") and _p.get("available", True)
        if _entry.get("buyable") is not _want:
            fail(f"checkout catalog marks {_p['id']} buyable={_entry.get('buyable')}, "
                 f"products.json says {_want}")
        for _s, _v in (_p.get("prices") or {}).items():
            if _entry.get("prices", {}).get(_s) != _v:
                fail(f"checkout catalog price for {_p['id']} {_s!r} disagrees with products.json")
    for _pid in _c.get("products", {}):
        if _pid not in {_p["id"] for _p in _src["products"]}:
            fail(f"checkout catalog carries {_pid}, which is not in products.json")

# ------------------------------------------------------------- generated
for extra in ("sitemap.xml", "robots.txt", "assets/img/favicon.svg",
              "assets/data/products.json", "assets/css/main.css",
              "assets/js/site.js", "assets/js/catalog.js", "assets/js/contact.js",
              "assets/css/fonts.css", "order-received.html", "pay.html"):
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
