/*
 * Shared offline fixtures for the console API suites: a signing key, signed
 * Supabase-style access tokens, and one stubbed global.fetch standing in for
 * the Auth server's key set, the staff lookup, staff_can and PostgREST reads.
 * Nothing here touches a network or a real Supabase project.
 */
'use strict';

const crypto = require('node:crypto');

const BASE = 'https://test-ref.supabase.co';
const ISSUER = `${BASE}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SERVICE_KEY = 'test-service-role-key-not-real';
const OWNER_AUTH_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_STAFF_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const ALL_PERMISSIONS = ['orders.read', 'orders.write', 'fulfilment.write', 'inventory.read', 'inventory.write',
  'finance.read', 'finance.write', 'customers.read', 'audit.read', 'staff.manage'];

process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const EC = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');

function token(over) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({
    iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub: OWNER_AUTH_ID,
    iat: now - 10, exp: now + 3600, aal: 'aal2', is_anonymous: false
  }, over || {});
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: EC.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const state = {};

function reset() {
  state.calls = [];
  state.permissions = new Set(ALL_PERMISSIONS);
  state.staff = [{ id: OWNER_STAFF_ID, auth_user_id: OWNER_AUTH_ID, email: 'owner@example.org',
                   display_name: 'Owner', role_code: 'owner', active: true }];
  state.tables = {};
  state.errors = {};
  state.down = false;
}
reset();

/* A PostgREST-ish error body: only "code" is ever read by the API. */
function errorResponse(status, code) {
  return { ok: false, status, json: async () => ({ code, message: 'relation "secret_table" violates constraint "x"', details: 'internal', hint: null }) };
}

global.fetch = async (url, init) => {
  url = String(url);
  init = init || {};
  const call = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
  state.calls.push(call);
  if (url === JWKS_URL) {
    const jwk = Object.assign(EC.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'ES256', use: 'sig' });
    return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [jwk] }) };
  }
  if (url.startsWith(`${BASE}/rest/v1/staff_members?`)) {
    return { ok: true, status: 200, json: async () => state.staff };
  }
  if (state.down) throw new Error('network down');
  if (url === `${BASE}/rest/v1/rpc/staff_can`) {
    if (state.errors.staff_can) return errorResponse(state.errors.staff_can.status, state.errors.staff_can.code);
    return { ok: true, status: 200, json: async () => state.permissions.has(call.body.p_permission) };
  }
  const m = /^https:\/\/test-ref\.supabase\.co\/rest\/v1\/([a-z_]+)\?/.exec(url);
  if (m) {
    const table = m[1];
    const err = state.errors[table];
    if (err) return errorResponse(err.status, err.code);
    const rows = state.tables[table];
    const value = typeof rows === 'function' ? rows(new URL(url)) : (rows || []);
    return { ok: true, status: 200, json: async () => value };
  }
  throw new Error(`unexpected fetch ${url}`);
};

/* A GET (or other method) to a handler, as Netlify would deliver it. */
function request(handler, query, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.token === null ? {} : { authorization: `Bearer ${opts.token || token()}` },
                                opts.headers || {});
  return handler({
    httpMethod: opts.method || 'GET',
    headers,
    queryStringParameters: query || null,
    multiValueQueryStringParameters: opts.multi || null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    isBase64Encoded: false
  });
}

/* PostgREST reads made during the last request (auth and staff_can left out). */
function reads() {
  return state.calls
    .filter((c) => c.url.startsWith(`${BASE}/rest/v1/`) && !c.url.includes('/rpc/') && !c.url.includes('/staff_members?'))
    .map((c) => {
      const u = new URL(c.url);
      return { table: u.pathname.replace('/rest/v1/', ''), params: [...u.searchParams.entries()], url: c.url, call: c };
    });
}

function readOf(table) {
  const found = reads().filter((r) => r.table === table);
  if (found.length !== 1) throw new Error(`expected one read of ${table}, saw ${found.length}`);
  return found[0];
}

const param = (r, name) => r.params.filter(([k]) => k === name).map(([, v]) => v);

module.exports = {
  BASE, SERVICE_KEY, OWNER_STAFF_ID, OWNER_AUTH_ID, ALL_PERMISSIONS,
  state, reset, token, request, reads, readOf, param
};
