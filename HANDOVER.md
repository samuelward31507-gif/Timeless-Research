# Handover

Everything the new operator needs to take this site live, in the order it needs
doing. `README.md` covers how the site is built; this covers what only you, as
the operator, can decide or supply.

Nothing here is legal advice. Several items below are business and compliance
decisions with real consequences, and they are flagged as such rather than
buried.

---

## 1. Things that must be set before the site can deploy

`tools/check.py` **fails the build** while any of these is missing, so the site
cannot go live half-configured. Set them in `[build.environment]` in
`netlify.toml`.

| Variable | What it is | Where it shows |
|---|---|---|
| `TR_LEGAL_ADDRESS` | Your business address | Terms §1, privacy policy §1 |
| `TR_LEGAL_STATE` | The US state whose law governs your sales | Terms §16 |
| `TR_SITE` | Your live domain | Canonical tags, Open Graph, sitemap, checkout return URLs |
| `TR_CONTACT_EMAIL` | Where enquiries should reach you | Contact page, form fallback |

One more is required before anyone can pay you, and is **not** set in
`netlify.toml` because that file is in the repository and a live key in version
control is a live key on the internet:

| Variable | What it is | Where to set it |
|---|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe secret key | Netlify → Site configuration → Environment variables |

Without it the checkout button tells the customer that checkout is
temporarily unavailable and logs the reason to the function log, rather than
failing silently. Three more tune checkout and have working defaults:
`TR_SHIP_STANDARD_CENTS` and `TR_SHIP_EXPRESS_CENTS` (the two shipping rates
offered, **placeholders — set them to what your courier actually costs**),
`TR_SHIP_COUNTRIES` (comma-separated ISO codes; empty uses the list in the
function) and `TR_STRIPE_TAX` (`1` once Stripe Tax is configured).

Two more are optional because they have sensible defaults:
`TR_LEGAL_ENTITY` (defaults to "Timeless Research") and `TR_LEGAL_EMAIL`
(defaults to `TR_CONTACT_EMAIL`).

These have to be real. An invented address or registration number would make
the legal documents false, which is worse than not publishing them.

---

## 2. Deployment

The site is configured for Netlify and needs no build server of your own.

1. Netlify → **Add new site → Import an existing project** → pick this
   repository. Every setting comes from `netlify.toml`; leave the build fields
   alone.
2. **Domain management** → attach your domain. Netlify issues the certificate.
3. Set the variables in section 1 and push.
4. **Forms → enquiry** → turn on the notification email. Without this,
   enquiries collect silently in the Netlify dashboard and nobody is told.
5. **Environment variables → `STRIPE_SECRET_KEY`** → paste your Stripe secret
   key, then redeploy. Test it with a Stripe test key first (see §3c).

Moving to another host instead: set `TR_FORM_PROVIDER=endpoint` and
`TR_FORM_ENDPOINT` to a handler of your own, and serve the `dist/` directory
produced by `python3 tools/build.py && python3 tools/dist.py`. **Checkout will
not come with you.** `netlify/functions/create-checkout-session.js` is written
against Netlify Functions; the logic is 200 lines of plain Node with no
dependencies, so it ports to any serverless runtime, but it is a port, not a
copy.

---

## 2b. Showing the site before it has a business behind it

Building with `TR_DEMO=1` produces a demonstration copy: a black bar on every
page stating that the site is not trading and that no enquiry reaches a
supplier, `noindex,nofollow` on every page, and a `robots.txt` that disallows
everything. The unfilled legal fields in section 1 become a warning instead of
a build failure, so a demo deploys without inventing details.

Checkout still works on a demo build, against Stripe's **test** mode, so the
thing the site is a demonstration *of* can actually be demonstrated. The cart
says so and gives the test card to use. This needs a test key
(`sk_test_...`) in `STRIPE_SECRET_KEY`.

