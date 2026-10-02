/*
 * The business overview (console/index.html, assets/js/console/command.js),
 * in a real browser, offline, on the real admin-* handlers and fixtures.
 */
import { test, expect } from '@playwright/test';
import { guard, setState, calls, noOverflow, overviewTables, orderTables, queue, id, ORDER_ID, XSS } from './helpers.mjs';

guard();

const open = (page) => page.goto('/console/index.html');
const ready = (page) => expect(page.locator('#cc-workspace')).toBeVisible();
const group = (page, key) => page.locator(`.cc-group[data-group="${key}"]`);
const figure = (page, key, label) => group(page, key).locator('.cc-figure', { hasText: label }).locator('.cc-figure-value');

async function load(page, request, tables, extra) {
  await setState(request, Object.assign({ tables }, extra || {}));
  await open(page);
}

/* ---------------------------------------------------------------- content */

test('every part of the overview is drawn from the API', async ({ page, request }) => {
  await load(page, request, overviewTables());
  await ready(page);
  await expect(page.locator('h1')).toHaveText('Business overview');
  await expect(page.locator('#cc-updated')).toContainText('Updated');
  await expect(page.locator('#cc-notice')).toBeHidden();

  // At a glance: sales without a currency symbol, labelled gross.
  await expect(figure(page, 'sales', 'Today')).toHaveText('12,450.00');
  await expect(figure(page, 'sales', 'Last 7 days')).toHaveText('78,320.00');
  await expect(figure(page, 'sales', 'Last 30 days')).toHaveText('312,840.00');
  await expect(group(page, 'sales').locator('.cc-caption')).toHaveText('Gross, including shipping, before fees and tax.');
  expect(await group(page, 'sales').innerText()).not.toMatch(/[$€£¥]/);
  await expect(figure(page, 'orders', 'Today')).toHaveText('18');
  await expect(figure(page, 'orders', 'Last 7 days')).toHaveText('112');
  await expect(figure(page, 'orders', 'Average order')).toHaveText('92.00');
  await expect(figure(page, 'customers', 'Repeat customers')).toHaveText('51');
  await expect(group(page, 'customers').locator('.cc-figure').first().locator('.cc-figure-value')).toHaveText('214');
  await expect(figure(page, 'inventory', 'Low stock')).toHaveText('2');
  await expect(figure(page, 'inventory', 'Retest due')).toHaveText('3');
  await expect(figure(page, 'inventory', 'Retest overdue')).toHaveText('1');

  // Order stages: all eight, in order, zero shown as zero.
  const stages = page.locator('.cc-stage');
  await expect(stages).toHaveCount(8);
  await expect(stages.locator('.cc-stage-label')).toHaveText(['Paid', 'Processing', 'Packed', 'Shipped', 'Delivered', 'Completed', 'Cancelled', 'Refunded']);
  await expect(stages.locator('.cc-stage-count')).toHaveText(['24', '8', '5', '12', '18', '91', '2', '0']);
  await expect(page.locator('.cc-stage[data-status="refunded"]')).toHaveClass(/is-zero/);
  expect(await page.locator('#cc-stages a').count()).toBe(0);

  // Needs attention: what the dashboard counts, with the orders' own reasons.
  const alerts = page.locator('.cc-alert .cc-alert-text');
  await expect(alerts).toHaveText([
    '4 orders need attention',
    '2 products are low on stock',
    '1 lot is overdue for retest',
    '3 lots need retesting within 30 days, overdue ones included'
  ]);
  await expect(page.locator('.cc-alert-list li')).toHaveCount(2);
  await expect(page.locator('.cc-alert-list li').first()).toContainText('Customer 1');
  await expect(page.locator('.cc-alert-list li').first()).toContainText('paid over 24 hours, not started');

  // Recent orders: newest first, totals in the order's own currency.
  const rows = page.locator('#cc-recent tbody tr');
  await expect(rows).toHaveCount(8);
  await expect(rows.first().locator('td')).toHaveText(['Oct 2, 9:59 AM', 'Customer 1', '$145.00', 'Paid']);
  await expect(page.locator('#cc-recent thead th')).toHaveText(['Received', 'Customer', 'Total', 'Status']);

  // Recent activity, in plain words.
  await expect(page.locator('.cc-activity-what')).toHaveText(['Order shipped', 'Order moved to Processing', 'Stock received']);
  await expect(page.locator('.cc-activity-meta').first()).toHaveText('Oct 2, 9:12 AM · owner@example.org');

  // Low stock.
  await expect(page.locator('.cc-stock-item')).toHaveCount(2);
  await expect(page.locator('.cc-stock-item').first()).toContainText('bpc-157');
  await expect(page.locator('.cc-stock-item').first()).toContainText('3 available');
  await expect(page.locator('.cc-stock-item').first()).toContainText('reorder at 5');

  // The page address never changes or carries data.
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/console/index.html');
});

