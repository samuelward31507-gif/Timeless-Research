/*
 * netlify/lib/orders.js, order intake, end to end: orders.js -> db.js ->
 * @neondatabase/serverless -> Neon's SQL-over-HTTP protocol (neon-http.mjs)
 * -> PostgreSQL on the Neon role model, as peptide_app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { neonHttp, TEST_URL } from './neon-http.mjs';

const require = createRequire(import.meta.url);
const db = require('../../netlify/lib/db.js');
const { recordPaidOrder, OrderInputError } = require('../../netlify/lib/orders.js');
const { orderItemRows } = require('../../netlify/lib/addons.js');

const fake = await neonHttp();
db._internals.fetch = fake.fetch;
process.env.DATABASE_URL = TEST_URL;

const raw = async (sql, params) => (await fake.db.query(sql, params)).rows;

const TABLE = { eligibility: { 'bpc-157': [{ addon: 'bac-water-3ml', rule: 'r1' }] } };

function paidOrder(reference, over = {}) {
  return Object.assign({
    reference,
    paymentReference: 'pay_' + reference,
    email: 'buyer@example.org',
    name: 'A Buyer',
    phone: '+15550100',
    amountTotal: 10500,
    amountSubtotal: 9500,
    amountShipping: 1000,
    amountDiscount: 0,
    currency: 'USD',
    shippingAddress: { line1: '1 Lab Way', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
    researchUseConfirmed: true,
    items: orderItemRows(TABLE, null,
      [{ id: 'bpc-157', size: '5 mg', qty: 2, name: 'BPC-157', unitCents: 4500, amountCents: 9000 }],
      [{ addonId: 'bac-water-3ml', ruleId: 'r1', parentId: 'bpc-157', parentSize: '5 mg', label: 'Bacteriostatic water',
         quantity: 1, unitCents: 500, amountCents: 500 }])
  }, over);
}

async function stored(reference) {
  const [order] = await raw('select id, status, amount_total, currency, email, name, shipping_address from public.orders where stripe_session_id = $1', [reference]);
  if (!order) return null;
  const lines = await raw('select kind, sku, pack_size, addon_id, rule_id, parent_sku, parent_pack_size, description, quantity, unit_amount, amount_total, offered_addons from public.order_items where order_id = $1 order by id', [order.id]);
  const notes = (await raw('select count(*)::int as n from public.order_notifications where order_id = $1', [order.id]))[0].n;
  const moves = await raw('select addon_id, delta, reason from public.addon_stock_movements where order_id = $1', [order.id]);
  return { order, lines, notes, moves };
}

test('a new paid order is recorded with its lines, its notifications and its add-on stock, in one go', async () => {
  const result = await recordPaidOrder(paidOrder('ord_new_1'));
  assert.equal(result.created, true);
  assert.equal(result.status, 'paid');
  assert.equal(result.consistent, true);
  assert.match(result.orderId, /^[0-9a-f-]{36}$/);

  const s = await stored('ord_new_1');
  assert.equal(s.order.id, result.orderId);
  assert.equal(s.order.amount_total, 10500);
  assert.deepEqual(s.order.shipping_address, { line1: '1 Lab Way', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' });
  assert.equal(s.lines.length, 2);
  assert.deepEqual(s.lines.map((l) => l.kind), ['product', 'addon'], 'lines keep their order');
  assert.deepEqual(s.lines[0].offered_addons, [{ addon: 'bac-water-3ml', rule: 'r1' }]);
  assert.equal(s.lines[1].parent_sku, 'bpc-157');
  assert.equal(s.notes, 2, 'email and text queued by the trigger');
  assert.deepEqual(s.moves, [{ addon_id: 'bac-water-3ml', delta: -1, reason: 'sale' }]);
});

test('a redelivery changes nothing: no second order, lines, notifications or stock movement, and status is kept', async () => {
  const first = await recordPaidOrder(paidOrder('ord_replay'));
  await raw("update public.orders set status = 'processing' where id = $1", [first.orderId]);
  const again = await recordPaidOrder(paidOrder('ord_replay', { name: 'Someone Else' }));
  assert.equal(again.created, false);
  assert.equal(again.orderId, first.orderId);
  assert.equal(again.status, 'processing', 'a fulfilled order is not reset to paid');
  assert.equal(again.consistent, true);
  const s = await stored('ord_replay');
  assert.equal(s.order.name, 'A Buyer', 'the stored order wins');
  assert.equal(s.lines.length, 2);
  assert.equal(s.notes, 2);
  assert.equal(s.moves.length, 1);
});

test('a redelivery that disagrees on total or currency is reported, and the stored order is unchanged', async () => {
  await recordPaidOrder(paidOrder('ord_conflict'));
  const total = await recordPaidOrder(paidOrder('ord_conflict', { amountTotal: 1 }));
  assert.deepEqual([total.created, total.consistent], [false, false]);
  const currency = await recordPaidOrder(paidOrder('ord_conflict', { currency: 'EUR' }));
  assert.equal(currency.consistent, false);
  const s = await stored('ord_conflict');
  assert.deepEqual([s.order.amount_total, s.order.currency], [10500, 'USD']);
});

test('a failure part-way through leaves nothing: no order, no notifications, no stock movement', async () => {
  await fake.db.exec('revoke insert on public.order_items from service_role');
  try {
    await assert.rejects(recordPaidOrder(paidOrder('ord_atomic')), (e) => e.kind === 'permission' && e.code === '42501');
  } finally {
    await fake.db.exec('grant insert on public.order_items to service_role');
  }
  assert.equal(await stored('ord_atomic'), null);
  assert.equal((await raw("select count(*)::int as n from public.order_notifications n join public.orders o on o.id = n.order_id where o.stripe_session_id = 'ord_atomic'"))[0].n, 0);
  const retry = await recordPaidOrder(paidOrder('ord_atomic'));
  assert.equal(retry.created, true, 'the provider\'s retry then records it whole');
  assert.equal((await stored('ord_atomic')).lines.length, 2);
});

test('an unreachable database is a connection error and nothing is recorded', async () => {
  fake.failNext = 'network';
  await assert.rejects(recordPaidOrder(paidOrder('ord_offline')), (e) => e.kind === 'connection');
  assert.equal(await stored('ord_offline'), null);
});

test('a malformed order is refused before anything is sent, naming the field', async () => {
  const sent = fake.requests.length;
  const base = paidOrder('ord_bad');
  const product = base.items[0];
  const addon = base.items[1];
  const cases = [
    [null, 'order'],
    [{ ...base, extra: 1 }, 'extra'],
    [{ ...base, reference: undefined }, 'reference'],
    [{ ...base, reference: 'has space' }, 'reference'],
    [{ ...base, reference: 'x'.repeat(256) }, 'reference'],
    [{ ...base, paymentReference: 'bad ref' }, 'paymentReference'],
    [{ ...base, amountTotal: undefined }, 'amountTotal'],
    [{ ...base, amountTotal: 10.5 }, 'amountTotal'],
    [{ ...base, amountTotal: -1 }, 'amountTotal'],
    [{ ...base, amountTotal: 2 ** 31 }, 'amountTotal'],
    [{ ...base, amountShipping: '100' }, 'amountShipping'],
    [{ ...base, currency: 'usd' }, 'currency'],
    [{ ...base, researchUseConfirmed: 'true' }, 'researchUseConfirmed'],
    [{ ...base, items: [] }, 'items'],
    [{ ...base, items: Array(101).fill(product) }, 'items'],
    [{ ...base, shippingAddress: 'Austin' }, 'shippingAddress'],
    [{ ...base, shippingAddress: { ...base.shippingAddress, county: 'X' } }, 'shippingAddress.county'],
    [{ ...base, shippingAddress: { ...base.shippingAddress, country: 'USA' } }, 'shippingAddress.country'],
    [{ ...base, items: [{ ...product, order_id: 'x' }] }, 'items[0].order_id'],
    [{ ...base, items: [{ ...product, kind: 'gift' }] }, 'items[0].kind'],
    [{ ...base, items: [{ ...product, quantity: 0 }] }, 'items[0].quantity'],
    [{ ...base, items: [{ ...product, quantity: 1.5 }] }, 'items[0].quantity'],
    [{ ...base, items: [{ ...product, colour: 'red' }] }, 'items[0].colour'],
    [{ ...base, items: [{ ...product, sku: 'bpc 157' }] }, 'items[0].sku'],
    [{ ...base, items: [{ ...product, sku: 'BPC-157' }] }, 'items[0].sku'],
    [{ ...base, items: [{ ...product, pack_size: ' 5 mg' }] }, 'items[0].pack_size'],
    [{ ...base, items: [{ ...addon, rule_id: 'r 1' }] }, 'items[0].rule_id'],
    [{ ...base, items: [{ ...product, addon_id: 'x' }] }, 'items[0].addon_id'],
    [{ ...base, items: [{ ...product, offered_addons: [{ addon: 'a' }] }] }, 'items[0].offered_addons[0].rule'],
    [{ ...base, items: [{ ...product, offered_addons: 'a' }] }, 'items[0].offered_addons'],
    [{ ...base, items: [{ ...addon, parent_sku: null }] }, 'items[0].parent_sku'],
    [{ ...base, items: [{ ...addon, addon_id: undefined }] }, 'items[0].addon_id'],
    [{ ...base, items: [{ ...addon, offered_addons: [] }] }, 'items[0].offered_addons'],
    [{ ...base, items: [{ ...product, unit_amount: -5 }] }, 'items[0].unit_amount']
  ];
  for (const [input, field] of cases) {
    const e = await recordPaidOrder(input).then(() => null, (err) => err);
    assert.ok(e instanceof OrderInputError, `${field}: ${e && e.message}`);
    assert.equal(e.field, field);
  }
  assert.equal(fake.requests.length, sent, 'nothing reached the database');
});

test('what a customer typed is tidied, not refused: a paid order is never lost over its text', async () => {
  const result = await recordPaidOrder(paidOrder('ord_text', {
    name: '  Dr.\u0007 Buyer\n',
    email: 'not-an-address',
    phone: '',
    shippingAddress: { line1: ' 1 Lab Way\r\nSuite 2 ', city: 'Austin', country: 'US' }
  }));
  assert.equal(result.created, true);
  const s = await stored('ord_text');
  assert.equal(s.order.name, 'Dr.  Buyer');
  assert.equal(s.order.email, 'not-an-address');
  assert.deepEqual(s.order.shipping_address,
    { line1: '1 Lab Way  Suite 2', line2: null, city: 'Austin', state: null, postal_code: null, country: 'US' });
});

test('an order with only product lines records no stock movement; a minimal order needs only the required fields', async () => {
  const result = await recordPaidOrder({
    reference: 'ord_minimal', amountTotal: 4500, currency: 'USD', researchUseConfirmed: false,
    items: [{ kind: 'product', sku: 'kpv', pack_size: '10 mg', description: null, quantity: 1, unit_amount: 4500, amount_total: 4500 }]
  });
  assert.equal(result.created, true);
  const s = await stored('ord_minimal');
  assert.deepEqual([s.lines.length, s.moves.length, s.notes], [1, 0, 2]);
  const [o] = await raw('select amount_shipping, amount_discount, amount_subtotal, research_use_confirmed, stripe_payment_intent from public.orders where id = $1', [result.orderId]);
  assert.deepEqual(o, { amount_shipping: 0, amount_discount: 0, amount_subtotal: null, research_use_confirmed: false, stripe_payment_intent: null });
});

test('two deliveries of the same order at once still record it exactly once', async () => {
  const [a, b] = await Promise.all([recordPaidOrder(paidOrder('ord_race')), recordPaidOrder(paidOrder('ord_race'))]);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(a.orderId, b.orderId);
  const s = await stored('ord_race');
  assert.deepEqual([s.lines.length, s.notes, s.moves.length], [2, 2, 1]);
});

test('the whole intake runs as one request, as peptide_app', async () => {
  const before = fake.requests.length;
  await recordPaidOrder(paidOrder('ord_onerequest'));
  assert.equal(fake.requests.length, before + 1);
  const body = JSON.parse(fake.requests[fake.requests.length - 1].body);
  assert.equal(body.queries.length, 4);
  assert.equal(new URL(fake.requests[fake.requests.length - 1].headers.get('Neon-Connection-String')).username, 'peptide_app');
});
