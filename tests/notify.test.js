/*
 * New-order notifications: netlify/lib/notify.js, netlify/functions/notify-dispatch.js
 * and the notifications section of netlify/functions/health.js.
 *
 *   node --test tests/notify.test.js
 *
 * Offline: Postmark and Twilio are stubbed through global.fetch, and the two
 * outbox functions through the dispatcher's store. What the outbox itself does
 * (one row per channel per new order, leases, retries) is proven against the
 * real schema in tests/db/notifications.test.mjs, and the store's SQL against
 * it, as peptide_app, in tests/db/runtime-stores.test.mjs.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_PASSWORD = 'test-db-password-not-real';
const ENV = {
  DATABASE_URL: `postgresql://peptide_app:${DB_PASSWORD}@ep-test.example.invalid/neondb`,
  NOTIFY_ENABLED: '1',
  POSTMARK_SERVER_TOKEN: '0a1b2c3d-1111-2222-3333-444455556666',
  NOTIFY_EMAIL_FROM: 'orders@shop.example',
  NOTIFY_EMAIL_TO: 'owner-inbox@owner.example',
  TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
  TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  TWILIO_FROM: '+15550001111',
  NOTIFY_SMS_TO: '+15559998888'
};
const NOTIFY_KEYS = ['NOTIFY_ENABLED', 'POSTMARK_SERVER_TOKEN', 'NOTIFY_EMAIL_FROM', 'NOTIFY_EMAIL_TO', 'POSTMARK_MESSAGE_STREAM',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID', 'NOTIFY_SMS_TO'];

function setEnv(over) {
  for (const k of NOTIFY_KEYS.concat(['DATABASE_URL'])) delete process.env[k];
  Object.assign(process.env, ENV, over || {});
  for (const [k, v] of Object.entries(over || {})) if (v === undefined) delete process.env[k];
}
setEnv();

const notify = require(path.join(__dirname, '..', 'netlify', 'lib', 'notify.js'));
const dispatchMod = require(path.join(__dirname, '..', 'netlify', 'functions', 'notify-dispatch.js'));
const health = require(path.join(__dirname, '..', 'netlify', 'functions', 'health.js'));
const CATALOG = require(path.join(__dirname, '..', 'netlify', 'functions', 'catalog.json'));

const ORDER = '1a2b3c4d-0000-4000-8000-000000000001';

/* A claimed row as claim_order_notifications returns it, plus fields the
   claim never returns (customer_email, phone), to prove they are not used
   even if they were present. */
