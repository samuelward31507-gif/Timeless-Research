/*
 * The console read API, endpoint by endpoint: what each one reads, how its
 * parameters become PostgREST filters, and what it returns.
 *
 *   node --test tests/admin-read.test.js
 *
 * Offline, with Supabase stubbed by tests/helpers/admin-fixtures.js. The
 * shared rules (method, authentication, permission, error mapping, headers)
 * are in tests/admin-api.test.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fx = require('./helpers/admin-fixtures.js');
const { decodeCursor, encodeCursor } = require(path.join(__dirname, '..', 'netlify', 'lib', 'admin-api.js'));

const fn = (name) => require(path.join(__dirname, '..', 'netlify', 'functions', `${name}.js`)).handler;
const get = (name, q, opts) => fx.request(fn(name), q, opts);
const body = (res) => JSON.parse(res.body);

const ORDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LOT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const EXPENSE_ID = 'cccccccc-0000-4000-8000-000000000001';

test.beforeEach(() => fx.reset());

function assert400(res, parameter) {
  assert.equal(res.statusCode, 400, res.body);
  assert.deepEqual(body(res), { error: 'invalid_parameter', parameter });
}

const filters = (r) => r.params.filter(([k]) => !['select'].includes(k));

/* ------------------------------------------------------------ dashboard */

test('dashboard: every status counted, with sections by permission', async () => {
  fx.state.tables.dashboard_status_counts = [{ status: 'paid', orders: 3 }, { status: 'shipped', orders: 1 }];
  fx.state.tables.dashboard_summary = [{ orders_needing_attention: 2, revenue_today_cents: 500, revenue_7d_cents: 900,
    revenue_30d_cents: 1000, orders_today: 1, orders_7d: 2, average_order_30d_cents: 450, currencies: 1,
    fees_and_tax_separated: false, low_stock_items: 4, lots_retest_due_30d: 1, lots_retest_overdue: 0 }];
  const b = body(await get('admin-dashboard', {}));
  assert.deepEqual(b.orders.status_counts.map((s) => s.status),
    ['paid', 'processing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded']);
  assert.equal(b.orders.status_counts[0].orders, 3);
  assert.equal(b.orders.status_counts[1].orders, 0);
  assert.equal(b.orders.orders_needing_attention, 2);
  assert.equal(b.finance.revenue_30d_cents, 1000);
  assert.equal(b.finance.fees_and_tax_separated, false);
  assert.equal(b.inventory.low_stock_items, 4);
});

test('dashboard: without finance.read or inventory.read those sections are neither read nor returned', async () => {
  fx.state.permissions.delete('finance.read');
  fx.state.permissions.delete('inventory.read');
  fx.state.tables.dashboard_summary = [{ orders_needing_attention: 0, revenue_30d_cents: 999 }];
  const b = body(await get('admin-dashboard', {}));
  assert.deepEqual(Object.keys(b), ['orders']);
  const sel = fx.param(fx.readOf('dashboard_summary'), 'select')[0];
  assert.equal(sel, 'orders_needing_attention');
});

test('dashboard: takes no parameters', async () => {
  assert400(await get('admin-dashboard', { limit: '5' }), 'limit');
});

/* ---------------------------------------------------------- order queue */

test('order queue: default read, newest first, one extra row for paging', async () => {
  await get('admin-orders', {});
  const r = fx.readOf('order_queue');
  assert.deepEqual(filters(r), [['order', 'created_at.desc,order_id.desc'], ['limit', '51']]);
  assert.equal(fx.param(r, 'select')[0],
    'order_id,created_at,status,in_status_since,name,email,reference,currency,amount_total,carrier,tracking_number,shipped_at,delivered_at,product_lines,product_units,unmapped_lines,addon_lines,unallocated_units,note_count,last_note_at,attention_reason');
});

test('order queue: status and attention filters', async () => {
  await get('admin-orders', { status: 'packed', attention: '1' });
  const r = fx.readOf('order_queue');
  assert.deepEqual(fx.param(r, 'status'), ['eq.packed']);
  assert.deepEqual(fx.param(r, 'attention_reason'), ['not.is.null']);
  for (const status of ['PAID', 'unknown', 'paid,shipped', '']) {
    fx.reset();
    assert400(await get('admin-orders', { status }), 'status');
  }
  assert400(await get('admin-orders', { attention: 'true' }), 'attention');
});

