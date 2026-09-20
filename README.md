# Timeless Research — website

Catalog and storefront for a peptide **reference-material supplier**, sold for
laboratory research use only.

No framework, no build toolchain, no runtime dependencies. Pages are generated
from a single Python script so that shared chrome and compliance language can
never drift between pages. The one piece of server-side code is a Netlify
Function that creates Stripe Checkout sessions, because a static page cannot
hold a secret key.

**Taking this site over? Start with [HANDOVER.md](HANDOVER.md)** — it lists
everything an operator has to supply, deploy and decide, in order. This file
covers how the site is built.

---

## Quick start

```bash
python3 tools/build.py      # regenerate every page
python3 -m http.server 8000 # preview at http://localhost:8000
```

The generator needs only the Python 3 standard library.

---

## Layout

```
index.html              Home
catalog.html            Filterable catalog (server-rendered, JS enhances)
quality.html            Analytical programme / how lots are released
about.html              Company position and what we decline to supply
faq.html                FAQ (with FAQPage structured data)
contact.html            Enquiry form (restricted standards, COAs, technical)
compliance.html         Research use policy
404.html                Not found
products/<id>.html      27 generated specification pages
specimen-coa.html       Worked example of a certificate of analysis
pay.html                How ordering and payment work
order-received.html     Stripe success_url; confirms and empties the cart
legal/                  terms.html, privacy.html, shipping.html
assets/
  css/main.css          Design tokens + all component styles
  js/site.js            Nav, reveal, accordion, cart, drawer, checkout
  js/catalog.js         Filtering and search
  js/contact.js         Form validation and submission
  data/products.json    Single source of truth for the catalog
  fonts/                Self-hosted Barlow Semi Condensed (label face)
  css/fonts.css         @font-face rules for the above (generated)
  img/vial.{png,webp}   Product photograph, matted (generated)
  img/mark.svg          Flame mark, redrawn as vector (generated)
  img/favicon.svg       Generated from the mark
vial.png                Original studio photograph (source for the above)
tools/build.py          Static site generator
tools/make_vial.py      Rebuilds the vial asset from the photograph
tools/make_logo.py      Rebuilds the flame mark and favicon
tools/check.py          Structural / link / a11y-hygiene checks
netlify/functions/
  create-checkout-session.js  Creates the Stripe session (the only backend)
  catalog.json          Price table it charges from (generated)
sitemap.xml, robots.txt Generated
```

## Design

Editorial and minimal on warm off-white paper (`#FAF9F7`): hairline rules
instead of boxes through the page body, large Cormorant Garamond display type
over Inter, and monospace reserved for analytical data (CAS, MW, sequences).
A single deep-blue accent (`#0A57B0`) carries links and emphasis.

Product cards follow a supplied reference: a rounded card, a tinted two-tone
tile (lighter ground with a deeper floor band), a purity pill sitting on the
tile edge, and one full-width pill action. Each research area carries its own
pastel tint, set in `assets/data/products.json` alongside the category, and the
translucent vial picks that tint up through the glass. The reference's
commerce furniture — prices, discount flashes — is deliberately not carried
over, since ordering here runs through quotation rather than checkout.

### The vials

`vial.png` at the repo root is a real photograph of a crimp-top glass vial
carrying a **blank paper label**, shot on black. Two things make it read as a
genuine product shot on a light page:

- **Translucent matte.** `tools/make_vial.py` derives alpha from luminance
  inside the subject silhouette, so the cap and label stay opaque while the
  glass becomes translucent and the page shows through it — which is what
  light actually does through a vial. A plain cutout leaves the glass interior
  black and reads as a dark blob pasted onto white. The baked studio shadow is
  cut, since it belongs to the black backdrop.
- **Type printed into the real label.** The label text is a DOM layer
  positioned over the photographed paper label and blended with
  `mix-blend-mode: multiply`, so it inherits the label's own curvature shading
  and paper texture. An earlier version covered the real label with a flat
  white rectangle, which is what made it look fake.

Label text layout follows a supplied reference: the compound set large and
left-aligned at the top, its pack size in a pill beneath, the brand wordmark
running vertically up the right edge, and the purity pill with the research-use
line along the bottom. The CAS number lives in the page text, not on the vial.

Multiply can only darken, so the pills are outlined rather than filled —
knocked-out light text inside a dark pill is not reachable through that blend
mode.

The label is set in **Barlow Semi Condensed**, a DIN-derived condensed
grotesque — printed matter, not screen type, and what pharmaceutical and
laboratory packaging actually uses. It is **self-hosted** (`assets/fonts/`,
67 KB, latin subset): the type sizing is calibrated to this face's metrics, so
a failed webfont load does not merely look different, a wider fallback overruns
the label. Serving it from our own origin removes that failure mode and one
third-party request per page.

