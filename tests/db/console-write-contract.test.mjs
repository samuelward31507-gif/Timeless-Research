/*
 * The console write API against the real schema, end to end and offline.
 *
 * Each POST action of admin-orders, admin-inventory and admin-expenses is
 * sent through its real handler. Sign-in uses a locally signed token
 * (tests/helpers/admin-fixtures.js); everything the handler then asks of
 * Supabase is answered by PostgreSQL 16 (PGlite) with migrations 0001-0004,
 * acting as the service role, as PostgREST would:
 *
 *   - the staff lookup reads staff_members;
 *   - rpc/<function> calls the function with the body as named arguments,
 *     refusing an argument name the function does not have (PostgREST's
 *     PGRST202), so a misspelt argument fails here rather than on Supabase.
 *
 * What this proves: every action reaches the function it is meant to with
 * arguments it accepts; the change happens; one audit row is written naming
 * the signed-in staff member; and a refusal by the database (42501 when the
 * staff member lost access mid-request) comes back as 403 with nothing
 * written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, rows, one, recordPaidOrder } from './harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = require(path.join(ROOT, 'tests', 'helpers', 'admin-fixtures.js'));
const fn = (name) => require(path.join(ROOT, 'netlify', 'functions', `${name}.js`)).handler;
const CATALOG = require(path.join(ROOT, 'netlify', 'functions', 'catalog.json'));

const OWNER_EMAIL = 'owner@example.org';

/* ------------------------------------------------- PostgREST, in PGlite */

let db;
let staffId;
const hooks = { beforeRpc: null };

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x)));

async function asService(fnc) {
  await db.exec('set role service_role');
  try { return await fnc(); } finally { await db.exec('reset role'); }
}

function pgError(e) {
  return { ok: false, status: 400, json: async () => ({ code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null }) };
}
const ok = (value) => ({ ok: true, status: 200, json: async () => plain(value) });

