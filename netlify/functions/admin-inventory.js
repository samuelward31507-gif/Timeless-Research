/*
 * Operations console: inventory.
 *
 *   GET ?active=true|false&low=1                 every stock item, with levels
 *   GET ?product_id=&pack_size=                  one stock item and its lots
 *   GET ?lot_id=<uuid>&limit=&cursor=            one lot, its movements and allocations
 *   POST {"action": ..., ...}                    the actions below
 *
 * Reads need inventory.read. Reads inventory_items, inventory_levels,
 * inventory_velocity, lots, lot_levels, stock_movements and order_line_lots
 * (migrations 0003 and 0004).
 *
 * Each action calls one protected database function (migration 0004), which
 * checks inventory.write again, makes the change and writes the audit entry
 * in one transaction. inventory.sync takes no input at all: the stock items
 * come from this deploy's own catalogue (catalog.json, which tools/build.py
 * generates), because the database function deactivates every item missing
 * from the list it is given. See netlify/lib/admin-api.js for the request
 * rules.
 */
'use strict';

const { endpoint, ApiError, v, field, optional, nullable, pick, onlyRow, decodeCursor, page } = require('../lib/admin-api.js');

let CATALOG = null;
try {
  CATALOG = require('./catalog.json');
} catch (e) {
  CATALOG = null;
}

const LEVEL_COLUMNS = ['product_id', 'pack_size', 'active', 'on_hand', 'committed_unallocated', 'available',
  'low_stock_threshold', 'is_low'];
const VELOCITY_COLUMNS = ['product_id', 'pack_size', 'units_out_30d', 'units_out_90d'];
const ITEM_COLUMNS = ['product_id', 'pack_size', 'low_stock_threshold', 'active', 'notes', 'created_at'];
const LOT_LEVEL_COLUMNS = ['lot_id', 'lot_number', 'received_on', 'quantity_received', 'retest_date',
  'retest_overdue', 'retest_due_30d', 'coa_reference', 'unit_cost_cents', 'currency', 'on_hand', 'allocated_out',
  'released_back', 'returned', 'adjusted'];
const LOT_COLUMNS = ['id', 'product_id', 'pack_size', 'lot_number', 'received_on', 'quantity_received',
  'retest_date', 'coa_reference', 'unit_cost_cents', 'currency', 'supplier', 'notes', 'created_at', 'created_by'];
const MOVEMENT_COLUMNS = ['id', 'delta', 'reason', 'order_id', 'allocation_id', 'note', 'created_by', 'created_at'];
const LOT_ALLOCATION_COLUMNS = ['id', 'order_id', 'quantity', 'allocated_at', 'released_at'];

const LIST_LIMIT = 500;
const DETAIL_LIMIT = '200';

const key = (r) => `${r.product_id}|${r.pack_size}`;

async function list({ params, select }) {
  const p = params(['active', 'low']);
  const active = v.oneOf(p.active, 'active', ['true', 'false']);
  const low = v.flag(p.low, 'low');
  const query = [];
  if (active) query.push(['active', `is.${active}`]);
  if (low) query.push(['is_low', 'is.true']);
  query.push(['order', 'product_id.asc,pack_size.asc'], ['limit', String(LIST_LIMIT + 1)]);

  const [levels, velocity] = await Promise.all([
    select('inventory_levels', LEVEL_COLUMNS, query),
    select('inventory_velocity', VELOCITY_COLUMNS, [['limit', String(LIST_LIMIT * 4)]])
  ]);
  const byItem = new Map(velocity.map((r) => [key(r), r]));
  const items = levels.slice(0, LIST_LIMIT).map((r) => Object.assign({}, r, {
    units_out_30d: (byItem.get(key(r)) || {}).units_out_30d || 0,
    units_out_90d: (byItem.get(key(r)) || {}).units_out_90d || 0
  }));
  return { items, truncated: levels.length > LIST_LIMIT };
}

