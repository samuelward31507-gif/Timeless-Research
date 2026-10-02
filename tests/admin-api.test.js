/*
 * The console read API's shared rules, checked against every endpoint:
 * netlify/lib/admin-api.js and the netlify/functions/admin-*.js that use it.
 *
 *   node --test tests/admin-api.test.js
 *
 * Offline: tokens are signed locally and Supabase (key set, staff lookup,
 * staff_can, PostgREST) is stubbed by tests/helpers/admin-fixtures.js. What
 * the database returns for these queries is covered by
 * tests/db/console-api-contract.test.mjs.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fx = require('./helpers/admin-fixtures.js');
const api = require(path.join(__dirname, '..', 'netlify', 'lib', 'admin-api.js'));

const fn = (name) => require(path.join(__dirname, '..', 'netlify', 'functions', `${name}.js`)).handler;

/* Every endpoint, the permission it needs, and one valid request per mode. */
const ENDPOINTS = [
  { name: 'admin-dashboard', permission: 'orders.read', requests: [{}] },
  { name: 'admin-orders', permission: 'orders.read', requests: [{}, { id: 'aaaaaaaa-0000-4000-8000-000000000001' }] },
  { name: 'admin-inventory', permission: 'inventory.read',
    requests: [{}, { product_id: 'bpc-157', pack_size: '10 mg' }, { lot_id: 'bbbbbbbb-0000-4000-8000-000000000001' }] },
  { name: 'admin-expenses', permission: 'finance.read',
    requests: [{}, { id: 'cccccccc-0000-4000-8000-000000000001' }, { view: 'import' }] },
  { name: 'admin-financials', permission: 'finance.read', requests: [{}] },
  { name: 'admin-audit', permission: 'audit.read', requests: [{}] },
  { name: 'admin-customers', permission: 'customers.read', requests: [{}, { email: 'a@example.org' }] }
];

/* Rows so that the single-record modes find their record. */
function seed() {
  fx.state.tables = {
    orders: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001' }],
    inventory_items: [{ product_id: 'bpc-157', pack_size: '10 mg' }],
    lots: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001' }],
    expenses: [{ id: 'cccccccc-0000-4000-8000-000000000001' }],
    customer_aggregates: [{ customer_email: 'a@example.org' }]
  };
}

let logs;
const origWarn = console.warn;
test.beforeEach(() => {
  fx.reset();
  seed();
  logs = [];
  console.warn = (...a) => logs.push(a.join(' '));
});
test.afterEach(() => { console.warn = origWarn; });

const body = (res) => JSON.parse(res.body);

function noStore(res) {
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Content-Type'], 'application/json');
}

/* ------------------------------------------------------- happy path */

test('every endpoint answers a valid owner request with 200 and no-store', async () => {
  for (const e of ENDPOINTS) {
    for (const q of e.requests) {
      fx.reset(); seed();
      const res = await fx.request(fn(e.name), q);
      assert.equal(res.statusCode, 200, `${e.name} ${JSON.stringify(q)}: ${res.body}`);
      noStore(res);
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    }
  }
});

/* ------------------------------------------------------------ method */

const WRITERS = ['admin-orders', 'admin-inventory', 'admin-expenses'];

test('read-only endpoints accept only GET; the three that write accept GET and POST; a refused method touches nothing', async () => {
  for (const e of ENDPOINTS) {
    const writes = WRITERS.includes(e.name);
    const refused = ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].concat(writes ? [] : ['POST']);
    for (const method of refused) {
      fx.reset();
      const res = await fx.request(fn(e.name), {}, { method, body: { action: 'x' },
                                                     headers: { 'content-type': 'application/json' } });
      assert.equal(res.statusCode, 405, `${e.name} ${method}`);
      assert.equal(res.headers.Allow, writes ? 'GET, POST' : 'GET');
      noStore(res);
      assert.equal(fx.state.calls.length, 0, `${e.name} ${method} made a call`);
    }
    assert.equal((await fn(e.name)(undefined)).statusCode, 405);
  }
});

/* -------------------------------------------------------- authentication */

test('authentication failures are passed through and nothing is read', async () => {
  const cases = [
    [{ token: null }, 401, 'not_authorized'],
    [{ token: 'not.a.token' }, 401, 'not_authorized'],
    [{ token: fx.token({ exp: Math.floor(Date.now() / 1000) - 3600 }) }, 401, 'not_authorized'],
    [{ token: fx.token({ aal: 'aal1' }) }, 403, 'mfa_required']
  ];
  for (const e of ENDPOINTS) {
    for (const [opts, status, error] of cases) {
      fx.reset();
      const res = await fx.request(fn(e.name), e.requests[0], opts);
      assert.equal(res.statusCode, status, `${e.name}`);
      assert.deepEqual(body(res), { error });
      assert.equal(fx.reads().length, 0);
      assert.equal(fx.state.calls.some((c) => c.url.includes('/rpc/')), false);
    }
    for (const staff of [[], [Object.assign({}, fx.state.staff[0], { active: false })]]) {
      fx.reset();
      fx.state.staff = staff;
      const res = await fx.request(fn(e.name), e.requests[0]);
      assert.equal(res.statusCode, 403);
      assert.equal(fx.reads().length, 0);
    }
  }
});

