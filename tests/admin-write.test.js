/*
 * The console write API: the POST actions of admin-orders, admin-inventory and
 * admin-expenses, and the rules in netlify/lib/admin-api.js they share.
 *
 *   node --test tests/admin-write.test.js
 *
 * Offline: tokens are signed locally and Supabase is stubbed by
 * tests/helpers/admin-fixtures.js, so what is proven here is what reaches the
 * database: which function, with exactly which arguments, and that p_actor is
 * always the signed-in staff member. That the functions do what those
 * arguments ask, and audit it against that actor, is proven against the real
 * schema in tests/db/console-write-contract.test.mjs.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fx = require('./helpers/admin-fixtures.js');
const api = require(path.join(__dirname, '..', 'netlify', 'lib', 'admin-api.js'));
const CATALOG = require(path.join(__dirname, '..', 'netlify', 'functions', 'catalog.json'));

const mod = (name) => require(path.join(__dirname, '..', 'netlify', 'functions', `${name}.js`));
const fn = (name) => mod(name).handler;
const body = (res) => JSON.parse(res.body);

const ORDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const LOT = 'bbbbbbbb-0000-4000-8000-000000000001';
const EXPENSE = 'cccccccc-0000-4000-8000-000000000001';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/* Every action: where it lives, a valid body, the function and exact
   arguments expected (p_actor is added by the test), what the stubbed
   function returns, and what the API answers. */
