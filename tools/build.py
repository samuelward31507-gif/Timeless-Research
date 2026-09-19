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
import pathlib
import re
import shutil
import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "assets/data/products.json").read_text(encoding="utf-8"))
PRODUCTS = DATA["products"]
CATEGORIES = DATA["categories"]
CAT_LABEL = {c["id"]: c["label"] for c in CATEGORIES}
CAT_TINT = {c["id"]: (c["tint"], c["tintDeep"]) for c in CATEGORIES}

SITE = "https://www.timelessresearch.com"
BRAND = "Timeless Research"
TODAY = datetime.date.today().isoformat()

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
def head(title, desc, depth, canonical, extra=""):
    p = rel(depth)
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
<meta property="og:image" content="{SITE}/vial.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#FAF9F7">
<link rel="icon" href="{p}assets/img/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script>document.documentElement.className+=" js";</script>
<link rel="stylesheet" href="{p}assets/css/fonts.css">
<link rel="stylesheet" href="{p}assets/css/main.css">
<script src="{p}assets/js/site.js" defer></script>
{extra}</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
"""


def header(depth, active):
    p = rel(depth)
    CUR = ' aria-current="page"'
    links = "".join(
        '<a href="{}{}"{}>{}</a>'.format(p, href, CUR if href == active else "", E(label))
        for label, href in NAV
    )
    return f"""<div class="announce">
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
<main id="main">
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
    doc = head(title, desc, depth, path, extra_head) + header(depth, active) + body + extra_body + footer(depth)
    out.write_text(doc, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- pieces
def label_name(name: str) -> str:
    """Keep parenthetical qualifiers on one line.

    Plain wrapping breaks "CJC-1295 (no DAC)" after "(no", which reads as a
    typo on a label. Spaces inside brackets become non-breaking so the
    qualifier travels as a unit.
    """
    return re.sub(r"\(([^)]*)\)", lambda mo: "(" + mo.group(1).replace(" ", "\u00a0") + ")", name)


def vial(p_name, size_label, height=240, alt="", purity=None):
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
    they render under 6px and read as a smudge."""
    compact = height < 260

    foot = ""
    if not compact:
        pur = f'<span class="vp-pill">Purity {E(purity)}</span>' if purity else ""
        foot = ('\n    <span class="vp-foot">' + pur +
                '<span class="vp-ruo">Research Use Only</span></span>')

    return f"""<span class="vial" style="--vial-h:{height}px">
  <picture>
    <source srcset="{{PREFIX}}assets/img/vial.webp" type="image/webp">
    <img src="{{PREFIX}}assets/img/vial.png" alt="{E(alt) if alt else ''}" width="489" height="880" loading="lazy" decoding="async">
  </picture>
  <span class="vial-print" aria-hidden="true">
    <span class="vp-name">{E(label_name(p_name))}</span>
    <span class="vp-dose">{E(size_label)}</span>
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
          {vial(p['name'], p['sizes'][0], 285, purity=p.get('purity'))}
          <span class="product-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 6 6L20 6"/></svg>{E(p['purity'])} HPLC</span>
        </div>
        <div class="product-body">
          <div class="product-head">
            <h3 class="product-name"><a href="products/{p['id']}.html">{E(p['name'])}</a></h3>
            <span class="product-cas">CAS {E(p['cas'] or '—')}</span>
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
      <p class="lede">Thirty-four compounds across seven research areas. Every listing carries CAS number, molecular formula, sequence, storage conditions and the assay panel applied at release.</p>
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
    <div style="margin-top:2.5rem"><a class="btn btn--ghost" href="quality.html">Read the full analytical programme</a></div>
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
        <p>Pricing is issued by quotation against a confirmed account, so that lot availability, quantity breaks and shipping conditions are agreed in writing before an order is placed.</p>
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
                body, "index.html")


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
        sizes = "".join(f'<option value="{E(s)}">{E(s)}</option>' for s in p["sizes"])
        tint, tint_deep = CAT_TINT[p['category']]
        cards.append(f"""
        <article class="product" data-cat="{p['category']}" data-search="{E(hay)}">
          <div class="product-media" style="--tint:{tint};--tint-deep:{tint_deep}">
            {vial(p['name'], p['sizes'][0], 285, purity=p.get('purity'))}
            {'<span class="product-flag">Restricted</span>' if p.get('restricted') else ''}
            <span class="product-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 6 6L20 6"/></svg>{E(p['purity'])} HPLC</span>
          </div>
          <div class="product-body">
            <div class="product-head">
              <h3 class="product-name"><a href="products/{p['id']}.html">{E(p['name'])}</a></h3>
              <span class="product-cas">CAS {E(p['cas'] or '—')}</span>
            </div>
            <p class="product-sub">{E((p.get('synonyms') or [CAT_LABEL[p['category']]])[0])}</p>
            <div class="product-foot">
              <select aria-label="Pack size for {E(p['name'])}" data-size>{sizes}</select>
              <button class="link-action" data-add="{p['id']}" data-name="{E(p['name'])}">Add to list</button>
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
      <p class="lede">{len(PRODUCTS)} characterised compounds. Select pack sizes and build a request list — pricing and lot availability are confirmed by quotation against a verified account.</p>
    </div>
    {RUO_NOTICE}
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
        <p class="muted mono" id="result-count" style="font-size:.7rem;margin-bottom:1.25rem" aria-live="polite"></p>
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

        rows = [
            ("CAS number", p.get("cas") or "Not assigned", False),
            ("Molecular formula", p.get("formula") or "—", False),
            ("Molecular weight", f"{p['mw']} g/mol" if p.get("mw") else "—", False),
            ("Sequence", p.get("sequence") or "Not applicable", False),
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
        sizes_opt = "".join(f'<option value="{E(s)}">{E(s)}</option>' for s in p["sizes"])

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
          {vial(p['name'], p['sizes'][0], 400, alt=f"{p['name']} research vial, {p['sizes'][0]}", purity=p.get('purity'))}
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

        <div class="field" style="margin-bottom:1.5rem">
          <label for="size-select">Pack size</label>
          <select id="size-select" data-size>{sizes_opt}</select>
        </div>
        <button class="btn btn--primary" data-add="{p['id']}" data-name="{E(p['name'])}">Add to request list</button>
        <p class="muted" style="font-size:.72rem;margin:.9rem 0 2.5rem">Pricing and lot availability confirmed by quotation against a verified account.</p>

        <table class="spec">
          <caption>Specification</caption>
          <tbody>{spec_rows}</tbody>
        </table>

        <h2 style="font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin:2.5rem 0 1rem">Release assay panel</h2>
        <ul style="list-style:none;display:flex;flex-wrap:wrap;gap:.5rem">{assay_rows.replace('<li>', '<li class="chip" style="padding:.3rem .6rem">')}</ul>
        <p class="muted" style="font-size:.78rem;margin-top:1rem;line-height:1.7">The certificate of analysis for the supplied lot reproduces the HPLC trace and mass spectrum, and is issued with the shipment. <a href="../quality.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">How lots are released</a>.</p>
      </div>
    </div>
  </div>
</section>

<section class="section section--alt">
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
                            extra_head=f'<script type="application/ld+json">{ld}</script>\n'))
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
        <h3>Retest, not expiry</h3>
        <p>Lyophilised peptides stored correctly do not simply expire on a date. We publish a retest date rather than an expiry: at that point the lot is re-assayed against its original specification and either re-released with updated data or withdrawn.</p>
        <h3>What we do not claim</h3>
        <p>We do not certify our material as sterile, endotoxin-free or pharmaceutical grade unless the certificate for that specific lot says so and reports the test that established it. Reagent solutions are tested for sterility and endotoxin; lyophilised research peptides generally are not, and should not be treated as though they were.</p>
      </div>
    </div>
  </div>
</section>

<section class="section section--alt">
  <div class="shell">{RUO_NOTICE}</div>
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

<section class="section">
  <div class="shell">{RUO_NOTICE}</div>
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
     "Because we need to know who the material is going to and what it is for before it ships. Pricing is issued by quotation against a verified account so that lot availability, quantity and shipping conditions are agreed in writing first. Building a request list on this site starts that process; it is not a purchase."),
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
    <div style="margin-top:3rem">{RUO_NOTICE}</div>
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
      <h1 class="display h-sec">Open an <em>account.</em></h1>
      <p class="lede">Tell us about the laboratory and the intended research use. We review each application individually and respond within two business days.</p>
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
        {RUO_NOTICE}
        <div class="prose" style="margin-top:2rem">
          <h3>What we need</h3>
          <ul>
            <li>The institution or company name, and its research facility address</li>
            <li>The responsible investigator or laboratory manager</li>
            <li>An institutional email address</li>
            <li>A short description of the intended research use</li>
          </ul>
          <h3>What we cannot help with</h3>
          <p>We do not provide dosing, administration or therapeutic guidance, and we do not supply individuals for personal use. Enquiries framed around human or veterinary use will be declined.</p>
          <h3>Technical support</h3>
          <p>For questions on identity, purity, solubility, stability, storage or certificates of analysis, use the form and select “Technical question”. Lot-specific certificates are available to account holders on request.</p>
        </div>
      </div>

      <div>
        <form id="account-form" novalidate>
          <div class="field-row">
            <div class="field">
              <label for="f-name">Full name <span class="req" aria-hidden="true">*</span></label>
              <input id="f-name" name="name" type="text" required autocomplete="name">
              <p class="field-error">Please enter your name.</p>
            </div>
            <div class="field">
              <label for="f-role">Role <span class="req" aria-hidden="true">*</span></label>
              <input id="f-role" name="role" type="text" required placeholder="e.g. Principal Investigator">
              <p class="field-error">Please enter your role.</p>
            </div>
          </div>

          <div class="field">
            <label for="f-org">Institution or company <span class="req" aria-hidden="true">*</span></label>
            <input id="f-org" name="organisation" type="text" required autocomplete="organization">
            <p class="field-error">Please enter your institution.</p>
          </div>

          <div class="field">
            <label for="f-email">Institutional email <span class="req" aria-hidden="true">*</span></label>
            <input id="f-email" name="email" type="email" required autocomplete="email">
            <p class="hint">We cannot process applications submitted from personal email addresses.</p>
            <p class="field-error">Please enter a valid institutional email address.</p>
          </div>

          <div class="field">
            <label for="f-country">Country of the research facility <span class="req" aria-hidden="true">*</span></label>
            <input id="f-country" name="country" type="text" required autocomplete="country-name">
            <p class="field-error">Please enter a country.</p>
          </div>

          <div class="field">
            <label for="f-type">Enquiry type</label>
            <select id="f-type" name="enquiry_type">
              <option>Account application</option>
              <option>Quotation request</option>
              <option>Technical question</option>
              <option>Certificate of analysis request</option>
              <option>Other</option>
            </select>
          </div>

          <div class="field">
            <label for="f-use">Intended research use <span class="req" aria-hidden="true">*</span></label>
            <textarea id="f-use" name="research_use" required placeholder="Describe the in vitro research application, including the compounds and quantities of interest."></textarea>
            <p class="field-error">Please describe the intended research use.</p>
          </div>

          <div class="field">
            <label class="check">
              <input type="checkbox" id="f-confirm" name="confirm" required>
              <span>I confirm that I am ordering on behalf of a research institution or qualified laboratory, that all material will be used solely for <strong>in vitro</strong> laboratory research, and that it will not be administered to humans or animals. <span class="req" aria-hidden="true">*</span></span>
            </label>
            <p class="field-error">This confirmation is required.</p>
          </div>

          <button class="btn btn--primary btn--block" type="submit">Submit application</button>
          <p class="muted" style="font-size:.7rem;margin-top:1rem;text-align:center">By submitting you agree to our <a href="legal/privacy.html" style="color:var(--accent);text-decoration:underline">privacy policy</a> and <a href="compliance.html" style="color:var(--accent);text-decoration:underline">research use policy</a>.</p>
          <div id="form-status" role="status" aria-live="polite" style="margin-top:1rem"></div>
        </form>
      </div>
    </div>
  </div>
</section>
"""
    return page("contact.html", f"Contact &amp; Account Application — {BRAND}",
                "Apply for an institutional research account, request a quotation, or ask a technical question about identity, purity, storage or certificates of analysis.",
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
    {RUO_NOTICE}
    <div class="prose" style="margin-top:2.5rem">
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
LEGAL_BANNER = """<div class="notice" style="margin-bottom:2.5rem">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
  <div><h3>Template — requires legal review before publication</h3>
  <p>This document is a drafting starting point, not legal advice. Placeholders in [SQUARE BRACKETS] must be completed, and the whole document must be reviewed by a qualified lawyer in your operating jurisdiction before the site goes live.</p></div>
</div>"""


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
    {LEGAL_BANNER}
    <div class="prose">{prose}</div>
  </div>
</section>
"""
    return page(f"legal/{slug}.html", f"{title} — {BRAND}", lede, body, "")


def build_legal():
    out = []
    out.append(legal_page("terms", "Terms of Sale", "Legal", "Terms of <em>sale.</em>",
        "The terms on which {b} accepts orders and supplies material.".format(b=BRAND), f"""
      <h2>1. Parties and scope</h2>
      <p>These terms govern all sales by {BRAND}, [REGISTERED COMPANY NAME], registered at [REGISTERED ADDRESS], company number [NUMBER] (“we”, “us”), to the account holder placing the order (“you”). They apply to the exclusion of any terms you seek to impose.</p>
      <h2>2. Eligibility and acceptance</h2>
      <p>Orders may be placed only by verified institutional or qualified-research accounts. Submitting a request list or quotation request is an invitation to treat, not an order. A contract forms only when we issue a written order confirmation. We may decline any order at our discretion, including where account verification is incomplete or the stated research use falls outside our <a href="../compliance.html">research use policy</a>.</p>
      <h2>3. Research use condition</h2>
      <p>Every sale is conditional on your agreement to the research use policy, which is incorporated into these terms. Breach of that policy is a material breach of contract entitling us to terminate immediately and to decline future orders.</p>
      <h2>4. Pricing and payment</h2>
      <p>Prices are those stated in the written quotation, are valid for [30] days, and exclude taxes, duties and shipping unless stated. Payment terms are [PAYMENT TERMS]. We reserve the right to require payment in advance. Late payment accrues interest at [RATE] in accordance with [APPLICABLE STATUTE].</p>
      <h2>5. Delivery and risk</h2>
      <p>Delivery estimates are estimates, not guarantees. Risk passes on delivery to the address stated on the order confirmation; title passes on payment in full. Shipments are made to institutional addresses only.</p>
      <h2>6. Specification and warranty</h2>
      <p>We warrant that, at the time of release, material conforms to the specification on the certificate of analysis issued for the supplied lot. This is the entire warranty. We give no warranty of merchantability, fitness for a particular purpose, sterility, endotoxin status, or suitability for any specific experimental application, and no warranty that use will not infringe third-party intellectual property.</p>
      <h2>7. Non-conforming material</h2>
      <p>Claims that material does not meet specification must be made within 30 days of delivery, quoting the lot number and supporting data. Our sole obligation is, at our option, replacement of the material or refund of the price paid. See the <a href="shipping.html">shipping and returns policy</a>.</p>
      <h2>8. Limitation of liability</h2>
      <p>Nothing in these terms limits liability for death or personal injury caused by negligence, for fraud, or for any liability that cannot lawfully be limited. Subject to that, our total liability arising from any order is limited to the price paid for the material giving rise to the claim, and we are not liable for loss of profit, loss of data, loss of experimental work, or any indirect or consequential loss.</p>
      <h2>9. Indemnity</h2>
      <p>You indemnify us against all claims, losses and costs arising from your use, handling, storage, resale or transfer of material supplied, including any use in breach of the research use policy.</p>
      <h2>10. Export, import and compliance</h2>
      <p>You are responsible for import permits, customs classification and compliance with the law of the destination jurisdiction. We will not mis-declare the contents, value or classification of any shipment.</p>
      <h2>11. Governing law</h2>
      <p>These terms are governed by the law of [JURISDICTION], and the courts of [JURISDICTION] have exclusive jurisdiction.</p>
      <h2>12. Contact</h2>
      <p>[LEGAL CONTACT EMAIL] · [REGISTERED ADDRESS]</p>"""))

    out.append(legal_page("privacy", "Privacy Policy", "Legal", "Privacy <em>policy.</em>",
        "What personal data we collect when you apply for an account, and how it is handled.", f"""
      <h2>1. Controller</h2>
      <p>The controller is {BRAND}, [REGISTERED COMPANY NAME], [REGISTERED ADDRESS]. Data protection contact: [DPO / PRIVACY EMAIL].</p>
      <h2>2. What we collect</h2>
      <ul>
        <li><strong>Account application data</strong> — name, role, institution, institutional email, country, and the description of intended research use you provide.</li>
        <li><strong>Order and correspondence records</strong> — quotations, order confirmations, shipping records and technical correspondence.</li>
        <li><strong>Technical data</strong> — server logs including IP address, user agent and pages requested, retained for [PERIOD] for security and diagnostics.</li>
      </ul>
      <p>Your request list is stored in your own browser using local storage. It is not transmitted to us until you submit a quotation request, and you can clear it at any time from the request list panel.</p>
      <h2>3. Why we process it, and on what basis</h2>
      <ul>
        <li><strong>Account verification and supply</strong> — performance of a contract, and compliance with our legal obligations in restricting supply of research material.</li>
        <li><strong>Regulatory and audit records</strong> — legal obligation and legitimate interest in demonstrating responsible supply.</li>
        <li><strong>Security and fraud prevention</strong> — legitimate interest.</li>
      </ul>
      <p>We do not sell personal data, and we do not use it for advertising or profiling.</p>
      <h2>4. Retention</h2>
      <p>Account and order records are retained for [RETENTION PERIOD] to meet accounting and supply-audit obligations. Declined applications are retained for [PERIOD] and then deleted.</p>
      <h2>5. Sharing</h2>
      <p>We share data with carriers for delivery, with payment providers for settlement, and with professional advisers or regulators where legally required. Processors are bound by written agreements. Where data is transferred outside [JURISDICTION], we rely on [TRANSFER MECHANISM].</p>
      <h2>6. Your rights</h2>
      <p>Subject to applicable law you may request access, rectification, erasure, restriction, portability, or object to processing based on legitimate interest. Contact [PRIVACY EMAIL]. You may complain to [SUPERVISORY AUTHORITY].</p>
      <h2>7. Cookies</h2>
      <p>This site sets no advertising or analytics cookies. Local storage is used solely to keep your request list between pages. If analytics are introduced, this policy will be updated and consent obtained where required.</p>
      <h2>8. Changes</h2>
      <p>Material changes will be notified to account holders by email.</p>"""))

    out.append(legal_page("shipping", "Shipping &amp; Returns", "Logistics", "Shipping &amp; <em>returns.</em>",
        "How orders are packed, shipped, and handled if something is wrong.", f"""
      <h2>1. Destinations</h2>
      <p>We ship to institutional research addresses only. We do not deliver to residential addresses, mail-forwarding services or PO boxes. International shipments are accepted only where the material may lawfully be imported for research use.</p>
      <h2>2. Processing and dispatch</h2>
      <p>Orders against a verified account are dispatched within [1–2] business days of confirmed payment, subject to lot availability. Where a lot is in quarantine pending release, we will tell you the expected release date rather than ship unreleased material.</p>
      <h2>3. Packing and cold chain</h2>
      <p>Lyophilised peptides are stable for shipping at ambient temperature for the duration of transit, and are packed with desiccant and protected from light. Where stability data indicates it, shipments are sent in insulated packaging with coolant, and the packing documentation notes the cold-chain condition. Transfer material to -20 °C on arrival.</p>
      <h2>4. Inspection on arrival</h2>
      <p>Inspect the shipment on receipt. Report visible damage, temperature excursion or discrepancy within 5 business days, with photographs and the lot number.</p>
      <h2>5. Non-conforming material</h2>
      <p>If material does not meet the specification on its certificate of analysis, notify us within 30 days of delivery with the lot number and your supporting data. Where the claim is substantiated we will, at our option, replace the material or refund the price paid, and we will cover return shipping. Material must not be returned before we issue a return authorisation.</p>
      <h2>6. Returns we cannot accept</h2>
      <p>Because storage conditions after delivery cannot be verified, we cannot accept returns of correctly supplied, conforming material — including where an order was placed in error, where requirements changed, or where material has been opened, reconstituted or transferred out of its original vial. Returns of restricted reference standards are not accepted under any circumstances.</p>
      <h2>7. Lost or delayed shipments</h2>
      <p>Report non-delivery within [15] business days of dispatch so a carrier trace can be opened. We will replace material confirmed lost in transit.</p>
      <h2>8. Customs and duties</h2>
      <p>Import duties, taxes and clearance charges are the account holder's responsibility, as are import permits. Shipments are declared accurately; we will not alter a declaration on request. Where a shipment is seized or refused entry because a required permit was not in place, we cannot refund it.</p>
      <h2>9. Contact</h2>
      <p>[LOGISTICS EMAIL]</p>"""))
    return out


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

    (ROOT / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nDisallow: /tools/\n\nSitemap: {SITE}/sitemap.xml\n", encoding="utf-8")


# --------------------------------------------------------------------------- main
def main():
    for d in ("products", "legal"):
        p = ROOT / d
        if p.exists():
            shutil.rmtree(p)

    pages = [build_home(), build_catalog(), build_quality(), build_about(),
             build_faq(), build_contact(), build_compliance(), build_404()]
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
