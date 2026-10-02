/*
 * The operations console's read API: what every admin-* function shares.
 *
 * Each console endpoint is a thin layer over the database. A request is
 * handled in this order, and stops at the first refusal:
 *
 *   1. Method. Reads are GET; anything else is 405.
 *   2. Who. authenticateStaff(event) (admin-auth.js) verifies the Supabase
 *      sign-in and resolves it to an active staff member. Its staff.id is the
 *      only actor this API ever uses; nothing in the request can name one.
 *   3. May they. staff_can(staff.id, permission) in the database, the same
 *      role-to-permission rows the write functions check with app_require.
 *   4. What. Query parameters are checked against the endpoint's allow-list
 *      and validated (UUIDs, dates, fixed choices, bounded integers, opaque
 *      cursors); an unknown, repeated or malformed parameter is 400. Only
 *      validated values reach a PostgREST filter, and values inside or=()
 *      are quoted after validation has ruled out quotes and backslashes.
 *   5. Read. PostgREST with the service role key, which stays on the server.
 *      Every query names its columns; nothing selects *.
 *
 * Responses are JSON with Cache-Control: no-store. Database errors are mapped
 * to a status and a fixed error code, never the database's own message. The
 * log records the endpoint, the staff id and an error code; never a request
 * or response body, a token or a key.
 *
 * Read-only: nothing here writes. Browser roles still have no database
 * access; every query runs as the service role, on the server.
 */
'use strict';

const { authenticateStaff, denialResponse } = require('./admin-auth.js');

const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const PRODUCT_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PACK_SIZE = /^[A-Za-z0-9][A-Za-z0-9 .]*$/;

const HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
});

function json(statusCode, body, extra) {
  return { statusCode, headers: Object.assign({}, HEADERS, extra || {}), body: JSON.stringify(body) };
}

/* A refusal or failure with a fixed, safe error code. */
class ApiError extends Error {
  constructor(status, error, extra) {
    super(error);
    this.status = status;
    this.error = error;
    this.extra = extra || null;
  }
}

const badParam = (name) => new ApiError(400, 'invalid_parameter', { parameter: String(name).slice(0, 40) });

/* ------------------------------------------------------------ parameters */

/* The endpoint's allowed parameters, each given once. Netlify lists a
   repeated parameter in multiValueQueryStringParameters; a repeat is refused
   rather than one copy silently chosen. */
function readParams(event, allowed) {
  const single = (event && event.queryStringParameters) || {};
  const multi = (event && event.multiValueQueryStringParameters) || {};
  const out = {};
  for (const name of new Set(Object.keys(single).concat(Object.keys(multi)))) {
    if (!allowed.includes(name)) throw badParam(name);
    const values = multi[name] !== undefined ? [].concat(multi[name]) : [single[name]];
    if (values.length !== 1 || typeof values[0] !== 'string') throw badParam(name);
    if (single[name] !== undefined && single[name] !== values[0]) throw badParam(name);
    out[name] = values[0];
  }
  return out;
}

function pattern(value, name, re, maxLength) {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > maxLength || !re.test(value)) throw badParam(name);
  return value;
}

function realDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const v = {
  uuid: (value, name) => pattern(value, name, UUID, 36) && value.toLowerCase(),
  date(value, name) {
    if (value === undefined) return undefined;
    if (!DATE.test(value) || !realDate(value)) throw badParam(name);
    return value;
  },
  month(value, name) {
    if (value === undefined) return undefined;
    if (!MONTH.test(value) || !realDate(`${value}-01`)) throw badParam(name);
    return `${value}-01`;
  },
  oneOf(value, name, choices) {
    if (value === undefined) return undefined;
    if (!choices.includes(value)) throw badParam(name);
    return value;
  },
  flag(value, name) {
    if (value === undefined) return false;
    if (value !== '1') throw badParam(name);
    return true;
  },
  limit(value, max) {
    if (value === undefined) return DEFAULT_LIMIT;
    if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > (max || MAX_LIMIT)) throw badParam('limit');
    return Number(value);
  },
  productId: (value, name) => pattern(value, name, PRODUCT_ID, 80),
  packSize: (value, name) => pattern(value, name, PACK_SIZE, 40),
  pattern
};

/* ---------------------------------------------------------------- cursors */

/* An opaque cursor is base64url JSON of the last row's sort key. It is
   decoded and every value re-validated against the shape this endpoint
   expects; a cursor the API did not issue is refused, not interpreted. */
const CURSOR_TYPES = {
  timestamp: (x) => typeof x === 'string' && TIMESTAMP.test(x) && !Number.isNaN(Date.parse(x.replace(' ', 'T'))),
  date: (x) => typeof x === 'string' && DATE.test(x) && realDate(x),
  uuid: (x) => typeof x === 'string' && UUID.test(x),
  id: (x) => Number.isSafeInteger(x) && x > 0,
  offset: (x) => Number.isSafeInteger(x) && x > 0 && x <= 10000
};

