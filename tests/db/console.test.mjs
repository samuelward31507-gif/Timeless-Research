/*
 * Phase 1, Pass 1: supabase/migrations/0004_console_foundation.sql.
 *
 * Covers staff and authorization, actor attribution, the audit log and its
 * resistance to forgery, atomic status and shipping operations, inventory and
 * expense functions, line mapping, the console views, and that the service
 * role (the server's key) and the browser roles have exactly the access
 * intended.
 *
 * "As the server" means set role service_role, which on Supabase bypasses row
 * level security; harness.mjs sets that up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { freshDb, rows, one, recordPaidOrder, insertOrder, productLine, errorOf, asRole, reapplyFrom } from './harness.mjs';

const OWNER_EMAIL = 'owner@example.org';
const CATALOG = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..',
  'netlify', 'functions', 'catalog.json'), 'utf8'));
const CATALOG_ITEMS = Object.entries(CATALOG.products)
  .flatMap(([id, p]) => Object.keys(p.prices).map((size) => ({ product_id: id, pack_size: size })));

async function setup() {
  const db = await freshDb();
  const owner = (await one(db, `select public.bootstrap_owner($1, gen_random_uuid(), 'Owner') as id`, [OWNER_EMAIL])).id;
  return { db, owner };
}
const asServer = (db, fn) => asRole(db, 'service_role', fn);
const call = (db, sql, params) => asServer(db, () => one(db, sql, params));
const auditCount = async (db) => (await one(db, 'select count(*)::int n from public.admin_audit_log')).n;
const lastAudit = (db) => one(db, 'select actor_id, actor_email, action, entity_type, entity_id, details from public.admin_audit_log order by id desc limit 1');

async function stocked(db, owner, product = 'bpc-157', pack = '10 mg', qty = 20, cost = 800, lotNumber = 'TEST-A') {
  await call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, JSON.stringify(CATALOG_ITEMS)]);
  return (await call(db, `select public.receive_lot($1, $2, $3, $4, $5, current_date, null, null, $6) as id`,
                     [owner, product, pack, lotNumber, qty, cost])).id;
}

/* ============================================================= setup */

test('0004 applies on top of 0001-0003 and again; roles and permissions are data, owner only', async () => {
  const { db } = await setup();
  await reapplyFrom(db, '0004_console_foundation.sql');
  assert.deepEqual((await rows(db, 'select code from public.staff_roles')).map((r) => r.code), ['owner']);
  const perms = (await rows(db, `select permission_code from public.role_permissions where role_code = 'owner' order by 1`)).map((r) => r.permission_code);
  assert.deepEqual(perms, ['audit.read', 'customers.read', 'finance.read', 'finance.write', 'fulfilment.write',
                           'inventory.read', 'inventory.write', 'orders.read', 'orders.write', 'staff.manage']);
  assert.equal((await one(db, 'select count(*)::int n from public.staff_members')).n, 1);
});

test('bootstrap_owner creates the first owner once, audited, and is not callable by the server or a browser', async () => {
  const { db, owner } = await setup();
  const s = await one(db, 'select email, role_code, active from public.staff_members where id = $1', [owner]);
  assert.deepEqual(s, { email: OWNER_EMAIL, role_code: 'owner', active: true });
  assert.equal((await lastAudit(db)).action, 'staff.bootstrap_owner');
  assert.match(await errorOf(() => db.query(`select public.bootstrap_owner('second@example.org', gen_random_uuid())`)) || '', /already exists/);
  for (const role of ['service_role', 'anon', 'authenticated']) {
    assert.match(await errorOf(() => asRole(db, role, () => db.query(`select public.bootstrap_owner('x@example.org', gen_random_uuid())`))) || 'callable',
                 /permission denied/, role);
  }
});

test('the last active owner cannot be deactivated or demoted', async () => {
  const { db, owner } = await setup();
  assert.match(await errorOf(() => db.query('update public.staff_members set active = false where id = $1', [owner])) || '', /last active owner/);
});

/* ===================================================== authorization */

