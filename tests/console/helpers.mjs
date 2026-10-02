/*
 * Shared by the console's screen tests (command, order, csv). Same offline
 * server and rules as console.spec.mjs: the real admin-* handlers on
 * tests/helpers/admin-fixtures.js, and any request to another host fails the
 * test. The fixtures return the rows they are given whatever the query asks
 * for, so tests check what was asked (/__test/calls) and what was drawn.
 */
import { test, expect } from '@playwright/test';

export const XSS = '<img src=x onerror="window.__xss=1">';

export async function setState(request, body) {
  const r = await request.post('/__test/state', { data: body });
  expect(r.status()).toBe(204);
}

export async function calls(request) {
  return (await request.get('/__test/calls')).json();
}

/* Every test: fixtures reset, a signed-in dev session, nothing leaves the
   machine, a fixed locale and time zone so formatted values are stable. */
export function guard() {
  let outside;
  test.use({ locale: 'en-US', timezoneId: 'UTC' });
  test.beforeEach(async ({ page, request }) => {
    await setState(request, { reset: true });
    await setState(request, { devSession: true });
    outside = [];
    await page.context().route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') return route.continue();
      outside.push(u.href);
      return route.abort();
    });
  });
  test.afterEach(async ({ page }) => {
    expect(outside, 'requests to other hosts').toEqual([]);
    const stored = await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])
      .catch(() => [0, 0, '']);
    expect(stored, 'browser storage').toEqual([0, 0, '']);
  });
}

export async function noOverflow(page) {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll).toBeLessThanOrEqual(inner);
}

/* ---------------------------------------------------------------- fixtures */

export const ORDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const STATUSES = ['paid', 'processing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'];

/* One order_queue row (the queue view, no phone or address). */
export function queueRow({ n = 1, ...over } = {}) {
  return Object.assign({
    order_id: id(n), created_at: new Date(Date.UTC(2026, 9, 2, 10, 0) - n * 60000).toISOString(),
    status: 'paid', in_status_since: '2026-10-02T10:00:00.000Z', name: `Customer ${n}`, email: `c${n}@example.org`,
    reference: `ref_${n}`, currency: 'USD', amount_total: 14500, carrier: null, tracking_number: null,
    shipped_at: null, delivered_at: null, product_lines: 1, product_units: 2, unmapped_lines: 0, addon_lines: 0,
    unallocated_units: 0, note_count: 0, last_note_at: null, attention_reason: null
  }, over);
}

export function queue(count, over) {
  return Array.from({ length: count }, (_, i) => queueRow(Object.assign({ n: i + 1 }, over ? over(i) : {})));
}

/* The tables behind admin-dashboard (dashboard_status_counts, dashboard_summary). */
export function dashboardTables(over = {}) {
  const counts = over.counts || { paid: 24, processing: 8, packed: 5, shipped: 12, delivered: 18, completed: 91, cancelled: 2, refunded: 0 };
  return {
    dashboard_status_counts: STATUSES.filter((s) => s in counts).map((s) => ({ status: s, orders: counts[s] })),
    dashboard_summary: over.summary === null ? [] : [Object.assign({
      orders_needing_attention: 4,
      revenue_today_cents: 1245000, revenue_7d_cents: 7832000, revenue_30d_cents: 31284000,
      orders_today: 18, orders_7d: 112, average_order_30d_cents: 9200, currencies: 1, fees_and_tax_separated: false,
      low_stock_items: 2, lots_retest_due_30d: 3, lots_retest_overdue: 1
    }, over.summary || {})]
  };
}

/* Everything the business overview reads, in one tables object. */
export function overviewTables(over = {}) {
  return Object.assign({}, dashboardTables(over), {
    order_queue: over.order_queue || queue(8, (i) => (i < 2 ? { attention_reason: 'paid over 24 hours, not started' } : {})),
    customer_aggregates: [{ customer_email: 'c1@example.org', currency: 'USD', first_order_at: '2026-01-01T00:00:00Z',
      last_order_at: '2026-10-01T00:00:00Z', order_count: 3, lifetime_revenue_cents: 30000, average_order_cents: 10000, is_repeat: true }],
    customer_summary: over.customer_summary || [{ currency: 'USD', customers: 214, repeat_customers: 51, repeat_rate_percent: 23.8,
      average_lifetime_revenue_cents: 41000, orders_without_email: 0 }],
    inventory_levels: over.inventory_levels || [
      { product_id: 'bpc-157', pack_size: '5mg', active: true, on_hand: 3, committed_unallocated: 0, available: 3, low_stock_threshold: 5, is_low: true },
      { product_id: 'tb-500', pack_size: '10mg', active: true, on_hand: 1, committed_unallocated: 0, available: 1, low_stock_threshold: 4, is_low: true }
    ],
    inventory_velocity: [],
    admin_audit_log: over.admin_audit_log || [
      { id: 3, occurred_at: '2026-10-02T09:12:00Z', actor_id: null, actor_email: 'owner@example.org', action: 'order.ship',
        entity_type: 'order', entity_id: ORDER_ID, details: { carrier: 'UPS' } },
      { id: 2, occurred_at: '2026-10-02T08:40:00Z', actor_id: null, actor_email: 'owner@example.org', action: 'order.set_status',
        entity_type: 'order', entity_id: ORDER_ID, details: { from: 'paid', to: 'processing' } },
      { id: 1, occurred_at: '2026-10-01T16:00:00Z', actor_id: null, actor_email: 'owner@example.org', action: 'inventory.receive_lot',
        entity_type: 'lot', entity_id: id(99), details: {} }
    ]
  });
}
