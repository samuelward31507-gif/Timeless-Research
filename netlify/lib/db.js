/*
 * The database, for the Netlify Functions: the single place they reach
 * PostgreSQL (Neon) from. Nothing calls it yet; the functions still use
 * Supabase's HTTP API until each is moved over.
 *
 * Connection. DATABASE_URL, a server-side environment variable, names the
 * branch and the role. It must log in as peptide_app, the runtime role
 * (db/neon/00_roles.sql): any other role is refused before a query is sent,
 * so the schema's owner, the read-only role or the database owner can never
 * end up running the site. The value is never logged, returned or put in an
 * error.
 *
 * Transport. Neon's SQL-over-HTTP (@neondatabase/serverless): one HTTPS
 * request per query, nothing held open between invocations, so there is no
 * pool, socket or session to leak when a function ends or fails.
 *
 *   query(text, params)    the rows, as objects
 *   one(text, params)      exactly one row; none is a not_found error
 *   scalar(text, params)   the first column of that one row
 *   call(fn, args)         rows of a public function, args by name
 *   transaction(build)     several statements, all or nothing
 *
 * Every value is a parameter ($1, $2, ...). The SQL text is the caller's own
 * constant; nothing from a request is ever spliced into it. call() builds its
 * text only from a function name and argument names checked against a plain
 * identifier pattern.
 *
 * Transactions. build(tx) returns a list of tx.query(text, params). The list
 * is sent as one request; Neon runs BEGIN, the statements in order, then
 * COMMIT, and rolls everything back if any of them fails. A statement cannot
 * see the JavaScript result of an earlier one: it refers to what an earlier
 * statement wrote in SQL instead (a sub-select on stripe_session_id, say). If
 * build throws, nothing is sent. If the request fails in transit, its outcome
 * is unknown, as with any single request.
 *
 * Values. The driver's defaults differ from what the functions return today
 * through PostgREST's JSON, so these types are read deliberately:
 *
 *   bigint       a number (ids, counts, cent totals). Beyond 2^53 it could
 *                not be exact, so it is an error rather than a rounded number.
 *   numeric      a number (the *_percent columns), as JSON gave it. More than
 *                15 significant digits could not be exact: an error.
 *   date         'YYYY-MM-DD', unchanged.
 *   timestamptz  '2026-10-02T07:13:00.123456+00:00': ISO 8601 in UTC with the
 *                microseconds kept, PostgREST's form. The console's cursors
 *                carry these and compare them exactly.
 *
 * Everything else keeps the driver's reading (integer, boolean, jsonb, uuid,
 * text).
 *
 * Errors. Every failure is a DbError with a fixed message and a kind:
 *
 *   config        DATABASE_URL missing, malformed or not peptide_app; or
 *                 the database refused the login or the database name
 *   connection    unreachable, timed out, or the service answered with an
 *                 HTTP error
 *   permission    42501: the role may not do this
 *   constraint    class 23: a unique, foreign key, not null or check refusal
 *                 (the console functions also refuse with check_violation)
 *   invalid_input class 22: a value of the wrong form
 *   not_found     P0002 from a function, or one()/scalar() found no row
 *   application   other P0 codes: a function's own refusal
 *   retry         40001 / 40P01: a serialization failure or deadlock
 *   database      anything else, including a value that cannot be read safely
 *
 * error.code is the SQLSTATE when there is one. error.dbMessage is the
 * database's own sentence, for callers that pass the migrations' messages on
 * to the operator (admin-api.js writeError); it is kept off the message and
 * scrubbed of anything resembling a connection string.
 */
'use strict';

const { neon, neonConfig, types: driverTypes } = require('@neondatabase/serverless');

const RUNTIME_ROLE = 'peptide_app';
const TIMEOUT_MS = 8000;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/* Tests replace fetch here; the driver's own config is pointed at it once. */
const _internals = { fetch: (url, init) => fetch(url, init) };
neonConfig.fetchFunction = (url, init) => _internals.fetch(url, init);

/* ------------------------------------------------------------------ errors */

