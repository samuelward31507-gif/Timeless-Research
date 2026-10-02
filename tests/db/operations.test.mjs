/*
 * Phase 0 operations foundation: supabase/migrations/0003_operations_foundation.sql.
 *
 *   cd tests/db && npm ci && npm test
 *
 * Runs against a real PostgreSQL 16 (PGlite). Covers the order lifecycle and
 * its transition rules, stale or repeated payment confirmations, inventory and
 * lots, cost of goods and the financial views, expense CSV import, customer
 * aggregates, and that none of it is reachable from a browser role.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rows, one, recordPaidOrder, insertOrder, productLine, setStatus, errorOf, asRole, reapplyFrom } from './harness.mjs';

async function history(db, orderId) {
  return rows(db, `select from_status, to_status, changed_by, note from public.order_status_history
                   where order_id = $1 order by id`, [orderId]);
}

/* ===================================================== migration safety */

test('0003 keeps existing orders exactly as they were, and backfills history once', async () => {
  let before;
  const db = await freshDb({
    between: async (d, name) => {
      if (name !== '0002_addons.sql') return;
      await d.exec(`insert into public.orders (stripe_session_id, amount_total, currency, status, email, tracking_number, carrier, shipped_at, created_at) values
        ('legacy-paid',      5000, 'USD', 'paid',      'a@example.org', null,   null,  null,                   '2026-01-05'),
        ('legacy-shipped',   7000, 'USD', 'shipped',   'b@example.org', '1Z99', 'UPS', '2026-01-08 10:00+00', '2026-01-06'),
        ('legacy-cancelled', 3000, 'USD', 'cancelled', 'c@example.org', null,   null,  null,                   '2026-01-07'),
        ('legacy-refunded',  4000, 'USD', 'refunded',  'd@example.org', null,   null,  null,                   '2026-01-09')`);
      before = await rows(d, `select id, stripe_session_id, amount_total, currency, status, email, tracking_number, carrier,
                                     shipped_at, created_at from public.orders order by stripe_session_id`);
    }
  });
  const after = await rows(db, `select id, stripe_session_id, amount_total, currency, status, email, tracking_number, carrier,
                                       shipped_at, created_at from public.orders order by stripe_session_id`);
  assert.deepEqual(after, before);

  const h = await rows(db, `select o.stripe_session_id, h.from_status, h.to_status, h.changed_at = o.created_at as dated
                            from public.order_status_history h join public.orders o on o.id = h.order_id
                            order by o.stripe_session_id`);
  assert.deepEqual(h.map((r) => [r.stripe_session_id, r.from_status, r.to_status, r.dated]), [
    ['legacy-cancelled', null, 'cancelled', true], ['legacy-paid', null, 'paid', true],
    ['legacy-refunded', null, 'refunded', true], ['legacy-shipped', null, 'shipped', true]]);

  // Running the migration a second time changes nothing.
  await reapplyFrom(db, '0003_operations_foundation.sql');
  assert.equal((await one(db, 'select count(*)::int n from public.order_status_history')).n, 4);
  assert.equal((await one(db, 'select count(*)::int n from public.order_status_transitions')).n, 16);
  assert.equal((await one(db, 'select count(*)::int n from public.expense_categories')).n, 10);
});

/* ========================================================== lifecycle */

test('an order moves paid → processing → packed → shipped → delivered → completed, with history and timestamps', async () => {
  const db = await freshDb();
  const { id } = await recordPaidOrder(db, 'cs_happy');
  for (const s of ['processing', 'packed', 'shipped', 'delivered', 'completed']) {
    await setStatus(db, id, s, `to ${s}`, 'owner');
  }
  const o = await one(db, `select status, processing_at, packed_at, shipped_at, delivered_at, completed_at,
                                  status_changed_at, cancelled_at, refunded_at from public.orders where id = $1`, [id]);
  assert.equal(o.status, 'completed');
  for (const k of ['processing_at', 'packed_at', 'shipped_at', 'delivered_at', 'completed_at', 'status_changed_at']) {
    assert.ok(o[k] instanceof Date, `${k} not set`);
  }
  assert.equal(o.cancelled_at, null);
  assert.equal(o.refunded_at, null);
  const h = await history(db, id);
  assert.deepEqual(h.map((r) => [r.from_status, r.to_status]), [
    [null, 'paid'], ['paid', 'processing'], ['processing', 'packed'], ['packed', 'shipped'],
    ['shipped', 'delivered'], ['delivered', 'completed']]);
  assert.equal(h[3].note, 'to shipped');
  assert.equal(h[3].changed_by, 'owner');
});