async function rpc(name, args) {
  const procs = await rows(db, `
    select p.proname, p.pronargs, p.pronargdefaults, p.proretset, t.typtype,
           p.proargnames[1:p.pronargs] as names,
           array(select format_type(x, null) from unnest(p.proargtypes) x) as types
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
     where n.nspname = 'public' and p.proname = $1`, [name]);
  if (procs.length !== 1) return { ok: false, status: 404, json: async () => ({ code: 'PGRST202', message: 'no such function' }) };
  const p = procs[0];
  const required = p.names.slice(0, p.pronargs - p.pronargdefaults);
  for (const k of Object.keys(args)) {
    if (!p.names.includes(k)) return { ok: false, status: 404, json: async () => ({ code: 'PGRST202', message: `no argument ${k}` }) };
  }
  for (const k of required) {
    if (!(k in args)) return { ok: false, status: 404, json: async () => ({ code: 'PGRST202', message: `missing ${k}` }) };
  }
  const keys = Object.keys(args);
  const sql = `select * from public."${name}"(${keys.map((k, i) => `"${k}" => $${i + 1}::${p.types[p.names.indexOf(k)]}`).join(', ')})`;
  const params = keys.map((k) => {
    const v = args[k];
    if (v === null || v === undefined) return null;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  try {
    const result = await asService(() => rows(db, sql, params));
    if (p.proretset) return ok(result);
    if (p.typtype === 'c') return ok(result[0]);
    return ok(result[0][name]);
  } catch (e) {
    return pgError(e);
  }
}

const stubbed = global.fetch;
global.fetch = async (url, init) => {
  url = String(url);
  init = init || {};
  if (url.startsWith(`${fx.BASE}/rest/v1/staff_members?`)) {
    const id = new URL(url).searchParams.get('auth_user_id').replace(/^eq\./, '');
    return ok(await asService(() => rows(db,
      'select id, auth_user_id, email, display_name, role_code, active from public.staff_members where auth_user_id = $1 limit 2', [id])));
  }
  const m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url);
  if (m) {
    const args = JSON.parse(init.body);
    if (hooks.beforeRpc && m[1] !== 'staff_can') await hooks.beforeRpc(m[1], args);
    return rpc(m[1], args);
  }
  if (url.startsWith(`${fx.BASE}/rest/v1/`)) throw new Error(`the write API read a table directly: ${url}`);
  return stubbed(url, init);
};

/* ----------------------------------------------------------- helpers */

const post = (endpoint, body) => fx.post(fn(endpoint), body);
const json = (res) => JSON.parse(res.body);

async function auditCount() {
  return (await one(db, 'select count(*)::int n from public.admin_audit_log')).n;
}

/* Sends an action, expects 200, and returns its result with the one audit
   row it must have written. */
async function act(endpoint, action, fields, auditAction) {
  const before = await auditCount();
  const res = await post(endpoint, Object.assign({ action }, fields));
  assert.equal(res.statusCode, 200, `${action}: ${res.body}`);
  const audits = await rows(db, 'select * from public.admin_audit_log order by id desc limit $1', [(await auditCount()) - before]);
  assert.equal(audits.length, 1, `${action} wrote ${audits.length} audit rows`);
  assert.equal(audits[0].action, auditAction);
  assert.equal(audits[0].actor_id, staffId, `${action}: audit actor`);
  assert.equal(audits[0].actor_email, OWNER_EMAIL);
  return { result: json(res).result, audit: audits[0] };
}

async function descriptionOnlyOrder(session, description, quantity) {
  const { id } = await recordPaidOrder(db, session);
  await db.query(`insert into public.order_items (order_id, kind, description, quantity, unit_amount, amount_total)
                  values ($1, 'product', $2, $3, 4500, $4)`, [id, description, quantity, 4500 * quantity]);
  return id;
}

test.before(async () => {
  db = await freshDb();
  staffId = (await one(db, `insert into public.staff_members (auth_user_id, email, display_name, role_code)
                            values ($1, $2, 'Owner', 'owner') returning id`, [fx.OWNER_AUTH_ID, OWNER_EMAIL])).id;
});

test.beforeEach(() => {
  fx.state.calls = [];
  hooks.beforeRpc = null;
});

/* ----------------------------------------------------------- inventory */

let lotId;

test('inventory.sync: the server catalogue becomes stock items, audited', async () => {
  const expected = Object.entries(CATALOG.products).reduce((n, [, p]) => n + Object.keys(p.prices).length, 0);
  const { result, audit } = await act('admin-inventory', 'inventory.sync', {}, 'inventory.sync_items');
  assert.deepEqual(result, { added: expected, reactivated: 0, deactivated: 0 });
  assert.equal((await one(db, 'select count(*)::int n from public.inventory_items where active')).n, expected);
  assert.equal(audit.details.catalogue_items, expected);
  const again = await act('admin-inventory', 'inventory.sync', {}, 'inventory.sync_items');
  assert.deepEqual(again.result, { added: 0, reactivated: 0, deactivated: 0 });
});

test('inventory.receive_lot: a lot with its receipt movement, recorded against the staff member', async () => {
  const { result, audit } = await act('admin-inventory', 'inventory.receive_lot', {
    product_id: 'bpc-157', pack_size: '10 mg', lot_number: 'L-TEST-1', quantity: 10, received_on: '2026-09-01',
    retest_date: '2027-09-01', unit_cost_cents: 1200, supplier: 'Acme', coa_reference: 'COA-1'
  }, 'inventory.receive_lot');
  lotId = result.lot_id;
  const lot = await one(db, 'select * from public.lots where id = $1', [lotId]);
  assert.equal(lot.lot_number, 'L-TEST-1');
  assert.equal(lot.created_by, OWNER_EMAIL);
  assert.equal((await one(db, 'select on_hand from public.lot_levels where lot_id = $1', [lotId])).on_hand, 10);
  assert.equal(audit.entity_id, lotId);
  // Defaults: received today, in USD, when not given.
  const d = await act('admin-inventory', 'inventory.receive_lot',
    { product_id: 'bpc-157', pack_size: '10 mg', lot_number: 'L-TEST-2', quantity: 5 }, 'inventory.receive_lot');
  const lot2 = await one(db, 'select currency, received_on = current_date as today from public.lots where id = $1', [d.result.lot_id]);
  assert.deepEqual(lot2, { currency: 'USD', today: true });
});

test('inventory.update_item, update_lot and record_movement change what they say and audit before and after', async () => {
  const item = await act('admin-inventory', 'inventory.update_item',
    { product_id: 'bpc-157', pack_size: '10 mg', changes: { low_stock_threshold: 3, notes: 'Fridge B' } }, 'inventory.update_item');
  assert.equal(item.result.item.low_stock_threshold, 3);
  assert.equal(item.audit.details.after.notes, 'Fridge B');

  const lot = await act('admin-inventory', 'inventory.update_lot',
    { lot_id: lotId, changes: { unit_cost_cents: 1300, supplier: null } }, 'inventory.update_lot');
  assert.equal(lot.result.lot.unit_cost_cents, 1300);
  assert.equal(lot.result.lot.supplier, null);
  assert.equal(lot.audit.details.before.unit_cost_cents, 1200);

  const mv = await act('admin-inventory', 'inventory.record_movement',
    { lot_id: lotId, delta: -1, reason: 'write_off', note: 'Cracked vial' }, 'inventory.record_movement');
  const m = await one(db, 'select * from public.stock_movements where id = $1', [mv.result.movement_id]);
  assert.equal(m.created_by, OWNER_EMAIL);
  assert.equal((await one(db, 'select on_hand from public.lot_levels where lot_id = $1', [lotId])).on_hand, 9);
});

/* ------------------------------------------------- orders and fulfilment */

test('the order path: map, process, allocate, pack, ship, note; every step audited to the staff member', async () => {
  const order = await descriptionOnlyOrder('cs_write_1', 'BPC-157 10 mg', 2);
  const item = (await one(db, 'select id from public.order_items where order_id = $1', [order])).id;

  const map = await act('admin-orders', 'fulfilment.map_line',
    { order_item_id: Number(item), product_id: 'bpc-157', pack_size: '10 mg', note: 'Label on the order says 10 mg' }, 'fulfilment.map_line');
  assert.ok(map.result.mapping_id);
  assert.equal((await one(db, 'select sku from public.order_items where id = $1', [item])).sku, 'bpc-157');

  const proc = await act('admin-orders', 'order.set_status', { order_id: order, status: 'processing', note: 'picking' }, 'order.set_status');
  assert.equal(proc.result.order.status, 'processing');
  const hist = await one(db, `select changed_by, note from public.order_status_history where order_id = $1 and to_status = 'processing'`, [order]);
  assert.deepEqual(hist, { changed_by: OWNER_EMAIL, note: 'picking' });

  const alloc = await act('admin-orders', 'fulfilment.allocate',
    { order_id: order, product_id: 'bpc-157', pack_size: '10 mg', lot_id: lotId, quantity: 2 }, 'fulfilment.allocate');
  assert.equal((await one(db, 'select allocated_by from public.order_line_lots where id = $1', [alloc.result.allocation_id])).allocated_by, OWNER_EMAIL);

  await act('admin-orders', 'order.set_status', { order_id: order, status: 'packed' }, 'order.set_status');
  const ship = await act('admin-orders', 'order.ship', { order_id: order, carrier: 'UPS', tracking_number: '1Z999' }, 'order.ship');
  assert.equal(ship.result.order.status, 'shipped');
  assert.equal(ship.result.order.tracking_number, '1Z999');

  const note = await act('admin-orders', 'order.add_note', { order_id: order, body: 'Customer emailed' }, 'order.add_note');
  const n = await one(db, 'select author_id, author_email, body from public.order_notes where id = $1', [note.result.note_id]);
  assert.deepEqual(n, { author_id: staffId, author_email: OWNER_EMAIL, body: 'Customer emailed' });
});

test('release and unmap: undone in order, each audited', async () => {
  const order = await descriptionOnlyOrder('cs_write_2', 'BPC-157 ten', 1);
  const item = (await one(db, 'select id from public.order_items where order_id = $1', [order])).id;
  const map = await act('admin-orders', 'fulfilment.map_line',
    { order_item_id: Number(item), product_id: 'bpc-157', pack_size: '10 mg', note: 'confirmed by email' }, 'fulfilment.map_line');
  const alloc = await act('admin-orders', 'fulfilment.allocate',
    { order_id: order, product_id: 'bpc-157', pack_size: '10 mg', lot_id: lotId, quantity: 1 }, 'fulfilment.allocate');

  // Unmapping while stock is allocated is refused by the database, in its own words.
  const before = await auditCount();
  const refused = await post('admin-orders', { action: 'fulfilment.unmap_line', mapping_id: map.result.mapping_id, note: 'x' });
  assert.equal(refused.statusCode, 422);
  assert.match(json(refused).message, /release the stock allocated to this line/);
  assert.equal(await auditCount(), before);

  const rel = await act('admin-orders', 'fulfilment.release', { allocation_id: alloc.result.allocation_id, note: 'wrong lot' }, 'fulfilment.release');
  assert.deepEqual(rel.result, { released: true });
  const un = await act('admin-orders', 'fulfilment.unmap_line', { mapping_id: map.result.mapping_id, note: 'wrong product' }, 'fulfilment.unmap_line');
  assert.deepEqual(un.result, { unmapped: true });
  assert.equal((await one(db, 'select sku from public.order_items where id = $1', [item])).sku, null);
});

/* ---------------------------------------------------------- finance */

test('expenses: create, update, delete, restore, each audited', async () => {
  const created = await act('admin-expenses', 'finance.create_expense',
    { incurred_on: '2026-09-30', category_code: 'lab_testing', description: 'HPLC', amount_cents: 45000, lot_id: lotId },
    'finance.create_expense');
  const id = created.result.expense_id;
  assert.equal((await one(db, 'select created_by from public.expenses where id = $1', [id])).created_by, OWNER_EMAIL);

  const upd = await act('admin-expenses', 'finance.update_expense', { expense_id: id, changes: { amount_cents: 46000, lot_id: null } },
    'finance.update_expense');
  assert.equal(upd.result.expense.amount_cents, 46000);
  assert.equal(upd.result.expense.updated_by, OWNER_EMAIL);

  await act('admin-expenses', 'finance.delete_expense', { expense_id: id, reason: 'duplicate' }, 'finance.delete_expense');
  assert.equal((await one(db, 'select deleted_by from public.expenses where id = $1', [id])).deleted_by, OWNER_EMAIL);
  const res = await act('admin-expenses', 'finance.restore_expense', { expense_id: id }, 'finance.restore_expense');
  assert.deepEqual(res.result, { restored: true });
  assert.equal((await one(db, 'select deleted_at from public.expenses where id = $1', [id])).deleted_at, null);
});

test('expense import: stage rows, then import; bad rows stay staged with the reason', async () => {
  const staged = await act('admin-expenses', 'finance.stage_import', {
    rows: [{ incurred_on: '2026-08-01', category: 'Software', description: 'Hosting', amount: '12.00' },
           { incurred_on: '2026-13-01', category: 'Software', description: 'Bad date', amount: '5' }]
  }, 'finance.stage_import');
  assert.deepEqual(staged.result, { staged: 2 });
  const imported = await act('admin-expenses', 'finance.import', {}, 'finance.import_expenses');
  assert.deepEqual(imported.result, { imported: 1, duplicates: 0, errors: 1 });
  const bad = await one(db, `select status, error from public.expense_import where description = 'Bad date'`);
  assert.equal(bad.status, 'error');
});

/* ---------------------------------------------------- refusals */

test('a staff member deactivated mid-request: the database refuses (42501), the API says 403, nothing is written', async () => {
  const order = await descriptionOnlyOrder('cs_write_race', 'X', 1);
  const before = await auditCount();
  hooks.beforeRpc = async () => { await db.query('update public.staff_members set active = false where id = $1', [staffId]); };
  // A second owner keeps the "last owner" rule from stopping the deactivation.
  await db.query(`insert into public.staff_members (email, role_code) values ('second@example.org', 'owner')`);
  try {
    const res = await post('admin-orders', { action: 'order.add_note', order_id: order, body: 'should not land' });
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(json(res), { error: 'not_authorized' });
    assert.equal(await auditCount(), before);
    assert.equal((await one(db, 'select count(*)::int n from public.order_notes where order_id = $1', [order])).n, 0);
  } finally {
    hooks.beforeRpc = null;
    await db.query('update public.staff_members set active = true where id = $1', [staffId]);
  }
});

test('every write function refuses an actor whose role lacks the permission, with 42501', async () => {
  await db.query(`insert into public.staff_roles (code, name) values ('test_readonly', 'Read only') on conflict do nothing`);
  await db.query(`insert into public.role_permissions (role_code, permission_code) values ('test_readonly', 'orders.read') on conflict do nothing`);
  const viewer = (await one(db, `insert into public.staff_members (email, role_code) values ('viewer@example.org', 'test_readonly') returning id`)).id;
  const calls = {
    admin_set_order_status: { p_order_id: '00000000-0000-4000-8000-000000000000', p_status: 'processing' },
    admin_add_order_note: { p_order_id: '00000000-0000-4000-8000-000000000000', p_body: 'x' },
    ship_order: { p_order_id: '00000000-0000-4000-8000-000000000000', p_carrier: 'UPS', p_tracking_number: '1' },
    admin_allocate_order_line: { p_order_id: '00000000-0000-4000-8000-000000000000', p_product_id: 'a', p_pack_size: 'b',
                                 p_lot_id: '00000000-0000-4000-8000-000000000000', p_quantity: 1 },
    admin_release_allocation: { p_allocation_id: 1 },
    admin_map_order_line: { p_order_item_id: 1, p_product_id: 'a', p_pack_size: 'b', p_note: 'n' },
    admin_unmap_order_line: { p_mapping_id: 1, p_note: 'n' },
    receive_lot: { p_product_id: 'bpc-157', p_pack_size: '10 mg', p_lot_number: 'Z', p_quantity: 1 },
    admin_update_inventory_item: { p_product_id: 'bpc-157', p_pack_size: '10 mg', p_changes: { notes: 'x' } },
    admin_update_lot: { p_lot_id: lotId, p_changes: { notes: 'x' } },
    admin_record_stock_movement: { p_lot_id: lotId, p_delta: 1, p_reason: 'adjustment', p_note: 'x' },
    sync_inventory_items: { p_items: [{ product_id: 'a', pack_size: 'b' }] },
    admin_create_expense: { p_incurred_on: '2026-01-01', p_category_code: 'other', p_description: 'x', p_amount_cents: 1 },
    admin_update_expense: { p_expense_id: '00000000-0000-4000-8000-000000000000', p_changes: { notes: 'x' } },
    admin_delete_expense: { p_expense_id: '00000000-0000-4000-8000-000000000000', p_reason: 'x' },
    admin_restore_expense: { p_expense_id: '00000000-0000-4000-8000-000000000000' },
    admin_stage_expense_import: { p_rows: [{ description: 'x' }] },
    admin_import_expenses: {}
  };
  const before = await auditCount();
  for (const [name, args] of Object.entries(calls)) {
    const res = await rpc(name, Object.assign({}, args, { p_actor: viewer }));
    assert.equal(res.ok, false, `${name} accepted a read-only actor`);
    assert.equal((await res.json()).code, '42501', name);
  }
  assert.equal(await auditCount(), before);
});

test('every action the API sends names only arguments its function has', async () => {
  // Already exercised above; this checks the bridge itself refuses a misspelt
  // or missing argument, so the checks above mean something.
  const bad = await rpc('admin_add_order_note', { p_actor: staffId, p_order: 'x', p_body: 'y' });
  assert.equal((await bad.json()).code, 'PGRST202');
  const missing = await rpc('admin_add_order_note', { p_actor: staffId, p_body: 'y' });
  assert.equal((await missing.json()).code, 'PGRST202');
});

test('the database\'s own sentences reach the operator; its generated ones do not', async () => {
  const order = await descriptionOnlyOrder('cs_write_msgs', 'Y', 1);
  const notPacked = await post('admin-orders', { action: 'order.ship', order_id: order, carrier: 'UPS', tracking_number: '1Z1' });
  assert.equal(notPacked.statusCode, 422);
  assert.match(json(notPacked).message, /only a packed order can be shipped/);

  const backwards = await post('admin-orders', { action: 'order.set_status', order_id: order, status: 'delivered' });
  assert.equal(backwards.statusCode, 422);
  assert.match(json(backwards).message, /status cannot move from paid to delivered/);

  const missing = await post('admin-orders', { action: 'order.add_note', order_id: '00000000-0000-4000-8000-000000000000', body: 'x' });
  assert.equal(missing.statusCode, 404);

  const dup = await post('admin-inventory', { action: 'inventory.receive_lot', product_id: 'bpc-157', pack_size: '10 mg',
                                              lot_number: 'L-TEST-1', quantity: 1 });
  assert.equal(dup.statusCode, 409);
  assert.deepEqual(json(dup), { error: 'conflict', message: 'That already exists.' });

  const tooMany = await post('admin-inventory', { action: 'inventory.record_movement', lot_id: lotId, delta: -1000, reason: 'adjustment', note: 'x' });
  assert.equal(tooMany.statusCode, 422);
  assert.match(json(tooMany).message, /on hand, cannot remove 1000/);

  const unknownItem = await post('admin-inventory', { action: 'inventory.receive_lot', product_id: 'no-such', pack_size: '1 mg',
                                                      lot_number: 'Q', quantity: 1 });
  assert.equal(unknownItem.statusCode, 404);
  assert.match(json(unknownItem).message, /no active stock item/);
});

test('the write API never reads or writes a table directly; it only calls functions', async () => {
  // The fetch bridge throws on any non-rpc PostgREST path; reaching here
  // with every test above passing is the proof. Check the record anyway.
  assert.equal(fx.state.calls.filter((c) => /\/rest\/v1\/(?!rpc\/|staff_members\?)/.test(c.url)).length, 0);
});
