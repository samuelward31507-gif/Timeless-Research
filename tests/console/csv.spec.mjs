/*
 * The orders CSV (assets/js/console/csv.js) from the business overview, in a
 * real browser, offline. The first page always comes from the real
 * admin-orders handler; later pages are served by the test, because the
 * fixtures return the same rows whatever cursor is asked for.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { guard, setState, calls, overviewTables, queue, queueRow, id } from './helpers.mjs';

guard();

const HEADER = 'order_id,created_at,status,status_since,customer_name,customer_email,currency,amount_total_minor,'
  + 'amount_total,product_lines,product_units,addon_lines,carrier,tracking_number,shipped_at,delivered_at,'
  + 'payment_reference,needs_attention,note_count';

async function openWith(page, request, orders) {
  await setState(request, { tables: overviewTables({ order_queue: orders }) });
  await page.goto('/console/index.html');
  await expect(page.locator('#cc-workspace')).toBeVisible();
}

async function download(page) {
  const waiting = page.waitForEvent('download');
  await page.locator('#cc-csv').click();
  const dl = await waiting;
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}

const exportCalls = async (request) => (await calls(request)).filter((c) => c.endpoint === 'admin-orders' && c.search.includes('limit=100'));

test('one click saves every order as a predictable UTF-8 CSV', async ({ page, request }) => {
  await openWith(page, request, queue(3, (i) => (i === 0 ? {
    status: 'shipped', carrier: 'UPS', tracking_number: '1Z 999', shipped_at: '2026-10-02T12:00:00Z', note_count: 2,
    attention_reason: 'shipped 14+ days ago, not delivered'
  } : {})));
  await expect(page.locator('#cc-recent .cc-section-head').getByRole('button', { name: 'Download CSV' })).toBeVisible();
  const { name, text } = await download(page);

  expect(name).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(text.charCodeAt(0)).toBe(0xFEFF);
  const lines = text.slice(1).split('\r\n');
  expect(lines[lines.length - 1]).toBe('');
  expect(lines[0]).toBe(HEADER);
  expect(lines).toHaveLength(5);
  expect(lines[1]).toBe(`${id(1)},2026-10-02T09:59:00.000Z,shipped,2026-10-02T10:00:00.000Z,Customer 1,c1@example.org,USD,`
    + '14500,145.00,1,2,0,UPS,1Z 999,2026-10-02T12:00:00Z,,ref_1,"shipped 14+ days ago, not delivered",2');
  expect(lines[2]).toBe(`${id(2)},2026-10-02T09:58:00.000Z,paid,2026-10-02T10:00:00.000Z,Customer 2,c2@example.org,USD,`
    + '14500,145.00,1,2,0,,,,,ref_2,,0');

  // Asked for 100 at a time; no phone or address is among the columns.
  expect((await exportCalls(request)).map((c) => c.search)).toEqual(['?limit=100']);
  expect(HEADER).not.toMatch(/phone|address/);
  await expect(page.locator('#console-toast')).toHaveText('Downloaded 3 orders.');
  await expect(page.locator('#cc-csv')).toBeEnabled();
  // The page address is untouched.
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/console/index.html');
});

test('quoting, accents, other currencies, and text a spreadsheet would run', async ({ page, request }) => {
  await openWith(page, request, [
    queueRow({ n: 1, name: 'Smith, "Jo"\nJr', email: 'zoë@example.org', currency: 'JPY', amount_total: 1500 }),
    queueRow({ n: 2, name: '=HYPERLINK("http://x")', email: '+cmd', carrier: '@carrier', tracking_number: '-5', currency: 'USD', amount_total: 5 }),
    queueRow({ n: 3, name: ' padded ', currency: 'US$', amount_total: 100 })
  ]);
  const { text } = await download(page);
  const body = text.slice(1);
  expect(body).toContain(`${id(1)},2026-10-02T09:59:00.000Z,paid,2026-10-02T10:00:00.000Z,"Smith, ""Jo""\nJr",zoë@example.org,JPY,1500,1500,`);
  expect(body).toContain(`,"'=HYPERLINK(""http://x"")",'+cmd,USD,5,0.05,`);
  expect(body).toContain(",'@carrier,-5,");
  // A currency code the browser cannot read keeps its minor units and leaves the decimal empty.
  expect(body).toContain(',US$,100,,');
  expect(body).toContain(',paid,2026-10-02T10:00:00.000Z," padded ",');
});

test('every page is fetched in turn, by cursor, until there are no more', async ({ page, request }) => {
  await openWith(page, request, queue(101));
  const pages = [];
  await page.route('**/.netlify/functions/admin-orders?*cursor=*', (route) => {
    pages.push(new URL(route.request().url()).searchParams.get('cursor'));
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ orders: [queueRow({ n: 500, name: 'Last one' })], next_cursor: null }) });
  });
  const { text } = await download(page);
  const lines = text.slice(1).split('\r\n').filter(Boolean);
  expect(lines).toHaveLength(1 + 101);
  expect(lines[lines.length - 1]).toContain('Last one');
  // The first page came from the real handler, with its own cursor for the next.
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  await expect(page.locator('#console-toast')).toHaveText('Downloaded 101 orders.');
});

test('at most 10,000 orders, the most recent, and the toast says so', async ({ page, request }) => {
  await openWith(page, request, queue(101));
  let served = 0;
  await page.route('**/.netlify/functions/admin-orders?*cursor=*', (route) => {
    served += 1;
    const rows = Array.from({ length: 100 }, (_, i) => queueRow({ n: 1000 + served * 100 + i }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: rows, next_cursor: `c${served}` }) });
  });
  const { text } = await download(page);
  expect(text.slice(1).split('\r\n').filter(Boolean)).toHaveLength(1 + 10000);
  expect(served).toBe(99);
  await expect(page.locator('#console-toast')).toHaveText('Downloaded the 10,000 most recent orders. Older orders are not in this file.');
});

test('a page that fails saves nothing, says so, and lets you try again', async ({ page, request }) => {
  await openWith(page, request, queue(101));
  await page.route('**/.netlify/functions/admin-orders?*cursor=*', (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) }));
  let downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.locator('#cc-csv').click();
  await expect(page.locator('#console-toast')).toContainText('nothing was downloaded');
  await expect(page.locator('#cc-csv')).toBeEnabled();
  await expect(page.locator('#cc-csv')).toHaveText('Download CSV');
  expect(downloads).toBe(0);
});

test('while a file is being prepared the button waits, so one click is one export', async ({ page, request }) => {
  await openWith(page, request, queue(2));
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/.netlify/functions/admin-orders?limit=100', async (route) => { await held; await route.continue(); });
  await page.locator('#cc-csv').click();
  await expect(page.locator('#cc-csv')).toBeDisabled();
  await expect(page.locator('#cc-csv')).toHaveText('Preparing…');
  await page.locator('#cc-csv').click({ force: true });
  const waiting = page.waitForEvent('download');
  release();
  await waiting;
  await expect(page.locator('#cc-csv')).toBeEnabled();
  expect(await exportCalls(request)).toHaveLength(1);
});

test('no access to orders: the export says so and saves nothing', async ({ page, request }) => {
  await openWith(page, request, queue(2));
  await setState(request, { permissions: [] });
  let downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.locator('#cc-csv').click();
  await expect(page.locator('#console-toast')).toHaveText('Your account does not have access to orders.');
  expect(downloads).toBe(0);
});