const CASES = [
  { endpoint: 'admin-orders', action: 'order.set_status', permission: 'orders.write',
    body: { order_id: ORDER, status: 'processing', note: ' picking today ' },
    fn: 'admin_set_order_status', args: { p_order_id: ORDER, p_status: 'processing', p_note: 'picking today' },
    returns: { id: ORDER, status: 'processing', status_changed_at: 't', email: 'x@y.org', phone: '1', shipping_address: {} },
    result: { order: { id: ORDER, status: 'processing', status_changed_at: 't', carrier: null, tracking_number: null, shipped_at: null } } },
  { endpoint: 'admin-orders', action: 'order.add_note', permission: 'orders.write',
    body: { order_id: ORDER, body: 'Called the customer.\nLeft a message.' },
    fn: 'admin_add_order_note', args: { p_order_id: ORDER, p_body: 'Called the customer.\nLeft a message.' },
    returns: 41, result: { note_id: 41 } },
  { endpoint: 'admin-orders', action: 'order.ship', permission: 'orders.write',
    body: { order_id: ORDER, carrier: 'UPS', tracking_number: '1Z 999-AA1' },
    fn: 'ship_order', args: { p_order_id: ORDER, p_carrier: 'UPS', p_tracking_number: '1Z 999-AA1', p_note: null },
    returns: { id: ORDER, status: 'shipped', carrier: 'UPS', tracking_number: '1Z 999-AA1', shipped_at: 't', status_changed_at: 't' },
    result: { order: { id: ORDER, status: 'shipped', status_changed_at: 't', carrier: 'UPS', tracking_number: '1Z 999-AA1', shipped_at: 't' } } },
  { endpoint: 'admin-orders', action: 'fulfilment.allocate', permission: 'fulfilment.write',
    body: { order_id: ORDER, product_id: 'bpc-157', pack_size: '10 mg', lot_id: LOT, quantity: 2 },
    fn: 'admin_allocate_order_line',
    args: { p_order_id: ORDER, p_product_id: 'bpc-157', p_pack_size: '10 mg', p_lot_id: LOT, p_quantity: 2 },
    returns: 7, result: { allocation_id: 7 } },
  { endpoint: 'admin-orders', action: 'fulfilment.release', permission: 'fulfilment.write',
    body: { allocation_id: 7 }, fn: 'admin_release_allocation', args: { p_allocation_id: 7, p_note: null },
    returns: true, result: { released: true } },
  { endpoint: 'admin-orders', action: 'fulfilment.map_line', permission: 'fulfilment.write',
    body: { order_item_id: 12, product_id: 'bpc-157', pack_size: '10 mg', note: 'Label says BPC-157 10 mg' },
    fn: 'admin_map_order_line',
    args: { p_order_item_id: 12, p_product_id: 'bpc-157', p_pack_size: '10 mg', p_note: 'Label says BPC-157 10 mg' },
    returns: 3, result: { mapping_id: 3 } },
  { endpoint: 'admin-orders', action: 'fulfilment.unmap_line', permission: 'fulfilment.write',
    body: { mapping_id: 3, note: 'Wrong pack size' }, fn: 'admin_unmap_order_line',
    args: { p_mapping_id: 3, p_note: 'Wrong pack size' }, returns: true, result: { unmapped: true } },
  { endpoint: 'admin-inventory', action: 'inventory.receive_lot', permission: 'inventory.write',
    body: { product_id: 'bpc-157', pack_size: '10 mg', lot_number: ' L-2026-01 ', quantity: 100 },
    fn: 'receive_lot',
    args: { p_product_id: 'bpc-157', p_pack_size: '10 mg', p_lot_number: 'L-2026-01', p_quantity: 100, p_retest_date: null,
            p_coa_reference: null, p_unit_cost_cents: null, p_supplier: null, p_notes: null },
    returns: LOT, result: { lot_id: LOT } },
  { endpoint: 'admin-inventory', action: 'inventory.update_item', permission: 'inventory.write',
    body: { product_id: 'bpc-157', pack_size: '10 mg', changes: { low_stock_threshold: 5, active: false, notes: null } },
    fn: 'admin_update_inventory_item',
    args: { p_product_id: 'bpc-157', p_pack_size: '10 mg', p_changes: { low_stock_threshold: 5, active: false, notes: null } },
    returns: { product_id: 'bpc-157', pack_size: '10 mg', low_stock_threshold: 5, active: false, notes: null, created_at: 't' },
    result: { item: { product_id: 'bpc-157', pack_size: '10 mg', low_stock_threshold: 5, active: false, notes: null } } },
  { endpoint: 'admin-inventory', action: 'inventory.update_lot', permission: 'inventory.write',
    body: { lot_id: LOT, changes: { retest_date: '2027-01-31', unit_cost_cents: 450 } },
    fn: 'admin_update_lot', args: { p_lot_id: LOT, p_changes: { retest_date: '2027-01-31', unit_cost_cents: 450 } },
    returns: { id: LOT, lot_number: 'L1', retest_date: '2027-01-31', unit_cost_cents: 450, created_by: 'x' },
    result: { lot: { id: LOT, product_id: null, pack_size: null, lot_number: 'L1', received_on: null, quantity_received: null,
                     retest_date: '2027-01-31', coa_reference: null, unit_cost_cents: 450, currency: null, supplier: null, notes: null } } },
  { endpoint: 'admin-inventory', action: 'inventory.record_movement', permission: 'inventory.write',
    body: { lot_id: LOT, delta: -2, reason: 'write_off', note: 'Two vials cracked' },
    fn: 'admin_record_stock_movement', args: { p_lot_id: LOT, p_delta: -2, p_reason: 'write_off', p_note: 'Two vials cracked' },
    returns: 99, result: { movement_id: 99 } },
  { endpoint: 'admin-inventory', action: 'inventory.sync', permission: 'inventory.write', body: {},
    fn: 'sync_inventory_items', args: { p_items: catalogueItems() },
    returns: [{ added: 3, reactivated: 0, deactivated: 1 }], result: { added: 3, reactivated: 0, deactivated: 1 } },
  { endpoint: 'admin-expenses', action: 'finance.create_expense', permission: 'finance.write',
    body: { incurred_on: '2026-09-30', category_code: 'lab_testing', description: 'HPLC batch', amount_cents: 45000 },
    fn: 'admin_create_expense',
    args: { p_incurred_on: '2026-09-30', p_category_code: 'lab_testing', p_description: 'HPLC batch', p_amount_cents: 45000,
            p_vendor: null, p_reference: null, p_lot_id: null, p_notes: null },
    returns: EXPENSE, result: { expense_id: EXPENSE } },
  { endpoint: 'admin-expenses', action: 'finance.update_expense', permission: 'finance.write',
    body: { expense_id: EXPENSE, changes: { amount_cents: -500, vendor: null } },
    fn: 'admin_update_expense', args: { p_expense_id: EXPENSE, p_changes: { amount_cents: -500, vendor: null } },
    returns: { id: EXPENSE, amount_cents: -500, created_by: 'x', deleted_at: null },
    result: { expense: { id: EXPENSE, incurred_on: null, category_code: null, description: null, amount_cents: -500, currency: null,
                         vendor: null, reference: null, lot_id: null, notes: null, updated_at: null, updated_by: null } } },
  { endpoint: 'admin-expenses', action: 'finance.delete_expense', permission: 'finance.write',
    body: { expense_id: EXPENSE, reason: 'Entered twice' }, fn: 'admin_delete_expense',
    args: { p_expense_id: EXPENSE, p_reason: 'Entered twice' }, returns: true, result: { deleted: true } },
  { endpoint: 'admin-expenses', action: 'finance.restore_expense', permission: 'finance.write',
    body: { expense_id: EXPENSE }, fn: 'admin_restore_expense', args: { p_expense_id: EXPENSE },
    returns: true, result: { restored: true } },
  { endpoint: 'admin-expenses', action: 'finance.stage_import', permission: 'finance.write',
    body: { rows: [{ incurred_on: '2026-01-02', category: 'Software', description: 'Hosting', amount: '12.00' }, { amount: null }] },
    fn: 'admin_stage_expense_import',
    args: { p_rows: [{ incurred_on: '2026-01-02', category: 'Software', description: 'Hosting', amount: '12.00' }, { amount: null }] },
    returns: 2, result: { staged: 2 } },
  { endpoint: 'admin-expenses', action: 'finance.import', permission: 'finance.write', body: {},
    fn: 'admin_import_expenses', args: {},
    returns: [{ imported: 1, duplicates: 0, errors: 1 }], result: { imported: 1, duplicates: 0, errors: 1 } }
];

