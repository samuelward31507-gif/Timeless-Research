/*
 * netlify/lib/db.js, the functions' database access layer, end to end:
 * db.js -> @neondatabase/serverless -> Neon's SQL-over-HTTP protocol
 * (neon-http.mjs) -> PostgreSQL built on the Neon role model, as peptide_app.
 *
 * Values are compared with what PostgREST returns today, which is
 * PostgreSQL's own to_json() in UTC: the access layer must not change any
 * response the functions send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { createRequire } from 'node:module';
import { neonHttp, TEST_URL, TEST_PASSWORD, urlFor } from './neon-http.mjs';

const require = createRequire(import.meta.url);
const db = require('../../netlify/lib/db.js');
const { DbError } = db;

const fake = await neonHttp();
db._internals.fetch = fake.fetch;

/* Everything printed while the tests run, to prove nothing leaks. */
const printed = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => { printed.push(util.format(...a)); return orig.apply(console, a); };
}

const withUrl = async (url, fn) => {
  const before = process.env.DATABASE_URL;
  if (url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = url;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before;
  }
};

process.env.DATABASE_URL = TEST_URL;

async function failure(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a failure');
}

/* Nothing about the connection may appear anywhere in an error. */
function assertNoSecret(e) {
  for (const text of [e.message, e.stack, String(e), JSON.stringify(e), util.inspect(e, { depth: 5, showHidden: true }),
                      e.dbMessage || '']) {
    assert.ok(!text.includes(TEST_PASSWORD), `password leaked: ${text}`);
    assert.ok(!/postgres(ql)?:\/\//i.test(text), `connection string leaked: ${text}`);
    assert.ok(!text.includes('ep-test-0000'), `host leaked: ${text}`);
  }
}

/* --------------------------------------------------------------- config */

test('1. a missing DATABASE_URL fails closed before any request, as a config error', async () => {
  const sent = fake.requests.length;
  for (const value of [undefined, '', '   ']) {
    const e = await withUrl(value, () => failure(() => db.query('select 1')));
    assert.ok(e instanceof DbError);
    assert.equal(e.kind, 'config');
    assert.equal(e.reason, 'missing_database_url');
  }
  const e = await withUrl('not a url', () => failure(() => db.query('select 1')));
  assert.deepEqual([e.kind, e.reason], ['config', 'malformed_database_url']);
  const t = await withUrl(undefined, () => failure(() => db.transaction((tx) => [tx.query('select 1')])));
  assert.deepEqual([t.kind, t.reason], ['config', 'missing_database_url']);
  assert.equal(fake.requests.length, sent, 'nothing was sent');
});

test('only peptide_app may be the runtime role: owner, read-only and the database owner are refused', async () => {
  const sent = fake.requests.length;
  for (const role of ['peptide_owner', 'peptide_readonly', 'neondb_owner', 'postgres']) {
    const e = await withUrl(urlFor(role), () => failure(() => db.query('select 1')));
    assert.deepEqual([e.kind, e.reason], ['config', 'not_runtime_role'], role);
    assertNoSecret(e);
  }
  assert.equal(fake.requests.length, sent, 'nothing was sent');
});

test('a refused login is a config error and does not carry the credentials', async () => {
  const e = await withUrl(TEST_URL.replace(TEST_PASSWORD, 'wrong-password-123'), () => failure(() => db.query('select 1')));
  assert.deepEqual([e.kind, e.code], ['config', '28P01']);
  assertNoSecret(e);
  assert.ok(!e.message.includes('wrong-password-123'));
});

/* -------------------------------------------------------------- queries */

test('2. a parameterized query returns rows as objects, as peptide_app', async () => {
  const rows = await db.query('select current_user as role, current_database() as d, $1::int + 1 as n', [41]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'peptide_app');
  assert.equal(rows[0].n, 42);
  assert.deepEqual(await db.query('select 1 as a where false'), []);
  assert.equal(await db.scalar('select count(*) from public.orders where stripe_session_id = $1', ['cs_none']), 0);
  assert.deepEqual(await db.one('select $1::text as a, $2::boolean as b', ['x', true]), { a: 'x', b: true });
});

test('3. values are bound as parameters, never spliced into the SQL', async () => {
  const hostile = `x'); delete from public.orders; select ('`;
  const row = await db.one('select $1::text as v, length($1::text) as n', [hostile]);
  assert.deepEqual(row, { v: hostile, n: hostile.length });
  for (const v of ['O\'Brien', '$1', '\\', '"quoted"', '😀', 'line\nbreak', '']) {
    assert.equal(await db.scalar('select $1::text', [v]), v);
  }
  assert.equal(await db.scalar('select $1::text is null', [null]), true);
  assert.deepEqual(await db.scalar('select $1::jsonb', [{ a: [1, 'two'] }]), { a: [1, 'two'] });
  const body = JSON.parse(fake.requests[fake.requests.length - 1].body);
  assert.equal(body.query, 'select $1::jsonb', 'the text sent is the constant SQL');

  for (const [params, reason] of [[[undefined], 'undefined_param'], ['x', 'params_not_array'], [{ a: 1 }, 'params_not_array']]) {
    const e = await failure(() => db.query('select $1', params));
    assert.deepEqual([e.kind, e.reason], ['invalid_input', reason]);
  }
});

test('call(): a public function with named arguments; names are checked, values are parameters', async () => {
  assert.deepEqual(await db.call('staff_can', { p_actor: '00000000-0000-4000-8000-000000000000', p_permission: 'orders.read' }),
                   [{ staff_can: false }]);
  for (const [fn, args, reason] of [['staff_can; drop table x', {}, 'function_name'], ['Staff_Can', {}, 'function_name'],
                                    ['staff_can', { 'p_actor => null); --': 1 }, 'argument_name'],
                                    ['staff_can', [1], 'args_not_object']]) {
    const e = await failure(() => db.call(fn, args));
    assert.deepEqual([e.kind, e.reason], ['invalid_input', reason]);
  }
});

/* --------------------------------------------------------------- errors */

test('4. SQL errors keep their SQLSTATE and kind; the message is fixed and the database sentence stays internal', async () => {
  const cases = [
    ['select 1/0', [], 'invalid_input', '22012'],
    ['select $1::int', ['abc'], 'invalid_input', '22P02'],
    ['select * from public.no_such_table', [], 'database', '42P01'],
    ['selec 1', [], 'database', '42601'],
    ['do $$ begin raise exception \'refused by a function\'; end $$', [], 'application', 'P0001'],
    ['select public.complete_order_notification($1, $2)', [999999, 'sent'], 'not_found', 'P0002'],
    ['select public.complete_order_notification($1, $2)', [1, 'bogus'], 'constraint', '23514']
  ];
  for (const [sql, params, kind, code] of cases) {
    const e = await failure(() => db.query(sql, params));
    assert.ok(e instanceof DbError, sql);
    assert.deepEqual([e.kind, e.code], [kind, code], sql);
    assert.equal(e.message, `database ${kind} (${code})`);
    assert.ok(typeof e.dbMessage === 'string' && e.dbMessage.length > 0);
    assert.ok(!Object.keys(e).includes('dbMessage'), 'dbMessage is not enumerable, so it is not serialized');
    assertNoSecret(e);
  }
  const p = await failure(() => db.query('select public.complete_order_notification($1, $2)', [1, 'bogus']));
  assert.equal(p.dbMessage, 'outcome must be sent, retry or failed', 'a function\'s own sentence is available to the caller');
});

test('not-found and empty results: one() and scalar() refuse no row and more than one', async () => {
  const none = await failure(() => db.one('select 1 where false'));
  assert.deepEqual([none.kind, none.reason, none.code], ['not_found', 'no_row', null]);
  const many = await failure(() => db.one('select generate_series(1, 2) as n'));
  assert.deepEqual([many.kind, many.reason], ['database', 'more_than_one_row']);
  const cols = await failure(() => db.scalar('select 1 as a, 2 as b'));
  assert.deepEqual([cols.kind, cols.reason], ['database', 'not_one_column']);
});

test('12. permission denied is its own kind, for tables, functions and DDL', async () => {
  for (const sql of [
    "insert into public.staff_members (email, role_code) values ('x@example.org', 'owner')",
    'delete from public.orders',
    'truncate public.order_items',
    'update public.order_status_history set note = null',
    "select public.bootstrap_owner('x@example.org', gen_random_uuid())",
    'select public.orders_release_addons()',
    'create table public.intruder (id int)'
  ]) {
    const e = await failure(() => db.query(sql));
    assert.deepEqual([e.kind, e.code], ['permission', '42501'], sql);
  }
});

test('connection failures: unreachable, timed out and HTTP errors are connection errors without detail', async () => {
  for (const [mode, reason] of [['network', 'unreachable'], ['timeout', 'timeout'], ['http500', 'http_500']]) {
    fake.failNext = mode;
    const e = await failure(() => db.query('select 1'));
    assert.deepEqual([e.kind, e.reason, e.code], ['connection', reason, null], mode);
    assertNoSecret(e);
    fake.failNext = mode;
    const t = await failure(() => db.transaction((tx) => [tx.query('select 1')]));
    assert.deepEqual([t.kind, t.reason], ['connection', reason], mode);
  }
});

/* --------------------------------------------------------- transactions */

const upsert = `insert into public.orders (stripe_session_id, stripe_payment_intent, email, name, amount_total,
                  amount_subtotal, amount_shipping, amount_discount, currency, research_use_confirmed, status)
                values ($1, $2, 'buyer@example.org', 'A Buyer', 10000, 9000, 1000, 0, 'USD', true, 'paid')
                on conflict (stripe_session_id) do update set amount_total = excluded.amount_total
                returning id, status`;
const lines = (session) => [
  [`delete from public.order_items where order_id = (select id from public.orders where stripe_session_id = $1)`, [session]],
  [`insert into public.order_items (order_id, description, quantity, unit_amount, amount_total)
      select id, $2, $3, $4, $5 from public.orders where stripe_session_id = $1`, [session, 'BPC-157 5mg', 2, 4500, 9000]]
];

test('5. a transaction commits every statement and returns each one\'s rows in order', async () => {
  const s = 'cs_test_db_commit';
  const results = await db.transaction((tx) => [tx.query(upsert, [s, 'pi_1']), ...lines(s).map(([q, p]) => tx.query(q, p))]);
  assert.equal(results.length, 3);
  assert.equal(results[0][0].status, 'paid');
  assert.deepEqual(results[1], []);
  const id = results[0][0].id;
  const after = await db.one(`select (select count(*) from public.orders where stripe_session_id = $1) as orders,
                                     (select count(*) from public.order_items where order_id = $2) as items,
                                     (select count(*) from public.order_notifications where order_id = $2) as notes`, [s, id]);
  assert.deepEqual(after, { orders: 1, items: 1, notes: 2 });
  const batch = JSON.parse(fake.requests[fake.requests.length - 2].body);
  assert.equal(batch.queries.length, 3, 'sent as one request');
});

test('6. a failing statement rolls back the whole transaction', async () => {
  const s = 'cs_test_db_rollback';
  const e = await failure(() => db.transaction((tx) => [
    tx.query(upsert, [s, 'pi_2']),
    tx.query('insert into public.order_items (order_id, description, quantity, unit_amount, amount_total) values ($1, $2, 1, 1, 1)',
             ['00000000-0000-4000-8000-000000000000', 'refers to nothing'])
  ]));
  assert.deepEqual([e.kind, e.code], ['constraint', '23503']);
  assert.equal(await db.scalar('select count(*) from public.orders where stripe_session_id = $1', [s]), 0, 'the order was rolled back');

  const p = await failure(() => db.transaction((tx) => [tx.query(upsert, [s, 'pi_2']), tx.query('delete from public.orders')]));
  assert.deepEqual([p.kind, p.code], ['permission', '42501']);
  assert.equal(await db.scalar('select count(*) from public.orders where stripe_session_id = $1', [s]), 0);

  const r = await failure(() => db.transaction((tx) => [tx.query(upsert, [s, 'pi_2'])], { readOnly: true }));
  assert.equal(r.code, '25006', 'a read-only transaction refuses writes');
  assert.equal(await db.scalar('select count(*) from public.orders where stripe_session_id = $1', [s]), 0);
  assert.deepEqual(await db.transaction((tx) => [tx.query('select 1 as a')], { readOnly: true, isolationLevel: 'RepeatableRead' }),
                   [[{ a: 1 }]]);
});

test('7. an exception while building a transaction sends nothing and is passed through unchanged', async () => {
  const s = 'cs_test_db_throw';
  const sent = fake.requests.length;
  const boom = new Error('application refused');
  const e = await failure(() => db.transaction(async (tx) => {
    const first = tx.query(upsert, [s, 'pi_3']);
    await first; // a statement is only a description: awaiting it runs nothing
    if (first) throw boom;
    return [first];
  }));
  assert.equal(e, boom);
  assert.equal(fake.requests.length, sent, 'nothing reached the database');
  assert.equal(await db.scalar('select count(*) from public.orders where stripe_session_id = $1', [s]), 0);

  for (const [build, reason] of [[() => [], 'not_statements'], [() => ['select 1'], 'not_statements'],
                                 [() => [db.query('select 1')], 'not_statements'], ['x', 'build_not_function']]) {
    const bad = await failure(() => db.transaction(build));
    assert.deepEqual([bad.kind, bad.reason], ['invalid_input', reason]);
  }
  const iso = await failure(() => db.transaction((tx) => [tx.query('select 1')], { isolationLevel: 'ReadSometimes' }));
  assert.deepEqual([iso.kind, iso.reason], ['invalid_input', 'isolation_level']);
});

test('a connection failure during a transaction leaves nothing behind', async () => {
  const s = 'cs_test_db_conn';
  fake.failNext = 'network';
  const e = await failure(() => db.transaction((tx) => [tx.query(upsert, [s, 'pi_4'])]));
  assert.equal(e.kind, 'connection');
  assert.equal(await db.scalar('select count(*) from public.orders where stripe_session_id = $1', [s]), 0);
});

/* --------------------------------------------------------------- values */

/* What PostgREST returns for an expression: PostgreSQL's to_json in UTC. */
async function postgrest(expr) {
  await fake.db.exec("set timezone = 'UTC'");
  try {
    const r = await fake.db.query(`select to_json(${expr})::text as j`);
    return JSON.parse(r.rows[0].j);
  } finally {
    await fake.db.exec('reset timezone');
  }
}

test('8. bigint is a number, as PostgREST gave it; beyond 2^53 it is refused, not rounded', async () => {
  for (const expr of ['0::bigint', '42::bigint', '-7::bigint', '9007199254740991::bigint', '-9007199254740991::bigint']) {
    const v = await db.scalar(`select ${expr}`);
    assert.equal(typeof v, 'number');
    assert.equal(v, await postgrest(expr), expr);
  }
  assert.equal(typeof await db.scalar('select count(*) from public.orders'), 'number');
  assert.equal(typeof (await db.one('select id from public.order_items limit 1')).id, 'number');
  for (const expr of ['9007199254740992::bigint', '-9007199254740993::bigint', '9223372036854775807::bigint']) {
    const e = await failure(() => db.scalar(`select ${expr}`));
    assert.deepEqual([e.kind, e.reason], ['database', 'unsafe_integer'], expr);
  }
  assert.equal(await db.scalar('select null::bigint'), null);
});

test('9. date stays YYYY-MM-DD, whatever the session time zone', async () => {
  for (const tz of ['GMT', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    fake.timeZone = tz;
    for (const d of ['2024-02-29', '2026-01-01', '1999-12-31']) {
      const v = await db.scalar('select $1::date', [d]);
      assert.equal(v, d);
      assert.equal(v, await postgrest(`'${d}'::date`));
    }
    assert.equal(await db.scalar("select 'infinity'::date"), 'infinity');
  }
  fake.timeZone = 'GMT';
  assert.equal(await db.scalar('select null::date'), null);
});

test('10. timestamptz is PostgREST\'s ISO 8601 in UTC, with the microseconds kept, in any session time zone', async () => {
  const values = ['2026-10-02 07:13:00.123456+00', '2026-10-02 07:13:00+00', '2026-10-02 07:13:00.5+00',
                  '2026-12-31 23:59:59.999999+00', '2024-02-29 00:00:00.000001+00', '2026-03-29 01:30:00+00'];
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/; // admin-api.js cursors
  for (const tz of ['GMT', 'UTC', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Chatham', 'Pacific/Kiritimati']) {
    fake.timeZone = tz;
    for (const t of values) {
      const v = await db.scalar('select $1::timestamptz', [t]);
      assert.equal(v, await postgrest(`'${t}'::timestamptz`), `${t} in ${tz}`);
      assert.match(v, TIMESTAMP);
      assert.ok(v.endsWith('+00:00'));
    }
  }
  fake.timeZone = 'GMT';
  assert.equal(await db.scalar("select '2026-10-02 07:13:00.123456+00'::timestamptz"), '2026-10-02T07:13:00.123456+00:00');
  assert.equal(await db.scalar('select null::timestamptz'), null);
  assert.equal(await db.scalar("select 'infinity'::timestamptz"), 'infinity');
  const row = await db.one('select created_at from public.orders limit 1');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/);
});

test('11. numeric is a number, as PostgREST gave it; more than 15 significant digits is refused', async () => {
  for (const expr of ['12.50::numeric', '0::numeric', '-0.1::numeric', '33.3::numeric', 'round(2::numeric / 3 * 100, 1)',
                      '123456789012345::numeric', '0.000000000000001::numeric', '1000000000000000000000::numeric']) {
    const v = await db.scalar(`select ${expr}`);
    assert.equal(typeof v, 'number', expr);
    assert.equal(v, await postgrest(expr), expr);
  }
  for (const expr of ['1234567890123456::numeric', '0.1234567890123456::numeric', "'NaN'::numeric"]) {
    const e = await failure(() => db.scalar(`select ${expr}`));
    assert.equal(e.kind, 'database', expr);
  }
  const views = await db.query(`select repeat_rate_percent from public.customer_summary`);
  for (const r of views) assert.ok(r.repeat_rate_percent === null || typeof r.repeat_rate_percent === 'number');
});

test('the other types keep the driver\'s reading, as PostgREST gave them', async () => {
  const row = await db.one(`select 7::int as i, true as b, '{"a":[1,"x"]}'::jsonb as j, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid as u,
                                   't'::text as t`);
  assert.deepEqual(row, { i: 7, b: true, j: { a: [1, 'x'] }, u: 'aaaaaaaa-0000-4000-8000-000000000001', t: 't' });
});

/* ------------------------------------------------------------- leakage */

test('13. no credential appears in any error, request body or anything printed', async () => {
  for (const r of fake.requests) {
    assert.ok(!r.body.includes(TEST_PASSWORD), 'the connection string travels only in its header');
  }
  const errors = [
    await failure(() => db.query('select $1::int', [TEST_URL])),
    await failure(() => db.query('select $1::int', [TEST_PASSWORD]))
  ];
  for (const e of errors) {
    assert.equal(e.code, '22P02');
    assertNoSecret(e);
    assert.ok(e.dbMessage.includes('[redacted]'));
  }
  fake.failNext = 'network';
  assertNoSecret(await failure(() => db.query('select 1')));
  for (const line of printed) {
    assert.ok(!line.includes(TEST_PASSWORD) && !/postgres(ql)?:\/\//i.test(line), `printed: ${line}`);
  }
  assert.ok(!Object.keys(db).some((k) => /url|password|connection/i.test(k)), 'the module exports nothing about the connection');
});
