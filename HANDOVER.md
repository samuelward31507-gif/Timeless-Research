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

One more is optional, and also goes in Netlify's environment variables rather
than `netlify.toml`: `ANTHROPIC_API_KEY` switches on the order and product help
assistant. **Before you add it, set a monthly spend limit for that key in the
Claude Console** (see §3d). Without it the assistant tells visitors it is
unavailable and points them to the contact page.

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

### Putting a demo online, in about ten minutes

Free, and nothing here touches a live key or a real domain.

1. **Netlify → Add new site → Import an existing project**, pick this
   repository. Leave every build field alone; `netlify.toml` has them.
2. **Stripe → Developers → API keys → reveal the *test* secret key**
   (`sk_test_...`). It sits behind the Test mode toggle, so no Stripe account
   review is needed to get one.
3. **Site configuration → Environment variables → add `STRIPE_SECRET_KEY`**
   with that test key. Then **Deploys → Trigger deploy**, because a variable
   added after the first build does not apply until the next one.

   **To check you got it right, open `/.netlify/functions/health` on the
   deploy.** It says in plain words whether the key is set, whether it is the
   right kind of key, whether a stray space got pasted with it, and what to do
   next. It never shows the key itself. Setting a variable is the one step in
   this that otherwise gives no feedback at all until a purchase fails.
4. That is it. The deploy gets a `something.netlify.app` address and the site
   figures out it lives there: canonical tags, the sitemap, the link-preview
   image and Stripe's return URL all follow the real address rather than the
   placeholder domain in `netlify.toml`. Sending the link by text gives a
   proper preview card.
5. **Try it before you show anyone.** Add something to the cart, tick the
   research-use box, pay with `4242 4242 4242 4242`, any future expiry, any
   CVC. You should land back on the order page with the cart emptied, and see
   the payment in your Stripe dashboard under Test mode.

`TR_LEGAL_ADDRESS` and `TR_LEGAL_STATE` can stay empty for a demo — the pages
show a visible fill-in marker instead of a blank, and the demo bar already says
the site is not trading.

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

The whole checkout backend is `netlify/functions/create-checkout-session.js`, about 200
lines of plain Node with no npm dependency. It refuses anything that is not a
POST, an unconfirmed research-use flag, an unknown id or pack size, a restricted
compound, a non-integer or out-of-range quantity, duplicate cart lines, more
than 20 lines, or a body over 20 KB. It never passes a Stripe error message
back to the customer — those go to the function log, because they name account
problems the customer cannot act on.

### Recording orders

Payment works without this; **order records do not.** Until the webhook is
wired, a completed order exists only in the Stripe dashboard — no order history,
no customer list, nothing to build a status page or a review request on, and
nothing you own if you ever change processor.

1. **Create the database.** Apply `supabase/migrations/0001_orders.sql` to a
   Supabase project — SQL editor, CLI, or the MCP tools. It is written to be
   safe to run twice.
2. **Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`** in Netlify. The
   *service role* key, not the anon key. It is the only key that can read these
   tables, and it must never appear anywhere a browser can reach.
3. **Stripe → Developers → Webhooks → Add endpoint**, pointed at
   `https://your-site/.netlify/functions/stripe-webhook`, subscribed to
   **`checkout.session.completed`**.
4. **Copy the signing secret** Stripe shows you (`whsec_...`) into
   `STRIPE_WEBHOOK_SECRET`, and redeploy.
5. **Test it.** Place a test order. Stripe's webhook page shows the delivery and
   the response; the `orders` table should gain one row and `order_items` the
   lines. Use Stripe's "Resend" button — the row must update, not duplicate.

⚠️ **The signing secret is not optional.** That URL is public and it writes to
your database. Without the secret the function refuses every request, which is
the safe failure; with the wrong one, the same. What it never does is accept an
unsigned request, because anyone who found the URL could then post invented
orders — fake addresses to ship to, fake revenue in your records.

**Row level security is on with no policies**, deliberately. These rows are
names, emails, phone numbers and home addresses of people buying research
chemicals. A readable orders table is the worst leak this site could have.
Anything that needs to read an order — a status page, an admin view — goes
through a function that checks who is asking first. Do not add a policy that
grants `anon` read access to make something work.

---

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

## 3d. The support assistant

