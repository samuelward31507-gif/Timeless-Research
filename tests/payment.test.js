/*
 * The payment boundary (netlify/lib/payment.js), the development-only payment
 * simulator (tools/simulate_paid_order.mjs), and the rules that keep the
 * order flow provider-neutral. No database and no network: the database
 * driver's fetch is replaced, and these tests fail if it is ever called.
 *
 *   node --test tests/payment.test.js
 *
 * tests/db/payment.test.mjs runs the same boundary against PostgreSQL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const payment = require(path.join(ROOT, 'netlify/lib/payment.js'));
const orders = require(path.join(ROOT, 'netlify/lib/orders.js'));
const db = require(path.join(ROOT, 'netlify/lib/db.js'));

// Any database request from these tests is a failure.
let dbCalls = 0;
db._internals.fetch = async () => { dbCalls += 1; throw new Error('no database in this suite'); };
process.env.DATABASE_URL = 'postgresql://peptide_app:x@ep-test.example.invalid/neondb';

const CATALOG = {
  currency: 'USD',
  volumeTiers: [{ minQty: 10, percent: 10 }, { minQty: 25, percent: 15 }],
  freeShippingOver: 250,
  products: {
    alpha: { name: 'Alpha', buyable: true, prices: { '5 mg': 45, '10 mg': 80 } },
    beta: { name: 'Beta', buyable: true, prices: { '2 mg': 60 } },
    gamma: { name: 'Gamma', buyable: true, prices: { '1 mg': 50 } },
    held: { name: 'Held', buyable: false, prices: { '1 mg': 10 } }
  }
};
const RATES = { standardCents: 1500, expressCents: 3500 };
const cart = (items, extra) => Object.assign({ items, researchUseConfirmed: true }, extra || {});
const price = (items, opts) => payment.priceCart(CATALOG, cart(items), Object.assign({ rates: RATES }, opts || {}));

function refusedAs(fn, field) {
  assert.throws(fn, (e) => e instanceof payment.CartError && e.field === field && e.message.length > 0, field);
}

/* --------------------------------------------------------------- pricing */

test('prices come from the catalogue, never from the request', () => {
  const p = price([{ id: 'alpha', size: '5 mg', qty: 2, price: 1, unitCents: 1 }]);
  assert.deepEqual(p.lines, [{ id: 'alpha', size: '5 mg', qty: 2, name: 'Alpha', unitCents: 4500, amountCents: 9000, tierPercent: null }]);
  assert.equal(p.goodsCents, 9000);
  assert.deepEqual(p.shipping, { method: 'standard', cents: 1500 });
  assert.equal(p.totalCents, 10500);
  assert.equal(p.currency, 'USD');
});

test('volume tiers apply per line; the best one a quantity reaches', () => {
  const p = price([{ id: 'alpha', size: '5 mg', qty: 10 }, { id: 'beta', size: '2 mg', qty: 25 }]);
  assert.deepEqual(p.lines.map((l) => [l.unitCents, l.tierPercent]), [[4050, 10], [5100, 15]]);
  assert.equal(p.goodsCents, 4050 * 10 + 5100 * 25);
});

test('standard shipping is free from the threshold up; express never is; rates come from the deploy', () => {
  assert.equal(price([{ id: 'gamma', size: '1 mg', qty: 4 }]).shipping.cents, 1500);   // $200, under $250
  assert.equal(price([{ id: 'gamma', size: '1 mg', qty: 5 }]).shipping.cents, 0);      // $250, exactly the threshold
  assert.equal(price([{ id: 'alpha', size: '10 mg', qty: 4 }]).shipping.cents, 0);     // $320
  assert.deepEqual(price([{ id: 'alpha', size: '10 mg', qty: 4 }], { shipping: 'express' }).shipping, { method: 'express', cents: 3500 });
  assert.equal(price([{ id: 'alpha', size: '10 mg', qty: 4 }], { shipping: 'express' }).totalCents, 32000 + 3500);
  assert.deepEqual(payment.shippingRates({ TR_SHIP_STANDARD_CENTS: '900', TR_SHIP_EXPRESS_CENTS: '2500' }),
    { standardCents: 900, expressCents: 2500 });
  assert.deepEqual(payment.shippingRates({ TR_SHIP_STANDARD_CENTS: 'x' }), { standardCents: 1500, expressCents: 3500 });
});

