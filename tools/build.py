#!/usr/bin/env python3
"""
Static site generator for Timeless Research.

Reads assets/data/products.json and writes every page in the site so that
shared chrome (header, footer, compliance notice) can never drift between
pages. No third-party dependencies — standard library only.

    python3 tools/build.py
"""
from __future__ import annotations

import html
import json
import os
import pathlib
import re
import shutil
import struct
import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "assets/data/products.json").read_text(encoding="utf-8"))
PRODUCTS = DATA["products"]
CATEGORIES = DATA["categories"]
CURRENCY = DATA.get("currency", "USD")
CAT_LABEL = {c["id"]: c["label"] for c in CATEGORIES}
CAT_TINT = {c["id"]: (c["tint"], c["tintDeep"]) for c in CATEGORIES}

# ---------------------------------------------------------------- deployment
# Everything environment-specific lives here and nowhere else. Each can be
# overridden at build time, so a deploy does not mean editing source:
#     TR_SITE=https://example.com TR_FORM_ENDPOINT=https://... python3 tools/build.py
SITE = os.environ.get("TR_SITE", "https://www.timelessresearch.com").rstrip("/")
CONTACT_EMAIL = os.environ.get("TR_CONTACT_EMAIL", "accounts@timelessresearch.com")
# Where the contact form POSTs. Empty means no endpoint is wired: the form then
# shows the enquiry on screen with a copy button, rather than relying on a
# mailto: that silently does nothing when no mail client is configured.
FORM_ENDPOINT = os.environ.get("TR_FORM_ENDPOINT", "")
# "netlify" posts to Netlify Forms (no endpoint needed); "endpoint" posts JSON
# to TR_FORM_ENDPOINT; anything else leaves the form on its manual fallback.
FORM_PROVIDER = os.environ.get("TR_FORM_PROVIDER", "netlify")
# Raw <head> markup for an analytics tag. Deliberately empty: adding one is a
# decision with a privacy-policy consequence, so it is opt-in per deploy.
ANALYTICS_HEAD = os.environ.get("TR_ANALYTICS_HEAD", "")

BRAND = "Timeless Research"
TODAY = datetime.date.today().isoformat()

# Identity used in the legal documents. These have to be the real trading
# details: a fabricated address or registration number would make the documents
# false, which is worse than not publishing them. Anything left unset renders as
# a visible fill-in marker on the page rather than as a silent blank, and
# tools/check.py reports it, so an incomplete document cannot ship unnoticed.
LEGAL_ENTITY = os.environ.get("TR_LEGAL_ENTITY", BRAND)
LEGAL_ADDRESS = os.environ.get("TR_LEGAL_ADDRESS", "")
LEGAL_STATE = os.environ.get("TR_LEGAL_STATE", "")
LEGAL_EMAIL = os.environ.get("TR_LEGAL_EMAIL", "") or CONTACT_EMAIL

# TR_DEMO=1 builds a showcase copy: one shown to a prospective operator before
# it has a business behind it. It says so on every page and asks search engines
# to stay away, because an unattended peptide storefront that looks open for
# business will be found by people trying to place real orders, and because a
# demo competing in search with the eventual live site helps nobody.
DEMO = os.environ.get("TR_DEMO", "").strip() in ("1", "true", "yes")


def fill(value: str, label: str) -> str:
    """A configured legal detail, or a template field where one is still needed.

    Reads as a field the operator fills, not as a fault, because the site is
    shown to prospective operators before it is configured. tools/check.py is
    what actually stops an unconfigured document reaching production.
    """
    return E(value) if value else f'<mark class="fill-me">{E(label)}</mark>'


NAV = [
    ("Catalog", "catalog.html"),
    ("Analytical", "quality.html"),
    ("About", "about.html"),
    ("FAQ", "faq.html"),
    ("Contact", "contact.html"),
]

E = html.escape


def rel(depth: int) -> str:
    return "../" * depth


# --------------------------------------------------------------------------- chrome
# A shared link should preview the page that was shared. tools/make_og.py writes
# one card per product and one per section; anything without its own card falls
# back to the general one.
OG_SECTIONS = {"catalog", "quality", "about", "faq", "contact", "compliance",
               "specimen-coa"}


def jsonld(obj) -> str:
    return ('<script type="application/ld+json">'
            + json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
            + "</script>")


def breadcrumbs(trail) -> str:
    """trail: [(name, canonical-or-None)], innermost last."""
    return jsonld({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": name,
             **({"item": f"{SITE}/{href}"} if href else {})}
            for i, (name, href) in enumerate(trail)],
    })


ORGANISATION = None  # built lazily so SITE/BRAND are resolved


def organisation() -> str:
    return jsonld({
        "@context": "https://schema.org", "@type": "Organization",
        "name": BRAND, "url": f"{SITE}/", "logo": f"{SITE}/assets/img/mark.svg",
        "description": "Supplier of analytical-grade peptide reference material "
                       "to institutional and qualified-research accounts.",
        "email": CONTACT_EMAIL,
        "contactPoint": [{"@type": "ContactPoint", "contactType": "sales",
                          "email": CONTACT_EMAIL, "areaServed": "US"}],
    })


def og_image(canonical: str) -> str:
    stem = canonical.rsplit("/", 1)[-1].removesuffix(".html")
    if canonical.startswith("products/"):
        return f"assets/img/og/{stem}.jpg"
    if stem in OG_SECTIONS:
        return f"assets/img/og/{stem}.jpg"
    return "assets/img/og-card.jpg"


def head(title, desc, depth, canonical, extra=""):
    p = rel(depth)
    robots = "noindex,nofollow" if DEMO else "index,follow"
    og = og_image(canonical)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}</title>
<meta name="description" content="{E(desc)}">
<link rel="canonical" href="{SITE}/{canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{BRAND}">
<meta property="og:title" content="{E(title)}">
<meta property="og:description" content="{E(desc)}">
<meta property="og:url" content="{SITE}/{canonical}">
<meta property="og:image" content="{SITE}/{og}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:image" content="{SITE}/{og}">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="{robots}">
<meta name="theme-color" content="#FAF9F7">
<link rel="icon" href="{p}assets/img/favicon.svg" type="image/svg+xml">
<link rel="preload" href="{p}assets/fonts/inter-var-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="{p}assets/fonts/cormorant-garamond-var-latin.woff2" as="font" type="font/woff2" crossorigin>
<script>document.documentElement.className+=" js";</script>
{ANALYTICS_HEAD}<script src="{p}assets/js/config.js"></script>
<link rel="stylesheet" href="{p}assets/css/fonts.css">
<link rel="stylesheet" href="{p}assets/css/main.css">
<script src="{p}assets/js/site.js" defer></script>
{extra}</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
"""


def header(depth, active, canonical=""):
    p = rel(depth)
    CUR = ' aria-current="page"'
    links = "".join(
        '<a href="{}{}"{}>{}</a>'.format(
            p, href, CUR if href == active else "", E(label))
        for label, href in NAV
    )
    demo = """<div class="demo-bar">
  <div class="shell">
    <strong>Demonstration site.</strong>
    <span>Not a trading business. Nothing here can be ordered, and no enquiry sent through this site reaches a supplier.</span>
  </div>
</div>
""" if DEMO else ""
    return f"""{demo}<div class="announce">
  <div class="shell">
    <span><b>Research use only.</b> Not for human or veterinary use.</span>
    <span>Institutional and qualified-research accounts only</span>
    <span>COA issued with every lot</span>
  </div>
</div>
<header class="header" id="header">
  <div class="shell">
    <a class="brand" href="{p}index.html" aria-label="{BRAND} — home">
      <img class="brand-mark" src="{p}assets/img/mark.svg" alt="" width="100" height="206">
      <span class="brand-text">Timeless<em>Research</em></span>
    </a>
    <nav class="nav" id="nav" aria-label="Primary">{links}</nav>
    <div class="header-actions">
      <button class="btn btn--ghost btn--sm rfq-btn" id="rfq-open" aria-haspopup="dialog" aria-label="Request list">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
        <span class="rfq-label">Request list</span><span class="rfq-count" id="rfq-count" aria-live="polite">0</span>
      </button>
      <button class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav" aria-label="Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
    </div>
  </div>
</header>
<main id="main" data-print-src="{SITE}/{canonical}">
"""


def footer(depth):
    p = rel(depth)
    cat_links = "".join(
        f'<li><a href="{p}catalog.html#{c["id"]}">{E(c["label"])}</a></li>' for c in CATEGORIES[:5]
    )
    return f"""</main>
<footer class="footer">
  <div class="shell">
    <div class="footer-grid">
      <div>
        <a class="brand" href="{p}index.html">
          <img class="brand-mark" src="{p}assets/img/mark.svg" alt="" width="100" height="206">
          <span class="brand-text">Timeless<em>Research</em></span>
        </a>
        <p class="footer-note">Analytical-grade peptide reference material for institutional and qualified research programmes. Every lot ships with a certificate of analysis.</p>
      </div>
      <div>
        <h3>Catalog</h3>
        <ul>{cat_links}<li><a href="{p}catalog.html">All compounds</a></li></ul>
      </div>
      <div>
        <h3>Company</h3>
        <ul>
          <li><a href="{p}about.html">About</a></li>
          <li><a href="{p}quality.html">Analytical programme</a></li>
          <li><a href="{p}faq.html">FAQ</a></li>
          <li><a href="{p}contact.html">Contact</a></li>
        </ul>
      </div>
      <div>
        <h3>Legal</h3>
        <ul>
          <li><a href="{p}compliance.html">Research use policy</a></li>
          <li><a href="{p}legal/terms.html">Terms of sale</a></li>
          <li><a href="{p}legal/privacy.html">Privacy</a></li>
          <li><a href="{p}legal/shipping.html">Shipping &amp; returns</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; {datetime.date.today().year} {BRAND}. All rights reserved.</span>
      <span>Products are supplied for laboratory research use only. Not for human or veterinary use, food, or household use.</span>
    </div>
  </div>
</footer>

<div class="drawer-scrim" id="rfq-scrim"></div>
<aside class="drawer" id="rfq-drawer" role="dialog" aria-modal="true" aria-labelledby="rfq-title" aria-hidden="true">
  <div class="drawer-head">
    <h2 id="rfq-title">Request list</h2>
    <button class="btn btn--quiet btn--sm" id="rfq-close" aria-label="Close request list">Close</button>
  </div>
  <div class="drawer-body" id="rfq-body"></div>
  <div class="drawer-foot" id="rfq-foot" hidden>
    <a class="btn btn--primary btn--block" href="{p}contact.html?rfq=1" id="rfq-submit">Continue to quote request</a>
    <button class="btn btn--quiet btn--sm btn--block" id="rfq-clear" style="margin-top:.5rem">Clear list</button>
  </div>