test('only an active staff member whose role grants the permission can act; a refusal writes nothing', async () => {
  const { db, owner } = await setup();
  const { id: order } = await recordPaidOrder(db, 'cs_authz');
  // A role with no permissions, created here only to prove the check reads
  // permissions rather than trusting membership.
  await db.exec(`insert into public.staff_roles (code, name) values ('test_readonly', 'Test')`);
  const viewer = (await one(db, `insert into public.staff_members (email, role_code) values ('viewer@example.org', 'test_readonly') returning id`)).id;
  const ex = (await one(db, `insert into public.staff_members (email, role_code, active) values ('former@example.org', 'owner', false) returning id`)).id;
  const before = await auditCount(db);

  for (const actor of ['00000000-0000-0000-0000-000000000000', viewer, ex]) {
    const err = await errorOf(() => call(db, `select (public.admin_set_order_status($1, $2, 'processing')).status`, [actor, order]));
    assert.match(err || 'allowed', /not authorized/, actor);
  }
  assert.equal((await one(db, 'select status from public.orders where id = $1', [order])).status, 'paid');
  assert.equal(await auditCount(db), before);

  assert.equal((await call(db, `select public.staff_can($1, 'orders.write') as ok`, [owner])).ok, true);
  assert.equal((await call(db, `select public.staff_can($1, 'orders.write') as ok`, [viewer])).ok, false);
  assert.equal((await call(db, `select public.staff_can($1, 'orders.write') as ok`, [ex])).ok, false);
});

/* ================================================ actor attribution */

test('every console write records the staff member, never the database role', async () => {
  const { db, owner } = await setup();
  const lot = await stocked(db, owner);
  const { id: order } = await recordPaidOrder(db, 'cs_actor');
  await asServer(db, () => productLine(db, order, 'bpc-157', '10 mg', 3, 2600));

  await call(db, `select (public.admin_set_order_status($1, $2, 'processing', 'picking')).status`, [owner, order]);
  const h = await one(db, `select changed_by, note from public.order_status_history where order_id = $1 and to_status = 'processing'`, [order]);
  assert.deepEqual(h, { changed_by: OWNER_EMAIL, note: 'picking' });

  assert.equal((await one(db, 'select created_by from public.lots where id = $1', [lot])).created_by, OWNER_EMAIL);
  assert.equal((await one(db, `select created_by from public.stock_movements where lot_id = $1 and reason = 'receipt'`, [lot])).created_by, OWNER_EMAIL);

  await call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6)', [owner, order, 'bpc-157', '10 mg', lot, 3]);
  assert.equal((await one(db, 'select allocated_by from public.order_line_lots where order_id = $1', [order])).allocated_by, OWNER_EMAIL);
  assert.equal((await one(db, `select created_by from public.stock_movements where order_id = $1 and reason = 'sale'`, [order])).created_by, OWNER_EMAIL);

  await call(db, `select public.admin_record_stock_movement($1, $2, -1, 'write_off', 'vial cracked')`, [owner, lot]);
  assert.equal((await one(db, `select created_by from public.stock_movements where reason = 'write_off'`)).created_by, OWNER_EMAIL);

  // Released by trigger when the owner cancels: still attributed to the owner.
  await call(db, `select (public.admin_set_order_status($1, $2, 'cancelled')).status`, [owner, order]);
  assert.equal((await one(db, `select created_by from public.stock_movements where order_id = $1 and reason = 'release'`, [order])).created_by, OWNER_EMAIL);

  const exp = (await call(db, `select public.admin_create_expense($1, '2026-07-01', 'software', 'Hosting', 2500) as id`, [owner])).id;
  assert.equal((await one(db, 'select created_by from public.expenses where id = $1', [exp])).created_by, OWNER_EMAIL);
  await call(db, `select (public.admin_update_expense($1, $2, '{"amount_cents": 2600}')).id`, [owner, exp]);
  await call(db, `select public.admin_delete_expense($1, $2, 'duplicate')`, [owner, exp]);
  assert.deepEqual(await one(db, 'select updated_by, deleted_by from public.expenses where id = $1', [exp]),
                   { updated_by: OWNER_EMAIL, deleted_by: OWNER_EMAIL });

  // Every one of those wrote an audit entry naming the owner.
  const actors = await rows(db, 'select distinct actor_id, actor_email from public.admin_audit_log');
  assert.deepEqual(actors, [{ actor_id: owner, actor_email: OWNER_EMAIL }]);
});

test('a status change made outside the console (the payment path) is attributed to the database login', async () => {
  const { db } = await setup();
  const { id } = await asServer(db, () => recordPaidOrder(db, 'cs_payment_path'));
  const h = await one(db, 'select changed_by from public.order_status_history where order_id = $1', [id]);
  assert.notEqual(h.changed_by, OWNER_EMAIL);
  assert.ok(h.changed_by.length > 0);
});

/* ======================================== audit cannot be forged or edited */