test('order queue: search is a quoted contains-match on name or email', async () => {
  await get('admin-orders', { q: '  Zoë O\'Neil-Smith ' });
  assert.deepEqual(fx.param(fx.readOf('order_queue'), 'or'), ['(name.ilike."*Zoë O\'Neil-Smith*",email.ilike."*Zoë O\'Neil-Smith*")']);
  fx.reset();
  await get('admin-orders', { q: 'jo.b+x@example.org' });
  assert.deepEqual(fx.param(fx.readOf('order_queue'), 'or'), ['(name.ilike."*jo.b+x@example.org*",email.ilike."*jo.b+x@example.org*")']);
});

test('order queue: search text that could change the filter is refused', async () => {
  for (const q of ['a,b', 'a)', '(a', 'a"b', 'a\\b', 'a*', 'a%', 'x', 'a'.repeat(61), 'a;b', 'a\nb', 'a.ilike.*,status.eq.paid']) {
    fx.reset();
    assert400(await get('admin-orders', { q }), 'q');
    assert.equal(fx.reads().length, 0);
  }
});

test('order queue: next_cursor and the keyset filter it produces', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    order_id: `aaaaaaaa-0000-4000-8000-00000000000${i}`, created_at: `2026-10-0${3 - i}T10:00:00.5+00:00` }));
  fx.state.tables.order_queue = rows;
  const b = body(await get('admin-orders', { limit: '2' }));
  assert.equal(b.orders.length, 2);
  assert.deepEqual(decodeCursor(b.next_cursor, ['timestamp', 'uuid']), [rows[1].created_at, rows[1].order_id]);

  fx.reset();
  fx.state.tables.order_queue = rows.slice(2);
  const b2 = body(await get('admin-orders', { limit: '2', cursor: b.next_cursor, status: 'paid' }));
  assert.equal(b2.next_cursor, null);
  const r = fx.readOf('order_queue');
  assert.deepEqual(fx.param(r, 'and'),
    [`(or(created_at.lt."${rows[1].created_at}",and(created_at.eq."${rows[1].created_at}",order_id.lt."${rows[1].order_id}")))`]);
  assert.deepEqual(fx.param(r, 'status'), ['eq.paid']);
});

test('order queue: search and cursor combine without clashing', async () => {
  const cursor = encodeCursor(['2026-10-01T00:00:00Z', ORDER_ID]);
  await get('admin-orders', { q: 'smith', cursor });
  const r = fx.readOf('order_queue');
  assert.equal(fx.param(r, 'or').length, 1);
  assert.equal(fx.param(r, 'and').length, 1);
});

/* --------------------------------------------------------- order detail */

function seedOrder() {
  fx.state.tables = {
    orders: [{ id: ORDER_ID, name: 'Jo', phone: '+15550000', shipping_address: { line1: '1 St' } }],
    order_items: [{ id: 1, kind: 'product', description: 'BPC-157 10 mg', quantity: 2 }],
    order_status_history: [{ id: 1, to_status: 'paid' }],
    order_notes: [{ id: 1, body: 'hi' }],
    order_line_lots: [{ id: 9, lot_id: LOT_ID, quantity: 2 }],
    order_line_mappings: [],
    order_queue: [{ attention_reason: null, unmapped_lines: 0, unallocated_units: 0 }],
    order_cogs: [{ cogs_cents: 800, units_ordered: 2, units_costed: 2, cost_complete: true }]
  };
}