async function item({ params, select }) {
  const p = params(['product_id', 'pack_size']);
  const productId = v.productId(p.product_id, 'product_id');
  const packSize = v.packSize(p.pack_size, 'pack_size');
  if (!productId || !packSize) throw new ApiError(400, 'invalid_parameter', { parameter: productId ? 'pack_size' : 'product_id' });
  const match = [['product_id', `eq.${productId}`], ['pack_size', `eq.${packSize}`]];

  const [items, levels, velocity, lots] = await Promise.all([
    select('inventory_items', ITEM_COLUMNS, match),
    select('inventory_levels', LEVEL_COLUMNS, match),
    select('inventory_velocity', VELOCITY_COLUMNS, match),
    select('lot_levels', LOT_LEVEL_COLUMNS, match.concat([['order', 'received_on.desc,lot_id.desc'], ['limit', DETAIL_LIMIT]]))
  ]);
  if (items.length !== 1) throw new ApiError(404, 'not_found');
  return {
    item: items[0],
    level: levels[0] || null,
    velocity: velocity[0] ? { units_out_30d: velocity[0].units_out_30d, units_out_90d: velocity[0].units_out_90d }
                          : { units_out_30d: 0, units_out_90d: 0 },
    lots
  };
}

async function lot({ params, select }) {
  const p = params(['lot_id', 'limit', 'cursor']);
  const lotId = v.uuid(p.lot_id, 'lot_id');
  const limit = v.limit(p.limit);
  const cursor = decodeCursor(p.cursor, ['id']);

  const movementQuery = [['lot_id', `eq.${lotId}`]];
  if (cursor) movementQuery.push(['id', `lt.${cursor[0]}`]);
  movementQuery.push(['order', 'id.desc'], ['limit', String(limit + 1)]);

  const [lots, levels, movements, allocations] = await Promise.all([
    select('lots', LOT_COLUMNS, [['id', `eq.${lotId}`]]),
    select('lot_levels', LOT_LEVEL_COLUMNS, [['lot_id', `eq.${lotId}`]]),
    select('stock_movements', MOVEMENT_COLUMNS, movementQuery),
    select('order_line_lots', LOT_ALLOCATION_COLUMNS, [['lot_id', `eq.${lotId}`], ['order', 'id.desc'], ['limit', DETAIL_LIMIT]])
  ]);
  if (lots.length !== 1) throw new ApiError(404, 'not_found');
  const result = page(movements, limit, (r) => [r.id]);
  return { lot: lots[0], level: levels[0] || null, allocations, movements: result.items, next_cursor: result.next_cursor };
}

/* --------------------------------------------------------------- writes */

/* Every product and pack size the catalogue lists, buyable or not, so a
   compound that stops being sold keeps its stock item and lots visible. A
   catalogue that is missing, empty or carries an id the API would refuse
   anywhere else stops the sync rather than deactivating stock. */
function catalogueItems() {
  const products = CATALOG && CATALOG.products;
  if (!products || typeof products !== 'object' || Array.isArray(products)) {
    throw new ApiError(500, 'unavailable', { reason: 'catalogue_missing' });
  }
  const items = [];
  for (const [productId, product] of Object.entries(products)) {
    const prices = product && product.prices;
    if (!prices || typeof prices !== 'object') throw new ApiError(500, 'unavailable', { reason: 'catalogue_invalid' });
    for (const packSize of Object.keys(prices)) {
      try {
        field.productId()(productId, 'product_id');
        field.packSize()(packSize, 'pack_size');
      } catch (e) {
        throw new ApiError(500, 'unavailable', { reason: 'catalogue_invalid' });
      }
      items.push({ product_id: productId, pack_size: packSize });
    }
  }
  if (items.length === 0) throw new ApiError(500, 'unavailable', { reason: 'catalogue_missing' });
  return items;
}

const text = (max) => field.text(1, max, { multiline: true });
const maybeText = (max) => optional(nullable(field.text(0, max, { multiline: true })));
const cost = () => field.int(0, 100000000);
const ITEM_RESULT = ['product_id', 'pack_size', 'low_stock_threshold', 'active', 'notes'];
const LOT_RESULT = ['id', 'product_id', 'pack_size', 'lot_number', 'received_on', 'quantity_received', 'retest_date',
  'coa_reference', 'unit_cost_cents', 'currency', 'supplier', 'notes'];
const MOVEMENT_SIGN = { return: 1, write_off: -1 };

function orNull(x) {
  return x === undefined ? null : x;
}