test('the server key cannot forge, edit or erase audit, history or notes, nor write console tables directly', async () => {
  const { db, owner } = await setup();
  const lot = await stocked(db, owner);
  const { id: order } = await recordPaidOrder(db, 'cs_forge');
  await call(db, `select public.admin_add_order_note($1, $2, 'real note')`, [owner, order]);

  const attempts = [
    [`insert into public.admin_audit_log (actor_id, actor_email, action, entity_type) values ('${owner}', '${OWNER_EMAIL}', 'order.ship', 'order')`],
    ['update public.admin_audit_log set actor_email = $1', ['someone@else.org']],
    ['delete from public.admin_audit_log'],
    [`insert into public.order_status_history (order_id, from_status, to_status, changed_by) values ('${order}', 'paid', 'shipped', '${OWNER_EMAIL}')`],
    ['update public.order_status_history set changed_by = $1', ['someone@else.org']],
    ['delete from public.order_status_history'],
    [`insert into public.order_notes (order_id, body, author_id, author_email) values ('${order}', 'forged', '${owner}', '${OWNER_EMAIL}')`],
    ['update public.order_notes set body = $1', ['edited']],
    [`insert into public.staff_members (email, role_code) values ('intruder@example.org', 'owner')`],
    [`insert into public.role_permissions (role_code, permission_code) values ('owner', 'orders.read') on conflict do nothing`],
    [`insert into public.stock_movements (lot_id, delta, reason, note) values ('${lot}', 100, 'adjustment', 'free stock')`],
    [`update public.lots set unit_cost_cents = 1 where id = '${lot}'`],
    [`insert into public.lots (product_id, pack_size, lot_number, quantity_received) values ('bpc-157', '10 mg', 'FORGED', 5)`],
    [`insert into public.expenses (incurred_on, category_code, description, amount_cents) values ('2026-01-01', 'other', 'x', 1)`],
    [`insert into public.expense_import (incurred_on, category, description, amount) values ('2026-01-01', 'other', 'x', '1')`],
    [`update public.inventory_items set low_stock_threshold = 0`],
    [`insert into public.order_line_lots (order_id, product_id, pack_size, lot_id, quantity) values ('${order}', 'bpc-157', '10 mg', '${lot}', 1)`],
    [`truncate public.admin_audit_log`]
  ];
  for (const [sql, params] of attempts) {
    const err = await errorOf(() => asServer(db, () => db.query(sql, params)));
    assert.match(err || 'allowed', /permission denied/, sql.slice(0, 70));
  }
  for (const fn of [
    `public.app_require('${owner}', 'orders.write')`,
    `public.set_order_status('${order}', 'processing', 'n', 'forged actor')`,
    `public.allocate_order_line('${order}', 'bpc-157', '10 mg', '${lot}', 1)`,
    `public.record_stock_movement('${lot}', 100, 'adjustment', 'free stock')`,
    `public.import_expenses()`,
    `public.current_actor()`
  ]) {
    assert.match(await errorOf(() => asServer(db, () => db.query(`select ${fn}`))) || 'callable', /permission denied/, fn);
  }
  // Even the table owner cannot edit or delete them.
  for (const sql of ['update public.admin_audit_log set details = \'{}\'', 'delete from public.admin_audit_log',
                     'update public.order_status_history set note = \'x\'', 'delete from public.order_notes']) {
    assert.match(await errorOf(() => db.query(sql)) || 'allowed', /append-only/, sql);
  }
  // The server can still read, which the console needs.
  assert.ok((await asServer(db, () => rows(db, 'select * from public.admin_audit_log'))).length > 0);
});

test('the actor recorded is the staff record, not anything the caller says', async () => {
  const { db, owner } = await setup();
  const { id: order } = await recordPaidOrder(db, 'cs_identity');
  // Even with a session setting claiming otherwise, the function records the
  // staff member it verified.
  await asServer(db, async () => {
    await db.exec(`select set_config('app.actor', 'forged@example.org', false)`);
    await db.query(`select public.admin_add_order_note($1, $2, 'note')`, [owner, order]);
  });
  const n = await one(db, 'select author_email from public.order_notes where order_id = $1', [order]);
  assert.equal(n.author_email, OWNER_EMAIL);
  assert.equal((await lastAudit(db)).actor_email, OWNER_EMAIL);
});

/* ======================================================== atomicity */