test('order detail: the whole order, each part read by order id with explicit columns', async () => {
  seedOrder();
  const res = await get('admin-orders', { id: ORDER_ID.toUpperCase() });
  assert.equal(res.statusCode, 200);
  const b = body(res);
  assert.equal(b.order.phone, '+15550000');
  assert.deepEqual(b.order.shipping_address, { line1: '1 St' });
  assert.equal(b.items.length, 1);
  assert.equal(b.history.length, 1);
  assert.equal(b.notes.length, 1);
  assert.equal(b.allocations.length, 1);
  assert.deepEqual(b.mappings, []);
  assert.deepEqual(b.attention, { attention_reason: null, unmapped_lines: 0, unallocated_units: 0 });
  assert.equal(b.cost.cogs_cents, 800);

  assert.deepEqual(fx.param(fx.readOf('orders'), 'id'), [`eq.${ORDER_ID}`]);
  const orderSel = fx.param(fx.readOf('orders'), 'select')[0].split(',');
  assert.equal(orderSel.includes('stripe_payment_intent'), false);
  for (const t of ['order_items', 'order_status_history', 'order_notes', 'order_line_lots', 'order_line_mappings']) {
    const r = fx.readOf(t);
    assert.deepEqual(fx.param(r, 'order_id'), [`eq.${ORDER_ID}`], t);
    assert.deepEqual(fx.param(r, 'limit'), ['200'], t);
  }
});

test('order detail: cost of goods only with finance.read', async () => {
  seedOrder();
  fx.state.permissions.delete('finance.read');
  const b = body(await get('admin-orders', { id: ORDER_ID }));
  assert.equal('cost' in b, false);
  assert.equal(fx.reads().some((r) => r.table === 'order_cogs'), false);
});

test('order detail: a bad or extra parameter is refused, and a missing order is 404', async () => {
  for (const id of ['', 'x', `${ORDER_ID}x`, `${ORDER_ID},${ORDER_ID}`]) {
    fx.reset();
    assert400(await get('admin-orders', { id }), 'id');
  }
  assert400(await get('admin-orders', { id: ORDER_ID, status: 'paid' }), 'status');
  fx.reset();
  const res = await get('admin-orders', { id: ORDER_ID });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(body(res), { error: 'not_found' });
});

/* ------------------------------------------------------------ inventory */

test('inventory list: levels with velocity merged in', async () => {
  fx.state.tables.inventory_levels = [{ product_id: 'bpc-157', pack_size: '10 mg', on_hand: 5 },
                                      { product_id: 'tb-500', pack_size: '5 mg', on_hand: 0 }];
  fx.state.tables.inventory_velocity = [{ product_id: 'bpc-157', pack_size: '10 mg', units_out_30d: 3, units_out_90d: 7 }];
  const b = body(await get('admin-inventory', {}));
  assert.equal(b.items[0].units_out_30d, 3);
  assert.equal(b.items[1].units_out_30d, 0);
  assert.equal(b.truncated, false);
  assert.deepEqual(fx.param(fx.readOf('inventory_levels'), 'order'), ['product_id.asc,pack_size.asc']);
});

test('inventory list: active and low filters', async () => {
  await get('admin-inventory', { active: 'true', low: '1' });
  const r = fx.readOf('inventory_levels');
  assert.deepEqual(fx.param(r, 'active'), ['is.true']);
  assert.deepEqual(fx.param(r, 'is_low'), ['is.true']);
  fx.reset();
  assert400(await get('admin-inventory', { active: 'yes' }), 'active');
  assert400(await get('admin-inventory', { low: 'true' }), 'low');
});

test('inventory item: one stock item and its lots; both keys required', async () => {
  fx.state.tables.inventory_items = [{ product_id: 'bpc-157', pack_size: '10 mg' }];
  fx.state.tables.lot_levels = [{ lot_id: LOT_ID, on_hand: 4 }];
  const b = body(await get('admin-inventory', { product_id: 'bpc-157', pack_size: '10 mg' }));
  assert.equal(b.item.product_id, 'bpc-157');
  assert.equal(b.lots.length, 1);
  assert.deepEqual(b.velocity, { units_out_30d: 0, units_out_90d: 0 });
  for (const t of ['inventory_items', 'inventory_levels', 'inventory_velocity', 'lot_levels']) {
    const r = fx.readOf(t);
    assert.deepEqual(fx.param(r, 'product_id'), ['eq.bpc-157']);
    assert.deepEqual(fx.param(r, 'pack_size'), ['eq.10 mg']);
  }
  fx.reset();
  assert400(await get('admin-inventory', { product_id: 'bpc-157' }), 'pack_size');
  assert400(await get('admin-inventory', { pack_size: '10 mg' }), 'product_id');
  assert400(await get('admin-inventory', { product_id: 'BPC 157', pack_size: '10 mg' }), 'product_id');
  assert400(await get('admin-inventory', { product_id: 'bpc-157', pack_size: '10 mg,x' }), 'pack_size');
  assert400(await get('admin-inventory', { product_id: 'bpc-157', pack_size: '10 mg', low: '1' }), 'low');
  const res = await get('admin-inventory', { product_id: 'bpc-157', pack_size: '10 mg' });
  assert.equal(res.statusCode, 404);
});