Every page has a "Questions?" button that opens an assistant answering from
the site's own data: products, specifications, CAS numbers, COA availability,
prices and volume tiers, shipping, returns, payment and how ordering works. It
refuses anything touching dosing, preparation, administration, cycling,
stacking, human or animal use, or health and performance claims, and points to
the research use policy. How it does that is in README, *Support assistant*.

### Switching it on

1. **Set a monthly spend limit first.** In the Claude Console
   (console.anthropic.com), create a workspace for this site alone, set a
   monthly spend limit on that workspace, and create the site's API key inside
   it. The limit then applies to everything that key can spend, and to nothing
   else you run. The function's rate limit is per Netlify instance and is not
   a cost control: a determined client can get past it, and the spend limit is
   the only hard ceiling on what the assistant can cost you.
2. Add the key as `ANTHROPIC_API_KEY` under **Site configuration →
   Environment variables**, then **Deploys → Trigger deploy**.
3. Open `/.netlify/functions/health`. `support_assistant.working` should be
   `true`.
4. **Run the live refusal check before you announce it** (below).

### Before launch: the live refusal check

```bash
ANTHROPIC_API_KEY=sk-ant-... node tests/chat_live.mjs report.json
```

It sends 30 direct and 18 indirect forbidden questions (fiction, "purely
academically", lab rats, translations, persona swaps, two conversations that
turn after a harmless opener) straight to the model, skipping the pattern
screen, plus 25 ordinary questions, and has a second model grade every reply.
It also prints response times.

- **If any indirect question leaks,** change `MODEL` in
  `netlify/functions/chat.js` to `claude-opus-5-5`, redeploy, and run it
  again. That is the agreed fallback; it costs about twice as much per
  question.
- **If an ordinary question is refused,** read the reply in `report.json`. A
  refusal there is usually a rule in the system prompt worded too broadly.
- **If replies take longer than 9 seconds,** the function gives up and shows
  "try again". Netlify stops a synchronous function at 10 seconds; lower
  `MAX_TOKENS`, or ask Netlify support to raise the limit.

This check has not yet been run against the real model. It needs a key, and
none was available when the assistant was built.

### Running it

- **The function log** (Netlify → Logs → Functions → chat) records one line
  per question: the outcome (`answered`, `refused_precheck`, `refused_model`,
  `refused_reply_screen`, `rate_limited`, `timeout`, `api_error`), the time
  taken and the token counts. It never records what was asked or answered, or
  who asked. Many `refused_reply_screen` lines mean the model is producing
  figures the rules forbid; run the live check.
- **The privacy policy** now names Anthropic as the assistant's provider, in §2
  and §4. Read that wording as you would any other part of the policy: it is
  your statement, not ours.
- **Changing what it knows** is a content edit: it is rebuilt from
  `products.json` and the pages on every deploy. **Changing what it may say**
  is the `RULES` text and the patterns in `netlify/functions/chat.js`; run
  `node --test tests/chat.test.js` and the live check after any change.

### Things not to do

Do not add `solubility`, the `research` blurbs or any preparation detail to
what the assistant is given; `check.py` fails the build if the first two
appear. Do not log message content to debug it. Do not put the key in
`netlify.toml`. Do not let it take orders: it links the product page, and the
cart and Stripe do the rest.

## 3e. Optional add-ons

The cart can offer shipping, documentation and packaging add-ons on each line
(an insulated shipper, a certified copy of the certificate of analysis, a
moisture-barrier pouch). How it works is in README, *Add-ons*. **It is built
but switched off,** and stays off until two things are done:

1. **The payment integration charges for add-ons.** It does not yet. Until it
   does, `PAYMENT_INTEGRATION_READY` in `tools/addons.py` is `False`, the
   cart shows no add-ons, and the build fails if one is enabled. That is on
   purpose: an add-on the customer ticks and checkout ignores is either a
   service you give away or one you fail to provide.
2. **You define real add-ons.** The three in `assets/data/addons.json` are
   examples, disabled, with no price. Replace them with services you actually
   provide, at prices you have set, and only then set `"enabled": true`.

### Defining add-ons

- Only shipping, documentation or packaging services. The build refuses
  anything that prepares, measures or administers material (diluents, water,
  syringes, needles, swabs), and any wording about dosing, cycles or effects.
  Do not try to word around it: an add-on that pairs a diluent or a syringe
  with a peptide is exactly what a processor or regulator reads as intent.