⚠️ The checkout function **refuses to run a demo build against a live key**, and
logs why. A site that tells every visitor it is not trading must not be able to
take real money from one of them. The four combinations are covered by a test:
demo+live is refused before Stripe is contacted at all; demo+test, live+live and
live+test all proceed.

This matters for a live demo. A peptide storefront that looks open for business
will be found by people trying to place real orders, and a demo left in the
search index competes with the eventual live site. Set `TR_DEMO = "0"` in
`netlify.toml`, or remove the line, when the site goes into service.

---

## 2c. If the form does not reach you

The form's own markup and JavaScript are verified: the correct `form-name`,
`data-netlify`, a honeypot, every field named, and the POST going to the site
root, which is the one path Netlify always accepts. So when nothing arrives,
the cause is almost always configuration rather than code. In order of
likelihood:

1. **Form detection is off.** Netlify does not enable it for new sites by
   default. Site configuration → Forms → Form detection → **Enable**, then
   **redeploy** — detection happens at deploy time, so enabling it alone does
   nothing until the next build.
2. **No notification is configured.** Submissions land in Forms →
   enquiry in the dashboard and nobody is told. Add an email notification
   there.
3. **The mailbox does not exist.** `TR_CONTACT_EMAIL` is
   `accounts@timelessresearch.com`; if that address is not real and receiving,
   the notification bounces and the manual fallback on the page sends people
   into a void.
4. **Checking the wrong deploy.** Forms are registered per deploy. A submission
   tested against an old deploy preview will not appear under the production
   site.

To confirm which: submit the form and open the browser console. A POST to `/`
returning 200 means Netlify accepted it and the problem is notification or
mailbox. A 404 means form detection is off. If the POST fails entirely, the
page shows the enquiry with a copy button, so the lead is not lost either way.

---

## 3. Claims you are taking on

The site states these as fact. They have not been verified against any supply
chain — this site was built as a product, not operated. Either arrange the
evidence or change the copy before you take an order.

- **"COA issued with every lot."** On every page, with a six-stage release
  process described in detail on `quality.html`. If you cannot produce a
  lot-specific certificate when a customer asks, this has to come down.
- **Purity.** Of the 27 compounds, 24 carry `≥98%`, one carries `≥95%` and two
  are specified `USP grade` (the waters), surfaced across cards, vial labels
  and specification tables. Source values are in `assets/data/products.json`.
- **Storage and handling.** Cold chain, −20 °C storage and the packing
  described in `legal/shipping.html` are commitments to your customers.

These are commercial claims. In the US they are the kind of thing the FTC
expects a seller to be able to substantiate.

---

## 3b. Prices

List prices live in `assets/data/products.json`, one per pack size, under
`prices`, with `currency` at the top of the file. Change a number there and
rebuild — the catalogue card, the product page, the pack-size dropdown, the
cart and the checkout function all read from that one place.

`tools/check.py` fails if a listed pack size has no price, so a size cannot be
offered without one. It also checks that the price rendered on each product page
matches one of the offers in that page's structured data — a page saying $26
while the machine-readable product says something else is the kind of fault
nobody notices until a search engine acts on it.

## 3b-i. Volume pricing and free shipping

Both live in `assets/data/products.json`, next to `currency`, and both flow from
there into the cart, the product pages and the checkout function on every build:

```json
"volumeTiers": [ { "minQty": 10, "percent": 10 }, { "minQty": 25, "percent": 15 } ],
"freeShippingOver": 250
```

⚠️ **Those numbers are placeholders and they come straight off your margin.**
They were set conservatively because guessing high with someone else's money is
worse than guessing low. Work out what you can actually afford per compound
before a real order lands. Amino Club runs 40% at ten units and 50% at fifty;
whether that is sustainable depends on a cost base neither of us can see from
here.