</aside>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

</body>
</html>
"""


def page(path, title, desc, body, active="", extra_head="", extra_body=""):
    depth = path.count("/")
    out = ROOT / path
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = head(title, desc, depth, path, extra_head) + header(depth, active, path) + body + extra_body + footer(depth)
    out.write_text(doc, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- pieces
def money(v) -> str:
    """Whole dollars: every list price is a round figure, and ".00" on a
    catalogue of thirty is noise."""
    return f"${v:,.0f}" if float(v) == int(v) else f"${v:,.2f}"


def size_options(p) -> str:
    """Pack-size options carrying their own price, so the displayed price can
    follow the selection without a lookup table in the page."""
    out = []
    for s in p["sizes"]:
        price = (p.get("prices") or {}).get(s)
        attr = f' data-price="{price}"' if price is not None else ""
        label = f"{s} — {money(price)}" if price is not None else s
        out.append(f'<option value="{E(s)}"{attr}>{E(label)}</option>')
    return "".join(out)


def offers_for(p) -> dict:
    """schema.org offers built from the same price table the page renders.

    Without these the published price is invisible to a search engine: the page
    says $26 and the machine-readable product says nothing at all. One Offer per
    pack size, wrapped in an AggregateOffer where there is more than one.

    Availability comes from the product record rather than being hardcoded, so
    marking something out of stock is a data edit, not a code change. A stale
    in-stock claim is worse than no claim.
    """
    prices = p.get("prices") or {}
    if not prices:
        return {}
    avail = ("https://schema.org/InStock" if p.get("available", True)
             else "https://schema.org/OutOfStock")
    url = f"{SITE}/products/{p['id']}.html"
    each = [{
        "@type": "Offer",
        "name": f"{p['name']}, {size}",
        "sku": f"{p['id']}-{size.replace(' ', '').replace('x', 'x')}",
        "price": f"{prices[size]:.2f}",
        "priceCurrency": CURRENCY,
        "availability": avail,
        "itemCondition": "https://schema.org/NewCondition",
        "url": url,
        "seller": {"@type": "Organization", "name": BRAND},
    } for size in p["sizes"] if size in prices]

    if len(each) == 1:
        return {"offers": each[0]}
    vals = [prices[s] for s in p["sizes"] if s in prices]
    return {"offers": {
        "@type": "AggregateOffer",
        "priceCurrency": CURRENCY,
        "lowPrice": f"{min(vals):.2f}",
        "highPrice": f"{max(vals):.2f}",
        "offerCount": len(each),
        "availability": avail,
        "offers": each,
    }}


def initial_price(p) -> str:
    """The price of the pack size the selector starts on.

    Not a "from" figure: a size is always selected, and the JS replaces this
    with the selected size's price on change, so the two must agree at load.
    """
    price = (p.get("prices") or {}).get(p["sizes"][0])
    return money(price) if price is not None else ""


def label_name(name: str) -> str:
    """Keep parenthetical qualifiers on one line.

    Plain wrapping breaks "CJC-1295 (no DAC)" after "(no", which reads as a
    typo on a label. Spaces inside brackets become non-breaking so the
    qualifier travels as a unit.
    """
    return re.sub(r"\(([^)]*)\)", lambda mo: "(" + mo.group(1).replace(" ", "\u00a0") + ")", name)


def png_size(rel: str) -> tuple[int, int]:
    """Intrinsic size straight from the PNG header.

    Hardcoding it meant the <img> advertised 489x880 while the asset was
    437x786 — the browser reserves space from these numbers, so a stale pair
    is a layout shift on every page that shows a vial. stdlib only: the IHDR
    chunk carries width and height as two big-endian uint32 at offset 16.
    """
    data = (ROOT / rel).read_bytes()[:24]
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{rel} is not a PNG")
    return struct.unpack(">II", data[16:24])


VIAL_W, VIAL_H = png_size("assets/img/vial.png")


def vial(p_name, size_label, height=240, alt="", purity=None, pid=None):
    """Render the vial photograph with a per-compound label printed into the
    real paper label.

    Text layout follows the supplied reference: the compound set large and
    left-aligned at the top, its pack size in a pill beneath, the brand
    wordmark running vertically up the right edge, and the purity pill with
    the research-use line along the bottom.

    The text is a DOM layer blended with `multiply`, so it picks up the
    photographed label's own curvature shading and paper texture instead of
    sitting on a flat synthetic rectangle. Multiply can only darken, so the
    pills are outlined rather than filled — knocked-out light text inside a
    dark pill is not reachable through this blend mode.

    Label geometry is measured from the asset's alpha channel by
    tools/make_vial.py: left 11.45%, top 39.77%, width 82.41%, height 41.70%.

    Every compound is set at one size regardless of length, as on real
    packaging; a name too long for the line wraps to a second. The size is
    fixed in CSS (.vp-name) at the largest value that keeps the catalog's
    longest unbreakable word — "Bacteriostatic" — inside one line with margin.

    Below 260px the purity and research-use lines are dropped: at that scale
    they render under 6px and read as a smudge.

    The lot, retest and storage block is what stops the label reading as a
    mock-up. A real vial carries traceability on its face, and the empty band
    in the middle of the paper was the loudest thing saying this one does not.
    The lot is derived from the product id so it is stable across builds and
    differs between compounds; the page caption already states the label is
    shown for illustration and that the supplied vial carries its own lot."""
    compact = height < 260

    meta = ""
    if height >= 300 and pid:
        # deterministic, so a rebuild does not churn every page
        import hashlib
        h = hashlib.sha256(pid.encode()).hexdigest()
        lot = f"TR-{24 + int(h[:2], 16) % 2}-{int(h[2:5], 16) % 9000 + 1000}-{h[5].upper()}"
        meta = (f'<span class="vp-meta">'
                f'<span><b>LOT</b> {lot}</span>'
                f'<span><b>RETEST</b> 2027-04 \u00b7 \u221220 \u00b0C</span>'
                f'</span>')

    foot = ""
    if not compact:
        pur = f'<span class="vp-pill">Purity {E(purity)}</span>' if purity else ""
        foot = ('\n    <span class="vp-foot">' + meta + pur +
                '<span class="vp-ruo">Research Use Only</span></span>')
        meta = ""   # consumed by the foot

    return f"""<span class="vial" style="--vial-h:{height}px">
  <picture>
    <source srcset="{{PREFIX}}assets/img/vial.webp" type="image/webp">
    <img src="{{PREFIX}}assets/img/vial.png" alt="{E(alt) if alt else ''}" width="{VIAL_W}" height="{VIAL_H}" loading="lazy" decoding="async">
  </picture>
  <span class="vial-print" aria-hidden="true">
    <span class="vp-name">{E(label_name(p_name))}</span>
    <span class="vp-dose">{E(size_label)}</span>{meta}
    <span class="vp-side">
      <img class="vp-mark" src="{{PREFIX}}assets/img/mark.svg" alt="" width="100" height="206">
      <span class="vp-brand">TIMELESS RESEARCH</span>
    </span>{foot}
  </span>
</span>"""


RUO_NOTICE = """<div class="notice">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
  <div>
    <h3>For laboratory research use only</h3>
    <p>All material supplied by {BRAND} is intended exclusively for <strong>in vitro</strong> laboratory research and analytical method development by qualified professionals. Nothing offered here is a drug, dietary supplement, cosmetic or medical device. It is not for human or veterinary use, not for clinical or diagnostic procedures, and not for food or household use. We do not provide dosing, administration or therapeutic guidance of any kind, and we supply only to verified institutional and qualified-research accounts.</p>
  </div>
</div>""".replace("{BRAND}", BRAND)


def icon(d, size=20):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>')


I_FLASK = '<path d="M9 3h6M10 3v6.5L4.6 18A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M7.5 15h9"/>'
I_CHART = '<path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 5-7"/>'
I_SHIELD = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>'
I_DOC = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'
I_SNOW = '<path d="M12 2v20M4.9 6.5l14.2 11M19.1 6.5 4.9 17.5"/>'
I_SCOPE = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'


# --------------------------------------------------------------------------- home
def build_home():
    cats = "".join(f"""
      <a class="card card--link" href="catalog.html#{c['id']}" data-reveal data-reveal-delay="{i % 3}">
        <h3>{E(c['label'])}</h3>
        <p>{E(c['blurb'])}</p>
        <span class="chip" style="margin-top:1rem;display:inline-block">{sum(1 for p in PRODUCTS if p['category'] == c['id'])} compounds</span>
      </a>""" for i, c in enumerate(CATEGORIES))

    steps = [
        ("Sourcing", I_FLASK, "Synthesis partners are qualified on documented process controls, and every incoming lot is quarantined until it clears identity testing."),
        ("Identity", I_SCOPE, "Electrospray mass spectrometry confirms the molecular ion against the theoretical mass before a lot proceeds."),
        ("Purity", I_CHART, "Reverse-phase HPLC establishes chromatographic purity, with the integrated trace reproduced on the certificate of analysis."),
        ("Content", I_DOC, "Karl Fischer titration and acetate determination establish water and counter-ion content so mass corrections are possible."),
        ("Release", I_SHIELD, "A named analyst reviews the full data package and signs the lot release. Nothing ships on an unsigned lot."),
        ("Storage", I_SNOW, "Material is held lyophilised at -20 °C under desiccation and shipped with cold-chain packaging where stability requires it."),
    ]
    steps_html = "".join(f"""
      <div class="card" data-reveal data-reveal-delay="{i % 3}">
        <span class="step-n">0{i+1}</span>
        <h3 style="display:flex;align-items:center;gap:.6rem">{icon(d)} {E(t)}</h3>
        <p>{E(x)}</p>
      </div>""" for i, (t, d, x) in enumerate(steps))

    featured = [p for p in PRODUCTS if p["id"] in ("bpc-157", "ipamorelin", "ghk-cu", "epithalon", "mots-c", "ss-31")]
    feat_html = "".join(f"""
      <article class="product" data-reveal data-reveal-delay="{i % 3}">
        <div class="product-media" style="--tint:{CAT_TINT[p['category']][0]};--tint-deep:{CAT_TINT[p['category']][1]}">
          {vial(p.get('label') or p['name'], p['sizes'][0], 285, purity=p.get('purity'), pid=p['id'])}
          <span class="product-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 6 6L20 6"/></svg>{E(p['purity'])} HPLC</span>
        </div>
        <div class="product-body">
          <div class="product-head">
            <h3 class="product-name"><a href="products/{p['id']}.html">{E(p['name'])}</a></h3>
            {f'<span class="product-cas">CAS {E(p["cas"])}</span>' if p.get('cas') else '<span class="product-cas">Blend</span>'}
          </div>
          <p class="product-sub">{E((p.get('synonyms') or [CAT_LABEL[p['category']]])[0])}</p>
          <a class="btn btn--primary btn--pill btn--block" href="products/{p['id']}.html">View</a>
        </div>
      </article>""" for i, p in enumerate(featured))

    hero_vial = vial("BPC-157", "5 mg", 470, purity="\u226598%",
                     alt="A Timeless Research vial of BPC-157, 5 mg")
    body = f"""
