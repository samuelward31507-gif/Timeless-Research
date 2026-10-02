/*
 * Optional add-ons, server side: netlify/lib/addons.js and the
 * addon-availability function.
 *
 *   node --test tests/addons.test.js
 *
 * Node 18+ and Python 3, no packages, no network. The add-on table is built
 * from tests/fixtures/addons.json by the same Python that tools/build.py uses,
 * so these tests exercise the real eligibility rules rather than a copy.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB = require(path.join(ROOT, 'netlify/lib/addons.js'));
const FIXTURE = path.join(__dirname, 'fixtures/addons.json');

function buildTable(fixture, ready) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
import addons
data = json.load(open(${JSON.stringify(path.join(ROOT, 'assets/data/products.json'))}))
cfg = addons.load(${JSON.stringify(fixture)})
errs = addons.validate(cfg, data["products"], data["categories"], ready=True)
assert not errs, errs
server, _ = addons.tables(cfg, data["products"], data.get("currency", "USD"), ready=${ready ? 'True' : 'False'})
print(json.dumps(server))
`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
}

const TABLE = buildTable(FIXTURE, true);
const NOT_READY = buildTable(FIXTURE, false);
const STOCK = { 'insulated-shipper': 5, 'moisture-barrier-pouch': 20 };

const line = (id, size, qty, addons, name) => ({ id, size, qty, addons, name: name || id });

/* ------------------------------------------------------------ eligibility */

test('eligibility comes from the rules: product, category and all-buyable', () => {
  const ids = (pid) => LIB.offeredFor(TABLE, pid).map((o) => o.addon).sort();
  // tirzepatide is in "metabolic": insulated shipper by category, COA copy by allBuyable
  assert.deepEqual(ids('tirzepatide'), ['coa-certified-copy', 'insulated-shipper']);
  // bpc-157: pouch by product rule, COA copy by allBuyable; not in a cold-chain category
  assert.deepEqual(ids('bpc-157'), ['coa-certified-copy', 'moisture-barrier-pouch']);
  // a product no rule names except allBuyable
  assert.deepEqual(ids('semax'), ['coa-certified-copy']);
});

test('a disabled add-on is never offered, even where a rule names it', () => {
  assert.equal(TABLE.addons['tamper-evident-seal'], undefined);
  assert.ok(!LIB.offeredFor(TABLE, 'bpc-157').some((o) => o.addon === 'tamper-evident-seal'));
});

test('an add-on offered by two rules is credited to the first, once', () => {
  const coa = LIB.offeredFor(TABLE, 'bpc-157').filter((o) => o.addon === 'coa-certified-copy');
  assert.equal(coa.length, 1);
  assert.equal(coa[0].rule, 'coa-copy-everything');
});

test('the shipped addons.json offers nothing: every example is disabled', () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'netlify/functions/addons.json'), 'utf8'));
  assert.deepEqual(real.addons, {});
  assert.deepEqual(real.eligibility, {});
  assert.equal(real.paymentIntegrationReady, false);
});

/* ---------------------------------------------------------------- pricing */

test('prices each add-on from the table, as its own line', () => {
  const r = LIB.priceAddons(TABLE, [
    line('tirzepatide', '100 mg', 1, ['insulated-shipper', 'coa-certified-copy'], 'Tirzepatide')
  ], STOCK);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lines.length, 2);
  const ship = r.lines.find((l) => l.addonId === 'insulated-shipper');
  assert.deepEqual(
    { kind: ship.kind, unitCents: ship.unitCents, quantity: ship.quantity, amountCents: ship.amountCents,
      ruleId: ship.ruleId, parentId: ship.parentId, parentSize: ship.parentSize, addonKind: ship.addonKind },
    { kind: 'addon', unitCents: 1200, quantity: 1, amountCents: 1200,
      ruleId: 'cold-chain-metabolic-growth', parentId: 'tirzepatide', parentSize: '100 mg', addonKind: 'shipping' });
  assert.equal(ship.label, 'Insulated shipper with cold packs (for Tirzepatide, 100 mg)');
  const coa = r.lines.find((l) => l.addonId === 'coa-certified-copy');
  assert.equal(coa.unitCents, 450, 'a fractional price is converted to exact cents');
  assert.equal(r.totalCents, 1650);
});

test('per-unit add-ons follow the line quantity; per-line add-ons are one', () => {
  const r = LIB.priceAddons(TABLE, [line('bpc-157', '10 mg', 12, ['moisture-barrier-pouch', 'coa-certified-copy'])], STOCK);
  assert.equal(r.ok, true, r.error);
  const pouch = r.lines.find((l) => l.addonId === 'moisture-barrier-pouch');
  assert.equal(pouch.quantity, 12);
  assert.equal(pouch.amountCents, 1500);
  assert.equal(r.lines.find((l) => l.addonId === 'coa-certified-copy').quantity, 1);
});

