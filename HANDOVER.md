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
| `TR_SITE` | Your live domain | Canonical tags, Open Graph, sitemap |
| `TR_CONTACT_EMAIL` | Where enquiries should reach you | Contact page, form fallback |

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
4. **Forms → account-application** → turn on the notification email. Without
   this, applications collect silently in the Netlify dashboard and nobody is
   told.

Moving to another host instead: set `TR_FORM_PROVIDER=endpoint` and
`TR_FORM_ENDPOINT` to a handler of your own, and serve the `dist/` directory
produced by `python3 tools/build.py && python3 tools/dist.py`.

---

## 2b. Showing the site before it has a business behind it

Building with `TR_DEMO=1` produces a demonstration copy: a black bar on every
page stating that the site is not trading and that no enquiry reaches a
supplier, `noindex,nofollow` on every page, and a `robots.txt` that disallows
everything. The unfilled legal fields in section 1 become a warning instead of
a build failure, so a demo deploys without inventing details.

This matters for a live demo. A peptide storefront that looks open for business
will be found by people trying to place real orders, and a demo left in the
search index competes with the eventual live site. Set `TR_DEMO = "0"` in
`netlify.toml`, or remove the line, when the site goes into service.

---

## 3. Claims you are taking on

The site states these as fact. They have not been verified against any supply
chain — this site was built as a product, not operated. Either arrange the
evidence or change the copy before you take an order.

- **"COA issued with every lot."** On every page, with a six-stage release
  process described in detail on `quality.html`. If you cannot produce a
  lot-specific certificate when a customer asks, this has to come down.
- **Purity.** 24 of the 27 compounds carry `≥98%` and 1 carry `≥95%`,
  surfaced 210 times across cards, vial labels and specification tables.
  Source values are in `assets/data/products.json`.
- **Storage and handling.** Cold chain, −20 °C storage and the packing
  described in `legal/shipping.html` are commitments to your customers.

These are commercial claims. In the US they are the kind of thing the FTC
expects a seller to be able to substantiate.

---

## 3b. Prices

List prices live in `assets/data/products.json`, one per pack size, under
`prices`, with `currency` at the top of the file. Change a number there and
rebuild — the catalogue card, the product page, the pack-size dropdown, the
request list and the subtotal all read from that one place.

`tools/check.py` fails if a listed pack size has no price, so a size cannot be
offered without one.

Prices are shown as list prices excluding shipping and tax. The site still
routes orders through the request list and a written quotation against a
verified account, which is where lot availability and any quantity break are
settled. The subtotal in the request drawer is labelled indicative for that
reason — it is not an invoice, and there is no checkout.

---

## 4. Decisions only you can make

**The four restricted compounds.** Semaglutide, Tirzepatide, Retatrutide and
Oxytocin are flagged `"restricted": true` in `assets/data/products.json` and
gated in the interface. They carry by far the highest regulatory exposure in
the catalog: the three GLP-1 analogues are covered by active patents held by
Novo Nordisk and Eli Lilly, both of which have litigated against sellers, and
FDA has issued warning letters to research-peptide vendors over research-use-only
framing. Removing them is four lines in the JSON and a rebuild. Keeping them
should be a decision you make deliberately, ideally having taken advice.

**Account verification.** The whole legal posture of this site rests on supply
being restricted to verified institutional accounts. The contact form collects
a name, email and phone; everything verification actually requires —
institution, facility address, responsible investigator, institutional email,
intended research use — is gathered in your follow-up. If that follow-up does
not genuinely happen, the research-use framing is decorative and will not
protect you.

**Legal review.** `legal/terms.html`, `legal/privacy.html` and
`legal/shipping.html` were written for a US sole proprietorship selling
research reagents business to business. They are careful drafts built on
standard commercial practice; they have **not** been reviewed by a lawyer.
If you incorporate, operate from a different state, or sell to consumers, they
need revisiting. The clauses doing the most work are the warranty disclaimer
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
- **No screen-reader pass.** Every page is clean under axe-core, which catches
  perhaps a third of real accessibility problems. Nobody has driven the site
  with VoiceOver or NVDA, or completed an order flow using only a keyboard.
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