test('ship_order: carrier, tracking and status change together, or not at all', async () => {
  const { db, owner } = await setup();
  const lot = await stocked(db, owner);
  const { id: order } = await recordPaidOrder(db, 'cs_ship');
  await asServer(db, () => productLine(db, order, 'bpc-157', '10 mg', 2, 2600));
  const state = () => one(db, 'select status, carrier, tracking_number, shipped_at from public.orders where id = $1', [order]);
  const ship = (carrier, tracking) => call(db, `select (public.ship_order($1, $2, $3, $4, 'out today')).status`, [owner, order, carrier, tracking]);

  assert.match(await errorOf(() => ship('UPS', '1Z999')) || '', /only a packed order can be shipped/);
  for (const s of ['processing', 'packed']) await call(db, `select (public.admin_set_order_status($1, $2, $3)).status`, [owner, order, s]);
  assert.match(await errorOf(() => ship('UPS', '1Z999')) || '', /not yet drawn from a lot/);
  assert.deepEqual(await state(), { status: 'packed', carrier: null, tracking_number: null, shipped_at: null });

  await call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6)', [owner, order, 'bpc-157', '10 mg', lot, 2]);
  assert.match(await errorOf(() => ship('', '1Z999')) || '', /carrier is required/);
  assert.match(await errorOf(() => ship('UPS', '')) || '', /tracking number is required/);
  assert.match(await errorOf(() => ship('UPS', '<script>')) || '', /tracking number is required/);
  assert.match(await errorOf(() => call(db, `select (public.admin_set_order_status($1, $2, 'shipped')).status`, [owner, order])) || '', /use ship_order/);

  // Make the very last step (the history row) fail: nothing before it may stick.
  const before = await auditCount(db);
  await db.exec(`create function public.t_fail() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
                 create trigger t_fail before insert on public.order_status_history for each row execute function public.t_fail();`);
  assert.match(await errorOf(() => ship('UPS', '1Z999')) || '', /injected failure/);
  assert.deepEqual(await state(), { status: 'packed', carrier: null, tracking_number: null, shipped_at: null });
  assert.equal(await auditCount(db), before);
  await db.exec('drop trigger t_fail on public.order_status_history; drop function public.t_fail();');

  assert.equal((await ship(' UPS ', '1Z 999-AB')).status, 'shipped');
  const s = await state();
  assert.equal(s.carrier, 'UPS');
  assert.equal(s.tracking_number, '1Z 999-AB');
  assert.ok(s.shipped_at instanceof Date);
  assert.equal((await one(db, `select note, changed_by from public.order_status_history where order_id = $1 and to_status = 'shipped'`, [order])).note, 'out today');
  const a = await lastAudit(db);
  assert.equal(a.action, 'order.ship');
  assert.equal(a.details.tracking_number, '1Z 999-AB');
});

test('a failed audit write rolls back the status change it describes', async () => {
  const { db, owner } = await setup();
  const { id: order } = await recordPaidOrder(db, 'cs_audit_fail');
  await db.exec(`create function public.t_fail() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$;
                 create trigger t_fail before insert on public.admin_audit_log for each row execute function public.t_fail();`);
  assert.match(await errorOf(() => call(db, `select (public.admin_set_order_status($1, $2, 'processing')).status`, [owner, order])) || '', /audit down/);
  assert.equal((await one(db, 'select status from public.orders where id = $1', [order])).status, 'paid');
  assert.equal((await one(db, 'select count(*)::int n from public.order_status_history where order_id = $1', [order])).n, 1);
});

test('admin_set_order_status keeps the lifecycle rules and refuses paid', async () => {
  const { db, owner } = await setup();
  const { id: order } = await recordPaidOrder(db, 'cs_rules');
  assert.match(await errorOf(() => call(db, `select (public.admin_set_order_status($1, $2, 'delivered')).status`, [owner, order])) || '', /cannot move from paid to delivered/);
  await call(db, `select (public.admin_set_order_status($1, $2, 'processing')).status`, [owner, order]);
  assert.match(await errorOf(() => call(db, `select (public.admin_set_order_status($1, $2, 'paid')).status`, [owner, order])) || '', /cannot move from processing to paid/);
  assert.match(await errorOf(() => call(db, `select (public.admin_set_order_status($1, gen_random_uuid(), 'processing')).status`, [owner])) || '', /not found/);
});

/* ============================================================ notes */

test('order notes: timestamped, attributed, append-only, validated', async () => {
  const { db, owner } = await setup();
  const { id: order } = await recordPaidOrder(db, 'cs_notes');
  await call(db, `select public.admin_add_order_note($1, $2, '  Called the lab to confirm address  ')`, [owner, order]);
  await call(db, `select public.admin_add_order_note($1, $2, 'Second note')`, [owner, order]);
  const n = await rows(db, 'select body, author_email, created_at is not null as dated from public.order_notes where order_id = $1 order by id', [order]);
  assert.deepEqual(n, [{ body: 'Called the lab to confirm address', author_email: OWNER_EMAIL, dated: true },
                       { body: 'Second note', author_email: OWNER_EMAIL, dated: true }]);
  assert.match(await errorOf(() => call(db, `select public.admin_add_order_note($1, $2, '   ')`, [owner, order])) || '', /check/);
  assert.match(await errorOf(() => call(db, `select public.admin_add_order_note($1, gen_random_uuid(), 'x')`, [owner])) || '', /not found/);
});

