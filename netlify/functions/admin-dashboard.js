/*
 * Operations console: the dashboard. GET only.
 *
 * Needs orders.read. The revenue section is added only for finance.read and
 * the stock section only for inventory.read, so a future role sees only what
 * its permissions cover. Reads dashboard_status_counts and dashboard_summary
 * (migration 0004). See netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { readEndpoint } = require('../lib/admin-api.js');

const STATUSES = ['paid', 'processing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'];

const SECTIONS = {
  orders: ['orders_needing_attention'],
  finance: ['revenue_today_cents', 'revenue_7d_cents', 'revenue_30d_cents', 'orders_today', 'orders_7d',
            'average_order_30d_cents', 'currencies', 'fees_and_tax_separated'],
  inventory: ['low_stock_items', 'lots_retest_due_30d', 'lots_retest_overdue']
};

exports.handler = readEndpoint('admin-dashboard', async ({ params, require, can, select }) => {
  await require('orders.read');
  params([]);
  const finance = await can('finance.read');
  const inventory = await can('inventory.read');

  const columns = SECTIONS.orders
    .concat(finance ? SECTIONS.finance : [])
    .concat(inventory ? SECTIONS.inventory : []);
  const [counts, summaryRows] = await Promise.all([
    select('dashboard_status_counts', ['status', 'orders']),
    select('dashboard_summary', columns)
  ]);
  const summary = summaryRows[0] || {};
  const pick = (cols) => Object.fromEntries(cols.map((c) => [c, summary[c] === undefined ? null : summary[c]]));

  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.orders]));
  const body = {
    orders: Object.assign({
      status_counts: STATUSES.map((s) => ({ status: s, orders: byStatus[s] || 0 }))
    }, pick(SECTIONS.orders))
  };
  if (finance) body.finance = pick(SECTIONS.finance);
  if (inventory) body.inventory = pick(SECTIONS.inventory);
  return body;
});
