/*
 * The operations console foundation, in a real browser (Chromium), offline.
 * server.mjs serves the built pages and runs the real admin-* handlers on
 * tests/helpers/admin-fixtures.js. These test the shell, the auth seam, the
 * request layer and the shared UI pieces; the screens have their own specs
 * (command.spec.mjs and the others), sharing helpers.mjs.
 */
import { test, expect } from '@playwright/test';

const ORDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

async function setState(request, body) {
  const r = await request.post('/__test/state', { data: body });
  expect(r.status()).toBe(204);
}

let outside;

test.beforeEach(async ({ page, request }) => {
  await setState(request, { reset: true });
  outside = [];
  // Nothing may leave the machine: any request to another host is refused
  // and fails the test.
  await page.context().route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    outside.push(u.href);
    return route.abort();
  });
});

test.afterEach(() => {
  expect(outside, 'requests to other hosts').toEqual([]);
});

const open = (page) => page.goto('/console/index.html');
const call = (page, endpoint, opts) => page.evaluate(([e, o]) =>
  window.TRConsole.api.requestAdmin(e, o).then(
    (data) => ({ ok: true, data }),
    (err) => ({ ok: false, kind: err.kind, status: err.status, code: err.code, field: err.field,
                parameter: err.parameter, message: err.message, name: err.name, json: JSON.stringify(err) })),
[endpoint, opts]);

/* ------------------------------------------------------------- privacy */

test('the console is private: noindex, no-store, a strict CSP, and no storefront chrome', async ({ page }) => {
  const res = await open(page);
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['x-robots-tag']).toContain('noindex');
  expect(h['cache-control']).toBe('no-store');
  expect(h['x-frame-options']).toBe('SAMEORIGIN');
  expect(h['x-content-type-options']).toBe('nosniff');
  const csp = h['content-security-policy'];
  for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'self'"]) {
    expect(csp).toContain(d);
  }
  expect(csp).not.toContain('unsafe-inline');

  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
  expect(await page.locator('link[rel="canonical"], meta[property^="og:"]').count()).toBe(0);
  expect(await page.locator('#gate, #cart, #chat-drawer, #chat-open').count()).toBe(0);
  const scripts = await page.locator('script').evaluateAll((s) => s.map((x) => x.getAttribute('src')));
  for (const s of scripts) expect(s).toMatch(/\/assets\/js\/console\/[a-z]+\.js\?v=[0-9a-f]+$/);
  const links = await page.locator('a[href]').evaluateAll((a) => a.map((x) => x.href));
  for (const l of links) expect(new URL(l).pathname.startsWith('/console/') || l.includes('#')).toBe(true);
});

test('the CSP refuses inline script and inline style', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.body.appendChild(s);
    const div = document.createElement('div');
    div.setAttribute('style', 'color: red');
    document.body.appendChild(div);
    setTimeout(() => resolve({ ran: window.__inlineRan === true, seen }), 300);
  }));
  expect(result.ran).toBe(false);
  expect(result.seen.some((d) => d.startsWith('script-src'))).toBe(true);
  expect(result.seen.some((d) => d.startsWith('style-src'))).toBe(true);
});

/* --------------------------------------------------------------- shell */