Tiers apply **per cart line** — one compound at one pack size — not across the
order, because that is the version the customer can check themselves in the
cart and the version the function can verify without trusting a total the
browser worked out. The highest tier a line qualifies for wins. Free shipping
is measured on the goods subtotal **after** discount, so a discount can take an
order back under the threshold; that is deliberate and tested.

`tools/check.py` refuses a discount outside 0–100%, two tiers at the same
quantity, and tiers where a larger order would get a smaller discount. Set
`"volumeTiers": []` to turn the whole thing off, or `"freeShippingOver": 0` for
just the shipping side.

---

## 3b-ii. Certificates of analysis

`coa.html` lists every compound with a link to request the certificate for the
lot currently in stock. It publishes no lot numbers, deliberately: the ones on
the vial illustrations are generated from a hash of the product id so the
artwork looks right, and presenting those as real lots would turn a label
mock-up into a false document.

**To publish a real certificate**, drop the PDF at
`assets/coa/<product-id>.pdf` — for example `assets/coa/bpc-157.pdf` — and
rebuild. That row changes from "Request" to "Download PDF" on its own. There is
no list to maintain; the file existing is the whole switch. The page's warning
notice disappears once at least one certificate is published.

---

**Marking something out of stock** is a data edit: add `"available": false` to
that product in `products.json`. The catalogue card gains an Unavailable badge
and loses its add control, the product page swaps the cart button for a contact
link and disables the pack-size selector, the structured data reports
`OutOfStock`, and the checkout function refuses the id even if someone still
has it in a cart from before. Remove the line to put it back.

Prices are shown excluding shipping and tax, and the cart's subtotal says so.
Shipping is chosen at checkout from the two rates in §1 and tax, if you enable
Stripe Tax, is calculated there — so the cart subtotal and the amount charged
differ by exactly those two things and nothing else.

**The price the customer is charged is never the one their browser holds.** The
cart posts ids, pack sizes and quantities; the checkout function prices them
from `netlify/functions/catalog.json`, which `tools/build.py` regenerates from
`products.json` on every deploy. `tools/check.py` fails the build if those two
files disagree on any price, any currency, or on which compounds are buyable.

---

## 3c. Taking payment

The catalogue is bought from the page and paid for by card at a Stripe-hosted
checkout. `pay.html` explains the sequence to the buyer, and the terms of sale
§2 describe it as it actually works: the order is the customer's offer, and the
contract forms when you confirm or despatch. That wording is what lets you
cancel and refund an order you do not want to fill, which is the only
enforcement the research-use condition has.

**The whole catalogue is in the cart, including the three restricted standards.**
Retatrutide, tirzepatide and oxytocin carry `"restricted": true` in
`products.json`, which puts a notice on their specification pages saying what
they are — an approved or investigational pharmaceutical substance supplied as
an analytical reference standard. That flag describes the material. It does not
change how the compound is bought.

**If you need to pull one SKU out of the cart**, that is a separate flag:
`"cart": false` on the product in `products.json`. It keeps the compound listed
and priced but replaces its add control with an Enquire button that lands on the
contact form with the compound preselected, and the checkout function refuses
the id outright. Nothing carries it today. Reach for it if a payment processor
objects to a specific compound, or if you decide you want an order in front of a
person before it ships — it is one line and a rebuild, and `tools/check.py`
fails if any page still offers to cart something marked that way.

### How the checkout works

```
browser                     Netlify Function                Stripe
  cart (ids, sizes, qty) ──▶ price from catalog.json ──────▶ create session
  redirect to Stripe   ◀──── session url ◀──────────────────
  pay on stripe.com ─────────────────────────────────────▶
  /order-received.html ◀──── success_url
```

The whole backend is `netlify/functions/create-checkout-session.js`, about 200
lines of plain Node with no npm dependency. It refuses anything that is not a
POST, an unconfirmed research-use flag, an unknown id or pack size, a restricted
compound, a non-integer or out-of-range quantity, duplicate cart lines, more
than 20 lines, or a body over 20 KB. It never passes a Stripe error message
back to the customer — those go to the function log, because they name account
problems the customer cannot act on.

