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

# Quantity breaks, applied per cart line (one compound at one pack size) rather
# than across the order, because that is what the customer can see themselves
# in the cart and what the checkout function can verify without trusting a
# total the browser worked out. Sorted ascending so the highest tier a line
# qualifies for is the last one that matches.
VOLUME_TIERS = sorted(
    ({"minQty": int(t["minQty"]), "percent": float(t["percent"])}
     for t in DATA.get("volumeTiers", [])),
    key=lambda t: t["minQty"])
# Goods subtotal, excluding shipping and tax, above which standard shipping is
# free. 0 or absent turns it off everywhere, including the checkout function.
FREE_SHIPPING_OVER = float(DATA.get("freeShippingOver") or 0)


def tier_for(qty: int) -> dict | None:
    """The best quantity break a line of `qty` units qualifies for."""
    best = None
    for t in VOLUME_TIERS:
        if qty >= t["minQty"]:
            best = t
    return best
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
OG_SECTIONS = {"catalog", "quality", "about", "faq", "contact", "pay",
               "compliance", "specimen-coa"}


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
                       "for laboratory research use.",
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


GATE_JS = """
(function(){var K='tr_ruo_ack_v1',d=document;
try{if(localStorage.getItem(K)==='1')return;}catch(e){return;}
d.documentElement.className+=' gate-on';
d.addEventListener('click',function(e){var t=e.target;
if(t.id==='gate-enter'){try{localStorage.setItem(K,'1');}catch(x){}
d.documentElement.className=d.documentElement.className.replace(/ ?gate-on/,'');
var m=d.getElementById('main');if(m)m.focus();return;}
if(t.name==='gate-ack'){var b=d.querySelectorAll('input[name=gate-ack]'),ok=true,i;
for(i=0;i<b.length;i++){if(!b[i].checked)ok=false;}
var g=d.getElementById('gate-enter');if(g)g.disabled=!ok;}});})();
""".replace("\n", "")


