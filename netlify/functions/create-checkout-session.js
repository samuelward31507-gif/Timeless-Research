/*
 * Creates a Stripe Checkout session for the cart.
 *
 * Why a function exists at all on an otherwise static site: Stripe Checkout has
 * to be created server-side, because doing it needs the secret key and a static
 * page cannot hold one. This is the whole backend.
 *
 * Two rules it exists to enforce, neither of which a browser can be trusted with:
 *
 *   1. Prices are read from catalog.json, which tools/build.py regenerates from
 *      assets/data/products.json on every deploy. The request carries ids, pack
 *      sizes and quantities and nothing else. A price sent from a browser is a
 *      number the customer chose.
 *   2. Restricted compounds are refused here, not only in the UI. They are the
 *      reference standards that correspond to approved or investigational
 *      pharmaceuticals; they have no add-to-cart control on any page, so an id
 *      arriving here means the page was bypassed, which is exactly when the
 *      check has to hold.
 *
 * No npm dependency: the Stripe REST API takes form-encoded POSTs and the
 * runtime has fetch. Adding the SDK would mean a package.json, a lockfile and
 * an install step in the deploy for one HTTP call.
 */
'use strict';

const CATALOG = require('./catalog.json');

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';

const MAX_LINES = 20;      // distinct cart lines
const MAX_QTY = 99;        // units of one pack size
const MAX_BODY = 20000;    // bytes; a legitimate cart is a few hundred

const DEFAULT_COUNTRIES = [
  'US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'NL', 'BE', 'LU', 'AT',
  'CH', 'ES', 'PT', 'IT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'JP', 'SG'
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

/* Stripe takes nested parameters as form fields: a[b][0][c]=v. */
function encode(obj, prefix, out) {
  out = out || [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') encode(v, `${name}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else if (typeof value === 'object') {
      encode(value, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  return out;
}

function shippingRate(name, cents, currency, minDays, maxDays) {
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      display_name: name,
      fixed_amount: { amount: cents, currency },
      delivery_estimate: {
        minimum: { unit: 'business_day', value: minDays },
        maximum: { unit: 'business_day', value: maxDays }
      }
    }
  };
}

function intEnv(name, fallback) {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    // Deliberately not "misconfigured": the visitor cannot act on that, and
    // the deploy log is where the operator finds out.
    console.error('STRIPE_SECRET_KEY is not set; checkout cannot be created.');
    return json(503, { error: 'Checkout is temporarily unavailable.' });
  }

  const raw = event.body || '';
  if (raw.length > MAX_BODY) return json(413, { error: 'That request was too large.' });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: 'That request could not be read.' });
  }

  if (payload.researchUseConfirmed !== true) {
    return json(400, { error: 'The research use condition has to be confirmed before checkout.' });
  }

  const items = Array.isArray(payload.items) ? payload.items : null;
  if (!items || !items.length) return json(400, { error: 'Your cart is empty.' });
  if (items.length > MAX_LINES) {
    return json(400, { error: 'That is more separate items than checkout takes. Please contact us for a bulk order.' });
  }

  const currency = (CATALOG.currency || 'USD').toLowerCase();
  const lineItems = [];
  const seen = new Set();

  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : '';
    const size = typeof item.size === 'string' ? item.size : '';
    // Strict: no coercion. The only client sends numbers, and a payments
    // endpoint is the wrong place to guess what a string meant.
    const qty = typeof item.qty === 'number' ? item.qty : NaN;

    const product = Object.prototype.hasOwnProperty.call(CATALOG.products, id)
      ? CATALOG.products[id] : null;
    if (!product) return json(400, { error: 'Something in your cart is no longer in the catalogue.' });
    if (!product.buyable) {
      return json(400, {
        error: `${product.name} is not sold through checkout. Please use the Enquire button on its page.`
      });
    }

    const price = Object.prototype.hasOwnProperty.call(product.prices, size)
      ? product.prices[size] : null;
    if (price === null) {
      return json(400, { error: `That pack size of ${product.name} is no longer offered.` });
    }

    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return json(400, { error: 'Please choose a quantity between 1 and ' + MAX_QTY + '.' });
    }

    const key = id + '|' + size;
    if (seen.has(key)) return json(400, { error: 'That cart has the same item on it twice.' });
    seen.add(key);

    lineItems.push({
      quantity: qty,
      price_data: {
        currency,
        unit_amount: Math.round(price * 100),
        product_data: {
          name: `${product.name} — ${size}`,
          description: 'Analytical-grade reference material. For laboratory research use only; not for human or veterinary use.',
          metadata: { sku: id, pack_size: size }
        }
      }
    });
  }

  const site = (process.env.TR_SITE || process.env.URL || '').replace(/\/+$/, '');
  if (!site) {
    console.error('Neither TR_SITE nor URL is set; cannot build return URLs.');
    return json(503, { error: 'Checkout is temporarily unavailable.' });
  }

  const countries = (process.env.TR_SHIP_COUNTRIES || '')
    .split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);

  const params = {
    mode: 'payment',
    line_items: lineItems,
    success_url: `${site}/order-received.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/catalog.html`,
    billing_address_collection: 'required',
    phone_number_collection: { enabled: true },
    shipping_address_collection: {
      allowed_countries: countries.length ? countries : DEFAULT_COUNTRIES
    },
    shipping_options: [
      shippingRate('Tracked courier — standard',
                   intEnv('TR_SHIP_STANDARD_CENTS', 1500), currency, 3, 7),
      shippingRate('Tracked courier — express',
                   intEnv('TR_SHIP_EXPRESS_CENTS', 3500), currency, 1, 3)
    ],
    custom_text: {
      submit: {
        message: 'Research use only. By paying you confirm this material is for in vitro laboratory research and will not be administered to a human or an animal.'
      }
    },
    metadata: {
      research_use_confirmed: 'true',
      source: 'website-cart'
    },
    payment_intent_data: {
      description: 'Research reference material — laboratory research use only'
    }
  };

  // Stripe Tax is an account-level setting with a cost, so it is opt-in.
  if (/^(1|true|yes)$/i.test(process.env.TR_STRIPE_TAX || '')) {
    params.automatic_tax = { enabled: true };
  }

  let response;
  try {
    response = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20'
      },
      body: encode(params).join('&')
    });
  } catch (err) {
    console.error('Stripe request failed:', err && err.message);
    return json(502, { error: 'Checkout could not be reached.' });
  }

  const result = await response.json().catch(() => null);
  if (!response.ok || !result || !result.url) {
    // Stripe's message names the account problem (restricted business, test
    // key in live mode, tax not configured) and belongs in the deploy log, not
    // in front of a customer.
    console.error('Stripe rejected the session:', response.status,
                  result && result.error && result.error.message);
    return json(502, { error: 'Checkout could not be started.' });
  }

  return json(200, { url: result.url });
};
