/*
 * Operations console: expenses. GET only (writes and the import itself come
 * in a later pass).
 *
 *   GET ?from=&to=&category=&include_deleted=1&limit=&cursor=   expenses, newest first
 *   GET ?id=<uuid>                                              one expense
 *   GET ?view=import&status=pending|error|imported|duplicate&limit=&cursor=
 *                                                               staged import rows
 *
 * Needs finance.read. Reads expenses, expense_categories and expense_import
 * (migrations 0003 and 0004). Deleted expenses are left out unless asked for.
 * See netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { readEndpoint, ApiError, v, decodeCursor, afterDesc, page } = require('../lib/admin-api.js');

const EXPENSE_COLUMNS = ['id', 'incurred_on', 'category_code', 'description', 'amount_cents', 'currency', 'vendor',
  'reference', 'lot_id', 'notes', 'created_by', 'created_at', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by',
  'delete_reason'];
const CATEGORY_COLUMNS = ['code', 'name', 'treatment', 'active'];
const IMPORT_COLUMNS = ['id', 'incurred_on', 'category', 'description', 'amount', 'currency', 'vendor', 'reference',
  'notes', 'status', 'error', 'expense_id', 'loaded_at'];
const IMPORT_STATUSES = ['pending', 'error', 'imported', 'duplicate'];
const CATEGORY = /^[a-z0-9]+(_[a-z0-9]+)*$/;

async function list({ params, select }) {
  const p = params(['from', 'to', 'category', 'include_deleted', 'limit', 'cursor']);
  const from = v.date(p.from, 'from');
  const to = v.date(p.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'invalid_parameter', { parameter: 'to' });
  const category = v.pattern(p.category, 'category', CATEGORY, 60);
  const includeDeleted = v.flag(p.include_deleted, 'include_deleted');
  const limit = v.limit(p.limit);
  const cursor = decodeCursor(p.cursor, ['date', 'uuid']);

  const query = [];
  if (from) query.push(['incurred_on', `gte.${from}`]);
  if (to) query.push(['incurred_on', `lte.${to}`]);
  if (category) query.push(['category_code', `eq.${category}`]);
  if (!includeDeleted) query.push(['deleted_at', 'is.null']);
  if (cursor) query.push(['or', afterDesc('incurred_on', 'id', cursor)]);
  query.push(['order', 'incurred_on.desc,id.desc'], ['limit', String(limit + 1)]);

  const [rows, categories] = await Promise.all([
    select('expenses', EXPENSE_COLUMNS, query),
    select('expense_categories', CATEGORY_COLUMNS, [['order', 'name.asc'], ['limit', '200']])
  ]);
  const result = page(rows, limit, (r) => [r.incurred_on, r.id]);
  return { expenses: result.items, categories, next_cursor: result.next_cursor };
}

async function one({ params, select }) {
  const p = params(['id']);
  const id = v.uuid(p.id, 'id');
  const rows = await select('expenses', EXPENSE_COLUMNS, [['id', `eq.${id}`]]);
  if (rows.length !== 1) throw new ApiError(404, 'not_found');
  return { expense: rows[0] };
}

async function staged({ params, select }) {
  const p = params(['view', 'status', 'limit', 'cursor']);
  const status = v.oneOf(p.status, 'status', IMPORT_STATUSES);
  const limit = v.limit(p.limit);
  const cursor = decodeCursor(p.cursor, ['id']);

  const query = [['status', status ? `eq.${status}` : 'in.(pending,error)']];
  if (cursor) query.push(['id', `lt.${cursor[0]}`]);
  query.push(['order', 'id.desc'], ['limit', String(limit + 1)]);
  const rows = await select('expense_import', IMPORT_COLUMNS, query);
  const result = page(rows, limit, (r) => [r.id]);
  return { rows: result.items, next_cursor: result.next_cursor };
}

exports.handler = readEndpoint('admin-expenses', async (ctx) => {
  await ctx.require('finance.read');
  const raw = ctx.params(['id', 'view', 'from', 'to', 'category', 'include_deleted', 'status', 'limit', 'cursor']);
  if (raw.view !== undefined) {
    v.oneOf(raw.view, 'view', ['import']);
    return staged(ctx);
  }
  if (raw.id !== undefined) return one(ctx);
  return list(ctx);
});
