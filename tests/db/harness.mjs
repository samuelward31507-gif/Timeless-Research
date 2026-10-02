/*
 * Shared setup for the database tests: a real PostgreSQL (PGlite, Postgres 16
 * compiled to WebAssembly, in-process, no server) with the migrations applied
 * the way the target platform would hold them.
 *
 * Two platforms, chosen with DB_PLATFORM:
 *
 *   supabase (default)  Supabase grants its browser roles (anon,
 *     authenticated) and the service role access to new tables, views and
 *     functions by default and relies on row level security to hide rows.
 *     Plain Postgres grants nothing, which would make the access tests pass
 *     for the wrong reason, so the same default privileges are set up first.
 *     service_role is given BYPASSRLS, as on Supabase.
 *
 *   neon  The roles from db/neon/00_roles.sql, no default privileges at all,
 *     every migration applied as peptide_owner (so it owns every object,
 *     SECURITY DEFINER functions included), then db/neon/99_access.sql. Tests
 *     acting as service_role then exercise exactly the privileges peptide_app
 *     has on Neon.
 *
 * Either way, tests acting as service_role exercise the server's real
 * privileges: past row level security, and stopped only by grants.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const NEON = path.join(ROOT, 'db', 'neon');

export const PLATFORM = process.env.DB_PLATFORM === 'neon' ? 'neon' : 'supabase';

export const MIGRATION_FILES = ['0001_orders.sql', '0002_addons.sql', '0003_operations_foundation.sql',
                                '0004_console_foundation.sql', '0005_order_notifications.sql',
                                '0006_runtime_grants.sql'];

export function migrationSql(name) {
  return readFileSync(path.join(MIGRATIONS, name), 'utf8');
}

export function neonSql(name) {
  return readFileSync(path.join(NEON, name), 'utf8');
}

/* Applies one migration as the platform's migration role. */
async function applyMigration(db, name, platform) {
  if (platform === 'neon') {
    await db.exec('set role peptide_owner');
    try { await db.exec(migrationSql(name)); } finally { await db.exec('reset role'); }
  } else {
    await db.exec(migrationSql(name));
  }
}

/* Re-applies every migration from `name` onward, in order: what running the
   migrations again on a live database does. Re-running one old migration on
   its own would put back definitions a later one replaced. */
export async function reapplyFrom(db, name, platform = PLATFORM) {
  for (const f of MIGRATION_FILES.slice(MIGRATION_FILES.indexOf(name))) await applyMigration(db, f, platform);
  if (platform === 'neon') await applyNeonAccess(db);
}

async function applyNeonAccess(db) {
  await db.exec('set role peptide_owner');
  try { await db.exec(neonSql('99_access.sql')); } finally { await db.exec('reset role'); }
}

/* A fresh database with migrations applied up to and including `upTo`
   (a file name). `between` runs after each migration, for tests that need
   data present before a later one is applied. */
export async function freshDb({ upTo = MIGRATION_FILES[MIGRATION_FILES.length - 1], between, platform = PLATFORM } = {}) {
  const db = new PGlite();
  if (platform === 'neon') {
    await db.exec(neonSql('00_roles.sql'));
  } else {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      alter role service_role with bypassrls;
    `);
  }
  for (const name of MIGRATION_FILES) {
    await applyMigration(db, name, platform);
    if (between) await between(db, name);
    if (name === upTo) break;
  }
  if (platform === 'neon' && upTo === MIGRATION_FILES[MIGRATION_FILES.length - 1]) await applyNeonAccess(db);
  return db;
}

export async function rows(db, sql, params) {
  return (await db.query(sql, params)).rows;
}

export async function one(db, sql, params) {
  return (await rows(db, sql, params))[0];
}

/* The exact write netlify/functions/stripe-webhook.js makes on every delivery
   of a payment confirmation: a PostgREST upsert on stripe_session_id with
   Prefer: resolution=merge-duplicates, which PostgREST turns into
   INSERT ... ON CONFLICT (stripe_session_id) DO UPDATE SET <every column sent>
   = EXCLUDED.<column>. The columns are the ones that function sends, status
   'paid' included, so a repeated delivery is reproduced faithfully. */
const WEBHOOK_COLUMNS = ['stripe_session_id', 'stripe_payment_intent', 'email', 'name', 'phone',
  'amount_total', 'amount_subtotal', 'amount_shipping', 'amount_discount', 'currency',
  'shipping_address', 'research_use_confirmed', 'status'];

export async function recordPaidOrder(db, sessionId, over = {}) {
  const o = Object.assign({
    stripe_session_id: sessionId, stripe_payment_intent: 'pi_' + sessionId,
    email: 'buyer@example.org', name: 'A Buyer', phone: null,
    amount_total: 10000, amount_subtotal: 9000, amount_shipping: 1000, amount_discount: 0,
    currency: 'USD', shipping_address: null, research_use_confirmed: true, status: 'paid'
  }, over);
  const cols = WEBHOOK_COLUMNS;
  const sql = `insert into public.orders (${cols.join(', ')})
               values (${cols.map((_, i) => '$' + (i + 1)).join(', ')})
               on conflict (stripe_session_id) do update set
               ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}
               returning id, status`;
  const params = cols.map((c) => (c === 'shipping_address' && o[c] ? JSON.stringify(o[c]) : o[c]));
  return one(db, sql, params);
}

/* An order created directly, for tests that need a particular date. */
export async function insertOrder(db, over = {}) {
  const o = Object.assign({
    stripe_session_id: 'cs_' + Math.random().toString(36).slice(2), email: 'buyer@example.org',
    amount_total: 10000, amount_subtotal: 9000, amount_shipping: 1000, amount_discount: 0,
    currency: 'USD', status: 'paid', created_at: new Date().toISOString()
  }, over);
  return one(db, `insert into public.orders
      (stripe_session_id, email, amount_total, amount_subtotal, amount_shipping, amount_discount, currency, status, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [o.stripe_session_id, o.email, o.amount_total, o.amount_subtotal, o.amount_shipping,
     o.amount_discount, o.currency, o.status, o.created_at]);
}

export async function productLine(db, orderId, sku, packSize, qty, unitCents) {
  await db.query(`insert into public.order_items
      (order_id, kind, sku, pack_size, description, quantity, unit_amount, amount_total)
      values ($1, 'product', $2, $3, $4, $5, $6, $7)`,
    [orderId, sku, packSize, `${sku} ${packSize}`, qty, unitCents, unitCents * qty]);
}

export async function setStatus(db, orderId, status, note, actor) {
  return one(db, `select (public.set_order_status($1, $2, $3, $4)).*`, [orderId, status, note || null, actor || null]);
}

/* Runs fn and returns the error message, or null if it did not throw. */
export async function errorOf(fn) {
  try { await fn(); return null; } catch (e) { return e.message; }
}

export async function asRole(db, role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
