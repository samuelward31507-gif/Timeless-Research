# Timeless Research — website

Static marketing and catalog site for a peptide **reference-material supplier**
serving institutional and qualified-research accounts.

No framework, no build toolchain, no runtime dependencies. Pages are generated
from a single Python script so that shared chrome and compliance language can
never drift between pages.

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
contact.html            Account application + quotation request
compliance.html         Research use policy
404.html                Not found
products/<id>.html      34 generated specification pages
legal/                  terms.html, privacy.html, shipping.html
assets/
  css/main.css          Design tokens + all component styles
  js/site.js            Nav, reveal, accordion, request list, drawer
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

Verified in-browser across all 34 catalog names: 30 set on one line, 4 on two,
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

Everything environment-specific is a build-time variable, so a deploy never
means editing source:

```bash
TR_SITE=https://your-domain.com \
TR_CONTACT_EMAIL=accounts@your-domain.com \
TR_FORM_ENDPOINT=https://your-handler.example/submit \
python3 tools/build.py
```

| Variable | Default | Effect |
|---|---|---|
| `TR_SITE` | `https://www.timelessresearch.com` | Canonical tags, Open Graph URLs, sitemap |
| `TR_CONTACT_EMAIL` | `accounts@timelessresearch.com` | Contact fallback address |
| `TR_FORM_ENDPOINT` | *(empty)* | Where the contact form POSTs |
| `TR_ANALYTICS_HEAD` | *(empty)* | Raw `<head>` markup for an analytics tag |

`TR_SITE` and `TR_CONTACT_EMAIL` reach the browser through
`assets/js/config.js`, which the build generates — do not edit that file.

**404s.** `_redirects` is generated for Netlify and Cloudflare Pages. On nginx
use `error_page 404 /404.html;`, on Apache `ErrorDocument 404 /404.html`.
Without it a static host serves its own 404 instead of this one.

**Analytics** is deliberately off. Adding a tag has a privacy-policy
consequence: `legal/privacy.html` currently states the site sets no analytics
cookies and promises to update the policy and obtain consent where required.
Honour that before switching one on.

**Email deliverability.** If `TR_FORM_ENDPOINT` mails you, set SPF and DKIM on
the sending domain or the notifications will land in spam.

---

## Before this goes live

These need your information or a professional's review — not a placeholder I
invent.

| Item | Where | What is needed |
|---|---|---|
| Legal documents | `legal/*.html` | 21 `[BRACKETED]` placeholders across three documents, and review by a lawyer in your operating jurisdiction. They are drafting starting points, **not** legal advice. |
| Certificate data | `quality.html`, product pages | "COA issued with every lot" appears on all 45 pages and the site describes the COA process in detail. If a lot-specific certificate cannot be produced on request, that claim has to come down. |
| Purity claims | `assets/data/products.json` | `≥98%` appears 63 times across cards and vial labels. It is a commercial claim; confirm each against your actual supplier and QC arrangements. |
| Account verification | — | The contact form collects name, email and phone only. Everything the research use policy requires for verification — institution, facility address, responsible investigator, institutional email, intended use — is gathered in the follow-up, so that step has to actually happen off-site. |
| Restricted standards | `assets/data/products.json` | Semaglutide, Tirzepatide, Retatrutide and Oxytocin are flagged `restricted` and gated in the UI. They carry the highest regulatory exposure in the catalog; worth a deliberate decision with counsel rather than a default. |

---

## What this site deliberately does not do

The catalog is limited to research peptides, small-molecule research compounds
and laboratory reagents.

It does **not** include anabolic steroids, controlled substances, finished-dose
pharmaceuticals or prescription medicines, and it has **no consumer checkout**.
Ordering runs through account verification and written quotation instead of a
cart, and the site publishes no dosing, administration or therapeutic guidance
anywhere.

That is a deliberate design constraint, not an oversight. Supplying those
product classes to the public is a licensing matter (and, for scheduled
substances, a criminal one) that a website cannot paper over — and the
research-use framing only holds up if the commercial mechanics actually match
it. Re-adding a cart or those SKUs would undermine the compliance posture the
rest of the site is built on.

---

## Accessibility and testing

Verified with Playwright + Chromium and axe-core (WCAG 2.1 A/AA):

- Every ink tier is verified AA against every surface it is used on. The
  original dark design failed here: its muted text sat at 3.5:1.
- Keyboard: skip link, visible focus rings, focus trapped in the request-list
  drawer, `Escape` closes drawer and mobile menu.
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
notice is present on every key page. It exits non-zero, so it can gate a deploy.

Audited with axe-core (WCAG 2.1 A/AA) across ten representative pages:
**0 violations**. Twenty functional tests cover catalog filtering, CAS search,
the request list, persistence, form validation, the accordion and mobile nav.

---

## Browser support

Evergreen Chrome, Firefox, Safari and Edge. The layout uses CSS grid and custom
properties; `backdrop-filter` and `mix-blend-mode` degrade gracefully.