/* ------------------------------------------------------- permissions */

test('each endpoint checks its permission with staff_can for the session staff id', async () => {
  for (const e of ENDPOINTS) {
    fx.reset(); seed();
    await fx.request(fn(e.name), e.requests[0]);
    const checks = fx.state.calls.filter((c) => c.url.endsWith('/rpc/staff_can'));
    assert.ok(checks.length >= 1, e.name);
    assert.equal(checks[0].body.p_permission, e.permission, e.name);
    for (const c of checks) {
      assert.deepEqual(Object.keys(c.body).sort(), ['p_actor', 'p_permission']);
      assert.equal(c.body.p_actor, fx.OWNER_STAFF_ID);
      assert.equal(c.method, 'POST');
      assert.equal(c.headers.apikey, fx.SERVICE_KEY);
    }
  }
});

test('without the permission: 403, and nothing is read', async () => {
  for (const e of ENDPOINTS) {
    for (const q of e.requests) {
      fx.reset(); seed();
      fx.state.permissions.delete(e.permission);
      const res = await fx.request(fn(e.name), q);
      assert.equal(res.statusCode, 403, `${e.name} ${JSON.stringify(q)}`);
      assert.deepEqual(body(res), { error: 'not_authorized' });
      noStore(res);
      assert.equal(fx.reads().length, 0, `${e.name} read without permission`);
    }
  }
});

test('the permission is checked before parameters, so a refused caller learns nothing about them', async () => {
  for (const e of ENDPOINTS) {
    fx.reset();
    fx.state.permissions.delete(e.permission);
    const res = await fx.request(fn(e.name), { bogus: '1' });
    assert.equal(res.statusCode, 403, e.name);
  }
});

test('a failing staff_can fails closed', async () => {
  for (const e of ENDPOINTS) {
    fx.reset();
    fx.state.errors.staff_can = { status: 500, code: 'XX000' };
    const res = await fx.request(fn(e.name), e.requests[0]);
    assert.equal(res.statusCode, 500, e.name);
    assert.deepEqual(body(res), { error: 'unavailable' });
    assert.equal(fx.reads().length, 0);
  }
});

/* --------------------------------------------- the actor and the request */

test('no request parameter can carry an actor: actor-like parameters are refused', async () => {
  for (const e of ENDPOINTS) {
    for (const name of ['actor', 'actor_id', 'p_actor', 'staff_id', 'user_id', 'auth_user_id', 'sub']) {
      fx.reset(); seed();
      const res = await fx.request(fn(e.name), Object.assign({}, e.requests[0], { [name]: fx.OWNER_STAFF_ID }));
      assert.equal(res.statusCode, 400, `${e.name} accepted ${name}`);
      assert.deepEqual(body(res), { error: 'invalid_parameter', parameter: name });
      assert.equal(fx.reads().length, 0);
    }
  }
});

test('headers and a body naming another staff member change nothing', async () => {
  const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const e of ENDPOINTS) {
    fx.reset(); seed();
    const res = await fx.request(fn(e.name), e.requests[0], {
      headers: { 'x-staff-id': other, 'x-actor-id': other, 'x-user-id': other, cookie: `staff=${other}` },
      body: { actor_id: other, staff_id: other }
    });
    assert.equal(res.statusCode, 200, e.name);
    for (const c of fx.state.calls) {
      assert.equal(c.url.includes(other), false, `${e.name}: ${c.url}`);
      if (c.body) assert.equal(JSON.stringify(c.body).includes(other), false);
    }
  }
});

/* -------------------------------------------------------- parameters */

test('unknown and repeated parameters are refused', async () => {
  for (const e of ENDPOINTS) {
    fx.reset(); seed();
    let res = await fx.request(fn(e.name), { select: '*' });
    assert.equal(res.statusCode, 400, e.name);
    assert.equal(body(res).parameter, 'select');
    fx.reset(); seed();
    res = await fx.request(fn(e.name), { order: 'phone.asc' });
    assert.equal(res.statusCode, 400);
    fx.reset(); seed();
    res = await fx.request(fn(e.name), { limit: '5' }, { multi: { limit: ['5', '6'] } });
    assert.equal(res.statusCode, 400, `${e.name} repeated`);
    assert.equal(fx.reads().length, 0);
  }
});