test('one refresh asks each source once, with only the documented parameters', async ({ page, request }) => {
  await load(page, request, overviewTables());
  await ready(page);
  const got = (await calls(request)).map((c) => `${c.method} ${c.endpoint}${c.search}`).sort();
  expect(got).toEqual([
    'GET admin-audit?limit=6',
    'GET admin-customers?limit=1',
    'GET admin-dashboard',
    'GET admin-inventory?active=true&low=1',
    'GET admin-orders?attention=1&limit=5',
    'GET admin-orders?limit=8'
  ]);
});

test('missing or null figures read as a dash, and nothing breaks', async ({ page, request }) => {
  await load(page, request, overviewTables({ summary: null, customer_summary: [] }));
  await ready(page);
  for (const [key, label] of [['sales', 'Today'], ['sales', 'Last 30 days'], ['orders', 'Today'], ['orders', 'Average order'],
                              ['customers', 'Repeat customers'], ['inventory', 'Low stock'], ['inventory', 'Retest overdue']]) {
    await expect(figure(page, key, label)).toHaveText('—');
  }
  await expect(page.locator('.cc-stage-count')).toHaveText(['24', '8', '5', '12', '18', '91', '2', '0']);
});

test('a null average reads as a dash', async ({ page, request }) => {
  await load(page, request, overviewTables({ summary: { average_order_30d_cents: null } }));
  await ready(page);
  await expect(figure(page, 'orders', 'Average order')).toHaveText('—');
  await expect(figure(page, 'sales', 'Today')).toHaveText('12,450.00');
});

test('sales across more than one currency are flagged, never given a symbol', async ({ page, request }) => {
  await load(page, request, overviewTables({ summary: { currencies: 2 } }));
  await ready(page);
  await expect(group(page, 'sales').locator('.cc-caption')).toHaveClass(/is-warn/);
  await expect(group(page, 'sales').locator('.cc-caption')).toContainText('Adds together 2 currencies');
  await expect(page.locator('.cc-alert-text').last()).toHaveText('Sales figures add together 2 currencies, so the totals cannot be read as one figure');
  expect(await group(page, 'sales').innerText()).not.toMatch(/[$€£¥]/);
});

test('with nothing to deal with, Needs attention says so', async ({ page, request }) => {
  await load(page, request, overviewTables({
    summary: { orders_needing_attention: 0, low_stock_items: 0, lots_retest_due_30d: 0, lots_retest_overdue: 0 },
    order_queue: queue(3)
  }));
  await ready(page);
  await expect(page.locator('.cc-alert')).toHaveCount(0);
  await expect(page.locator('#cc-attention-body')).toContainText('Nothing needs attention right now.');
});