- A paid service is a promise. If you sell "an insulated shipper" or
  "signature on delivery", your terms of sale should say what it covers and
  what happens if it fails. That wording is yours to add.
- Rules decide where each add-on is offered: by product, by category, or on
  everything buyable.

### Stock

Stock-tracked add-ons are counted in Supabase. Apply
`supabase/migrations/0002_addons.sql` after `0001`. Then, in the SQL editor:

```sql
-- receive stock
insert into addon_stock_movements (addon_id, delta, reason, note)
values ('insulated-shipper', 200, 'restock', 'PO 1182');

-- current levels
select * from addon_stock_levels;
```

Sales come off automatically when an order is recorded, and go back when you
mark the order `cancelled` or `refunded`. Do not delete an order whose add-ons
moved stock (the database refuses); cancel or refund it. Stock is not held
while a customer pays, so the last unit can sell twice; that shows as a
negative level, and you decide whether to source one more or refund it.

If Supabase is not configured, stock-tracked add-ons are not offered at all.

### Reports

```sql
select * from addon_revenue order by month desc;      -- units and revenue
select * from addon_attach_rate;                      -- offered vs taken
```

Both count paid and shipped orders. Neither involves tracking visitors: what
was offered is recorded with the order, by the server.

### Before switching it on: the payment integration

The integration has to: accept the add-on ids the cart sends per line; call
`priceAddons()` from `netlify/lib/addons.js` with stock from
`addon_stock_levels`; charge each returned line as its own line item; keep the
free-shipping calculation on products only; on confirmed payment, write the
rows from `orderItemRows()` and call `record_addon_sales(order_id)`. Then set
`PAYMENT_INTEGRATION_READY = True` in the same change. Today that means the
checkout function (`netlify/functions/create-checkout-session.js`), the
order-recording webhook (`netlify/functions/stripe-webhook.js`) and the
checkout handler in `assets/js/site.js`, or whatever replaces them if the
site moves to another processor.

## 3f. Operations data (orders, stock, lots, expenses)

Apply `supabase/migrations/0003_operations_foundation.sql` after `0001` and
`0002`. It keeps every existing order as it is and gives each one a first
history entry. There are no screens for any of this yet; until the operations
console exists, use the Supabase SQL editor. README, *Operations data*,
explains the design.

### Moving an order along

```sql
select set_order_status('<order id>', 'processing', 'picking today', 'Sam');
-- then 'packed', 'shipped', 'delivered', 'completed'; or 'cancelled', 'refunded'
select * from order_status_history where order_id = '<order id>';
```

A move the business does not make (shipped back to packed, delivered to
cancelled) is refused with a message. An order cannot be put back to `paid`.

### Receiving stock and packing from a lot

```sql
-- once per product and pack size you stock
insert into inventory_items (product_id, pack_size, low_stock_threshold)
values ('bpc-157', '10 mg', 10);

-- each delivery is a lot: use the supplier's real lot number and the COA's location
insert into lots (product_id, pack_size, lot_number, quantity_received, retest_date, coa_reference, unit_cost_cents)
values ('bpc-157', '10 mg', '<lot number>', 100, '<retest date or null>', '<COA file or link>', <cost per unit in cents>);

-- packing an order: draw its line from a lot (twice, from two lots, to split it)
select allocate_order_line('<order id>', 'bpc-157', '10 mg', '<lot id>', 4);

select * from inventory_levels;   -- on hand, sold but not yet allocated, available
select * from low_stock;
select * from lot_levels;         -- per lot, with retest flags
```

Correct a count, write off a damaged vial, or book a returned parcel with
`record_stock_movement('<lot id>', <+/- units>, 'adjustment' | 'write_off' | 'return', '<why>')`.
Nothing in the stock ledger can be edited or deleted; a mistake is corrected
by another movement. **Allocation needs the order's lines to name their
product and pack size**, which the current payment integration does not
record (it writes a description only). That is completed with the payment
integration; until then, allocation works for orders entered with that detail.

### Expenses

Add rows to `expenses`, or import a CSV: load it into `expense_import` with
columns `incurred_on` (YYYY-MM-DD), `category` (code or name), `description`,
`amount`, and optionally `currency`, `vendor`, `reference`, `notes`; then run
`select * from import_expenses();`. Bad rows stay in `expense_import` with the
reason; importing the same file again does not double-count. The ten starting
categories are generic: rename or add your own in `expense_categories`.