function row(over) {
  return Object.assign({
    notification_id: 41, channel: 'email', attempt: 1, order_id: ORDER,
    order_created_at: '2026-10-02T07:13:05.123+00:00', stripe_session_id: 'cs_live_abc123',
    customer_name: 'Jo Bloggs', amount_total: 12345, currency: 'USD',
    shipping_address: { line1: '1 Main St', line2: 'Apt 2', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' },
    research_use_confirmed: true,
    items: [{ kind: 'product', description: 'BPC-157 10 mg', quantity: 2, amount_total: 9000 },
            { kind: 'addon', description: 'Insulated shipper', quantity: 1, amount_total: 1200 }],
    customer_email: 'buyer-private@example.org', phone: '+15551234567'
  }, over || {});
}

/* ------------------------------------------------------------ stubs */

let calls;
let claimRows;
let providers;
let completeError;
let claimError;
function resetStubs() {
  calls = [];
  claimRows = [];
  providers = { postmark: () => ({ status: 200, body: { ErrorCode: 0, MessageID: 'pm-msg-1' } }),
                twilio: () => ({ status: 201, body: { sid: 'SM' + 'c'.repeat(32) } }) };
  completeError = null;
  claimError = null;
}
resetStubs();

global.fetch = async (url, init) => {
  url = String(url);
  init = init || {};
  const call = { url, method: init.method, headers: init.headers || {}, rawBody: init.body };
  calls.push(call);
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  if (url === notify._internals.POSTMARK_URL) {
    call.body = JSON.parse(init.body);
    const r = providers.postmark(call);
    if (r instanceof Error) throw r;
    return reply(r.status, r.body);
  }
  if (url.startsWith(notify._internals.TWILIO_BASE)) {
    call.body = Object.fromEntries(new URLSearchParams(init.body));
    const r = providers.twilio(call);
    if (r instanceof Error) throw r;
    return reply(r.status, r.body);
  }
  throw new Error(`unexpected fetch ${url}`);
};

/* The outbox's two database functions, as the dispatcher's store calls them.
   A refusal is a DbError carrying the database's text, to prove that text is
   never logged. */
const db = require(path.join(__dirname, '..', 'netlify', 'lib', 'db.js'));
const realStore = Object.assign({}, dispatchMod._internals.store);
const dbFailure = () => new db.DbError('database', { code: 'XX000', dbMessage: 'secret db text' });
function stubStore() {
  dispatchMod._internals.store.claim = async (limit, leaseSeconds) => {
    const call = { url: 'db:claim_order_notifications', body: { p_limit: limit, p_lease_seconds: leaseSeconds } };
    calls.push(call);
    if (claimError) throw dbFailure();
    return claimRows;
  };
  dispatchMod._internals.store.complete = async (args) => {
    calls.push({ url: 'db:complete_order_notification', body: args });
    if (completeError) throw dbFailure();
    return args.p_outcome === 'sent' ? 'sent' : 'pending';
  };
}

let logs;
const origLog = console.log;
const origWarn = console.warn;
test.beforeEach(() => {
  setEnv();
  resetStubs();
  stubStore();
  dispatchMod._internals.setCatalog(Object.assign({}, CATALOG, { demo: false }));
  dispatchMod._internals.clock.now = () => Date.now();
  logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
});
test.afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
});

const dispatch = () => dispatchMod.handler({});
const providerCalls = () => calls.filter((c) => !c.url.startsWith('db:'));
const completes = () => calls.filter((c) => c.url === 'db:complete_order_notification').map((c) => c.body);

/* ----------------------------------------------------- configuration */

test('NOTIFY_ENABLED must be exactly "1"', () => {
  for (const [value, enabled] of [['1', true], ['true', false], ['yes', false], ['0', false], [' 1', false], ['1 ', false],
                                  ['', false], [undefined, false], ['TRUE', false]]) {
    const env = Object.assign({}, ENV, { NOTIFY_ENABLED: value });
    if (value === undefined) delete env.NOTIFY_ENABLED;
    assert.equal(notify.configState(env).enabled, enabled, String(value));
  }
});

test('each setting is ok, missing or invalid, and the state never carries the value', () => {
  const ok = notify.configState(ENV);
  assert.equal(ok.email.ready, true);
  assert.equal(ok.sms.ready, true);
  assert.equal(ok.email.POSTMARK_MESSAGE_STREAM, 'default');
  const bad = notify.configState(Object.assign({}, ENV, {
    POSTMARK_SERVER_TOKEN: 'not-a-token', NOTIFY_EMAIL_TO: 'owner at example', TWILIO_ACCOUNT_SID: 'XX1',
    TWILIO_AUTH_TOKEN: 'short', NOTIFY_SMS_TO: '5559998888', POSTMARK_MESSAGE_STREAM: 'Bad Stream'
  }));
  assert.equal(bad.email.ready, false);
  assert.equal(bad.sms.ready, false);
  assert.equal(bad.email.POSTMARK_SERVER_TOKEN, 'invalid');
  assert.equal(bad.email.NOTIFY_EMAIL_TO, 'invalid');
  assert.equal(bad.email.POSTMARK_MESSAGE_STREAM, 'invalid');
  assert.equal(bad.sms.NOTIFY_SMS_TO, 'invalid');
  const none = notify.configState({});
  assert.equal(none.NOTIFY_ENABLED, 'missing');
  assert.equal(none.email.NOTIFY_EMAIL_FROM, 'missing');
  assert.equal(none.sms.sender, 'missing');
  const text = JSON.stringify([ok, bad, none]);
  for (const v of Object.values(ENV)) if (v.length > 2) assert.equal(text.includes(v), false, v);
});