function catalogueItems() {
  const items = [];
  for (const [id, p] of Object.entries(CATALOG.products)) for (const size of Object.keys(p.prices)) items.push({ product_id: id, pack_size: size });
  return items;
}

const send = (c, extra, opts) => fx.post(fn(c.endpoint), Object.assign({ action: c.action }, c.body, extra || {}), opts);

let logs;
const origWarn = console.warn;
test.beforeEach(() => {
  fx.reset();
  for (const c of CASES) fx.state.rpc[c.fn] = c.returns;
  logs = [];
  console.warn = (...a) => logs.push(a.join(' '));
});
test.afterEach(() => { console.warn = origWarn; });

function refused(res, status, error, extra) {
  assert.equal(res.statusCode, status, res.body);
  assert.deepEqual(body(res), Object.assign({ error }, extra || {}));
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(fx.rpcs().length, 0, 'a database function was called');
}

function resetWithRpc() {
  fx.reset();
  for (const c of CASES) fx.state.rpc[c.fn] = c.returns;
}

/* ---------------------------------------------------- every action */

test('the action lists are exactly the agreed eighteen', () => {
  assert.deepEqual(Object.keys(mod('admin-orders').ACTIONS),
    ['order.set_status', 'order.add_note', 'order.ship', 'fulfilment.allocate', 'fulfilment.release', 'fulfilment.map_line', 'fulfilment.unmap_line']);
  assert.deepEqual(Object.keys(mod('admin-inventory').ACTIONS),
    ['inventory.receive_lot', 'inventory.update_item', 'inventory.update_lot', 'inventory.record_movement', 'inventory.sync']);
  assert.deepEqual(Object.keys(mod('admin-expenses').ACTIONS),
    ['finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.restore_expense', 'finance.stage_import', 'finance.import']);
  assert.equal(CASES.length, 18);
});

test('each action calls exactly its function with exactly its arguments, and p_actor is the session staff id', async () => {
  for (const c of CASES) {
    resetWithRpc();
    const res = await send(c);
    assert.equal(res.statusCode, 200, `${c.action}: ${res.body}`);
    assert.deepEqual(body(res), { action: c.action, result: c.result }, c.action);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    const calls = fx.rpcs();
    assert.equal(calls.length, 1, c.action);
    assert.equal(calls[0].fn, c.fn, c.action);
    assert.deepEqual(calls[0].args, Object.assign({}, c.args, { p_actor: fx.OWNER_STAFF_ID }), c.action);
    assert.equal(calls[0].call.method, 'POST');
    assert.equal(calls[0].call.headers.apikey, fx.SERVICE_KEY);
    assert.equal(fx.reads().length, 0, `${c.action} read a table directly`);
  }
});

test('the permission is checked with staff_can before the function is called', async () => {
  for (const c of CASES) {
    resetWithRpc();
    await send(c);
    const order = fx.state.calls.map((x) => x.url.replace(`${fx.BASE}/rest/v1/`, '')).filter((u) => u.startsWith('rpc/'));
    assert.deepEqual(order, ['rpc/staff_can', `rpc/${c.fn}`], c.action);
    assert.equal(fx.state.calls.find((x) => x.url.endsWith('/rpc/staff_can')).body.p_permission, c.permission);
  }
});

test('without the write permission: 403 and no function is called', async () => {
  for (const c of CASES) {
    resetWithRpc();
    fx.state.permissions.delete(c.permission);
    refused(await send(c), 403, 'not_authorized');
  }
});

