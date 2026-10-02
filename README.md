# Timeless Research — website

Catalog and storefront for a peptide **reference-material supplier**, sold for
laboratory research use only.

No framework, no build toolchain, no runtime dependencies. Pages are generated
from a single Python script so that shared chrome and compliance language can
never drift between pages. The server-side code is a handful of Netlify
Functions, there because a static page cannot hold a secret key: one creates
Stripe Checkout sessions, and one answers the order and product help
assistant (see [Support assistant](#support-assistant)).

**Taking this site over? Start with [HANDOVER.md](HANDOVER.md)** — it lists
everything an operator has to supply, deploy and decide, in order. This file
covers how the site is built.

### Put a demo online

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/samuelward31507-gif/Timeless-Research)

Free, and nothing it touches is live. Netlify reads `netlify.toml`, so every
build setting comes across — including `TR_DEMO = "1"`, which puts a
not-trading bar on every page and keeps the deploy out of search results.

Checkout works on the demo, against Stripe's **test** mode, so the thing the
site is a demonstration *of* can actually be shown. Add
`STRIPE_SECRET_KEY` (an `sk_test_...` key) under **Site configuration →
Environment variables**, redeploy, and pay with `4242 4242 4242 4242`.

The function refuses to run a demo build against a live key, so this cannot
quietly start taking real money. Full steps, including the redeploy people
miss: [HANDOVER.md §2b](HANDOVER.md).

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
coa.html                Certificate index; links a PDF where one exists
pay.html                How ordering and payment work
order-received.html     Stripe success_url; confirms and empties the cart
legal/                  terms.html, privacy.html, shipping.html
assets/
  css/main.css          Design tokens + all component styles
  js/site.js            Nav, reveal, accordion, cart, drawer, checkout
  js/catalog.js         Filtering and search
  js/contact.js         Form validation and submission
  js/chat.js            Order and product help assistant (drawer, history)
  data/products.json    Catalog, prices, volume tiers, shipping threshold
  data/addons.json      Optional add-ons and the rules that offer them
  coa/<id>.pdf          Optional; publishes that compound's certificate
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
  create-checkout-session.js  Creates the Stripe session
  catalog.json          Price table it charges from (generated)
  chat.js               Support assistant: screens, calls the Anthropic API
  chat-knowledge.json   Everything the assistant may answer from (generated)
  addon-availability.js In stock or not, per stock-tracked add-on (read-only)
  addons.json           Add-on prices and eligibility (generated)
netlify/lib/addons.js   Add-on validation and pricing, payment-provider agnostic
netlify/lib/admin-auth.js  Operations console: who is calling (token + staff)
netlify/lib/admin-api.js   Operations console: rules shared by the read API
netlify/functions/admin-*.js  Operations console API (GET reads; POST writes on three)
netlify/lib/notify.js   New-order notifications: messages, Postmark and Twilio
netlify/lib/db.js       The database (Neon), server side: queries, transactions,
                        types and errors. Not used by any function yet
netlify/lib/orders.js   Order intake: records a paid order, whoever took the
                        payment (one transaction on Neon). Not wired yet
netlify/functions/notify-dispatch.js  Sends due notifications (scheduled, every minute)
tools/addons.py         Reads, validates and resolves assets/data/addons.json
supabase/migrations/    0001 orders; 0002 add-ons; 0003 order lifecycle,
                        inventory and lots, financials, customer views;
                        0004 console data layer; 0005 notification outbox;
                        0006 the server's privileges, stated explicitly
db/neon/                Neon only: roles before the migrations, read-only
                        access after them (see HANDOVER, 3i)
tests/                  Node and Python tests (no dependencies)
tests/db/               Database tests against PostgreSQL 16 (PGlite, test-only),
                        on the Supabase and the Neon role model
console/                Operations console pages (generated; private, noindex)
tools/console_build.py  Builds console/: its own shell, not the storefront's page()
tools/console_rules.py  What check.py requires of every console page
assets/js/console/      Console scripts: auth seam, request layer, UI pieces, shell
tests/console/          Console browser tests (Playwright) and offline dev server
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
6. Optional: set `ANTHROPIC_API_KEY` there too, to switch on the support
   assistant. Set a monthly spend limit for the key in the Claude Console
   first (HANDOVER §3d). Until it is set, the assistant tells visitors it is unavailable and
   points them to the contact page.

Run it locally exactly as Netlify does with
`python3 tools/build.py && python3 tools/dist.py`, then serve `dist/`.
`dist/` is generated and git-ignored; never edit it.

`dist.py` re-resolves every internal link inside the publish directory before
it reports success, and exits non-zero if one does not resolve. That is not
redundant with `check.py`: `check.py` walks the source tree, so it cannot see a
page that was built correctly and then left out of the copy. The `legal/`
directory was missing from the copy list for as long as it existed — 114 footer
links, on every page, resolving locally and 404ing once deployed.

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
| `TR_SITE` | `https://www.timelessresearch.com` | Canonical tags, Open Graph URLs, sitemap. On a `TR_DEMO` build, Netlify's own `DEPLOY_PRIME_URL`/`URL` wins, so a demo deploy is self-addressing and its link previews resolve |
| `TR_CONTACT_EMAIL` | `accounts@timelessresearch.com` | Contact fallback address |
| `TR_FORM_PROVIDER` | `netlify` | `netlify`, or `endpoint` to POST JSON elsewhere |
| `TR_FORM_ENDPOINT` | *(empty)* | Target when `TR_FORM_PROVIDER=endpoint` |
| `TR_ANALYTICS_HEAD` | *(empty)* | Raw `<head>` markup for an analytics tag |
| `TR_LEGAL_ENTITY` / `TR_LEGAL_ADDRESS` / `TR_LEGAL_STATE` / `TR_LEGAL_EMAIL` | see *Legal documents* | Parties, controller and governing-law clauses |
| `TR_DEMO` | *(off)* | `1` marks the build a demonstration: a not-trading bar on every page, `noindex`, `robots.txt` disallowing all, and a checkout that runs against Stripe's test mode and says so |

The checkout function reads its own, set on the deploy rather than at build time:

| Variable | Default | Effect |
|---|---|---|
| `STRIPE_SECRET_KEY` | *(none)* | Required. Never put it in `netlify.toml` |
| `TR_SHIP_STANDARD_CENTS` | `1500` | Standard shipping rate offered at checkout |
| `TR_SHIP_EXPRESS_CENTS` | `3500` | Express shipping rate offered at checkout |
| `TR_SHIP_COUNTRIES` | *(empty)* | Comma-separated ISO codes; empty uses the list in the function |
| `TR_STRIPE_TAX` | *(off)* | `1` enables Stripe Tax on the session |

The support assistant reads one, also set on the deploy:

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(none)* | Optional. Switches on the assistant. Never put it in `netlify.toml` |

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

**Volume pricing** is `volumeTiers` in `products.json`, applied per cart line
and computed three times from that one source: the product page states the
breaks, the cart shows the discount and the saving, and the checkout function
recalculates it for the charge. Only the third is authoritative — a discount in
the request is ignored. `freeShippingOver` zeroes the standard shipping rate
once the goods subtotal clears it, measured after discount. `check.py` refuses
impossible or non-monotonic tiers, and a browser test asserts the cart's
subtotal equals what the function independently arrives at for the same cart.

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

**The entry overlay is an affirmation, not a gate.** First visit shows a
full-screen confirmation (21 or over; in vitro research use) before the site,
remembered in `localStorage` under `tr_ruo_ack_v1`. Its whole behaviour is
inline in `<head>` rather than in the deferred `site.js`: it has to run before
the body paints, and a blocking overlay must not depend on a file that might
not arrive. It fails open three ways — no JavaScript, unreadable storage, and a
plain anchor as the way out — so it can never trap a visitor or hide the
catalogue from a crawler, and the page behind it stays in the DOM.

**What the site does not claim.** There is no account verification, no vetting
and no credentialing step, and no page says otherwise — research use is a
contractual condition confirmed at checkout, and `compliance.html` §3 says so in
those words. `tools/check.py` carries a list of the retired "verified account"
wording and fails the build if any of it reappears, because a promise the
operator cannot keep is worse than no promise.

---

## Support assistant

A small "Questions?" button on every page opens the order and product help
assistant: a drawer like the cart, with the research-use line in its header
above anything it says. It answers questions about products, specifications,
CAS numbers, COA availability, prices and volume tiers, shipping, returns,
payment, the order process and how to reach a person. It does not take orders
or payment details; it links the product page and explains the cart.

**What it knows.** `tools/build.py` writes
`netlify/functions/chat-knowledge.json` on every build: an allow-list of
catalogue fields per product (name, synonyms, CAS, formula, MW, sequence,
form, purity, storage, release assays, packs and prices, stock, the restricted
flag) plus the readable text of the FAQ, ordering, shipping, terms, privacy,
research-use, analytical-programme and COA pages, lifted from the generated
HTML. Two product fields are left out on purpose and `check.py` fails if
either appears: `solubility`, one step from reconstitution advice, and the
`research` blurbs, which describe preclinical findings and read easily as a
claim about what a compound does. The restricted notice is one constant in
`build.py`, shared by the specification pages and the assistant, which may say
nothing else about those compounds.

**What it will not do,** in three layers, each enough on a good day:

1. A fixed pattern screen in `netlify/functions/chat.js` refuses clear dosing,
   reconstitution, administration, cycling, stacking, human- or animal-use and
   health-claim questions without calling the model at all.
2. The system prompt carries the same rules, refuses whatever the screen
   misses (rephrasings, fiction, "hypothetically", "for a friend",
   role-play), and treats anything in a visitor's message that tries to change
   the rules as just a message.
3. A screen on the reply replaces any answer carrying an amount per day,
   mg/kg, a volume of water or a syringe figure with the refusal.

Every refusal points to `compliance.html`. Earlier assistant turns travel back
from the browser with each question, so the function signs every reply and
refuses a history it did not write: a page cannot forge an "assistant" that
already gave a dose.

**Limits.** Model `claude-sonnet-5-5`, at low effort with a 1,024-token cap
and a 9-second timeout (Netlify stops a synchronous function at 10). The last
ten messages are kept; a question is at most 1,000 characters; bodies over
32 KB and anything but POST are refused. Rate limiting is per IP, 8 a minute
and 60 an hour, held in memory, so it covers one warm instance only: it stops
one browser hammering the button, not a determined client. The spend limit on
the API key is the real ceiling. The function logs outcome, latency and token
counts, never the question, the reply or the address. The knowledge and rules
are sent as a cached prefix, so repeat questions cost mostly the conversation.

**Without a key** the assistant says it is unavailable and points to the
contact page; on a demo build it says the demo has no assistant switched on.
`/.netlify/functions/health` reports whether the key is set.

**Testing.**

```bash
node --test tests/chat.test.js          # stubbed; no key, no network
ANTHROPIC_API_KEY=sk-ant-... node tests/chat_live.mjs report.json
```

The stubbed suite asserts that 30 dosing and human-use questions are refused
without reaching the model, that 25 ordinary questions sharing their words
("price for 10 units", "stacked boxes", "restock cycle", "add 25 units to my
cart") are not, and covers every refusal path: wrong method, oversized body,
malformed or forged history, rate limit, missing key, model refusal, a reply
carrying a dose, a truncated reply, API errors, and that nothing a visitor
types reaches the log. The live run sends the same questions, plus 18 indirect
ones written to slip past the screen, straight to the model with the
production request, grades each reply with a second model, and reports
latency against the timeout. Run it before launch and after any change to the
model, the rules or the knowledge.

## Add-ons

Optional add-ons are shipping, documentation or packaging services a customer
can attach to a cart line: an insulated shipper for a cold-chain compound, a
certified copy of the certificate of analysis, a moisture-barrier pouch per
vial. They are configured in `assets/data/addons.json`, apart from the
catalogue, so they can be added, repriced or retired as a data edit.

**Status: built, not switched on.** Everything up to the payment step exists
and is tested. The payment integration does not yet charge for add-ons, so
`PAYMENT_INTEGRATION_READY` in `tools/addons.py` is `False`. While it is, the
cart shows no add-ons, and the build and `check.py` both refuse an enabled
one, so a customer can never be shown an add-on that checkout would drop.
Every entry in the shipped file is an example, disabled, with no price.

**The flow.** Product → eligible add-on offered on its cart line → customer
ticks it → cart → server-side validation and pricing → the payment processor
→ confirmed payment → the order records the add-on as its own line →
inventory is updated. Nothing in it is specific to a payment processor:
`netlify/lib/addons.js` returns neutral line objects in cents, and the
database records and counts them however the order was paid for.

**Configuring.** Each add-on has an `id`, `name`, `description`, `kind`
(`shipping`, `documentation` or `packaging`), `quantity` (`per-line`: one per
line; `per-unit`: one per unit on the line), `price`, `trackInventory` and
`enabled`. Rules say where add-ons are offered:

```json
{ "id": "cold-chain", "recommend": ["insulated-shipper"],
  "when": { "categories": ["metabolic", "growth"] } }
```

`when` takes `products` (ids), `categories` (ids), or `"allBuyable": true`.
The build resolves the rules into a product → add-ons map that the cart and
the server both read, so they cannot disagree. An add-on offered by two rules
is credited to the first, for reporting.

**What add-ons never do.** Change their line's price, its volume tier, or the
free-shipping threshold, which counts products only; the cart shows products
and add-ons as separate rows once an add-on is ticked, and says "more in
products" in the free-shipping line. Attach to the order as a whole: every
add-on belongs to a line.

**The compliance guard.** `tools/addons.py` refuses any add-on whose id, name
or description mentions a diluent or water, a syringe, needle, swab or other
means of preparing or administering material, dosing, cycling or stacking, or
an effect or claim (weight loss, recovery, health and so on), and any kind
other than the three above. It is a guard against a data edit, not a
substitute for judgement: it fails the build, and the list is in the file.

**Server side.** `priceAddons()` takes product lines the caller has already
validated, and refuses: add-ons while the integration is not ready; unknown
or disabled add-ons; an add-on not offered on that product; duplicates;
malformed selections; and stock-tracked add-ons that are out of stock, or
whose stock cannot be read (it fails closed). The browser sends add-on ids
only: prices, quantities and the rule an add-on counts under are decided on
the server. `orderItemRows()` produces the `order_items` rows, product lines
carrying the add-ons they were offered.

**Inventory** is a ledger in the database (`supabase/migrations/0002_addons.sql`):
stock is the sum of `addon_stock_movements`. Restock or correct by inserting a
row. `record_addon_sales(order_id)` takes a confirmed order's add-ons out of
stock and is idempotent, including across a retry that rewrites the order's
items. Cancelling or refunding an order puts them back, once, by trigger.
Stock is not reserved while a customer pays, so two buyers of the last unit
can both succeed; the sale is recorded and the level goes negative, which is
how an oversell shows. `/.netlify/functions/addon-availability` tells the
cart which tracked add-ons are in stock, as booleans, never counts; it reads
the ledger through `netlify/lib/db.js` (Neon, `DATABASE_URL`).

**Reporting** needs no tracking of visitors. Two views, readable only with the
service role (the Supabase dashboard): `addon_revenue` (units and revenue per
add-on per month) and `addon_attach_rate` (of the product lines an add-on was
offered on, how many took it). "Offered" is recorded by the server on each
product line at order time. Paid and shipped orders only.

**Previewing.** To see add-ons in the cart before the integration exists,
build locally from the test fixture:

```bash
TR_ADDONS_FILE=tests/fixtures/addons.json TR_ADDONS_PREVIEW=1 python3 tools/build.py
```

The cart then carries a "preview build, not charged" notice, `check.py`
fails, and the build refuses to run on Netlify. Rebuild without the variables
afterwards.

**Testing.**

```bash
node --test tests/addons.test.js                        # server side, no network
python3 -m unittest discover -s tests -p 'test_*.py'    # configuration and guard
```

## Operations data

`supabase/migrations/0003_operations_foundation.sql` is the data layer for
running the business: order lifecycle, product inventory by lot, expenses,
cost of goods and margin, and customer summaries. It is schema, rules and
reporting views only: no screens yet (the operations console is Phase 1), and
nothing on the public site reads it. It is independent of the payment
processor. HANDOVER §3f says how to use it day to day.

**Order lifecycle.** `paid → processing → packed → shipped → delivered →
completed`, with `cancelled` before shipping and `refunded` at any point. The
allowed moves are rows in `order_status_transitions`; a trigger refuses any
other, stamps a timestamp per state, and writes `order_status_history` for
every change. A payment confirmation that arrives again after the order has
moved on writes `status = 'paid'`; the trigger keeps the order where it is
instead, so it can never move backward. `set_order_status()` is how the console
will move orders, with a note and the person's name in the history.

**Inventory and lots.** A stock item is a product and pack size. Stock exists
only in `lots` (lot number, quantity received, retest date, COA reference,
unit cost), and a lot's quantity is the sum of its `stock_movements`, an
append-only ledger: receipts, allocations to orders, releases, returns,
adjustments and write-offs, none of which can take a lot below zero. An order
line is drawn from a lot by `allocate_order_line()`; each allocation is one
(line, lot) row, so splitting a line across lots is more rows, not a new
schema. Cancelling, or refunding before shipping, returns allocated stock;
refunding after shipping does not, and a returned parcel is recorded as a
`return`. Views: `lot_levels`, `inventory_levels` (on hand, sold but not yet
allocated, available, low stock), `low_stock`, `inventory_velocity`.

**Financials.** `expenses` with `expense_categories` (a generic starting set;
inventory purchases are a separate treatment so they reach profit as cost of
goods, not twice). Cost of goods is allocated units times their lot's unit
cost. Views: `monthly_revenue` (orders, totals, average order value),
`order_metrics`, `monthly_expenses`, `order_cogs`, `monthly_gross_margin`,
`monthly_financial_summary`. **Not complete until the payment processor is
chosen:** processor fees and tax are not separated from order totals, partial
refunds are not modelled, and revenue by product needs every order line to
record its sku, which the current payment integration does not. The views say
so (`fees_and_tax_separated = false`), and gross margin is reported only over
orders whose cost is fully known (`orders_cost_complete`), never estimated.
CSV import: load a CSV into `expense_import`, then `select * from
import_expenses()`; each row is validated on its own and a re-import is marked
as a duplicate. Export any view as CSV from the Supabase dashboard.

**Customers.** `customer_aggregates` and `customer_summary`, read-only and
keyed by email: first and last order, order count, lifetime revenue, repeat
flag and repeat rate. No accounts, no profiles, no marketing fields.

**Access.** As changed by `0004_console_foundation.sql`:

- **Browser roles** (`anon`, `authenticated`) can read and change nothing,
  by one of two means:
  - every view, every function, and the tables added by 0004 are revoked
    from them outright;
  - the tables from 0001 to 0003 keep Supabase's default grant but have row
    level security on with no policy, so a browser role sees no rows and can
    write none.

  `tests/db/console-api-contract.test.mjs` checks that every object the
  console API reads is covered by one or the other.
- **The server (service role)** reads everything. It still writes `orders`
  and `order_items` directly, because that is how the payment path records a
  paid order. It cannot insert, update, delete or truncate the console and
  operations tables:
  - staff, roles and permissions;
  - the audit log, order notes and line mappings;
  - status history and transitions;
  - stock items, lots, allocations and stock movements;
  - expenses, expense categories and the expense import table.
- **Console writes** go only through the protected database functions
  (`admin_*`, `ship_order`, `receive_lot`, `sync_inventory_items`). Each takes
  the acting staff member's id, which the server takes from the verified
  sign-in ([Operations console: authentication](#operations-console-authentication)).
  The database then checks that this is an active staff member whose role
  allows the action, records the change against them, and writes the audit
  entry in the same transaction.
- **Internal helpers are not callable through the API.** This covers the 0003
  helpers that take a free-text actor (`set_order_status`,
  `allocate_order_line`, `record_stock_movement`, `import_expenses`) and
  `bootstrap_owner`. They remain usable from the Supabase SQL editor.

**Testing.**

```bash
cd tests/db && npm ci && npm test     # PostgreSQL 16 in-process; test-only dependency
```

`tests/db` is the one place with a package: PGlite, pinned, so the migrations
are tested against a real database without a server. Nothing in it is
deployed; the site and its functions still have no runtime dependencies.

## Operations console: the UI foundation

The console's screens are not built yet. What exists is the foundation they
will be built on, and it is private by construction:

- **Its own pages.** `tools/console_build.py` writes `console/` with its own
  document shell, not the storefront's `page()`: no entry gate, cart,
  assistant, Open Graph or canonical; always `noindex,nofollow`; never in
  `sitemap.xml`; disallowed in `robots.txt` on a trading build. The navigation
  lists every documented area (dashboard, orders, fulfilment, inventory, lots,
  expenses, CSV import, financials, customers, audit) as *not built yet* until
  its screen exists.
- **Served privately.** `netlify.toml` gives `/console/*` `Cache-Control:
  no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`
  and a Content-Security-Policy that runs only the console's own files
  (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src
  'self'; frame-ancestors 'self'`). No inline script or style anywhere.
  `tools/check.py` applies `tools/console_rules.py` to every console page and
  fails if the headers block, the robots rule or `dist.py`'s `console` entry
  goes missing.
- **An authentication seam, with no provider.** `assets/js/console/auth.js`:
  a provider (when one is chosen) registers once with
  `TRConsole.auth.setTokenProvider(fn)`; everything else asks
  `getAccessToken()`. The token lives in memory only and goes nowhere but the
  `Authorization: Bearer` header. As shipped there is no provider, so the
  console has no session and makes no requests.
- **One request layer.** `TRConsole.api.requestAdmin(endpoint, { params })`
  for a read, `{ action, fields }` for a write, to the seven `admin-*`
  endpoints only. No cookies, no caching, no redirects. Every documented
  answer becomes a `ConsoleError` kind: `signin` (401), `mfa` (403
  `mfa_required`), `forbidden` (403), `invalid` (400/405/413/415),
  `not_found`, `conflict`/`retry` (409), `rejected` (422, with the API's own
  sentence), `unavailable` (500) or `network`.
- **Shared pieces.** `assets/js/console/ui.js`: loading, empty and error
  states; a modal confirmation dialog (focus starts on Cancel, Escape
  cancels, an optional required reason); a polite toast. Everything is built
  with DOM nodes and `textContent`: names, addresses and notes are always
  text, never markup. `shell.js`: the header, the session notice, and the
  navigation folding behind a Menu button on narrow screens.

**Offline development and tests.**

```bash
python3 tools/build.py
(cd tests/console && npm ci && npm run dev)   # http://127.0.0.1:4317/console/index.html
(cd tests/console && npm test)                # Playwright, Chromium, offline
```

`tests/console/server.mjs` serves `console/` and `assets/` with
`netlify.toml`'s own headers, and runs the **real** `admin-*` handlers in
process on `tests/helpers/admin-fixtures.js` (a throwaway signing key, a fake
staff lookup and canned rows): there is no second API to drift from the real
one. `npm run dev` also registers a development token provider, injected by
the server only, so the console opens with a session. It listens on
127.0.0.1, serves nothing else in the repository, and nothing it does
reaches the network; the browser tests also fail if a page requests any other
host. `tests/test_console_rules.py` covers the page rules and the deployment
wiring.

## Operations console: authentication

`netlify/lib/admin-auth.js` decides who is calling the operations console. It
is a library, not an endpoint: there are no console endpoints or screens yet,
and nothing on the public site uses it. Every console endpoint will start with

```js
const { authenticateStaff, denialResponse } = require('../lib/admin-auth.js');
const who = await authenticateStaff(event);
if (!who.ok) return denialResponse(who);
// who.staff.id is the acting staff member: the p_actor of every database call
```

**Who gets in.** A Supabase Auth user who has passed a second factor and is an
active row in `staff_members` with an allowed role. The only allowed role is
`owner`. Sign-up is invite-only and is set in the Supabase dashboard, not here
(HANDOVER §3g).

**The actor rule.** The staff member a console action is recorded against is
`staff_members.id` for the row whose `auth_user_id` is the verified token's
subject, and nothing else. The library reads the `Authorization: Bearer`
header and nothing else: an id in the body, the query string, a cookie or any
other header is never consulted, and a token's other claims cannot name a
staff member either. The database then checks the same id again
(`app_require`) before any write.

**What a token must be.**

- Signed with ES256 or RS256 by a key in the project's published key set,
  `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, matched by `kid`, with the
  key's type (EC P-256, or RSA of at least 2048 bits) matching the algorithm.
  There is no shared-secret (HS256) path at all, so `alg: none` and "the
  public key used as an HMAC secret" have nothing to work with.
- `iss` exactly `<SUPABASE_URL>/auth/v1`; `aud` `authenticated`; `role`
  `authenticated`; `sub` a UUID; not an anonymous user.
- `exp` present and not passed, `iat` present and not in the future, `nbf` (if
  present) not in the future, all with 30 seconds of clock tolerance; a token
  valid for more than 24 hours is refused outright.
- `aal` `aal2`: MFA is enforced here on every request, whatever the dashboard
  allows.
- The header is at most 8 KB; a header with `crit`, or two different
  Authorization values, is refused.

**Signing keys.** The key set is fetched without credentials, with a 5-second
timeout, cached for 10 minutes, and refetched early when a token names a `kid`
it does not hold (a key rotation), at most once a minute so random `kid`s
cannot make it fetch on demand. A `kid` published twice is ignored. If the key
set is needed and cannot be fetched, nothing is verified.

**Staff, every request.** The verified subject is looked up in
`staff_members` with the service role key, on every request, so deactivating
someone takes effect on their next request rather than when their token
expires. Unknown, inactive and not-allowed-role users are refused. The service
role key is read from the environment on the server and is never sent
anywhere but Supabase's REST API.

**Failure.** Always closed. A missing, malformed, forged or expired token is
401 `not_authorized`; a valid token without MFA is 403 `mfa_required` (said
only once everything else about the token has checked out, and before
anything about staff); a valid token that is not active staff is 403
`not_authorized`. Missing or unsafe configuration (`SUPABASE_URL` must be
`https://`), an unreachable key set, a PostgREST error or an unexpected answer
is 500 `unavailable` — never access. The log records a reason code, and the
user id for staff-level refusals; never a token or any key.

**Configuration.** None new: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`,
the same two the order webhook uses.

**Testing.**

```bash
node --test tests/admin-auth.test.js   # offline; signs its own tokens
```

The suite generates its own EC and RSA keys, signs tokens with them, and stubs
the key set and PostgREST. It proves what the library accepts and refuses. It
does **not** prove that the real Supabase project issues tokens shaped the way
the library expects: that needs the staging project (HANDOVER §3g).

## Operations console: read API

Seven endpoints serve the console's screens. There are no screens yet, so
nothing calls them. Each is a Netlify function at
`/.netlify/functions/<name>`. All seven answer `GET`. Three of them also take
the console's writes as `POST`; see
[Operations console: write API](#operations-console-write-api).

| Endpoint | Needs | Reads |
|---|---|---|
| `admin-dashboard` | `orders.read` (revenue also needs `finance.read`, stock `inventory.read`) | status counts, orders needing attention, revenue, low stock, retests due |
| `admin-orders` | `orders.read` (cost of goods also `finance.read`) | the order queue (`status`, `attention=1`, `q`, paging); one order with `?id=` |
| `admin-inventory` | `inventory.read` | stock levels (`active`, `low=1`); one item with `?product_id=&pack_size=`; one lot with `?lot_id=` |
| `admin-expenses` | `finance.read` | expenses (`from`, `to`, `category`, `include_deleted=1`, paging); one with `?id=`; staged import rows with `?view=import` |
| `admin-financials` | `finance.read` | monthly summary, gross margin, expenses by category, add-on reports (`from_month`, `to_month`) |
| `admin-audit` | `audit.read` | the audit log (`entity_type`, `entity_id`, `action`, paging) |
| `admin-customers` | `customers.read` (one customer's orders also `orders.read`) | customers and the summary; one customer with `?email=` |

`netlify/lib/admin-api.js` holds the rules every endpoint follows, in order:

1. **Method.** Anything but `GET` (or `POST` on the three endpoints that
   write) is 405, before anything else happens.
2. **Who.** `authenticateStaff(event)` (above). The staff id it returns is the
   only actor; no parameter, header or body can name one, and an actor-like
   parameter (`actor_id`, `staff_id`, `user_id` and the like) is refused.
3. **May they.** `staff_can(staff id, permission)` in the database, before
   any parameter is looked at, so a refused caller learns nothing about them.
4. **What.** Each endpoint has an allow-list of parameters. An unknown,
   repeated or malformed one is 400 with the parameter's name. Every value
   reaching a PostgREST filter is validated first: UUIDs, real dates, fixed
   choices, bounded integers (`limit` 1 to 100), and search text without the
   characters that could change a filter's shape. Values inside an `or=()`
   are also quoted.
5. **Read.** PostgREST with the service role key, on the server. Every query
   names its columns. Lists never include a phone number or an address; only
   the single-order view does, because shipping needs them.

Paging is by an opaque `cursor`, returned as `next_cursor`. It holds the last
row's sort key, and is refused if it does not decode to exactly the shape
that endpoint issues. Customers page by offset, up to 10,000 rows.

Every response has `Cache-Control: no-store`. Database errors become a fixed
code: 403 `not_authorized`, 404 `not_found`, 400 `invalid_input`, otherwise
500 `unavailable`. The database's own message is never passed on, because it
can name tables, constraints and values. Logs record the endpoint, the staff
id and an error code: never a request, a response, a token or a key.

A customer is their email address, lower-cased and trimmed, as
`customer_aggregates` keys them. One customer's orders are found with a
contains-match on email. In that match, `_` is a one-character wildcard, so
every row it finds is compared exactly before it is returned.

**Testing.**

```bash
node --test tests/admin-api.test.js tests/admin-read.test.js   # offline
(cd tests/db && npm ci && npm test)   # includes console-api-contract.test.mjs
```

The first two drive every endpoint with signed tokens and stubbed Supabase.
The contract test drives them the same way, records every table, view and
column they read, filter or sort on, and checks each one against the
migrations in PostgreSQL 16:

- that it exists;
- that the service role can read it;
- that the browser roles cannot.

## Operations console: write API

Every change the console can make is one `POST` action on one of three
endpoints. Each action calls exactly one protected database function from
migration 0004. That function checks the permission again, makes the change
and writes the audit entry, all in one transaction. The API never writes a
table itself.

| Endpoint | Action | Needs | Database function |
|---|---|---|---|
| `admin-orders` | `order.set_status` | `orders.write` | `admin_set_order_status` |
| | `order.add_note` | `orders.write` | `admin_add_order_note` |
| | `order.ship` | `orders.write` | `ship_order` |
| | `fulfilment.allocate` | `fulfilment.write` | `admin_allocate_order_line` |
| | `fulfilment.release` | `fulfilment.write` | `admin_release_allocation` |
| | `fulfilment.map_line` | `fulfilment.write` | `admin_map_order_line` |
| | `fulfilment.unmap_line` | `fulfilment.write` | `admin_unmap_order_line` |
| `admin-inventory` | `inventory.receive_lot` | `inventory.write` | `receive_lot` |
| | `inventory.update_item` | `inventory.write` | `admin_update_inventory_item` |
| | `inventory.update_lot` | `inventory.write` | `admin_update_lot` |
| | `inventory.record_movement` | `inventory.write` | `admin_record_stock_movement` |
| | `inventory.sync` | `inventory.write` | `sync_inventory_items` |
| `admin-expenses` | `finance.create_expense` | `finance.write` | `admin_create_expense` |
| | `finance.update_expense` | `finance.write` | `admin_update_expense` |
| | `finance.delete_expense` | `finance.write` | `admin_delete_expense` |
| | `finance.restore_expense` | `finance.write` | `admin_restore_expense` |
| | `finance.stage_import` | `finance.write` | `admin_stage_expense_import` |
| | `finance.import` | `finance.write` | `admin_import_expenses` |

A write is a JSON body naming its action and its fields, for example
`{"action": "order.ship", "order_id": "…", "carrier": "UPS",
"tracking_number": "1Z…"}`. It is refused, in this order, before the
database is asked anything:

1. **Not a JSON request.** The content type must be `application/json`, or
   the response is 415. The body is at most 64 KB, or 1 MB for
   `finance.stage_import`; larger is 413. Both are checked before sign-in.
2. **Not signed in** as an active staff member with MFA (as for reads).
3. **Not one JSON object naming a known action** of this endpoint (400). Any
   query parameter on a write is also 400: a write's input is its body.
4. **Missing the action's permission**, checked with `staff_can` (403). The
   database function checks it again.
5. **A field that is unknown, missing, or the wrong type or size** (400,
   naming the field). This includes any field that could name an actor:
   `actor_id`, `staff_id`, `p_actor`, `created_by` and the like. Inside
   `changes`, only the keys the database function edits are accepted, each
   typed, because the function casts them directly.

The acting staff member (`p_actor`) is added by the server, last, from the
verified sign-in. Nothing in the body, the query string, a header or a cookie
can supply or change it.

**Answers.** Each action returns `{"action": …, "result": …}`. The result is
the new id, a yes/no, counts, or the changed row cut down to named fields.
Refusals are mapped as follows:

| Database refusal | Response |
|---|---|
| Permission (`42501`) | 403 |
| Not found (`P0002`) | 404 |
| The migrations' own rules (`23514`) | 422 `rejected` |
| Already exists (`23505`) | 409 `conflict` |
| Refers to nothing (`23503`) | 422 |
| Bad value (`23502`, `22…`) | 400 |
| Serialization (`40001`) | 409 `retry` |
| Anything else | 500 |

The migrations' own refusals are written for the operator ("only a packed
order can be shipped", "lot L1: only 3 on hand, cannot remove 5"), so for
404 and 422 that sentence is passed on as `message`. PostgreSQL's generated
messages, and every database detail and hint, never are: they can quote
table names and the failing row.

**Inventory sync takes no input.** `sync_inventory_items` deactivates every
stock item missing from the list it is given, so the list never comes from
the request. It is every product and pack size in this deploy's
`netlify/functions/catalog.json`, which `tools/build.py` generates. A body
carrying any field besides `action` is refused. If the catalogue is missing,
empty or malformed, the sync stops with 500 rather than deactivate stock.

**Cancelled and refunded are records.** Setting either status, from the
console or anywhere else, moves no money; refunds are made in Stripe.

**Testing.**

```bash
node --test tests/admin-write.test.js   # offline; every action and refusal
(cd tests/db && npm ci && npm test)      # includes console-write-contract.test.mjs
```

`tests/admin-write.test.js` drives every action with signed tokens and
stubbed Supabase. It checks the exact database function and arguments, and
that `p_actor` is always the signed-in staff member, whatever the body, query
string, headers or cookies claim. It also checks every refusal path.

`tests/db/console-write-contract.test.mjs` runs every action through its real
handler. The Supabase calls are answered by PostgreSQL 16 with the
migrations applied, acting as the service role. It checks four things:

- each action reaches its function with arguments that function accepts;
- the change happens;
- exactly one audit row names the signed-in staff member;
- a staff member deactivated mid-request is refused by the database itself
  (403, nothing written).

## New-order notifications

When a paid order arrives, the owner gets an email (Postmark) and a text
(Twilio), usually within a minute. Nothing is sent until `NOTIFY_ENABLED` is
set to exactly `1`; HANDOVER §3h says how to set it up.

**One event per new order, never two.** The payment webhook records an order
with an upsert on its Stripe session, so a retried delivery updates the same
row. Migration 0005 adds an `AFTER INSERT` trigger on `orders`, which fires
for a genuinely new paid order and never for a retry. It writes one `email`
and one `sms` row, unique per order and channel, into the
`order_notifications` outbox, in the same transaction as the order. If that
insert fails, the order insert fails too: the webhook answers 500 and Stripe
retries, so an order is never recorded with its notification silently lost.
The payment webhook itself is unchanged.

**Sending.** `notify-dispatch` runs every minute (`netlify.toml`) and takes
no input:

- **Claiming.** It claims up to five due rows with
  `claim_order_notifications()`. The rows are leased with
  `FOR UPDATE SKIP LOCKED`, so overlapping runs never claim the same row.
- **Building.** It builds each message from the order at that moment and
  sends it.
- **Recording.** It records the outcome with
  `complete_order_notification()`:
  - **sent:** the provider's message id is kept;
  - **retry:** after 1, 5, 15, 60 and 360 minutes, then failed;
  - **failed:** the provider refused the request.
- **Waiting rules:**
  - An order is given up to five minutes for its line items, which the
    webhook writes just after the order. After that the email says the
    lines were unavailable.
  - A channel that is not fully configured waits rather than being dropped.
  - Anything over a day old is marked skipped. Switching notifications on
    never sends a backlog.

Delivery is at least once. If a run stops after a provider accepted a
message but before the outcome was recorded, that one message is sent again.
The notification id is sent to Postmark as metadata, for tracing.

**What each message says.**

- **SMS.** Exactly `New order TR-1A2B3C4D: $123.45 USD, 3 items.`, prefixed
  `[TEST] ` for a test order. No name, address, email or phone.
- **Email.** It includes:
  - the reference, time placed and order id;
  - the customer's name and the total;
  - each line with quantity and amount;
  - the shipping address, and its country and state;
  - whether research use was confirmed.

  It never includes the customer's email or phone: the claim does not even
  return them. A test order's subject starts `[TEST]` and its body opens with
  a "test order, not a real sale, do not ship" line.
- **Live or test.** An order counts as live only if its Stripe session id
  starts `cs_live_` and the deploy is not a demo. Anything else, including
  anything unrecognised, is labelled a test.

**What is stored and logged.** The outbox holds ids, channel, delivery state,
a short error code and the provider's message id. It holds no message text
and no customer details. Messages are built from the order at send time.

The dispatcher logs a notification id, channel, outcome and error code. It
never logs a message, a provider's answer, a name, address, email, phone or
key. Provider error messages are reduced to their numeric code, because they
quote recipients.

Browser roles have no access to the outbox. The service role (on Neon,
`peptide_app`) can read it and call the two functions, but cannot write it
directly. The dispatcher reaches it through `netlify/lib/db.js`, so it needs
`DATABASE_URL`; without a usable one it logs `not_configured` and sends
nothing.

**Health.** `/.netlify/functions/health` has a `notifications` section. It
shows whether notifications are switched on, and each Postmark and Twilio
setting as `ok`, `missing` or `invalid`. It never shows a value. Its
`database` section says whether `DATABASE_URL` is set and logs in as
`peptide_app` (`ok`, `missing`, `invalid` or `wrong-role`), never the value.

**Testing.**

```bash
node --test tests/notify.test.js        # offline; messages, providers, dispatcher, health
(cd tests/db && npm ci && npm test)     # includes notifications.test.mjs
```

`tests/notify.test.js` covers the following, with Postmark, Twilio and the
database stubbed:

- the switch;
- every setting's checks;
- the exact SMS sentence;
- that the email holds what was agreed and nothing more;
- test labelling;
- the exact provider requests;
- how every provider answer is classified;
- the dispatcher's retries, deferrals and time budget;
- that logs and health never carry personal details or secrets.

`tests/db/notifications.test.mjs` runs migration 0005 in PostgreSQL 16. It
checks that:

- a new paid order queues exactly two rows, and replays of the webhook's
  upsert queue none;
- existing orders are not backfilled;
- an outbox failure fails the order;
- access is as described;
- leases, the line-item wait, stale skipping and the retry schedule behave
  as described;
- the dispatcher works end to end against it.

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
- Touch targets: every control is at least 40px on a coarse pointer. Inline
  links in prose are exempt and are left at their type size.

**The mobile spacing scale steps down at 720px.** The large steps (`--s-7`
through `--s-10`) are sized for a 1240px page; used unchanged on a phone they
cost a third of the viewport before any content appeared. Redefining the tokens
in one media query fixes every section, section head, hero and grid at once,
because they are all expressed in those tokens. The small steps are untouched —
they set the rhythm inside a component and that is right at any width.

**Two layouts lead with text on mobile, not the photograph.** Every vial on the
site is the same photograph with a different label printed on it, so it is the
weakest thing to lead with. Stacked, it put a product's price 1.50 screens down
and the home page's own headline 0.89 screens down. Measured before and after:

| | before | after |
|---|---|---|
| Product name | 1.06 screens | 0.30 |
| Product price | 1.50 | 0.74 |
| Add to cart | 1.77 | 1.01 |
| Catalog, first card | 1.30 | 1.08 |
| Home, hero headline | 0.89 | 0.26 |

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
reappears. It also fails if any page is missing the support assistant, or if
the assistant's knowledge file disagrees with `products.json` or carries a
field left out on purpose; if `assets/data/addons.json` is invalid, enables
an add-on before the payment integration can charge for it, offers anything
the compliance guard refuses, or disagrees with its generated copies; or if
the build is an add-on preview. It exits non-zero, so it can gate a deploy.

The assistant's function has its own suite, `node --test tests/chat.test.js`;
see [Support assistant](#support-assistant).
Add-ons have two, `node --test tests/addons.test.js` and
`python3 -m unittest discover -s tests -p 'test_*.py'`; see [Add-ons](#add-ons).
The migrations have their own, `cd tests/db && npm ci && npm test`; see
[Operations data](#operations-data). The console's authentication has
`node --test tests/admin-auth.test.js`; see
[Operations console: authentication](#operations-console-authentication).
Its read API has `node --test tests/admin-api.test.js tests/admin-read.test.js`;
see [Operations console: read API](#operations-console-read-api). Its write
API has `node --test tests/admin-write.test.js`; see
[Operations console: write API](#operations-console-write-api).
New-order notifications have `node --test tests/notify.test.js`; see
[New-order notifications](#new-order-notifications).

Audited with axe-core (WCAG 2.1 A/AA) across fifteen representative pages plus
the open cart drawer in its error state: **0 violations**.

Contrast is measured on rendered pixels, not read off the stylesheet: 712
control states across two viewports, every `.btn`, `.filter-btn`,
`.link-action`, `.chip` and `select` at rest, on hover, and — for the filters —
in their selected state. That sweep used to cover `.btn` at 1440px only, which
is why it did not see the selected filter chip render as near-black text on a
near-black fill the first time that state was written.

Browser tests (Playwright, Chromium) cover the entry affirmation (what it
blocks, what it remembers, and all three fail-open paths), volume pricing and
free shipping end to end, catalog filtering,
CAS search, sorting, out-of-stock state, pack-size to price and label sync, cart
persistence, the `"cart": false` refusal, the checkout consent gate, the
redirect to Stripe, what the browser actually posts, cart clearing after
payment, checkout failure handling, demo mode, form validation and submission,
the accordion and mobile nav.

The checkout function has its own suite: the amount charged comes from the
server-side table and not from the request, every volume tier is checked at its
own boundary, a discount sent by the browser is ignored, free shipping is
measured on what is actually charged, every pack size of the multi-size
compound prices independently, and every refusal path — a compound marked
non-buyable, unknown id or size, bad quantity, duplicate lines, missing consent,
oversized body, wrong method, missing key, Stripe errors — is asserted. Stripe
itself is stubbed; see HANDOVER §3c for the live test that is still owed.

---

## Browser support

Evergreen Chrome, Firefox, Safari and Edge. The layout uses CSS grid and custom
properties; `backdrop-filter` and `mix-blend-mode` degrade gracefully.