/* ======================================================== inventory */

test('sync_inventory_items adds the catalogue, then deactivates and reactivates to match it', async () => {
  const { db, owner } = await setup();
  let r = await call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, JSON.stringify(CATALOG_ITEMS)]);
  assert.deepEqual(r, { added: CATALOG_ITEMS.length, reactivated: 0, deactivated: 0 });
  r = await call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, JSON.stringify(CATALOG_ITEMS)]);
  assert.deepEqual(r, { added: 0, reactivated: 0, deactivated: 0 });
  r = await call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, JSON.stringify(CATALOG_ITEMS.slice(1))]);
  assert.deepEqual(r, { added: 0, reactivated: 0, deactivated: 1 });
  r = await call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, JSON.stringify(CATALOG_ITEMS)]);
  assert.deepEqual(r, { added: 0, reactivated: 1, deactivated: 0 });
  assert.equal((await lastAudit(db)).action, 'inventory.sync_items');
  for (const bad of ['[]', '{}', '[{"product_id": "x"}]', '["x"]']) {
    assert.match(await errorOf(() => call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, bad])) || '', /items|product_id/, bad);
  }
});

test('receive_lot and admin_update_lot: validated, audited, and quantity stays frozen', async () => {
  const { db, owner } = await setup();
  await call(db, 'select * from public.sync_inventory_items($1, $2)', [owner, JSON.stringify(CATALOG_ITEMS)]);
  const rl = (lotNo, qty, received, retest) => call(db,
    `select public.receive_lot($1, 'bpc-157', '10 mg', $2, $3, $4, $5, 'coa/ref.pdf', 800, 'usd', ' Supplier ') as id`,
    [owner, lotNo, qty, received, retest]);
  const lot = (await rl('TEST-L1', 25, '2026-07-01', '2027-07-01')).id;
  assert.deepEqual(await one(db, 'select on_hand, coa_reference, currency from public.lot_levels where lot_id = $1', [lot]),
                   { on_hand: 25, coa_reference: 'coa/ref.pdf', currency: 'USD' });
  assert.equal((await lastAudit(db)).action, 'inventory.receive_lot');
  assert.match(await errorOf(() => rl('TEST-L1', 5, '2026-07-01', null)) || '', /duplicate|unique/);
  assert.match(await errorOf(() => rl('TEST-L2', 5, '2026-07-01', '2026-06-01')) || '', /retest date is before/);
  assert.match(await errorOf(() => call(db, `select public.receive_lot($1, 'nope', '10 mg', 'X', 5) as id`, [owner])) || '', /sync stock items/);

  await call(db, `select (public.admin_update_lot($1, $2, '{"unit_cost_cents": 900, "coa_reference": "coa/ref-v2.pdf"}')).id`, [owner, lot]);
  const a = await lastAudit(db);
  assert.equal(a.details.before.unit_cost_cents, 800);
  assert.equal(a.details.after.unit_cost_cents, 900);
  assert.match(await errorOf(() => call(db, `select (public.admin_update_lot($1, $2, '{"quantity_received": 99}')).id`, [owner, lot])) || '', /cannot change quantity_received/);

  await call(db, `select (public.admin_update_inventory_item($1, 'bpc-157', '10 mg', '{"low_stock_threshold": 30}')).product_id`, [owner]);
  assert.equal((await one(db, `select is_low from public.inventory_levels where product_id = 'bpc-157' and pack_size = '10 mg'`)).is_low, true);
  assert.match(await errorOf(() => call(db, `select (public.admin_update_inventory_item($1, 'bpc-157', '10 mg', '{"product_id": "x"}')).product_id`, [owner])) || '', /cannot change product_id/);
});

test('allocation can be released before shipping and not after', async () => {
  const { db, owner } = await setup();
  const lot = await stocked(db, owner);
  const { id: order } = await recordPaidOrder(db, 'cs_release');
  await asServer(db, () => productLine(db, order, 'bpc-157', '10 mg', 2, 2600));
  const alloc = (await call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6) as id', [owner, order, 'bpc-157', '10 mg', lot, 2])).id;
  assert.equal((await call(db, 'select public.admin_release_allocation($1, $2) as ok', [owner, alloc])).ok, true);
  const again = (await call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6) as id', [owner, order, 'bpc-157', '10 mg', lot, 2])).id;
  for (const s of ['processing', 'packed']) await call(db, `select (public.admin_set_order_status($1, $2, $3)).status`, [owner, order, s]);
  await call(db, `select (public.ship_order($1, $2, 'DHL', 'JD0001')).status`, [owner, order]);
  assert.match(await errorOf(() => call(db, 'select public.admin_release_allocation($1, $2) as ok', [owner, again])) || '', /only be released before it ships/);
});