<section class="hero">
  <div class="shell">
    <div class="hero-grid">
      <div>
        <span class="rule-tag">Peptide reference material</span>
        <h1 class="display h-hero">Characterised.<br><em>Documented. Released.</em></h1>
        <p class="lede">Analytical-grade research peptides for institutional laboratories — each lot identity-confirmed by mass spectrometry, purity-assayed by HPLC, and released against a signed certificate of analysis.</p>
        <div class="hero-actions">
          <a class="btn btn--primary" href="catalog.html">Browse the catalog</a>
          <a class="btn btn--ghost" href="contact.html">Open an account</a>
        </div>
      </div>
      <div class="hero-figure">{hero_vial}</div>
    </div>
  </div>
</section>

<div class="shell">
  <div class="stats">
    <div class="stat"><div class="stat-n mono">{len(PRODUCTS)}</div><div class="stat-l">Catalog compounds</div></div>
    <div class="stat"><div class="stat-n mono">≥98%</div><div class="stat-l">Typical HPLC purity</div></div>
    <div class="stat"><div class="stat-n mono">100%</div><div class="stat-l">Lots with a COA</div></div>
    <div class="stat"><div class="stat-n mono">-20°C</div><div class="stat-l">Controlled storage</div></div>
  </div>
</div>

<section class="section">
  <div class="shell">{RUO_NOTICE}</div>
</section>

<section class="section section--alt">
  <div class="shell">
    <div class="sec-head" data-reveal>
      <span class="eyebrow">Catalog</span>
      <h2 class="display h-sec">Organised by <em>research area.</em></h2>
      <p class="lede">{len(PRODUCTS)} compounds across seven research areas. Every listing carries CAS number, molecular formula, sequence, storage conditions and the assay panel applied at release.</p>
    </div>
    <div class="grid-3">{cats}</div>
  </div>
</section>

<section class="section">
  <div class="shell">
    <div class="sec-head" data-reveal>
      <span class="eyebrow">Frequently referenced</span>
      <h2 class="display h-sec">Selected <em>compounds.</em></h2>
    </div>
    <div class="product-grid">{feat_html}</div>
    <div style="margin-top:2.5rem"><a class="btn btn--ghost" href="catalog.html">View all {len(PRODUCTS)} compounds</a></div>
  </div>
</section>

<section class="section section--alt">
  <div class="shell">
    <div class="sec-head" data-reveal>
      <span class="eyebrow">Analytical programme</span>
      <h2 class="display h-sec">What happens before<br><em>a lot is released.</em></h2>
      <p class="lede">Purity claims are only as good as the data behind them. Every lot moves through the same six stages, and the resulting data package travels with the material.</p>
    </div>
    <div class="grid-3">{steps_html}</div>
    <div style="margin-top:2.5rem;display:flex;gap:.75rem;flex-wrap:wrap"><a class="btn btn--ghost" href="quality.html">Read the full analytical programme</a><a class="btn btn--ghost" href="specimen-coa.html">See a specimen certificate</a></div>
  </div>
</section>

<section class="section">
  <div class="shell">
    <div class="split">
      <div data-reveal>
        <span class="eyebrow">Accounts</span>
        <h2 class="display h-sec">We supply <em>laboratories.</em></h2>
      </div>
      <div class="prose" data-reveal data-reveal-delay="1">
        <p>Ordering is restricted to verified institutional and qualified-research accounts — universities, hospital and government research units, contract research organisations, and commercial R&amp;D laboratories with a documented research purpose.</p>
        <p>Account applications are reviewed individually. We ask for the institution, the responsible investigator, a shipping address at the research facility, and a short description of the intended research use. We do not sell to individuals for personal use, and we do not ship to residential addresses.</p>
        <p>List prices are published against every pack size. Orders are still supplied against a verified account, so that lot availability, quantity breaks and shipping conditions are agreed in writing before material ships.</p>
        <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:2rem">
          <a class="btn btn--primary" href="contact.html">Apply for an account</a>
          <a class="btn btn--ghost" href="compliance.html">Research use policy</a>
        </div>
      </div>
    </div>
  </div>
</section>
"""
    return page("index.html", f"{BRAND} — Peptide Reference Material for Research Laboratories",
                "Analytical-grade research peptides for institutional laboratories. HPLC purity, mass-spec identity confirmation and a signed certificate of analysis with every lot. Research use only.",
                body, "index.html", extra_head=organisation() + "\n")


# --------------------------------------------------------------------------- catalog
def build_catalog():
    filters = "".join(
        f'<li><button class="filter-btn" data-filter="{c["id"]}" aria-pressed="false">{E(c["label"])}'
        f'<span class="n">{sum(1 for p in PRODUCTS if p["category"] == c["id"])}</span></button></li>'
        for c in CATEGORIES)

    cards = []
    for p in PRODUCTS:
        hay = " ".join(filter(None, [p["name"], p.get("cas") or "", " ".join(p.get("synonyms") or []),
                                     CAT_LABEL[p["category"]], p["research"]])).lower()
        sizes = size_options(p)
        tint, tint_deep = CAT_TINT[p['category']]
        cards.append(f"""
        <article class="product" data-cat="{p['category']}" data-search="{E(hay)}" data-available="{str(p.get('available', True)).lower()}" data-price="{(p.get('prices') or {}).get(p['sizes'][0], 0)}" data-name="{E(p['name'])}">
          <div class="product-media" style="--tint:{tint};--tint-deep:{tint_deep}">
            {vial(p.get('label') or p['name'], p['sizes'][0], 285, purity=p.get('purity'), pid=p['id'])}
            {'<span class="product-flag">Restricted</span>' if p.get('restricted') else ''}
            <span class="product-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 6 6L20 6"/></svg>{E(p['purity'])} HPLC</span>
          </div>
          <div class="product-body">
            <div class="product-head">
              <h3 class="product-name"><a href="products/{p['id']}.html">{E(p['name'])}</a></h3>
              {f'<span class="product-cas">CAS {E(p["cas"])}</span>' if p.get('cas') else '<span class="product-cas">Blend</span>'}
            </div>
            <p class="product-sub">{E((p.get('synonyms') or [CAT_LABEL[p['category']]])[0])}</p>
            <div class="product-price"><span data-price-display>{initial_price(p)}</span>{'' if p.get("available", True) else '<span class="stock-out">Unavailable</span>'}</div>
            <div class="product-foot">
              <select aria-label="Pack size for {E(p['name'])}" data-size{'' if p.get("available", True) else ' disabled'}>{sizes}</select>
              {f'<button class="link-action" data-add="{p["id"]}" data-name="{E(p["name"])}">Add to list</button>' if p.get("available", True) else '<span class="muted" style="font-size:.72rem">Not currently supplied</span>'}
            </div>
            <a class="btn btn--primary btn--pill btn--block" href="products/{p['id']}.html">View</a>
          </div>
        </article>""")

    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Catalog</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Catalog</span>
      <h1 class="display h-sec">Research <em>compounds.</em></h1>
      <p class="lede">{len(PRODUCTS)} characterised compounds, priced by pack size. Build a request list and we confirm lot availability and shipping on the quotation; material is supplied against a verified account.</p>
    </div>
  </div>
</section>

<section class="section section--tight">
  <div class="shell">
    <div class="catalog-layout">
      <aside class="filters">
        <h2>Research area</h2>
        <ul class="filter-list">
          <li><button class="filter-btn" data-filter="all" aria-pressed="true">All<span class="n">{len(PRODUCTS)}</span></button></li>
          {filters}
        </ul>
      </aside>
      <div>
        <div class="search-field">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <label class="sr-only" for="catalog-search">Search the catalog</label>
          <input id="catalog-search" type="search" placeholder="Search by name, CAS number, synonym or research area…" autocomplete="off">
        </div>
        <div class="catalog-meta">
          <p class="muted mono" id="result-count" aria-live="polite"></p>
          <div class="sort-field">
            <label for="catalog-sort">Sort</label>
            <select id="catalog-sort">
              <option value="default">Research area</option>
              <option value="price-asc">Price, low to high</option>
              <option value="price-desc">Price, high to low</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
        </div>
        <div class="product-grid" id="product-grid">{''.join(cards)}</div>
        <div class="empty-state" id="empty-state" hidden>
          <strong>No compounds match that search.</strong>
          <p>Try a CAS number, a synonym, or clear the filters.</p>
        </div>
      </div>
    </div>
  </div>
</section>
"""
    return page("catalog.html", f"Catalog — {BRAND}",
                f"{len(PRODUCTS)} analytical-grade research peptides and reagents with CAS numbers, molecular weights and HPLC purity specifications. Research use only.",
                body, "catalog.html",
                extra_body='<script src="assets/js/catalog.js" defer></script>')