test('moves that skip a step or go backward are refused', async () => {
  const db = await freshDb();
  const bad = [
    [[], 'shipped'], [[], 'delivered'], [[], 'completed'],
    [['processing'], 'shipped'],
    [['processing', 'packed', 'shipped'], 'cancelled'],
    [['processing', 'packed', 'shipped'], 'packed'],
    [['processing', 'packed', 'shipped', 'delivered', 'completed'], 'delivered'],
    [['refunded'], 'processing'],
    [['cancelled'], 'processing']
  ];
  for (const [path, target] of bad) {
    const { id } = await recordPaidOrder(db, 'cs_bad_' + path.join('_') + '_' + target);
    for (const s of path) await setStatus(db, id, s);
    const err = await errorOf(() => db.query(`update public.orders set status = $2 where id = $1`, [id, target]));
    assert.match(err || '', /cannot move from/, `${path.join('>') || 'paid'} -> ${target} was allowed`);
  }
  // Back to 'paid' is the stale-confirmation case: not an error, just ignored.
  const { id: back } = await recordPaidOrder(db, 'cs_back_to_paid');
  await setStatus(db, back, 'refunded');
  await db.query(`update public.orders set status = 'paid' where id = $1`, [back]);
  assert.equal((await one(db, 'select status from public.orders where id = $1', [back])).status, 'refunded');

  const { id } = await recordPaidOrder(db, 'cs_unknown');
  assert.match(await errorOf(() => setStatus(db, id, 'lost')) || '', /cannot move|orders_status_check/);
  assert.match(await errorOf(() => db.query(`update public.orders set status = 'lost' where id = $1`, [id])) || '',
               /cannot move|orders_status_check/);
});

test('the exits: cancel then refund, refund after shipping, unpack', async () => {
  const db = await freshDb();
  let { id } = await recordPaidOrder(db, 'cs_exit1');
  await setStatus(db, id, 'cancelled');
  await setStatus(db, id, 'refunded');
  assert.equal((await one(db, 'select status from public.orders where id = $1', [id])).status, 'refunded');

  ({ id } = await recordPaidOrder(db, 'cs_exit2'));
  for (const s of ['processing', 'packed', 'shipped', 'refunded']) await setStatus(db, id, s);
  const r = await one(db, 'select status, refunded_at, shipped_at from public.orders where id = $1', [id]);
  assert.equal(r.status, 'refunded');
  assert.ok(r.refunded_at && r.shipped_at);

  ({ id } = await recordPaidOrder(db, 'cs_exit3'));
  for (const s of ['processing', 'packed', 'processing', 'packed', 'shipped']) await setStatus(db, id, s);
  assert.equal((await one(db, 'select status from public.orders where id = $1', [id])).status, 'shipped');
});

test('set_order_status refuses to put an order back to paid, and an unknown order', async () => {
  const db = await freshDb();
  const { id } = await recordPaidOrder(db, 'cs_sos');
  await setStatus(db, id, 'processing');
  assert.match(await errorOf(() => setStatus(db, id, 'paid')) || '', /cannot move from processing to paid/);
  assert.match(await errorOf(() => setStatus(db, '00000000-0000-0000-0000-000000000000', 'processing')) || '', /not found/);
});

/* ============================================ stale payment confirmations */

test('a repeated payment confirmation cannot move an order backward, from any later state', async () => {
  const db = await freshDb();
  const paths = {
    processing: ['processing'],
    packed: ['processing', 'packed'],
    shipped: ['processing', 'packed', 'shipped'],
    delivered: ['processing', 'packed', 'shipped', 'delivered'],
    completed: ['processing', 'packed', 'shipped', 'delivered', 'completed'],
    cancelled: ['cancelled'],
    refunded: ['processing', 'packed', 'shipped', 'refunded']
  };
  for (const [state, path] of Object.entries(paths)) {
    const sid = 'cs_stale_' + state;
    const { id } = await recordPaidOrder(db, sid);
    for (const s of path) await setStatus(db, id, s);
    await db.query(`update public.orders set tracking_number = '1Z-TRACK' where id = $1`, [id]);
    const before = await one(db, `select status, shipped_at, tracking_number, status_changed_at from public.orders where id = $1`, [id]);
    const historyBefore = (await history(db, id)).length;

    // The confirmation arrives again, as the webhook sends it: status 'paid'.
    const res = await recordPaidOrder(db, sid);
    assert.equal(res.id, id, 'the retry must update the same order, not create one');
    assert.equal(res.status, state, `${state}: moved back to ${res.status}`);

    const after = await one(db, `select status, shipped_at, tracking_number, status_changed_at from public.orders where id = $1`, [id]);
    assert.deepEqual(after, before, `${state}: order changed`);
    assert.equal((await history(db, id)).length, historyBefore, `${state}: a history row was written`);
  }
});