test('volume tiers never apply to add-ons, whatever the line quantity', () => {
  // 25 units would put the product line in the 15% tier; the pouch stays full price.
  const r = LIB.priceAddons(TABLE, [line('bpc-157', '10 mg', 25, ['moisture-barrier-pouch'])], { 'moisture-barrier-pouch': 100 });
  assert.equal(r.lines[0].unitCents, 125);
  assert.equal(r.lines[0].amountCents, 125 * 25);
});

test('nothing selected is a valid empty result', () => {
  const r = LIB.priceAddons(TABLE, [line('bpc-157', '10 mg', 1), line('semax', '10 mg', 1, [])], null);
  assert.deepEqual(r, { ok: true, lines: [], totalCents: 0 });
});

test('the server decides the rule; the browser cannot claim one', () => {
  const r = LIB.priceAddons(TABLE, [{ id: 'bpc-157', size: '10 mg', qty: 1, addons: ['coa-certified-copy'], rule: 'made-up' }], STOCK);
  assert.equal(r.lines[0].ruleId, 'coa-copy-everything');
});

/* -------------------------------------------------------------- refusals */

test('refuses add-ons outright until the payment integration is ready', () => {
  const r = LIB.priceAddons(NOT_READY, [line('bpc-157', '10 mg', 1, ['coa-certified-copy'])], STOCK);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_ready');
  // ...but a cart with no add-ons is unaffected
  assert.equal(LIB.priceAddons(NOT_READY, [line('bpc-157', '10 mg', 1)], STOCK).ok, true);
});

test('refuses unknown, disabled, ineligible, duplicated and malformed selections', () => {
  const cases = [
    [[line('bpc-157', '10 mg', 1, ['no-such-addon'])], 'unknown_addon'],
    [[line('bpc-157', '10 mg', 1, ['tamper-evident-seal'])], 'unknown_addon'],
    [[line('semax', '10 mg', 1, ['insulated-shipper'])], 'not_eligible'],
    [[line('bpc-157', '10 mg', 1, ['coa-certified-copy', 'coa-certified-copy'])], 'duplicate'],
    [[line('bpc-157', '10 mg', 1, 'coa-certified-copy')], 'bad_request'],
    [[line('bpc-157', '10 mg', 1, [42])], 'bad_request'],
    [[line('bpc-157', '10 mg', 1, Array(LIB.MAX_ADDONS_PER_LINE + 1).fill('coa-certified-copy'))], 'bad_request'],
    [[line('__proto__', '10 mg', 1, ['coa-certified-copy'])], 'not_eligible']
  ];
  for (const [lines, code] of cases) {
    const r = LIB.priceAddons(TABLE, lines, STOCK);
    assert.equal(r.ok, false, JSON.stringify(lines));
    assert.equal(r.code, code, JSON.stringify(lines));
    assert.equal(typeof r.error, 'string');
  }
});

test('stock: refuses what is not there, counting demand across lines', () => {
  let r = LIB.priceAddons(TABLE, [line('bpc-157', '10 mg', 21, ['moisture-barrier-pouch'])], STOCK);
  assert.equal(r.code, 'out_of_stock');
  assert.match(r.error, /Only 20/);
  r = LIB.priceAddons(TABLE, [
    line('bpc-157', '10 mg', 15, ['moisture-barrier-pouch']),
    line('tb-500', '10 mg', 6, ['moisture-barrier-pouch'])
  ], STOCK);
  assert.equal(r.code, 'out_of_stock', 'two lines that each fit but together do not');
  r = LIB.priceAddons(TABLE, [line('tirzepatide', '100 mg', 1, ['insulated-shipper'])], { 'insulated-shipper': 0 });
  assert.equal(r.code, 'out_of_stock');
  assert.match(r.error, /out of stock/);
});

test('stock: a tracked add-on is refused when stock cannot be read (fails closed)', () => {
  for (const stock of [null, {}, { 'insulated-shipper': 'lots' }]) {
    const r = LIB.priceAddons(TABLE, [line('tirzepatide', '100 mg', 1, ['insulated-shipper'])], stock);
    assert.equal(r.code, 'stock_unknown', JSON.stringify(stock));
  }
});

test('stock: an untracked add-on needs no stock figure', () => {
  const r = LIB.priceAddons(TABLE, [line('semax', '10 mg', 1, ['coa-certified-copy'])], null);
  assert.equal(r.ok, true);
});

/* ------------------------------------------------------------ order rows */