test('inventory lot: lot, level, allocations and paged movements', async () => {
  fx.state.tables.lots = [{ id: LOT_ID, lot_number: 'L1', supplier: 'S' }];
  fx.state.tables.stock_movements = [{ id: 30 }, { id: 20 }, { id: 10 }];
  const b = body(await get('admin-inventory', { lot_id: LOT_ID, limit: '2' }));
  assert.equal(b.lot.lot_number, 'L1');
  assert.equal(b.movements.length, 2);
  assert.deepEqual(decodeCursor(b.next_cursor, ['id']), [20]);
  assert.deepEqual(fx.param(fx.readOf('stock_movements'), 'lot_id'), [`eq.${LOT_ID}`]);
  assert.deepEqual(fx.param(fx.readOf('order_line_lots'), 'lot_id'), [`eq.${LOT_ID}`]);

  fx.reset();
  fx.state.tables.lots = [{ id: LOT_ID }];
  await get('admin-inventory', { lot_id: LOT_ID, cursor: b.next_cursor });
  assert.deepEqual(fx.param(fx.readOf('stock_movements'), 'id'), ['lt.20']);

  fx.reset();
  assert400(await get('admin-inventory', { lot_id: 'nope' }), 'lot_id');
  assert400(await get('admin-inventory', { lot_id: LOT_ID, active: 'true' }), 'active');
  assert.equal((await get('admin-inventory', { lot_id: LOT_ID })).statusCode, 404);
});

/* ------------------------------------------------------------- expenses */

test('expenses: deleted left out by default, date range and category filters', async () => {
  await get('admin-expenses', { from: '2026-01-01', to: '2026-03-31', category: 'lab_testing' });
  const r = fx.readOf('expenses');
  assert.deepEqual(fx.param(r, 'incurred_on'), ['gte.2026-01-01', 'lte.2026-03-31']);
  assert.deepEqual(fx.param(r, 'category_code'), ['eq.lab_testing']);
  assert.deepEqual(fx.param(r, 'deleted_at'), ['is.null']);
  assert.deepEqual(fx.param(r, 'order'), ['incurred_on.desc,id.desc']);
  assert.ok(fx.readOf('expense_categories'));

  fx.reset();
  await get('admin-expenses', { include_deleted: '1' });
  assert.deepEqual(fx.param(fx.readOf('expenses'), 'deleted_at'), []);
});

test('expenses: invalid filters are refused', async () => {
  assert400(await get('admin-expenses', { from: '2026-02-30' }), 'from');
  assert400(await get('admin-expenses', { to: '01/02/2026' }), 'to');
  assert400(await get('admin-expenses', { from: '2026-03-01', to: '2026-01-01' }), 'to');
  assert400(await get('admin-expenses', { category: 'Lab Testing' }), 'category');
  assert400(await get('admin-expenses', { category: 'a,b' }), 'category');
  assert400(await get('admin-expenses', { include_deleted: 'yes' }), 'include_deleted');
});

test('expenses: paging uses a (date, id) keyset', async () => {
  fx.state.tables.expenses = [{ id: EXPENSE_ID, incurred_on: '2026-02-01' }, { id: 'cccccccc-0000-4000-8000-000000000002', incurred_on: '2026-01-15' }];
  const b = body(await get('admin-expenses', { limit: '1' }));
  assert.deepEqual(decodeCursor(b.next_cursor, ['date', 'uuid']), ['2026-02-01', EXPENSE_ID]);
  fx.reset();
  await get('admin-expenses', { cursor: b.next_cursor });
  assert.deepEqual(fx.param(fx.readOf('expenses'), 'or'),
    [`(incurred_on.lt."2026-02-01",and(incurred_on.eq."2026-02-01",id.lt."${EXPENSE_ID}"))`]);
});