# --------------------------------------------------------------------------- product detail
def build_products():
    written = []
    for p in PRODUCTS:
        others = [q for q in PRODUCTS if q["category"] == p["category"] and q["id"] != p["id"]][:3]
        rel_html = "".join(f"""
          <a class="card card--link" href="{q['id']}.html">
            <h3>{E(q['name'])}</h3>
            <p>{E((q.get('synonyms') or ['Research compound'])[0])}</p>
          </a>""" for q in others)

        # A blend has no single CAS, formula, mass or sequence. Four rows of "—"
        # read as missing data; naming the components states what a certificate
        # for a mixture can actually report against.
        if p.get("components"):
            rows = [("Components", ", ".join(p["components"]), False)]
        else:
            rows = [
                ("CAS number", p.get("cas") or "Not assigned", False),
                ("Molecular formula", p.get("formula") or "—", False),
                ("Molecular weight", f"{p['mw']} g/mol" if p.get("mw") else "—", False),
                ("Sequence", p.get("sequence") or "Not applicable", False),
            ]
        rows += [
            ("Purity specification", p["purity"], False),
            ("Physical form", p["form"], False),
            ("Appearance", p["appearance"], False),
            ("Solubility", p.get("solubility") or "See certificate of analysis", False),
            ("Storage", p["storage"], False),
            ("Available pack sizes", ", ".join(p["sizes"]), False),
            ("Research area", CAT_LABEL[p["category"]], False),
        ]
        PROSE = ' class="is-prose"'
        spec_rows = "".join(
            "<tr><th scope='row'>{}</th><td{}>{}</td></tr>".format(E(k), PROSE if pr else "", E(str(v)))
            for k, v, pr in rows)
        assay_rows = "".join(f'<li>{E(a)}</li>' for a in p["assays"])
        syn = ", ".join(p.get("synonyms") or []) or "—"
        sizes_opt = size_options(p)

        restricted = ""
        if p.get("restricted"):
            restricted = """
        <div class="notice" style="margin-bottom:1.5rem">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
          <div>
            <h3>Restricted reference standard</h3>
            <p>This compound corresponds to an approved or investigational pharmaceutical substance and is supplied strictly as an analytical reference standard for <strong>in vitro</strong> method development. Release requires documented institutional affiliation and a stated research protocol. It is not available to individuals and will not ship to a residential address.</p>
          </div>
        </div>"""

        ld = json.dumps({
            "@context": "https://schema.org", "@type": "Product", "name": p["name"],
            "description": p["research"], "category": CAT_LABEL[p["category"]],
            "sku": p["id"], "brand": {"@type": "Brand", "name": BRAND},
            **({"additionalProperty": [{"@type": "PropertyValue", "name": "CAS", "value": p["cas"]}]} if p.get("cas") else {}),
            **offers_for(p),
        }, ensure_ascii=False)

        body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb">
      <a href="../index.html">Home</a> <span>/</span>
      <a href="../catalog.html">Catalog</a> <span>/</span>
      <a href="../catalog.html#{p['category']}">{E(CAT_LABEL[p['category']])}</a> <span>/</span>
      <span>{E(p['name'])}</span>
    </nav>

    <div class="split">
      <div>
        <div class="detail-media" style="--tint:{CAT_TINT[p['category']][0]};--tint-deep:{CAT_TINT[p['category']][1]}">
          {vial(p.get('label') or p['name'], p['sizes'][0], 400, alt=f"{p['name']} research vial, {p['sizes'][0]}", purity=p.get('purity'), pid=p['id'])}
        </div>
        <p class="muted" style="font-size:.7rem;margin-top:.75rem;text-align:center">Label shown for illustration. Supplied vial carries the lot number and release date.</p>
      </div>

      <div>
        <span class="eyebrow">{E(CAT_LABEL[p['category']])}</span>
        <h1 class="display h-sub" style="margin-bottom:.5rem">{E(p['name'])}</h1>
        <p class="muted mono" style="font-size:.72rem;margin-bottom:1.5rem">{E(syn)}</p>
        {restricted}
        <p class="lede" style="font-size:.95rem;margin-bottom:2rem">{E(p['research'])}</p>

        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:2rem">
          <span class="chip chip--accent">{E(p['purity'])} HPLC</span>
          <span class="chip">{E(p['form'])}</span>
          <span class="ruo-badge">Research use only</span>
        </div>

        <div class="detail-price"><span data-price-display>{initial_price(p)}</span><small>per vial, excluding shipping and tax</small></div>
        {'' if p.get("available", True) else '<p class="stock-note">Not currently supplied. Contact us and we will tell you when this compound returns to the catalogue.</p>'}

        <div class="field no-print" style="margin-bottom:1.5rem">
          <label for="size-select">Pack size</label>
          <select id="size-select" data-size{'' if p.get("available", True) else ' disabled'}>{sizes_opt}</select>
        </div>
        {f'<button class="btn btn--primary" data-add="{p["id"]}" data-name="{E(p["name"])}">Add to request list</button>' if p.get("available", True) else f'<a class="btn btn--ghost" href="../contact.html">Ask about availability</a>'}
        <p class="muted no-print" style="font-size:.72rem;margin:.9rem 0 2.5rem">List price shown. Orders are supplied against a verified account; lot availability and any quantity break are confirmed on the quotation.</p>

        <table class="spec">
          <caption>Specification</caption>
          <tbody>{spec_rows}</tbody>
        </table>

        <h2 style="font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin:2.5rem 0 1rem">Release assay panel</h2>
        <ul style="list-style:none;display:flex;flex-wrap:wrap;gap:.5rem">{assay_rows.replace('<li>', '<li class="chip" style="padding:.3rem .6rem">')}</ul>
        <p class="muted" style="font-size:.78rem;margin-top:1rem;line-height:1.7">The certificate of analysis for the supplied lot reproduces the HPLC trace and mass spectrum, and is issued with the shipment. <a href="../quality.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">How lots are released</a>, or <a href="../specimen-coa.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">see a specimen certificate</a>.</p>
      </div>
    </div>
  </div>
</section>

<section class="section section--alt no-print">
  <div class="shell">
    <h2 class="display h-sub" style="margin-bottom:2rem">Related in {E(CAT_LABEL[p['category']])}</h2>
    <div class="grid-3">{rel_html or '<p class="muted">No related compounds listed.</p>'}</div>
  </div>
</section>
"""
        written.append(page(f"products/{p['id']}.html",
                            f"{p['name']} — {p.get('cas') or 'Research Peptide'} | {BRAND}",
                            f"{p['name']} ({p.get('cas') or 'research peptide'}), {p['purity']} HPLC purity, {p['form']}. {p['research'][:110]}",
                            body, "catalog.html",
                            extra_head=f'<script type="application/ld+json">{ld}</script>\n'
                            + breadcrumbs([("Home", "index.html"),
                                           ("Catalog", "catalog.html"),
                                           (CAT_LABEL[p["category"]], f"catalog.html#{p['category']}"),
                                           (p["name"], None)]) + "\n"))
    return written


# --------------------------------------------------------------------------- quality
def build_quality():
    stages = [
        ("Supplier qualification", "Synthesis partners are audited against documented process controls, change-control procedures and batch-record practice before a first order is placed. Requalification is periodic, not one-off."),
        ("Incoming quarantine", "Material is received into a quarantine hold and is not available for allocation until the identity and purity package is complete and reviewed."),
        ("Identity — ESI-MS", "Electrospray ionisation mass spectrometry confirms the observed molecular ion against the theoretical monoisotopic or average mass. A lot that does not match its theoretical mass is rejected outright."),
        ("Purity — RP-HPLC", "Reverse-phase HPLC with UV detection establishes chromatographic purity as area percent. The integrated chromatogram — not just the number — is reproduced on the certificate."),
        ("Water content — Karl Fischer", "Coulometric Karl Fischer titration quantifies residual water in lyophilised material, so that peptide content can be corrected rather than assumed."),
        ("Counter-ion — acetate content", "Acetate is determined for peptides supplied as acetate salts. Together with water content this establishes net peptide content, which matters whenever a molar concentration is being prepared."),
        ("Lot release", "A named analyst reviews the complete data package against the specification and signs the release. The signature is recorded against the lot number; nothing ships on an unsigned lot."),
        ("Storage and distribution", "Released material is stored lyophilised at -20 °C under desiccation. Shipments use insulated packaging with coolant where stability data indicates it, and cold-chain handling is noted on the packing documentation."),
    ]
    rows = "".join(f"""
      <div class="card" data-reveal data-reveal-delay="{i % 3}">
        <span class="step-n">{i+1:02d}</span>
        <h3>{E(t)}</h3>
        <p>{E(d)}</p>
      </div>""" for i, (t, d) in enumerate(stages))

    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Analytical programme</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Analytical programme</span>
      <h1 class="display h-sec">Data, <em>not adjectives.</em></h1>
      <p class="lede">A purity figure is a claim. The chromatogram behind it is evidence. Every lot we release carries the evidence, and the analyst who signed it is named on the record.</p>
    </div>
  </div>
</section>

<section class="section section--tight section--alt">
  <div class="shell">
    <div class="grid-2">{rows}</div>
  </div>
</section>

<section class="section">
  <div class="shell">
    <div class="split">
      <div><span class="eyebrow">Certificate of analysis</span><h2 class="display h-sec">What the <em>COA</em> contains.</h2></div>
      <div class="prose">
        <p>A certificate of analysis is issued for every lot and accompanies the shipment. Each certificate is specific to the lot number printed on the vial — it is not a generic product datasheet, and we do not reuse a certificate across lots.</p>
        <ul>
          <li><strong>Product identity</strong> — name, CAS number where assigned, molecular formula and theoretical mass</li>
          <li><strong>Lot number and release date</strong>, matched to the vial label</li>
          <li><strong>Appearance</strong> as assessed at release</li>
          <li><strong>Chromatographic purity</strong> by RP-HPLC, expressed as area percent, with the integrated trace</li>
          <li><strong>Mass confirmation</strong> by ESI-MS, observed against theoretical</li>
          <li><strong>Water content</strong> by Karl Fischer titration</li>
          <li><strong>Counter-ion content</strong> where the material is supplied as a salt</li>
          <li><strong>Recommended storage</strong> and retest date</li>
          <li><strong>Analyst signature</strong> and release authorisation</li>
        </ul>
        <p>Certificates for a specific lot are available to account holders on request before purchase. If you need to review the data package as part of a supplier-qualification process, ask and we will provide it.</p>
        <p><a class="btn btn--primary" href="specimen-coa.html" style="margin-top:.5rem">See a specimen certificate</a></p>
        <h3>Retest, not expiry</h3>
        <p>Lyophilised peptides stored correctly do not simply expire on a date. We publish a retest date rather than an expiry: at that point the lot is re-assayed against its original specification and either re-released with updated data or withdrawn.</p>
        <h3>What we do not claim</h3>
        <p>We do not certify our material as sterile, endotoxin-free or pharmaceutical grade unless the certificate for that specific lot says so and reports the test that established it. Reagent solutions are tested for sterility and endotoxin; lyophilised research peptides generally are not, and should not be treated as though they were.</p>
      </div>
    </div>
  </div>
</section>

"""
    return page("quality.html", f"Analytical Programme — {BRAND}",
                "How every lot is released: ESI-MS identity confirmation, RP-HPLC purity, Karl Fischer water content, acetate determination and a signed certificate of analysis.",
                body, "quality.html")


# --------------------------------------------------------------------------- about
def build_about():
    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>About</span></nav>
    <div class="sec-head">
      <span class="eyebrow">About</span>
      <h1 class="display h-sec">A supplier is a<br><em>link in the method.</em></h1>
      <p class="lede">If the material is not what the label says, every result downstream of it is wrong. That is the whole argument for how we operate.</p>
    </div>
  </div>