/* ========================================================= expenses */

test('expenses: create, edit with before and after, delete with a reason, restore', async () => {
  const { db, owner } = await setup();
  const id = (await call(db, `select public.admin_create_expense($1, '2026-07-02', 'shipping_postage', 'Courier', 4200, 'usd', ' Courier Co ') as id`, [owner])).id;
  assert.deepEqual(await one(db, 'select amount_cents, currency, vendor from public.expenses where id = $1', [id]),
                   { amount_cents: 4200, currency: 'USD', vendor: 'Courier Co' });
  assert.match(await errorOf(() => call(db, `select public.admin_create_expense($1, '2026-07-02', 'groceries', 'x', 1) as id`, [owner])) || '', /unknown or inactive category/);

  await call(db, `select (public.admin_update_expense($1, $2, '{"amount_cents": 4500, "category_code": "packaging_supplies"}')).id`, [owner, id]);
  const a = await lastAudit(db);
  assert.equal(a.details.before.amount_cents, 4200);
  assert.equal(a.details.after.amount_cents, 4500);
  assert.match(await errorOf(() => call(db, `select (public.admin_update_expense($1, $2, '{"created_by": "x"}')).id`, [owner, id])) || '', /cannot change created_by/);
  assert.match(await errorOf(() => call(db, `select (public.admin_update_expense($1, $2, '{"category_code": "nope"}')).id`, [owner, id])) || '', /unknown or inactive/);

  const month = async () => (await rows(db, `select amount_cents::int from public.monthly_expenses where month = '2026-07-01'`)).map((r) => r.amount_cents);
  assert.deepEqual(await month(), [4500]);
  assert.match(await errorOf(() => call(db, 'select public.admin_delete_expense($1, $2, $3)', [owner, id, ' '])) || '', /needs a reason/);
  await call(db, 'select public.admin_delete_expense($1, $2, $3)', [owner, id, 'entered twice']);
  assert.deepEqual(await month(), [], 'a deleted expense still counts');
  assert.equal((await one(db, 'select count(*)::int n from public.expenses where id = $1', [id])).n, 1, 'deleted for real');
  assert.match(await errorOf(() => call(db, `select (public.admin_update_expense($1, $2, '{"amount_cents": 1}')).id`, [owner, id])) || '', /not found/);
  await call(db, 'select public.admin_restore_expense($1, $2)', [owner, id]);
  assert.deepEqual(await month(), [4500]);
  assert.deepEqual((await rows(db, `select action from public.admin_audit_log where entity_id = $1 order by id`, [id])).map((r) => r.action),
                   ['finance.create_expense', 'finance.update_expense', 'finance.delete_expense', 'finance.restore_expense']);
});

test('expense import through the console: staged, booked, attributed and audited', async () => {
  const { db, owner } = await setup();
  const staged = (await call(db, 'select public.admin_stage_expense_import($1, $2) as n', [owner, JSON.stringify([
    { incurred_on: '2026-07-01', category: 'software', description: 'Hosting', amount: '25.00' },
    { incurred_on: 'July 1', category: 'software', description: 'Bad date', amount: '5' }])])).n;
  assert.equal(staged, 2);
  const r = await call(db, 'select * from public.admin_import_expenses($1)', [owner]);
  assert.deepEqual(r, { imported: 1, duplicates: 0, errors: 1 });
  assert.equal((await one(db, `select created_by from public.expenses where description = 'Hosting'`)).created_by, OWNER_EMAIL);
  assert.deepEqual((await rows(db, `select action from public.admin_audit_log where action like 'finance.%' order by id`)).map((x) => x.action),
                   ['finance.stage_import', 'finance.import_expenses']);
  assert.match(await errorOf(() => call(db, 'select public.admin_stage_expense_import($1, $2) as n', [owner, '[]'])) || '', /1 to 5000/);
});

/* ===================================================== line mapping */