### Reports

```sql
select * from monthly_financial_summary order by month desc;
select * from monthly_gross_margin;       -- over orders whose cost is fully known
select * from customer_summary;           -- customers, repeat rate, average lifetime revenue
select * from customer_aggregates order by lifetime_revenue_cents desc;
```

Read the limits before relying on the numbers: order totals still include tax
and are before processor fees, a refund removes the whole order, and margin
covers only orders allocated to lots with a known unit cost. All three improve
when the payment processor is chosen and integrated.

## 3g. Operations console sign-in (not switched on yet)

The console will be signed into with Supabase Auth: the same Supabase project
that records orders, no other sign-in provider. What exists so far is the
server-side check every console endpoint will run,
`netlify/lib/admin-auth.js` (README, *Operations console: authentication*).
There is no sign-in page and no console endpoint yet, so nothing here is
reachable, and nothing has been applied to any Supabase project.

The rules it enforces, in short:

- **Invite-only, owner-only.** Only an active `staff_members` row with the
  `owner` role gets in. A Supabase user who is not in that table gets nothing.
- **MFA is mandatory.** A signed-in user who has not passed a second factor is
  refused on every request, whatever the dashboard allows.
- **The server decides who is acting.** The staff member recorded against a
  change comes from the verified sign-in, looked up in `staff_members` on every
  request. Nothing a browser sends can name someone else. Deactivating a staff
  member locks them out on their next request.
- **The service role key never leaves the server**, and browsers still have no
  access to the database at all: no row level security policies were added.

### Configuring the Supabase project (staging first, then production)

None of this is code; it is set in the Supabase dashboard. Do it on the
staging project first and run the checks below before touching production.

1. **Authentication > Sign In / Providers:** turn **off** "Allow new users to
   sign up". Users then exist only when invited.
2. **Authentication > Multi-Factor:** enable **TOTP** (authenticator app).
   The console will require it; this setting is what lets a user enrol.
3. **JWT signing keys** (Project Settings > JWT Keys): the project must sign
   with an **asymmetric** key (ECC P-256 / ES256, or RSA / RS256) and publish
   it at `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. The library
   deliberately has no shared-secret (HS256) mode. If the project still signs
   with the legacy JWT secret, migrate it to asymmetric keys first; do not add
   an HS256 path.
4. **Access token expiry:** keep it short (the default one hour, or less).
   The library refuses any token valid for more than 24 hours. A signed-out
   token keeps verifying until it expires, so shorter is safer; deactivation in
   `staff_members` does not wait for expiry.
5. **URL configuration:** set the site URL and an allow-list of redirect URLs
   to the console's own address only, once it exists.
6. **Invite the owner:** Authentication > Users > Invite user. When they have
   accepted, copy their user id and run once in the SQL editor:

   ```sql
   select bootstrap_owner('<owner email>', '<auth user id>', '<display name>');
   ```

   It refuses if an active owner already exists, and it cannot be called
   through the API.
7. **Netlify environment:** nothing new. The console uses the same
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as the order webhook.
   `SUPABASE_URL` must be the plain `https://<ref>.supabase.co`.

### What has to be checked against the staging project

Everything above is tested offline only (`tests/admin-auth.test.js`, with
locally generated keys and stubbed Supabase). These have **not** been checked
against real Supabase, and must be before the console is relied on:

- that the project's tokens are ES256 or RS256 with a `kid` found in its
  published key set (if staging turns out to require HS256, stop: that is a
  design change, not a setting);
- that `iss` is exactly `https://<ref>.supabase.co/auth/v1`, `aud` and `role`
  are `authenticated`, `sub` is the user id, and `is_anonymous` is false;
- that a user who has completed TOTP gets `aal: "aal2"`, and one who has only
  entered a password or followed an email link gets `aal1` and is refused;
- that the key set endpoint answers without credentials, and the service role
  can read `staff_members` through PostgREST with 0003 and 0004 applied;
- that public sign-up is really off, and an invited user who is not in
  `staff_members` is refused;
- that `bootstrap_owner` works with a real Auth user id, and the
  `staff_members.auth_user_id` foreign key to `auth.users` is created (it only
  can be on Supabase; the offline tests have no `auth` schema);