test('a read permission is not a write permission', async () => {
  resetWithRpc();
  fx.state.permissions = new Set(['orders.read', 'inventory.read', 'finance.read']);
  for (const c of CASES) refused(await send(c), 403, 'not_authorized');
});

test('authentication failures stop a write before anything is called', async () => {
  for (const c of CASES) {
    for (const [opts, status, error] of [[{ token: null }, 401, 'not_authorized'], [{ token: 'x.y.z' }, 401, 'not_authorized'],
                                         [{ token: fx.token({ aal: 'aal1' }) }, 403, 'mfa_required']]) {
      resetWithRpc();
      const res = await send(c, null, opts);
      assert.equal(res.statusCode, status);
      assert.deepEqual(body(res), { error });
      assert.equal(fx.state.calls.some((x) => x.url.includes('/rpc/')), false);
    }
    resetWithRpc();
    fx.state.staff = [];
    assert.equal((await send(c)).statusCode, 403);
    assert.equal(fx.rpcs().length, 0);
  }
});

const REQUIRED = {
  'order.set_status': ['order_id', 'status'],
  'order.add_note': ['order_id', 'body'],
  'order.ship': ['order_id', 'carrier', 'tracking_number'],
  'fulfilment.allocate': ['order_id', 'product_id', 'pack_size', 'lot_id', 'quantity'],
  'fulfilment.release': ['allocation_id'],
  'fulfilment.map_line': ['order_item_id', 'product_id', 'pack_size', 'note'],
  'fulfilment.unmap_line': ['mapping_id', 'note'],
  'inventory.receive_lot': ['product_id', 'pack_size', 'lot_number', 'quantity'],
  'inventory.update_item': ['product_id', 'pack_size', 'changes'],
  'inventory.update_lot': ['lot_id', 'changes'],
  'inventory.record_movement': ['lot_id', 'delta', 'reason', 'note'],
  'inventory.sync': [],
  'finance.create_expense': ['incurred_on', 'category_code', 'description', 'amount_cents'],
  'finance.update_expense': ['expense_id', 'changes'],
  'finance.delete_expense': ['expense_id', 'reason'],
  'finance.restore_expense': ['expense_id'],
  'finance.stage_import': ['rows'],
  'finance.import': []
};

test('every required field is required: missing or null is refused', async () => {
  for (const c of CASES) {
    const required = REQUIRED[c.action];
    assert.ok(required, c.action);
    for (const k of required) {
      assert.ok(k in c.body, `${c.action}: test body lacks ${k}`);
      resetWithRpc();
      const without = Object.assign({}, c.body);
      delete without[k];
      refused(await fx.post(fn(c.endpoint), Object.assign({ action: c.action }, without)), 400, 'invalid_field', { field: k });
      resetWithRpc();
      refused(await send(c, { [k]: null }), 400, 'invalid_field', { field: k });
    }
  }
});

/* --------------------------------------------------- the actor rule */

const ACTOR_KEYS = ['actor', 'actor_id', 'p_actor', 'staff_id', 'staff', 'user_id', 'auth_user_id', 'sub', 'created_by',
  'author_id', 'author_email', 'mapped_by', 'changed_by', 'updated_by', 'deleted_by', 'allocated_by', 'email'];

test('no body field can name an actor: every actor-like key is refused before the database', async () => {
  for (const c of CASES) {
    for (const k of ACTOR_KEYS) {
      resetWithRpc();
      refused(await send(c, { [k]: OTHER }), 400, 'invalid_field', { field: k });
    }
  }
});

test('nor can a key inside changes', async () => {
  for (const c of CASES.filter((x) => x.body.changes)) {
    for (const k of ['p_actor', 'actor_id', 'updated_by', 'created_by', 'deleted_at', 'id', 'product_id', 'quantity_received']) {
      resetWithRpc();
      refused(await send(c, { changes: Object.assign({}, c.body.changes, { [k]: OTHER }) }), 400, 'invalid_field', { field: `changes.${k}` });
    }
  }
});

test('headers, cookies and query parameters naming someone else change nothing, or are refused', async () => {
  for (const c of CASES) {
    resetWithRpc();
    const res = await send(c, null, { headers: { 'x-staff-id': OTHER, 'x-actor-id': OTHER, 'x-user-id': OTHER,
                                                 'x-forwarded-user': OTHER, cookie: `staff_id=${OTHER}; actor=${OTHER}` } });
    assert.equal(res.statusCode, 200, c.action);
    assert.equal(fx.rpcs()[0].args.p_actor, fx.OWNER_STAFF_ID);
    assert.equal(JSON.stringify(fx.state.calls.map((x) => [x.url, x.body])).includes(OTHER), false);

    resetWithRpc();
    refused(await send(c, null, { query: { actor_id: OTHER } }), 400, 'invalid_parameter', { parameter: 'actor_id' });
    resetWithRpc();
    refused(await send(c, null, { query: { order_id: ORDER } }), 400, 'invalid_parameter', { parameter: 'order_id' });
  }
});

