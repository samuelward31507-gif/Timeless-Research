/*
 * The operations console's API: what every admin-* function shares.
 *
 * Each console endpoint is a thin layer over the database. A read (GET) is
 * handled in this order, and stops at the first refusal:
 *
 *   1. Method. GET, or POST on an endpoint that has actions; else 405.
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
 * A write (POST) is a JSON body naming one allow-listed action. Its content
 * type and size are checked before sign-in; then who, the action, may they
 * (staff_can), and every body field against the action's own list. It then
 * calls exactly one protected database function (rpc/<fn>, migration 0004),
 * with p_actor set here from the session and nowhere else. That function
 * checks the permission again, makes the change and writes the audit entry
 * in one transaction. Nothing here writes a table directly.
 *
 * Responses are JSON with Cache-Control: no-store. Database errors are mapped
 * to a status and a fixed error code. A read never passes on the database's
 * message; a write passes on only the migrations' own sentences (see
 * writeError). The log records the endpoint, the staff id and an error code;
 * never a request or response body, a token or a key.
 *
 * Browser roles still have no database access; every call runs as the
 * service role, on the server.
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

/* A database refusal, carrying the SQLSTATE and the database's message. The
   message stays inside the server unless writeError() decides it is one of
   the migrations' own, written for the operator (see below). */
class DbFailure extends Error {
  constructor(code, dbMessage) {
    super(code || 'http_error');
    this.code = code;
    this.dbMessage = dbMessage;
  }
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
    let detail = null;
    try {
      detail = await res.json();
    } catch (e) { /* a body that is not JSON carries no code */ }
    const code = detail && typeof detail.code === 'string' ? detail.code : null;
    const message = detail && typeof detail.message === 'string' ? detail.message : null;
    throw new DbFailure(code, message);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new ApiError(500, 'unavailable', { reason: 'malformed_response' });
  }
}

/* Database errors on a read, by SQLSTATE, to a status and a fixed code. The
   database's message is never passed on: it can name tables, constraints and
   values. */
function dbError(code) {
  if (code === '42501') return new ApiError(403, 'not_authorized', { reason: code });
  if (code === 'P0002') return new ApiError(404, 'not_found', { reason: code });
  if (['22P02', '22007', '22008', '22023'].includes(code)) return new ApiError(400, 'invalid_input', { reason: code });
  return new ApiError(500, 'unavailable', { reason: code || 'http_error' });
}

/* Database errors on a write. The console functions in 0003 and 0004 refuse
   with their own sentences ("only a packed order can be shipped", "lot L1:
   only 3 on hand, cannot remove 5") as check_violation or no_data_found, and
   those are what the operator needs to see. PostgreSQL's own constraint
   messages share those codes but are generated ("new row for relation ...
   violates check constraint ...", with the failing row in the details), so
   anything that reads like one gets a fixed message instead. The details and
   hint are never passed on. */
const GENERATED = /violates|relation "|constraint "|column "|null value|failing row|duplicate key|syntax|function |permission/i;

function operatorMessage(message) {
  if (typeof message !== 'string') return null;
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 300 || GENERATED.test(text)) return null;
  return text;
}

function writeError(code, dbMessage) {
  if (code === '42501') return new ApiError(403, 'not_authorized', { reason: code });
  if (code === 'P0002') return new ApiError(404, 'not_found', { reason: code, message: operatorMessage(dbMessage) });
  if (code === '23514') {
    return new ApiError(422, 'rejected', { reason: code, message: operatorMessage(dbMessage) || 'The database refused this change.' });
  }
  if (code === '23505') return new ApiError(409, 'conflict', { reason: code, message: 'That already exists.' });
  if (code === '23503') return new ApiError(422, 'rejected', { reason: code, message: 'It refers to something that does not exist.' });
  if (['23502', '22P02', '22007', '22008', '22023', '22003', '22001'].includes(code)) {
    return new ApiError(400, 'invalid_input', { reason: code });
  }
  if (code === '40001' || code === '40P01') return new ApiError(409, 'retry', { reason: code });
  return new ApiError(500, 'unavailable', { reason: code || 'http_error' });
}

/* A read: table or view, explicit columns, and already-validated filters.
   query is a list of [name, value] pairs so a column can be filtered twice
   (a date range). */
async function select(table, columns, query) {
  const params = new URLSearchParams();
  params.append('select', columns.join(','));
  for (const [name, value] of query || []) params.append(name, value);
  let rows;
  try {
    rows = await call('GET', `${table}?${params.toString()}`);
  } catch (e) {
    throw e instanceof DbFailure ? dbError(e.code) : e;
  }
  if (!Array.isArray(rows)) throw new ApiError(500, 'unavailable', { reason: 'malformed_response' });
  return rows;
}

