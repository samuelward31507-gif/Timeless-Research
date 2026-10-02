/*
 * A stand-in for Neon's SQL-over-HTTP endpoint, backed by an in-process
 * PostgreSQL (PGlite) built on the Neon role model. Test-only.
 *
 * It answers the requests @neondatabase/serverless makes, in the same form:
 *
 *   POST, JSON body { query, params } or { queries: [{ query, params }] },
 *   headers Neon-Connection-String, Neon-Raw-Text-Output, Neon-Array-Mode,
 *   and for a batch Neon-Batch-Isolation-Level / Neon-Batch-Read-Only;
 *
 *   200 { fields: [{ name, dataTypeID }], rows: [[text|null]], command,
 *   rowCount } (a batch: { results: [...] }), or 400 with PostgreSQL's error
 *   fields ({ message, code, detail, ... }).
 *
 * Every value comes back as PostgreSQL's text, exactly as Neon sends it, so
 * the driver's type parsing and db.js's are exercised for real. Each request
 * runs as the role named in its connection string (SET ROLE), so privileges
 * are the database's own, and a batch runs between BEGIN and COMMIT, rolled
 * back if a statement fails, as Neon does.
 */
import { freshDb } from './harness.mjs';

export const TEST_PASSWORD = 'tst-not-a-real-password-7c1e';
export const TEST_URL = `postgresql://peptide_app:${TEST_PASSWORD}@ep-test-0000.example.invalid/neondb?sslmode=require`;
export const urlFor = (role) => TEST_URL.replace('peptide_app', role);

const ROLES = new Set(['peptide_app', 'peptide_readonly', 'peptide_owner']);
const ERROR_FIELDS = ['severity', 'code', 'detail', 'hint', 'position', 'internalPosition', 'internalQuery',
  'where', 'schema', 'table', 'column', 'dataType', 'constraint', 'file', 'line', 'routine'];

function respond(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function neonHttp(options = {}) {
  const db = options.db || await freshDb({ platform: 'neon' });
  /* Text in, text out: parameters reach PostgreSQL as the text the driver
     prepared, and every value comes back as PostgreSQL's text, as on Neon. */
  const oids = (await db.query('select oid::int as o from pg_type')).rows.map((r) => r.o);
  const raw = Object.fromEntries(oids.map((o) => [o, (x) => x]));
  const asText = Object.fromEntries(oids.map((o) => [o, (x) => String(x)]));
  let queue = Promise.resolve();
  const fake = {
    db,
    requests: [],
    /* 'network' | 'http500' | 'timeout': the next request fails that way. */
    failNext: null,
    /* The session time zone, as a Neon compute's might differ. */
    timeZone: 'GMT',
    fetch: (url, init) => {
      const run = queue.then(() => handle(url, init));
      queue = run.catch(() => {});
      return run;
    }
  };

  async function runOne(q) {
    const r = await db.query(q.query, q.params, { rowMode: 'array', parsers: raw, serializers: asText });
    return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows,
             command: null, rowCount: r.affectedRows ?? r.rows.length };
  }

  async function handle(url, init) {
    const headers = new Headers(init.headers);
    fake.requests.push({ url: String(url), headers, body: init.body });
    const failure = fake.failNext;
    fake.failNext = null;
    if (failure === 'network') {
      const e = new TypeError('fetch failed');
      e.cause = new Error(`getaddrinfo ENOTFOUND ${new URL(String(url)).hostname}`);
      throw e;
    }
    if (failure === 'timeout') {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    if (failure === 'http500') return new Response('upstream connect error', { status: 500 });
    if (init.method !== 'POST' || headers.get('Neon-Raw-Text-Output') !== 'true' || headers.get('Neon-Array-Mode') !== 'true') {
      return new Response('unexpected request', { status: 500 });
    }

    const conn = new URL(headers.get('Neon-Connection-String'));
    const role = decodeURIComponent(conn.username);
    if (!ROLES.has(role) || decodeURIComponent(conn.password) !== TEST_PASSWORD) {
      return respond(400, { message: `password authentication failed for user "${role}"`, code: '28P01' });
    }
    const body = JSON.parse(init.body);
    await db.exec(`set role ${role}; set timezone = '${fake.timeZone.replace(/'/g, '')}'`);
    try {
      if (!Array.isArray(body.queries)) return respond(200, await runOne(body));
      const iso = headers.get('Neon-Batch-Isolation-Level');
      const ro = headers.get('Neon-Batch-Read-Only');
      const level = { ReadCommitted: 'read committed', RepeatableRead: 'repeatable read', Serializable: 'serializable' }[iso];
      await db.exec(`begin${level ? ` isolation level ${level}` : ''}${ro === 'true' ? ' read only' : ''}`);
      const results = [];
      try {
        for (const q of body.queries) results.push(await runOne(q));
        await db.exec('commit');
      } catch (e) {
        await db.exec('rollback');
        throw e;
      }
      return respond(200, { results });
    } catch (e) {
      if (!e || !e.code) throw e;
      const out = { message: e.message };
      for (const f of ERROR_FIELDS) if (e[f] !== undefined) out[f] = e[f];
      return respond(400, out);
    } finally {
      await db.exec('reset role; reset timezone');
    }
  }

  return fake;
}