const ACTIONS = {
  'inventory.receive_lot': {
    permission: 'inventory.write',
    fn: 'receive_lot',
    fields: {
      product_id: field.productId(), pack_size: field.packSize(), lot_number: field.text(1, 80),
      quantity: field.int(1, 1000000), received_on: optional(field.date()), retest_date: optional(nullable(field.date())),
      coa_reference: maybeText(500), unit_cost_cents: optional(nullable(cost())), currency: optional(field.currency()),
      supplier: maybeText(200), notes: maybeText(2000)
    },
    args(b) {
      if (b.retest_date && b.received_on && b.retest_date < b.received_on) {
        throw new ApiError(400, 'invalid_field', { field: 'retest_date' });
      }
      const a = { p_product_id: b.product_id, p_pack_size: b.pack_size, p_lot_number: b.lot_number,
                  p_quantity: b.quantity, p_retest_date: orNull(b.retest_date), p_coa_reference: orNull(b.coa_reference),
                  p_unit_cost_cents: orNull(b.unit_cost_cents), p_supplier: orNull(b.supplier), p_notes: orNull(b.notes) };
      // Left out when not given, so the function's own defaults apply
      // (received today, USD).
      if (b.received_on !== undefined) a.p_received_on = b.received_on;
      if (b.currency !== undefined) a.p_currency = b.currency;
      return a;
    },
    result: (r) => ({ lot_id: r })
  },
  'inventory.update_item': {
    permission: 'inventory.write',
    fn: 'admin_update_inventory_item',
    fields: {
      product_id: field.productId(), pack_size: field.packSize(),
      changes: field.changes({
        low_stock_threshold: nullable(field.int(0, 1000000)),
        active: field.bool(),
        notes: nullable(field.text(0, 2000, { multiline: true }))
      })
    },
    args: (b) => ({ p_product_id: b.product_id, p_pack_size: b.pack_size, p_changes: b.changes }),
    result: (r) => ({ item: pick(r, ITEM_RESULT) })
  },
  'inventory.update_lot': {
    permission: 'inventory.write',
    fn: 'admin_update_lot',
    fields: {
      lot_id: field.uuid(),
      changes: field.changes({
        received_on: field.date(),
        retest_date: nullable(field.date()),
        coa_reference: nullable(field.text(0, 500, { multiline: true })),
        unit_cost_cents: nullable(cost()),
        currency: field.currency(),
        supplier: nullable(field.text(0, 200, { multiline: true })),
        notes: nullable(field.text(0, 2000, { multiline: true }))
      })
    },
    args: (b) => ({ p_lot_id: b.lot_id, p_changes: b.changes }),
    result: (r) => ({ lot: pick(r, LOT_RESULT) })
  },
  'inventory.record_movement': {
    permission: 'inventory.write',
    fn: 'admin_record_stock_movement',
    fields: {
      lot_id: field.uuid(), delta: field.int(-1000000, 1000000, { nonzero: true }),
      reason: field.oneOf(['return', 'adjustment', 'write_off']), note: text(1000)
    },
    args(b) {
      // A return adds stock and a write-off removes it; the table refuses the
      // other sign, so say which field is wrong before it gets there.
      const sign = MOVEMENT_SIGN[b.reason];
      if (sign && Math.sign(b.delta) !== sign) throw new ApiError(400, 'invalid_field', { field: 'delta' });
      return { p_lot_id: b.lot_id, p_delta: b.delta, p_reason: b.reason, p_note: b.note };
    },
    result: (r) => ({ movement_id: r })
  },
  'inventory.sync': {
    permission: 'inventory.write',
    fn: 'sync_inventory_items',
    fields: {},
    args: () => ({ p_items: catalogueItems() }),
    result: (r) => pick(onlyRow(r), ['added', 'reactivated', 'deactivated'])
  }
};

exports.handler = endpoint('admin-inventory', async (ctx) => {
  await ctx.require('inventory.read');
  const raw = ctx.params(['active', 'low', 'product_id', 'pack_size', 'lot_id', 'limit', 'cursor']);
  if (raw.lot_id !== undefined) return lot(ctx);
  if (raw.product_id !== undefined || raw.pack_size !== undefined) return item(ctx);
  return list(ctx);
}, ACTIONS);

exports.ACTIONS = ACTIONS;
// For the test suite; not part of the handler contract.
exports._internals = {
  catalogueItems,
  setCatalog(c) {
    CATALOG = c;
  }
};