/* --------------------------------------------------------- write fields */

/* Validators for write bodies. Each takes (value, name) and returns the
   normalized value, or throws 400 invalid_field naming the field. Every
   validator refuses a missing field or null; optional() lets a missing field
   through as undefined, nullable() lets an explicit null through. */
const badField = (name) => new ApiError(400, 'invalid_field', { field: String(name).slice(0, 60) });

// Single-line text: no control characters. Multi-line text may hold newlines
// and tabs, nothing else below space.
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;
const MULTI_LINE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

function fieldOf(check) {
  return (value, name) => {
    if (value === undefined || value === null) throw badField(name);
    return check(value, name);
  };
}
const optional = (f) => (value, name) => (value === undefined ? undefined : f(value, name));
const nullable = (f) => (value, name) => (value === null ? null : f(value, name));

const field = {
  text: (min, max, opts) => fieldOf((value, name) => {
    if (typeof value !== 'string') throw badField(name);
    const t = value.trim();
    const re = opts && opts.multiline ? MULTI_LINE : SINGLE_LINE;
    if (t.length < min || t.length > max || !re.test(t)) throw badField(name);
    if (opts && opts.pattern && !opts.pattern.test(t)) throw badField(name);
    return t;
  }),
  uuid: () => fieldOf((value, name) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw badField(name);
    return value.toLowerCase();
  }),
  id: () => fieldOf((value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw badField(name);
    return value;
  }),
  int: (min, max, opts) => fieldOf((value, name) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw badField(name);
    if (opts && opts.nonzero && value === 0) throw badField(name);
    return value;
  }),
  bool: () => fieldOf((value, name) => {
    if (typeof value !== 'boolean') throw badField(name);
    return value;
  }),
  date: () => fieldOf((value, name) => {
    if (typeof value !== 'string' || !DATE.test(value) || !realDate(value)) throw badField(name);
    return value;
  }),
  oneOf: (choices) => fieldOf((value, name) => {
    if (typeof value !== 'string' || !choices.includes(value)) throw badField(name);
    return value;
  }),
  currency: () => fieldOf((value, name) => {
    if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw badField(name);
    return value;
  }),
  productId: () => fieldOf((value, name) => {
    if (typeof value !== 'string' || value.length > 80 || !PRODUCT_ID.test(value)) throw badField(name);
    return value;
  }),
  packSize: () => fieldOf((value, name) => {
    if (typeof value !== 'string' || value.length > 40 || !PACK_SIZE.test(value)) throw badField(name);
    return value;
  }),
  /* A partial update: an object of at least one allowed key, each validated. */
  changes: (spec) => fieldOf((value, name) => {
    if (typeof value !== 'object' || Array.isArray(value)) throw badField(name);
    const keys = Object.keys(value);
    if (keys.length === 0) throw badField(name);
    const out = {};
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(spec, k)) throw badField(`${name}.${k}`);
      out[k] = spec[k](value[k], `${name}.${k}`);
    }
    return out;
  })
};

/* --------------------------------------------------------------- bodies */

const BODY_LIMIT = 64 * 1024;
const MAX_BODY_LIMIT = 1024 * 1024;

function header(event, name) {
  const headers = (event && event.headers) || {};
  const found = Object.keys(headers).filter((k) => k.toLowerCase() === name);
  return found.length === 1 ? headers[found[0]] : (found.length ? null : undefined);
}

/* The raw body as text, refusing anything that is not a JSON request of a
   bounded size. Checked before the caller is even authenticated: it costs
   nothing and says nothing. */
function rawBody(event) {
  const type = header(event, 'content-type');
  if (typeof type !== 'string' || !/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(type)) {
    throw new ApiError(415, 'unsupported_media_type');
  }
  if (typeof event.body !== 'string' || event.body.length === 0) throw new ApiError(400, 'invalid_body');
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_LIMIT) throw new ApiError(413, 'body_too_large');
  return text;
}

/* ------------------------------------------------------------------ entry */

function log(fields) {
  console.warn(JSON.stringify(Object.assign({ admin_api: 'error' }, fields)));
}