- that all of it behaves the same inside Netlify's function runtime.

### The console's read API (not reachable from any screen yet)

Seven read-only functions, `admin-dashboard`, `admin-orders`,
`admin-inventory`, `admin-expenses`, `admin-financials`, `admin-audit` and
`admin-customers`, serve the screens still to be built (README, *Operations
console: read API*). Each:

- accepts `GET` only;
- signs the caller in with the check above;
- asks the database (`staff_can`) whether that staff member's role allows
  the read;
- validates every parameter;
- reads only named columns, with the service role key, on the server.

They change nothing. Nothing new needs configuring: they use the same two
Supabase settings as the order webhook.

Also to check on the staging project, once 0003 and 0004 are applied there:

- that each endpoint returns real data for the owner, with every filter and
  page cursor, and that PostgREST accepts the quoted keyset filters
  (`or=(created_at.lt."…",…)`) exactly as the offline tests build them;
- that `POST /rest/v1/rpc/staff_can` answers `true` or `false` for the
  service role;
- **which kind of service key the project has.** The API, the sign-in check
  and the order webhook all send it as both `apikey` and
  `Authorization: Bearer`. That is right for the legacy JWT-format
  `service_role` key. Supabase's newer `sb_secret_…` keys may not be accepted
  in the `Authorization` header. If staging only issues the newer kind,
  report it before changing anything: the fix touches the payment webhook
  too;
- **what the browser roles may do on the 0001-0003 tables.** Those tables
  rely on row level security with no policies: a browser role sees no rows
  and can write none, and the offline tests prove that. But if the project
  still gives `anon` and `authenticated` Supabase's broad default grants, the
  grant itself is wider than needed. A migration revoking those table
  privileges outright would be a sensible hardening step; it is not part of
  this pass.

---

### The console's write API (not reachable from any screen yet)

Eighteen `POST` actions on `admin-orders`, `admin-inventory` and
`admin-expenses` make every change the console will offer (README,
*Operations console: write API*). Each is one call to a protected database
function from 0004. That function re-checks the permission, makes the change
and writes the audit entry in one transaction. The staff member recorded is
always the one signed in; nothing a browser sends can change that.

Two things to know before using it:

- **Inventory sync uses the deployed catalogue.** It adds a stock item for
  every product and pack size in `catalog.json` and deactivates any that are
  no longer listed (their lots and history stay). Run it after a catalogue
  change, before receiving stock of a new product.
- **Cancelled and refunded move no money.** They record what happened. Make
  the refund in Stripe.

Also to check on the staging project, once 0003 and 0004 are applied:

- that every action works through real PostgREST `rpc/` calls with the
  service key, with the argument names the offline tests prove against the
  migrations;
- that PostgREST returns the error codes this API maps (`42501`, `P0002`,
  `23514`, `23505`, `23503`) in the response body, with the functions' own
  messages, as the offline tests assume.

## 3h. New-order notifications (email and text to the owner)

When a paid order arrives, the owner is emailed (Postmark) and texted
(Twilio), usually within a minute (README, *New-order notifications*).
Nothing is sent until you switch it on.

### Setting it up

1. **Apply `supabase/migrations/0005_order_notifications.sql`** after 0001 to
   0004. It adds the outbox and the trigger that fills it. Orders that already
   exist are not notified.
2. **Postmark:** create a server, and verify the sending domain (DNS records
   Postmark gives you). Note the server API token.
3. **Twilio:** buy a number, or set up a messaging service. **Texting a US
   number needs A2P 10DLC registration (or toll-free verification) before
   carriers deliver it.** Allow for that taking days, and for carriers being
   cautious about this product category.
4. **In Netlify, Site configuration > Environment variables** (never in
   `netlify.toml`: these are keys and personal details):

   | Variable | Value |
   |---|---|
   | `POSTMARK_SERVER_TOKEN` | the server token |
   | `NOTIFY_EMAIL_FROM` | an address on the verified domain |
   | `NOTIFY_EMAIL_TO` | the owner's address |
   | `POSTMARK_MESSAGE_STREAM` | optional; Postmark's `outbound` if unset |
   | `TWILIO_ACCOUNT_SID` | `AC…` |
   | `TWILIO_AUTH_TOKEN` | the account's auth token |
   | `TWILIO_FROM` | the sending number (`+1…`) **or** `TWILIO_MESSAGING_SERVICE_SID` (`MG…`), not both |
   | `NOTIFY_SMS_TO` | the owner's mobile (`+1…`) |
   | `NOTIFY_ENABLED` | `1`, last, once the rest show `ok` |