class DbError extends Error {
  constructor(kind, { code = null, dbMessage = null, reason = null } = {}) {
    super(`database ${kind}${code ? ` (${code})` : reason ? ` (${reason})` : ''}`);
    this.name = 'DbError';
    this.kind = kind;
    this.code = code;
    this.reason = reason;
    Object.defineProperty(this, 'dbMessage', { value: dbMessage, enumerable: false });
  }
}

const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi;

function scrub(text) {
  if (typeof text !== 'string') return null;
  let out = text.replace(CONNECTION_STRING, '[redacted]');
  const url = process.env.DATABASE_URL;
  if (url) {
    out = out.split(url).join('[redacted]');
    try {
      const pw = decodeURIComponent(new URL(url).password);
      if (pw.length >= 4) out = out.split(pw).join('[redacted]');
    } catch (e) { /* a malformed URL was refused before any query */ }
  }
  return out;
}

function kindOf(code) {
  if (code === '42501') return 'permission';
  if (code === 'P0002') return 'not_found';
  if (code === '40001' || code === '40P01') return 'retry';
  const cls = code.slice(0, 2);
  if (cls === '23') return 'constraint';
  if (cls === '22') return 'invalid_input';
  if (cls === 'P0') return 'application';
  if (cls === '28' || code === '3D000') return 'config';
  if (cls === '08' || cls === '57') return 'connection';
  return 'database';
}

/* Whatever the driver or the network threw, as a DbError. */
function normalizeError(e) {
  if (e instanceof DbError) return e;
  const code = e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  if (code) return new DbError(kindOf(code), { code, dbMessage: scrub(e.message) });
  const name = e && ((e.sourceError && e.sourceError.name) || e.name);
  if (name === 'TimeoutError' || name === 'AbortError') return new DbError('connection', { reason: 'timeout' });
  if (e && e.sourceError) return new DbError('connection', { reason: 'unreachable' });
  const status = e && typeof e.message === 'string' && /HTTP status (\d{3})/.exec(e.message);
  if (status) return new DbError('connection', { reason: `http_${status[1]}` });
  return new DbError('database', { reason: 'driver' });
}

/* ------------------------------------------------------------------ values */

function unreadable(reason) {
  return new DbError('database', { reason });
}

function bigint(text) {
  if (!/^-?\d+$/.test(text)) throw unreadable('unexpected_bigint');
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw unreadable('unsafe_integer');
  return n;
}

function numeric(text) {
  const m = /^-?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw unreadable('unexpected_numeric');
  const digits = (m[1] + (m[2] || '')).replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 15) throw unreadable('unsafe_numeric');
  return Number(text);
}

function date(text) {
  if (text === 'infinity' || text === '-infinity' || /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  throw unreadable('unexpected_date');
}

/* PostgreSQL's text form (DateStyle ISO), in whatever time zone the session
   has, to PostgREST's: 'T', UTC, '+00:00', the fraction as PostgreSQL wrote
   it. Only whole seconds are shifted, so the microseconds are exact. */
const TIMESTAMPTZ = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;

function timestamptz(text) {
  if (text === 'infinity' || text === '-infinity') return text;
  const m = TIMESTAMPTZ.exec(text);
  if (!m) throw unreadable('unexpected_timestamp');
  const [, y, mo, d, h, mi, s, frac = '', sign, oh, om = '00', os = '00'] = m;
  const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os));
  let utc = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (offset !== 0) {
    const t = new Date(0);
    t.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
    t.setUTCHours(Number(h), Number(mi), Number(s) - offset, 0);
    utc = t.toISOString().slice(0, 19);
    if (!/^\d{4}-/.test(utc)) throw unreadable('unexpected_timestamp');
  }
  return `${utc}${frac}+00:00`;
}

const PARSERS = { 20: bigint, 1700: numeric, 1082: date, 1184: timestamptz };

const TYPES = {
  getTypeParser(oid, format) {
    return PARSERS[oid] || driverTypes.getTypeParser(oid, format);
  }
};

/* ------------------------------------------------------------- connection */

let cached = { url: null, sql: null };