Alpha, superscript-plus and greater-or-equal are not in Barlow and fall back
per glyph; the advance table was measured with that fallback in place, so the
sizing already accounts for them. The label also reserves the brand strip in
padding and clips rather than overlapping, so even a wide fallback cannot
collide.

Every compound is set at **one size** regardless of length, as on real
packaging; a name too long for the line wraps to a second. The size is fixed in
`.vp-name` at the largest value that keeps the catalog's longest unbreakable
word — "Bacteriostatic" — inside a line with margin. Spaces inside brackets are
made non-breaking so a qualifier such as "(no DAC)" travels as a unit rather
than breaking after "(no".

Verified in-browser across all 27 catalog names: most set on one line, the rest on two,
none clipped and none overflowing.

### The mark

The supplied logo raster is 128x106, with the flame itself only ~14x38px — far
too small for a site header or a vial label. `tools/make_logo.py` redraws it as
vector: two tapered ribbons on a sine centreline, related by 180-degree
rotation, pointed at both tips and pinched where they cross. Colours are
sampled from the original artwork. It also emits the favicon, so both come from
one definition.

Copper appears as two tokens. `--copper` (`#A87C52`) is the artwork value, used
for the mark and the printed label. `--copper-text` (`#8A5F33`) is darkened to
clear AA wherever copper carries real interface text — the artwork value sits
at 3.5:1 and fails.

```bash
python3 tools/make_logo.py
```

To regenerate after replacing the photograph:

```bash
pip install pillow numpy
python3 tools/make_vial.py     # then sync .vial-print if the geometry changed
```

### Editing content

- **Products** — edit `assets/data/products.json`, then rerun the build. Adding a
  product generates its specification page, catalog card, sitemap entry and
  category count automatically.
- **Page copy** — edit the corresponding `build_*()` function in `tools/build.py`.
  Do **not** edit generated `.html` files directly; the next build overwrites them.
- **Design tokens** — the `:root` block at the top of `assets/css/main.css`.

---

## Deploying

### Netlify (how this is set up)

`netlify.toml` holds the whole deploy. Netlify runs the generator and publishes
`dist/`, so the repository's own tooling is never served:

```toml
command = "python3 tools/build.py && python3 tools/dist.py"
publish = "dist"
```

To go live:

1. In Netlify, **Add new site → Import an existing project**, and pick this
   repository. Every setting is read from `netlify.toml`; leave the build
   fields alone.
2. Attach the domain under **Domain management**. Netlify issues the
   certificate.
3. Change `TR_SITE` in `netlify.toml` to that domain and push. Canonical tags,
   Open Graph URLs and the sitemap are all built from it, so a wrong value here
   is an SEO problem rather than a visible one.
4. Enquiries arrive under **Forms → enquiry**. Turn on the email notification
   there, or nothing will tell you a lead came in.
5. Set `STRIPE_SECRET_KEY` under **Site configuration → Environment variables**
   — *not* in `netlify.toml`, which is in the repository. Until it is set, the
   checkout button reports that checkout is unavailable.

Run it locally exactly as Netlify does with
`python3 tools/build.py && python3 tools/dist.py`, then serve `dist/`.
`dist/` is generated and git-ignored; never edit it.

### Build variables

Everything environment-specific is a build-time variable, so a deploy never
means editing source:

```bash
TR_SITE=https://your-domain.com \
TR_CONTACT_EMAIL=accounts@your-domain.com \
python3 tools/build.py && python3 tools/dist.py
```

| Variable | Default | Effect |
|---|---|---|
| `TR_SITE` | `https://www.timelessresearch.com` | Canonical tags, Open Graph URLs, sitemap |
| `TR_CONTACT_EMAIL` | `accounts@timelessresearch.com` | Contact fallback address |
| `TR_FORM_PROVIDER` | `netlify` | `netlify`, or `endpoint` to POST JSON elsewhere |
| `TR_FORM_ENDPOINT` | *(empty)* | Target when `TR_FORM_PROVIDER=endpoint` |
| `TR_ANALYTICS_HEAD` | *(empty)* | Raw `<head>` markup for an analytics tag |
| `TR_LEGAL_ENTITY` / `TR_LEGAL_ADDRESS` / `TR_LEGAL_STATE` / `TR_LEGAL_EMAIL` | see *Legal documents* | Parties, controller and governing-law clauses |
| `TR_DEMO` | *(off)* | `1` marks the build a demonstration: a not-trading bar on every page, `noindex`, `robots.txt` disallowing all, and a checkout button that says so instead of calling Stripe |

The checkout function reads its own, set on the deploy rather than at build time:

| Variable | Default | Effect |
|---|---|---|
| `STRIPE_SECRET_KEY` | *(none)* | Required. Never put it in `netlify.toml` |
| `TR_SHIP_STANDARD_CENTS` | `1500` | Standard shipping rate offered at checkout |
| `TR_SHIP_EXPRESS_CENTS` | `3500` | Express shipping rate offered at checkout |
| `TR_SHIP_COUNTRIES` | *(empty)* | Comma-separated ISO codes; empty uses the list in the function |
| `TR_STRIPE_TAX` | *(off)* | `1` enables Stripe Tax on the session |

These reach the browser through `assets/js/config.js`, which the build
generates — do not edit that file.

**Moving off Netlify** means setting `TR_FORM_PROVIDER=endpoint` and
`TR_FORM_ENDPOINT` to a handler of your own; the form posts JSON to it instead.
If a submission fails either way, the form shows the visitor their composed
enquiry with a copy button and a mailto link, so a lead is never lost silently.

**404s.** `_redirects` is generated for Netlify and Cloudflare Pages. On nginx
use `error_page 404 /404.html;`, on Apache `ErrorDocument 404 /404.html`.
Without it a static host serves its own 404 instead of this one.

**Analytics** is deliberately off. The site currently sets no analytics
cookies. Switching a tag on is a cookie-consent question in the EU and UK and
a disclosure question under CCPA, so settle the policy side before adding one.

**Email deliverability.** Netlify's form notifications come from Netlify, so
they need no DNS work. If you move to your own handler that mails you, set SPF
and DKIM on the sending domain or the notifications will land in spam.

---

## Before this goes live

Everything an operator must supply, deploy or decide is in
**[HANDOVER.md](HANDOVER.md)**: the build variables that `check.py` refuses to
deploy without, the Netlify steps, the commercial claims the copy makes, and
the decisions — carrying the three restricted compounds, what to do with an
order that reads wrong, legal review — that are not the builder's to make.

`tools/check.py` fails while any legal document still carries an unfilled
field, so an unconfigured site cannot reach production by accident.

---

## What this site deliberately does not do

The catalog is limited to research peptides, small-molecule research compounds
and laboratory reagents.

It does **not** include anabolic steroids, controlled substances, finished-dose
pharmaceuticals or prescription medicines, and the site publishes no dosing,
administration or therapeutic guidance anywhere.

That is a deliberate design constraint, not an oversight. Supplying those
product classes to the public is a licensing matter — and, for scheduled
substances, a criminal one — that a website cannot paper over. Adding those SKUs
would undermine everything the rest of the site is built on.

**Two product flags, deliberately separate.** `"restricted": true` marks a
compound that corresponds to an approved or investigational pharmaceutical
substance — retatrutide, tirzepatide and oxytocin carry it. It puts a notice on
the specification page saying what the material is and is not; it says nothing
about how the compound is bought, and `check.py` fails the build if a flagged
compound has no such notice. `"cart": false` is the other one: it keeps a
compound listed and priced but replaces its add control with an Enquire link and
has the checkout function refuse the id. Nothing carries it today; it is the
lever for pulling one SKU off card payment without delisting it. `check.py`
fails if a page still offers to cart something marked that way.

Conflating those two was a bug in an earlier version of this site: the notice
belongs on the page whatever the payment mechanics are.

**What the site does not claim.** There is no account verification, no vetting
and no credentialing step, and no page says otherwise — research use is a
contractual condition confirmed at checkout, and `compliance.html` §3 says so in
those words. `tools/check.py` carries a list of the retired "verified account"
wording and fails the build if any of it reappears, because a promise the
operator cannot keep is worse than no promise.

---

## Assets and tooling

Every asset is generated and committed; a build and a deploy never touch the
network.

| Script | Produces | Run it when |
|---|---|---|
| `tools/build.py` | All 39 pages, sitemap, robots, config | Every change |
| `tools/dist.py` | `dist/` for deployment | Every deploy (Netlify does it) |
| `tools/check.py` | Structural report, non-zero on failure | Before every push |
| `tools/fetch_fonts.py` | Full faces into `tools/fonts-src/` | The type stack changes |
| `tools/subset_fonts.py` | Served fonts in `assets/fonts/` | After fetching, or new glyphs |
| `tools/make_og.py` | 35 social cards | Product names or copy change |
| `tools/make_vial.py` | `assets/img/vial.{png,webp}` | The photograph is replaced |
| `tools/make_logo.py` | `assets/img/mark.svg`, `favicon.svg` | The mark changes |

**Fonts are self-hosted and subset.** Inter and Cormorant Garamond are variable
faces, so one file covers a weight range instead of five static cuts; Barlow
Semi Condensed has no variable version and stays as three. Twelve faces at
453 KB became seven at 187 KB, and Inter's italic is now a real italic rather
than a sheared upright. Nothing is loaded from a third party, which is why the
privacy policy can state that a page load contacts nobody but the host.

