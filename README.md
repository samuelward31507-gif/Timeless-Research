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
  js/site.js            Nav, reveal, accordion, request list, drawer, hero canvas
  js/catalog.js         Filtering and search
  js/contact.js         Form validation and submission
  data/products.json    Single source of truth for the catalog
  img/favicon.svg       Generated
tools/build.py          Static site generator
sitemap.xml, robots.txt Generated
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

- Body text meets AA contrast on the near-black ground; the muted greys were
  darkened from the original design, which failed at `rgba(242,244,248,.4)`.
- Keyboard: skip link, visible focus rings, focus trapped in the request-list
  drawer, `Escape` closes drawer and mobile menu.
- `prefers-reduced-motion` disables the hero particle field and all reveals.
- Reveal animations are progressive enhancement — with JavaScript disabled all
  content renders, and the full catalog is present in the HTML.
- No horizontal overflow at 360 / 390 / 768 / 1024 / 1440 px.
- The hero canvas stops painting when scrolled out of view or the tab is hidden.

Re-run the structural checks at any time (no server or browser needed):

```bash
python3 tools/check.py
```

It verifies that internal links resolve, no template placeholders leaked, every
page has a title / description / canonical / `<main>` / skip link and exactly one
`<h1>`, images carry `alt`, form controls are labelled, and the research-use
notice is present on every key page. It exits non-zero, so it can gate a deploy.

Audited separately with axe-core (WCAG 2.1 A/AA) across ten representative
pages: **0 violations**.

---

## Browser support

Evergreen Chrome, Firefox, Safari and Edge. The layout uses CSS grid and custom
properties; `backdrop-filter` and `mix-blend-mode` degrade gracefully.