test('SMS needs exactly one sender: a number or a messaging service', () => {
  const svc = 'MG' + 'd'.repeat(32);
  assert.equal(notify.configState(Object.assign({}, ENV, { TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: svc })).sms.sender, 'ok');
  assert.equal(notify.configState(Object.assign({}, ENV, { TWILIO_MESSAGING_SERVICE_SID: svc })).sms.sender, 'invalid');
  assert.equal(notify.configState(Object.assign({}, ENV, { TWILIO_FROM: '+1555' })).sms.sender, 'invalid');
});

/* ------------------------------------------------------------- SMS text */

test('the SMS is exactly the agreed sentence', () => {
  assert.equal(notify.smsText(row(), false), 'New order TR-1A2B3C4D: $123.45 USD, 3 items.');
  assert.equal(notify.smsText(row({ stripe_session_id: 'cs_test_abc' }), false), '[TEST] New order TR-1A2B3C4D: $123.45 USD, 3 items.');
  assert.equal(notify.smsText(row({ items: [{ quantity: 1 }] }), false), 'New order TR-1A2B3C4D: $123.45 USD, 1 item.');
  assert.equal(notify.smsText(row({ items: [] }), false), 'New order TR-1A2B3C4D: $123.45 USD, line items not yet recorded.');
  assert.equal(notify.smsText(row({ amount_total: 5000, currency: 'EUR' }), false), 'New order TR-1A2B3C4D: €50.00 EUR, 3 items.');
  assert.equal(notify.smsText(row({ amount_total: 5000, currency: 'JPY' }), false), 'New order TR-1A2B3C4D: ¥5,000 JPY, 3 items.');
});

test('the SMS carries no personal information whatever the order holds', () => {
  const r = row({ customer_name: 'Zelda Unique-Name', shipping_address: { line1: '742 Evergreen Terrace', city: 'Shelbyville', country: 'US', state: 'OR' } });
  const sms = notify.smsText(r, false);
  for (const s of ['Zelda', 'Evergreen', 'Shelbyville', 'buyer-private', '5551234567', 'OR', 'BPC']) {
    assert.equal(sms.includes(s), false, s);
  }
  assert.match(sms, /^(\[TEST\] )?New order TR-[0-9A-F]{8}: \S+ [A-Z]{3}, (\d+ items?|line items not yet recorded)\.$/);
});

/* ------------------------------------------------------- test labelling */

test('only a cs_live_ session on a non-demo deploy is live; everything else is [TEST]', () => {
  assert.equal(notify.isLive(row({ stripe_session_id: 'cs_live_x' }), false), true);
  for (const id of ['cs_test_x', 'cs_x', '', null, undefined, 'CS_LIVE_x', 'xcs_live_', 'cs_livex']) {
    assert.equal(notify.isLive(row({ stripe_session_id: id }), false), false, String(id));
  }
  assert.equal(notify.isLive(row({ stripe_session_id: 'cs_live_x' }), true), false, 'a demo deploy is never live');
  const m = notify.emailMessage(row({ stripe_session_id: 'cs_test_x' }), false);
  assert.match(m.subject, /^\[TEST\] /);
  assert.match(m.text, /^\*\*\* TEST ORDER - NOT A REAL SALE/);
  const live = notify.emailMessage(row(), false);
  assert.equal(/TEST/.test(live.subject + live.text), false);
});

/* ------------------------------------------------------------- the email */