### Test it before you take a real order

1. Put a **test** key (`sk_test_…`) in `STRIPE_SECRET_KEY` and deploy.
2. Buy something with Stripe's test card `4242 4242 4242 4242`, any future
   expiry, any CVC.
3. Check: the amount matches the catalogue plus the shipping rate you chose;
   Stripe collected a name, email, phone number and shipping address; you got
   the order in the Stripe dashboard; `/order-received.html` loaded and the
   cart emptied.
4. Then swap in the live key. **Do not skip step 3** — the shipping rates in
   `netlify.toml` are placeholders, and a live key will happily charge them.

### Before you build on this: Stripe may not accept you

Stripe's restricted-business rules cover pharmaceuticals, "nutraceuticals" and
products making unsubstantiated health claims, and research-chemical sellers are
declined or shut down under them regularly — often after processing has begun,
with a hold on the balance. **A card checkout makes this risk larger, not
smaller**, because the volume runs through Stripe rather than through invoices
you raise by hand. Find out before you depend on it:

1. Apply describing the business accurately: analytical reference material sold
   for laboratory research use only. Do not omit the GLP-1 analogues from that
   description — an account approved on an incomplete picture is an account that
   gets frozen later, with the balance held, which is worse than being declined
   up front.
2. Say plainly that you do not sell for human consumption, and that research use
   is a condition of sale confirmed at checkout and written into the terms. The
   site, its research use policy and the checkout confirmation are your
   evidence.
3. Get the answer in writing before taking a first order. If Stripe declines,
   the alternatives for this sector are bank transfer on invoice, or a
   high-risk merchant acquirer at a considerably worse rate.

If you have to leave Stripe, the function is the only thing that changes: every
other page describes "a card payment on a hosted checkout" without naming a
processor, except `pay.html` and the privacy policy §4, which name Stripe
because they have to.

### Fulfilment, once an order lands

1. **Read the order before you release it.** Stripe gives you the name, email,
   phone and shipping address. An order that reads as personal rather than
   professional is the moment the research-use condition is worth something:
   cancel and refund it. Doing that costs you one sale. Not doing it is what
   turns "research use only" into decoration.
2. **Confirm by email**, from the address on `pay.html`. That confirmation is
   what forms the contract under the terms, and it is when the order becomes
   one you have to fill.
3. **Ship with the certificate of analysis** for the lot supplied, and record
   which lot went to which order. That link is the whole point of §3.
4. **Refunds** go back through Stripe against the original payment. Never
   refund to a different card or account than the one that paid.

### Things not to do

Never take card details by telephone or email and key them in yourself: it
defeats the fraud protection, and it contradicts what `pay.html` promises
customers. Never email a payment link on a domain that is not `stripe.com` —
`pay.html` tells buyers to distrust exactly that, which only protects them if
you keep to it. Never put the Stripe secret key in `netlify.toml`, a commit, or
anything else that lands in the repository.

---

## 4. Decisions only you can make

**The three restricted compounds.** Retatrutide, tirzepatide and oxytocin are
flagged `"restricted": true` in `assets/data/products.json` and sold through the
cart like everything else. That was an explicit decision by the operator, taken
on the basis that competing vendors sell them the same way, and it is recorded
here so it is not mistaken for an oversight.

They carry by far the highest exposure in the catalog, and the cart does not
change most of it:

- **Patents.** Retatrutide and tirzepatide are Eli Lilly compounds under active
  patent, and Lilly has litigated against sellers. This exposure comes from
  listing them at all, not from how they are paid for.
- **FDA.** Tirzepatide is an approved drug (Mounjaro, Zepbound) and oxytocin is
  prescription-only. Research-use-only framing over a compound with an approved
  counterpart is exactly the shape of the warning letters FDA has sent
  research-peptide vendors. Again: listing, not checkout.
