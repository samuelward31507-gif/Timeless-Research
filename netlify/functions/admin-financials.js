/*
 * Operations console: monthly financial reports. GET only.
 *
 *   GET ?from_month=YYYY-MM&to_month=YYYY-MM
 *
 * Needs finance.read. Reads monthly_financial_summary, monthly_gross_margin,
 * monthly_expenses, addon_revenue and addon_attach_rate (migrations 0003 and
 * 0004). The views' own "fees and tax not separated" flag is passed through,
 * so the console can say the figures are incomplete rather than imply they
 * are final. See netlify/lib/admin-api.js for the request rules.
 */
'use strict';

const { readEndpoint, ApiError, v } = require('../lib/admin-api.js');

const SUMMARY_COLUMNS = ['month', 'currency', 'orders', 'revenue_total_cents', 'revenue_goods_net_cents',
  'average_order_cents', 'operating_expenses_cents', 'inventory_purchases_cents', 'orders_cost_complete',
  'gross_margin_cents', 'gross_margin_percent', 'fees_and_tax_separated'];
const MARGIN_COLUMNS = ['month', 'currency', 'orders', 'orders_cost_complete', 'goods_net_cents_costed',
  'cogs_cents_costed', 'gross_margin_cents', 'gross_margin_percent'];
const EXPENSE_COLUMNS = ['month', 'currency', 'category_code', 'category', 'treatment', 'entries', 'amount_cents'];
const ADDON_REVENUE_COLUMNS = ['month', 'addon_id', 'orders', 'units', 'revenue_cents', 'currency'];
const ADDON_ATTACH_COLUMNS = ['addon_id', 'rule_id', 'lines_offered', 'lines_taken', 'attach_rate_percent',
  'revenue_cents'];

const ROW_LIMIT = '1000';

exports.handler = readEndpoint('admin-financials', async ({ params, require, select }) => {
  await require('finance.read');
  const p = params(['from_month', 'to_month']);
  const from = v.month(p.from_month, 'from_month');
  const to = v.month(p.to_month, 'to_month');
  if (from && to && from > to) throw new ApiError(400, 'invalid_parameter', { parameter: 'to_month' });

  const range = [];
  if (from) range.push(['month', `gte.${from}`]);
  if (to) range.push(['month', `lte.${to}`]);
  const newestFirst = (extra) => range.concat([['order', `month.desc,${extra}`], ['limit', ROW_LIMIT]]);

  const [summary, margin, expenses, addonRevenue, addonAttach] = await Promise.all([
    select('monthly_financial_summary', SUMMARY_COLUMNS, newestFirst('currency.asc')),
    select('monthly_gross_margin', MARGIN_COLUMNS, newestFirst('currency.asc')),
    select('monthly_expenses', EXPENSE_COLUMNS, newestFirst('currency.asc,category_code.asc')),
    select('addon_revenue', ADDON_REVENUE_COLUMNS, newestFirst('addon_id.asc')),
    select('addon_attach_rate', ADDON_ATTACH_COLUMNS, [['order', 'addon_id.asc,rule_id.asc'], ['limit', ROW_LIMIT]])
  ]);
  return {
    fees_and_tax_separated: false,
    summary, gross_margin: margin, expenses_by_category: expenses,
    addons: { revenue: addonRevenue, attach_rate: addonAttach }
  };
});