test('the email holds the agreed details and never the customer\'s email or phone', () => {
  const m = notify.emailMessage(row(), false);
  assert.equal(m.subject, 'New order TR-1A2B3C4D - $123.45 USD');
  for (const s of ['New paid order TR-1A2B3C4D', 'Placed:   2026-10-02 07:13 UTC', 'Customer: Jo Bloggs', 'Total:    $123.45 USD',
                   `Order ID: ${ORDER}`, 'Items (3):', '  2 x BPC-157 10 mg - $90.00 USD', '  1 x Insulated shipper (add-on) - $12.00 USD',
                   'Ship to:', '  1 Main St', '  Apt 2', '  Springfield, IL, 62701', '  US',
                   'Shipping country/state: US / IL', 'Research-use confirmation: confirmed']) {
    assert.ok(m.text.includes(s), s);
  }
  for (const s of ['buyer-private@example.org', '+15551234567', '5551234567', 'Jo Bloggs - $']) {
    assert.equal((m.subject + m.text).includes(s), false, s);
  }
  assert.equal(m.subject.includes('Jo'), false, 'the subject carries no customer detail');
});

test('the email says when lines are missing or research use was not confirmed', () => {
  const m = notify.emailMessage(row({ items: [], research_use_confirmed: false, shipping_address: null, customer_name: null }), false);
  assert.match(m.text, /line details were not yet available/);
  assert.match(m.text, /Research-use confirmation: NOT CONFIRMED/);
  assert.match(m.text, /\(no shipping address recorded\)/);
  assert.match(m.text, /Customer: \(no name given\)/);
});

test('order text is flattened: no control characters, no injected lines', () => {
  const m = notify.emailMessage(row({
    customer_name: 'Jo\r\nBcc: attacker@example.org',
    shipping_address: { line1: 'A\u0000B\u2028C', country: 'USA-TOO-LONG', state: 'IL' },
    items: [{ description: 'X\n\nResearch-use confirmation: confirmed', quantity: 1, amount_total: 1 }],
    research_use_confirmed: false
  }), false);
  assert.equal(m.text.split('\n').filter((l) => l.startsWith('Bcc')).length, 0);
  assert.equal(m.text.split('\n').filter((l) => l.startsWith('Research-use confirmation:')).length, 1);
  assert.match(m.text, /Research-use confirmation: NOT CONFIRMED/);
  assert.ok(m.text.includes('A B C'));
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u2028]/.test(m.text), false);
  assert.equal(/\r|\n/.test(m.subject), false);
});

/* ------------------------------------------------------------- providers */

test('Postmark: the exact request', async () => {
  const r = await notify.sendEmail(row(), ENV, false);
  assert.deepEqual(r, { outcome: 'sent', providerMessageId: 'pm-msg-1', errorCode: null });
  const c = providerCalls()[0];
  assert.equal(c.url, 'https://api.postmarkapp.com/email');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['X-Postmark-Server-Token'], ENV.POSTMARK_SERVER_TOKEN);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(c.body).sort(), ['From', 'MessageStream', 'Metadata', 'Subject', 'Tag', 'TextBody', 'To']);
  assert.equal(c.body.From, ENV.NOTIFY_EMAIL_FROM);
  assert.equal(c.body.To, ENV.NOTIFY_EMAIL_TO);
  assert.equal(c.body.MessageStream, 'outbound');
  assert.deepEqual(c.body.Metadata, { notification_id: '41' });
  await notify.sendEmail(row(), Object.assign({}, ENV, { POSTMARK_MESSAGE_STREAM: 'owner-alerts' }), false);
  assert.equal(providerCalls()[1].body.MessageStream, 'owner-alerts');
});

