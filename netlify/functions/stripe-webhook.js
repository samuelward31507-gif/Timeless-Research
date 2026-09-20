/*
 * Records a completed order.
 *
 * Until this existed, a paid order lived only in Stripe. That is fine for
 * taking money and useless for running a shop: no order history, no customer
 * list, nothing to build a status page or a review request on, and nothing the
 * operator owns if they ever change processor.
 *
 * Stripe calls this endpoint when a Checkout session completes. Two properties
 * matter more than anything else here:
 *
 *   1. SIGNATURE VERIFICATION. This URL is public and it writes to the
 *      database. Without a signature check, anyone who finds it can post
 *      invented orders — fake addresses to ship to, fake revenue in the
 *      records. Every request is verified against STRIPE_WEBHOOK_SECRET with a
 *      constant-time comparison before its body is parsed as anything but
 *      bytes, and a request that fails is refused without touching the data.
 *
 *   2. IDEMPOTENCY. Stripe retries a webhook until it gets a 2xx, and will
 *      happily deliver the same event twice. The session id is unique in the
 *      orders table and writes upsert on it, so a replay updates one row
 *      rather than creating a second order for one payment.
 *
 * No npm dependency, for the same reason as the checkout function: Node has
 * crypto and fetch, Stripe's API is HTTP, and Supabase's PostgREST is HTTP.
 */
'use strict';

const crypto = require('crypto');

// Stripe's own tolerance for a signed request, in seconds. Older than this and
// the timestamp is treated as a replay of a captured request.
const TOLERANCE = 300;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

/* Stripe-Signature looks like: t=1699999999,v1=abc...,v1=def... — more than one
   v1 while a secret is being rotated, so every candidate has to be checked. */
function parseSignature(header) {
  const parts = String(header || '').split(',');
  const out = { t: null, v1: [] };
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') out.t = v;
    else if (k === 'v1') out.v1.push(v);
  }
  return out;
}

function verify(rawBody, header, secret) {
  const { t, v1 } = parseSignature(header);
  if (!t || !v1.length) return { ok: false, why: 'malformed signature header' };

  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) return { ok: false, why: 'malformed timestamp' };
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE) {
    return { ok: false, why: 'timestamp outside tolerance' };
  }

  const expected = crypto.createHmac('sha256', secret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex');
  const want = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the length is checked
  // first — and the comparison itself stays constant-time for equal lengths,
  // which is the case that matters.
  const matched = v1.some((candidate) => {
    const got = Buffer.from(candidate, 'utf8');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });

  return matched ? { ok: true } : { ok: false, why: 'no signature matched' };
}

/* --------------------------------------------------------------- Supabase */
/* PostgREST over plain HTTP, with the service role key. That key bypasses row
   level security, which is exactly why it lives only here: the tables have RLS
   on with no policies, so the anon key — the one a browser could ever see —
   can read nothing at all. */
async function supabase(path, options) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options && options.headers)
    }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`supabase ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json().catch(() => null);
}

/* Stripe only sends the line items if you ask for them, and the session in the
   event payload does not include them. */
async function lineItemsFor(sessionId) {
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  );
  if (!res.ok) throw new Error(`stripe line_items ${res.status}`);
  const body = await res.json();
  return body.data || [];
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('stripe-webhook is not configured: needs STRIPE_WEBHOOK_SECRET, ' +
                  'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    // 500 rather than 200: Stripe retries, so a misconfiguration that is fixed
    // within the retry window still ends with the order recorded.
    return json(500, { error: 'not configured' });
  }

  /* Netlify base64-encodes the body when it is flagged binary. The signature is
     computed over the exact bytes Stripe sent, so it has to be decoded before
     anything else touches it. */
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const headers = event.headers || {};
  const signature = headers['stripe-signature'] || headers['Stripe-Signature'];

  const check = verify(rawBody, signature, secret);
  if (!check.ok) {
    console.error('Rejected an unsigned or badly signed webhook:', check.why);
    return json(400, { error: 'signature verification failed' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return json(400, { error: 'unparseable body' });
  }

  // Anything else Stripe is configured to send is acknowledged and ignored, so
  // a stray event type does not sit in Stripe's queue being retried forever.
  if (payload.type !== 'checkout.session.completed') {
    return json(200, { received: true, ignored: payload.type });
  }

  const session = (payload.data && payload.data.object) || {};
  if (session.payment_status !== 'paid') {
    return json(200, { received: true, ignored: `payment_status=${session.payment_status}` });
  }

  const details = session.customer_details || {};
  const shipping = session.collected_information && session.collected_information.shipping_details
    ? session.collected_information.shipping_details
    : (session.shipping_details || null);

  const order = {
    stripe_session_id: session.id,
    stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    email: details.email || null,
    name: (shipping && shipping.name) || details.name || null,
    phone: details.phone || null,
    amount_total: session.amount_total,
    amount_subtotal: session.amount_subtotal,
    amount_shipping: (session.total_details && session.total_details.amount_shipping) || 0,
    amount_discount: (session.total_details && session.total_details.amount_discount) || 0,
    currency: (session.currency || 'usd').toUpperCase(),
    shipping_address: (shipping && shipping.address) || null,
    research_use_confirmed: (session.metadata || {}).research_use_confirmed === 'true',
    status: 'paid'
  };

  let rows;
  try {
    rows = await supabase('orders?on_conflict=stripe_session_id', {
      method: 'POST',
      headers: {
        // merge-duplicates makes the retry an update rather than a second
        // order; representation gets the row id back so the items can hang off it
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify([order])
    });
  } catch (err) {
    console.error('Could not record the order:', err.message);
    // Let Stripe retry rather than swallowing a lost order.
    return json(500, { error: 'could not record order' });
  }

  const orderId = rows && rows[0] && rows[0].id;
  if (!orderId) {
    console.error('Order upsert returned no id; items not written.');
    return json(500, { error: 'could not record order' });
  }

  try {
    const items = await lineItemsFor(session.id);
    if (items.length) {
      // Replace rather than append, so a retry does not double the items.
      await supabase(`order_items?order_id=eq.${encodeURIComponent(orderId)}`, { method: 'DELETE' });
      await supabase('order_items', {
        method: 'POST',
        body: JSON.stringify(items.map((li) => ({
          order_id: orderId,
          description: li.description || null,
          quantity: li.quantity,
          unit_amount: (li.price && li.price.unit_amount) != null ? li.price.unit_amount : null,
          amount_total: li.amount_total
        })))
      });
    }
  } catch (err) {
    // The order itself is safely recorded by this point. Losing the line items
    // is worth a log and a retry, not a lost payment record.
    console.error('Order recorded but line items failed:', err.message);
    return json(500, { error: 'order recorded, items failed' });
  }

  return json(200, { received: true, order_id: orderId });
};

// exported for the test suite; not part of the handler contract
exports._verify = verify;
exports._parseSignature = parseSignature;