5. **Redeploy**, then open `/.netlify/functions/health`. Under
   `notifications`, every setting should read `ok` and `working` should be
   `true`.
6. **Place a test order.** Within a couple of minutes you should get an email
   whose subject starts `[TEST]` and a text starting `[TEST] New order`. Use
   Stripe's "Resend" on the webhook delivery: no second email or text should
   arrive.

The schedule runs on the published production deploy only, not on deploy
previews. `NOTIFY_ENABLED` is the off switch: remove it or set it to `0` and
nothing more is sent. Orders keep queuing, and anything over a day old is
skipped rather than sent when it is switched back on.

### What the messages contain, and what they do not

- **The text is deliberately minimal.**
  `New order TR-1A2B3C4D: $123.45 USD, 3 items.` No name, address, email or
  phone.
- **The email** adds:
  - the customer's name;
  - the lines;
  - the shipping address;
  - whether research use was confirmed, flagged loudly when it was not.

  It never includes the customer's email or phone.
- **There is no console link yet;** it comes with the console screens.

**Test orders are always marked `[TEST]`.** An order counts as live only when
its Stripe session is a live one (`cs_live_…`) and this is not a demo deploy.

### Things to know

- **A notification is not proof of payment.** Check the order in Stripe
  before shipping anything unusual.
- **Delivery is at least once.** In the rare case that a send succeeds but
  recording it fails, the owner gets the same alert twice; nothing is lost.
- **Delayed payment methods are not covered.** The webhook records an order
  only when Checkout reports it paid at once (`checkout.session.completed`
  with `payment_status = paid`). It does not yet handle
  `checkout.session.async_payment_succeeded`, so an order paid by a delayed
  method (a bank debit, for example) is neither recorded nor notified. Keep
  only instant methods enabled in Stripe until that is addressed.

### To check on the staging project

- that 0005 applies on top of 0001-0004;
- that a Stripe test order queues exactly two outbox rows, and "Resend" adds
  none;
- **Postmark's API, as built from the documentation we know:**
  - the `X-Postmark-Server-Token` header;
  - the JSON fields `From`, `To`, `Subject`, `TextBody`, `MessageStream`,
    `Tag` and `Metadata`;
  - the `MessageID` and `ErrorCode` in the answer;
  - whether Postmark offers an idempotency key (this pass does not rely on
    one);
- **Twilio's API:** the Messages endpoint with Basic auth, the form fields
  `To`, `From` or `MessagingServiceSid`, and `Body`, and the `sid` and
  numeric `code` in the answer;
- **that two overlapping runs never claim the same row.** This relies on
  PostgreSQL's `FOR UPDATE SKIP LOCKED`; the offline tests use a
  single-connection database and cannot run two claims at once;
- that the scheduled function runs every minute on the production deploy,
  and what calling its URL directly does (it takes no input either way).

## 3i. Neon staging database (schema only; the site does not use it yet)

The schema also lives on the Neon project `peptide`, branch `peptide-staging`
(PostgreSQL 18). Nothing in the site or its functions connects to it yet:
they still use Supabase.

**Roles.** Neon has no `service_role` and grants nothing by default, so
`db/neon/00_roles.sql` sets up the roles first:

- `peptide_owner` owns every table, view and function, and is used only to
  apply migrations. It cannot log in.
- `peptide_app` is what the server will connect as. It holds exactly what
  `service_role` holds on Supabase, through membership of a `service_role`
  group: read everything, write orders and order lines, record add-on
  sales, and call the console and notification functions. It cannot create,
  truncate or delete orders, and it is not the owner.
- `peptide_readonly` reads everything and can change nothing, for reports
  and checks. Its sessions are read-only by default.
- `anon` and `authenticated` exist only so the migrations' revokes apply.
  They hold nothing.

Row level security stays on with no policies, as on Supabase: the app and
read-only roles bypass it deliberately, and every other role sees nothing.
Neither login role has a password yet.