test('Twilio: the exact request, with a number or a messaging service', async () => {
  const r = await notify.sendSms(row({ channel: 'sms' }), ENV, false);
  assert.equal(r.outcome, 'sent');
  assert.match(r.providerMessageId, /^SM/);
  const c = providerCalls()[0];
  assert.equal(c.url, `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`);
  assert.equal(c.headers.Authorization, `Basic ${Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`).toString('base64')}`);
  assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(c.body, { To: ENV.NOTIFY_SMS_TO, From: ENV.TWILIO_FROM, Body: 'New order TR-1A2B3C4D: $123.45 USD, 3 items.' });
  const svc = 'MG' + 'd'.repeat(32);
  await notify.sendSms(row(), Object.assign({}, ENV, { TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: svc }), false);
  assert.deepEqual(Object.keys(providerCalls()[1].body).sort(), ['Body', 'MessagingServiceSid', 'To']);
});

test('provider answers become sent, retry or failed, with a code and never a message', async () => {
  const cases = [
    ['postmark', 200, { ErrorCode: 0, MessageID: 'abc-1' }, { outcome: 'sent', providerMessageId: 'abc-1', errorCode: null }],
    ['postmark', 200, { ErrorCode: 0 }, { outcome: 'sent', providerMessageId: null, errorCode: null }],
    ['postmark', 200, { MessageID: 'bad id with spaces <x@y>' }, { outcome: 'sent', providerMessageId: null, errorCode: null }],
    ['postmark', 422, { ErrorCode: 406, Message: 'You tried to send to recipient owner-inbox@owner.example' }, { outcome: 'failed', errorCode: 'postmark_422_406' }],
    ['postmark', 422, { ErrorCode: 300 }, { outcome: 'failed', errorCode: 'postmark_422_300' }],
    ['postmark', 401, { ErrorCode: 10 }, { outcome: 'retry', errorCode: 'postmark_401_10' }],
    ['postmark', 429, {}, { outcome: 'retry', errorCode: 'postmark_429' }],
    ['postmark', 500, null, { outcome: 'retry', errorCode: 'postmark_500' }],
    ['postmark', 503, { ErrorCode: 'x; drop' }, { outcome: 'retry', errorCode: 'postmark_503' }],
    ['twilio', 201, { sid: 'SMabc' }, { outcome: 'sent', providerMessageId: 'SMabc', errorCode: null }],
    ['twilio', 400, { code: 21211, message: "The 'To' number +15559998888 is not valid" }, { outcome: 'failed', errorCode: 'twilio_400_21211' }],
    ['twilio', 400, { code: 21610 }, { outcome: 'failed', errorCode: 'twilio_400_21610' }],
    ['twilio', 401, { code: 20003 }, { outcome: 'retry', errorCode: 'twilio_401_20003' }],
    ['twilio', 429, { code: 20429 }, { outcome: 'retry', errorCode: 'twilio_429_20429' }],
    ['twilio', 502, null, { outcome: 'retry', errorCode: 'twilio_502' }]
  ];
  for (const [p, status, b, expected] of cases) {
    resetStubs();
    providers[p] = () => ({ status, body: b });
    const r = p === 'postmark' ? await notify.sendEmail(row(), ENV, false) : await notify.sendSms(row(), ENV, false);
    assert.deepEqual(r, expected, `${p} ${status}`);
    assert.equal(JSON.stringify(r).includes('+1555'), false);
    if (r.errorCode) assert.match(r.errorCode, /^[a-z0-9_]{1,60}$/);
  }
  for (const [err, code] of [[Object.assign(new Error('x'), { name: 'AbortError' }), 'timeout'], [new TypeError('fetch failed'), 'network']]) {
    resetStubs();
    providers.postmark = () => err;
    providers.twilio = () => err;
    assert.deepEqual(await notify.sendEmail(row(), ENV, false), { outcome: 'retry', errorCode: `postmark_${code}` });
    assert.deepEqual(await notify.sendSms(row(), ENV, false), { outcome: 'retry', errorCode: `twilio_${code}` });
  }
});

/* ------------------------------------------------------------ dispatcher */

test('switched off: nothing is claimed and nothing is sent', async () => {
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    setEnv({ NOTIFY_ENABLED: value });
    resetStubs();
    claimRows = [row()];
    const res = await dispatch();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { enabled: false });
    assert.equal(calls.length, 0, String(value));
  }
});

test('enabled without a usable DATABASE_URL: refuses, sends nothing, reaches nothing', async () => {
  Object.assign(dispatchMod._internals.store, realStore);
  for (const value of [undefined, 'not a url', `postgresql://neondb_owner:${DB_PASSWORD}@ep-test.example.invalid/neondb`]) {
    setEnv({ DATABASE_URL: value });
    resetStubs();
    logs = [];
    assert.equal((await dispatch()).statusCode, 500);
    assert.equal(calls.length, 0, String(value));
    assert.deepEqual(JSON.parse(logs[0]), { notify: 'dispatch', outcome: 'not_configured', reason: 'database' });
  }
});