test('empty lists say so', async ({ page, request }) => {
  await load(page, request, overviewTables({ order_queue: [], admin_audit_log: [], inventory_levels: [] }));
  await ready(page);
  await expect(page.locator('#cc-recent-body')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#cc-recent-body')).toContainText('No orders yet');
  await expect(page.locator('#cc-activity-body')).toContainText('No recent changes');
  await expect(page.locator('#cc-stock-body')).toContainText('Nothing is low on stock');
});

test('an unknown status or audit action is shown as itself, not guessed at', async ({ page, request }) => {
  const t = overviewTables({ order_queue: queue(1, () => ({ status: 'on_hold' })) });
  t.admin_audit_log = [{ id: 9, occurred_at: '2026-10-02T09:00:00Z', actor_email: null, action: 'staff.something_new',
    entity_type: 'staff', entity_id: '1', details: null }];
  await load(page, request, t);
  await ready(page);
  await expect(page.locator('#cc-recent .console-badge')).toHaveText('on_hold');
  await expect(page.locator('#cc-recent .console-badge')).toHaveAttribute('data-status', 'other');
  await expect(page.locator('.cc-activity-what')).toHaveText(['Change recorded']);
  await expect(page.locator('.cc-activity-meta')).toHaveText(['Oct 2, 9:00 AM']);
});

test('an order opens on its own page; only a real order id becomes a link', async ({ page, request }) => {
  const t = overviewTables({ order_queue: queue(3, (i) => (i === 1 ? { order_id: 'not-a-uuid', attention_reason: 'paid over 24 hours, not started' }
                                                         : { attention_reason: i === 0 ? 'packed over 24 hours, not shipped' : null })) });
  await load(page, request, t);
  await ready(page);
  const links = page.locator('#cc-recent tbody a');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', `order.html?id=${id(1)}`);
  await expect(page.locator('#cc-recent tbody tr').nth(1).locator('a')).toHaveCount(0);
  await expect(page.locator('#cc-recent tbody tr').nth(1)).toContainText('Customer 2');
  await expect(page.locator('.cc-alert-list a')).toHaveAttribute('href', `order.html?id=${id(1)}`);
  // Activity on an order links to it; activity on anything else does not.
  await expect(page.locator('#cc-activity a')).toHaveCount(2);
  await expect(page.locator('#cc-activity a').first()).toHaveAttribute('href', `order.html?id=${ORDER_ID}`);

  await setState(request, { tables: orderTables() });
  await links.first().click();
  await expect(page).toHaveURL(new RegExp(`/console/order\\.html\\?id=${id(1)}$`));
  await expect(page.locator('#od-workspace')).toBeVisible();
});

/* ------------------------------------------------------------ permissions */

test('a section the person has no access to is left out, not shown as refused', async ({ page, request }) => {
  await load(page, request, overviewTables(), { permissions: ['orders.read'] });
  await ready(page);
  await expect(page.locator('#cc-snapshot')).toBeHidden();
  await expect(page.locator('#cc-activity')).toBeHidden();
  await expect(page.locator('#cc-stock')).toBeHidden();
  await expect(page.locator('#cc-stages')).toBeVisible();
  await expect(page.locator('#cc-attention')).toBeVisible();
  await expect(page.locator('#cc-recent tbody tr')).toHaveCount(8);
  await expect(page.locator('main')).not.toContainText('Not available to you');
  // Only the orders need attention: there is no stock section to count from.
  await expect(page.locator('.cc-alert-text')).toHaveText(['4 orders need attention']);
});

test('without finance access, sales and order totals are left out; customers and stock stay', async ({ page, request }) => {
  await load(page, request, overviewTables(), {
    permissions: ['orders.read', 'customers.read', 'inventory.read', 'audit.read'] });
  await ready(page);
  await expect(group(page, 'sales')).toHaveCount(0);
  await expect(group(page, 'orders')).toHaveCount(0);
  await expect(group(page, 'customers')).toBeVisible();
  await expect(group(page, 'inventory')).toBeVisible();
});

/* ----------------------------------------------------------------- errors */

test('no access to orders at all: the overview says so, and shows nothing else', async ({ page, request }) => {
  await load(page, request, overviewTables(), { permissions: [] });
  await expect(page.locator('#cc-notice')).toHaveAttribute('data-error-kind', 'forbidden');
  await expect(page.locator('#cc-notice')).toContainText('Not available to you');
  await expect(page.locator('#cc-workspace')).toBeHidden();
});

test('the data cannot be reached: Unavailable, and Try again recovers', async ({ page, request }) => {
  await load(page, request, overviewTables(), { down: true });
  await expect(page.locator('#cc-notice')).toHaveAttribute('data-error-kind', 'unavailable');
  await expect(page.locator('#cc-notice')).toContainText('Unavailable');
  await expect(page.locator('#cc-workspace')).toBeHidden();
  await setState(request, { down: false });
  await page.locator('#cc-notice').getByRole('button', { name: 'Try again' }).click();
  await ready(page);
  await expect(page.locator('#cc-notice')).toBeHidden();
});

test('a session without a second factor: the shell asks for it', async ({ page, request }) => {
  await load(page, request, overviewTables(), { tokenMode: 'aal1' });
  await expect(page.locator('#cc-notice')).toHaveAttribute('data-error-kind', 'mfa');
  await expect(page.locator('#console-alert')).toContainText('second factor');
});

test('an expired session: sign-in required', async ({ page, request }) => {
  await load(page, request, overviewTables(), { tokenMode: 'expired' });
  await expect(page.locator('#cc-notice')).toHaveAttribute('data-error-kind', 'signin');
  await expect(page.locator('#console-alert')).toContainText('Sign-in required');
});

test('one section failing shows its own error and retry; the rest still draw', async ({ page, request }) => {
  await load(page, request, overviewTables(), { errors: { admin_audit_log: { status: 500, code: 'XX000' } } });
  await ready(page);
  await expect(page.locator('#cc-activity-body')).toHaveAttribute('data-error-kind', 'unavailable');
  await expect(page.locator('#cc-recent tbody tr')).toHaveCount(8);
  await setState(request, { errors: {} });
  await page.locator('#cc-activity-body').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.cc-activity-what')).toHaveCount(3);
});

/* ------------------------------------------------------ loading, refresh */

test('loading is shown while the first answers are on their way', async ({ page, request }) => {
  await setState(request, { tables: overviewTables() });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/.netlify/functions/admin-dashboard*', async (route) => { await held; await route.continue(); });
  await open(page);
  await expect(page.locator('#cc-notice')).toHaveAttribute('data-state', 'loading');
  await expect(page.locator('#cc-notice')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#cc-workspace')).toBeHidden();
  release();
  await ready(page);
});

test('Refresh asks again and redraws, keeping the page in place meanwhile', async ({ page, request }) => {
  await load(page, request, overviewTables());
  await ready(page);
  await expect(page.locator('.cc-stage[data-status="paid"] .cc-stage-count')).toHaveText('24');
  await setState(request, { tables: overviewTables({ counts: { paid: 30 } }) });
  const before = (await calls(request)).length;
  await page.locator('#cc-refresh').click();
  await expect(page.locator('.cc-stage[data-status="paid"] .cc-stage-count')).toHaveText('30');
  expect((await calls(request)).length).toBe(before + 6);
  await expect(page.locator('#cc-workspace')).not.toHaveAttribute('aria-busy', 'true');
});

test('an answer to an earlier refresh never overwrites a later one', async ({ page, request }) => {
  await setState(request, { tables: overviewTables({ counts: { paid: 111 } }) });
  let first = null;
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/.netlify/functions/admin-dashboard*', async (route) => {
    if (first === null) { first = route; await held; await route.continue(); return; }
    await route.continue();
  });
  await open(page);
  await expect(page.locator('#cc-refresh')).toBeVisible();
  await expect.poll(() => first !== null).toBe(true);

  // The second refresh answers first, with the newer figures.
  await setState(request, { tables: overviewTables({ counts: { paid: 222 } }) });
  await page.locator('#cc-refresh').click();
  await expect(page.locator('.cc-stage[data-status="paid"] .cc-stage-count')).toHaveText('222');

  // Then the first, slower answer arrives, carrying older figures: ignored.
  await setState(request, { tables: overviewTables({ counts: { paid: 111 } }) });
  release();
  await page.waitForTimeout(500);
  await expect(page.locator('.cc-stage[data-status="paid"] .cc-stage-count')).toHaveText('222');
});