test('expense detail: by id, deleted included; 404 when missing', async () => {
  fx.state.tables.expenses = [{ id: EXPENSE_ID, deleted_at: '2026-01-01T00:00:00Z' }];
  const b = body(await get('admin-expenses', { id: EXPENSE_ID }));
  assert.equal(b.expense.id, EXPENSE_ID);
  const r = fx.readOf('expenses');
  assert.deepEqual(fx.param(r, 'id'), [`eq.${EXPENSE_ID}`]);
  assert.deepEqual(fx.param(r, 'deleted_at'), []);
  fx.reset();
  assert.equal((await get('admin-expenses', { id: EXPENSE_ID })).statusCode, 404);
  assert400(await get('admin-expenses', { id: EXPENSE_ID, from: '2026-01-01' }), 'from');
});

test('staged import rows: pending and error by default, a chosen status, id paging', async () => {
  fx.state.tables.expense_import = [{ id: 7, status: 'error', error: 'bad date' }];
  const b = body(await get('admin-expenses', { view: 'import' }));
  assert.equal(b.rows[0].error, 'bad date');
  assert.deepEqual(fx.param(fx.readOf('expense_import'), 'status'), ['in.(pending,error)']);
  fx.reset();
  await get('admin-expenses', { view: 'import', status: 'duplicate', cursor: encodeCursor([50]) });
  const r = fx.readOf('expense_import');
  assert.deepEqual(fx.param(r, 'status'), ['eq.duplicate']);
  assert.deepEqual(fx.param(r, 'id'), ['lt.50']);
  fx.reset();
  assert400(await get('admin-expenses', { view: 'other' }), 'view');
  assert400(await get('admin-expenses', { view: 'import', status: 'all' }), 'status');
  assert400(await get('admin-expenses', { view: 'import', category: 'other' }), 'category');
});

/* ----------------------------------------------------------- financials */

test('financials: five reports, a month range applied to the monthly ones', async () => {
  fx.state.tables.monthly_financial_summary = [{ month: '2026-09-01', currency: 'USD', fees_and_tax_separated: false }];
  const b = body(await get('admin-financials', { from_month: '2026-01', to_month: '2026-09' }));
  assert.equal(b.fees_and_tax_separated, false);
  assert.equal(b.summary.length, 1);
  for (const t of ['monthly_financial_summary', 'monthly_gross_margin', 'monthly_expenses', 'addon_revenue']) {
    assert.deepEqual(fx.param(fx.readOf(t), 'month'), ['gte.2026-01-01', 'lte.2026-09-01'], t);
  }
  assert.deepEqual(fx.param(fx.readOf('addon_attach_rate'), 'month'), []);
});

test('financials: invalid months are refused', async () => {
  assert400(await get('admin-financials', { from_month: '2026-13' }), 'from_month');
  assert400(await get('admin-financials', { to_month: '2026-1' }), 'to_month');
  assert400(await get('admin-financials', { from_month: '2026-05', to_month: '2026-04' }), 'to_month');
  assert400(await get('admin-financials', { month: '2026-05' }), 'month');
});

/* ------------------------------------------------------------ audit log */

test('audit log: newest first, filters, id paging', async () => {
  fx.state.tables.admin_audit_log = [{ id: 3 }, { id: 2 }];
  const b = body(await get('admin-audit', { entity_type: 'inventory_item', entity_id: 'bpc-157|10 mg', action: 'inventory.update_item', limit: '1' }));
  assert.deepEqual(decodeCursor(b.next_cursor, ['id']), [3]);
  const r = fx.readOf('admin_audit_log');
  assert.deepEqual(fx.param(r, 'entity_type'), ['eq.inventory_item']);
  assert.deepEqual(fx.param(r, 'entity_id'), ['eq.bpc-157|10 mg']);
  assert.deepEqual(fx.param(r, 'action'), ['eq.inventory.update_item']);
  assert.deepEqual(fx.param(r, 'order'), ['id.desc']);
});