test('a plain update to paid from a later state is ignored the same way; a retry while still paid is a no-op', async () => {
  const db = await freshDb();
  const { id } = await recordPaidOrder(db, 'cs_direct');
  await recordPaidOrder(db, 'cs_direct');
  await recordPaidOrder(db, 'cs_direct');
  assert.equal((await history(db, id)).length, 1, 'retries while paid wrote history');
  await setStatus(db, id, 'processing');
  await db.query(`update public.orders set status = 'paid' where id = $1`, [id]);
  assert.equal((await one(db, 'select status from public.orders where id = $1', [id])).status, 'processing');
});

test('a late confirmation does not re-sell add-ons released by a cancellation', async () => {
  const db = await freshDb();
  await db.query(`insert into public.addon_stock_movements (addon_id, delta, reason, note) values ('insulated-shipper', 10, 'restock', 't')`);
  const { id } = await recordPaidOrder(db, 'cs_addon');
  await db.query(`insert into public.order_items (order_id, kind, sku, addon_id, rule_id, parent_sku, parent_pack_size, quantity, unit_amount, amount_total)
                  values ($1, 'addon', 'insulated-shipper', 'insulated-shipper', 'r', 'tirzepatide', '100 mg', 1, 1200, 1200)`, [id]);
  await db.query('select public.record_addon_sales($1)', [id]);
  await setStatus(db, id, 'cancelled');
  await recordPaidOrder(db, 'cs_addon');
  await db.query('select public.record_addon_sales($1)', [id]);
  const lvl = await one(db, `select available from public.addon_stock_levels where addon_id = 'insulated-shipper'`);
  assert.equal(lvl.available, 10);
  assert.equal((await one(db, 'select status from public.orders where id = $1', [id])).status, 'cancelled');
});

/* ======================================================== inventory & lots */