test('shell: one h1, landmarks, and the business overview as the one current screen', async ({ page }) => {
  await open(page);
  expect(await page.locator('h1').count()).toBe(1);
  await expect(page.locator('main#main')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Console' })).toBeVisible();
  // One screen: the navigation holds the overview and nothing else, built.
  const links = page.locator('#console-nav .console-nav-link');
  await expect(links).toHaveCount(1);
  await expect(page.locator('a[aria-current="page"]')).toHaveText('Business overview');
  await expect(page.locator('a[aria-current="page"]')).toHaveAttribute('href', 'index.html');
  expect(await page.locator('.is-pending, [aria-disabled="true"]').count()).toBe(0);
});

test('keyboard: the skip link is first and moves focus to the content', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('narrow screens: the navigation folds behind Menu; Escape closes it and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const btn = page.locator('#console-menu-btn');
  const nav = page.locator('#console-nav');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(nav).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toBeFocused();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('wide screens: the navigation is always shown and there is no Menu button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await expect(page.locator('#console-menu-btn')).toBeHidden();
  await expect(page.locator('#console-nav')).toBeVisible();
});

/* ------------------------------------------------------------ auth seam */

test('no provider (as shipped): the overview says sign-in is not set up and nothing is requested', async ({ page, request }) => {
  await open(page);
  await expect(page.locator('#cc-notice')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#cc-notice')).toContainText('Sign-in is not set up yet');
  await expect(page.locator('#cc-workspace')).toBeHidden();
  expect(await page.evaluate(() => window.TRConsole.auth.hasProvider())).toBe(false);
  expect(await page.evaluate(() => window.TRConsole.auth.getAccessToken())).toBeNull();
  const r = await call(page, 'admin-dashboard');
  expect(r).toMatchObject({ ok: false, kind: 'signin', status: 401 });
  await expect(page.locator('#console-alert')).toBeVisible();
  await expect(page.locator('#console-alert')).toContainText('Sign-in required');
  expect(await (await request.get('/__test/calls')).json()).toEqual([]);
});

test('with a provider: the token travels only in the Authorization header, and is stored nowhere', async ({ page, request }) => {
  await setState(request, { devSession: true });
  const sent = [];
  page.on('request', (r) => { if (r.url().includes('/.netlify/functions/')) sent.push(r); });
  await open(page);
  await expect(page.locator('#cc-workspace')).toBeVisible();
  await expect(page.locator('#console-session')).toHaveText('Session available');

  const r = await call(page, 'admin-dashboard');
  expect(r.ok).toBe(true);
  expect(r.data.orders.status_counts).toHaveLength(8);

  // The overview's own reads plus this call. The dev provider signs a fresh
  // token for every call, so check each one that was sent.
  expect(sent).toHaveLength(7);
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
  for (const req of sent) {
    const h = await req.allHeaders();
    expect(h.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const token = h.authorization.slice('Bearer '.length);
    expect(h.cookie).toBeUndefined();
    expect(req.url()).not.toContain(token);
    expect(stored).not.toContain(token);
  }
  const calls = await (await request.get('/__test/calls')).json();
  expect(calls).toHaveLength(7);
  for (const c of calls) expect(c).toMatchObject({ method: 'GET', authorization: 'Bearer', cookie: false });
  expect(calls[calls.length - 1]).toEqual({ endpoint: 'admin-dashboard', method: 'GET', search: '', authorization: 'Bearer', cookie: false });

  // The provider is set once; a second cannot replace it.
  const second = await page.evaluate(() => {
    try { window.TRConsole.auth.setTokenProvider(() => 'x.y.z'); return 'replaced'; } catch (e) { return 'refused'; }
  });
  expect(second).toBe('refused');
});

test('a provider value that is not a bearer token means no session, and nothing is sent', async ({ page, request }) => {
  await setState(request, { devSession: true, tokenMode: 'garbage' });
  await open(page);
  await expect(page.locator('#cc-notice')).toContainText('Not signed in');
  expect(await page.evaluate(() => window.TRConsole.auth.getAccessToken())).toBeNull();
  expect((await call(page, 'admin-orders')).kind).toBe('signin');
  expect(await (await request.get('/__test/calls')).json()).toEqual([]);
});

/* ----------------------------------------------------- the request layer */

test('the server refusing the session: 401 is signin, and the shell asks for sign-in', async ({ page, request }) => {
  await setState(request, { devSession: true, tokenMode: 'expired' });
  await open(page);
  const r = await call(page, 'admin-dashboard');
  expect(r).toMatchObject({ ok: false, kind: 'signin', status: 401, code: 'not_authorized' });
  await expect(page.locator('#console-alert')).toContainText('Sign-in required');
});

test('no second factor: 403 mfa_required is mfa, and the shell says so', async ({ page, request }) => {
  await setState(request, { devSession: true, tokenMode: 'aal1' });
  await open(page);
  const r = await call(page, 'admin-dashboard');
  expect(r).toMatchObject({ ok: false, kind: 'mfa', status: 403, code: 'mfa_required' });
  await expect(page.locator('#console-alert')).toContainText('second factor');
});

test('every documented refusal maps to its kind, from the real handlers', async ({ page, request }) => {
  await setState(request, { devSession: true });
  await open(page);

  await setState(request, { permissions: [] });
  expect(await call(page, 'admin-dashboard')).toMatchObject({ kind: 'forbidden', status: 403, code: 'not_authorized' });

  await setState(request, { reset: true, devSession: true });
  expect(await call(page, 'admin-orders', { params: { status: 'bogus' } }))
    .toMatchObject({ kind: 'invalid', status: 400, parameter: 'status' });
  expect(await call(page, 'admin-orders', { params: { id: ORDER_ID } }))
    .toMatchObject({ kind: 'not_found', status: 404 });
  expect(await call(page, 'admin-orders', { action: 'order.add_note', fields: { order_id: ORDER_ID } }))
    .toMatchObject({ kind: 'invalid', status: 400, field: 'body' });

  const refused = [
    ['23514', 'only a packed order can be shipped', { kind: 'rejected', status: 422, message: 'only a packed order can be shipped' }],
    ['23505', undefined, { kind: 'conflict', status: 409, code: 'conflict' }],
    ['40001', undefined, { kind: 'retry', status: 409, code: 'retry' }],
    ['XX000', undefined, { kind: 'unavailable', status: 500, message: '' }]
  ];
  for (const [code, message, want] of refused) {
    await setState(request, { rpcErrors: { admin_add_order_note: { status: 400, code, message } } });
    expect(await call(page, 'admin-orders', { action: 'order.add_note', fields: { order_id: ORDER_ID, body: 'checked' } }))
      .toMatchObject(want);
  }

  await setState(request, { reset: true, devSession: true, down: true });
  expect(await call(page, 'admin-dashboard')).toMatchObject({ kind: 'unavailable', status: 500, code: 'unavailable' });
});

test('a write is a JSON POST with no query string, and the action cannot be overridden by a field', async ({ page, request }) => {
  await setState(request, { devSession: true, rpc: { admin_add_order_note: 7 } });
  await open(page);
  const bodies = [];
  page.on('request', (r) => { if (r.method() === 'POST') bodies.push([r.url(), r.postDataJSON(), r.headers()['content-type']]); });
  const r = await call(page, 'admin-orders', { action: 'order.add_note', fields: { order_id: ORDER_ID, body: 'checked', action: 'order.ship' } });
  expect(r).toEqual({ ok: true, data: { action: 'order.add_note', result: { note_id: 7 } } });
  expect(bodies).toEqual([[expect.stringMatching(/\/admin-orders$/), { order_id: ORDER_ID, body: 'checked', action: 'order.add_note' }, 'application/json']]);
});

test('no answer is a network error; an unknown endpoint is refused before any request', async ({ page, request }) => {
  await setState(request, { devSession: true });
  await open(page);
  await page.route('**/.netlify/functions/**', (route) => route.abort());
  expect(await call(page, 'admin-dashboard')).toMatchObject({ ok: false, kind: 'network', status: 0 });
  await page.unroute('**/.netlify/functions/**');
  expect(await call(page, 'admin-staff')).toMatchObject({ ok: false, name: 'TypeError' });
  expect(await call(page, '../health')).toMatchObject({ ok: false, name: 'TypeError' });
});

test('an error never carries the token or the response beyond its named fields', async ({ page, request }) => {
  await setState(request, { devSession: true, permissions: [] });
  await open(page);
  const token = await page.evaluate(() => window.TRConsole.auth.getAccessToken());
  const r = await call(page, 'admin-dashboard');
  expect(r.json).not.toContain(token);
  expect(JSON.parse(r.json)).toEqual({ name: 'ConsoleError', kind: 'forbidden', status: 403, code: 'not_authorized',
                                       field: null, parameter: null, message: '' });
});

/* ------------------------------------------------------------ UI pieces */

test('loading, empty and error states render text, never markup', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(() => {
    const ui = window.TRConsole.ui;
    const box = ui.el('div', { id: 'probe' });
    document.getElementById('main').appendChild(box);
    const seen = {};
    ui.states.loading(box);
    seen.loading = [box.getAttribute('data-state'), box.getAttribute('aria-busy')];
    ui.states.empty(box, 'No orders', 'Nothing matches.');
    seen.empty = [box.getAttribute('data-state'), box.getAttribute('aria-busy'), box.textContent];
    let retried = 0;
    const evil = '<img src=x onerror="window.__pwned=1">';
    ui.states.error(box, { kind: 'rejected', message: evil, field: null }, () => { retried += 1; });
    box.querySelector('button').click();
    seen.error = [box.getAttribute('data-state'), box.getAttribute('data-error-kind'), box.textContent.includes(evil),
                  box.querySelectorAll('img').length, retried];
    ui.states.error(box, { kind: 'forbidden' }, () => {});
    seen.forbidden = [box.textContent.includes('Not available to you'), box.querySelectorAll('button').length];
    ui.states.error(box, { kind: 'invalid', parameter: 'status' });
    seen.invalid = box.textContent.includes('Refused: status');
    const refused = [];
    for (const k of ['innerHTML', 'onclick', 'style', 'srcdoc']) {
      try { ui.el('div', { [k]: 'x' }); refused.push(false); } catch (e) { refused.push(true); }
    }
    seen.refused = refused;
    return seen;
  });
  expect(out.loading).toEqual(['loading', 'true']);
  expect(out.empty).toEqual(['empty', null, 'No ordersNothing matches.']);
  expect(out.error).toEqual(['error', 'rejected', true, 0, 1]);
  expect(out.forbidden).toEqual([true, 0]);
  expect(out.invalid).toBe(true);
  expect(out.refused).toEqual([true, true, true, true]);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('confirmation: modal, focus starts on Cancel, Escape cancels and focus returns', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const b = window.TRConsole.ui.el('button', { id: 'opener', type: 'button', text: 'Delete' });
    document.getElementById('main').appendChild(b);
    b.focus();
    window.__answer = window.TRConsole.ui.confirm({ title: 'Delete this?', body: 'It can be restored.', confirmLabel: 'Delete', danger: true });
  });
  await expect(page.locator('#console-confirm')).toBeVisible();
  await expect(page.locator('#console-confirm-title')).toHaveText('Delete this?');
  await expect(page.locator('#console-confirm-cancel')).toBeFocused();
  // Focus stays inside the modal, both ways round.
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => document.getElementById('console-confirm').contains(document.activeElement)), key).toBe(true);
  }
  // A second confirmation while one is open is refused.
  expect(await page.evaluate(() => window.TRConsole.ui.confirm({}).then(() => 'opened', () => 'refused'))).toBe('refused');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__answer)).toEqual({ confirmed: false });
  await expect(page.locator('#console-confirm')).toBeHidden();
  await expect(page.locator('#opener')).toBeFocused();
});

