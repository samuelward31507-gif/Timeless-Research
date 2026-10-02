/*
 * Operations console: customers, as they appear on orders. GET only.
 *
 *   GET ?limit=&cursor=          customers by most recent order, and the summary
 *   GET ?email=<address>         one customer's totals and their orders
 *
 * Needs customers.read; one customer's order list also needs orders.read.
 * Reads customer_aggregates, customer_summary and order_queue (migrations
 * 0003 and 0004). Customers are keyed by email address, lower-cased and
 * trimmed, exactly as customer_aggregates keys them. No phone number or
 * address is returned. See netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { readEndpoint, ApiError, v, decodeCursor, encodeCursor } = require('../lib/admin-api.js');

const CUSTOMER_COLUMNS = ['customer_email', 'currency', 'first_order_at', 'last_order_at', 'order_count',
  'lifetime_revenue_cents', 'average_order_cents', 'is_repeat'];
const SUMMARY_COLUMNS = ['currency', 'customers', 'repeat_customers', 'repeat_rate_percent',
  'average_lifetime_revenue_cents', 'orders_without_email'];
const ORDER_COLUMNS = ['order_id', 'created_at', 'status', 'name', 'email', 'reference', 'currency', 'amount_total',
  'attention_reason'];

// An email address without the characters that mean something to PostgREST
// or to a LIKE pattern (comma, brackets, quotes, backslash, asterisk, %).
// "_" is allowed, as addresses use it; it is a one-character wildcard in
// ilike, so every row found is compared exactly before it is returned.
const EMAIL = /^[A-Za-z0-9.!#$&'+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const ORDER_SCAN_LIMIT = 500;

const normalize = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

async function list({ params, select }) {
  const p = params(['limit', 'cursor']);
  const limit = v.limit(p.limit);
  const cursor = decodeCursor(p.cursor, ['offset']);
  const offset = cursor ? cursor[0] : 0;

  const [rows, summary] = await Promise.all([
    select('customer_aggregates', CUSTOMER_COLUMNS, [
      ['order', 'last_order_at.desc,customer_email.asc,currency.asc'],
      ['offset', String(offset)], ['limit', String(limit + 1)]]),
    select('customer_summary', SUMMARY_COLUMNS, [['order', 'currency.asc']])
  ]);
  const more = rows.length > limit && offset + limit <= 10000;
  return {
    customers: rows.slice(0, limit),
    summary,
    next_cursor: more ? encodeCursor([offset + limit]) : null
  };
}

async function one({ params, select, require }) {
  const p = params(['email']);
  const email = p.email === undefined ? undefined : normalize(p.email);
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new ApiError(400, 'invalid_parameter', { parameter: 'email' });
  await require('orders.read');

  const [totals, candidates] = await Promise.all([
    select('customer_aggregates', CUSTOMER_COLUMNS, [['customer_email', `eq.${email}`], ['order', 'currency.asc']]),
    select('order_queue', ORDER_COLUMNS, [['email', `ilike.*${email}*`],
      ['order', 'created_at.desc,order_id.desc'], ['limit', String(ORDER_SCAN_LIMIT + 1)]])
  ]);
  const orders = candidates.slice(0, ORDER_SCAN_LIMIT).filter((o) => normalize(o.email) === email);
  if (totals.length === 0 && orders.length === 0) throw new ApiError(404, 'not_found');
  return { email, totals, orders, truncated: candidates.length > ORDER_SCAN_LIMIT };
}

exports.handler = readEndpoint('admin-customers', async (ctx) => {
  await ctx.require('customers.read');
  const raw = ctx.params(['email', 'limit', 'cursor']);
  return raw.email !== undefined ? one(ctx) : list(ctx);
});