**Social cards are per page.** `tools/make_og.py` writes one card per product
and one per section, each with that compound's name printed on the vial.
`og_image()` in `build.py` routes a page to its card by canonical path, falling
back to the general card.

**Print is a real output.** `specimen-coa.html` offers "print or save as PDF",
and every product page prints as a filed specification sheet: chrome, ordering
controls and cross-sell rails are dropped, the photograph shrinks to a
reference thumbnail, and a footer carries the source URL.

---

## Legal documents

`legal/terms.html`, `legal/privacy.html` and `legal/shipping.html` are
generated by `build_legal()` in `tools/build.py`, like every other page. Edit
them there, not in the HTML.

They are written for a **US sole proprietorship selling research reagents
business to business**. Change that situation — incorporate, move state, start
selling to consumers — and they need revisiting.

**They have not been reviewed by a lawyer.** They are careful drafts built on
standard commercial practice, not legal advice, and they carry no assurance
that a court in your state would enforce every clause. The two clauses doing
the most work are the warranty disclaimer (section 8 of the terms) and the
limitation of liability (section 9). Both are set in capitals inside a
`.legal-strong` block on purpose: UCC 2-316 requires a disclaimer of the
implied warranties of merchantability and fitness to be *conspicuous*, and a
limitation of liability is read the same way. Do not quietly restyle them into
sentence case — that is not a cosmetic change.

### Filling in your details

Four values are injected at build time, so they appear consistently everywhere:

| Variable | Default | Used in |
|---|---|---|
| `TR_LEGAL_ENTITY` | `Timeless Research` | Parties clause, privacy controller |
| `TR_LEGAL_ADDRESS` | *(unset)* | Parties clause, privacy controller |
| `TR_LEGAL_STATE` | *(unset)* | Governing law and venue |
| `TR_LEGAL_EMAIL` | `TR_CONTACT_EMAIL` | Contact section of each document |

Anything unset renders as a loud highlighted marker in the page rather than a
silent blank, and `tools/check.py` **fails** while one is present, so an
unfinished document cannot be deployed by accident. Set them in
`[build.environment]` in `netlify.toml` alongside `TR_SITE`.

These must be real. A fabricated address or registration number would make the
documents false, which is worse than not publishing them at all.

---

## Accessibility and testing

Verified with Playwright + Chromium and axe-core (WCAG 2.1 A/AA):

- Every ink tier is verified AA against every surface it is used on. The
  original dark design failed here: its muted text sat at 3.5:1.
- Keyboard: skip link, visible focus rings, focus trapped in the cart drawer,
  `Escape` closes drawer and mobile menu.
- `prefers-reduced-motion` disables all reveal animation.
- Reveal animations are progressive enhancement — with JavaScript disabled all
  content renders, and the full catalog is present in the HTML.
- No horizontal overflow at 360 / 390 / 768 / 1024 / 1440 px.
- Phones use a 2-up catalog grid with smaller vials; one column at full size
  made the catalog ~23,000px tall.

Re-run the structural checks at any time (no server or browser needed):

```bash
python3 tools/check.py
```

It verifies that internal links resolve, no template placeholders leaked, every
page has a title / description / canonical / `<main>` / skip link and exactly one
`<h1>`, images carry `alt`, form controls are labelled, and the research-use
notice is present on every key page. It also fails the build if the checkout
price table disagrees with `products.json`, if a restricted compound carries an
add-to-cart control, or if any of the retired account-verification wording
reappears. It exits non-zero, so it can gate a deploy.

Audited with axe-core (WCAG 2.1 A/AA) across fifteen representative pages plus
the open cart drawer in its error state: **0 violations**.

Browser tests (Playwright, Chromium) cover catalog filtering, CAS search,
sorting, out-of-stock state, pack-size to price and label sync, cart
persistence, the `"cart": false` refusal, the checkout consent gate, the
redirect to Stripe, what the browser actually posts, cart clearing after
payment, checkout failure handling, demo mode, form validation and submission,
the accordion and mobile nav.

The checkout function has its own suite: the amount charged comes from the
server-side table and not from the request, every pack size of the multi-size
compound prices independently, and every refusal path — a compound marked
non-buyable, unknown id or size, bad quantity, duplicate lines, missing consent,
oversized body, wrong method, missing key, Stripe errors — is asserted. Stripe
itself is stubbed; see HANDOVER §3c for the live test that is still owed.

---

## Browser support

Evergreen Chrome, Firefox, Safari and Edge. The layout uses CSS grid and custom
properties; `backdrop-filter` and `mix-blend-mode` degrade gracefully.