function failure(e, name, staff) {
  if (!(e instanceof ApiError)) {
    log({ endpoint: name, staff: staff && staff.id, reason: 'internal_error' });
    return json(500, { error: 'unavailable' });
  }
  if (e.status >= 500 || e.status === 403) {
    log({ endpoint: name, staff: staff && staff.id, status: e.status, reason: e.extra && e.extra.reason });
  }
  const body = { error: e.error };
  if (e.status === 400 && e.extra && e.extra.parameter) body.parameter = e.extra.parameter;
  if (e.status === 400 && e.extra && e.extra.field) body.field = e.extra.field;
  if (e.extra && e.extra.message) body.message = e.extra.message;
  return json(e.status, body);
}

/* An endpoint. read(ctx) answers GET; actions, if given, are the POST
   actions it accepts, each { permission, fn, fields, args, result, maxBytes }:

     permission  checked with staff_can before anything in the body is used;
                 the database function checks it again (app_require)
     fn          the protected database function, called as rpc/<fn>
     fields      every key the body may carry besides "action", each with
                 its validator; any other key is refused
     args        builds the function's named arguments from validated fields
                 (p_actor is added here, from the session, and nowhere else)
     result      what of the function's answer is returned */
function endpoint(name, read, actions) {
  const allow = actions ? 'GET, POST' : 'GET';
  return async function handler(event) {
    const method = event && event.httpMethod;
    if (method !== 'GET' && !(method === 'POST' && actions)) {
      return json(405, { error: 'method_not_allowed' }, { Allow: allow });
    }

    let text = null;
    if (method === 'POST') {
      try {
        text = rawBody(event);
      } catch (e) {
        return failure(e, name, null);
      }
    }

    const who = await authenticateStaff(event);
    if (!who.ok) return denialResponse(who);
    const staff = who.staff;

    const granted = new Map();
    async function can(permission) {
      if (!granted.has(permission)) {
        let result;
        try {
          result = await call('POST', 'rpc/staff_can', { p_actor: staff.id, p_permission: permission });
        } catch (e) {
          throw e instanceof DbFailure ? dbError(e.code) : e;
        }
        granted.set(permission, result === true);
      }
      return granted.get(permission);
    }
    async function require(permission) {
      if (!(await can(permission))) throw new ApiError(403, 'not_authorized', { reason: `missing ${permission}` });
    }

    try {
      if (method === 'GET') {
        return json(200, await read({ staff, params: (allowed) => readParams(event, allowed), can, require, select }));
      }
      return json(200, await write(event, text, actions, staff, require));
    } catch (e) {
      return failure(e, name, staff);
    }
  };
}

async function write(event, text, actions, staff, require) {
  // A write takes its input from the body only.
  const query = Object.assign({}, event.queryStringParameters || {}, event.multiValueQueryStringParameters || {});
  const firstParam = Object.keys(query)[0];
  if (firstParam !== undefined) throw badParam(firstParam);

  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new ApiError(400, 'invalid_body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body');
  const action = body.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action)) {
    throw new ApiError(400, 'unknown_action');
  }
  const spec = actions[action];
  if (Buffer.byteLength(text, 'utf8') > (spec.maxBytes || BODY_LIMIT)) throw new ApiError(413, 'body_too_large');

  await require(spec.permission);

  for (const k of Object.keys(body)) {
    if (k !== 'action' && !Object.prototype.hasOwnProperty.call(spec.fields, k)) throw badField(k);
  }
  const values = {};
  for (const [k, check] of Object.entries(spec.fields)) values[k] = check(body[k], k);

  // The acting staff member: the verified session's, set last so nothing
  // built from the body can stand in for it.
  const args = Object.assign({}, spec.args(values), { p_actor: staff.id });

  let result;
  try {
    result = await call('POST', `rpc/${spec.fn}`, args);
  } catch (e) {
    throw e instanceof DbFailure ? writeError(e.code, e.dbMessage) : e;
  }
  return { action, result: spec.result(result) };
}

/* A read-only endpoint. */
function readEndpoint(name, route) {
  return endpoint(name, route, null);
}

/* For results: keep exactly these keys of a returned row. */
function pick(row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ApiError(500, 'unavailable', { reason: 'malformed_response' });
  return Object.fromEntries(keys.map((k) => [k, row[k] === undefined ? null : row[k]]));
}

/* For results: a function that returns one row as a table. */
function onlyRow(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new ApiError(500, 'unavailable', { reason: 'malformed_response' });
  return rows[0];
}

module.exports = {
  endpoint,
  readEndpoint,
  ApiError,
  v,
  field,
  optional,
  nullable,
  pick,
  onlyRow,
  decodeCursor,
  encodeCursor,
  afterDesc,
  page,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  BODY_LIMIT,
  MAX_BODY_LIMIT,
  _internals: { readParams, dbError, writeError, operatorMessage, select, call }
};
