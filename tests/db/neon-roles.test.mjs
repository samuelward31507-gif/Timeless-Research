/*
 * The Neon role model (db/neon/00_roles.sql, migrations 0001-0006,
 * db/neon/99_access.sql), proven in PostgreSQL 16 (PGlite) with no default
 * privileges, exactly as a Neon branch holds it.
 *
 *   peptide_owner     owns everything, logs in as nothing
 *   peptide_app       the runtime: reads all, writes only the payment path,
 *                     runs only the audited functions; owns nothing
 *   peptide_readonly  reads all, writes nothing, runs nothing
 *   anon, authenticated   nothing at all
 *
 * The same expectations are checked against the real Neon staging branch
 * through tests/db/schema-snapshot.mjs (equal digests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rows, one, recordPaidOrder, errorOf } from './harness.mjs';

const asRole = async (db, role, fn) => {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};

const APP_FUNCTIONS = [
  'admin_add_order_note', 'admin_allocate_order_line', 'admin_create_expense', 'admin_delete_expense',
  'admin_import_expenses', 'admin_map_order_line', 'admin_record_stock_movement', 'admin_release_allocation',
  'admin_restore_expense', 'admin_set_order_status', 'admin_stage_expense_import', 'admin_unmap_order_line',
  'admin_update_expense', 'admin_update_inventory_item', 'admin_update_lot', 'claim_order_notifications',
  'complete_order_notification', 'receive_lot', 'record_addon_sales', 'release_addon_sales', 'ship_order',
  'staff_can', 'sync_inventory_items'
];

let db;
async function neon() {
  db ??= await freshDb({ platform: 'neon' });
  return db;
}

const executable = async (d, role) => (await rows(d, `
  select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
     and pg_get_userbyid(p.proowner) = 'peptide_owner' and has_function_privilege($1, p.oid, 'EXECUTE')
   order by 1`, [role])).map((r) => r.proname);

const writable = async (d, role) => (await rows(d, `
  select c.relname || '=' || concat_ws(',',
           case when has_table_privilege($1, c.oid, 'INSERT') then 'insert' end,
           case when has_table_privilege($1, c.oid, 'UPDATE') then 'update' end,
           case when has_table_privilege($1, c.oid, 'DELETE') then 'delete' end,
           case when has_table_privilege($1, c.oid, 'TRUNCATE') then 'truncate' end,
           case when has_table_privilege($1, c.oid, 'REFERENCES') then 'references' end,
           case when has_table_privilege($1, c.oid, 'TRIGGER') then 'trigger' end) as p
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
     and (has_table_privilege($1, c.oid, 'INSERT') or has_table_privilege($1, c.oid, 'UPDATE')
       or has_table_privilege($1, c.oid, 'DELETE') or has_table_privilege($1, c.oid, 'TRUNCATE')
       or has_table_privilege($1, c.oid, 'REFERENCES') or has_table_privilege($1, c.oid, 'TRIGGER'))
   order by 1`, [role])).map((r) => r.p);

const readable = async (d, role) => one(d, `
  select count(*)::int as total, count(*) filter (where has_table_privilege($1, c.oid, 'SELECT'))::int as readable
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')`, [role]);

/* ------------------------------------------------------------- ownership */

test('peptide_owner owns every table, view and function; every SECURITY DEFINER function pins its search_path', async () => {
  const d = await neon();
  const others = await rows(d, `
    select c.relname, pg_get_userbyid(c.relowner) as owner from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p','S') and pg_get_userbyid(c.relowner) <> 'peptide_owner'
    union all
    select p.proname, pg_get_userbyid(p.proowner) from pg_proc p
     where p.pronamespace = 'public'::regnamespace and pg_get_userbyid(p.proowner) <> 'peptide_owner'`);
  assert.deepEqual(others, []);
  const definers = await rows(d, `select proname, proconfig from pg_proc where pronamespace = 'public'::regnamespace and prosecdef`);
  assert.ok(definers.length >= 25, `only ${definers.length} SECURITY DEFINER functions`);
  for (const f of definers) assert.ok((f.proconfig || []).some((c) => c.startsWith('search_path=')), `${f.proname} has no search_path`);
});