test('a cart the server will not price is refused, naming what is wrong', () => {
  refusedAs(() => payment.priceCart(CATALOG, cart([{ id: 'alpha', size: '5 mg', qty: 1 }], { researchUseConfirmed: false }), { rates: RATES }), 'researchUseConfirmed');
  refusedAs(() => payment.priceCart(CATALOG, { items: [{ id: 'alpha', size: '5 mg', qty: 1 }] }, { rates: RATES }), 'researchUseConfirmed');
  refusedAs(() => price([]), 'items');
  refusedAs(() => price(Array.from({ length: 21 }, (_, i) => ({ id: 'alpha', size: '5 mg', qty: i + 1 }))), 'items');
  refusedAs(() => price([{ id: 'nope', size: '5 mg', qty: 1 }]), 'items[0].id');
  refusedAs(() => price([{ id: 'held', size: '1 mg', qty: 1 }]), 'items[0].id');
  refusedAs(() => price([{ id: 'alpha', size: '7 mg', qty: 1 }]), 'items[0].size');
  for (const qty of [0, 100, 1.5, '2', null]) refusedAs(() => price([{ id: 'alpha', size: '5 mg', qty }]), 'items[0].qty');
  refusedAs(() => price([{ id: 'alpha', size: '5 mg', qty: 1 }, { id: 'alpha', size: '5 mg', qty: 2 }]), 'items[1]');
  refusedAs(() => price([{ id: 'alpha', size: '5 mg', qty: 1 }], { shipping: 'drone' }), 'shipping');
  refusedAs(() => price([{ id: '__proto__', size: '5 mg', qty: 1 }]), 'items[0].id');
});

/* ------------------------------------------------- the normalized paid order */