test('an unknown parameter name is echoed back only as a short string', async () => {
  const res = await fx.request(fn('admin-audit'), { ['x'.repeat(500)]: '1' });
  assert.equal(res.statusCode, 400);
  assert.ok(body(res).parameter.length <= 40);
});

test('limit is bounded', async () => {
  for (const e of ['admin-orders', 'admin-expenses', 'admin-audit', 'admin-customers']) {
    for (const limit of ['0', '-1', '101', '1.5', 'abc', '', '01', '99999']) {
      fx.reset();
      const res = await fx.request(fn(e), { limit });
      assert.equal(res.statusCode, 400, `${e} limit=${limit}`);
      assert.equal(body(res).parameter, 'limit');
    }
    fx.reset();
    await fx.request(fn(e), { limit: '100' });
    const r = fx.reads().find((x) => fx.param(x, 'limit').length);
    assert.equal(fx.param(r, 'limit')[0], '101');
  }
});

test('cursors the API did not issue are refused', async () => {
  const enc = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  const bad = {
    'admin-orders': [enc(['2026-01-01T00:00:00Z']), enc(['2026-01-01T00:00:00Z', 'x']), enc(['2026-01-01T00:00:00Z")', 'aaaaaaaa-0000-4000-8000-000000000001']),
                     enc(['not a time', 'aaaaaaaa-0000-4000-8000-000000000001'])],
    'admin-expenses': [enc(['2026-02-30', 'aaaaaaaa-0000-4000-8000-000000000001']), enc([1, 2])],
    'admin-audit': [enc([0]), enc([-5]), enc(['5']), enc([1.5]), enc([2 ** 60]), enc([5, 6]), enc([])],
    'admin-customers': [enc([0]), enc([10001]), enc(['10'])]
  };
  const common = ['%%%', 'a'.repeat(600), enc('not json'), enc({ a: 1 }), enc(null), '!!'];
  for (const [e, cursors] of Object.entries(bad)) {
    for (const cursor of cursors.concat(common)) {
      fx.reset();
      const res = await fx.request(fn(e), { cursor });
      assert.equal(res.statusCode, 400, `${e} cursor ${cursor.slice(0, 40)}`);
      assert.deepEqual(body(res), { error: 'invalid_parameter', parameter: 'cursor' });
      assert.equal(fx.reads().length, 0);
    }
  }
});

/* ------------------------------------------------------ what is read */

test('every read names its columns; nothing selects *', async () => {
  for (const e of ENDPOINTS) {
    for (const q of e.requests) {
      fx.reset(); seed();
      await fx.request(fn(e.name), q);
      for (const r of fx.reads()) {
        const sel = fx.param(r, 'select');
        assert.equal(sel.length, 1, `${e.name} ${r.table}`);
        assert.match(sel[0], /^[a-z_0-9]+(,[a-z_0-9]+)*$/, `${e.name} ${r.table} select=${sel[0]}`);
      }
    }
  }
});

test('reads use the service key, sent only to Supabase; it never appears in a response', async () => {
  for (const e of ENDPOINTS) {
    for (const q of e.requests) {
      fx.reset(); seed();
      const res = await fx.request(fn(e.name), q);
      assert.equal(res.body.includes(fx.SERVICE_KEY), false);
      assert.equal(JSON.stringify(res.headers).includes(fx.SERVICE_KEY), false);
      for (const r of fx.reads()) {
        assert.ok(r.url.startsWith(`${fx.BASE}/rest/v1/`));
        assert.equal(r.call.method, 'GET');
        assert.equal(r.call.headers.apikey, fx.SERVICE_KEY);
      }
    }
  }
});

test('lists never select a phone number or an address', async () => {
  const lists = [['admin-orders', {}], ['admin-customers', {}], ['admin-customers', { email: 'a@example.org' }],
                 ['admin-dashboard', {}], ['admin-audit', {}], ['admin-expenses', {}]];
  for (const [e, q] of lists) {
    fx.reset(); seed();
    await fx.request(fn(e), q);
    for (const r of fx.reads()) {
      const sel = fx.param(r, 'select')[0].split(',');
      for (const col of ['phone', 'shipping_address']) assert.equal(sel.includes(col), false, `${e} ${r.table} selects ${col}`);
    }
  }
});

/* --------------------------------------------------- database errors */