test('a different staff member signed in is the actor, whatever the body says', async () => {
  const otherAuth = '22222222-2222-4222-8222-222222222222';
  resetWithRpc();
  fx.state.staff = [{ id: OTHER, auth_user_id: otherAuth, email: 'second@example.org', role_code: 'owner', active: true }];
  const c = CASES[0];
  await send(c, null, { token: fx.token({ sub: otherAuth }) });
  assert.equal(fx.rpcs()[0].args.p_actor, OTHER);
});

/* ------------------------------------------------------ the request */

test('only application/json is accepted, checked before anything is called', async () => {
  const c = CASES[0];
  for (const type of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x',
                      'application/json; charset=latin1', 'application/jsonx', 'text/json']) {
    resetWithRpc();
    const headers = { authorization: `Bearer ${fx.token()}` };
    if (type !== undefined) headers['content-type'] = type;
    const res = await fn(c.endpoint)({ httpMethod: 'POST', headers, body: JSON.stringify(Object.assign({ action: c.action }, c.body)) });
    assert.equal(res.statusCode, 415, String(type));
    assert.equal(fx.state.calls.length, 0);
  }
  resetWithRpc();
  assert.equal((await send(c, null, { headers: { 'content-type': 'application/json; charset=UTF-8' } })).statusCode, 200);
  resetWithRpc();
  assert.equal((await send(c, null, { headers: { 'Content-Type': 'application/json', 'content-type': 'text/plain' } })).statusCode, 415);
});

test('bodies that are not one JSON object, or name no known action, are refused', async () => {
  const h = fn('admin-orders');
  for (const raw of ['', 'not json', '[]', 'null', '42', '"order.add_note"', '{"action":"order.add_note"']) {
    resetWithRpc();
    const res = await fx.post(h, raw);
    assert.equal(res.statusCode, 400, raw);
    assert.equal(fx.rpcs().length, 0);
  }
  for (const action of [undefined, '', 'nope', 'ORDER.SET_STATUS', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
                        'inventory.sync', 'finance.import', 'order.delete', 42, ['order.add_note']]) {
    resetWithRpc();
    refused(await fx.post(h, { action, order_id: ORDER, body: 'x' }), 400, 'unknown_action');
  }
});

test('an action only works on its own endpoint', async () => {
  for (const c of CASES) {
    for (const other of ['admin-orders', 'admin-inventory', 'admin-expenses'].filter((e) => e !== c.endpoint)) {
      resetWithRpc();
      refused(await fx.post(fn(other), Object.assign({ action: c.action }, c.body)), 400, 'unknown_action');
    }
  }
});