test('mapping a description-only line: explicit, audited, survives a redelivery, and reversible', async () => {
  const { db, owner } = await setup();
  const lot = await stocked(db, owner);
  const { id: order } = await asServer(db, () => recordPaidOrder(db, 'cs_map'));
  // As the current webhook records a line: description only.
  const writeItems = () => asServer(db, () => db.query(`insert into public.order_items (order_id, description, quantity, unit_amount, amount_total)
                                                          values ($1, 'BPC-157 — 10 mg', 2, 2600, 5200)`, [order]));
  await writeItems();
  const item = (await one(db, 'select id from public.order_items where order_id = $1', [order])).id;
  assert.equal((await one(db, 'select attention_reason from public.order_queue where order_id = $1', [order])).attention_reason, 'line needs product mapping');
  assert.match(await errorOf(() => call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6)', [owner, order, 'bpc-157', '10 mg', lot, 2])) || '', /has no line/);

  assert.match(await errorOf(() => call(db, `select public.admin_map_order_line($1, $2, 'bpc-157', '10 mg', '')`, [owner, item])) || '', /needs a note/);
  assert.match(await errorOf(() => call(db, `select public.admin_map_order_line($1, $2, 'nope', '10 mg', 'n')`, [owner, item])) || '', /no stock item/);
  const mapping = (await call(db, `select public.admin_map_order_line($1, $2, 'bpc-157', '10 mg', 'matches the receipt') as id`, [owner, item])).id;
  assert.deepEqual(await one(db, 'select sku, pack_size from public.order_items where id = $1', [item]), { sku: 'bpc-157', pack_size: '10 mg' });
  assert.match(await errorOf(() => call(db, `select public.admin_map_order_line($1, $2, 'bpc-157', '10 mg', 'again')`, [owner, item])) || '', /already names its product/);
  assert.equal((await lastAudit(db)).action, 'fulfilment.map_line');

  // The payment integration redelivers and rewrites the items: the mapping comes back with them.
  await asServer(db, () => db.query('delete from public.order_items where order_id = $1', [order]));
  await writeItems();
  assert.deepEqual(await one(db, 'select sku, pack_size from public.order_items where order_id = $1', [order]), { sku: 'bpc-157', pack_size: '10 mg' });

  await call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6)', [owner, order, 'bpc-157', '10 mg', lot, 2]);
  assert.equal((await one(db, 'select cost_complete from public.order_cogs where order_id = $1', [order])).cost_complete, true);

  assert.match(await errorOf(() => call(db, `select public.admin_unmap_order_line($1, $2, 'wrong product')`, [owner, mapping])) || '', /release the stock/);
  const alloc = (await one(db, 'select id from public.order_line_lots where order_id = $1 and released_at is null', [order])).id;
  await call(db, 'select public.admin_release_allocation($1, $2)', [owner, alloc]);
  await call(db, `select public.admin_unmap_order_line($1, $2, 'wrong product')`, [owner, mapping]);
  assert.deepEqual(await one(db, 'select sku, pack_size from public.order_items where order_id = $1', [order]), { sku: null, pack_size: null });
  assert.deepEqual(await one(db, 'select reverted_by, revert_note from public.order_line_mappings where id = $1', [mapping]),
                   { reverted_by: OWNER_EMAIL, revert_note: 'wrong product' });
  // A reverted mapping is not re-applied on the next redelivery.
  await asServer(db, () => db.query('delete from public.order_items where order_id = $1', [order]));
  await writeItems();
  assert.equal((await one(db, 'select sku from public.order_items where order_id = $1', [order])).sku, null);
});

/* ============================================================= views */

test('order queue: attention reasons, counts and search', async () => {
  const { db, owner } = await setup();
  const lot = await stocked(db, owner);
  const old = new Date(Date.now() - 3 * 864e5).toISOString();
  const { id: stale } = await insertOrder(db, { created_at: old });
  const { id: fresh } = await insertOrder(db, {});
  await db.query(`update public.orders set name = 'Dr Ada Lovelace' where id = $1`, [fresh]);
  const { id: packed } = await insertOrder(db, {});
  await productLine(db, packed, 'bpc-157', '10 mg', 3, 2600);
  for (const s of ['processing', 'packed']) await call(db, `select (public.admin_set_order_status($1, $2, $3)).status`, [owner, packed, s]);
  await call(db, `select public.admin_add_order_note($1, $2, 'waiting on stock')`, [owner, packed]);

  const q = Object.fromEntries((await asServer(db, () => rows(db, 'select order_id, attention_reason, unallocated_units, note_count::int from public.order_queue'))).map((r) => [r.order_id, r]));
  assert.equal(q[stale].attention_reason, 'paid over 24 hours, not started');
  assert.equal(q[fresh].attention_reason, null);
  assert.deepEqual([q[packed].attention_reason, q[packed].unallocated_units, q[packed].note_count],
                   ['packed with stock not drawn from a lot', 3, 1]);
  await call(db, 'select public.admin_allocate_order_line($1, $2, $3, $4, $5, $6)', [owner, packed, 'bpc-157', '10 mg', lot, 3]);
  assert.equal((await one(db, 'select attention_reason from public.order_queue where order_id = $1', [packed])).attention_reason, null);

  const found = await asServer(db, () => rows(db, `select order_id from public.order_queue where lower(name) like 'dr ada%'`));
  assert.deepEqual(found.map((r) => r.order_id), [fresh]);
  const idx = await rows(db, `select indexname from pg_indexes where tablename = 'orders' and indexname in ('orders_name_lower_idx', 'orders_email_lower_pattern_idx') order by 1`);
  assert.equal(idx.length, 2);
});