test('a run claims a bounded batch with a lease, sends each on its channel, and reports each outcome', async () => {
  claimRows = [row({ notification_id: 1, channel: 'email' }), row({ notification_id: 2, channel: 'sms' })];
  const res = await dispatch();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { enabled: true, claimed: 2, sent: 2, retry: 0, failed: 0, deferred: 0 });
  const claim = calls[0];
  assert.equal(claim.url, 'db:claim_order_notifications');
  // A small batch within the database's own bound (1-20), and a lease long
  // enough to outlast a run's 20-second budget.
  assert.deepEqual(claim.body, { p_limit: 5, p_lease_seconds: 120 });
  assert.ok(claim.body.p_lease_seconds * 1000 > dispatchMod._internals.BUDGET_MS * 2);
  assert.deepEqual(providerCalls().map((c) => new URL(c.url).hostname), ['api.postmarkapp.com', 'api.twilio.com']);
  assert.deepEqual(completes(), [
    { p_id: 1, p_outcome: 'sent', p_provider_message_id: 'pm-msg-1', p_error_code: null },
    { p_id: 2, p_outcome: 'sent', p_provider_message_id: 'SM' + 'c'.repeat(32), p_error_code: null }
  ]);
  for (const c of calls.filter((x) => x.url.startsWith('db:'))) {
    assert.ok(/^db:(claim_order_notifications|complete_order_notification)$/.test(c.url), c.url);
  }
});

test('failures are reported for retry or as failed, with codes only', async () => {
  claimRows = [row({ notification_id: 1, channel: 'email' }), row({ notification_id: 2, channel: 'sms' })];
  providers.postmark = () => ({ status: 503, body: {} });
  providers.twilio = () => ({ status: 400, body: { code: 21211, message: 'number +15559998888 bad' } });
  const res = JSON.parse((await dispatch()).body);
  assert.deepEqual(res, { enabled: true, claimed: 2, sent: 0, retry: 1, failed: 1, deferred: 0 });
  assert.deepEqual(completes(), [
    { p_id: 1, p_outcome: 'retry', p_provider_message_id: null, p_error_code: 'postmark_503' },
    { p_id: 2, p_outcome: 'failed', p_provider_message_id: null, p_error_code: 'twilio_400_21211' }
  ]);
});

test('a channel that is not fully configured is retried, never sent and never dropped', async () => {
  setEnv({ TWILIO_AUTH_TOKEN: undefined, POSTMARK_SERVER_TOKEN: 'nope' });
  claimRows = [row({ notification_id: 1, channel: 'email' }), row({ notification_id: 2, channel: 'sms' })];
  await dispatch();
  assert.equal(providerCalls().length, 0);
  assert.deepEqual(completes().map((c) => [c.p_outcome, c.p_error_code]), [['retry', 'email_not_configured'], ['retry', 'sms_not_configured']]);
});

test('an unknown channel is failed, not sent', async () => {
  claimRows = [row({ notification_id: 9, channel: 'fax' })];
  await dispatch();
  assert.equal(providerCalls().length, 0);
  assert.deepEqual(completes()[0], { p_id: 9, p_outcome: 'failed', p_provider_message_id: null, p_error_code: 'unknown_channel' });
});

test('a failed claim sends nothing; a failed completion is logged and left to the lease', async () => {
  claimRows = [row()];
  claimError = 500;
  assert.equal((await dispatch()).statusCode, 500);
  assert.equal(providerCalls().length, 0);

  resetStubs();
  claimRows = { not: 'rows' };
  assert.equal((await dispatch()).statusCode, 500);
  assert.equal(providerCalls().length, 0);

  resetStubs();
  claimRows = [row()];
  completeError = 500;
  const res = await dispatch();
  assert.equal(res.statusCode, 200);
  assert.equal(providerCalls().length, 1);
  assert.match(logs.join('\n'), /"status":"complete_failed"/);
});

