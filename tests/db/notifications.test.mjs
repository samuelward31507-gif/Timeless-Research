/*
 * Migration 0005, the new-order notification outbox, against PostgreSQL 16.
 *
 * Orders are written the way the payment webhook writes them (harness.mjs
 * recordPaidOrder replays its PostgREST upsert), as the service role. The
 * dispatcher (netlify/functions/notify-dispatch.js) is then run against this
 * database: its two rpc calls are answered here, as PostgREST would, and
 * Postmark and Twilio are stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, rows, one, recordPaidOrder, insertOrder, productLine, errorOf, asRole, reapplyFrom } from './harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const asServer = (db, fn) => asRole(db, 'service_role', fn);
const notes = (db, order) => rows(db, 'select * from public.order_notifications where order_id = $1 order by channel', [order]);
const claim = (db, limit = 5, lease = 120) => asServer(db, () => rows(db, 'select * from public.claim_order_notifications($1, $2)', [limit, lease]));
const complete = (db, id, outcome, providerId = null, code = null) =>
  asServer(db, () => one(db, 'select public.complete_order_notification($1, $2, $3, $4) as status', [id, outcome, providerId, code]));

/* ---------------------------------------------------- creating events */

test('0005 applies on top of 0001-0004, and again', async () => {
  const db = await freshDb();
  await reapplyFrom(db, '0005_order_notifications.sql');
  await reapplyFrom(db, '0005_order_notifications.sql');
  assert.equal((await one(db, `select count(*)::int n from pg_trigger where tgname = 'orders_enqueue_notifications'`)).n, 1);
});

test('a new paid order queues one email and one SMS; webhook retries queue nothing more', async () => {
  const db = await freshDb();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_test_n1'));
  for (let i = 0; i < 3; i++) await asServer(db, () => recordPaidOrder(db, 'cs_test_n1'));
  const n = await notes(db, id);
  assert.deepEqual(n.map((r) => [r.channel, r.status, r.attempts]), [['email', 'pending', 0], ['sms', 'pending', 0]]);
  const { id: second } = await asServer(db, () => recordPaidOrder(db, 'cs_test_n2'));
  assert.equal((await notes(db, second)).length, 2);
  assert.equal((await one(db, 'select count(*)::int n from public.order_notifications')).n, 4);
});

test('a retry after the order has moved on queues nothing', async () => {
  const db = await freshDb();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_test_moved'));
  await db.query(`select public.set_order_status($1, 'processing', null, 'test')`, [id]);
  await asServer(db, () => recordPaidOrder(db, 'cs_test_moved'));
  assert.equal((await notes(db, id)).length, 2);
});

test('orders that existed before 0005 are never notified (no backfill)', async () => {
  const db = await freshDb({
    between: async (d, name) => {
      if (name === '0004_console_foundation.sql') await recordPaidOrder(d, 'cs_test_before');
    }
  });
  assert.equal((await one(db, 'select count(*)::int n from public.orders')).n, 1);
  assert.equal((await one(db, 'select count(*)::int n from public.order_notifications')).n, 0);
});

test('an order inserted in any status but paid queues nothing', async () => {
  const db = await freshDb();
  const { id } = await insertOrder(db, { status: 'processing' });
  assert.equal((await notes(db, id)).length, 0);
});

test('fail closed: if the outbox cannot be written, the order is not recorded either', async () => {
  const db = await freshDb();
  await db.exec('alter table public.order_notifications rename to order_notifications_moved');
  try {
    const err = await errorOf(() => asServer(db, () => recordPaidOrder(db, 'cs_test_closed')));
    assert.match(err || 'no error', /order_notifications/);
    assert.equal((await one(db, 'select count(*)::int n from public.orders')).n, 0);
  } finally {
    await db.exec('alter table public.order_notifications_moved rename to order_notifications');
  }
  await asServer(db, () => recordPaidOrder(db, 'cs_test_closed'));
  assert.equal((await one(db, 'select count(*)::int n from public.order_notifications')).n, 2);
});

/* -------------------------------------------------------------- access */

