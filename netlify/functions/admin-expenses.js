/*
 * Operations console: expenses.
 *
 *   GET ?from=&to=&category=&include_deleted=1&limit=&cursor=   expenses, newest first
 *   GET ?id=<uuid>                                              one expense
 *   GET ?view=import&status=pending|error|imported|duplicate&limit=&cursor=
 *                                                               staged import rows
 *
 *   POST {"action": ..., ...}                                   the actions below
 *
 * Reads need finance.read. Reads expenses, expense_categories and
 * expense_import (migrations 0003 and 0004). Deleted expenses are left out
 * unless asked for.
 *
 * Each action calls one protected database function (migration 0004), which
 * checks finance.write again, makes the change and writes the audit entry in
 * one transaction. Deleting is reversible (restore). A CSV import is two
 * steps: stage the rows, then import every pending staged row; each row is
 * validated by the database on its own, and bad rows stay staged with the
 * reason. See netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { endpoint, ApiError, v, field, optional, nullable, pick, onlyRow, decodeCursor, afterDesc, page, MAX_BODY_LIMIT } = require('../lib/admin-api.js');

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

/* --------------------------------------------------------------- writes */

const category = () => field.text(1, 60, { pattern: CATEGORY });
// Expenses are integer cents in a PostgreSQL integer; negative for a credit.
const amount = () => field.int(-2000000000, 2000000000, { nonzero: true });
const maybeText = (max) => optional(nullable(field.text(0, max, { multiline: true })));
const EXPENSE_RESULT = ['id', 'incurred_on', 'category_code', 'description', 'amount_cents', 'currency', 'vendor',
  'reference', 'lot_id', 'notes', 'updated_at', 'updated_by'];

/* A staged CSV row: the spreadsheet's own text, each column optional. The
   database parses and validates every value when the import runs. */
const ROW_COLUMNS = ['incurred_on', 'category', 'description', 'amount', 'currency', 'vendor', 'reference', 'notes'];
const MAX_ROWS = 5000;

function rows(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) {
    throw new ApiError(400, 'invalid_field', { field: name });
  }
  const cell = optional(nullable(field.text(0, 1000)));
  return value.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ApiError(400, 'invalid_field', { field: `${name}[${i}]` });
    const out = {};
    for (const k of Object.keys(row)) {
      if (!ROW_COLUMNS.includes(k)) throw new ApiError(400, 'invalid_field', { field: `${name}[${i}].${k}` });
      const c = cell(row[k], `${name}[${i}].${k}`);
      if (c !== undefined) out[k] = c;
    }
    return out;
  });
}

function orNull(x) {
  return x === undefined ? null : x;
}

const ACTIONS = {
  'finance.create_expense': {
    permission: 'finance.write',
    fn: 'admin_create_expense',
    fields: {
      incurred_on: field.date(), category_code: category(), description: field.text(1, 500),
      amount_cents: amount(), currency: optional(field.currency()), vendor: maybeText(200),
      reference: maybeText(200), lot_id: optional(nullable(field.uuid())), notes: maybeText(2000)
    },
    args(b) {
      const a = { p_incurred_on: b.incurred_on, p_category_code: b.category_code, p_description: b.description,
                  p_amount_cents: b.amount_cents, p_vendor: orNull(b.vendor), p_reference: orNull(b.reference),
                  p_lot_id: orNull(b.lot_id), p_notes: orNull(b.notes) };
      if (b.currency !== undefined) a.p_currency = b.currency;
      return a;
    },
    result: (r) => ({ expense_id: r })
  },
  'finance.update_expense': {
    permission: 'finance.write',
    fn: 'admin_update_expense',
    fields: {
      expense_id: field.uuid(),
      changes: field.changes({
        incurred_on: field.date(),
        category_code: category(),
        description: field.text(1, 500),
        amount_cents: amount(),
        currency: field.currency(),
        vendor: nullable(field.text(0, 200, { multiline: true })),
        reference: nullable(field.text(0, 200, { multiline: true })),
        lot_id: nullable(field.uuid()),
        notes: nullable(field.text(0, 2000, { multiline: true }))
      })
    },
    args: (b) => ({ p_expense_id: b.expense_id, p_changes: b.changes }),
    result: (r) => ({ expense: pick(r, EXPENSE_RESULT) })
  },
  'finance.delete_expense': {
    permission: 'finance.write',
    fn: 'admin_delete_expense',
    fields: { expense_id: field.uuid(), reason: field.text(1, 500, { multiline: true }) },
    args: (b) => ({ p_expense_id: b.expense_id, p_reason: b.reason }),
    result: (r) => ({ deleted: r === true })
  },
  'finance.restore_expense': {
    permission: 'finance.write',
    fn: 'admin_restore_expense',
    fields: { expense_id: field.uuid() },
    args: (b) => ({ p_expense_id: b.expense_id }),
    result: (r) => ({ restored: r === true })
  },
  'finance.stage_import': {
    permission: 'finance.write',
    fn: 'admin_stage_expense_import',
    maxBytes: MAX_BODY_LIMIT,
    fields: { rows },
    args: (b) => ({ p_rows: b.rows }),
    result: (r) => ({ staged: r })
  },
  'finance.import': {
    permission: 'finance.write',
    fn: 'admin_import_expenses',
    fields: {},
    args: () => ({}),
    result: (r) => pick(onlyRow(r), ['imported', 'duplicates', 'errors'])
  }
};

exports.handler = endpoint('admin-expenses', async (ctx) => {
  await ctx.require('finance.read');
  const raw = ctx.params(['id', 'view', 'from', 'to', 'category', 'include_deleted', 'status', 'limit', 'cursor']);
  if (raw.view !== undefined) {
    v.oneOf(raw.view, 'view', ['import']);
    return staged(ctx);
  }
  if (raw.id !== undefined) return one(ctx);
  return list(ctx);
}, ACTIONS);

exports.ACTIONS = ACTIONS;