test('order rows: add-ons are their own lines, products carry what they were offered', () => {
  const priced = LIB.priceAddons(TABLE, [line('tirzepatide', '100 mg', 2, ['insulated-shipper'], 'Tirzepatide')], STOCK);
  const rows = LIB.orderItemRows(TABLE, 'order-1',
    [{ id: 'tirzepatide', size: '100 mg', qty: 2, name: 'Tirzepatide', unitCents: 18000, amountCents: 36000 }],
    priced.lines);
  assert.equal(rows.length, 2);
  const [prod, add] = rows;
  assert.equal(prod.kind, 'product');
  assert.equal(prod.amount_total, 36000, 'the product line is untouched by its add-on');
  assert.deepEqual(prod.offered_addons.map((o) => o.addon).sort(), ['coa-certified-copy', 'insulated-shipper']);
  assert.deepEqual(
    { kind: add.kind, addon_id: add.addon_id, rule_id: add.rule_id, parent_sku: add.parent_sku,
      parent_pack_size: add.parent_pack_size, quantity: add.quantity, unit_amount: add.unit_amount, amount_total: add.amount_total },
    { kind: 'addon', addon_id: 'insulated-shipper', rule_id: 'cold-chain-metabolic-growth', parent_sku: 'tirzepatide',
      parent_pack_size: '100 mg', quantity: 1, unit_amount: 1200, amount_total: 1200 });
});

/* --------------------------------------------------- availability helper */

test('availability: booleans for tracked add-ons only, closed when unknown', () => {
  assert.deepEqual(LIB.availability(TABLE, { 'insulated-shipper': 3, 'moisture-barrier-pouch': 0 }),
                   { 'insulated-shipper': true, 'moisture-barrier-pouch': false });
  assert.deepEqual(LIB.availability(TABLE, null),
                   { 'insulated-shipper': false, 'moisture-barrier-pouch': false });
  assert.deepEqual(LIB.availability(TABLE, { 'insulated-shipper': -2 }),
                   { 'insulated-shipper': false, 'moisture-barrier-pouch': false });
});

/* ------------------------------------------------ addon-availability fn */

function loadFunction(table) {
  const fnPath = path.join(ROOT, 'netlify/functions/addon-availability.js');
  const tablePath = path.join(ROOT, 'netlify/functions/addons.json');
  delete require.cache[fnPath];
  require.cache[tablePath] = { id: tablePath, filename: tablePath, loaded: true, exports: table };
  const fn = require(fnPath);
  delete require.cache[tablePath];
  return fn;
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test('availability function: GET only', async () => {
  const fn = loadFunction(TABLE);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await fn.handler({ httpMethod: m })).statusCode, 405);
});

test('availability function: reads stock levels and returns booleans, never counts', async () => {
  const fn = loadFunction(TABLE);
  let asked = null;
  fn._internals.store.levels = async (ids) => {
    asked = ids;
    return [{ addon_id: 'insulated-shipper', available: 7 }, { addon_id: 'moisture-barrier-pouch', available: 0 }];
  };
  const res = await fn.handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { available: { 'insulated-shipper': true, 'moisture-barrier-pouch': false } });
  assert.ok(!/7/.test(res.body), 'a stock count leaked');
  assert.match(res.headers['Cache-Control'], /max-age=60/);
  assert.deepEqual(asked, ['insulated-shipper', 'moisture-barrier-pouch'], 'only tracked add-ons are asked for');
});

test('availability function: fails closed without a database or on a database error', async () => {
  const db = require(path.join(ROOT, 'netlify/lib/db.js'));
  const password = 'test-db-password-not-real';
  const orig = global.fetch;
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  global.fetch = async () => { throw new Error('the database must not be reached'); };
  try {
    // The real store, with no usable DATABASE_URL: refused before any request.
    for (const value of [undefined, `postgresql://neondb_owner:${password}@ep-test.example.invalid/neondb`]) {
      const fn = loadFunction(TABLE);
      await withEnv({ DATABASE_URL: value }, async () => {
        const res = await fn.handler({ httpMethod: 'GET' });
        assert.deepEqual(JSON.parse(res.body).available, { 'insulated-shipper': false, 'moisture-barrier-pouch': false });
        assert.equal(res.headers['Cache-Control'], 'no-store');
      });
    }
    const fn = loadFunction(TABLE);
    fn._internals.store.levels = async () => { throw new db.DbError('connection', { reason: 'unreachable' }); };
    const res = await fn.handler({ httpMethod: 'GET' });
    assert.deepEqual(JSON.parse(res.body).available, { 'insulated-shipper': false, 'moisture-barrier-pouch': false });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.ok(errors.length >= 3);
    assert.ok(errors.every((e) => !e.includes(password) && !/postgres(ql)?:\/\//.test(e)), 'a credential was logged');
  } finally { global.fetch = orig; console.error = origErr; }
});

test('availability function: with nothing tracked, answers without touching the database', async () => {
  const fn = loadFunction({ addons: { 'coa-certified-copy': { trackInventory: false } }, eligibility: {} });
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('should not be called'); };
  try {
    const res = await fn.handler({ httpMethod: 'GET' });
    assert.deepEqual(JSON.parse(res.body), { available: {} });
  } finally { global.fetch = orig; }
});