test('read-only endpoints refuse POST', async () => {
  for (const e of ['admin-dashboard', 'admin-financials', 'admin-audit', 'admin-customers']) {
    resetWithRpc();
    const res = await fx.post(fn(e), { action: 'order.add_note', order_id: ORDER, body: 'x' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'GET');
    assert.equal(fx.state.calls.length, 0);
  }
});

test('body size: 64 KB for an action, 1 MB for staging an import, checked before the database', async () => {
  const note = (n) => ({ action: 'order.add_note', order_id: ORDER, body: 'x', pad: 'y'.repeat(n) });
  resetWithRpc();
  refused(await fx.post(fn('admin-orders'), note(api.BODY_LIMIT)), 413, 'body_too_large');
  resetWithRpc();
  const rows = Array.from({ length: 1000 }, () => ({ description: 'z'.repeat(900) }));
  const res = await fx.post(fn('admin-expenses'), { action: 'finance.stage_import', rows });
  assert.equal(res.statusCode, 200, res.body);
  resetWithRpc();
  const huge = JSON.stringify({ action: 'finance.stage_import', rows: [{ description: 'z'.repeat(api.MAX_BODY_LIMIT) }] });
  const big = await fx.post(fn('admin-expenses'), huge);
  assert.equal(big.statusCode, 413);
  assert.equal(fx.state.calls.length, 0, 'an oversized body reached authentication');
});

test('a base64-encoded body is decoded before it is read', async () => {
  const c = CASES[1];
  resetWithRpc();
  const raw = Buffer.from(JSON.stringify(Object.assign({ action: c.action }, c.body))).toString('base64');
  const res = await fx.post(fn(c.endpoint), raw, { base64: true });
  assert.equal(res.statusCode, 200, res.body);
});

/* ----------------------------------------------- field validation */

const BAD = {
  'order.set_status': { order_id: ['x', 1, `${ORDER}x`], status: ['paid', 'shipped', 'PROCESSING', '', 'unknown', 1],
                        note: ['', 'x'.repeat(1001), 'a\u0000b', 5] },
  'order.add_note': { order_id: ['nope'], body: ['', '   ', 'x'.repeat(4001), 'a\u0007b', ['x'], {}] },
  'order.ship': { carrier: ['', 'x'.repeat(61), 'U\nPS', 'U\tPS'], tracking_number: ['', '-1Z', '1Z_99', '1Z/99', 'x'.repeat(101), 5] },
  'fulfilment.allocate': { product_id: ['BPC', 'a,b', ''], pack_size: [' 10 mg', '10,mg', ''], lot_id: ['x'],
                           quantity: [0, -1, 1.5, '2', 100001, null] },
  'fulfilment.release': { allocation_id: [0, -1, 1.5, '7', 2 ** 60] },
  'fulfilment.map_line': { order_item_id: [0, 'x'], note: ['', '  '] },
  'fulfilment.unmap_line': { mapping_id: [0, 'x'], note: [''] },
  'inventory.receive_lot': { lot_number: ['', '  ', 'x'.repeat(81), 'L\n1'], quantity: [0, 1000001, '5'],
                             received_on: ['2026-02-30', 'today', null], retest_date: ['2026-13-01'],
                             unit_cost_cents: [-1, 1.5, '450'], currency: ['usd', 'US', 'USDX'], coa_reference: ['x'.repeat(501), 5] },
  'inventory.update_item': { changes: [{}, [], 'x', { low_stock_threshold: -1 }, { low_stock_threshold: '5' }, { active: 'true' },
                                       { active: null }, { notes: 5 }] },
  'inventory.update_lot': { changes: [{}, { received_on: null }, { received_on: '2026-02-30' }, { currency: 'eur' },
                                      { currency: null }, { unit_cost_cents: -5 }, { quantity_received: 5 }] },
  'inventory.record_movement': { delta: [0, 1.5, '2', 1000001], reason: ['receipt', 'sale', 'release', ''], note: ['', '  '] },
  'finance.create_expense': { incurred_on: ['2026-02-30', '30/09/2026'], category_code: ['Lab Testing', 'a,b', ''],
                              description: ['', 'x'.repeat(501)], amount_cents: [0, 1.5, '450', 2000000001], currency: ['usd'],
                              lot_id: ['x'] },
  'finance.update_expense': { expense_id: ['x'], changes: [{}, { amount_cents: 0 }, { description: '' }, { description: null },
                                                           { incurred_on: null }, { category_code: null }, { deleted_at: null }] },
  'finance.delete_expense': { reason: ['', '   ', 'x'.repeat(501)] },
  'finance.restore_expense': { expense_id: ['', 'x'] },
  'finance.stage_import': { rows: [[], 'x', {}, [null], [[]], [{ amount: 5 }], [{ bogus: 'x' }], [{ amount: 'x'.repeat(1001) }],
                                   Array.from({ length: 5001 }, () => ({}))] }
};

test('every field rejects values the database would refuse or misread', async () => {
  for (const c of CASES) {
    for (const [k, values] of Object.entries(BAD[c.action] || {})) {
      for (const value of values) {
        resetWithRpc();
        const res = await send(c, { [k]: value });
        assert.equal(res.statusCode, 400, `${c.action} ${k}=${JSON.stringify(value).slice(0, 40)}: ${res.body}`);
        assert.equal(body(res).error, 'invalid_field');
        assert.ok(String(body(res).field).startsWith(k), `${c.action} ${k}: ${body(res).field}`);
        assert.equal(fx.rpcs().length, 0);
      }
    }
  }
});

test('receive_lot: optional fields, function defaults kept, retest before receipt refused', async () => {
  const c = CASES.find((x) => x.action === 'inventory.receive_lot');
  resetWithRpc();
  await send(c, { received_on: '2026-09-01', retest_date: '2027-09-01', currency: 'EUR', unit_cost_cents: 0,
                  coa_reference: ' COA-1 ', supplier: 'Acme', notes: 'Cold chain\nOK' });
  assert.deepEqual(fx.rpcs()[0].args, {
    p_product_id: 'bpc-157', p_pack_size: '10 mg', p_lot_number: 'L-2026-01', p_quantity: 100, p_received_on: '2026-09-01',
    p_retest_date: '2027-09-01', p_coa_reference: 'COA-1', p_unit_cost_cents: 0, p_currency: 'EUR', p_supplier: 'Acme',
    p_notes: 'Cold chain\nOK', p_actor: fx.OWNER_STAFF_ID });
  resetWithRpc();
  await send(c);
  assert.equal('p_received_on' in fx.rpcs()[0].args, false, 'received_on default overridden');
  assert.equal('p_currency' in fx.rpcs()[0].args, false, 'currency default overridden');
  resetWithRpc();
  refused(await send(c, { received_on: '2026-09-01', retest_date: '2026-08-01' }), 400, 'invalid_field', { field: 'retest_date' });
});

test('record_movement: a return must add stock and a write-off remove it', async () => {
  const c = CASES.find((x) => x.action === 'inventory.record_movement');
  for (const [reason, delta] of [['return', -1], ['write_off', 3]]) {
    resetWithRpc();
    refused(await send(c, { reason, delta }), 400, 'invalid_field', { field: 'delta' });
  }
  for (const [reason, delta] of [['return', 1], ['write_off', -1], ['adjustment', 4], ['adjustment', -4]]) {
    resetWithRpc();
    assert.equal((await send(c, { reason, delta })).statusCode, 200, `${reason} ${delta}`);
  }
});

test('order.set_status: every status the console may set is accepted', async () => {
  const c = CASES[0];
  for (const status of ['processing', 'packed', 'delivered', 'completed', 'cancelled', 'refunded']) {
    resetWithRpc();
    assert.equal((await send(c, { status })).statusCode, 200, status);
    assert.equal(fx.rpcs()[0].args.p_status, status);
  }
});

/* ------------------------------------------------------- inventory sync */

test('sync sends the whole server catalogue and accepts no input at all', async () => {
  const c = CASES.find((x) => x.action === 'inventory.sync');
  resetWithRpc();
  await send(c);
  const items = fx.rpcs()[0].args.p_items;
  assert.ok(items.length >= 20);
  assert.deepEqual(items, catalogueItems());
  for (const extra of [{ items: [] }, { items: [{ product_id: 'x', pack_size: '1 mg' }] }, { p_items: [] }, { catalogue: {} },
                       { products: {} }]) {
    resetWithRpc();
    refused(await send(c, extra), 400, 'invalid_field', { field: Object.keys(extra)[0] });
  }
});

test('sync keeps products that are not currently for sale: stock existence is not sellability', async () => {
  const inv = mod('admin-inventory');
  const c = CASES.find((x) => x.action === 'inventory.sync');
  try {
    inv._internals.setCatalog({ products: {
      'bpc-157': { buyable: true, prices: { '10 mg': 50 } },
      retatrutide: { buyable: false, prices: { '10 mg': 90, '20 mg': 160 } }
    } });
    resetWithRpc();
    assert.equal((await send(c)).statusCode, 200);
    assert.deepEqual(fx.rpcs()[0].args.p_items, [
      { product_id: 'bpc-157', pack_size: '10 mg' },
      { product_id: 'retatrutide', pack_size: '10 mg' },
      { product_id: 'retatrutide', pack_size: '20 mg' }
    ]);
  } finally {
    inv._internals.setCatalog(CATALOG);
  }
});

test('sync refuses to run on a missing, empty or malformed catalogue', async () => {
  const inv = mod('admin-inventory');
  const c = CASES.find((x) => x.action === 'inventory.sync');
  try {
    for (const bad of [null, {}, { products: {} }, { products: [] }, { products: { 'BAD ID': { prices: { '1 mg': 1 } } } },
                       { products: { ok: { prices: { ' 1 mg': 1 } } } }, { products: { ok: {} } }]) {
      inv._internals.setCatalog(bad);
      resetWithRpc();
      const res = await send(c);
      assert.equal(res.statusCode, 500, JSON.stringify(bad));
      assert.deepEqual(body(res), { error: 'unavailable' });
      assert.equal(fx.rpcs().length, 0);
    }
  } finally {
    inv._internals.setCatalog(CATALOG);
  }
});

/* -------------------------------------------------- database errors */

test('database errors map to statuses; only the migrations\' own sentences are passed on', async () => {
  const c = CASES.find((x) => x.action === 'order.ship');
  const cases = [
    [{ code: '42501', message: 'not authorized' }, 403, { error: 'not_authorized' }],
    [{ code: 'P0002', message: `order ${ORDER} not found` }, 404, { error: 'not_found', message: `order ${ORDER} not found` }],
    [{ code: 'P0002', message: 'relation "x" does not exist' }, 404, { error: 'not_found' }],
    [{ code: '23514', message: `order ${ORDER} is paid; only a packed order can be shipped` }, 422,
      { error: 'rejected', message: `order ${ORDER} is paid; only a packed order can be shipped` }],
    [{ code: '23514', message: 'new row for relation "orders" violates check constraint "orders_status_check"' }, 422,
      { error: 'rejected', message: 'The database refused this change.' }],
    [{ code: '23514', message: 'x'.repeat(301) }, 422, { error: 'rejected', message: 'The database refused this change.' }],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "lots_product_id_pack_size_lot_number_key"' }, 409,
      { error: 'conflict', message: 'That already exists.' }],
    [{ code: '23503', message: 'insert or update on table "lots" violates foreign key constraint' }, 422,
      { error: 'rejected', message: 'It refers to something that does not exist.' }],
    [{ code: '23502', message: 'null value in column "x"' }, 400, { error: 'invalid_input' }],
    [{ code: '22P02', message: 'invalid input syntax' }, 400, { error: 'invalid_input' }],
    [{ code: '22003', message: 'integer out of range' }, 400, { error: 'invalid_input' }],
    [{ code: '40001', message: 'could not serialize' }, 409, { error: 'retry' }],
    [{ code: 'PGRST202', message: 'Could not find the function' }, 500, { error: 'unavailable' }],
    [{ code: 'XX000', message: 'internal' }, 500, { error: 'unavailable' }],
    [{ code: undefined, message: undefined }, 500, { error: 'unavailable' }]
  ];
  for (const [err, status, expected] of cases) {
    resetWithRpc();
    fx.state.rpcErrors.ship_order = Object.assign({ status: 400 }, err);
    const res = await send(c);
    assert.equal(res.statusCode, status, `${err.code}: ${res.body}`);
    assert.deepEqual(body(res), expected, String(err.code));
    assert.equal(/secret-detail|secret-hint|Failing row/.test(res.body), false);
  }
});