async function stockItem(db, product, pack, threshold) {
  await db.query(`insert into public.inventory_items (product_id, pack_size, low_stock_threshold) values ($1, $2, $3)`,
                 [product, pack, threshold ?? null]);
}
async function lot(db, product, pack, number, qty, costCents, extra = {}) {
  return (await one(db, `insert into public.lots (product_id, pack_size, lot_number, quantity_received, unit_cost_cents, retest_date, coa_reference)
                         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [product, pack, number, qty, costCents ?? null, extra.retest ?? null, extra.coa ?? null])).id;
}
const level = (db, product, pack) =>
  one(db, `select on_hand, committed_unallocated, available, is_low from public.inventory_levels where product_id = $1 and pack_size = $2`, [product, pack]);
const allocate = (db, order, product, pack, lotId, qty) =>
  db.query('select public.allocate_order_line($1,$2,$3,$4,$5) as id', [order, product, pack, lotId, qty]);

test('receiving a lot puts its quantity into stock once; a lot cannot be redefined; the ledger is append-only', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg', 5);
  const L = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 40, 800, { retest: '2027-01-01', coa: 'coa/test-a.pdf' });
  assert.deepEqual(await level(db, 'bpc-157', '10 mg'), { on_hand: 40, committed_unallocated: 0, available: 40, is_low: false });
  const ll = await one(db, 'select on_hand, quantity_received, coa_reference, unit_cost_cents from public.lot_levels where lot_id = $1', [L]);
  assert.deepEqual(ll, { on_hand: 40, quantity_received: 40, coa_reference: 'coa/test-a.pdf', unit_cost_cents: 800 });

  assert.match(await errorOf(() => db.query(`update public.lots set quantity_received = 50 where id = $1`, [L])) || '', /cannot change/);
  assert.match(await errorOf(() => db.query(`update public.lots set product_id = 'tb-500' where id = $1`, [L])) || '', /cannot change|violates/);
  await db.query(`update public.lots set retest_date = '2027-06-01', coa_reference = 'coa/test-a-v2.pdf', unit_cost_cents = 850 where id = $1`, [L]);
  assert.match(await errorOf(() => db.query(`update public.stock_movements set delta = 99 where lot_id = $1`, [L])) || '', /cannot be changed/);
  assert.match(await errorOf(() => db.query(`delete from public.stock_movements where lot_id = $1`, [L])) || '', /cannot be changed/);
  assert.match(await errorOf(() => lot(db, 'bpc-157', '10 mg', 'TEST-A', 5)) || '', /duplicate|unique/);
  assert.match(await errorOf(() => lot(db, 'no-such', '10 mg', 'X', 5)) || '', /foreign key/);
  assert.match(await errorOf(() => lot(db, 'bpc-157', '10 mg', '  ', 5)) || '', /check/);
});

test('allocating one lot per order line takes stock out, and is bounded by the order and the lot', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg', 5);
  const A = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 10, 800);
  const { id: order } = await recordPaidOrder(db, 'cs_alloc');
  await productLine(db, order, 'bpc-157', '10 mg', 4, 2600);

  assert.deepEqual(await level(db, 'bpc-157', '10 mg'), { on_hand: 10, committed_unallocated: 4, available: 6, is_low: false });
  await allocate(db, order, 'bpc-157', '10 mg', A, 4);
  assert.deepEqual(await level(db, 'bpc-157', '10 mg'), { on_hand: 6, committed_unallocated: 0, available: 6, is_low: false });

  assert.match(await errorOf(() => allocate(db, order, 'bpc-157', '10 mg', A, 1)) || '', /already allocated|duplicate|unique/);
  const { id: other } = await recordPaidOrder(db, 'cs_alloc2');
  await productLine(db, other, 'bpc-157', '10 mg', 20, 2600);
  assert.match(await errorOf(() => allocate(db, other, 'bpc-157', '10 mg', A, 7)) || '', /only 6 on hand/);
  assert.match(await errorOf(() => allocate(db, other, 'bpc-157', '10 mg', A, 0)) || '', /positive/);

  await stockItem(db, 'tb-500', '10 mg');
  const T = await lot(db, 'tb-500', '10 mg', 'TEST-T', 10, 900);
  assert.match(await errorOf(() => allocate(db, other, 'bpc-157', '10 mg', T, 1)) || '', /is tb-500 10 mg, not bpc-157 10 mg/);
  assert.match(await errorOf(() => allocate(db, other, 'tb-500', '10 mg', T, 1)) || '', /has no line/);

  // A line recorded with a description only (as the current webhook writes it) cannot be allocated.
  const { id: legacy } = await recordPaidOrder(db, 'cs_legacy');
  await db.query(`insert into public.order_items (order_id, description, quantity, unit_amount, amount_total)
                  values ($1, 'BPC-157 — 10 mg', 2, 2600, 5200)`, [legacy]);
  assert.match(await errorOf(() => allocate(db, legacy, 'bpc-157', '10 mg', A, 2)) || '', /has no line/);

  for (const s of ['processing', 'packed', 'shipped']) await setStatus(db, order, s);
  assert.match(await errorOf(() => allocate(db, order, 'bpc-157', '10 mg', A, 1)) || '', /only be allocated before it ships/);
});

test('one order line can be split across two lots without any schema change', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg');
  const A = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 3, 800);
  const B = await lot(db, 'bpc-157', '10 mg', 'TEST-B', 10, 1000);
  const { id: order } = await recordPaidOrder(db, 'cs_split');
  await productLine(db, order, 'bpc-157', '10 mg', 5, 2600);
  await allocate(db, order, 'bpc-157', '10 mg', A, 3);
  await allocate(db, order, 'bpc-157', '10 mg', B, 2);
  const lots = await rows(db, `select lot_number, on_hand from public.lot_levels order by lot_number`);
  assert.deepEqual(lots, [{ lot_number: 'TEST-A', on_hand: 0 }, { lot_number: 'TEST-B', on_hand: 8 }]);
  const cogs = await one(db, 'select cogs_cents::int, units_ordered, units_costed, cost_complete from public.order_cogs where order_id = $1', [order]);
  assert.deepEqual(cogs, { cogs_cents: 3 * 800 + 2 * 1000, units_ordered: 5, units_costed: 5, cost_complete: true });
});

test('cancelling, or refunding before shipping, returns allocated stock once; refunding after shipping does not', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg');
  const A = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 20, 800);
  const onHand = async () => (await one(db, 'select on_hand from public.lot_levels where lot_id = $1', [A])).on_hand;

  const { id: c } = await recordPaidOrder(db, 'cs_cancel');
  await productLine(db, c, 'bpc-157', '10 mg', 5, 2600);
  await allocate(db, c, 'bpc-157', '10 mg', A, 5);
  await setStatus(db, c, 'cancelled');
  assert.equal(await onHand(), 20);
  await setStatus(db, c, 'refunded');
  assert.equal(await onHand(), 20, 'released twice');

  const { id: r } = await recordPaidOrder(db, 'cs_refund_unshipped');
  await productLine(db, r, 'bpc-157', '10 mg', 4, 2600);
  await allocate(db, r, 'bpc-157', '10 mg', A, 4);
  await setStatus(db, r, 'processing');
  await setStatus(db, r, 'refunded');
  assert.equal(await onHand(), 20);

  const { id: s } = await recordPaidOrder(db, 'cs_refund_shipped');
  await productLine(db, s, 'bpc-157', '10 mg', 3, 2600);
  await allocate(db, s, 'bpc-157', '10 mg', A, 3);
  for (const st of ['processing', 'packed', 'shipped', 'refunded']) await setStatus(db, s, st);
  assert.equal(await onHand(), 17, 'shipped goods came back on refund');

  // When the parcel does come back, the owner records it.
  await db.query(`select public.record_stock_movement($1, 3, 'return', 'parcel returned undamaged')`, [A]);
  assert.equal(await onHand(), 20);

  // Deallocating by hand before packing also returns stock, once.
  const { id: d } = await recordPaidOrder(db, 'cs_dealloc');
  await productLine(db, d, 'bpc-157', '10 mg', 2, 2600);
  const { id: allocId } = await one(db, 'select public.allocate_order_line($1,$2,$3,$4,$5) as id', [d, 'bpc-157', '10 mg', A, 2]);
  assert.equal((await one(db, 'select public.release_allocation($1) as ok', [allocId])).ok, true);
  assert.equal((await one(db, 'select public.release_allocation($1) as ok', [allocId])).ok, false);
  assert.equal(await onHand(), 20);
  await allocate(db, d, 'bpc-157', '10 mg', A, 2);
  assert.equal(await onHand(), 18, 'the same lot can be allocated again after a release');
});

test('manual movements need a reason and a note, and cannot take a lot below zero', async () => {
  const db = await freshDb();
  await stockItem(db, 'tb-500', '10 mg');
  const T = await lot(db, 'tb-500', '10 mg', 'TEST-T', 5, null);
  assert.match(await errorOf(() => db.query(`select public.record_stock_movement($1, -1, 'write_off', '')`, [T])) || '', /needs a note/);
  assert.match(await errorOf(() => db.query(`select public.record_stock_movement($1, 5, 'receipt', 'more')`, [T])) || '', /takes return, adjustment or write_off/);
  assert.match(await errorOf(() => db.query(`select public.record_stock_movement($1, -6, 'write_off', 'vial broken')`, [T])) || '', /only 5 on hand/);
  assert.match(await errorOf(() => db.query(`select public.record_stock_movement($1, 2, 'write_off', 'x')`, [T])) || '', /check/);
  await db.query(`select public.record_stock_movement($1, -1, 'write_off', 'vial broken')`, [T]);
  await db.query(`select public.record_stock_movement($1, 2, 'adjustment', 'count correction')`, [T]);
  assert.equal((await one(db, 'select on_hand, adjusted from public.lot_levels where lot_id = $1', [T])).on_hand, 6);
});

test('low stock and velocity', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg', 5);
  await stockItem(db, 'tb-500', '10 mg');          // no threshold: never "low"
  await stockItem(db, 'semax', '10 mg', 0);
  const A = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 8, 800);
  await lot(db, 'tb-500', '10 mg', 'TEST-T', 1, 900);
  const { id: order } = await recordPaidOrder(db, 'cs_low');
  await productLine(db, order, 'bpc-157', '10 mg', 4, 2600);
  // 8 on hand, 4 committed: available 4 <= 5
  assert.deepEqual((await rows(db, 'select product_id, available from public.low_stock order by product_id')),
                   [{ product_id: 'bpc-157', available: 4 }, { product_id: 'semax', available: 0 }]);
  await allocate(db, order, 'bpc-157', '10 mg', A, 4);
  const v = await one(db, `select units_out_30d, units_out_90d from public.inventory_velocity where product_id = 'bpc-157'`);
  assert.deepEqual(v, { units_out_30d: 4, units_out_90d: 4 });
  await db.query(`update public.inventory_items set active = false where product_id = 'semax'`);
  assert.deepEqual((await rows(db, 'select product_id from public.low_stock')).map((r) => r.product_id), ['bpc-157']);
});

test('retest flags on lots', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg');
  const past = await lot(db, 'bpc-157', '10 mg', 'TEST-PAST', 1, null, { retest: '2000-01-01' });
  const soon = await lot(db, 'bpc-157', '10 mg', 'TEST-SOON', 1, null,
    { retest: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10) });
  const none = await lot(db, 'bpc-157', '10 mg', 'TEST-NONE', 1, null);
  const f = async (id) => one(db, 'select retest_overdue, retest_due_30d from public.lot_levels where lot_id = $1', [id]);
  assert.deepEqual(await f(past), { retest_overdue: true, retest_due_30d: true });
  assert.deepEqual(await f(soon), { retest_overdue: false, retest_due_30d: true });
  assert.deepEqual(await f(none), { retest_overdue: false, retest_due_30d: false });
});

/* =============================================================== financials */

test('monthly revenue and average order value count sales only, and say fees and tax are not separated', async () => {
  const db = await freshDb();
  await insertOrder(db, { amount_total: 10000, amount_subtotal: 9000, amount_shipping: 1000, created_at: '2026-03-02' });
  await insertOrder(db, { amount_total: 20500, amount_subtotal: 21000, amount_shipping: 1500, amount_discount: 2000, created_at: '2026-03-20' });
  await insertOrder(db, { amount_total: 99900, status: 'cancelled', created_at: '2026-03-21' });
  await insertOrder(db, { amount_total: 88800, status: 'refunded', created_at: '2026-03-22' });
  await insertOrder(db, { amount_total: 5000, amount_subtotal: 5000, amount_shipping: 0, created_at: '2026-04-01' });
  const m = await rows(db, `select month::text, orders::int, total_cents::int, goods_net_cents::int, shipping_cents::int,
                                   discount_cents::int, average_order_cents::int, fees_and_tax_separated
                            from public.monthly_revenue order by month`);
  assert.deepEqual(m, [
    { month: '2026-03-01', orders: 2, total_cents: 30500, goods_net_cents: 9000 + (21000 - 2000), shipping_cents: 2500,
      discount_cents: 2000, average_order_cents: 15250, fees_and_tax_separated: false },
    { month: '2026-04-01', orders: 1, total_cents: 5000, goods_net_cents: 5000, shipping_cents: 0,
      discount_cents: 0, average_order_cents: 5000, fees_and_tax_separated: false }]);
  const all = await one(db, 'select orders::int, total_cents::int, average_order_cents::int from public.order_metrics');
  assert.deepEqual(all, { orders: 3, total_cents: 35500, average_order_cents: 11833 });
});

test('expenses by month and category; inventory purchases are kept out of operating expenses', async () => {
  const db = await freshDb();
  await db.exec(`insert into public.expenses (incurred_on, category_code, description, amount_cents) values
    ('2026-03-03', 'shipping_postage',    'Courier invoice',     4200),
    ('2026-03-15', 'shipping_postage',    'Courier invoice',     1800),
    ('2026-03-20', 'software',            'Hosting',             2500),
    ('2026-03-25', 'inventory_purchases', 'Stock purchase',    100000),
    ('2026-03-28', 'software',            'Refund from vendor',  -500)`);
  const e = await rows(db, `select month::text, category_code, treatment, entries::int, amount_cents::int
                            from public.monthly_expenses order by category_code`);
  assert.deepEqual(e, [
    { month: '2026-03-01', category_code: 'inventory_purchases', treatment: 'inventory', entries: 1, amount_cents: 100000 },
    { month: '2026-03-01', category_code: 'shipping_postage', treatment: 'operating', entries: 2, amount_cents: 6000 },
    { month: '2026-03-01', category_code: 'software', treatment: 'operating', entries: 2, amount_cents: 2000 }]);
  await insertOrder(db, { amount_total: 30000, created_at: '2026-03-10' });
  const s = await one(db, `select orders::int, revenue_total_cents::int, operating_expenses_cents::int, inventory_purchases_cents::int,
                                  fees_and_tax_separated from public.monthly_financial_summary where month = '2026-03-01'`);
  assert.deepEqual(s, { orders: 1, revenue_total_cents: 30000, operating_expenses_cents: 8000,
                        inventory_purchases_cents: 100000, fees_and_tax_separated: false });
  assert.match(await errorOf(() => db.query(`insert into public.expenses (incurred_on, category_code, description, amount_cents)
                                              values ('2026-03-01', 'nope', 'x', 1)`)) || '', /foreign key/);
  assert.match(await errorOf(() => db.query(`insert into public.expenses (incurred_on, category_code, description, amount_cents)
                                              values ('2026-03-01', 'other', 'x', 0)`)) || '', /check/);
});

test('gross margin is reported only over orders whose cost of goods is fully known', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg');
  await stockItem(db, 'tb-500', '10 mg');
  const A = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 50, 800);   // costed
  const U = await lot(db, 'tb-500', '10 mg', 'TEST-U', 50, null);   // cost not yet known

  // Complete: 4 units at $8 cost, goods $104 net.
  const { id: o1 } = await insertOrder(db, { amount_total: 11400, amount_subtotal: 10400, amount_shipping: 1000, created_at: '2026-05-02' });
  await productLine(db, o1, 'bpc-157', '10 mg', 4, 2600);
  await allocate(db, o1, 'bpc-157', '10 mg', A, 4);
  // Incomplete: allocated to an uncosted lot.
  const { id: o2 } = await insertOrder(db, { amount_total: 6000, amount_subtotal: 5000, amount_shipping: 1000, created_at: '2026-05-03' });
  await productLine(db, o2, 'tb-500', '10 mg', 2, 2500);
  await allocate(db, o2, 'tb-500', '10 mg', U, 2);
  // Incomplete: not allocated yet.
  const { id: o3 } = await insertOrder(db, { amount_total: 3600, amount_subtotal: 2600, amount_shipping: 1000, created_at: '2026-05-04' });
  await productLine(db, o3, 'bpc-157', '10 mg', 1, 2600);
  // Incomplete: legacy line with no sku.
  const { id: o4 } = await insertOrder(db, { amount_total: 3600, amount_subtotal: 2600, amount_shipping: 1000, created_at: '2026-05-05' });
  await db.query(`insert into public.order_items (order_id, description, quantity, unit_amount, amount_total) values ($1, 'BPC-157 — 10 mg', 1, 2600, 2600)`, [o4]);

  // Incomplete: partly allocated, so it carries SOME known cost that must not
  // leak into the margin figures.
  const { id: o5 } = await insertOrder(db, { amount_total: 14000, amount_subtotal: 13000, amount_shipping: 1000, created_at: '2026-05-06' });
  await productLine(db, o5, 'bpc-157', '10 mg', 5, 2600);
  await allocate(db, o5, 'bpc-157', '10 mg', A, 2);

  const c = Object.fromEntries((await rows(db, 'select order_id, cost_complete, cogs_cents::int from public.order_cogs')).map((r) => [r.order_id, r]));
  assert.deepEqual([c[o1].cost_complete, c[o2].cost_complete, c[o3].cost_complete, c[o4].cost_complete, c[o5].cost_complete],
                   [true, false, false, false, false]);
  assert.equal(c[o1].cogs_cents, 3200);
  assert.equal(c[o5].cogs_cents, 1600, 'partial cost is visible per order');

  const g = await one(db, `select orders::int, orders_cost_complete::int, goods_net_cents_costed::int, cogs_cents_costed::int,
                                  gross_margin_cents::int, gross_margin_percent::float from public.monthly_gross_margin where month = '2026-05-01'`);
  assert.deepEqual(g, { orders: 5, orders_cost_complete: 1, goods_net_cents_costed: 10400, cogs_cents_costed: 3200,
                        gross_margin_cents: 7200, gross_margin_percent: 69.2 });

  // Costing the lot later completes that order without touching the ledger.
  await db.query('update public.lots set unit_cost_cents = 1000 where id = $1', [U]);
  const g2 = await one(db, `select orders_cost_complete::int, gross_margin_cents::int from public.monthly_gross_margin where month = '2026-05-01'`);
  assert.deepEqual(g2, { orders_cost_complete: 2, gross_margin_cents: 7200 + (5000 - 2000) });
});

test('expense CSV import: good rows in, bad rows explained, re-imports are duplicates', async () => {
  const db = await freshDb();
  await db.exec(`insert into public.expense_import (incurred_on, category, description, amount, currency, vendor, reference) values
    ('2026-06-01', 'shipping_postage',     'Courier June',   '$1,234.50', '',    'Courier Co', 'INV-1'),
    ('2026-06-02', 'Software and subscriptions', 'Hosting', '25',        'usd', null,          null),
    ('2026-06-03', 'other',                'Vendor credit',  '-10.00',    null,  null,          null),
    ('06/04/2026', 'other',                'Bad date',       '5',         null,  null,          null),
    ('2026-06-05', 'groceries',            'Bad category',   '5',         null,  null,          null),
    ('2026-06-06', 'other',                'Bad amount',     '5.123',     null,  null,          null),
    ('2026-06-07', 'other',                '',               '5',         null,  null,          null),
    ('2026-06-08', 'other',                'Zero',           '0.00',      null,  null,          null),
    ('2026-02-30', 'other',                'Impossible day', '5',         null,  null,          null)`);
  const r1 = await one(db, 'select * from public.import_expenses()');
  assert.deepEqual(r1, { imported: 3, duplicates: 0, errors: 6 });
  const e = await rows(db, 'select description, amount_cents, currency, category_code from public.expenses order by incurred_on');
  assert.deepEqual(e, [
    { description: 'Courier June', amount_cents: 123450, currency: 'USD', category_code: 'shipping_postage' },
    { description: 'Hosting', amount_cents: 2500, currency: 'USD', category_code: 'software' },
    { description: 'Vendor credit', amount_cents: -1000, currency: 'USD', category_code: 'other' }]);
  const errs = await rows(db, `select description, error from public.expense_import where status = 'error' order by id`);
  assert.deepEqual(errs.map((x) => x.description), ['Bad date', 'Bad category', 'Bad amount', '', 'Zero', 'Impossible day']);
  assert.match(errs[0].error, /YYYY-MM-DD/);
  assert.match(errs[1].error, /unknown category "groceries"/);
  assert.match(errs[2].error, /two decimals/);
  assert.match(errs[3].error, /description is required/);
  assert.match(errs[4].error, /cannot be zero/);
  assert.ok(errs[5].error.length > 0);

  // Running it again does nothing; loading the same file again marks duplicates.
  assert.deepEqual(await one(db, 'select * from public.import_expenses()'), { imported: 0, duplicates: 0, errors: 0 });
  await db.exec(`insert into public.expense_import (incurred_on, category, description, amount, vendor, reference) values
    ('2026-06-01', 'shipping_postage', 'Courier June', '1234.50', 'Courier Co', 'INV-1')`);
  assert.deepEqual(await one(db, 'select * from public.import_expenses()'), { imported: 0, duplicates: 1, errors: 0 });
  assert.equal((await one(db, 'select count(*)::int n from public.expenses')).n, 3);
});

/* ======================================================= customer aggregates */

test('customer aggregates: first and last order, count, lifetime revenue, repeat rate', async () => {
  const db = await freshDb();
  await insertOrder(db, { email: 'Repeat@Example.org', amount_total: 10000, created_at: '2026-01-10' });
  await insertOrder(db, { email: 'repeat@example.org ', amount_total: 5000, created_at: '2026-03-10' });
  await insertOrder(db, { email: 'repeat@example.org', amount_total: 70000, status: 'cancelled', created_at: '2026-04-10' });
  await insertOrder(db, { email: 'once@example.org', amount_total: 2500, created_at: '2026-02-01' });
  await insertOrder(db, { email: 'gone@example.org', amount_total: 9000, status: 'refunded', created_at: '2026-02-02' });
  await insertOrder(db, { email: null, amount_total: 1000, created_at: '2026-02-03' });

  const c = await rows(db, `select customer_email, first_order_at::date::text as first, last_order_at::date::text as last,
                                   order_count::int, lifetime_revenue_cents::int, average_order_cents::int, is_repeat
                            from public.customer_aggregates order by customer_email`);
  assert.deepEqual(c, [
    { customer_email: 'once@example.org', first: '2026-02-01', last: '2026-02-01', order_count: 1,
      lifetime_revenue_cents: 2500, average_order_cents: 2500, is_repeat: false },
    { customer_email: 'repeat@example.org', first: '2026-01-10', last: '2026-03-10', order_count: 2,
      lifetime_revenue_cents: 15000, average_order_cents: 7500, is_repeat: true }]);
  const s = await one(db, `select customers::int, repeat_customers::int, repeat_rate_percent::float,
                                  average_lifetime_revenue_cents::int, orders_without_email::int from public.customer_summary`);
  assert.deepEqual(s, { customers: 2, repeat_customers: 1, repeat_rate_percent: 50, average_lifetime_revenue_cents: 8750, orders_without_email: 1 });
});

/* ================================================================= access */

test('nothing new is readable, writable or callable from a browser role', async () => {
  const db = await freshDb();
  await stockItem(db, 'bpc-157', '10 mg');
  const A = await lot(db, 'bpc-157', '10 mg', 'TEST-A', 5, 800);
  const { id: order } = await recordPaidOrder(db, 'cs_rls');
  await db.exec(`insert into public.expenses (incurred_on, category_code, description, amount_cents) values ('2026-01-01', 'other', 'x', 100)`);

  for (const role of ['anon', 'authenticated']) {
    await asRole(db, role, async () => {
      for (const t of ['order_status_history', 'order_status_transitions', 'inventory_items', 'lots', 'order_line_lots',
                       'stock_movements', 'expense_categories', 'expenses', 'expense_import', 'orders']) {
        const r = await rows(db, `select * from public.${t}`).catch((e) => e.message);
        assert.ok(Array.isArray(r) ? r.length === 0 : /permission denied/.test(r), `${role} read ${t}: ${JSON.stringify(r).slice(0, 80)}`);
      }
      for (const v of ['lot_levels', 'inventory_levels', 'low_stock', 'inventory_velocity', 'revenue_orders', 'monthly_revenue',
                       'order_metrics', 'monthly_expenses', 'order_cogs', 'monthly_gross_margin', 'monthly_financial_summary',
                       'customer_aggregates', 'customer_summary']) {
        assert.match(await errorOf(() => db.query(`select * from public.${v}`)) || 'readable', /permission denied/, `${role} read view ${v}`);
      }
      for (const [fn, args] of [
        ['set_order_status($1, $2)', [order, 'processing']],
        ['allocate_order_line($1, $2, $3, $4, $5)', [order, 'bpc-157', '10 mg', A, 1]],
        ['release_allocation($1)', [1]],
        ['record_stock_movement($1, $2, $3, $4)', [A, 100, 'adjustment', 'free stock']],
        ['import_expenses()', []]]) {
        assert.match(await errorOf(() => db.query(`select public.${fn}`, args)) || 'callable', /permission denied/, `${role} called ${fn}`);
      }
      assert.match(await errorOf(() => db.query(`insert into public.expenses (incurred_on, category_code, description, amount_cents)
                                                  values ('2026-01-01', 'other', 'x', 1)`)) || 'writable', /row-level security|permission denied/);
      assert.match(await errorOf(() => db.query(`insert into public.stock_movements (lot_id, delta, reason, note) values ($1, 100, 'adjustment', 'x')`, [A])) || 'writable',
                   /row-level security|permission denied/);
    });
  }
  assert.equal((await one(db, 'select status from public.orders where id = $1', [order])).status, 'paid');
  assert.equal((await one(db, 'select on_hand from public.lot_levels where lot_id = $1', [A])).on_hand, 5);
});