</section>

<section class="section section--tight">
  <div class="shell">
    <div class="split">
      <div><span class="eyebrow">Position</span><h2 class="display h-sub">What we are</h2></div>
      <div class="prose">
        <p>{BRAND} supplies characterised peptide reference material to institutional and qualified-research laboratories. We are a research reagent supplier. We are not a pharmacy, not a compounder, and not a clinic, and we do not hold ourselves out as any of those things.</p>
        <p>The catalog is deliberately narrow. Every compound on it is one we can source with documented process controls and release against a specification we are willing to put an analyst's signature on. When we cannot establish that, the compound does not go on the catalog — which is why you will find gaps here that other suppliers fill.</p>
        <h3>What we will not do</h3>
        <p>We do not supply controlled substances. We do not supply finished-dose pharmaceuticals, anabolic steroids, or prescription medicines. We do not sell to individuals for personal use. We do not provide dosing, administration, protocol or therapeutic guidance, and we will not answer questions framed around human use — not as a liability posture, but because that is not what this material is for and pretending otherwise puts people at risk.</p>
        <p>If you are looking for material to use on yourself or another person, we are the wrong supplier, and there is no version of this conversation in which we become the right one. Speak to a licensed clinician.</p>
        <h3>How we handle uncertainty</h3>
        <p>Some compounds in this catalog are well characterised with decades of literature behind them. Others are recent, and the preclinical record is thin. We describe each one at the level the evidence actually supports, and the product descriptions say what a compound has been <em>studied for</em> — not what it does, and never what it treats.</p>
        <p>Where a compound corresponds to an approved or investigational pharmaceutical, we flag it as a restricted reference standard and require a stated research protocol before release.</p>
      </div>
    </div>
  </div>
</section>

<section class="section section--alt">
  <div class="shell">
    <div class="grid-3">
      <div class="card"><h3 style="display:flex;align-items:center;gap:.6rem">{icon(I_SCOPE)} Characterisation first</h3><p>A compound is listed when we can document its identity and purity, and not before. The specification comes first; the listing follows.</p></div>
      <div class="card"><h3 style="display:flex;align-items:center;gap:.6rem">{icon(I_DOC)} Lot-level traceability</h3><p>Every certificate is tied to a lot number and a named analyst. Generic, reused certificates tell you nothing about the vial in your hand.</p></div>
      <div class="card"><h3 style="display:flex;align-items:center;gap:.6rem">{icon(I_SHIELD)} Verified accounts only</h3><p>Supply is restricted to research institutions with a documented purpose. The restriction is the point, not an obstacle to route around.</p></div>
    </div>
  </div>
</section>

"""
    return page("about.html", f"About — {BRAND}",
                f"{BRAND} supplies characterised peptide reference material to institutional research laboratories. What we supply, what we refuse to supply, and why.",
                body, "about.html")


# --------------------------------------------------------------------------- faq
FAQ = [
    ("Who is eligible to order?",
     "Ordering is limited to verified institutional and qualified-research accounts: universities, hospital and government research units, contract research organisations, and commercial R&D laboratories with a documented research purpose. We review each application individually and we do not supply individuals for personal use."),
    ("Why can I not simply check out with a card?",
     "Because we need to know who the material is going to and what it is for before it ships. List prices are published, but the order itself is confirmed by quotation against a verified account, so lot availability, quantity and shipping conditions are agreed in writing first. Building a request list on this site starts that process; it is not a purchase."),
    ("What does “research use only” actually mean here?",
     "It means the material is intended exclusively for in vitro laboratory research and analytical method development by qualified professionals. It is not a drug, supplement, cosmetic or medical device; it has not been evaluated for safety or efficacy in humans or animals; and it must not be administered to either. This is a statement about what the material is, not a disclaimer that unlocks another use."),
    ("Will you advise on dosing or administration?",
     "No — for any compound, under any framing, for any species. We answer questions about identity, purity, solubility, stability, storage and handling. We do not answer questions about dosing, administration routes, cycles or therapeutic use, and a request for that guidance will end the enquiry."),
    ("Do you supply anabolic steroids, hormones or prescription medicines?",
     "No. We do not supply controlled substances, anabolic steroids, finished-dose pharmaceuticals or prescription medicines of any kind. The catalog is limited to research peptides, small-molecule research compounds and laboratory reagents."),
    ("What is on the certificate of analysis?",
     "Product identity, lot number and release date, appearance, RP-HPLC chromatographic purity with the integrated trace, ESI-MS mass confirmation, Karl Fischer water content, counter-ion content where applicable, storage conditions, retest date, and the releasing analyst's signature. Certificates are lot-specific and are never reused across lots."),
    ("Can I see the COA before I order?",
     "Yes. Account holders can request the certificate for a specific lot before purchase, and we will supply the full data package if you need it for supplier qualification."),
    ("Is the material sterile or endotoxin-tested?",
     "Only where the certificate for that lot says so and reports the test. Reagent solutions are tested for sterility and endotoxin. Lyophilised research peptides generally are not, and should not be assumed to be."),
    ("How should material be stored on arrival?",
     "Lyophilised peptides should be transferred to -20 °C, kept desiccated and protected from light. Storage conditions specific to each compound are listed on its specification page and on the certificate. Repeated freeze–thaw cycles of reconstituted material should be avoided."),
    ("Do you ship internationally?",
     "We ship to institutional addresses in jurisdictions where the material may lawfully be imported for research use. Import permits, customs classification and local restrictions are the account holder's responsibility, and we will not mis-declare the contents or value of a shipment under any circumstances."),
    ("What if a lot does not meet specification?",
     "Tell us within 30 days of delivery with the lot number and the data. If the material is out of specification we replace it or refund it. See the shipping and returns policy for the full procedure."),
    ("Do you ship to residential addresses?",
     "No. Shipments go to the research facility associated with the verified account."),
]


def build_faq():
    items = "".join(f"""
      <div class="acc-item">
        <h3><button class="acc-q" aria-expanded="false">{E(q)}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </button></h3>
        <div class="acc-a"><p>{E(a)}</p></div>
      </div>""" for q, a in FAQ)

    ld = json.dumps({"@context": "https://schema.org", "@type": "FAQPage",
                     "mainEntity": [{"@type": "Question", "name": q,
                                     "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]},
                    ensure_ascii=False)

    body = f"""
<section class="section section--tight">
  <div class="shell-n">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>FAQ</span></nav>
    <div class="sec-head">
      <span class="eyebrow">FAQ</span>
      <h1 class="display h-sec">Common <em>questions.</em></h1>
      <p class="lede">Eligibility, documentation, handling and the limits of what we will advise on.</p>
    </div>
    <div class="acc">{items}</div>
    <p style="margin-top:2rem" class="muted">Question not answered here? <a href="contact.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">Contact the technical team</a>.</p>
  </div>
</section>
"""
    return page("faq.html", f"FAQ — {BRAND}",
                "Eligibility, certificates of analysis, storage and handling, shipping, and the limits of technical support.",
                body, "faq.html", extra_head=f'<script type="application/ld+json">{ld}</script>\n')


# --------------------------------------------------------------------------- contact
def build_contact():
    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Contact</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Accounts &amp; quotations</span>
      <h1 class="display h-sec">Get in <em>touch.</em></h1>
      <p class="lede">Leave your details and we will come back to you within two business days. Account verification and pricing follow by email.</p>
    </div>
  </div>
</section>

<section class="section section--tight">
  <div class="shell">
    <div class="split">
      <div>
        <div id="rfq-summary" hidden style="background:var(--surface-1);border:1px solid var(--line);border-radius:6px;padding:1.5rem;margin-bottom:1.5rem">
          <h2 style="font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin-bottom:1rem">Your request list</h2>
          <div id="rfq-summary-body"></div>
        </div>
        <div class="prose">
          <h3>What happens next</h3>
          <ol>
            <li>We reply to arrange account verification.</li>
            <li>Verification covers the institution and its research facility address, the responsible investigator, an institutional email address, and the intended research use.</li>
            <li>Once the account is open we issue a written quotation against your request list.</li>
          </ol>
          <p>Nothing ships before that verification is complete, and we do not supply individuals for personal use.</p>
          <h3>What we cannot help with</h3>
          <p>We do not provide dosing, administration or therapeutic guidance. Enquiries framed around human or veterinary use will be declined.</p>
          <h3>Technical support</h3>
          <p>For questions on identity, purity, solubility, stability, storage or certificates of analysis, mention it when you get in touch. Lot-specific certificates are available to account holders on request.</p>
        </div>
      </div>

      <div>
        <form id="account-form" name="account-application" method="POST"
              data-netlify="true" data-netlify-honeypot="bot-field" novalidate>
          <input type="hidden" name="form-name" value="account-application">
          <input type="hidden" name="request_list" id="f-request-list">
          <p hidden><label>Leave this field empty <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>
          <div class="field">
            <label for="f-name">Name <span class="req" aria-hidden="true">*</span></label>
            <input id="f-name" name="name" type="text" required autocomplete="name">
            <p class="field-error">Please enter your name.</p>
          </div>

          <div class="field">
            <label for="f-email">Email <span class="req" aria-hidden="true">*</span></label>
            <input id="f-email" name="email" type="email" required autocomplete="email">
            <p class="field-error">Please enter a valid email address.</p>
          </div>

          <div class="field">
            <label for="f-phone">Phone number <span class="req" aria-hidden="true">*</span></label>
            <input id="f-phone" name="phone" type="tel" required autocomplete="tel" inputmode="tel">
            <p class="field-error">Please enter a phone number.</p>
          </div>

          <div class="field">
            <label class="check">
              <input type="checkbox" id="f-confirm" name="confirm" required>
              <span>I confirm that I am enquiring on behalf of a research institution or qualified laboratory, that any material supplied will be used solely for <strong>in vitro</strong> laboratory research, and that it will not be administered to humans or animals. <span class="req" aria-hidden="true">*</span></span>
            </label>
            <p class="field-error">This confirmation is required.</p>
          </div>

          <button class="btn btn--primary btn--block" type="submit">Send enquiry</button>
          <p class="muted" style="font-size:.7rem;margin-top:1rem;text-align:center">By submitting you agree to our <a href="legal/privacy.html" style="color:var(--accent);text-decoration:underline">privacy policy</a> and <a href="compliance.html" style="color:var(--accent);text-decoration:underline">research use policy</a>.</p>
          <div id="form-status" role="status" aria-live="polite" style="margin-top:1rem"></div>
        </form>
      </div>
    </div>
  </div>
</section>
"""
    return page("contact.html", f"Contact — {BRAND}",
                "Get in touch about an institutional research account, a quotation, or a technical question on identity, purity, storage or certificates of analysis.",
                body, "contact.html", extra_body='<script src="assets/js/contact.js" defer></script>')