test('confirmation with a reason: Confirm waits for one, and returns it trimmed', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.__answer = window.TRConsole.ui.confirm({ title: 'Release allocation', reason: { label: 'Why?', max: 100 } });
  });
  await expect(page.locator('#console-confirm-reason')).toBeFocused();
  await expect(page.locator('label[for="console-confirm-reason"]')).toHaveText('Why?');
  await expect(page.locator('#console-confirm-ok')).toBeDisabled();
  await page.keyboard.type('   ');
  await expect(page.locator('#console-confirm-ok')).toBeDisabled();
  await page.keyboard.type('picked the wrong lot  ');
  await expect(page.locator('#console-confirm-ok')).toBeEnabled();
  await page.locator('#console-confirm-ok').click();
  expect(await page.evaluate(() => window.__answer)).toEqual({ confirmed: true, reason: 'picked the wrong lot' });
  await expect(page.locator('#console-confirm')).toBeHidden();
});

test('toast: announced politely, as text, and cleared', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.TRConsole.ui.toast('<b>Saved</b>', 300));
  const toast = page.locator('#console-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveText('<b>Saved</b>');
  expect(await toast.locator('b').count()).toBe(0);
  await expect(toast).toBeHidden({ timeout: 2000 });
});

/* --------------------------------------------------------- dev server */

test('the offline server serves only the console and its assets', async ({ request }) => {
  for (const p of ['/netlify.toml', '/tests/helpers/admin-fixtures.js', '/netlify/lib/admin-auth.js', '/index.html',
                   '/console/../netlify.toml', '/assets/../netlify.toml', '/.netlify/functions/stripe-webhook',
                   '/.netlify/functions/create-checkout-session']) {
    expect((await request.get(p)).status(), p).toBe(404);
  }
  expect((await request.get('/assets/css/console.css')).status()).toBe(200);
});
