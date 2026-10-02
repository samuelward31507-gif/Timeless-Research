/*
 * Operations console: orders. GET only (writes come in a later pass).
 *
 *   GET ?status=&attention=1&q=&limit=&cursor=   the order queue
 *   GET ?id=<uuid>                               one order in full
 *
 * Needs orders.read. The queue never carries a phone number or address; only
 * the single-order view does, because shipping needs them. Cost of goods is
 * included in the single-order view only for finance.read. See
 * netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { readEndpoint, ApiError, v, decodeCursor, afterDesc, page } = require('../lib/admin-api.js');

const STATUSES = ['paid', 'processing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'];

// Letters (any language), digits, space and the punctuation of names and
// email addresses. No comma, bracket, quote, backslash or asterisk, so the
// value cannot change the shape of the PostgREST filter it is placed in.
const SEARCH = /^[\p{L}\p{M}0-9 @._+'-]+$/u;

const QUEUE_COLUMNS = ['order_id', 'created_at', 'status', 'in_status_since', 'name', 'email', 'reference',
  'currency', 'amount_total', 'carrier', 'tracking_number', 'shipped_at', 'delivered_at', 'product_lines',
  'product_units', 'unmapped_lines', 'addon_lines', 'unallocated_units', 'note_count', 'last_note_at',
  'attention_reason'];

const ORDER_COLUMNS = ['id', 'created_at', 'status', 'status_changed_at', 'processing_at', 'packed_at',
  'shipped_at', 'delivered_at', 'completed_at', 'cancelled_at', 'refunded_at', 'name', 'email', 'phone',
  'shipping_address', 'amount_total', 'amount_subtotal', 'amount_shipping', 'amount_discount', 'currency',
  'carrier', 'tracking_number', 'research_use_confirmed', 'stripe_session_id', 'notes'];

const ITEM_COLUMNS = ['id', 'kind', 'description', 'quantity', 'unit_amount', 'amount_total', 'sku', 'pack_size',
  'addon_id', 'parent_sku', 'parent_pack_size'];
const HISTORY_COLUMNS = ['id', 'from_status', 'to_status', 'changed_at', 'changed_by', 'note'];
const NOTE_COLUMNS = ['id', 'body', 'author_id', 'author_email', 'created_at'];
const ALLOCATION_COLUMNS = ['id', 'product_id', 'pack_size', 'lot_id', 'quantity', 'allocated_at', 'allocated_by',
  'released_at'];
const MAPPING_COLUMNS = ['id', 'match_description', 'match_quantity', 'product_id', 'pack_size', 'note', 'mapped_by',
  'mapped_at', 'reverted_at', 'reverted_by', 'revert_note'];
const COGS_COLUMNS = ['cogs_cents', 'units_ordered', 'units_costed', 'cost_complete'];

const DETAIL_LIMIT = '200';

async function queue({ params, select }) {
  const p = params(['status', 'attention', 'q', 'limit', 'cursor']);
  const status = v.oneOf(p.status, 'status', STATUSES);
  const attention = v.flag(p.attention, 'attention');
  const q = p.q === undefined ? undefined : p.q.trim();
  if (q !== undefined && (q.length < 2 || q.length > 60 || !SEARCH.test(q))) throw new ApiError(400, 'invalid_parameter', { parameter: 'q' });
  const limit = v.limit(p.limit);
  const cursor = decodeCursor(p.cursor, ['timestamp', 'uuid']);

  const query = [];
  if (status) query.push(['status', `eq.${status}`]);
  if (attention) query.push(['attention_reason', 'not.is.null']);
  if (q) query.push(['or', `(name.ilike."*${q}*",email.ilike."*${q}*")`]);
  if (cursor) query.push(['and', `(or${afterDesc('created_at', 'order_id', cursor)})`]);
  query.push(['order', 'created_at.desc,order_id.desc'], ['limit', String(limit + 1)]);

  const rows = await select('order_queue', QUEUE_COLUMNS, query);
  const result = page(rows, limit, (r) => [r.created_at, r.order_id]);
  return { orders: result.items, next_cursor: result.next_cursor };
}

async function detail({ params, select, can }) {
  const p = params(['id']);
  const id = v.uuid(p.id, 'id');
  const byOrder = ['order_id', `eq.${id}`];

  const [orders, items, history, notes, allocations, mappings, queueRows] = await Promise.all([
    select('orders', ORDER_COLUMNS, [['id', `eq.${id}`]]),
    select('order_items', ITEM_COLUMNS, [byOrder, ['order', 'id.asc'], ['limit', DETAIL_LIMIT]]),
    select('order_status_history', HISTORY_COLUMNS, [byOrder, ['order', 'changed_at.asc,id.asc'], ['limit', DETAIL_LIMIT]]),
    select('order_notes', NOTE_COLUMNS, [byOrder, ['order', 'created_at.asc,id.asc'], ['limit', DETAIL_LIMIT]]),
    select('order_line_lots', ALLOCATION_COLUMNS, [byOrder, ['order', 'id.asc'], ['limit', DETAIL_LIMIT]]),
    select('order_line_mappings', MAPPING_COLUMNS, [byOrder, ['order', 'id.asc'], ['limit', DETAIL_LIMIT]]),
    select('order_queue', ['attention_reason', 'unmapped_lines', 'unallocated_units'], [byOrder])
  ]);
  if (orders.length !== 1) throw new ApiError(404, 'not_found');

  const body = {
    order: orders[0],
    attention: queueRows[0] || null,
    items, history, notes, allocations, mappings
  };
  if (await can('finance.read')) {
    const cogs = await select('order_cogs', COGS_COLUMNS, [byOrder]);
    body.cost = cogs[0] || null;
  }
  return body;
}

exports.handler = readEndpoint('admin-orders', async (ctx) => {
  await ctx.require('orders.read');
  const raw = ctx.params(['id', 'status', 'attention', 'q', 'limit', 'cursor']);
  return raw.id !== undefined ? detail(ctx) : queue(ctx);
});