const PAYMENT = {
  reference: 'pay_ref_1', amountPaid: 10500,
  customer: { email: 'buyer@example.org', name: 'A Buyer', phone: '+15550100' },
  shippingAddress: { line1: '1 Lab Way', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' }
};

test('a priced cart and a confirmed payment make the normalized order recordPaidOrder() takes', () => {
  const order = payment.paidOrderFromCart(price([{ id: 'alpha', size: '5 mg', qty: 2 }]), PAYMENT);
  assert.deepEqual(order, {
    reference: 'pay_ref_1', paymentReference: null,
    email: 'buyer@example.org', name: 'A Buyer', phone: '+15550100',
    amountTotal: 10500, amountSubtotal: 9000, amountShipping: 1500, amountDiscount: 0, currency: 'USD',
    shippingAddress: PAYMENT.shippingAddress, researchUseConfirmed: true,
    items: [{ order_id: null, kind: 'product', sku: 'alpha', pack_size: '5 mg', description: 'Alpha — 5 mg',
              quantity: 2, unit_amount: 4500, amount_total: 9000, offered_addons: [] }]
  });
  // The intake's own validation accepts it as it stands.
  assert.doesNotThrow(() => orders._internals.normalize(order));
});

/* ------------------------------------------------------ the payment event */

test('failed and cancelled payments record nothing and never reach the database', async () => {
  const order = payment.paidOrderFromCart(price([{ id: 'alpha', size: '5 mg', qty: 1 }]), PAYMENT);
  for (const status of ['failed', 'cancelled']) {
    assert.deepEqual(await payment.recordPaymentEvent({ status, order }), { recorded: false, status });
  }
  assert.equal(dbCalls, 0);
});

test('an unknown event, or a malformed paid order, is refused before any database work', async () => {
  for (const event of [null, 'paid', {}, { status: 'succeeded' }, { status: 'PAID' }, { status: 'refunded' }]) {
    await assert.rejects(payment.recordPaymentEvent(event), payment.PaymentEventError);
  }
  const good = payment.paidOrderFromCart(price([{ id: 'alpha', size: '5 mg', qty: 1 }]), PAYMENT);
  const broken = [
    [Object.assign({}, good, { reference: undefined }), 'reference'],
    [Object.assign({}, good, { reference: 'has space' }), 'reference'],
    [Object.assign({}, good, { currency: 'usd' }), 'currency'],
    [Object.assign({}, good, { amountTotal: -1 }), 'amountTotal'],
    [Object.assign({}, good, { amountTotal: 10.5 }), 'amountTotal'],
    [Object.assign({}, good, { items: [] }), 'items'],
    [Object.assign({}, good, { researchUseConfirmed: 'yes' }), 'researchUseConfirmed']
  ];
  for (const [order, field] of broken) {
    await assert.rejects(payment.recordPaymentEvent({ status: 'paid', order }),
      (e) => e instanceof orders.OrderInputError && String(e.field || e.message).includes(field), field);
  }
  assert.equal(dbCalls, 0);
});

/* ------------------------------------------------------------ the simulator */

const SIM = path.join(ROOT, 'tools/simulate_paid_order.mjs');
const sim = () => import(SIM);
const DEV = { TR_SIMULATE_PAYMENTS: '1', DATABASE_URL: 'postgresql://peptide_app:x@ep-dev.example.invalid/neondb' };

test('the simulator refuses to run unless explicitly asked, and never in production', async () => {
  const { refusal } = await sim();
  assert.equal(refusal(DEV), null);
  assert.match(refusal({}), /TR_SIMULATE_PAYMENTS=1/);
  assert.match(refusal(Object.assign({}, DEV, { TR_SIMULATE_PAYMENTS: 'true' })), /TR_SIMULATE_PAYMENTS=1/);
  assert.match(refusal(Object.assign({}, DEV, { NETLIFY: 'true' })), /Netlify/);
  assert.match(refusal(Object.assign({}, DEV, { CONTEXT: 'production' })), /Netlify/);
  assert.match(refusal(Object.assign({}, DEV, { NODE_ENV: 'production' })), /NODE_ENV=production/);
  assert.match(refusal({ TR_SIMULATE_PAYMENTS: '1' }), /DATABASE_URL/);
});

test('a refused simulation does nothing; a simulated payment is always a test order', async () => {
  const { simulate, newReference, PREFIX, TEST_CUSTOMER } = await sim();
  const base = { catalog: CATALOG, cart: { items: [{ id: 'alpha', size: '5 mg', qty: 1 }] } };
  await assert.rejects(simulate(Object.assign({}, base, { env: {} })), /TR_SIMULATE_PAYMENTS=1/);
  await assert.rejects(simulate(Object.assign({}, base, { env: Object.assign({}, DEV, { CONTEXT: 'production' }) })), /Netlify/);
  await assert.rejects(simulate(Object.assign({}, base, { env: DEV, reference: 'cs_live_abc' })), /test_sim_/);
  assert.equal(PREFIX, 'test_sim_');
  assert.match(newReference(), /^test_sim_[0-9a-f]{24}$/);
  assert.notEqual(newReference(), newReference());
  assert.equal(TEST_CUSTOMER.name, 'TEST ORDER (simulated)');
  assert.match(TEST_CUSTOMER.email, /\.invalid$/);
  // A failed simulated payment prices the cart and records nothing.
  const res = await simulate(Object.assign({}, base, { env: DEV, event: 'failed' }));
  assert.equal(res.recorded, false);
  assert.match(res.reference, /^test_sim_/);
  assert.equal(dbCalls, 0);
});

/* ---------------------------------------------- the shape of the order flow */

function filesUnder(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p);
const SERVER = filesUnder(path.join(ROOT, 'netlify'), ['.js']);

test('the simulator is never deployed: nothing under netlify/ imports it, and tools/ is not published', () => {
  for (const f of SERVER) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /simulate_paid_order/, rel(f));
  const dist = fs.readFileSync(path.join(ROOT, 'tools/dist.py'), 'utf8');
  const trees = JSON.parse(dist.match(/^TREES = (\[[^\]]*\])/m)[1].replace(/'/g, '"'));
  assert.ok(!trees.includes('tools'), 'dist.py publishes tools/');
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(toml, /functions = "netlify\/functions"/);
});

test('no payment-provider implementation remains, and the cart says payment is unavailable', () => {
  for (const gone of ['netlify/functions/create-checkout-session.js', 'netlify/functions/stripe-webhook.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, gone);
  }
  for (const f of SERVER.concat(filesUnder(path.join(ROOT, 'assets/js'), ['.js']))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /api\.stripe\.com|create-checkout-session|stripe-webhook|STRIPE_(SECRET_KEY|WEBHOOK_SECRET)/, rel(f));
  }
  const config = fs.readFileSync(path.join(ROOT, 'assets/js/config.js'), 'utf8');
  assert.match(config, /"checkoutEndpoint": ""/);
  const site = fs.readFileSync(path.join(ROOT, 'assets/js/site.js'), 'utf8');
  assert.match(site, /if \(!CFG\.checkoutEndpoint\) \{\s*showCartError\('Online payment is not available yet/);
});

test('orders are created in one place only: recordPaidOrder() in netlify/lib/orders.js', () => {
  const writers = SERVER.filter((f) => /insert\s+into\s+public\.orders\b|rest\/v1\/orders\b/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(writers.map(rel), ['netlify/lib/orders.js']);
});

test('orders are priced in one place only: priceCart() in netlify/lib/payment.js', () => {
  // The arithmetic of a charge: a tier's discount applied to a price. (The
  // support assistant only describes the tiers in words, and the browser's
  // drawer only shows them; neither is on the server's charging path.)
  const pricers = SERVER.filter((f) => /percent\s*\/\s*100/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(pricers.map(rel), ['netlify/lib/payment.js']);
});
