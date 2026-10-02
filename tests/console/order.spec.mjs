/*
 * One order, read-only (console/order.html, assets/js/console/order.js), in a
 * real browser, offline, on the real admin-orders handler and fixtures.
 */
import { test, expect } from '@playwright/test';
import { guard, setState, calls, noOverflow, orderTables, ORDER_ID, XSS } from './helpers.mjs';

guard();

const url = (id) => `/console/order.html?id=${id}`;
const ready = (page) => expect(page.locator('#od-workspace')).toBeVisible();
// Exact titles and labels: "Items" is not "Items matched to products", "Total" is not "Subtotal".
const exact = (words) => new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const section = (page, title) => page.locator('.od-section', { has: page.locator('.cc-section-title', { hasText: exact(title) }) });
const fact = (page, title, label) => section(page, title).locator('.od-dl-row', { has: page.locator('dt', { hasText: exact(label) }) }).locator('dd');

async function load(page, request, tables, extra) {
  await setState(request, Object.assign({ tables }, extra || {}));
  await page.goto(url(ORDER_ID));
}

test('asks for exactly this order, once, and nothing else', async ({ page, request }) => {
  await load(page, request, orderTables());
  await ready(page);
  expect(await calls(request)).toEqual([
    { endpoint: 'admin-orders', method: 'GET', search: `?id=${ORDER_ID}`, authorization: 'Bearer', cookie: false }
  ]);
  // The address is the order id and nothing more.
  expect(new URL(page.url()).search).toBe(`?id=${ORDER_ID}`);
});

test('every part of the order is shown', async ({ page, request }) => {
  await load(page, request, orderTables());
  await ready(page);
  await expect(page.locator('h1')).toHaveText('Order placed Oct 2, 2026, 9:59 AM');
  await expect(page.locator('.od-status .console-badge')).toHaveText('Packed');
  await expect(page.locator('.od-since')).toHaveText('since Oct 2, 2026, 12:30 PM');
  await expect(page.locator('.od-stages li')).toHaveText(['ProcessingOct 2, 2026, 11:00 AM', 'PackedOct 2, 2026, 12:30 PM']);

  await expect(page.locator('.od-attention-title')).toHaveText('Needs attention: line needs product mapping');
  await expect(page.locator('.od-attention-text')).toHaveText(['1 line has no product matched']);

  await expect(fact(page, 'Customer', 'Name')).toHaveText('Jane Doe');
  await expect(fact(page, 'Customer', 'Email')).toHaveText('jane@example.org');
  await expect(fact(page, 'Customer', 'Phone')).toHaveText('+1 555 0100');
  await expect(fact(page, 'Shipping', 'Address').locator('.od-address > span')).toHaveText(['1 Main St', 'Suite 4', 'Springfield, IL 62701', 'US']);
  await expect(fact(page, 'Shipping', 'Carrier')).toHaveText('—');
  await expect(fact(page, 'Shipping', 'Research use confirmed')).toHaveText('Yes');

  await expect(fact(page, 'Totals', 'Subtotal')).toHaveText('$145.00');
  await expect(fact(page, 'Totals', 'Shipping')).toHaveText('$15.00');
  await expect(fact(page, 'Totals', 'Discount')).toHaveText('$5.00');
  await expect(fact(page, 'Totals', 'Total')).toHaveText('$155.00');
  await expect(fact(page, 'Totals', 'Currency')).toHaveText('USD');

  await expect(fact(page, 'Reference', 'Payment reference')).toHaveText('cs_test_abc123');
  await expect(fact(page, 'Reference', 'Order ID')).toHaveText(ORDER_ID);

  const items = section(page, 'Items').locator('tbody tr');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0).locator('td')).toHaveText(['BPC-157 5mg', 'bpc-157 · 5mg', '2', '$60.00', '$120.00']);
  await expect(items.nth(1).locator('td').nth(1)).toHaveText('No product matched');
  await expect(items.nth(2).locator('td').nth(1)).toHaveText('Add-on for bpc-157 · 5mg');

  await expect(section(page, 'Status history').locator('.od-timeline-what'))
    .toHaveText(['Recorded as Paid', 'Paid → Processing', 'Processing → Packed']);
  await expect(section(page, 'Status history')).toContainText('Packed with ice');

  // A note keeps its line breaks.
  const note = section(page, 'Notes').locator('.od-note-body').first();
  expect(await note.innerText()).toBe('Customer asked for\nsignature on delivery');
  await expect(section(page, 'Notes')).toContainText('owner@example.org');

  const drawn = section(page, 'Stock drawn for this order').locator('li');
  await expect(drawn).toHaveCount(2);
  await expect(drawn.nth(0)).toContainText('Held');
  await expect(drawn.nth(0)).toContainText('2 units');
  await expect(drawn.nth(1)).toContainText('Released Oct 2, 2026, 11:45 AM');
  await expect(section(page, 'Stock drawn for this order')).not.toContainText('aaaaaaaa-0000-4000-8000-000000000050');

  const matched = section(page, 'Items matched to products').locator('li');
  await expect(matched).toContainText('BPC 157 (old name) × 1');
  await expect(matched).toContainText('Same product, renamed');
  await expect(matched).toContainText('Undone Oct 2, 2026, 11:20 AM by owner@example.org: Wrong line');

  await expect(fact(page, 'Cost of goods', 'Cost of goods')).toHaveText('42.00');
  await expect(fact(page, 'Cost of goods', 'Units ordered')).toHaveText('3');
  await expect(fact(page, 'Cost of goods', 'Units costed')).toHaveText('2');
  await expect(fact(page, 'Cost of goods', 'Complete')).toContainText('Incomplete');
  await expect(section(page, 'Cost of goods')).toContainText('Lot costs carry their own currency');
});