test('dashboard: status counts for every status and a one-row summary', async () => {
  const { db, owner } = await setup();
  await insertOrder(db, { amount_total: 10000 });
  await insertOrder(db, { amount_total: 5000, created_at: new Date(Date.now() - 5 * 864e5).toISOString() });
  await insertOrder(db, { amount_total: 99999, status: 'cancelled' });
  await stocked(db, owner, 'bpc-157', '10 mg', 2, 800);
  await call(db, `select (public.admin_update_inventory_item($1, 'bpc-157', '10 mg', '{"low_stock_threshold": 5}')).product_id`, [owner]);

  const counts = Object.fromEntries((await asServer(db, () => rows(db, 'select status, orders from public.dashboard_status_counts'))).map((r) => [r.status, r.orders]));
  assert.deepEqual(counts, { paid: 2, processing: 0, packed: 0, shipped: 0, delivered: 0, completed: 0, cancelled: 1, refunded: 0 });
  const d = await asServer(db, () => one(db, `select revenue_today_cents::int, revenue_7d_cents::int, orders_today, orders_7d,
                                                     average_order_30d_cents::int, low_stock_items, fees_and_tax_separated
                                              from public.dashboard_summary`));
  assert.deepEqual(d, { revenue_today_cents: 10000, revenue_7d_cents: 15000, orders_today: 1, orders_7d: 2,
                        average_order_30d_cents: 7500, low_stock_items: 1, fees_and_tax_separated: false });
});

/* ===================================================== browser roles */

test('browser roles can reach nothing added in 0004', async () => {
  const { db, owner } = await setup();
  const { id: order } = await recordPaidOrder(db, 'cs_browser');
  for (const role of ['anon', 'authenticated']) {
    await asRole(db, role, async () => {
      for (const t of ['permissions', 'staff_roles', 'role_permissions', 'staff_members', 'admin_audit_log', 'order_notes', 'order_line_mappings',
                       'order_queue', 'dashboard_status_counts', 'dashboard_summary', 'monthly_expenses']) {
        assert.match(await errorOf(() => db.query(`select * from public.${t}`)) || 'readable', /permission denied/, `${role} read ${t}`);
      }
      for (const fn of [
        `public.staff_can('${owner}', 'orders.read')`,
        `public.admin_set_order_status('${owner}', '${order}', 'processing')`,
        `public.admin_add_order_note('${owner}', '${order}', 'x')`,
        `public.ship_order('${owner}', '${order}', 'UPS', '1')`,
        `public.sync_inventory_items('${owner}', '[{"product_id":"a","pack_size":"b"}]')`,
        `public.receive_lot('${owner}', 'bpc-157', '10 mg', 'X', 1)`,
        `public.admin_create_expense('${owner}', '2026-01-01', 'other', 'x', 1)`,
        `public.admin_import_expenses('${owner}')`,
        `public.admin_map_order_line('${owner}', 1, 'bpc-157', '10 mg', 'n')`,
        `public.bootstrap_owner('x@example.org', gen_random_uuid())`
      ]) {
        assert.match(await errorOf(() => db.query(`select ${fn}`)) || 'callable', /permission denied/, `${role}: ${fn.slice(0, 40)}`);
      }
    });
  }
});

test('the payment path is unchanged: the server key still records orders and items and add-on sales', async () => {
  const { db } = await setup();
  await db.exec(`insert into public.addon_stock_movements (addon_id, delta, reason, note) values ('insulated-shipper', 5, 'restock', 't')`);
  await asServer(db, async () => {
    const { id } = await recordPaidOrder(db, 'cs_path');
    await db.query(`insert into public.order_items (order_id, kind, sku, addon_id, rule_id, parent_sku, parent_pack_size, quantity, unit_amount, amount_total)
                    values ($1, 'addon', 'insulated-shipper', 'insulated-shipper', 'r', 'tirzepatide', '100 mg', 1, 1200, 1200)`, [id]);
    await db.query('select public.record_addon_sales($1)', [id]);
    await db.query('delete from public.order_items where order_id = $1', [id]);
    const again = await recordPaidOrder(db, 'cs_path');
    assert.equal(again.id, id);
  });
});