function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

function decodeCursor(value, types) {
  if (value === undefined) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw badParam('cursor');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (e) {
    throw badParam('cursor');
  }
  if (!Array.isArray(parsed) || parsed.length !== types.length) throw badParam('cursor');
  types.forEach((t, i) => { if (!CURSOR_TYPES[t](parsed[i])) throw badParam('cursor'); });
  return parsed;
}

/* Rows after the cursor, for a two-column descending sort: PostgREST's
   or=(a.lt."x",and(a.eq."x",b.lt."y")). Both values have already passed
   CURSOR_TYPES, so they contain no quote, backslash, comma or bracket. */
function afterDesc(colA, colB, cursor) {
  const [a, b] = cursor.map((x) => `"${x}"`);
  return `(${colA}.lt.${a},and(${colA}.eq.${a},${colB}.lt.${b}))`;
}

/* Fetch one extra row to know whether there is a next page. */
function page(rows, limit, keyOf) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? encodeCursor(keyOf(items[items.length - 1])) : null };
}

/* --------------------------------------------------------------- PostgREST */

function supabaseBase() {
  const url = new URL(process.env.SUPABASE_URL);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function call(method, path, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${supabaseBase()}/rest/v1/${path}`, {
      method,
      headers: Object.assign(
        { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
        body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    throw new ApiError(500, 'unavailable', { reason: 'unreachable' });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    let code = null;
    try {
      const detail = await res.json();
      code = detail && typeof detail.code === 'string' ? detail.code : null;
    } catch (e) { /* the code is all that is used; a body that is not JSON has none */ }
    throw dbError(code);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new ApiError(500, 'unavailable', { reason: 'malformed_response' });
  }
}

/* Database errors, by SQLSTATE, to a status and a fixed code. The database's
   message is never passed on: it can name tables, constraints and values. */
function dbError(code) {
  if (code === '42501') return new ApiError(403, 'not_authorized', { reason: code });
  if (code === 'P0002') return new ApiError(404, 'not_found', { reason: code });
  if (['22P02', '22007', '22008', '22023'].includes(code)) return new ApiError(400, 'invalid_input', { reason: code });
  return new ApiError(500, 'unavailable', { reason: code || 'http_error' });
}

/* A read: table or view, explicit columns, and already-validated filters.
   query is a list of [name, value] pairs so a column can be filtered twice
   (a date range). */
async function select(table, columns, query) {
  const params = new URLSearchParams();
  params.append('select', columns.join(','));
  for (const [name, value] of query || []) params.append(name, value);
  const rows = await call('GET', `${table}?${params.toString()}`);
  if (!Array.isArray(rows)) throw new ApiError(500, 'unavailable', { reason: 'malformed_response' });
  return rows;
}

/* ------------------------------------------------------------------ entry */

function log(fields) {
  console.warn(JSON.stringify(Object.assign({ admin_api: 'error' }, fields)));
}

/* A read endpoint. route(ctx) returns the response body; ctx carries the
   authenticated staff member, the validated-parameter reader, the permission
   check and the PostgREST read. */
function readEndpoint(name, route) {
  return async function handler(event) {
    if (!event || event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });

    const who = await authenticateStaff(event);
    if (!who.ok) return denialResponse(who);
    const staff = who.staff;

    const granted = new Map();
    async function can(permission) {
      if (!granted.has(permission)) {
        const result = await call('POST', 'rpc/staff_can', { p_actor: staff.id, p_permission: permission });
        granted.set(permission, result === true);
      }
      return granted.get(permission);
    }
    async function require(permission) {
      if (!(await can(permission))) throw new ApiError(403, 'not_authorized', { reason: `missing ${permission}` });
    }

    try {
      const body = await route({
        staff,
        params: (allowed) => readParams(event, allowed),
        can,
        require,
        select
      });
      return json(200, body);
    } catch (e) {
      if (!(e instanceof ApiError)) {
        log({ endpoint: name, staff: staff.id, reason: 'internal_error' });
        return json(500, { error: 'unavailable' });
      }
      if (e.status >= 500 || e.status === 403) log({ endpoint: name, staff: staff.id, status: e.status, reason: e.extra && e.extra.reason });
      const body = { error: e.error };
      if (e.status === 400 && e.extra && e.extra.parameter) body.parameter = e.extra.parameter;
      return json(e.status, body);
    }
  };
}

module.exports = {
  readEndpoint,
  ApiError,
  v,
  decodeCursor,
  encodeCursor,
  afterDesc,
  page,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  _internals: { readParams, dbError, select, call }
};