test('the payment provider is never named', async ({ page, request }) => {
  await load(page, request, orderTables());
  await ready(page);
  expect(await page.locator('body').innerText()).not.toMatch(/stripe/i);
});

test('cost of goods appears only when the API returns it (finance access)', async ({ page, request }) => {
  await load(page, request, orderTables(), { permissions: ['orders.read'] });
  await ready(page);
  await expect(section(page, 'Cost of goods')).toHaveCount(0);
  const reads = (await calls(request)).map((c) => c.endpoint);
  expect(reads).toEqual(['admin-orders']);
});

test('quiet parts: no attention, no stock drawn, no matches, no notes; an empty address is said so', async ({ page, request }) => {
  await load(page, request, orderTables({
    order: { shipping_address: null, research_use_confirmed: null, notes: 'Left at the front desk' },
    order_queue: [{ attention_reason: null, unmapped_lines: 0, unallocated_units: 0 }],
    order_line_lots: [], order_line_mappings: [], order_notes: []
  }));
  await ready(page);
  await expect(page.locator('.od-attention')).toHaveCount(0);
  await expect(section(page, 'Stock drawn for this order')).toHaveCount(0);
  await expect(section(page, 'Items matched to products')).toHaveCount(0);
  await expect(fact(page, 'Shipping', 'Address')).toHaveText('No shipping address recorded');
  await expect(fact(page, 'Shipping', 'Research use confirmed')).toHaveText('—');
  // The order record's own note shows; there are no staff notes.
  await expect(section(page, 'Notes')).toContainText('Note on the order record');
  await expect(section(page, 'Notes')).toContainText('Left at the front desk');
});

test('an address that is not what is expected is not trusted', async ({ page, request }) => {
  await load(page, request, orderTables({ order: { shipping_address: { line1: 42, city: ['x'], country: 'US' } } }));
  await ready(page);
  await expect(fact(page, 'Shipping', 'Address').locator('.od-address > span')).toHaveText(['US']);
});

/* ----------------------------------------------------- ids and refusals */

test('no id, or one that is not an order id: no request at all', async ({ page, request }) => {
  for (const bad of ['', '?id=', '?id=123', `?id=${ORDER_ID}x`, '?id=%3Cscript%3E']) {
    await page.goto(`/console/order.html${bad}`);
    await expect(page.locator('#od-notice')).toContainText('No order selected');
    await expect(page.locator('#od-workspace')).toBeHidden();
    await expect(page.locator('#od-refresh')).toBeHidden();
  }
  expect(await calls(request)).toEqual([]);
});