test('an unreachable database or a malformed answer fails closed', async () => {
  const c = CASES.find((x) => x.action === 'order.set_status');
  resetWithRpc();
  fx.state.rpc.admin_set_order_status = 'not a row';
  assert.equal((await send(c)).statusCode, 500);
  const sync = CASES.find((x) => x.action === 'inventory.sync');
  for (const r of [[], [{}, {}], null, {}]) {
    resetWithRpc();
    fx.state.rpc.sync_inventory_items = r;
    assert.equal((await send(sync)).statusCode, 500, JSON.stringify(r));
  }
  resetWithRpc();
  fx.state.errors.staff_can = { status: 500, code: 'XX000' };
  refused(await send(c), 500, 'unavailable');
});

test('returned rows are cut down to the agreed fields: no customer details leak from a write', async () => {
  const c = CASES[0];
  resetWithRpc();
  const res = await send(c);
  for (const k of ['email', 'phone', 'shipping_address', 'name', 'stripe_session_id']) assert.equal(res.body.includes(`"${k}"`), false, k);
});

test('logs carry codes only: never a body value, token, key or database text', async () => {
  const c = CASES.find((x) => x.action === 'order.add_note');
  const tok = fx.token();
  resetWithRpc();
  fx.state.rpcErrors.admin_add_order_note = { status: 500, code: 'XX000', message: 'boom secret_table' };
  await send(c, { body: 'Customer phone is 555-0100' }, { token: tok });
  resetWithRpc();
  fx.state.permissions.clear();
  await send(c, { body: 'Customer phone is 555-0100' }, { token: tok });
  const all = logs.join('\n');
  assert.ok(logs.length >= 2);
  for (const s of ['555-0100', tok.split('.')[2], fx.SERVICE_KEY, 'secret_table']) assert.equal(all.includes(s), false, s);
});

/* ---------------------------------------------------- library pieces */

test('operatorMessage passes the migrations\' sentences and stops generated ones', () => {
  const m = api._internals.operatorMessage;
  assert.equal(m('a stock movement needs a note saying why'), 'a stock movement needs a note saying why');
  assert.equal(m('lot L1: only 3 on hand, cannot remove 5'), 'lot L1: only 3 on hand, cannot remove 5');
  for (const generated of ['new row for relation "lots" violates check constraint "lots_currency_check"',
                           'duplicate key value violates unique constraint "x"', 'null value in column "x" violates not-null constraint',
                           'column "x" does not exist', 'permission denied for table orders', '', null, 5, 'x'.repeat(301)]) {
    assert.equal(m(generated), null, String(generated));
  }
});
