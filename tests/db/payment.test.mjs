/*
 * The payment boundary end to end, against PostgreSQL on the Neon role model:
 * the development-only simulator (tools/simulate_paid_order.mjs) prices a
 * real cart from the deploy's catalogue, reports a payment outcome through
 * netlify/lib/payment.js, and recordPaidOrder() writes the order and queues
 * the owner's notifications, which the real dispatcher then sends (the
 * providers stubbed). Same Neon stand-in as orders.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { neonHttp, TEST_URL } from './neon-http.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const db = require('../../netlify/lib/db.js');
const notify = require('../../netlify/lib/notify.js');
const dispatch = require('../../netlify/functions/notify-dispatch.js');
const { simulate } = await import('../../tools/simulate_paid_order.mjs');

const fake = await neonHttp();
db._internals.fetch = fake.fetch;
process.env.DATABASE_URL = TEST_URL;
const raw = async (sql, params) => (await fake.db.query(sql, params)).rows;

// The catalogue the build wrote for this deploy, and two things it sells.
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'netlify/functions/catalog.json'), 'utf8'));
const [a, b] = Object.entries(CATALOG.products).filter(([, p]) => p.buyable).slice(0, 2)
  .map(([id, p]) => ({ id, size: Object.keys(p.prices)[0] }));
const CART = { items: [{ id: a.id, size: a.size, qty: 2 }, { id: b.id, size: b.size, qty: 1 }] };
const DEV = { TR_SIMULATE_PAYMENTS: '1', DATABASE_URL: TEST_URL };
const run = (over) => simulate(Object.assign({ catalog: CATALOG, cart: CART, env: DEV }, over));

async function orderFor(reference) {
  const orders = await raw('select id, name, email, amount_total, amount_subtotal, amount_shipping, currency, status from public.orders where stripe_session_id = $1', [reference]);
  if (orders.length !== 1) return { count: orders.length };
  const [order] = orders;
  const lines = await raw('select kind, sku, pack_size, quantity, unit_amount, amount_total from public.order_items where order_id = $1 order by id', [order.id]);
  const notes = await raw('select channel, status from public.order_notifications where order_id = $1 order by channel', [order.id]);
  return { count: 1, order, lines, notes };
}

test('a simulated successful payment records exactly one test order, through recordPaidOrder(), with one email and one SMS queued', async () => {
  const before = fake.requests.length;
  const res = await run();
  assert.equal(res.recorded, true);
  assert.equal(res.created, true);
  assert.match(res.reference, /^test_sim_[0-9a-f]{24}$/);

  // recordPaidOrder()'s single transaction: one request, four statements, as peptide_app.
  assert.equal(fake.requests.length, before + 1);
  const sent = fake.requests[fake.requests.length - 1];
  assert.equal(JSON.parse(sent.body).queries.length, 4);
  assert.equal(new URL(sent.headers.get('Neon-Connection-String')).username, 'peptide_app');

  const got = await orderFor(res.reference);
  assert.equal(got.count, 1);
  assert.equal(got.order.id, res.orderId);
  assert.equal(got.order.name, 'TEST ORDER (simulated)');
  assert.equal(got.order.email, 'simulated@example.invalid');
  assert.equal(got.order.status, 'paid');
  assert.equal(got.order.amount_total, res.priced.totalCents);
  assert.equal(got.order.amount_subtotal, res.priced.goodsCents);
  assert.equal(got.order.amount_shipping, res.priced.shipping.cents);
  assert.equal(got.order.currency, CATALOG.currency.toUpperCase());
  // The lines say what was sold: product and pack size, priced by the server.
  assert.deepEqual(got.lines.map((l) => [l.kind, l.sku, l.pack_size, l.quantity]),
    [['product', a.id, a.size, 2], ['product', b.id, b.size, 1]]);
  assert.deepEqual(got.lines.map((l) => l.amount_total), res.priced.lines.map((l) => l.amountCents));
  assert.deepEqual(got.notes, [{ channel: 'email', status: 'pending' }, { channel: 'sms', status: 'pending' }]);
});

test('the same payment reported again records nothing more: one order, two notifications', async () => {
  const first = await run();
  const again = await run({ reference: first.reference });
  assert.equal(again.recorded, true);
  assert.equal(again.created, false);
  assert.equal(again.orderId, first.orderId);
  const got = await orderFor(first.reference);
  assert.equal(got.count, 1);
  assert.equal(got.lines.length, 2);
  assert.equal(got.notes.length, 2);
});

test('failed and cancelled payments create no order and no notification', async () => {
  const ordersBefore = (await raw('select count(*)::int as n from public.orders'))[0].n;
  const notesBefore = (await raw('select count(*)::int as n from public.order_notifications'))[0].n;
  for (const event of ['failed', 'cancelled']) {
    const res = await run({ event });
    assert.equal(res.recorded, false);
    assert.equal((await orderFor(res.reference)).count, 0);
  }
  assert.equal((await raw('select count(*)::int as n from public.orders'))[0].n, ordersBefore);
  assert.equal((await raw('select count(*)::int as n from public.order_notifications'))[0].n, notesBefore);
});

test('the dispatcher sends a simulated order to the owner by email and text, both marked [TEST]', async () => {
  // Start from a clean outbox, then one fresh simulated order.
  await raw("update public.order_notifications set status = 'skipped', locked_until = null where status in ('pending', 'sending')");
  const { orderId } = await run();
  const env = { NOTIFY_ENABLED: '1', POSTMARK_SERVER_TOKEN: '0a1b2c3d-1111-2222-3333-444455556666',
    NOTIFY_EMAIL_FROM: 'orders@shop.example', NOTIFY_EMAIL_TO: 'owner@owner.example', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
    TWILIO_AUTH_TOKEN: 'b'.repeat(32), TWILIO_FROM: '+15550001111', NOTIFY_SMS_TO: '+15559998888' };
  Object.assign(process.env, env);
  const origFetch = global.fetch;
  const origLog = console.log;
  const messages = {};
  console.log = () => {};
  global.fetch = async (url, init) => {
    url = String(url);
    if (url === notify._internals.POSTMARK_URL) {
      messages.email = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ErrorCode: 0, MessageID: 'pm-sim-1' }) };
    }
    if (url.startsWith(notify._internals.TWILIO_BASE)) {
      messages.sms = new URLSearchParams(String(init.body)).get('Body');
      return { ok: true, status: 201, json: async () => ({ sid: 'SM' + 'd'.repeat(32) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const res = await dispatch.handler({});
    assert.deepEqual(JSON.parse(res.body), { enabled: true, claimed: 2, sent: 2, retry: 0, failed: 0, deferred: 0 });
  } finally {
    global.fetch = origFetch;
    console.log = origLog;
    for (const k of Object.keys(env)) delete process.env[k];
  }
  assert.match(messages.email.Subject, /^\[TEST\] /);
  assert.match(messages.sms, /^\[TEST\] New order TR-/);
  assert.match(messages.email.TextBody, /TEST ORDER \(simulated\)/);
  assert.deepEqual((await raw('select channel, status from public.order_notifications where order_id = $1 order by channel', [orderId])),
    [{ channel: 'email', status: 'sent' }, { channel: 'sms', status: 'sent' }]);
});