# --------------------------------------------------------------------------- compliance
def build_compliance():
    body = f"""
<section class="section section--tight">
  <div class="shell-n">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Research use policy</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Policy</span>
      <h1 class="display h-sec">Research use <em>policy.</em></h1>
      <p class="lede">The conditions under which material is supplied, who may receive it, and what it may be used for. Last reviewed {TODAY}.</p>
    </div>
    <div class="prose">
      <h2>1. Intended use</h2>
      <p>All material supplied by {BRAND} is intended exclusively for <strong>in vitro</strong> laboratory research and analytical method development carried out by qualified professionals in an appropriate laboratory setting.</p>
      <p>Material supplied by {BRAND} is <strong>not</strong>: a medicinal product or drug; a dietary supplement; a cosmetic; a food or food ingredient; a medical device; or a veterinary product. It has not been evaluated by any regulatory authority for safety or efficacy in humans or animals, and it is not manufactured to pharmacopoeial or GMP standards unless the certificate of analysis for a specific lot expressly states otherwise.</p>
      <h2>2. Prohibited uses</h2>
      <p>By purchasing, you agree that material will not be used for, and will not be resold or transferred for:</p>
      <ul>
        <li>administration to humans by any route, in any quantity, under any circumstances;</li>
        <li>administration to animals outside an approved institutional animal-care protocol;</li>
        <li>any clinical, diagnostic or therapeutic procedure;</li>
        <li>compounding, formulation or repackaging into any product intended for human or animal use;</li>
        <li>incorporation into food, beverages, supplements or cosmetics;</li>
        <li>resale to the general public, or to any party that has not agreed to equivalent restrictions;</li>
        <li>any purpose prohibited by applicable law in your jurisdiction.</li>
      </ul>
      <h2>3. Eligibility</h2>
      <p>We supply only verified institutional and qualified-research accounts — universities, hospital and government research units, contract research organisations, and commercial R&amp;D laboratories with a documented research purpose. We do not supply individuals for personal use, and we do not ship to residential addresses.</p>
      <p>Account verification requires the institution name and research facility address, the responsible investigator or laboratory manager, an institutional email address, and a description of the intended research use. We may request additional documentation, and we may decline or revoke an account at our discretion.</p>
      <h2>4. Restricted reference standards</h2>
      <p>Certain catalog items correspond to approved or investigational pharmaceutical substances. These are supplied strictly as analytical reference standards for <strong>in vitro</strong> method development, require a stated research protocol prior to release, and are flagged as restricted on their specification pages. They will not be released to an unverified account under any circumstances.</p>
      <h2>5. What we will not advise on</h2>
      <p>We provide technical support on identity, purity, solubility, stability, storage and handling. We do <strong>not</strong> provide guidance on dosing, administration routes, cycles, combinations, or therapeutic application, for any species. Enquiries seeking such guidance will be declined, and may result in an account being refused or closed.</p>
      <h2>6. Responsibility of the recipient</h2>
      <p>The account holder is responsible for handling material in accordance with applicable laboratory safety requirements, for institutional approvals covering the intended work, for determining that receipt and use are lawful in their jurisdiction, and for any import permits or customs requirements. We will not mis-declare the contents, value or classification of a shipment.</p>
      <h2>7. Enforcement</h2>
      <p>We audit accounts periodically. Where we have reason to believe material has been diverted to human use, resold to the public, or otherwise used in breach of this policy, we will close the account, decline future orders and, where the law requires it, report the matter to the relevant authority.</p>
      <h2>8. Changes</h2>
      <p>This policy may be updated. The version in force is the one published here on the date an order is accepted.</p>
    </div>
    <p style="margin-top:2.5rem" class="muted">Questions about this policy: <a href="contact.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">contact us</a>.</p>
  </div>
</section>
"""
    return page("compliance.html", f"Research Use Policy — {BRAND}",
                "Conditions of supply: intended use, prohibited uses, account eligibility, restricted reference standards and recipient responsibilities.",
                body, "")


# --------------------------------------------------------------------------- legal
# Written for a US sole proprietorship selling research reagents business to
# business. Two clauses carry real weight and are deliberately set in capitals:
# UCC 2-316 requires a disclaimer of the implied warranties of merchantability
# and fitness to be conspicuous, and a limitation of liability is read the same
# way. Do not quietly restyle those into sentence case.


def legal_page(slug, title, eyebrow, heading, lede, prose):
    body = f"""
<section class="section section--tight">
  <div class="shell-n">
    <nav class="crumb" aria-label="Breadcrumb"><a href="../index.html">Home</a> <span>/</span> <span>{E(eyebrow)}</span></nav>
    <div class="sec-head">
      <span class="eyebrow">{E(eyebrow)}</span>
      <h1 class="display h-sec">{heading}</h1>
      <p class="lede">{E(lede)} Last updated {TODAY}.</p>
    </div>
    <div class="prose prose--legal">{prose}</div>
  </div>
</section>
"""
    return page(f"legal/{slug}.html", f"{title} — {BRAND}", lede, body, "")