test('browser roles can reach nothing; the service role can read but not write the outbox', async () => {
  const db = await freshDb();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_test_access'));
  const nid = (await notes(db, id))[0].id;
  for (const role of ['anon', 'authenticated']) {
    for (const sql of ['select * from public.order_notifications', 'select * from public.claim_order_notifications(1, 60)',
                       `select public.complete_order_notification(${nid}, 'sent')`]) {
      assert.match(await errorOf(() => asRole(db, role, () => db.query(sql))) || 'allowed', /permission denied/, `${role}: ${sql}`);
    }
  }
  assert.equal((await asServer(db, () => rows(db, 'select id from public.order_notifications'))).length, 2);
  for (const sql of [`insert into public.order_notifications (order_id, channel) values ('${id}', 'email')`,
                     `update public.order_notifications set status = 'sent'`,
                     'delete from public.order_notifications', 'truncate public.order_notifications']) {
    assert.match(await errorOf(() => asServer(db, () => db.query(sql))) || 'allowed', /permission denied/, sql);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(await errorOf(() => asRole(db, role, () => db.query('select public.orders_enqueue_notifications()'))) || 'allowed',
                 /permission denied|trigger functions/, role);
  }
});

/* --------------------------------------------------------------- claiming */

test('a claim returns what a message needs, never the customer\'s email or phone, and leases the rows', async () => {
  const db = await freshDb();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_live_claim', { phone: '+15551234567',
    shipping_address: { line1: '1 Main St', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' } }));
  await productLine(db, id, 'bpc-157', '10 mg', 2, 4500);
  const got = await claim(db);
  assert.equal(got.length, 2);
  assert.deepEqual(Object.keys(got[0]).sort(), ['amount_total', 'attempt', 'channel', 'currency', 'customer_name', 'items', 'notification_id',
    'order_created_at', 'order_id', 'research_use_confirmed', 'shipping_address', 'stripe_session_id']);
  const text = JSON.stringify(got);
  for (const s of ['buyer@example.org', '+15551234567']) assert.equal(text.includes(s), false, s);
  assert.equal(got[0].stripe_session_id, 'cs_live_claim');
  assert.equal(got[0].attempt, 1);
  assert.deepEqual(got[0].items, [{ kind: 'product', description: 'bpc-157 10 mg', quantity: 2, amount_total: 9000 }]);
  const n = await notes(db, id);
  assert.ok(n.every((r) => r.status === 'sending' && r.attempts === 1 && r.locked_until > new Date()));

  assert.equal((await claim(db)).length, 0, 'leased rows were claimed again');
  await db.query(`update public.order_notifications set locked_until = now() - interval '1 second'`);
  const again = await claim(db);
  assert.equal(again.length, 2, 'an expired lease is claimed again');
  assert.equal(again[0].attempt, 2);
});

test('a claim takes at most the limit, oldest first', async () => {
  const db = await freshDb();
  for (let i = 0; i < 4; i++) {
    const { id } = await asServer(db, () => recordPaidOrder(db, `cs_test_lim${i}`));
    await productLine(db, id, 'x', '1 mg', 1, 1);
  }
  const first = await claim(db, 3);
  assert.equal(first.length, 3);
  const ids = first.map((r) => Number(r.notification_id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal((await claim(db, 10)).length, 5);
});

test('an order without lines waits up to five minutes, then is sent anyway', async () => {
  const db = await freshDb();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_test_wait'));
  assert.equal((await claim(db)).length, 0);
  await db.query(`update public.orders set created_at = now() - interval '6 minutes' where id = $1`, [id]);
  const got = await claim(db);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].items, []);
});

test('notifications over a day old are skipped, not sent', async () => {
  const db = await freshDb();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_test_stale'));
  await productLine(db, id, 'x', '1 mg', 1, 1);
  await db.query(`update public.order_notifications set created_at = now() - interval '25 hours'`);
  assert.equal((await claim(db)).length, 0);
  assert.deepEqual((await notes(db, id)).map((r) => [r.status, r.last_error_code]), [['skipped', 'stale'], ['skipped', 'stale']]);
});

test('claim bounds are enforced', async () => {
  const db = await freshDb();
  for (const [limit, lease] of [[0, 120], [21, 120], [null, 120], [5, 29], [5, 901], [5, null]]) {
    assert.match(await errorOf(() => claim(db, limit, lease)) || 'allowed', /limit|lease/, `${limit} ${lease}`);
  }
});

/* ------------------------------------------------------------- completing */

async function claimedOne(db, session) {
  const { id } = await asServer(db, () => recordPaidOrder(db, session));
  await productLine(db, id, 'x', '1 mg', 1, 1);
  const got = await claim(db);
  return { order: id, email: got.find((r) => r.channel === 'email').notification_id, sms: got.find((r) => r.channel === 'sms').notification_id };
}

test('sent: recorded with the provider id; a sent row cannot be completed again', async () => {
  const db = await freshDb();
  const c = await claimedOne(db, 'cs_test_sent');
  assert.equal((await complete(db, c.email, 'sent', 'pm-msg-1')).status, 'sent');
  const r = await one(db, 'select * from public.order_notifications where id = $1', [c.email]);
  assert.equal(r.provider_message_id, 'pm-msg-1');
  assert.ok(r.sent_at);
  assert.equal(r.locked_until, null);
  assert.match(await errorOf(() => complete(db, c.email, 'sent', 'again')) || 'allowed', /not being sent/);
  assert.equal((await claim(db)).length, 0, 'a sent notification was claimed again');
});

test('retry: back off 1, 5, 15, 60, 360 minutes; the sixth failed attempt is final', async () => {
  const db = await freshDb();
  const c = await claimedOne(db, 'cs_test_retry');
  const expected = { 1: 60, 2: 300, 3: 900, 4: 3600, 5: 21600 };
  for (const [attempts, seconds] of Object.entries(expected)) {
    await db.query(`update public.order_notifications set status = 'sending', attempts = $2 where id = $1`, [c.email, Number(attempts)]);
    assert.equal((await complete(db, c.email, 'retry', null, 'postmark_503')).status, 'pending');
    const r = await one(db, `select extract(epoch from next_attempt_at - now())::int as wait, last_error_code, locked_until from public.order_notifications where id = $1`, [c.email]);
    assert.ok(Math.abs(r.wait - seconds) <= 2, `attempt ${attempts}: waits ${r.wait}s`);
    assert.equal(r.last_error_code, 'postmark_503');
    assert.equal(r.locked_until, null);
  }
  await db.query(`update public.order_notifications set status = 'sending', attempts = 6 where id = $1`, [c.email]);
  assert.equal((await complete(db, c.email, 'retry', null, 'postmark_503')).status, 'failed');
});

test('failed is final at once; outcomes and codes are checked', async () => {
  const db = await freshDb();
  const c = await claimedOne(db, 'cs_test_failed');
  assert.equal((await complete(db, c.sms, 'failed', null, 'twilio_400_21211')).status, 'failed');
  assert.match(await errorOf(() => complete(db, c.email, 'maybe')) || 'allowed', /outcome must be/);
  assert.match(await errorOf(() => complete(db, c.email, 'retry')) || 'allowed', /needs an error code/);
  for (const code of ['Has Spaces', 'x'.repeat(61), 'to +15551234567', 'a@b.org']) {
    assert.match(await errorOf(() => complete(db, c.email, 'retry', null, code)) || 'allowed', /check constraint|violates/, code);
  }
  assert.match(await errorOf(() => complete(db, c.email, 'sent', 'id with spaces')) || 'allowed', /check constraint|violates/);
  assert.match(await errorOf(() => complete(db, 999999, 'sent')) || 'allowed', /not found/);
});

/* ------------------------------------------------ the dispatcher, end to end */

test('the dispatcher, end to end: one email and one text per new order, never twice', async () => {
  const db = await freshDb();
  const BASE = 'https://test-ref.supabase.co';
  const env = {
    SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: 'k', NOTIFY_ENABLED: '1',
    POSTMARK_SERVER_TOKEN: '0a1b2c3d-1111-2222-3333-444455556666', NOTIFY_EMAIL_FROM: 'orders@shop.example',
    NOTIFY_EMAIL_TO: 'owner@owner.example', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'b'.repeat(32),
    TWILIO_FROM: '+15550001111', NOTIFY_SMS_TO: '+15559998888'
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const sends = [];
  let postmarkStatus = 200;
  const original = global.fetch;
  global.fetch = async (url, init) => {
    url = String(url);
    const m = /\/rest\/v1\/rpc\/(claim_order_notifications|complete_order_notification)$/.exec(url);
    if (m) {
      const a = JSON.parse(init.body);
      const sql = m[1] === 'claim_order_notifications'
        ? ['select * from public.claim_order_notifications($1, $2)', [a.p_limit, a.p_lease_seconds]]
        : ['select public.complete_order_notification($1, $2, $3, $4) as r', [a.p_id, a.p_outcome, a.p_provider_message_id, a.p_error_code]];
      try {
        const out = await asServer(db, () => rows(db, sql[0], sql[1]));
        const value = m[1] === 'claim_order_notifications' ? out : out[0].r;
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value, (k, x) => (typeof x === 'bigint' ? Number(x) : x))) };
      } catch (e) {
        return { ok: false, status: 400, json: async () => ({ code: e.code, message: e.message }) };
      }
    }
    if (url === 'https://api.postmarkapp.com/email') {
      sends.push({ channel: 'email', body: JSON.parse(init.body) });
      return { ok: postmarkStatus === 200, status: postmarkStatus, json: async () => (postmarkStatus === 200 ? { ErrorCode: 0, MessageID: `pm-${sends.length}` } : {}) };
    }
    if (url.startsWith('https://api.twilio.com/')) {
      sends.push({ channel: 'sms', body: Object.fromEntries(new URLSearchParams(init.body)) });
      return { ok: true, status: 201, json: async () => ({ sid: `SM${sends.length}` }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const dispatch = require(path.join(ROOT, 'netlify', 'functions', 'notify-dispatch.js'));
  dispatch._internals.setCatalog({ demo: false });
  try {
    const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_live_e2e', { phone: '+15551234567', name: 'Jo Bloggs',
      shipping_address: { line1: '1 Main St', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' } }));
    await productLine(db, id, 'bpc-157', '10 mg', 3, 4500);

    let res = JSON.parse((await dispatch.handler({})).body);
    assert.deepEqual(res, { enabled: true, claimed: 2, sent: 2, retry: 0, failed: 0, deferred: 0 });
    assert.deepEqual(sends.map((s) => s.channel).sort(), ['email', 'sms']);
    const email = sends.find((s) => s.channel === 'email').body;
    const sms = sends.find((s) => s.channel === 'sms').body;
    assert.match(sms.Body, /^New order TR-[0-9A-F]{8}: \$100\.00 USD, 3 items\.$/);
    assert.ok(email.TextBody.includes('Customer: Jo Bloggs'));
    assert.ok(email.TextBody.includes('1 Main St'));
    for (const s of ['buyer@example.org', '+15551234567']) {
      assert.equal(JSON.stringify(sends).includes(s), false, s);
    }
    assert.deepEqual((await notes(db, id)).map((r) => [r.channel, r.status, r.provider_message_id !== null]),
                     [['email', 'sent', true], ['sms', 'sent', true]]);

    // A Stripe retry and another run: nothing more is sent.
    await asServer(db, () => recordPaidOrder(db, 'cs_live_e2e'));
    res = JSON.parse((await dispatch.handler({})).body);
    assert.equal(res.claimed, 0);
    assert.equal(sends.length, 2);

    // A provider outage: the email is retried later, the SMS goes through.
    postmarkStatus = 503;
    const { id: second } = await asServer(db, () => recordPaidOrder(db, 'cs_test_e2e2'));
    await productLine(db, second, 'bpc-157', '10 mg', 1, 4500);
    res = JSON.parse((await dispatch.handler({})).body);
    assert.deepEqual([res.sent, res.retry], [1, 1]);
    const n = await notes(db, second);
    assert.deepEqual(n.map((r) => [r.channel, r.status, r.last_error_code]), [['email', 'pending', 'postmark_503'], ['sms', 'sent', null]]);
    assert.match(sends[sends.length - 1].body.Body || sends[sends.length - 2].body.Body, /^\[TEST\] /);
    assert.equal(JSON.parse((await dispatch.handler({})).body).claimed, 0, 'retried before its back-off');

    // Switched off: nothing is claimed, so nothing waiting changes.
    process.env.NOTIFY_ENABLED = '0';
    await db.query(`update public.order_notifications set next_attempt_at = now()`);
    assert.deepEqual(JSON.parse((await dispatch.handler({})).body), { enabled: false });
    assert.equal((await notes(db, second))[0].status, 'pending');
  } finally {
    global.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