- **Your payment processor.** This one *is* worse with a cart. Card volume on
  GLP-1 analogues is among the most common reasons these accounts get frozen,
  and Stripe holds the balance while it reviews. Before the cart, that volume
  would have arrived as invoices you raised by hand. Now it runs on card rails
  on your highest-value SKU.

Removing them is three lines in the JSON and a rebuild. Taking just those three
out of the cart while keeping them listed is `"cart": false` on each, which is
the lever described in §3c. Both are config changes; the judgement is not.

**The entry affirmation is not an age check.** A visitor's first view of the
site is an overlay asking them to confirm they are 21 or over and that the
material is for in vitro research. It is the convention in this sector, and it
is worth having: it puts the condition in front of the catalogue rather than
only at checkout, and it is a second documented touchpoint if a processor or a
regulator asks what you do.

Be clear with yourself about what it is. Anyone can tick two boxes; the gate
stops nobody who means to proceed, and it is deliberately captioned so as not
to imply otherwise — it says on its face that these are statements the visitor
makes and not checks you perform. It also fails open by design: no JavaScript,
or blocked browser storage, means no gate and a fully readable site, because
hiding the catalogue from those visitors would cost you real readers and
inconvenience nobody. If you ever need it to be a real control, it cannot be
one on the client side at all.

**Research use is a condition, not a check — and the site says so.** With a card
checkout there is no vetting step, and every page has been written to stop
short of claiming one. `compliance.html` §3 says in as many words that this is a
contractual condition and not an identity check, and that we do not operate a
credentialing process. `tools/check.py` fails the build if the retired
"verified account" wording reappears anywhere.

That honesty is load-bearing, and it puts the whole weight on what you actually
do with an order once it arrives. Read §3c, "Fulfilment". An operator who ships
everything that pays has a research-use policy that is decorative and will not
protect them. An operator who cancels and refunds the orders that read wrong has
one that means something. Nothing in this repository can make that choice for
you; it is the single most consequential habit you take on with this site.

**What was looked at and not copied.** A competitor's homepage was reviewed
during this build. Four things on it were deliberately left alone, and the
reasoning is here so the decisions are not silently reversed later:

- **Renaming the GLP-1 analogues.** They list retatrutide, tirzepatide and
  semaglutide as "GLP-3 (RT)", "GLP-2 (TR)" and "GLP-1 (SM)". The parenthetical
  initials are the tell. Obscuring what a compound is, on a site whose entire
  argument is that the material is what the label says, cuts against the
  premise — and a processor or regulator who works out the substitution finds a
  seller who was hiding the name, which is a worse position than never having
  hidden it.
- **Nasal and dermal sprays.** They sell GHK-Cu, NAD+, Semax and PT-141 as
  metered sprays. A lyophilised powder in a sealed vial is a research
  presentation; a metered spray is a delivery device for putting a substance
  into a person. Selling one while saying "not for administration to humans" is
  a contradiction on the face of the product.
- **Countdown timers.** A "Fall Sale" counting down fifteen days, and a daily
  list that "resets at 3:00 AM". If the deadline is not real, that is the
  fake-urgency pattern the FTC has brought cases over. It can be built
  honestly — a real end date, enforced — but it has to actually end.
- **"Club Tab", their pay-in-four scheme.** They extend up to $1,500 of their
  own credit at no interest. In the US, lending your own money to consumers is
  a regulated activity: state lending or credit-service licensing, TILA and
  Regulation Z disclosure duties, and CFPB interest in buy-now-pay-later
  generally. If you want instalments, use a provider who holds the licences —
  Stripe supports Klarna, Affirm and Afterpay on Checkout — rather than
  becoming the lender yourself.

Their affiliate programme, points-with-bonus scheme and subscription box are
ordinary commerce features rather than problems; none is built here, and each
is a fair-sized piece of work if you want one.