test('the roles are what the design says', async () => {
  const d = await neon();
  const r = Object.fromEntries((await rows(d, `
    select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb
      from pg_roles where rolname in ('peptide_owner','peptide_app','peptide_readonly','service_role','anon','authenticated')`))
    .map((x) => [x.rolname, x]));
  assert.equal(r.peptide_owner.rolcanlogin, false, 'nothing logs in as the owner');
  assert.equal(r.peptide_app.rolcanlogin, true);
  assert.equal(r.peptide_app.rolbypassrls, true);
  assert.equal(r.peptide_readonly.rolbypassrls, true);
  for (const name of ['service_role', 'anon', 'authenticated']) assert.equal(r[name].rolcanlogin, false, name);
  for (const x of Object.values(r)) {
    assert.equal(x.rolsuper, false, x.rolname);
    assert.equal(x.rolcreaterole, false, x.rolname);
    assert.equal(x.rolcreatedb, false, x.rolname);
  }
  const member = async (who) => (await rows(d, `
    select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
     where u.rolname = $1 order by 1`, [who])).map((x) => x.rolname);
  assert.deepEqual(await member('peptide_app'), ['service_role']);
  assert.deepEqual(await member('peptide_readonly'), []);
  assert.deepEqual(await member('anon'), []);
  const setting = await rows(d, `
    select unnest(s.setconfig) as c from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'peptide_readonly'`);
  assert.deepEqual(setting.map((x) => x.c), ['default_transaction_read_only=on']);
});

/* ------------------------------------------------------------ privileges */

test('peptide_app: reads everything, writes only the payment path, runs only the audited functions', async () => {
  const d = await neon();
  const r = await readable(d, 'peptide_app');
  assert.equal(r.readable, r.total);
  assert.deepEqual(await writable(d, 'peptide_app'),
    ['addon_stock_movements=insert', 'order_items=insert,delete', 'orders=insert,update']);
  assert.deepEqual(await executable(d, 'peptide_app'), APP_FUNCTIONS);
  for (const priv of ['CREATE']) {
    assert.equal((await one(d, `select has_schema_privilege('peptide_app', 'public', $1) as ok`, [priv])).ok, false);
  }
});

test('peptide_readonly: reads everything, writes nothing, runs nothing', async () => {
  const d = await neon();
  const r = await readable(d, 'peptide_readonly');
  assert.equal(r.readable, r.total);
  assert.deepEqual(await writable(d, 'peptide_readonly'), []);
  assert.deepEqual(await executable(d, 'peptide_readonly'), []);
  assert.equal((await one(d, `select has_schema_privilege('peptide_readonly', 'public', 'CREATE') as ok`)).ok, false);
});

test('anon and authenticated: nothing at all', async () => {
  const d = await neon();
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await readable(d, role)).readable, 0, role);
    assert.deepEqual(await writable(d, role), [], role);
    assert.deepEqual(await executable(d, role), [], role);
  }
});

/* ------------------------------------------------------ as peptide_app */

test('as peptide_app: the webhook path records one order per session and queues its two notifications', async () => {
  const d = await neon();
  const { id } = await asRole(d, 'peptide_app', () => recordPaidOrder(d, 'cs_test_neon_app'));
  await asRole(d, 'peptide_app', async () => {
    await recordPaidOrder(d, 'cs_test_neon_app');
    await d.query(`insert into public.order_items (order_id, description, quantity, unit_amount, amount_total) values ($1, 'X', 1, 100, 100)`, [id]);
    await d.query('delete from public.order_items where order_id = $1', [id]);
    await d.query(`insert into public.order_items (order_id, description, quantity, unit_amount, amount_total) values ($1, 'X', 1, 100, 100)`, [id]);
    const counts = await one(d, `select (select count(*)::int from public.orders where stripe_session_id = 'cs_test_neon_app') as orders,
                                        (select count(*)::int from public.order_notifications where order_id = $1) as notes`, [id]);
    assert.deepEqual(counts, { orders: 1, notes: 2 });
    assert.ok((await rows(d, 'select status, orders from public.dashboard_status_counts')).length > 0, 'views read past row level security');
  });
});