test('400 from the API names the refused parameter', async ({ page, request }) => {
  await setState(request, { tables: orderTables() });
  await page.route('**/.netlify/functions/admin-orders*', (route) => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_parameter', parameter: 'id' }) }));
  await page.goto(url(ORDER_ID));
  await expect(page.locator('#od-notice')).toHaveAttribute('data-error-kind', 'invalid');
  await expect(page.locator('#od-notice')).toContainText('Refused: id');
});

test('an order that does not exist: Not found, and no retry', async ({ page, request }) => {
  await load(page, request, Object.assign(orderTables(), { orders: [] }));
  await expect(page.locator('#od-notice')).toHaveAttribute('data-error-kind', 'not_found');
  await expect(page.locator('#od-notice')).toContainText('Not found');
  await expect(page.locator('#od-notice').getByRole('button')).toHaveCount(0);
});

test('no access to orders: Not available to you', async ({ page, request }) => {
  await load(page, request, orderTables(), { permissions: [] });
  await expect(page.locator('#od-notice')).toHaveAttribute('data-error-kind', 'forbidden');
  await expect(page.locator('#od-notice')).toContainText('Not available to you');
});

test('the data cannot be reached: Unavailable, and Try again recovers', async ({ page, request }) => {
  await load(page, request, orderTables(), { down: true });
  await expect(page.locator('#od-notice')).toHaveAttribute('data-error-kind', 'unavailable');
  await setState(request, { down: false });
  await page.locator('#od-notice').getByRole('button', { name: 'Try again' }).click();
  await ready(page);
});

test('no sign-in provider: says so and asks for nothing', async ({ page, request }) => {
  await setState(request, { devSession: false, tables: orderTables() });
  await page.goto(url(ORDER_ID));
  await expect(page.locator('#od-notice')).toContainText('Sign-in is not set up yet');
  expect(await calls(request)).toEqual([]);
});

/* ---------------------------------------------------- read-only, loading */

test('read-only: no forms, no write controls, and nothing but GET is ever sent', async ({ page, request }) => {
  const methods = [];
  page.on('request', (r) => { if (r.url().includes('/.netlify/functions/')) methods.push(r.method()); });
  await load(page, request, orderTables());
  await ready(page);
  await page.locator('#od-refresh').click();
  await expect.poll(() => methods.length).toBe(2);
  expect(methods).toEqual(['GET', 'GET']);
  expect(await page.locator('main form, main input, main textarea, main select').count()).toBe(0);
  await expect(page.locator('main button')).toHaveText(['Refresh']);
});

test('loading is shown while the order is on its way, and Refresh keeps it in place', async ({ page, request }) => {
  await setState(request, { tables: orderTables() });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/.netlify/functions/admin-orders*', async (route) => { await held; await route.continue(); });
  await page.goto(url(ORDER_ID));
  await expect(page.locator('#od-notice')).toHaveAttribute('data-state', 'loading');
  await expect(page.locator('#od-notice')).toHaveAttribute('aria-busy', 'true');
  release();
  await ready(page);
  await page.unroute('**/.netlify/functions/admin-orders*');
  await setState(request, { tables: orderTables({ order: { name: 'Janet Doe' } }) });
  await page.locator('#od-refresh').click();
  await expect(fact(page, 'Customer', 'Name')).toHaveText('Janet Doe');
});

/* --------------------------------------------------------------- security */

test('server text is shown as text, never run as markup', async ({ page, request }) => {
  await load(page, request, orderTables({
    order: { name: XSS, email: XSS, phone: XSS, carrier: XSS, tracking_number: XSS, stripe_session_id: XSS, notes: XSS,
             currency: XSS, shipping_address: { line1: XSS, city: XSS, country: XSS } },
    order_items: [{ id: 1, kind: 'product', description: XSS, quantity: 1, unit_amount: 100, amount_total: 100, sku: XSS, pack_size: XSS }],
    order_status_history: [{ id: 1, from_status: XSS, to_status: XSS, changed_at: '2026-10-02T09:59:00Z', changed_by: XSS, note: XSS }],
    order_notes: [{ id: 1, body: XSS, author_email: XSS, created_at: '2026-10-02T10:00:00Z' }],
    order_line_lots: [{ id: 1, product_id: XSS, pack_size: XSS, quantity: 1, allocated_at: '2026-10-02T10:00:00Z', allocated_by: XSS, released_at: null }],
    order_line_mappings: [{ id: 1, match_description: XSS, match_quantity: 1, product_id: XSS, pack_size: XSS, note: XSS, mapped_by: XSS,
                            mapped_at: '2026-10-02T10:00:00Z', reverted_at: '2026-10-02T11:00:00Z', reverted_by: XSS, revert_note: XSS }],
    order_queue: [{ attention_reason: XSS, unmapped_lines: 0, unallocated_units: 0 }]
  }));
  await ready(page);
  await expect(fact(page, 'Customer', 'Name')).toHaveText(XSS);
  await expect(page.locator('.od-attention-title')).toContainText(XSS);
  await expect(section(page, 'Notes')).toContainText(XSS);
  expect(await page.locator('main img, main script').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

/* ----------------------------------------------------------------- layout */

test('narrow 390px: one column, customer details first, no sideways scrolling', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page, request, orderTables());
  await ready(page);
  await noOverflow(page);
  const customer = await section(page, 'Customer').boundingBox();
  const items = await section(page, 'Items').boundingBox();
  expect(customer.y).toBeLessThan(items.y);
});

test('desktop 1440×900: the order sits in two columns', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page, request, orderTables());
  await ready(page);
  await noOverflow(page);
  const items = await section(page, 'Items').boundingBox();
  const customer = await section(page, 'Customer').boundingBox();
  expect(customer.x).toBeGreaterThan(items.x + items.width - 1);
  expect(Math.abs(customer.y - items.y)).toBeLessThan(2);
});