test('the run stops sending once its time budget is spent; the rest wait for their lease', async () => {
  const start = 1_000_000;
  let now = start;
  dispatchMod._internals.clock.now = () => now;
  claimRows = [row({ notification_id: 1 }), row({ notification_id: 2 }), row({ notification_id: 3 })];
  providers.postmark = () => {
    now += dispatchMod._internals.BUDGET_MS;
    return { status: 200, body: { MessageID: 'm' } };
  };
  const res = JSON.parse((await dispatch()).body);
  assert.equal(res.sent, 1);
  assert.equal(res.deferred, 2);
  assert.equal(providerCalls().length, 1);
  assert.deepEqual(completes().map((c) => c.p_id), [1]);
});

test('test orders are labelled even on a live order id when the deploy is a demo', async () => {
  dispatchMod._internals.setCatalog(Object.assign({}, CATALOG, { demo: true }));
  claimRows = [row({ channel: 'email' }), row({ channel: 'sms', notification_id: 2 })];
  await dispatch();
  assert.match(providerCalls()[0].body.Subject, /^\[TEST\] /);
  assert.match(providerCalls()[1].body.Body, /^\[TEST\] /);
});

test('the dispatcher logs ids, channels, outcomes and codes: never a message, address, name, recipient or key', async () => {
  claimRows = [row({ notification_id: 1, channel: 'email' }), row({ notification_id: 2, channel: 'sms' })];
  providers.twilio = () => ({ status: 400, body: { code: 21211, message: 'To +15559998888 invalid' } });
  await dispatch();
  claimError = 500;
  await dispatch();
  const all = logs.join('\n');
  assert.ok(logs.length >= 3);
  for (const s of ['Jo Bloggs', '1 Main St', 'Springfield', 'BPC-157', 'buyer-private', '5551234567', '5559998888',
                   ENV.NOTIFY_EMAIL_TO, ENV.NOTIFY_EMAIL_FROM, ENV.POSTMARK_SERVER_TOKEN, ENV.TWILIO_AUTH_TOKEN, ENV.TWILIO_ACCOUNT_SID,
                   DB_PASSWORD, 'New order', 'secret db text', 'invalid']) {
    assert.equal(all.includes(s), false, s);
  }
  for (const line of logs) {
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).filter((k) => !['notify', 'id', 'channel', 'outcome', 'code', 'status', 'reason'].includes(k)), []);
  }
});

test('the dispatcher answers with counts only', async () => {
  claimRows = [row()];
  const res = await dispatch();
  assert.equal(res.headers['Cache-Control'], 'no-store');
  for (const s of ['Jo', 'TR-', 'pm-msg', ORDER]) assert.equal(res.body.includes(s), false, s);
});

/* ---------------------------------------------------------------- health */

test('health reports each notification setting as ok, missing or invalid, never its value', async () => {
  const secrets = Object.assign({}, ENV, { STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24) });
  for (const [over, working, enabled] of [
    [{}, true, 'ok'],
    [{ NOTIFY_ENABLED: undefined }, false, 'missing'],
    [{ NOTIFY_ENABLED: 'true' }, false, 'invalid'],
    [{ TWILIO_AUTH_TOKEN: 'zzz' }, false, 'ok']
  ]) {
    setEnv(Object.assign({}, secrets, over));
    const res = await health.handler({});
    const b = JSON.parse(res.body);
    assert.equal(b.notifications.working, working, JSON.stringify(over));
    assert.equal(b.notifications.enabled, enabled);
    assert.ok(b.notifications.note);
    for (const v of Object.values(ENV)) if (v.length > 2) assert.equal(res.body.includes(v), false, v);
    assert.equal(res.body.includes('zzz'), false);
    assert.ok(b.checkout && b.order_records, 'the existing sections are still there');
  }
  setEnv({ TWILIO_AUTH_TOKEN: 'zzz' });
  const b = JSON.parse((await health.handler({})).body);
  assert.equal(b.notifications.sms.TWILIO_AUTH_TOKEN, 'invalid');
  assert.equal(b.notifications.sms.ready, false);
  assert.equal(b.notifications.email.ready, true);
});