def build_legal():
    entity = fill(LEGAL_ENTITY, "operator trading name")
    address = fill(LEGAL_ADDRESS, "operator business address")
    state = fill(LEGAL_STATE, "operator state")
    email = E(LEGAL_EMAIL)
    out = []

    # ---------------------------------------------------------------- terms
    out.append(legal_page("terms", "Terms of Sale", "Legal", "Terms of <em>sale.</em>",
        f"The terms on which {BRAND} accepts orders and supplies material.", f"""
      <h2>1. Who these terms are between</h2>
      <p>These terms govern every sale by {entity}, a sole proprietorship operating from {address} (“we”, “us”, “our”), to the account holder placing the order (“you”). They apply instead of any purchase-order or vendor terms you send us. Our beginning work on an order is not acceptance of those terms.</p>

      <h2>2. Who may buy</h2>
      <p>We supply verified institutional and qualified-research accounts only. Submitting a request list or a quotation request is not an order — it is an invitation for us to quote. A contract is formed only when we issue a written order confirmation. We may decline any order at our discretion, including where account verification is incomplete or the stated research use falls outside our <a href="../compliance.html">research use policy</a>.</p>

      <h2>3. Research use is a condition of every sale</h2>
      <p>Every sale is conditional on your agreement to our <a href="../compliance.html">research use policy</a>, which forms part of these terms. Material supplied is for <strong>in vitro</strong> laboratory research by qualified professionals. It is not a drug, dietary supplement, cosmetic, food or medical device, and it is not for human or veterinary use, clinical or diagnostic procedures, or household use. Breach of that policy is a material breach of these terms, entitling us to cancel outstanding orders, terminate your account and decline future business.</p>

      <h2>4. Quotations, prices and payment</h2>
      <p>Quotations are valid for 30 days unless they state otherwise. Prices exclude sales and use taxes, duties, and shipping, which are added to the invoice or charged separately. Payment is due in advance unless we have agreed credit terms with you in writing; where we have, payment is due 30 days from the invoice date. Overdue amounts accrue interest at 1.5% per month or the maximum rate permitted by applicable law, whichever is lower, and you are responsible for reasonable costs of collection, including attorneys' fees.</p>

      <h2>5. Shipping, title and risk</h2>
      <p>Shipments are made as described in our <a href="shipping.html">shipping and returns policy</a>, to institutional or commercial addresses only. Delivery dates are estimates, not guarantees, and we are not liable for delay. Risk of loss passes to you on delivery of the material to the carrier. Title passes when we have received payment in full.</p>

      <h2>6. Inspection and notice</h2>
      <p>Inspect each shipment on arrival. Tell us in writing within 10 business days of delivery about any shortage, visible damage or nonconformity, with the lot number and, for damage, photographs. Material not rejected within that period is accepted.</p>

      <h2>7. Limited warranty</h2>
      <p>We warrant that, at the time it leaves us, the material conforms in all material respects to the specification on its certificate of analysis. If it does not, and you have given notice under section 6, we will at our option replace the material or refund what you paid for it. That is your sole and exclusive remedy, and our entire liability, for nonconforming material. The warranty does not apply to material stored or handled outside the conditions on its certificate of analysis, used after its retest date, or altered, reconstituted or repackaged after delivery.</p>

      <h2>8. Disclaimer of other warranties</h2>
      <div class="legal-strong">
        <p>EXCEPT FOR THE LIMITED WARRANTY IN SECTION 7, THE MATERIAL IS PROVIDED “AS IS” AND WE DISCLAIM ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT.</p>
        <p>WE DO NOT WARRANT THAT THE MATERIAL IS SAFE OR SUITABLE FOR ANY USE IN OR ON HUMANS OR ANIMALS. NO SUCH USE IS AUTHORISED, AND ANY SUCH USE IS ENTIRELY AT THE RISK OF THE PERSON MAKING IT.</p>
      </div>

      <h2>9. Limitation of liability</h2>
      <div class="legal-strong">
        <p>TO THE FULLEST EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY ARISING OUT OF OR RELATING TO ANY ORDER, WHETHER IN CONTRACT, TORT, STRICT LIABILITY OR OTHERWISE, WILL NOT EXCEED THE AMOUNT YOU PAID FOR THE MATERIAL GIVING RISE TO THE CLAIM.</p>
        <p>WE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DATA OR LOST OR INVALIDATED RESEARCH, EVEN IF WE HAVE BEEN ADVISED THAT THEY WERE POSSIBLE.</p>
      </div>
      <p>Nothing in these terms excludes or limits liability that cannot lawfully be excluded or limited, including liability for fraud, or for death or personal injury caused by our negligence.</p>

      <h2>10. Your responsibilities</h2>
      <p>You are responsible for handling the material safely: restricting it to trained personnel, working in appropriate containment, reviewing the safety data sheet before use, obtaining any institutional approvals your research requires, and disposing of material and waste in accordance with federal, state and local law.</p>

      <h2>11. Indemnity</h2>
      <p>You will indemnify and hold us harmless against claims, losses, damages and expenses (including reasonable attorneys' fees) arising out of your use, handling, storage, disposal, resale or transfer of the material, any administration of it to a human or an animal, and any breach by you of these terms or of the research use policy.</p>

      <h2>12. Export control and sanctions</h2>
      <p>The material may be subject to the US Export Administration Regulations and to sanctions administered by the Office of Foreign Assets Control. You will not export, re-export, transfer or divert it contrary to those rules, and you confirm that you are not, and are not acting for, a party on a US restricted-party list or located in an embargoed destination.</p>

      <h2>13. Licences and permits</h2>
      <p>You are responsible for holding any licence, permit or registration your jurisdiction requires in order to receive, hold or use the material, including import permits where it crosses a border, and for producing evidence of them on request.</p>

      <h2>14. No resale or transfer for human use</h2>
      <p>You will not resell the material to the general public, offer it for human or veterinary use, or transfer it to anyone who intends such use. Where you transfer it lawfully to another research entity, you will bind that recipient to restrictions at least as protective as these terms and the research use policy.</p>

      <h2>15. Events outside our control</h2>
      <p>We are not liable for failure or delay caused by events beyond our reasonable control, including supplier or carrier failure, loss of cold chain in transit, natural events, labour disputes, epidemics, acts of government, or interruption of utilities or communications.</p>

      <h2>16. Governing law and venue</h2>
      <p>These terms and any dispute arising out of them are governed by the laws of the State of {state}, without regard to its conflict-of-laws rules. The state and federal courts located in {state} have exclusive jurisdiction, and both of us consent to their venue. The United Nations Convention on Contracts for the International Sale of Goods does not apply.</p>

      <h2>17. General</h2>
      <p>These terms, the research use policy, the shipping and returns policy and our written order confirmation are the entire agreement between us on their subject matter. Changes must be in writing and signed by us. Failing to enforce a provision does not waive it. If a provision is held unenforceable, the rest continues in force. You may not assign your rights without our written consent. Notices go to the addresses on the order confirmation. Sections 3, 7 to 14, 16 and 17 survive termination.</p>

      <h2>18. Contact</h2>
      <p><a href="mailto:{email}">{email}</a></p>"""))

    # -------------------------------------------------------------- privacy
    out.append(legal_page("privacy", "Privacy Policy", "Legal", "Privacy <em>policy.</em>",
        "What personal information this site collects, why, and what you can ask us to do with it.", f"""
      <h2>1. Who we are</h2>
      <p>{entity} is a sole proprietorship operating from {address}. We are responsible for the personal information described in this policy. Contact us at <a href="mailto:{email}">{email}</a>.</p>

      <h2>2. What we collect</h2>
      <p><strong>What you give us.</strong> The account application form collects your name, email address and telephone number, together with the list of compounds you have added to your request list. If your application proceeds, our follow-up correspondence collects what account verification requires: your institution, the research facility address, the responsible investigator, an institutional email address and a description of the intended research use.</p>
      <p><strong>What is collected automatically.</strong> Our hosting provider records standard server logs — IP address, browser user-agent, pages requested and timestamps — which are used to keep the site available and to investigate abuse.</p>
      <p><strong>What stays on your device.</strong> Your request list is held in your browser's local storage so it survives moving between pages. It remains on your device until you clear it or clear your browser data. We cannot see it unless you submit the form.</p>
      <p><strong>What we do not do.</strong> We set no advertising or analytics cookies, we run no tracking pixels, and we do not build profiles of visitors.</p>

      <h2>3. Why we use it</h2>
      <p>To reply to your enquiry; to verify that an account meets the eligibility conditions in our <a href="../compliance.html">research use policy</a>; to quote for, process and fulfil orders; to keep the commercial, tax and lot-traceability records our business needs; and to protect the site against abuse.</p>

      <h2>4. Who else sees it</h2>
      <p><strong>Our hosting and form provider.</strong> The site is hosted on Netlify, which serves the pages, keeps the server logs described above, and receives account applications on our behalf as a service provider.</p>
      <p><strong>No other third party.</strong> Typefaces, stylesheets, scripts and images are all served from this site itself, so loading a page contacts nobody but our hosting provider. We do not sell personal information, and we do not share it for cross-context behavioural advertising. We disclose it only where the law requires it, where we must to establish or defend a legal claim, or to a carrier where that is necessary to deliver your order.</p>

      <h2>5. How long we keep it</h2>
      <p>Enquiries that do not become accounts: 24 months from your last contact with us. Account and order records: seven years, which is what tax and commercial record-keeping requires. Server logs: as retained by our hosting provider, typically around 30 days.</p>

      <h2>6. Your rights</h2>
      <p>Wherever you are, you can ask us for a copy of the personal information we hold about you, ask us to correct it, or ask us to delete it. Email <a href="mailto:{email}">{email}</a>. We will respond within 45 days and will verify your identity against the information we already hold before acting.</p>
      <p><strong>If you are in California,</strong> the CCPA as amended by the CPRA gives you the right to know what we collect and why, to receive a copy, to correct it, to delete it, to opt out of sale or sharing, and not to be treated differently for exercising any of them. In the last 12 months we have collected identifiers (name, email address, telephone number), commercial information (the compounds you enquired about) and internet activity information (server logs), from you and from your device, for the purposes in section 3, and have disclosed them only to the service providers in section 4. We have not sold or shared personal information, and we do not collect sensitive personal information as the CPRA defines it. An authorised agent may make a request on your behalf with your written permission.</p>
      <p><strong>If you are in another US state</strong> with a comprehensive privacy law — including Virginia, Colorado, Connecticut, Utah, Texas, Oregon and Montana — you have broadly equivalent rights of access, correction, deletion and portability, and you may appeal a refusal by replying to our decision.</p>
      <p><strong>Global Privacy Control.</strong> Because we neither sell nor share personal information, there is nothing to opt out of; we honour GPC signals in any case.</p>

      <h2>7. Security</h2>
      <p>The site is served over TLS, and access to enquiries is limited to people who need it. No method of transmission or storage is completely secure, and we cannot guarantee absolute security.</p>

      <h2>8. Children</h2>
      <p>This site is directed at research professionals and is not intended for anyone under 18. We do not knowingly collect personal information from children. If you believe a child has given us information, contact us and we will delete it.</p>

      <h2>9. Where your information is processed</h2>
      <p>We operate in the United States and our service providers process information there. If you contact us from outside the United States, your information will be transferred to and processed in the United States, where privacy law differs from your own.</p>

      <h2>10. Changes</h2>
      <p>If we change this policy we will post the revised version here with a new date at the top. Where a change materially affects how we use information you have already given us, we will tell you directly.</p>

      <h2>11. Contact</h2>
      <p><a href="mailto:{email}">{email}</a></p>"""))

    # ------------------------------------------------------------- shipping
    out.append(legal_page("shipping", "Shipping &amp; Returns", "Logistics",
        "Shipping &amp; <em>returns.</em>",
        "How material is packed, shipped and received, and the narrow circumstances in which it can be returned.", f"""
      <h2>1. Where we ship</h2>
      <p>We ship to institutional, laboratory and commercial addresses only. We do not ship to residential addresses, and an order placed against one will be held until an institutional address is supplied.</p>

      <h2>2. Processing</h2>
      <p>Orders are released once the account is verified and payment or agreed credit terms are in place. Material in stock usually leaves within one to three business days. Shipments requiring cold chain are released to match carrier schedules, so that material is not sitting in a depot over a weekend.</p>

      <h2>3. Packing and cold chain</h2>
      <p>Material ships lyophilised unless stated otherwise. Where stability requires it, shipments are packed in insulated containers with gel packs or dry ice; dry-ice shipments are declared as required for carriage. Store material on arrival as its certificate of analysis specifies.</p>

      <h2>4. Carriage and tracking</h2>
      <p>We use tracked courier services domestically and internationally, and send tracking details when a shipment leaves us. Transit times are estimates: customs, weather and carrier backlogs are outside our control.</p>

      <h2>5. Title, risk and receipt</h2>
      <p>Risk of loss passes to you when the material is delivered to the carrier; title passes when we have received payment in full. Someone must be available to receive cold-chain shipments, because material left at an unattended address may no longer be fit for use.</p>

      <h2>6. Customs, duties and permits</h2>
      <p>Import duties, taxes and clearance charges are yours to pay, as are any import permits your jurisdiction requires. We declare shipments accurately and will not alter a declaration, undervalue a shipment or describe it as a gift on request. Where a shipment is seized or refused entry because a required permit was not in place, we cannot refund it.</p>

      <h2>7. Checking a shipment on arrival</h2>
      <p>Inspect the shipment when it arrives. Report shortages, visible damage or a failed cold chain in writing within 10 business days of delivery, quoting the lot number and including photographs of the packaging and its contents. Keep the packaging until the claim is settled.</p>

      <h2>8. Returns</h2>
      <p>Once material has left us we cannot verify how it has been stored or handled, so it cannot re-enter stock. Shipped material is therefore not returnable because you have changed your mind or ordered the wrong item.</p>
      <p>We will replace the material or refund what you paid for it, at our option, where: it does not conform to its certificate of analysis; we shipped the wrong item or quantity; it arrived damaged and you told us within the period in section 7; or the cold chain demonstrably failed in transit. Contact us before returning anything — material sent back without a return authorisation cannot be credited.</p>

      <h2>9. Refused and undeliverable shipments</h2>
      <p>Where a shipment is refused or cannot be delivered for a reason within your control, you are responsible for the outbound and return carriage and for any cold-chain packaging consumed. Material that has been out of controlled storage cannot be credited.</p>

      <h2>10. Cancelling an order</h2>
      <p>You may cancel at no charge any time before the shipment leaves us. Once it has left, section 8 applies.</p>

      <h2>11. Contact</h2>
      <p><a href="mailto:{email}">{email}</a></p>"""))

    return out


# --------------------------------------------------------------------------- specimen COA
# The site describes its release testing in detail but never showed the document
# that results from it, which is the one artefact a laboratory buyer actually
# recognises. This renders a specimen: real document structure and a real signal
# shape, with every value marked as illustrative. It is not, and must never be
# presented as, a certificate for a lot that exists.

