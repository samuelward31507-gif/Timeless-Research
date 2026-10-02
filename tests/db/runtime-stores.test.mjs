/*
 * The functions' database stores, against the real schema: the SQL that
 * netlify/functions/notify-dispatch.js and addon-availability.js run through
 * netlify/lib/db.js, end to end over Neon's SQL-over-HTTP protocol
 * (neon-http.mjs), as peptide_app. Postmark and Twilio are stubbed; nothing
 * leaves the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { neonHttp, TEST_URL } from './neon-http.mjs';

const require = createRequire(import.meta.url);
const db = require('../../netlify/lib/db.js');
const { recordPaidOrder } = require('../../netlify/lib/orders.js');
const dispatch = require('../../netlify/functions/notify-dispatch.js');
const availability = require('../../netlify/functions/addon-availability.js');
const notify = require('../../netlify/lib/notify.js');

const fake = await neonHttp();
db._internals.fetch = fake.fetch;
process.env.DATABASE_URL = TEST_URL;

const raw = async (sql, params) => (await fake.db.query(sql, params)).rows;

function order(reference) {
  return {
    reference, amountTotal: 9000, currency: 'USD', researchUseConfirmed: true, name: 'A Buyer',
    shippingAddress: { line1: '1 Lab Way', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
    items: [{ kind: 'product', sku: 'bpc-157', pack_size: '5 mg', description: 'BPC-157 — 5 mg', quantity: 2,
              unit_amount: 4500, amount_total: 9000 }]
  };
}

/* ------------------------------------------------------ notify-dispatch */

test('the dispatcher store claims due notifications with the types the messages expect', async () => {
  const { orderId } = await recordPaidOrder(order('ord_claim_types'));
  const rows = await dispatch._internals.store.claim(5, 120);
  const mine = rows.filter((r) => r.order_id === orderId);
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((r) => r.channel).sort(), ['email', 'sms']);
  for (const r of mine) {
    assert.ok(Number.isSafeInteger(r.notification_id), 'bigint id as a number');
    assert.equal(r.attempt, 1);
    assert.match(r.order_created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/);
    assert.equal(r.amount_total, 9000);
    assert.equal(r.stripe_session_id, 'ord_claim_types');
    assert.deepEqual(r.items, [{ kind: 'product', description: 'BPC-157 — 5 mg', quantity: 2, amount_total: 9000 }]);
    assert.equal(r.shipping_address.city, 'Austin');
    assert.equal(r.customer_email, undefined, 'the claim never returns the customer email');
  }
  const [email] = mine.filter((r) => r.channel === 'email');
  assert.equal(await dispatch._internals.store.complete({ p_id: email.notification_id, p_outcome: 'sent',
    p_provider_message_id: 'pm-1', p_error_code: null }), 'sent');
  const [sms] = mine.filter((r) => r.channel === 'sms');
  assert.equal(await dispatch._internals.store.complete({ p_id: sms.notification_id, p_outcome: 'retry',
    p_provider_message_id: null, p_error_code: 'twilio_503' }), 'pending');
  assert.deepEqual(await raw('select channel, status, last_error_code from public.order_notifications where order_id = $1 order by channel', [orderId]),
    [{ channel: 'email', status: 'sent', last_error_code: null }, { channel: 'sms', status: 'pending', last_error_code: 'twilio_503' }]);
});

test('a dispatcher run, end to end: claimed in the database, sent through the providers, recorded as sent', async () => {
  // Earlier rows in this file are leased or pending; start from a clean outbox.
  await raw("update public.order_notifications set status = 'skipped', locked_until = null where status in ('pending', 'sending')");
  const { orderId } = await recordPaidOrder(order('ord_dispatch_run'));
  const env = { NOTIFY_ENABLED: '1', POSTMARK_SERVER_TOKEN: '0a1b2c3d-1111-2222-3333-444455556666',
    NOTIFY_EMAIL_FROM: 'orders@shop.example', NOTIFY_EMAIL_TO: 'owner@owner.example', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
    TWILIO_AUTH_TOKEN: 'b'.repeat(32), TWILIO_FROM: '+15550001111', NOTIFY_SMS_TO: '+15559998888' };
  Object.assign(process.env, env);
  const origFetch = global.fetch;
  const origLog = console.log;
  const sent = [];
  console.log = () => {};
  global.fetch = async (url) => {
    url = String(url);
    if (url === notify._internals.POSTMARK_URL) {
      sent.push('email');
      return { ok: true, status: 200, json: async () => ({ ErrorCode: 0, MessageID: 'pm-run-1' }) };
    }
    if (url.startsWith(notify._internals.TWILIO_BASE)) {
      sent.push('sms');
      return { ok: true, status: 201, json: async () => ({ sid: 'SM' + 'c'.repeat(32) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const res = await dispatch.handler({});
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { enabled: true, claimed: 2, sent: 2, retry: 0, failed: 0, deferred: 0 });
  } finally {
    global.fetch = origFetch;
    console.log = origLog;
    for (const k of Object.keys(env)) delete process.env[k];
  }
  assert.deepEqual(sent.sort(), ['email', 'sms']);
  assert.deepEqual((await raw('select status, provider_message_id is not null as has_id from public.order_notifications where order_id = $1', [orderId]))
    .map((r) => [r.status, r.has_id]), [['sent', true], ['sent', true]]);
});

/* --------------------------------------------------- addon-availability */

test('the availability store reads the stock ledger for the asked ids only, as numbers', async () => {
  await raw("insert into public.addon_stock_movements (addon_id, delta, reason) values ('insulated-shipper', 5, 'restock'), ('insulated-shipper', -2, 'adjustment'), ('moisture-barrier-pouch', 1, 'restock'), ('moisture-barrier-pouch', -1, 'adjustment'), ('other-addon', 9, 'restock')");
  const rows = await availability._internals.store.levels(['insulated-shipper', 'moisture-barrier-pouch', 'never-stocked']);
  assert.deepEqual(rows.sort((a, b) => a.addon_id.localeCompare(b.addon_id)),
    [{ addon_id: 'insulated-shipper', available: 3 }, { addon_id: 'moisture-barrier-pouch', available: 0 }]);
  // The deployed add-on table (built from assets/data/addons.json) has every
  // add-on disabled today, so the function tracks none and answers without a
  // query; tests/addons.test.js covers the handler with tracked add-ons.
  const res = await availability.handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { available: {} });
});
