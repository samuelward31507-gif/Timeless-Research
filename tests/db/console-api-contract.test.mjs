/*
 * The console read API against the real schema: every table, view and
 * column the admin-* functions read, filter or sort on exists after
 * migrations 0001-0004, the service role (which the API uses) can read it,
 * and the browser roles cannot.
 *
 * The list is not written out by hand. Each endpoint is driven, offline, in
 * every mode and with every filter, through tests/helpers/admin-fixtures.js;
 * the PostgREST URLs it builds are recorded, and every name in them is then
 * checked here in PostgreSQL 16 (PGlite). A column renamed in a migration, or
 * one the API starts reading, fails this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, rows } from './harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = require(path.join(ROOT, 'tests', 'helpers', 'admin-fixtures.js'));
const api = require(path.join(ROOT, 'netlify', 'lib', 'admin-api.js'));
const fn = (name) => require(path.join(ROOT, 'netlify', 'functions', `${name}.js`)).handler;

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TS = api.encodeCursor(['2026-10-01T00:00:00+00:00', ID]);

/* Every mode of every endpoint, with every filter it accepts. */
const REQUESTS = [
  ['admin-dashboard', {}],
  ['admin-orders', { status: 'paid', attention: '1', q: 'smith', cursor: TS }],
  ['admin-orders', { id: ID }],
  ['admin-inventory', { active: 'true', low: '1' }],
  ['admin-inventory', { product_id: 'bpc-157', pack_size: '10 mg' }],
  ['admin-inventory', { lot_id: ID, cursor: api.encodeCursor([5]) }],
  ['admin-expenses', { from: '2026-01-01', to: '2026-02-01', category: 'other', cursor: api.encodeCursor(['2026-01-01', ID]) }],
  ['admin-expenses', { id: ID }],
  ['admin-expenses', { view: 'import', status: 'error', cursor: api.encodeCursor([5]) }],
  ['admin-financials', { from_month: '2026-01', to_month: '2026-12' }],
  ['admin-audit', { entity_type: 'order', entity_id: ID, action: 'order.set_status', cursor: api.encodeCursor([5]) }],
  ['admin-customers', { cursor: api.encodeCursor([10]) }],
  ['admin-customers', { email: 'a@example.org' }]
];

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'or', 'and']);

/* table -> set of column names the API uses (selected, filtered or sorted). */
async function recordReads() {
  const used = new Map();
  const add = (table, col) => {
    if (!used.has(table)) used.set(table, new Set());
    used.get(table).add(col);
  };
  for (const [name, query] of REQUESTS) {
    fx.reset();
    // Each single-record mode finds its record, so every read in it happens.
    fx.state.tables = { orders: [{ id: ID }], inventory_items: [{}], lots: [{ id: ID }], expenses: [{ id: ID }],
                        customer_aggregates: [{ customer_email: 'a@example.org' }] };
    const res = await fx.request(fn(name), query);
    assert.equal(res.statusCode, 200, `${name} ${JSON.stringify(query)}: ${res.body}`);
    for (const r of fx.reads()) {
      for (const [k, value] of r.params) {
        if (k === 'select') value.split(',').forEach((c) => add(r.table, c));
        else if (k === 'order') value.split(',').forEach((c) => add(r.table, c.replace(/\.(asc|desc)$/, '')));
        else if (k === 'or' || k === 'and') {
          for (const m of value.matchAll(/([a-z_]+)\.(eq|lt|gt|lte|gte|ilike|is)\./g)) add(r.table, m[1]);
        } else if (!RESERVED.has(k)) add(r.table, k);
      }
    }
  }
  return used;
}

let used;
let db;

test('the API reads exactly these tables and views', async () => {
  used = await recordReads();
  assert.deepEqual([...used.keys()].sort(), [
    'addon_attach_rate', 'addon_revenue', 'admin_audit_log', 'customer_aggregates', 'customer_summary',
    'dashboard_status_counts', 'dashboard_summary', 'expense_categories', 'expense_import', 'expenses',
    'inventory_items', 'inventory_levels', 'inventory_velocity', 'lot_levels', 'lots', 'monthly_expenses',
    'monthly_financial_summary', 'monthly_gross_margin', 'order_cogs', 'order_items', 'order_line_lots',
    'order_line_mappings', 'order_notes', 'order_queue', 'order_status_history', 'orders', 'stock_movements']);
});