**Applying the schema to a new branch,** as the project owner:

1. `db/neon/00_roles.sql`;
2. `supabase/migrations/0001` to `0006`, each after `set role peptide_owner`;
3. `db/neon/99_access.sql`, also as `peptide_owner`.

**Checking a branch.** `tests/db/schema-snapshot.mjs` holds catalogue
queries that reduce the schema and every role's privileges to digests. Run
directly, it prints the digests of the tested build; the same queries run on
the branch must give the same digests. `npm run test:neon` in `tests/db`
runs the database tests on the Neon role model, and
`tests/db/neon-roles.test.mjs` checks the roles themselves.

**The access layer.** `netlify/lib/db.js` is how the functions will reach
this database; none of them uses it yet. It reads `DATABASE_URL`, a
server-side environment variable that must log in as `peptide_app` (it
refuses any other role), and talks to Neon over HTTPS with the official
driver, `@neondatabase/serverless`: the only runtime dependency, in the root
`package.json`, which Netlify installs on deploy. It returns values in the
form the functions return today (numbers for bigint and numeric, `YYYY-MM-DD`
dates, UTC timestamps with microseconds), and every failure as a `DbError`
with a fixed message and a kind (config, connection, permission, constraint,
not found and so on). The comment at its top has the details.
`tests/db/db.test.mjs` runs it against a stand-in for Neon's HTTP endpoint
backed by the tested schema.

Before it can be used on staging:

- `peptide_app` needs a password (the Neon console can reset it, or
  `ALTER ROLE` as the database owner), and the connection string goes into
  Netlify's environment as `DATABASE_URL`, never into the repository;
- the functions need Node 20 or later (the driver needs 19).

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
- **The assistant has not met the real model.** Its function is covered by a
  stubbed suite (`tests/chat.test.js`) and its drawer was driven in Chromium,
  but the Anthropic API was stubbed throughout. The live refusal check in §3d
  is not optional.
- **The operations data has no screens and no real data yet.** Its rules,
  views and calculations are tested against PostgreSQL 16 (`tests/db`), but
  it has not been applied to the live Supabase project, and revenue figures
  stay incomplete until the payment integration records fees, tax and skus.
- **Console sign-in has not met real Supabase Auth.** The server-side check
  (`netlify/lib/admin-auth.js`) is covered offline with tokens the tests sign
  themselves; no token from the real project has been verified. §3g lists
  what must be checked on the staging project.
- **The console read API has not read real data.** Its seven endpoints are
  covered offline with Supabase stubbed, and every table and column they read
  is checked against the migrations in PostgreSQL 16, but none has run against
  a Supabase project or behind real PostgREST. §3g lists what to check.
- **No notification has been sent.** Email and text are covered offline,
  with Postmark and Twilio stubbed. The outbox is checked against the
  migrations in PostgreSQL 16. §3h lists what to check on staging, including
  the provider APIs themselves.
- **The console write API has not changed real data.** All eighteen actions
  are covered offline, including against the migrations in PostgreSQL 16, but
  none has run against a Supabase project or behind real PostgREST.
- **Add-ons have not been through a payment.** The configuration, cart,
  server-side pricing, stock ledger and reports are tested, the SQL against
  Postgres 16, but no payment integration charges for add-ons yet, so none
  has been bought end to end.

---

## 6. Checking your work

```bash
python3 tools/build.py      # regenerate every page
python3 tools/check.py      # links, metadata, labels, unfilled legal details
node --test tests/chat.test.js   # the support assistant's function, stubbed
node --test tests/addons.test.js # add-ons, server side
node --test tests/admin-auth.test.js   # console authentication, offline
node --test tests/admin-api.test.js tests/admin-read.test.js   # console read API, offline
node --test tests/admin-write.test.js   # console write API, offline
node --test tests/notify.test.js        # new-order notifications, offline
python3 -m unittest discover -s tests -p 'test_*.py'   # add-on configuration
npm ci                                # the functions' one dependency (the Neon driver)
(cd tests/db && npm ci && npm test)   # database migrations and db.js, against PostgreSQL 16
```

`check.py` exits non-zero on failure, so it can gate a deploy. It verifies that
internal links resolve, that every page has its title, description, canonical
and landmarks, that images carry alt text and form controls carry labels, and
that no legal document still contains an unfilled field.