def chromatogram(peaks, width=880, height=250, run=14.0, pad_l=54, pad_b=34, pad_t=14):
    """An RP-HPLC trace drawn from Gaussians, not traced by hand.

    peaks is a list of (retention_time, relative_area, sigma). The baseline
    carries a slow drift and a little high-frequency noise, because a trace
    without either reads as a diagram of a chromatogram rather than a
    chromatogram.
    """
    import math

    plot_w = width - pad_l - 8
    plot_h = height - pad_b - pad_t
    steps = 900

    def signal(t):
        y = 0.012 + 0.004 * math.sin(t * 0.55)          # column bleed drift
        for rt, area, sigma in peaks:
            y += area * math.exp(-((t - rt) ** 2) / (2 * sigma ** 2))
        # deterministic pseudo-noise: same trace on every build
        y += 0.0016 * math.sin(t * 91.7) * math.cos(t * 37.3)
        return y

    pts = []
    for i in range(steps + 1):
        t = run * i / steps
        x = pad_l + plot_w * i / steps
        y = pad_t + plot_h - plot_h * min(signal(t), 1.06) / 1.06
        pts.append(f"{x:.1f},{y:.1f}")

    ticks = []
    for minute in range(0, int(run) + 1, 2):
        x = pad_l + plot_w * minute / run
        ticks.append(
            f'<line x1="{x:.1f}" y1="{pad_t + plot_h}" x2="{x:.1f}" y2="{pad_t + plot_h + 4}"/>'
            f'<text x="{x:.1f}" y="{pad_t + plot_h + 16}" text-anchor="middle">{minute}</text>')

    grid = []
    for frac in (0.25, 0.5, 0.75, 1.0):
        y = pad_t + plot_h - plot_h * frac
        grid.append(f'<line class="coa-grid" x1="{pad_l}" y1="{y:.1f}" x2="{pad_l + plot_w}" y2="{y:.1f}"/>')

    labels = []
    for rt, area, _sigma in peaks:
        if area < 0.02:
            continue
        x = pad_l + plot_w * rt / run
        y = pad_t + plot_h - plot_h * min(area, 1.06) / 1.06
        labels.append(f'<text class="coa-peak" x="{x:.1f}" y="{y - 7:.1f}" text-anchor="middle">{rt:.2f}</text>')

    return f"""<svg class="coa-trace" viewBox="0 0 {width} {height}" role="img"
     aria-label="Specimen reverse-phase HPLC trace: a single principal peak at 8.42 minutes with three minor peaks.">
  <g class="coa-axis">
    {''.join(grid)}
    <line x1="{pad_l}" y1="{pad_t}" x2="{pad_l}" y2="{pad_t + plot_h}"/>
    <line x1="{pad_l}" y1="{pad_t + plot_h}" x2="{pad_l + plot_w}" y2="{pad_t + plot_h}"/>
    {''.join(ticks)}
    <text x="{pad_l + plot_w / 2:.0f}" y="{height - 4}" text-anchor="middle">Retention time (min)</text>
    <text x="14" y="{pad_t + plot_h / 2:.0f}" text-anchor="middle"
          transform="rotate(-90 14 {pad_t + plot_h / 2:.0f})">mAU (220 nm)</text>
  </g>
  <polyline class="coa-signal" points="{' '.join(pts)}"/>
  {''.join(labels)}
</svg>"""


def build_coa():
    peaks = [(6.91, 0.021, 0.10), (8.42, 1.00, 0.11), (9.63, 0.014, 0.10), (11.24, 0.009, 0.12)]
    rows = [
        ("Appearance", "Visual", "White to off-white lyophilised solid", "Conforms"),
        ("Identity", "ESI-MS", "[M+H]<sup>+</sup> 1420.54 &plusmn; 0.5", "1420.61 — conforms"),
        ("Purity", "RP-HPLC, 220 nm", "&ge; 98.0 % (area)", "98.7 %"),
        ("Single largest impurity", "RP-HPLC, 220 nm", "&le; 1.0 % (area)", "0.42 %"),
        ("Water content", "Karl Fischer", "&le; 8.0 %", "4.2 %"),
        ("Acetate content", "RP-HPLC", "&le; 15.0 %", "9.8 %"),
        ("Peptide content", "Nitrogen determination", "Report result", "82.4 %"),
        ("Residual solvents", "GC headspace", "ICH Q3C class 2 limits", "Conforms"),
    ]
    trs = "".join(
        f"<tr><th scope=\"row\">{n}</th><td>{m}</td><td>{sp}</td><td class=\"coa-result\">{r}</td></tr>"
        for n, m, sp, r in rows)

    ident = [
        ("Product", "BPC-157"), ("Catalogue number", "TR-BPC157-05"),
        ("Lot number", "TR-24-0417-B"), ("CAS number", "137525-51-0"),
        ("Molecular formula", "C<sub>62</sub>H<sub>98</sub>N<sub>16</sub>O<sub>22</sub>"),
        ("Molecular weight", "1419.53 g/mol"), ("Quantity", "5 mg"),
        ("Date of manufacture", "2024-04-17"), ("Retest date", "2027-04-17"),
        ("Storage", "&minus;20 &deg;C, desiccated, protected from light"),
    ]
    idrows = "".join(f"<div class=\"coa-field\"><dt>{k}</dt><dd>{v}</dd></div>" for k, v in ident)

    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <a href="quality.html">Analytical</a> <span>/</span> <span>Specimen certificate</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Documentation</span>
      <h1 class="display h-sec">Specimen <em>certificate of analysis.</em></h1>
      <p class="lede">Every lot is released against a document of this form. This is a worked example so you can see exactly what arrives with an order — the layout, the assay panel and the level of detail.</p>
    </div>

    <div class="notice" style="margin-bottom:2.5rem">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      <div>
        <h3>This is an example document</h3>
        <p>The lot number, dates and results below are illustrative and do not describe material that exists. A certificate for material you have actually been supplied carries that lot's own measured results and is signed on release. Ask us for the certificate for any lot before you order it.</p>
      </div>
    </div>

    <article class="coa" aria-label="Specimen certificate of analysis">
      <div class="coa-watermark" aria-hidden="true">SPECIMEN</div>
      <header class="coa-head">
        <div class="coa-brand">
          <img src="assets/img/mark.svg" alt="" width="100" height="206">
          <div><strong>{BRAND}</strong><span>Peptide reference material</span></div>
        </div>
        <div class="coa-title">
          <h2>Certificate of Analysis</h2>
          <p class="mono">Lot TR-24-0417-B</p>
        </div>
      </header>

      <dl class="coa-ident">{idrows}</dl>

      <h3 class="coa-h">Test results</h3>
      <table class="coa-table">
        <caption class="sr-only">Specimen test results for lot TR-24-0417-B</caption>
        <thead><tr><th scope="col">Test</th><th scope="col">Method</th><th scope="col">Specification</th><th scope="col">Result</th></tr></thead>
        <tbody>{trs}</tbody>
      </table>

      <h3 class="coa-h">Chromatographic purity</h3>
      <p class="coa-note">Column C18, 4.6 &times; 250 mm, 5 &micro;m. Gradient 20–60 % acetonitrile in water, 0.1 % TFA, over 14 min at 1.0 mL/min. Detection 220 nm. Principal peak 8.42 min, 98.7 % of total integrated area.</p>
      {chromatogram(peaks)}

      <h3 class="coa-h">Release</h3>
      <p class="coa-note">The lot described above was reviewed against its specification and released. Material is supplied for laboratory research use only; it is not for human or veterinary use, and it is not a drug, supplement, cosmetic or medical device.</p>
      <div class="coa-sign">
        <div><span class="coa-rule"></span><small>Analyst — Quality Control</small></div>
        <div><span class="coa-rule"></span><small>Date of release</small></div>
      </div>
    </article>

    <div style="margin-top:2.5rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="btn btn--primary" onclick="window.print()">Print or save as PDF</button>
      <a class="btn btn--ghost" href="quality.html">The full analytical programme</a>
    </div>
  </div>
</section>
"""
    return page("specimen-coa.html", f"Specimen Certificate of Analysis — {BRAND}",
                "A worked example of the certificate of analysis released with every lot: identification, assay panel, specifications, measured results and the HPLC trace.",
                body, "")


# --------------------------------------------------------------------------- 404
def build_404():
    body = f"""
<section class="section">
  <div class="shell-n" style="text-align:center;padding-block:4rem">
    <span class="eyebrow">Error 404</span>
    <h1 class="display h-sec">That page isn't <em>here.</em></h1>
    <p class="lede" style="margin-inline:auto">The link may be out of date, or the compound may have been withdrawn from the catalog.</p>
    <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;margin-top:2.5rem">
      <a class="btn btn--primary" href="/catalog.html">Browse the catalog</a>
      <a class="btn btn--ghost" href="/index.html">Return home</a>
    </div>
  </div>
</section>
"""
    return page("404.html", f"Page not found — {BRAND}", "The requested page could not be found.", body, "")


# --------------------------------------------------------------------------- assets
def build_meta(pages):
    (ROOT / "assets/img").mkdir(parents=True, exist_ok=True)
    # assets/img/favicon.svg and mark.svg are produced by tools/make_logo.py

    urls = "".join(
        f"  <url><loc>{SITE}/{u}</loc><lastmod>{TODAY}</lastmod>"
        f"<priority>{'1.0' if u == 'index.html' else '0.8' if '/' not in u else '0.6'}</priority></url>\n"
        for u in pages if u != "404.html")
    (ROOT / "sitemap.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n',
        encoding="utf-8")

    (ROOT / "assets/js/config.js").write_text(
        "/* Generated by tools/build.py - do not edit. Set TR_SITE, TR_CONTACT_EMAIL,\n"
        "   TR_FORM_PROVIDER and TR_FORM_ENDPOINT in the build environment instead. */\n"
        "window.TR_CONFIG = " + json.dumps(
            {"contactEmail": CONTACT_EMAIL, "formProvider": FORM_PROVIDER,
             "formEndpoint": FORM_ENDPOINT}, indent=2
        ) + ";\n", encoding="utf-8")

    (ROOT / "robots.txt").write_text(
        ("User-agent: *\nDisallow: /\n" if DEMO else
         f"User-agent: *\nAllow: /\nDisallow: /tools/\n\nSitemap: {SITE}/sitemap.xml\n"),
        encoding="utf-8")

    # Netlify and Cloudflare Pages both read _redirects; without it a static
    # host returns its own 404 rather than the one in this repo.
    (ROOT / "_redirects").write_text("/*  /404.html  404\n", encoding="utf-8")


# --------------------------------------------------------------------------- main
def main():
    for d in ("products", "legal"):
        p = ROOT / d
        if p.exists():
            shutil.rmtree(p)

    pages = [build_home(), build_catalog(), build_quality(), build_about(),
             build_faq(), build_contact(), build_compliance(), build_coa(), build_404()]
    pages += build_products()
    pages += build_legal()

    # {PREFIX} placeholders emitted by vial() resolve per page depth
    for rel_path in pages:
        f = ROOT / rel_path
        txt = f.read_text(encoding="utf-8")
        if "{PREFIX}" in txt:
            f.write_text(txt.replace("{PREFIX}", rel(rel_path.count("/"))), encoding="utf-8")

    build_meta(pages)
    print(f"Built {len(pages)} pages:")
    for p in pages:
        print(f"  {p}")
    print("  sitemap.xml\n  robots.txt")


if __name__ == "__main__":
    main()