test('database errors map to fixed codes and never pass the database message on', async () => {
  const cases = [['42501', 403, 'not_authorized'], ['P0002', 404, 'not_found'], ['22P02', 400, 'invalid_input'],
                 ['22007', 400, 'invalid_input'], ['XX000', 500, 'unavailable'], ['PGRST301', 500, 'unavailable'],
                 [undefined, 500, 'unavailable']];
  for (const [code, status, error] of cases) {
    fx.reset(); seed();
    fx.state.errors.order_queue = { status: 400, code };
    const res = await fx.request(fn('admin-orders'), {});
    assert.equal(res.statusCode, status, String(code));
    assert.deepEqual(body(res), { error });
    noStore(res);
    assert.equal(/secret_table|violates|internal/.test(res.body), false);
  }
});

test('an unreachable database or a malformed answer fails closed', async () => {
  fx.state.down = true;
  let res = await fx.request(fn('admin-audit'), {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(body(res), { error: 'unavailable' });
  fx.reset();
  fx.state.tables.admin_audit_log = { not: 'an array' };
  res = await fx.request(fn('admin-audit'), {});
  assert.equal(res.statusCode, 500);
  fx.reset();
  fx.state.tables.admin_audit_log = () => { throw new Error('boom'); };
  res = await fx.request(fn('admin-audit'), {});
  assert.equal(res.statusCode, 500);
});

test('logs carry codes only: no token, key or database text', async () => {
  const tok = fx.token();
  fx.state.errors.order_queue = { status: 500, code: 'XX000' };
  await fx.request(fn('admin-orders'), {}, { token: tok });
  fx.reset();
  fx.state.permissions.clear();
  await fx.request(fn('admin-orders'), {}, { token: tok });
  const all = logs.join('\n');
  assert.ok(logs.length >= 2);
  assert.equal(all.includes(tok.split('.')[2]), false);
  assert.equal(all.includes(fx.SERVICE_KEY), false);
  assert.equal(/secret_table|violates/.test(all), false);
});

/* ------------------------------------------------- library pieces */

test('readParams refuses a parameter whose single and multi values disagree', () => {
  assert.throws(() => api._internals.readParams({ queryStringParameters: { a: '1' }, multiValueQueryStringParameters: { a: ['2'] } }, ['a']));
  assert.deepEqual(api._internals.readParams({ queryStringParameters: { a: '1' }, multiValueQueryStringParameters: { a: ['1'] } }, ['a']), { a: '1' });
});

test('validators', () => {
  const { v } = api;
  assert.equal(v.uuid('AAAAAAAA-0000-4000-8000-000000000001', 'id'), 'aaaaaaaa-0000-4000-8000-000000000001');
  for (const bad of ['', 'x', 'aaaaaaaa-0000-4000-8000-00000000000g', ' aaaaaaaa-0000-4000-8000-000000000001']) {
    assert.throws(() => v.uuid(bad, 'id'));
  }
  assert.equal(v.date('2024-02-29', 'd'), '2024-02-29');
  for (const bad of ['2023-02-29', '2024-13-01', '2024-1-1', '20240101', '2024-01-01T00:00:00Z']) assert.throws(() => v.date(bad, 'd'));
  assert.equal(v.month('2026-03', 'm'), '2026-03-01');
  for (const bad of ['2026-3', '2026-13', '2026-03-01']) assert.throws(() => v.month(bad, 'm'));
  assert.equal(v.flag(undefined, 'f'), false);
  assert.equal(v.flag('1', 'f'), true);
  for (const bad of ['true', '0', 'yes', '']) assert.throws(() => v.flag(bad, 'f'));
  assert.equal(v.productId('bpc-157-tb-500-blend', 'p'), 'bpc-157-tb-500-blend');
  for (const bad of ['BPC', 'bpc_157', 'bpc-', '-bpc', 'a,b', 'a)']) assert.throws(() => v.productId(bad, 'p'));
  assert.equal(v.packSize('3 mL x 3 vials', 'p'), '3 mL x 3 vials');
  for (const bad of [' 10 mg', '10,mg', '10mg)', '10"mg', 'x'.repeat(41)]) assert.throws(() => v.packSize(bad, 'p'));
});

test('a cursor round-trips, and the keyset filter quotes only validated values', () => {
  const c = api.encodeCursor(['2026-10-02T07:13:00.123456+00:00', 'aaaaaaaa-0000-4000-8000-000000000001']);
  const back = api.decodeCursor(c, ['timestamp', 'uuid']);
  assert.deepEqual(back, ['2026-10-02T07:13:00.123456+00:00', 'aaaaaaaa-0000-4000-8000-000000000001']);
  assert.equal(api.afterDesc('created_at', 'order_id', back),
    '(created_at.lt."2026-10-02T07:13:00.123456+00:00",and(created_at.eq."2026-10-02T07:13:00.123456+00:00",order_id.lt."aaaaaaaa-0000-4000-8000-000000000001"))');
});