def gate() -> str:
    """The affirmation shown before the site is browsed.

    Deliberately not called verification. We cannot check a visitor's age or
    what they intend to do with the material, and every other page on this site
    is careful to say that the research use condition is contractual rather than
    a vetting process. A gate captioned "researcher verification" — which is
    what this sector's convention calls it — would contradict all of it on the
    very first screen. The footnote says what the tick boxes are and are not.

    Fails open, in three ways, each on purpose: no JavaScript means no gate,
    because locking the catalogue behind a script would hide it from everyone
    with JS disabled and gain nothing a determined visitor could not bypass;
    blocked localStorage (private browsing) means no gate, for the same reason;
    and the way out is a plain link, which works even if everything else breaks.
    """
    return """<div class="gate" id="gate" role="dialog" aria-labelledby="gate-title">
  <div class="gate-card">
    <img class="gate-mark" src="{PREFIX}assets/img/mark.svg" alt="" width="100" height="206">
    <span class="eyebrow">Research use only</span>
    <p class="display gate-title" id="gate-title">Before you <em>continue.</em></p>
    <p class="gate-lede">Timeless Research supplies peptide reference material for laboratory research. Please confirm both statements.</p>
    <div class="gate-checks">
      <label class="check"><input type="checkbox" name="gate-ack"><span>I am at least 21 years old.</span></label>
      <label class="check"><input type="checkbox" name="gate-ack"><span>I am acquiring this material for <strong>in vitro</strong> laboratory research. It will not be administered to a human or an animal.</span></label>
    </div>
    <button class="btn btn--primary btn--block" id="gate-enter" type="button" disabled>Enter the site</button>
    <p class="gate-note">These are statements you make, not checks we perform. We have no way to verify either one and we do not claim to &mdash; they are a condition of sale under our <a href="{PREFIX}legal/terms.html">terms</a> and <a href="{PREFIX}compliance.html">research use policy</a>. Material supplied is not for human or veterinary use, not for use in diagnostic procedures, and has not been evaluated by the US Food and Drug Administration.</p>
    <p class="gate-exit">Not buying for research? <a href="https://www.google.com/" rel="noopener">Leave this site</a>.</p>
  </div>
</div>
"""


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
<script>document.documentElement.className+=" js";{GATE_JS}</script>
{ANALYTICS_HEAD}<script src="{p}assets/js/config.js"></script>
<link rel="stylesheet" href="{p}assets/css/fonts.css">
<link rel="stylesheet" href="{p}assets/css/main.css">
<script src="{p}assets/js/site.js" defer></script>
{extra}</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
{gate()}"""


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
    <span>COA issued with every lot</span>
    <span>Orders ship in 1&ndash;3 business days</span>
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
      <button class="btn btn--ghost btn--sm rfq-btn" id="rfq-open" aria-haspopup="dialog" aria-label="Cart">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h2.2l2.3 11.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.55L20.5 7H5.2"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/></svg>
        <span class="rfq-label">Cart</span><span class="rfq-count" id="rfq-count" aria-live="polite">0</span>
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
        <p class="footer-note">Analytical-grade peptide reference material for laboratory research. Every lot ships with a certificate of analysis.</p>
      </div>
      <div>
        <h3>Catalog</h3>
        <ul>{cat_links}<li><a href="{p}catalog.html">All compounds</a></li></ul>
      </div>
      <div>
        <h3>Company</h3>
        <ul>
          <li><a href="{p}about.html">About</a></li>
          <li><a href="{p}faq.html">FAQ</a></li>
          <li><a href="{p}contact.html">Contact</a></li>
          <li><a href="{p}pay.html">Ordering &amp; payment</a></li>
        </ul>
      </div>
      <div>
        <h3>Documentation</h3>
        <ul>
          <li><a href="{p}coa.html">Certificates of analysis</a></li>
          <li><a href="{p}specimen-coa.html">Specimen certificate</a></li>
          <li><a href="{p}quality.html">Analytical programme</a></li>
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
    <p class="footer-fda">
      <strong>FDA disclaimer.</strong> Statements made about these products have not been evaluated by the US Food and Drug Administration. These products are not intended to diagnose, treat, cure or prevent any disease. All products are supplied strictly for laboratory research use by qualified professionals and are not for human, veterinary or food use in any form. Nothing on this site is a substitute for advice from a qualified healthcare practitioner.
    </p>
    <div class="footer-bottom">
      <span>&copy; {datetime.date.today().year} {BRAND}. All rights reserved.</span>
      <span>Products are supplied for laboratory research use only. Not for human or veterinary use, food, or household use.</span>
    </div>
  </div>
</footer>

<div class="drawer-scrim" id="rfq-scrim"></div>
<aside class="drawer" id="rfq-drawer" role="dialog" aria-modal="true" aria-labelledby="rfq-title" aria-hidden="true">
  <div class="drawer-head">
    <h2 id="rfq-title">Cart</h2>
    <button class="btn btn--quiet btn--sm" id="rfq-close" aria-label="Close cart">Close</button>
  </div>
  <div class="drawer-body" id="rfq-body"></div>
  <div class="drawer-foot" id="rfq-foot" hidden>
    <div class="field cart-consent">
      <label class="check">
        <input type="checkbox" id="cart-confirm">
        <span>I confirm I am ordering for laboratory research use, and that this material will not be administered to a human or an animal.</span>
      </label>
    </div>
    <button class="btn btn--primary btn--block" id="cart-checkout">Checkout</button>
    <p class="cart-foot-note">Card payment is taken by Stripe on their own page. Shipping and any tax are added there.</p>
    <p class="cart-error" id="cart-error" role="alert" hidden></p>
    <button class="btn btn--quiet btn--sm btn--block" id="rfq-clear">Clear cart</button>
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


def buyable(p) -> bool:
    """Whether a product can be put in the cart and paid for on the site.

    Two independent flags can say no, and they are deliberately separate:

      `available: false`  stock. The compound is ours to sell but we have none.
      `cart: false`       how it is sold. The compound is listed and priced, but
                          the order is taken by email rather than by card.

    `restricted` is neither of those and does not appear here. It marks a
    compound that corresponds to an approved or investigational pharmaceutical,
    which earns it a notice and a badge saying what it is — a fact about the
    material, not a route to the checkout. Conflating the two was a mistake:
    the notice belongs on the page whatever the payment mechanics are, and the
    operator needs to be able to pull one SKU out of the cart (if a processor
    objects to it, say) without deleting what the page says about it.
    """
    return bool(p.get("available", True)) and p.get("cart", True) is not False


# Ids the browser is told not to put in the cart, so the UI can refuse early
# with a sentence rather than a failed request. Not the enforcement: the
# checkout function re-checks every id against its own copy of the catalogue,
# because anything the browser is told, the browser can be made to ignore.
NO_CART_IDS = sorted(p["id"] for p in PRODUCTS if p.get("cart") is False)


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

    # The strength sits at the head of the bottom block, above the release
    # lines, rather than under the compound name. Below 260px there is no
    # bottom block, so it stays with the name.
    dose = f'<span class="vp-dose">{E(size_label)}</span>'

    foot = ""
    if not compact:
        pur = f'<span class="vp-pill">Purity {E(purity)}</span>' if purity else ""
        foot = ('\n    <span class="vp-foot">' + dose + meta + pur +
                '<span class="vp-ruo">Research Use Only</span></span>')
        meta = ""   # consumed by the foot
        dose = ""   # ditto

    return f"""<span class="vial" style="--vial-h:{height}px">
  <picture>
    <source srcset="{{PREFIX}}assets/img/vial.webp" type="image/webp">
    <img src="{{PREFIX}}assets/img/vial.png" alt="{E(alt) if alt else ''}" width="{VIAL_W}" height="{VIAL_H}" loading="lazy" decoding="async">
  </picture>
  <span class="vial-print" aria-hidden="true">
    <span class="vp-name">{E(label_name(p_name))}</span>{dose}{meta}
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
    <p>All material supplied by {BRAND} is intended exclusively for <strong>in vitro</strong> laboratory research and analytical method development by qualified professionals. Nothing offered here is a drug, dietary supplement, cosmetic or medical device. It is not for human or veterinary use, not for clinical or diagnostic procedures, and not for food or household use. We do not provide dosing, administration or therapeutic guidance of any kind. Placing an order is your confirmation that the material is for laboratory research use and will not be administered to a human or an animal.</p>
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
      <article class="product" data-id="{p['id']}" data-reveal data-reveal-delay="{i % 3}">
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
        <p class="lede">Analytical-grade research peptides — each lot identity-confirmed by mass spectrometry, purity-assayed by HPLC, and released against a signed certificate of analysis. Priced on the page and paid for by card.</p>
        <div class="hero-actions">
          <a class="btn btn--primary" href="catalog.html">Browse the catalog</a>
          <a class="btn btn--ghost" href="quality.html">How lots are released</a>
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
        <span class="eyebrow">Ordering</span>
        <h2 class="display h-sec">Priced on the page. <em>Paid by card.</em></h2>
      </div>
      <div class="prose" data-reveal data-reveal-delay="1">
        <p>Every pack size carries its list price. Add what you need to the cart and pay by card — checkout is hosted by Stripe, which collects your name, email, phone number and shipping address and takes the payment. There is no account to apply for and no quotation to wait on.</p>
        <p>Research use is a condition of every sale, not a formality. You confirm it at checkout, it is written into the <a href="legal/terms.html">terms of sale</a>, and an order we have reason to believe is destined for human or veterinary use is cancelled and refunded rather than shipped.</p>
        <p>Some compounds correspond to approved or investigational pharmaceutical substances. Those are flagged as <strong>restricted reference standards</strong> on their specification pages, because what they are is worth stating plainly. The conditions of sale are the same for them as for everything else: supplied for <strong>in vitro</strong> method development, never for administration.</p>
        <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:2rem">
          <a class="btn btn--primary" href="catalog.html">Browse the catalog</a>
          <a class="btn btn--ghost" href="pay.html">How ordering works</a>
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
        if p.get("cart") is False:
            action = f'<a class="link-action" href="contact.html?item={p["id"]}">Enquire</a>'
        elif p.get("available", True):
            action = (f'<button class="link-action" data-add="{p["id"]}" '
                      f'data-name="{E(p["name"])}">Add to cart</button>')
        else:
            action = '<span class="muted" style="font-size:.72rem">Not currently supplied</span>'
        tint, tint_deep = CAT_TINT[p['category']]
        cards.append(f"""
        <article class="product" data-id="{p['id']}" data-cat="{p['category']}" data-search="{E(hay)}" data-available="{str(p.get('available', True)).lower()}" data-price="{(p.get('prices') or {}).get(p['sizes'][0], 0)}" data-name="{E(p['name'])}">
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
              {action}
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
      <p class="lede">{len(PRODUCTS)} characterised compounds, priced by pack size and paid for by card at checkout. Compounds marked <strong>Restricted</strong> correspond to an approved or investigational pharmaceutical substance and are supplied as analytical reference standards for <strong>in vitro</strong> method development.</p>
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

        if p.get("cart") is False:
            price_caption = "indicative list price, confirmed on enquiry"
            buy_control = (f'<a class="btn btn--primary" href="../contact.html?item={p["id"]}">'
                           f'Enquire about this compound</a>')
            buy_note = ("Not sold through the cart. Tell us what you need and we will reply by "
                        "email with availability and a price.")
        elif p.get("available", True):
            price_caption = "per vial, excluding shipping and tax"
            buy_control = (f'<button class="btn btn--primary" data-add="{p["id"]}" '
                           f'data-name="{E(p["name"])}">Add to cart</button>')
            buy_note = ("Shipping and any tax are added at checkout. Payment is taken by Stripe "
                        "on their own page; we never see your card details.")
        else:
            price_caption = "last list price; not currently supplied"
            buy_control = '<a class="btn btn--ghost" href="../contact.html">Ask about availability</a>'
            buy_note = ("Not currently supplied. Tell us what you need and we will say when this "
                        "compound returns to the catalogue.")

        # Quantity breaks are worth nothing if they are only discovered in the
        # cart. Stated here, from the same table the cart and the checkout
        # function use, so the three cannot drift apart.
        volume_note = ""
        if buyable(p) and VOLUME_TIERS:
            breaks = ", ".join(f"{int(t['minQty'])}+ units &minus;{t['percent']:g}%"
                               for t in VOLUME_TIERS)
            volume_note = (f'<p class="volume-note no-print">Volume pricing: {breaks}. '
                           f'Applied automatically in the cart.</p>')

        restricted = ""
        if p.get("restricted"):
            restricted = """
        <div class="notice" style="margin-bottom:1.5rem">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
          <div>
            <h3>Restricted reference standard</h3>
            <p>This compound corresponds to an approved or investigational pharmaceutical substance. It is supplied strictly as an analytical reference standard for <strong>in vitro</strong> method development: it is not a medicine, it is not manufactured to pharmaceutical standards, it has not been evaluated by any regulatory authority for safety or efficacy, and it must not be administered to a human or an animal. Buying it is your confirmation of that — see our <a href="../compliance.html">research use policy</a>.</p>
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

    <div class="split split--product">
      <div class="detail-figure">
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

        <div class="detail-price"><span data-price-display>{initial_price(p)}</span><small>{price_caption}</small></div>
        {volume_note}
        {'' if p.get("available", True) else '<p class="stock-note">Not currently supplied. Contact us and we will tell you when this compound returns to the catalogue.</p>'}

        <div class="field no-print" style="margin-bottom:1.5rem">
          <label for="size-select">Pack size</label>
          <select id="size-select" data-size{'' if p.get("available", True) else ' disabled'}>{sizes_opt}</select>
        </div>
        {buy_control}
        <p class="muted no-print" style="font-size:.72rem;margin:.9rem 0 2.5rem">{buy_note}</p>

        <table class="spec">
          <caption>Specification</caption>
          <tbody>{spec_rows}</tbody>
        </table>

        <h2 style="font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin:2.5rem 0 1rem">Release assay panel</h2>
        <ul style="list-style:none;display:flex;flex-wrap:wrap;gap:.5rem">{assay_rows.replace('<li>', '<li class="chip" style="padding:.3rem .6rem">')}</ul>
        <p class="muted" style="font-size:.78rem;margin-top:1rem;line-height:1.7">The certificate of analysis for the supplied lot reproduces the HPLC trace and mass spectrum, and is issued with the shipment. <a href="../coa.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">Request the certificate for the current lot</a>, read <a href="../quality.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">how lots are released</a>, or <a href="../specimen-coa.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">see a specimen</a>.</p>
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
        <p>{BRAND} supplies characterised peptide reference material to research laboratories and qualified professional purchasers. We are a research reagent supplier. We are not a pharmacy, not a compounder, and not a clinic, and we do not hold ourselves out as any of those things.</p>
        <p>The catalog is deliberately narrow. Every compound on it is one we can source with documented process controls and release against a specification we are willing to put an analyst's signature on. When we cannot establish that, the compound does not go on the catalog — which is why you will find gaps here that other suppliers fill.</p>
        <h3>What we will not do</h3>
        <p>We do not supply controlled substances. We do not supply finished-dose pharmaceuticals, anabolic steroids, or prescription medicines. We do not sell for personal use: research use is a condition of every sale, and an order we have reason to believe is destined for human or veterinary use is cancelled and refunded rather than shipped. We do not provide dosing, administration, protocol or therapeutic guidance, and we will not answer questions framed around human use — not as a liability posture, but because that is not what this material is for and pretending otherwise puts people at risk.</p>
        <p>If you are looking for material to use on yourself or another person, we are the wrong supplier, and there is no version of this conversation in which we become the right one. Speak to a licensed clinician.</p>
        <h3>How we handle uncertainty</h3>
        <p>Some compounds in this catalog are well characterised with decades of literature behind them. Others are recent, and the preclinical record is thin. We describe each one at the level the evidence actually supports, and the product descriptions say what a compound has been <em>studied for</em> — not what it does, and never what it treats.</p>
        <p>Where a compound corresponds to an approved or investigational pharmaceutical, we flag it as a restricted reference standard on its specification page and say what that means, rather than listing it as though it were any other reagent.</p>
      </div>
    </div>
  </div>
</section>

<section class="section section--alt">
  <div class="shell">
    <div class="grid-3">
      <div class="card"><h3 style="display:flex;align-items:center;gap:.6rem">{icon(I_SCOPE)} Characterisation first</h3><p>A compound is listed when we can document its identity and purity, and not before. The specification comes first; the listing follows.</p></div>
      <div class="card"><h3 style="display:flex;align-items:center;gap:.6rem">{icon(I_DOC)} Lot-level traceability</h3><p>Every certificate is tied to a lot number and a named analyst. Generic, reused certificates tell you nothing about the vial in your hand.</p></div>
      <div class="card"><h3 style="display:flex;align-items:center;gap:.6rem">{icon(I_SHIELD)} Research use, as a condition</h3><p>It is written into the terms of sale, confirmed at checkout, and enforced by refunding orders rather than shipping them. The restriction is the point, not an obstacle to route around.</p></div>
    </div>
  </div>
</section>

"""
    return page("about.html", f"About — {BRAND}",
                f"{BRAND} supplies characterised peptide reference material for laboratory research. What we supply, what we refuse to supply, and why.",
                body, "about.html")


# --------------------------------------------------------------------------- faq
FAQ = [
    ("Can I just add something to the cart and pay?",
     "Yes, for everything on the catalog. Prices are published against every pack size, the cart totals them, and checkout is hosted by Stripe. There is no account to apply for and nothing to wait on."),
    ("What does checkout ask me for?",
     "Your name, email address, phone number and a shipping address, all collected by Stripe on their own page, plus card details we never see. You also confirm on this site, before checkout opens, that the material is for laboratory research use. That is the whole of it."),
    ("What does the Restricted flag on some compounds mean?",
     "That the compound corresponds to an approved or investigational pharmaceutical substance \u2014 retatrutide, tirzepatide and oxytocin carry it. They are supplied as analytical reference standards for in vitro method development, on exactly the same conditions as everything else on the catalog. The flag is there because a buyer is entitled to know that what they are ordering has a pharmaceutical counterpart, not because the ordering route is different."),
    ("What does \u201cresearch use only\u201d actually mean here?",
     "It means the material is intended exclusively for in vitro laboratory research and analytical method development by qualified professionals. It is not a drug, supplement, cosmetic or medical device; it has not been evaluated for safety or efficacy in humans or animals; and it must not be administered to either. This is a statement about what the material is, not a disclaimer that unlocks another use."),
    ("You cannot verify who I am, so is that confirmation worth anything?",
     "It is a condition of sale, not an identity check, and we say so rather than implying a vetting process we do not run. It binds you contractually, it is what the terms of sale are built on, and where we have reason to believe an order is destined for human or veterinary use we cancel and refund it instead of shipping. We would rather state the limit of that plainly than dress it up."),
    ("Will you advise on dosing or administration?",
     "No \u2014 for any compound, under any framing, for any species. We answer questions about identity, purity, solubility, stability, storage and handling. We do not answer questions about dosing, administration routes, cycles or therapeutic use, and a request for that guidance will end the enquiry."),
    ("Do you supply anabolic steroids, hormones or prescription medicines?",
     "No. We do not supply controlled substances, anabolic steroids, finished-dose pharmaceuticals or prescription medicines of any kind. The catalog is limited to research peptides, small-molecule research compounds and laboratory reagents."),
    ("What is on the certificate of analysis?",
     "Product identity, lot number and release date, appearance, RP-HPLC chromatographic purity with the integrated trace, ESI-MS mass confirmation, Karl Fischer water content, counter-ion content where applicable, storage conditions, retest date, and the releasing analyst's signature. Certificates are lot-specific and are never reused across lots."),
    ("Can I see the COA before I order?",
     "Yes. Ask us for the certificate covering the lot currently in stock and we will send it, along with the full data package if you need it for supplier qualification."),
    ("Is the material sterile or endotoxin-tested?",
     "Only where the certificate for that lot says so and reports the test. Reagent solutions are tested for sterility and endotoxin. Lyophilised research peptides generally are not, and should not be assumed to be."),
    ("How should material be stored on arrival?",
     "Lyophilised peptides should be transferred to -20 \u00b0C, kept desiccated and protected from light. Storage conditions specific to each compound are listed on its specification page and on the certificate. Repeated freeze\u2013thaw cycles of reconstituted material should be avoided."),
    ("How long does shipping take, and what does it cost?",
     "Orders placed against material in stock leave us within one to three business days. Shipping is charged at checkout, where you choose between a standard and an express tracked courier service; the cost is shown before you pay."),
    ("Do you ship internationally?",
     "We ship to the countries offered at checkout, where the material may lawfully be imported for research use. Import permits, customs classification and local restrictions are yours to deal with, and we will not mis-declare the contents or value of a shipment under any circumstances."),
    ("What if a lot does not meet specification?",
     "Tell us within 30 days of delivery with the lot number and the data. If the material is out of specification we replace it or refund it. See the shipping and returns policy for the full procedure."),
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
      <p class="lede">Ordering, documentation, handling and the limits of what we will advise on.</p>
    </div>
    <div class="acc">{items}</div>
    <p style="margin-top:2rem" class="muted">Question not answered here? <a href="contact.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">Contact the technical team</a>.</p>
  </div>
</section>
"""
    return page("faq.html", f"FAQ — {BRAND}",
                "Ordering and payment, certificates of analysis, storage and handling, shipping, and the limits of technical support.",
                body, "faq.html", extra_head=f'<script type="application/ld+json">{ld}</script>\n')


# --------------------------------------------------------------------------- contact
# Since the catalogue is bought from the page, this form is no longer a gate in
# front of a purchase: it is for certificates, technical questions, bulk and
# purchase-order enquiries, and anything the FAQ does not answer. It therefore
# asks for the three things the operator needs to reply — name, email, phone —
# and the question itself, and nothing else.
#
# The compound select is prefilled from ?item=, which is matched against the
# option values built here. An id that is not in the catalogue simply leaves the
# select on its default: the parameter chooses between options this page already
# contains, and can never introduce content of its own.
def build_contact():
    opts = "".join(
        f'<option value="{E(p["id"])}">{E(p["name"])}'
        f'{" — restricted standard" if p.get("restricted") else ""}</option>'
        for p in PRODUCTS)

    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Contact</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Enquiries</span>
      <h1 class="display h-sec">Get in <em>touch.</em></h1>
      <p class="lede">For a certificate of analysis, a bulk quantity, a purchase order, or anything the catalogue does not answer. We reply within two business days.</p>
    </div>
  </div>
</section>

<section class="section section--tight">
  <div class="shell">
    <div class="split">
      <div>
        <div class="prose">
          <h3>Ordering does not go through here</h3>
          <p>The whole catalogue is bought from its own page: add a pack size to the cart and pay by card. <a href="pay.html">How ordering works</a>.</p>
          <h3>Bulk quantities and purchase orders</h3>
          <p>Checkout takes up to 99 units of a pack size across 20 lines. For more than that, or to be invoiced against a purchase order instead of paying by card, ask here and we will quote it.</p>
          <h3>Certificates and technical questions</h3>
          <p>Ask for the certificate covering the lot currently in stock and we will send it, with the full data package if you need it for supplier qualification. We answer questions on identity, purity, solubility, stability, storage and handling.</p>
          <h3>What we cannot help with</h3>
          <p>We do not provide dosing, administration or therapeutic guidance, for any species. Enquiries framed around human or veterinary use will be declined.</p>
          <h3>Or write to us directly</h3>
          <p><a href="mailto:{E(CONTACT_EMAIL)}">{E(CONTACT_EMAIL)}</a></p>
        </div>
      </div>

      <div>
        <form id="account-form" name="enquiry" method="POST"
              data-netlify="true" data-netlify-honeypot="bot-field" novalidate>
          <input type="hidden" name="form-name" value="enquiry">
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
            <label for="f-item">Compound</label>
            <select id="f-item" name="item">
              <option value="">General enquiry</option>
              {opts}
            </select>
            <p class="field-hint">Leave this on “General enquiry” if your question is not about one compound.</p>
          </div>

          <div class="field">
            <label for="f-message">Your enquiry <span class="req" aria-hidden="true">*</span></label>
            <textarea id="f-message" name="message" rows="5" required></textarea>
            <p class="field-hint">One line is usually enough.</p>
            <p class="field-error">Please tell us what you need.</p>
          </div>

          <div class="field">
            <label class="check">
              <input type="checkbox" id="f-confirm" name="confirm" required>
              <span>I confirm that any material supplied will be used solely for <strong>in vitro</strong> laboratory research, and that it will not be administered to humans or animals. <span class="req" aria-hidden="true">*</span></span>
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
                "Request a certificate of analysis, quote a bulk quantity or purchase order, or ask a technical question on identity, purity, storage or handling.",
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
      <h2>3. Who may buy, and on what condition</h2>
      <p>Material is sold to purchasers who are buying it for laboratory research use. Before checkout opens you confirm that the material is for <strong>in vitro</strong> laboratory research and will not be administered to a human or an animal. That confirmation is a condition of sale and is incorporated into the <a href="legal/terms.html">terms of sale</a>.</p>
      <p>We are direct about what that is and is not. It is a contractual condition, not an identity check: we do not operate a vetting or credentialing process, and we do not claim to. What we do is refuse the sale where we have reason to believe the material is destined for human or veterinary use — before shipping, by cancelling and refunding the order; after shipping, by declining further business. We may decline any order at our discretion and without giving a reason.</p>
      <h2>4. Restricted reference standards</h2>
      <p>Certain catalog items correspond to approved or investigational pharmaceutical substances. They are flagged as restricted on their specification pages and are supplied strictly as analytical reference standards for <strong>in vitro</strong> method development. They are not medicines, are not manufactured to pharmacopoeial or GMP standards, and have not been evaluated by any regulatory authority for safety or efficacy in humans or animals.</p>
      <p>Section 2 applies to them without exception. That a compound has an approved or investigational counterpart is a reason for more care in handling and disposal, not a suggestion that it may be used as that counterpart is used. Any order of one of these compounds that we have reason to believe is destined for human or veterinary use is cancelled and refunded rather than shipped, and we may decline further business.</p>
      <h2>5. What we will not advise on</h2>
      <p>We provide technical support on identity, purity, solubility, stability, storage and handling. We do <strong>not</strong> provide guidance on dosing, administration routes, cycles, combinations, or therapeutic application, for any species. Enquiries seeking such guidance will be declined, and may result in an account being refused or closed.</p>
      <h2>6. Responsibility of the recipient</h2>
      <p>The buyer is responsible for handling material in accordance with applicable laboratory safety requirements, for any institutional approvals the intended work requires, for determining that receipt and use are lawful in their jurisdiction, and for any import permits or customs requirements. We will not mis-declare the contents, value or classification of a shipment.</p>
      <h2>7. Enforcement</h2>
      <p>Where we have reason to believe material has been diverted to human use, resold to the public, or otherwise used in breach of this policy, we will cancel and refund any order not yet shipped, decline future orders from that buyer, and, where the law requires it, report the matter to the relevant authority.</p>
      <h2>8. Changes</h2>
      <p>This policy may be updated. The version in force is the one published here on the date an order is accepted.</p>
    </div>
    <p style="margin-top:2.5rem" class="muted">Questions about this policy: <a href="contact.html" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px">contact us</a>.</p>
  </div>
</section>
"""
    return page("compliance.html", f"Research Use Policy — {BRAND}",
                "Conditions of supply: intended use, prohibited uses, who may buy, restricted reference standards and buyer responsibilities.",
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

      <h2>2. How an order is made and accepted</h2>
      <p>Placing an order through checkout is your offer to buy. A contract is formed when we send you an order confirmation or despatch the material, whichever happens first. Payment being authorised or captured at checkout is not by itself our acceptance: until we confirm or despatch, we may cancel the order and refund you in full.</p>
      <p>We may decline any order at our discretion, including where the stated research use falls outside our <a href="../compliance.html">research use policy</a>, where we have reason to believe the material is destined for human or veterinary use, where we cannot lawfully ship to the destination, or where a price or availability shown on the site was wrong.</p>
      <p>Some compounds are marked as restricted reference standards because they correspond to an approved or investigational pharmaceutical substance. They are sold on these terms like anything else on the catalogue, and section 3 applies to them with particular force: they are supplied as analytical reference standards for <strong>in vitro</strong> method development and for no other purpose.</p>

      <h2>3. Research use is a condition of every sale</h2>
      <p>Every sale is conditional on your agreement to our <a href="../compliance.html">research use policy</a>, which forms part of these terms. Material supplied is for <strong>in vitro</strong> laboratory research by qualified professionals. It is not a drug, dietary supplement, cosmetic, food or medical device, and it is not for human or veterinary use, clinical or diagnostic procedures, or household use. Breach of that policy is a material breach of these terms, entitling us to cancel outstanding orders, terminate your account and decline future business.</p>

      <h2>4. Prices and payment</h2>
      <p>Catalogue prices are in {CURRENCY} and exclude shipping and any sales, use or import taxes and duties; shipping and any tax we are required to collect are added at checkout and shown before you pay. Payment is due in full at checkout and is taken by Stripe on their own hosted page. We do not receive, process or store your card details, and we will never ask for them by telephone or email.</p>
      <p>Prices may change without notice, but the price you are charged is the one shown at checkout. Where a price is obviously wrong, we may cancel the order under section 2 and refund you rather than supply at that price.</p>
      <p>Where we have agreed credit terms with you in writing, payment is due 30 days from the invoice date; overdue amounts accrue interest at 1.5% per month or the maximum rate permitted by applicable law, whichever is lower, and you are responsible for reasonable costs of collection, including attorneys' fees.</p>

      <h2>5. Shipping, title and risk</h2>
      <p>Shipments are made as described in our <a href="shipping.html">shipping and returns policy</a>, to the address you give at checkout. Delivery dates are estimates, not guarantees, and we are not liable for delay. Risk of loss passes to you on delivery of the material to the carrier. Title passes when we have received payment in full.</p>

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
      <p>These terms, the research use policy, the shipping and returns policy and our order confirmation are the entire agreement between us on their subject matter. Changes must be in writing and signed by us. Failing to enforce a provision does not waive it. If a provision is held unenforceable, the rest continues in force. You may not assign your rights without our written consent. Notices go to the addresses on the order confirmation. Sections 3, 7 to 14, 16 and 17 survive termination.</p>

      <h2>18. Contact</h2>
      <p><a href="mailto:{email}">{email}</a></p>"""))

    # -------------------------------------------------------------- privacy
    out.append(legal_page("privacy", "Privacy Policy", "Legal", "Privacy <em>policy.</em>",
        "What personal information this site collects, why, and what you can ask us to do with it.", f"""
      <h2>1. Who we are</h2>
      <p>{entity} is a sole proprietorship operating from {address}. We are responsible for the personal information described in this policy. Contact us at <a href="mailto:{email}">{email}</a>.</p>

      <h2>2. What we collect</h2>
      <p><strong>What you give us when you order.</strong> Checkout is hosted by Stripe, who collect your name, email address, telephone number, shipping address and payment details in order to take the payment. Stripe then passes us everything except your card details, which we never receive, hold or have access to. We also record what you ordered.</p>
      <p><strong>What you give us when you write to us.</strong> The enquiry form collects your name, email address, telephone number, the compound your question is about and the message itself.</p>
      <p><strong>What is collected automatically.</strong> Our hosting provider records standard server logs — IP address, browser user-agent, pages requested and timestamps — which are used to keep the site available and to investigate abuse.</p>
      <p><strong>What stays on your device.</strong> Your cart is held in your browser's local storage so it survives moving between pages. It remains on your device until you clear it, check out, or clear your browser data. We cannot see it until you start checkout.</p>
      <p><strong>What we do not do.</strong> We set no advertising or analytics cookies, we run no tracking pixels, and we do not build profiles of visitors.</p>

      <h2>3. Why we use it</h2>
      <p>To take payment for, process and fulfil your order; to reply to your enquiry; to apply the conditions of supply in our <a href="../compliance.html">research use policy</a>; to keep the commercial, tax and lot-traceability records our business needs; and to protect the site against abuse.</p>

      <h2>4. Who else sees it</h2>
      <p><strong>Our payment processor.</strong> Checkout and payment are handled by Stripe, Inc. as an independent controller of the payment data it collects. Their <a href="https://stripe.com/privacy" rel="noopener">privacy policy</a> governs that processing. We receive from Stripe the name, email address, telephone number and shipping address you gave them, and the fact and amount of the payment — never your card number.</p>
      <p><strong>Our hosting and form provider.</strong> The site is hosted on Netlify, which serves the pages, runs the small function that creates a Stripe checkout session, keeps the server logs described above, and receives enquiries from the contact form on our behalf as a service provider.</p>
      <p><strong>No other third party.</strong> Typefaces, stylesheets, scripts and images are all served from this site itself, so loading a page contacts nobody but our hosting provider. We do not sell personal information, and we do not share it for cross-context behavioural advertising. We disclose it only where the law requires it, where we must to establish or defend a legal claim, or to a carrier where that is necessary to deliver your order.</p>

      <h2>5. How long we keep it</h2>
      <p>Enquiries that do not become orders: 24 months from your last contact with us. Order records: seven years, which is what tax and commercial record-keeping requires. Server logs: as retained by our hosting provider, typically around 30 days.</p>

      <h2>6. Your rights</h2>
      <p>Wherever you are, you can ask us for a copy of the personal information we hold about you, ask us to correct it, or ask us to delete it. Email <a href="mailto:{email}">{email}</a>. We will respond within 45 days and will verify your identity against the information we already hold before acting.</p>
      <p><strong>If you are in California,</strong> the CCPA as amended by the CPRA gives you the right to know what we collect and why, to receive a copy, to correct it, to delete it, to opt out of sale or sharing, and not to be treated differently for exercising any of them. In the last 12 months we have collected identifiers (name, email address, telephone number), commercial information (the compounds you enquired about) and internet activity information (server logs), from you and from your device, for the purposes in section 3, and have disclosed them only to the payment processor and service providers in section 4. We have not sold or shared personal information, and we do not collect sensitive personal information as the CPRA defines it. An authorised agent may make a request on your behalf with your written permission.</p>
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
      <p>We ship to the countries offered at checkout, to the address you give there. Where the material may not lawfully be imported into a destination for research use, we will cancel the order and refund it rather than ship it.</p>

      <h2>2. Processing</h2>
      <p>Orders are released once payment has cleared, or once agreed credit terms are in place. Material in stock usually leaves within one to three business days. Shipments requiring cold chain are released to match carrier schedules, so that material is not sitting in a depot over a weekend.</p>

      <h2>3. Packing and cold chain</h2>
      <p>Material ships lyophilised unless stated otherwise. Where stability requires it, shipments are packed in insulated containers with gel packs or dry ice; dry-ice shipments are declared as required for carriage. Store material on arrival as its certificate of analysis specifies.</p>

      <h2>4. Carriage and tracking</h2>
      <p>We use tracked courier services domestically and internationally, and send tracking details when a shipment leaves us. Transit times are estimates: customs, weather and carrier backlogs are outside our control.</p>

      <h2>5. Title, risk and receipt</h2>
      <p>Risk of loss passes to you when the material is delivered to the carrier; title passes when we have received payment in full. Someone must be available to receive cold-chain shipments, because material left at an unattended address may no longer be fit for use.</p>
      <p>Shipments carry a research-reagent declaration and are addressed exactly as you enter the address at checkout, so give an address where a parcel can be signed for during business hours.</p>

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


# --------------------------------------------------------------------------- payment
# Ordering is a card payment on a Stripe-hosted page, so this page explains the
# sequence and what each step actually collects.
#
# Deliberately NOT a redirector. A page that took a session id or a URL in the
# query string and forwarded the visitor to it would be an open redirect on a
# domain that takes payments — a ready-made phishing tool aimed at our own
# customers. The only way to a payment page is the checkout button, which gets
# its URL from Stripe's API in the response to a request this site made.


def build_pay():
    body = f"""
<section class="section section--tight">
  <div class="shell-n">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Ordering &amp; payment</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Ordering &amp; payment</span>
      <h1 class="display h-sec">Placing <em>an order.</em></h1>
      <p class="lede">Catalogue prices are the prices you pay. Add pack sizes to the cart, confirm the research use condition, and pay by card on a page hosted by Stripe. There is no account to open and no quotation to wait for.</p>
    </div>

    <ol class="pay-steps">
      <li>
        <h2>Cart</h2>
        <p>Choose a pack size on any catalogue or product page and add it to the cart. The cart totals what you have chosen; shipping and any tax are added at checkout, where the full amount is shown before you pay.</p>
      </li>
      <li>
        <h2>Research use confirmation</h2>
        <p>Before checkout opens you confirm that the material is for laboratory research use and will not be administered to a human or an animal. That confirmation is a condition of sale under our <a href="legal/terms.html">terms</a> and our <a href="compliance.html">research use policy</a> — it is not a formality, and an order we have reason to believe is destined for human or veterinary use is cancelled and refunded rather than shipped.</p>
      </li>
      <li>
        <h2>Checkout</h2>
        <p>Checkout is hosted by Stripe on their own page. They collect your name, email address, phone number and shipping address, and take the card payment. Your card details never reach this site: we receive the order and your delivery details, and nothing else.</p>
      </li>
      <li>
        <h2>Confirmation</h2>
        <p>Stripe emails you a receipt immediately, and we follow it with an order confirmation. The contract is formed at that confirmation or at despatch, whichever comes first — see <a href="legal/terms.html">terms of sale</a>, section 2.</p>
      </li>
      <li>
        <h2>Release and despatch</h2>
        <p>Material in stock leaves us within one to three business days, tracked. The certificate of analysis for the supplied lot travels with the shipment.</p>
      </li>
    </ol>

    <div class="notice" style="margin-top:2.5rem">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
      <div>
        <h3>How to know a payment request is really ours</h3>
        <p>The only payment page we use is the one the checkout button opens, hosted by Stripe on a <strong>stripe.com</strong> address. Our email reaches you only from <strong>{E(CONTACT_EMAIL)}</strong>. We will never telephone you for card details, never email you a link to a payment page on another domain, and never send instructions that change bank details at short notice. If anything about a payment request looks wrong, stop and contact us on the address above before paying.</p>
      </div>
    </div>

    <div class="prose" style="margin-top:2.5rem">
      <h2>Questions we are asked</h2>
      <h3>Is the whole catalogue in the cart?</h3>
      <p>Yes. Some compounds carry a <strong>Restricted</strong> flag, which says that they correspond to an approved or investigational pharmaceutical substance and are supplied as analytical reference standards &mdash; it describes the material, not a different way of buying it.</p>
      <h3>What if I need more than checkout allows?</h3>
      <p>Checkout takes up to 99 units of a pack size across 20 separate lines. Beyond that, <a href="contact.html">ask us</a> and we will quote and invoice it.</p>
      <h3>What does shipping cost?</h3>
      <p>You choose a tracked standard or express courier service at checkout and the cost is added there, before you pay. Import duties and clearance charges at the destination are separate and are yours to pay.</p>
      <h3>Do you take purchase orders?</h3>
      <p>Yes. <a href="contact.html">Contact us</a> with the PO and we will invoice it. Credit terms have to be agreed in writing first; otherwise payment is due at checkout.</p>
      <h3>What currency?</h3>
      <p>All prices and charges are in {E(CURRENCY)}. Your bank may apply its own conversion and charges.</p>
      <h3>Can I see a certificate of analysis before I order?</h3>
      <p>Yes — <a href="contact.html">ask us</a> for the certificate covering the lot currently in stock and we will send it.</p>
      <h3>What if I need to change or cancel an order?</h3>
      <p>Tell us before it ships and we will cancel and refund it in full. Once it has shipped, the <a href="legal/shipping.html">returns policy</a> applies.</p>
    </div>

    <div style="margin-top:2.5rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <a class="btn btn--primary" href="catalog.html">Browse the catalog</a>
      <a class="btn btn--ghost" href="legal/terms.html">Terms of sale</a>
    </div>
  </div>
</section>
"""
    return page("pay.html", f"Ordering &amp; Payment — {BRAND}",
                "How to order: add pack sizes to the cart, confirm research use, and pay by card on a Stripe-hosted checkout. Shipping and tax are shown before you pay.",
                body, "")


# --------------------------------------------------------------------------- order received
# Stripe's success_url. It confirms nothing it cannot know: the page is reached
# by a redirect, not by a webhook, so it reports what Stripe has already done
# (taken the payment, emailed a receipt) and does not claim the order has been
# accepted — under the terms of sale that happens at our confirmation.


def build_order_received():
    body = f"""
<section class="section">
  <div class="shell-n" style="padding-block:3rem">
    <div class="sec-head">
      <span class="eyebrow">Order received</span>
      <h1 class="display h-sec">Thank you &mdash; <em>that is paid.</em></h1>
      <p class="lede">Stripe has taken the payment and emailed you a receipt. Check your spam folder if it has not arrived within a few minutes.</p>
    </div>

    <div class="prose">
      <h2>What happens next</h2>
      <ol>
        <li>We confirm the order by email, usually within one business day. That confirmation is what forms the contract &mdash; see <a href="legal/terms.html">terms of sale</a>, section 2.</li>
        <li>Material in stock is released and despatched within one to three business days, tracked. We send the tracking details when it leaves us.</li>
        <li>The certificate of analysis for the lot supplied travels with the shipment.</li>
      </ol>
      <h2>If something is wrong</h2>
      <p>Reply to the receipt, or write to <a href="mailto:{E(CONTACT_EMAIL)}">{E(CONTACT_EMAIL)}</a>, quoting the receipt number. Anything that has not yet shipped can be changed, cancelled or refunded in full.</p>
      <h2>On arrival</h2>
      <p>Transfer lyophilised material to -20&nbsp;&deg;C, desiccated and protected from light, and inspect the shipment within 10 business days as the <a href="legal/shipping.html">shipping and returns policy</a> describes.</p>
    </div>

    <div style="margin-top:2.5rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <a class="btn btn--primary" href="catalog.html">Back to the catalog</a>
      <a class="btn btn--ghost" href="contact.html">Contact us</a>
    </div>
  </div>
</section>
"""
    # The cart has been paid for, so it must not survive the redirect back.
    # Inline rather than in site.js: it has to run on this page and no other.
    clear = ('<script>try{localStorage.removeItem("tr_cart_v1");'
             'localStorage.removeItem("tr_rfq_v1");}catch(e){}</script>')
    return page("order-received.html", f"Order received — {BRAND}",
                "Your payment has been taken by Stripe. What happens next, and how to reach us about an order.",
                body, "", extra_body=clear)


# --------------------------------------------------------------------------- certificates
# The site promises a certificate of analysis with every lot on every page, and
# had nowhere to get one. This is the index.
#
# It publishes no lot numbers. The ones printed on the vial illustrations are
# generated from a hash of the product id so that the artwork looks right; they
# are not real lots, and listing them here as though they were would turn a
# label mock-up into a false document. A certificate is lot-specific, so what
# this page can honestly offer is the document for whatever lot is in stock
# now, by asking.
#
# Where the operator has a real certificate, dropping the PDF at
# assets/coa/<product-id>.pdf makes this page link it on the next build. No
# code change, no list to maintain: the file existing is the whole switch.


def build_coa_index():
    have = ROOT / "assets/coa"
    rows = []
    published = 0
    for p in PRODUCTS:
        pdf = f"assets/coa/{p['id']}.pdf"
        exists = (ROOT / pdf).exists()
        published += exists
        action = (f'<a class="link-action" href="{pdf}">Download PDF</a>' if exists
                  else f'<a class="link-action" href="contact.html?item={p["id"]}">Request</a>')
        rows.append(f"""
        <tr>
          <td><a href="products/{p['id']}.html">{E(p['name'])}</a></td>
          <td class="mono">{E(p.get('cas') or 'Blend')}</td>
          <td class="mono">{E(p['purity'])}</td>
          <td>{action}</td>
        </tr>""")

    note = ("" if published else """
    <div class="notice" style="margin-bottom:2.5rem">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      <div>
        <h3>No certificates are published here yet</h3>
        <p>Certificates are issued with the shipment and on request. When a lot's certificate is published on this page, its row will offer the PDF directly.</p>
      </div>
    </div>""")

    body = f"""
<section class="section section--tight">
  <div class="shell">
    <nav class="crumb" aria-label="Breadcrumb"><a href="index.html">Home</a> <span>/</span> <span>Certificates of analysis</span></nav>
    <div class="sec-head">
      <span class="eyebrow">Certificates of analysis</span>
      <h1 class="display h-sec">Every lot, <em>documented.</em></h1>
      <p class="lede">A certificate of analysis is issued for the lot supplied and travels with the shipment. Ask for the certificate covering the lot currently in stock and we will send it before you order.</p>
    </div>
    {note}
    <div class="coa-table-wrap">
      <table class="spec coa-index">
        <caption>All {len(PRODUCTS)} catalogue compounds</caption>
        <thead>
          <tr><th scope="col">Compound</th><th scope="col">CAS</th><th scope="col">Purity specification</th><th scope="col">Certificate</th></tr>
        </thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
    </div>

    <div class="prose" style="margin-top:3rem">
      <h2>Why there is no single certificate per compound</h2>
      <p>A certificate reports on a lot, not on a product. Two lots of the same compound are two different batches of material with their own chromatograms, their own water content and their own release date, and a certificate that did not name a lot would be telling you nothing about the vial in your hand. That is why this page asks rather than publishes a fixed document: the certificate you want is the one for the material you will actually receive.</p>
      <h2>What a certificate reports</h2>
      <p>Identity and lot number, appearance, RP-HPLC chromatographic purity with the integrated trace, ESI-MS mass confirmation, Karl Fischer water content, counter-ion content where it applies, storage conditions, retest date, and the signature of the analyst who released it. <a href="specimen-coa.html">See a worked specimen</a>, or read <a href="quality.html">how a lot is released</a>.</p>
      <h2>For supplier qualification</h2>
      <p>If you need the full data package rather than the certificate alone &mdash; raw chromatograms, the mass spectrum, method parameters &mdash; <a href="contact.html">ask</a> and we will send it.</p>
    </div>

    <div style="margin-top:2.5rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <a class="btn btn--primary" href="specimen-coa.html">See a specimen certificate</a>
      <a class="btn btn--ghost" href="quality.html">The analytical programme</a>
    </div>
  </div>
</section>
"""
    return page("coa.html", f"Certificates of Analysis — {BRAND}",
                "A certificate of analysis is issued for every lot supplied. Request the certificate covering the lot currently in stock for any catalogue compound.",
                body, "", extra_head=breadcrumbs([("Home", "index.html"),
                                                  ("Certificates of analysis", None)]) + "\n")


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
             "formEndpoint": FORM_ENDPOINT,
             "checkoutEndpoint": "/.netlify/functions/create-checkout-session",
             "currency": CURRENCY,
             "noCart": NO_CART_IDS,
             "volumeTiers": VOLUME_TIERS,
             "freeShippingOver": FREE_SHIPPING_OVER,
             "demo": DEMO}, indent=2
        ) + ";\n", encoding="utf-8")

    # The checkout function must not take a price from the browser, so it needs
    # its own copy of the price table. Generating it here keeps products.json the
    # single source of truth: the function cannot drift from the catalogue
    # because it is rebuilt from it on every deploy. Only what pricing an order
    # needs is written out — no prose, no assay panels.
    catalog = {
        "currency": CURRENCY,
        "volumeTiers": VOLUME_TIERS,
        "freeShippingOver": FREE_SHIPPING_OVER,
        "products": {
            p["id"]: {
                "name": p["name"],
                "buyable": buyable(p),
                "prices": {s: (p.get("prices") or {}).get(s) for s in p["sizes"]
                           if (p.get("prices") or {}).get(s) is not None},
            } for p in PRODUCTS
        },
    }
    fn = ROOT / "netlify/functions"
    fn.mkdir(parents=True, exist_ok=True)
    (fn / "catalog.json").write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

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
             build_faq(), build_contact(), build_compliance(), build_coa(),
             build_coa_index(), build_pay(), build_order_received(), build_404()]
    pages += build_products()
    pages += build_legal()

    # {PREFIX} placeholders emitted by vial() resolve per page depth
    for rel_path in pages:
        f = ROOT / rel_path
        txt = f.read_text(encoding="utf-8")
        if "{PREFIX}" in txt:
            f.write_text(txt.replace("{PREFIX}", rel(rel_path.count("/"))), encoding="utf-8")

    # A page removed from the generator leaves its last build behind at the
    # repository root, and tools/dist.py copies every root *.html into the
    # publish directory — so a retired page keeps being deployed, linked from
    # nowhere and contradicting the pages that replaced it.
    kept = {(ROOT / q).resolve() for q in pages}
    for stale in sorted(ROOT.glob("*.html")):
        if stale.resolve() not in kept:
            stale.unlink()
            print(f"Removed stale page: {stale.name}")

    build_meta(pages)
    print(f"Built {len(pages)} pages:")
    for p in pages:
        print(f"  {p}")
    print("  sitemap.xml\n  robots.txt")


if __name__ == "__main__":
    main()
