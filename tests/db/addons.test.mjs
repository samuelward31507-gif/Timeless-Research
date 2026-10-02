/*
 * Add-on stock and reporting: supabase/migrations/0002_addons.sql, checked with
 * every migration applied so a later one cannot quietly change its behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rows, one, insertOrder, errorOf, asRole, reapplyFrom } from './harness.mjs';

async function items(db, orderId, list) {
  for (const r of list) {
    await db.query(`insert into public.order_items (order_id, kind, sku, pack_size, addon_id, rule_id, parent_sku, parent_pack_size,
                    description, quantity, unit_amount, amount_total, offered_addons) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [orderId, r.kind, r.sku, r.pack ?? null, r.addon ?? null, r.rule ?? null, r.parent ?? null, r.ppack ?? null,
       r.d ?? null, r.qty, r.unit, r.unit * r.qty, r.offered ? JSON.stringify(r.offered) : null]);
  }
}
const levels = async (db) => Object.fromEntries((await rows(db, 'select addon_id, available from public.addon_stock_levels')).map((r) => [r.addon_id, r.available]));
const OFFERED = [{ addon: 'insulated-shipper', rule: 'cold' }, { addon: 'coa-certified-copy', rule: 'all' }];
const ORDER1 = [
  { kind: 'product', sku: 'tirzepatide', pack: '100 mg', qty: 1, unit: 18000, offered: OFFERED },
  { kind: 'addon', sku: 'insulated-shipper', addon: 'insulated-shipper', rule: 'cold', parent: 'tirzepatide', ppack: '100 mg', qty: 1, unit: 1200 },
  { kind: 'product', sku: 'bpc-157', pack: '10 mg', qty: 3, unit: 2600, offered: [{ addon: 'moisture-barrier-pouch', rule: 'pouch' }] },
  { kind: 'addon', sku: 'moisture-barrier-pouch', addon: 'moisture-barrier-pouch', rule: 'pouch', parent: 'bpc-157', ppack: '10 mg', qty: 3, unit: 125 }
];

async function setup() {
  const db = await freshDb();
  await db.exec(`insert into public.addon_stock_movements (addon_id, delta, reason, note) values
    ('insulated-shipper', 10, 'restock', 'initial'), ('moisture-barrier-pouch', 50, 'restock', 'initial')`);
  return db;
}

test('0002 applies twice', async () => {
  const db = await freshDb();
  await reapplyFrom(db, '0002_addons.sql');
  assert.ok(true);
});

test('record_addon_sales is idempotent, including across rewritten items', async () => {
  const db = await setup();
  const { id } = await insertOrder(db);
  await items(db, id, ORDER1);
  assert.equal((await one(db, 'select public.record_addon_sales($1) n', [id])).n, 2);
  assert.equal((await one(db, 'select public.record_addon_sales($1) n', [id])).n, 0);
  await db.query('delete from public.order_items where order_id = $1', [id]);
  await items(db, id, ORDER1);
  assert.equal((await one(db, 'select public.record_addon_sales($1) n', [id])).n, 0);
  assert.deepEqual(await levels(db), { 'insulated-shipper': 9, 'moisture-barrier-pouch': 47 });
});

test('revenue and attach-rate views', async () => {
  const db = await setup();
  const { id: o1 } = await insertOrder(db);
  await items(db, o1, ORDER1);
  const { id: o2 } = await insertOrder(db);
  await items(db, o2, [ORDER1[0]]);
  const rev = await rows(db, 'select addon_id, units, revenue_cents::int from public.addon_revenue order by addon_id');
  assert.deepEqual(rev, [{ addon_id: 'insulated-shipper', units: 1, revenue_cents: 1200 },
                         { addon_id: 'moisture-barrier-pouch', units: 3, revenue_cents: 375 }]);
  const ar = Object.fromEntries((await rows(db, `select addon_id, lines_offered::int, lines_taken::int, attach_rate_percent::float
                                                 from public.addon_attach_rate`)).map((r) => [r.addon_id, r]));
  assert.deepEqual(ar['insulated-shipper'], { addon_id: 'insulated-shipper', lines_offered: 2, lines_taken: 1, attach_rate_percent: 50 });
  assert.deepEqual(ar['coa-certified-copy'], { addon_id: 'coa-certified-copy', lines_offered: 2, lines_taken: 0, attach_rate_percent: 0 });
});

test('the new statuses count as sales in the add-on reports; cancelling releases add-on stock once', async () => {
  const db = await setup();
  const { id } = await insertOrder(db);
  await items(db, id, ORDER1);
  await db.query('select public.record_addon_sales($1)', [id]);
  // Every order still on its way, or delivered, is a sale for the add-on reports.
  for (const st of ['processing', 'packed']) {
    await db.query('select public.set_order_status($1, $2)', [id, st]);
    const units = Object.fromEntries((await rows(db, 'select addon_id, units from public.addon_revenue')).map((r) => [r.addon_id, r.units]));
    assert.deepEqual(units, { 'insulated-shipper': 1, 'moisture-barrier-pouch': 3 }, `${st}: dropped out of add-on revenue`);
    assert.equal((await one(db, `select lines_taken::int n from public.addon_attach_rate where addon_id = 'insulated-shipper'`)).n, 1,
                 `${st}: dropped out of attach rate`);
  }
  await db.query(`select public.set_order_status($1, 'cancelled')`, [id]);
  assert.deepEqual(await levels(db), { 'insulated-shipper': 10, 'moisture-barrier-pouch': 50 });
  await db.query(`select public.set_order_status($1, 'refunded')`, [id]);
  assert.deepEqual(await levels(db), { 'insulated-shipper': 10, 'moisture-barrier-pouch': 50 });
});

test('delivered and completed orders stay in the add-on reports; cancelled ones leave', async () => {
  const db = await setup();
  const { id } = await insertOrder(db);
  await items(db, id, ORDER1);
  for (const st of ['processing', 'packed', 'shipped', 'delivered', 'completed']) {
    await db.query('select public.set_order_status($1, $2)', [id, st]);
    assert.equal((await rows(db, 'select * from public.addon_revenue')).length, 2, `${st}: missing from add-on revenue`);
  }
  const { id: c } = await insertOrder(db);
  await items(db, c, ORDER1);
  await db.query(`select public.set_order_status($1, 'cancelled')`, [c]);
  assert.equal((await one(db, `select units::int n from public.addon_revenue where addon_id = 'moisture-barrier-pouch'`)).n, 3);
});

test('guards: add-on line shape, kind, sale without order, delete with movements, zero movement, oversell', async () => {
  const db = await setup();
  const { id } = await insertOrder(db);
  assert.match(await errorOf(() => db.query(`insert into public.order_items (order_id, kind, quantity) values ($1, 'addon', 1)`, [id])) || '', /order_items_addon_shape_check/);
  assert.match(await errorOf(() => db.query(`insert into public.order_items (order_id, kind, quantity) values ($1, 'gift', 1)`, [id])) || '', /order_items_kind_check/);
  assert.match(await errorOf(() => db.query(`insert into public.addon_stock_movements (addon_id, delta, reason) values ('x', -1, 'sale')`)) || '', /check/);
  assert.match(await errorOf(() => db.query(`insert into public.addon_stock_movements (addon_id, delta, reason) values ('x', 0, 'adjustment')`)) || '', /check/);
  await items(db, id, [{ kind: 'addon', sku: 'moisture-barrier-pouch', addon: 'moisture-barrier-pouch', rule: 'pouch', parent: 'bpc-157', ppack: '10 mg', qty: 60, unit: 125 }]);
  await db.query('select public.record_addon_sales($1)', [id]);
  assert.equal((await levels(db))['moisture-barrier-pouch'], -10, 'a paid oversell shows as negative stock');
  assert.match(await errorOf(() => db.query('delete from public.orders where id = $1', [id])) || '', /foreign key/);
});

test('add-on tables, views and functions are closed to browser roles', async () => {
  const db = await setup();
  const { id } = await insertOrder(db);
  await asRole(db, 'anon', async () => {
    assert.equal((await rows(db, 'select * from public.addon_stock_movements')).length, 0);
    for (const v of ['addon_stock_levels', 'addon_revenue', 'addon_attach_rate']) {
      assert.match(await errorOf(() => db.query(`select * from public.${v}`)) || 'readable', /permission denied/);
    }
    assert.match(await errorOf(() => db.query('select public.record_addon_sales($1)', [id])) || 'callable', /permission denied/);
    assert.match(await errorOf(() => db.query(`insert into public.addon_stock_movements (addon_id, delta, reason) values ('x', 1000, 'restock')`)) || 'writable',
                 /row-level security/);
  });
});