test('every column the API names exists in the migrated schema', async () => {
  db ??= await freshDb();
  for (const [table, cols] of used) {
    const present = new Set((await rows(db,
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table]))
      .map((r) => r.column_name));
    assert.ok(present.size > 0, `${table} does not exist`);
    for (const c of cols) assert.ok(present.has(c), `${table}.${c} does not exist`);
  }
});

test('the service role can run every read the API makes', async () => {
  db ??= await freshDb();
  for (const [table, cols] of used) {
    await db.exec('set role service_role');
    try {
      await db.query(`select ${[...cols].map((c) => `"${c}"`).join(', ')} from public."${table}" limit 1`);
    } finally {
      await db.exec('reset role');
    }
  }
});

/* Two protections are in use, both by design of the migrations: views and the
   0004 tables are revoked from the browser roles outright; the 0001-0003
   tables keep Supabase's default grant but have row level security on with
   no policy, so a browser role sees no rows at all. Each object the API reads
   must have one or the other. */
test('the browser roles can read nothing the API reads', async () => {
  db ??= await freshDb();
  await db.exec(`insert into public.orders (stripe_session_id, email, amount_total, currency)
                 values ('cs_contract', 'a@example.org', 100, 'USD')`);
  for (const table of used.keys()) {
    const [meta] = await rows(db, `
      select c.relkind, c.relrowsecurity,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1`, [table]);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      let err = null;
      let count = null;
      try {
        count = (await rows(db, `select count(*)::int n from public."${table}"`))[0].n;
      } catch (e) {
        err = e.message;
      } finally {
        await db.exec('reset role');
      }
      if (err) {
        assert.match(err, /permission denied/, `${role} ${table}`);
      } else {
        assert.equal(meta.relkind, 'r', `${role} can read the view ${table}`);
        assert.equal(meta.relrowsecurity, true, `${role} can read ${table}, which has no row level security`);
        assert.equal(meta.policies, 0, `${table} has a policy`);
        assert.equal(count, 0, `${role} sees rows in ${table}`);
      }
    }
  }
});

test('staff_can, the read check the API calls, is callable by the service role only and answers per permission', async () => {
  db ??= await freshDb();
  const [{ id: owner }] = await rows(db,
    `insert into public.staff_members (email, role_code) values ('owner@example.org', 'owner') returning id`);
  const [{ id: former }] = await rows(db,
    `insert into public.staff_members (email, role_code, active) values ('former@example.org', 'owner', false) returning id`);
  await db.exec('set role service_role');
  try {
    for (const perm of ['orders.read', 'inventory.read', 'finance.read', 'customers.read', 'audit.read']) {
      assert.equal((await rows(db, 'select public.staff_can($1, $2) ok', [owner, perm]))[0].ok, true, perm);
      assert.equal((await rows(db, 'select public.staff_can($1, $2) ok', [former, perm]))[0].ok, false, perm);
    }
    assert.equal((await rows(db, 'select public.staff_can($1, $2) ok', [owner, 'no.such'])) [0].ok, false);
    assert.equal((await rows(db, 'select public.staff_can(gen_random_uuid(), $1) ok', ['orders.read']))[0].ok, false);
  } finally {
    await db.exec('reset role');
  }
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    let err = null;
    try {
      await db.query('select public.staff_can($1, $2)', [owner, 'orders.read']);
    } catch (e) {
      err = e.message;
    } finally {
      await db.exec('reset role');
    }
    assert.match(err || 'callable', /permission denied/);
  }
});

test('the dashboard reads every status the order lifecycle allows', async () => {
  db ??= await freshDb();
  const statuses = (await rows(db, 'select status from public.dashboard_status_counts order by status')).map((r) => r.status);
  assert.deepEqual(statuses.sort(), ['cancelled', 'completed', 'delivered', 'packed', 'paid', 'processing', 'refunded', 'shipped']);
});