test('as peptide_app: an audited write records the staff member; direct writes, deletes and truncates are refused', async () => {
  const d = await neon();
  const staff = (await one(d, `insert into public.staff_members (email, role_code) values ('neon-owner@example.org', 'owner') returning id`)).id;
  const { id: order } = await asRole(d, 'peptide_app', () => recordPaidOrder(d, 'cs_test_neon_audit'));
  await asRole(d, 'peptide_app', async () => {
    await d.query('select public.admin_add_order_note($1, $2, $3)', [staff, order, 'checked']);
    const audit = await one(d, `select actor_id, action from public.admin_audit_log where entity_id = $1`, [order]);
    assert.deepEqual(audit, { actor_id: staff, action: 'order.add_note' });
    for (const sql of [
      `insert into public.admin_audit_log (actor_id, actor_email, action, entity_type) values ('${staff}', 'x', 'a.b', 'x')`,
      `update public.order_status_history set note = 'x'`,
      `insert into public.order_notes (order_id, body, author_id, author_email) values ('${order}', 'x', '${staff}', 'x')`,
      `insert into public.stock_movements (lot_id, delta, reason, note) values (gen_random_uuid(), 1, 'adjustment', 'x')`,
      `insert into public.order_notifications (order_id, channel) values ('${order}', 'email')`,
      `insert into public.staff_members (email, role_code) values ('x@example.org', 'owner')`,
      `insert into public.expenses (incurred_on, category_code, description, amount_cents) values (current_date, 'other', 'x', 1)`,
      `delete from public.orders where id = '${order}'`,
      'truncate public.order_items',
      `select public.app_require('${staff}', 'orders.write')`,
      `select public.bootstrap_owner('x@example.org', gen_random_uuid())`,
      `select public.set_order_status('${order}', 'processing', 'x', 'forged actor')`,
      'select public.orders_release_addons()',
      'create table public.intruder (id int)'
    ]) {
      assert.match(await errorOf(() => d.query(sql)) || 'allowed', /permission denied/, sql);
    }
  });
});

test('as peptide_readonly: every write is refused', async () => {
  const d = await neon();
  const { id: order } = await recordPaidOrder(d, 'cs_test_neon_ro');
  await asRole(d, 'peptide_readonly', async () => {
    assert.ok((await rows(d, 'select id from public.orders')).length > 0, 'reads past row level security');
    for (const sql of [`insert into public.orders (stripe_session_id, amount_total, currency) values ('cs_test_x', 1, 'USD')`,
                       `update public.orders set notes = 'x' where id = '${order}'`,
                       `delete from public.order_items where order_id = '${order}'`,
                       `select public.claim_order_notifications(1, 60)`,
                       `select public.staff_can(gen_random_uuid(), 'orders.read')`]) {
      assert.match(await errorOf(() => d.query(sql)) || 'allowed', /permission denied/, sql);
    }
  });
});

/* ---------------------------------------------------- protections kept */

test('the protections the application depends on are all present', async () => {
  const d = await neon();
  const claim = await one(d, `select prosrc from pg_proc where proname = 'claim_order_notifications'`);
  assert.match(claim.prosrc, /for update of n skip locked/);
  const triggers = (await rows(d, `
    select tgname from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
     order by 1`)).map((x) => x.tgname);
  for (const t of ['admin_audit_log_append_only', 'order_status_history_append_only', 'order_notes_append_only',
                   'stock_movements_append_only', 'orders_guard_status', 'orders_log_status', 'orders_enqueue_notifications',
                   'staff_keep_an_owner', 'lots_freeze_identity', 'stock_movements_guard']) {
    assert.ok(triggers.includes(t), `missing trigger ${t}`);
  }
  const enqueue = await one(d, `select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'orders_enqueue_notifications'`);
  assert.match(enqueue.def, /AFTER INSERT ON public\.orders FOR EACH ROW WHEN \(\(new\.status = 'paid'::text\)\)/);
  const unique = await one(d, `select pg_get_constraintdef(oid) as def from pg_constraint
                                 where conrelid = 'public.orders'::regclass and contype = 'u'`);
  assert.equal(unique.def, 'UNIQUE (stripe_session_id)');
  const outbox = await one(d, `select pg_get_constraintdef(oid) as def from pg_constraint
                                 where conrelid = 'public.order_notifications'::regclass and contype = 'u'`);
  assert.equal(outbox.def, 'UNIQUE (order_id, channel)');
});