**Legal review.** `legal/terms.html`, `legal/privacy.html` and
`legal/shipping.html` were written for a US sole proprietorship selling
research reagents. They are careful drafts built on standard commercial
practice; they have **not** been reviewed by a lawyer. If you incorporate or
operate from a different state, they need revisiting.

⚠️ They also need revisiting *because of the cart*. An open checkout means
anyone can buy, and a buyer who is not a business may be a consumer in law —
which brings in consumer-protection rules a business-to-business contract does
not contemplate: distance-selling cancellation rights in the UK and EU, state
consumer statutes in the US, and limits on how far a warranty disclaimer and a
liability cap can be enforced against a consumer at all. The terms were drafted
before this site had a checkout. Getting them read by a lawyer was already
sensible; with a card checkout it is the first thing to spend money on. The clauses doing the most work are the warranty disclaimer
(terms §8) and the limitation of liability (terms §9).

⚠️ Those two clauses are set in capitals inside a `.legal-strong` block on
purpose. UCC 2-316 requires a disclaimer of the implied warranties of
merchantability and fitness to be *conspicuous*, and a limitation of liability
is read the same way. Restyling them into sentence case is not a cosmetic
change — it can cost you the protection.

---

## 5. Worth doing early

- **Analytics** is deliberately absent. Adding a tag is a cookie-consent
  question in the EU and UK and a disclosure question under CCPA, and the
  privacy policy currently states that no analytics cookies are set. Update
  section 2 and 4 of the policy if you add one. `TR_ANALYTICS_HEAD` injects
  the tag.
- **Fonts are self-hosted**, so a page load contacts no third party at all.
  Regenerate them with `tools/fetch_fonts.py` then `tools/subset_fonts.py` if
  you change the type stack — and if you do, update privacy policy §4, which
  currently states that nothing but your host is contacted.
- **Email deliverability.** Netlify sends the form notifications, so no DNS work
  is needed. If you move to your own handler, set SPF and DKIM or the
  notifications will land in spam.
- **The product photograph.** `vial.png` is the source image every vial on the
  site is derived from, via `tools/make_vial.py`. Labels are printed in CSS over
  the photograph, so changing a product name or dose does not require new
  photography.

---

## 5b. What has not been tested

Stated plainly so you are not surprised, and so a buyer is not misled.

- **Only Chromium.** Every automated check was run in Chromium. The site uses
  no exotic CSS and its JavaScript is deliberately ES5 — no arrow functions, no
  optional chaining, a clipboard fallback — so it should behave, and every
  vendor-prefixed property is paired. But the vial label is printed over the
  photograph with `mix-blend-mode: multiply`, and blend modes are the one thing
  that can differ between engines. Open the home page in Safari and on an
  iPhone before you rely on it; if the labels look washed out or too dark,
  that rule is the cause.
- **No screen-reader pass.** Every page is clean under axe-core, including the
  cart drawer with its error state showing, and that catches perhaps a third of
  real accessibility problems. Nobody has driven the site with VoiceOver or
  NVDA, or completed an order flow using only a keyboard.
- **No real Stripe call.** The checkout function is covered by 64 unit tests and
  the browser flow by 39 more, but Stripe itself is stubbed in both: what is
  proven is what the function refuses, and the exact parameters it sends. No
  payment has been taken, no session has been created against Stripe's real API,
  and no order has arrived in a Stripe dashboard. The test in §3c is not
  optional, and the shipping rates it makes you check are placeholders.
- **No real-device testing.** Layouts were verified by emulating widths from
  360 px up, not on physical hardware.

---

## 6. Checking your work

```bash
python3 tools/build.py      # regenerate every page
python3 tools/check.py      # links, metadata, labels, unfilled legal details
```

`check.py` exits non-zero on failure, so it can gate a deploy. It verifies that
internal links resolve, that every page has its title, description, canonical
and landmarks, that images carry alt text and form controls carry labels, and
that no legal document still contains an unfilled field.