/* --------------------------------------------------------------- security */

test('server text is shown as text, never run as markup', async ({ page, request }) => {
  const t = overviewTables({
    order_queue: queue(2, () => ({ name: XSS, attention_reason: XSS, currency: XSS, status: XSS })),
    customer_summary: [{ currency: XSS, customers: 1, repeat_customers: 0 }, { currency: 'USD', customers: 2, repeat_customers: 0 }]
  });
  t.inventory_levels = [{ product_id: XSS, pack_size: XSS, active: true, on_hand: 1, available: 1, low_stock_threshold: 2, is_low: true }];
  t.admin_audit_log = [{ id: 1, occurred_at: '2026-10-02T09:00:00Z', actor_email: XSS, action: XSS, entity_type: 'order',
    entity_id: XSS, details: { to: XSS } }];
  await load(page, request, t);
  await ready(page);
  await expect(page.locator('#cc-recent tbody tr').first()).toContainText(XSS);
  await expect(page.locator('.cc-alert-list li').first()).toContainText(XSS);
  await expect(page.locator('.cc-stock-item')).toContainText(XSS);
  await expect(page.locator('.cc-activity-meta')).toContainText(XSS);
  await expect(group(page, 'customers')).toContainText(XSS);
  expect(await page.locator('main img, main script').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

/* ----------------------------------------------------------------- layout */

test('desktop 1440×900: the whole overview fits on one screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page, request, overviewTables());
  await ready(page);
  for (const id of ['#cc-snapshot', '#cc-stages', '#cc-attention', '#cc-recent', '#cc-activity', '#cc-stock']) {
    const box = await page.locator(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(900);
  }
  await noOverflow(page);
});

test('narrow 390px: one column, attention before the lists, no sideways scrolling', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page, request, overviewTables());
  await ready(page);
  await noOverflow(page);
  const attention = await page.locator('#cc-attention').boundingBox();
  const recent = await page.locator('#cc-recent').boundingBox();
  expect(attention.y).toBeLessThan(recent.y);
  // The orders table reads as labelled cards.
  const label = await page.locator('#cc-recent tbody td').first().evaluate((td) => getComputedStyle(td, '::before').content);
  expect(label).toBe('"Received"');
});