test('audit log: invalid filters are refused', async () => {
  assert400(await get('admin-audit', { entity_id: ORDER_ID }), 'entity_type');
  assert400(await get('admin-audit', { entity_type: 'Order' }), 'entity_type');
  assert400(await get('admin-audit', { entity_type: 'order', entity_id: 'a,b' }), 'entity_id');
  assert400(await get('admin-audit', { action: 'order' }), 'action');
  assert400(await get('admin-audit', { action: 'order.set_status,x' }), 'action');
});

/* ------------------------------------------------------------ customers */

test('customers: list by most recent order, with summary and offset paging', async () => {
  fx.state.tables.customer_aggregates = [{ customer_email: 'a@x.org' }, { customer_email: 'b@x.org' }, { customer_email: 'c@x.org' }];
  fx.state.tables.customer_summary = [{ currency: 'USD', customers: 3 }];
  const b = body(await get('admin-customers', { limit: '2' }));
  assert.equal(b.customers.length, 2);
  assert.equal(b.summary[0].customers, 3);
  assert.deepEqual(decodeCursor(b.next_cursor, ['offset']), [2]);
  const r = fx.readOf('customer_aggregates');
  assert.deepEqual(fx.param(r, 'order'), ['last_order_at.desc,customer_email.asc,currency.asc']);
  assert.deepEqual(fx.param(r, 'offset'), ['0']);
  fx.reset();
  await get('admin-customers', { cursor: b.next_cursor });
  assert.deepEqual(fx.param(fx.readOf('customer_aggregates'), 'offset'), ['2']);
});

test('customer detail: exact, normalized email; wildcard over-matches are filtered out', async () => {
  fx.state.tables.customer_aggregates = [{ customer_email: 'jo_b@example.org', currency: 'USD', order_count: 2 }];
  fx.state.tables.order_queue = [
    { order_id: '1', email: 'Jo_B@Example.org ' },
    { order_id: '2', email: 'joXb@example.org' },     // "_" matched any character
    { order_id: '3', email: 'bigjo_b@example.org' },  // contains-match
    { order_id: '4', email: 'jo_b@example.org' }
  ];
  const b = body(await get('admin-customers', { email: '  JO_B@example.ORG ' }));
  assert.equal(b.email, 'jo_b@example.org');
  assert.deepEqual(b.orders.map((o) => o.order_id), ['1', '4']);
  assert.deepEqual(fx.param(fx.readOf('customer_aggregates'), 'customer_email'), ['eq.jo_b@example.org']);
  const q = fx.readOf('order_queue');
  assert.deepEqual(fx.param(q, 'email'), ['ilike.*jo_b@example.org*']);
  const sel = fx.param(q, 'select')[0].split(',');
  assert.equal(sel.includes('phone'), false);
});

test('customer detail: emails that could change the filter are refused', async () => {
  for (const email of ['a', 'a@', '@b.org', 'a,b@x.org', 'a*@x.org', 'a%@x.org', 'a"b@x.org', 'a(b)@x.org', 'a\\b@x.org',
                       'a b@x.org', `${'a'.repeat(250)}@x.org`, 'a@x', 'a@x..org']) {
    fx.reset();
    assert400(await get('admin-customers', { email }), 'email');
    assert.equal(fx.reads().length, 0);
  }
});

test('customer detail: needs orders.read as well; the list does not; 404 for an unknown customer', async () => {
  fx.state.permissions.delete('orders.read');
  assert.equal((await get('admin-customers', { email: 'a@example.org' })).statusCode, 403);
  assert.equal(fx.reads().length, 0);
  fx.reset();
  fx.state.permissions.delete('orders.read');
  assert.equal((await get('admin-customers', {})).statusCode, 200);
  fx.reset();
  const res = await get('admin-customers', { email: 'nobody@example.org' });
  assert.equal(res.statusCode, 404);
  assert400(await get('admin-customers', { email: 'a@example.org', limit: '5' }), 'limit');
});