function connection() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || !url.trim()) throw new DbError('config', { reason: 'missing_database_url' });
  if (cached.url === url) return cached.sql;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new DbError('config', { reason: 'malformed_database_url' });
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.password) {
    throw new DbError('config', { reason: 'malformed_database_url' });
  }
  if (decodeURIComponent(parsed.username) !== RUNTIME_ROLE) throw new DbError('config', { reason: 'not_runtime_role' });
  let sql;
  try {
    sql = neon(url);
  } catch (e) {
    throw new DbError('config', { reason: 'malformed_database_url' });
  }
  cached = { url, sql };
  return sql;
}

function checkStatement(text, params) {
  if (typeof text !== 'string' || !text.trim()) throw new DbError('invalid_input', { reason: 'no_sql' });
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new DbError('invalid_input', { reason: 'params_not_array' });
  if (params.some((p) => p === undefined)) throw new DbError('invalid_input', { reason: 'undefined_param' });
  return params;
}

function fetchOptions() {
  return { signal: AbortSignal.timeout(TIMEOUT_MS) };
}

/* ---------------------------------------------------------------- queries */

async function query(text, params) {
  const values = checkStatement(text, params);
  const sql = connection();
  try {
    return await sql.query(text, values, { types: TYPES, fetchOptions: fetchOptions() });
  } catch (e) {
    throw normalizeError(e);
  }
}

async function one(text, params) {
  const rows = await query(text, params);
  if (rows.length === 0) throw new DbError('not_found', { reason: 'no_row' });
  if (rows.length > 1) throw new DbError('database', { reason: 'more_than_one_row' });
  return rows[0];
}

async function scalar(text, params) {
  const row = await one(text, params);
  const keys = Object.keys(row);
  if (keys.length !== 1) throw new DbError('database', { reason: 'not_one_column' });
  return row[keys[0]];
}

/* select * from public.fn(p_a => $1, p_b => $2): a set-returning function
   gives its rows; any other gives one row, its column named after it. */
function callText(fn, args) {
  if (typeof fn !== 'string' || !IDENTIFIER.test(fn)) throw new DbError('invalid_input', { reason: 'function_name' });
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new DbError('invalid_input', { reason: 'args_not_object' });
  }
  const names = Object.keys(args);
  for (const n of names) if (!IDENTIFIER.test(n)) throw new DbError('invalid_input', { reason: 'argument_name' });
  const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  return { text: `select * from public.${fn}(${list})`, params: names.map((n) => args[n]) };
}

async function call(fn, args = {}) {
  const { text, params } = callText(fn, args);
  return query(text, params);
}

/* ------------------------------------------------------------ transactions */

const STATEMENT = Symbol('statement');

const tx = Object.freeze({
  /* A plain description, not a query: awaiting it inside build() runs
     nothing, so no statement can escape the transaction. */
  query(text, params) {
    return { [STATEMENT]: true, text, params: checkStatement(text, params) };
  },
  call(fn, args = {}) {
    const { text, params } = callText(fn, args);
    return tx.query(text, params);
  }
});

/* Returns each statement's rows, in order. options: isolationLevel
   ('ReadCommitted' | 'RepeatableRead' | 'Serializable') and readOnly. */
async function transaction(build, options = {}) {
  if (typeof build !== 'function') throw new DbError('invalid_input', { reason: 'build_not_function' });
  const statements = await build(tx);
  if (!Array.isArray(statements) || statements.length === 0 || statements.some((s) => !s || s[STATEMENT] !== true)) {
    throw new DbError('invalid_input', { reason: 'not_statements' });
  }
  const sql = connection();
  const opts = { fetchOptions: fetchOptions() };
  if (options.isolationLevel !== undefined) {
    if (!['ReadCommitted', 'RepeatableRead', 'Serializable'].includes(options.isolationLevel)) {
      throw new DbError('invalid_input', { reason: 'isolation_level' });
    }
    opts.isolationLevel = options.isolationLevel;
  }
  if (options.readOnly !== undefined) opts.readOnly = options.readOnly === true;
  try {
    return await sql.transaction(statements.map((s) => sql.query(s.text, s.params, { types: TYPES })), opts);
  } catch (e) {
    throw normalizeError(e);
  }
}

module.exports = { query, one, scalar, call, transaction, DbError, RUNTIME_ROLE, _internals };
