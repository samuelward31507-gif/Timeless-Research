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

The compound is sized to fill the label rather than sit in it. A fixed size
ladder left short names filling half the width and long ones filling most of
it; `name_scale()` in `tools/build.py` estimates each string's rendered width
from per-character advances (calibrated against measured renders, accurate to
~5%) and sizes it to a common target. Fill now lands at 90–95% across the
catalog instead of 49–85%, and `tools/check.py`'s companion browser test
asserts no label overflows its box.

Label geometry in `.vial-print` is measured from the asset, not eyeballed —
`make_vial.py` prints the values to keep CSS and asset in sync. Below 260px the
research-use line is dropped, since at that scale it renders under 6px and
reads as a smudge. Compound names are not uppercased, so Greek characters
(α, β) survive.

**Despeckling.** The photographed glass carries fine white dust specks. On the
original black backdrop they read as sparkle, but a luminance-derived alpha
makes each speck *opaque* while the dark glass around it goes transparent — on
a light page they turn into visible dirt, which is what made the vial look
cheap. Alpha is therefore derived from a median-filtered copy (`DESPECKLE`)
while the RGB stays sharp, so the cap's brushed metal and the label's paper
texture are untouched. The glass curve was also steepened (`GLASS_GAMMA` above
1) so mid-tones drop away and the glass reads clear rather than milky.

The studio shadow is cut along with the black backdrop, so `.vial::after` draws
a contact shadow — without it the vial floats above the tile.

`make_vial.py` can also recolour the crimp cap (`CAP_TINT`) by remapping the
cap's own luminance onto a colour ramp, which keeps the metal's specular and
brushed texture rather than flat-filling it. It is set to `None` — bare
aluminium, as photographed.

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

## Before this goes live

These are the things that are deliberately unfinished, because they need your
information or a professional's review — not a placeholder I invent.

| Item | Where | What is needed |
|---|---|---|
| Form endpoint | `assets/js/contact.js` | Set `ENDPOINT` to your handler URL. Until then the form falls back to opening the visitor's mail client, which leaves you no record of submissions. |
| Contact addresses | `assets/js/contact.js`, legal pages | Replace `accounts@timelessresearch.com` and the `[BRACKETED]` addresses. |
| Legal documents | `legal/*.html` | Every `[BRACKETED]` placeholder must be completed, and all three documents reviewed by a lawyer in your operating jurisdiction. They are drafting starting points, **not** legal advice. |
| Canonical domain | `SITE` in `tools/build.py` | Currently `https://www.timelessresearch.com`. Feeds canonical tags, Open Graph URLs and the sitemap. |
| Certificate data | `quality.html`, product pages | The site describes the COA process and claims a `≥98%` **specification**. It publishes no lot-specific results, because those must come from your actual analytical records. Wire real COA PDFs per lot before claiming them. |
| Purity / assay claims | `assets/data/products.json` | The `purity` and `assays` fields state what you intend to release against. Confirm each against your real supplier and QC arrangements; they are commercial claims. |
| Analytics | — | None installed. If you add any, update `legal/privacy.html` and obtain consent where required. |

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
