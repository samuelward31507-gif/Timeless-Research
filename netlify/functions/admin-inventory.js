/*
 * Operations console: inventory. GET only (writes, including the catalogue
 * sync, come in a later pass).
 *
 *   GET ?active=true|false&low=1                 every stock item, with levels
 *   GET ?product_id=&pack_size=                  one stock item and its lots
 *   GET ?lot_id=<uuid>&limit=&cursor=            one lot, its movements and allocations
 *
 * Needs inventory.read. Reads inventory_items, inventory_levels,
 * inventory_velocity, lots, lot_levels, stock_movements and order_line_lots
 * (migrations 0003 and 0004). See netlify/lib/admin-api.js for the request
 * rules.
 */
'use strict';

const { readEndpoint, ApiError, v, decodeCursor, page } = require('../lib/admin-api.js');

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

exports.handler = readEndpoint('admin-inventory', async (ctx) => {
  await ctx.require('inventory.read');
  const raw = ctx.params(['active', 'low', 'product_id', 'pack_size', 'lot_id', 'limit', 'cursor']);
  if (raw.lot_id !== undefined) return lot(ctx);
  if (raw.product_id !== undefined || raw.pack_size !== undefined) return item(ctx);
  return list(ctx);
});
