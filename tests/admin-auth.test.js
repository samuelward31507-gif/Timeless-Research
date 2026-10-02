/*
 * The operations console's authentication foundation: netlify/lib/admin-auth.js.
 *
 *   node --test tests/admin-auth.test.js
 *
 * Offline. Signing keys are generated here, tokens are signed here, and both
 * Supabase endpoints the library calls — the Auth server's published key set
 * and PostgREST's staff_members — are stubbed through global.fetch. What this
 * proves is what the library accepts and refuses. Whether real Supabase Auth
 * issues tokens shaped the way this assumes is not proven here; HANDOVER §3g
 * lists what has to be checked against the staging project.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const BASE = 'https://test-ref.supabase.co';
const ISSUER = `${BASE}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SERVICE_KEY = 'test-service-role-key-not-real';

process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const auth = require(path.join(__dirname, '..', 'netlify', 'lib', 'admin-auth.js'));
const I = auth._internals;

/* ------------------------------------------------------------- keys */

function keyPair(kind) {
  const pair = kind === 'EC'
    ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return pair;
}

const EC = keyPair('EC');
const EC2 = keyPair('EC');
const RSA = keyPair('RSA');
const RSA_SMALL = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });

function jwk(pair, kid, extra) {
  return Object.assign(pair.publicKey.export({ format: 'jwk' }), { kid }, extra || {});
}

/* ----------------------------------------------------------- tokens */

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

let NOW = 1_800_000_000; // seconds; the library's clock is pinned to this

const OWNER_AUTH_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_STAFF_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STAFF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function claims(over) {
  return Object.assign({
    iss: ISSUER, aud: 'authenticated', role: 'authenticated',
    sub: OWNER_AUTH_ID, email: 'owner@example.org',
    iat: NOW - 60, exp: NOW + 3600, aal: 'aal2', amr: [{ method: 'totp', timestamp: NOW - 60 }],
    is_anonymous: false, session_id: '22222222-2222-4222-8222-222222222222'
  }, over || {});
}

function sign(payload, opts) {
  opts = opts || {};
  const alg = opts.alg || 'ES256';
  const header = Object.assign({ alg, typ: 'JWT', kid: opts.kid || 'ec-1' }, opts.header || {});
  const input = `${b64(header)}.${b64(payload)}`;
  let sig;
  if (alg === 'ES256') {
    sig = crypto.sign('sha256', Buffer.from(input), { key: (opts.pair || EC).privateKey, dsaEncoding: 'ieee-p1363' });
  } else if (alg === 'RS256') {
    sig = crypto.sign('sha256', Buffer.from(input), (opts.pair || RSA).privateKey);
  } else if (alg === 'HS256') {
    sig = crypto.createHmac('sha256', opts.secret).update(input).digest();
  } else {
    sig = Buffer.alloc(0);
  }
  return `${input}.${sig.toString('base64url')}`;
}

const token = (over, opts) => sign(claims(over), opts);

/* ------------------------------------------------------- stubbed fetch */

let jwksBody;
let jwksStatus;
let staffRows;
let staffStatus;
let calls;
let failNext = null;

function defaultKeys() {
  return { keys: [jwk(EC, 'ec-1', { alg: 'ES256', use: 'sig' }), jwk(RSA, 'rsa-1', { alg: 'RS256', use: 'sig' })] };
}

function ownerRow(over) {
  return Object.assign({
    id: OWNER_STAFF_ID, auth_user_id: OWNER_AUTH_ID, email: 'owner@example.org',
    display_name: 'Owner', role_code: 'owner', active: true
  }, over || {});
}

global.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (failNext && failNext(String(url))) throw new Error('network down');
  if (url === JWKS_URL) {
    const text = typeof jwksBody === 'string' ? jwksBody : JSON.stringify(jwksBody);
    return { ok: jwksStatus === 200, status: jwksStatus, text: async () => text };
  }
  if (String(url).startsWith(`${BASE}/rest/v1/staff_members?`)) {
    return { ok: staffStatus === 200, status: staffStatus, json: async () => (typeof staffRows === 'function' ? staffRows() : staffRows) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

function request(tok, extra) {
  extra = extra || {};
  const headers = Object.assign({}, tok === undefined ? {} : { authorization: `Bearer ${tok}` }, extra.headers || {});
  return {
    httpMethod: extra.method || 'POST',
    headers,
    multiValueHeaders: extra.multiValueHeaders,
    queryStringParameters: extra.query || null,
    body: extra.body === undefined ? null : JSON.stringify(extra.body),
    isBase64Encoded: false
  };
}

const run = (tok, extra) => auth.authenticateStaff(request(tok, extra));

let logs;
const origWarn = console.warn;

test.beforeEach(() => {
  NOW = 1_800_000_000;
  I.clock.now = () => NOW * 1000;
  I.resetKeyCache();
  jwksBody = defaultKeys();
  jwksStatus = 200;
  staffRows = [ownerRow()];
  staffStatus = 200;
  calls = [];
  failNext = null;
  logs = [];
  console.warn = (...a) => logs.push(a.join(' '));
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
});

test.afterEach(() => { console.warn = origWarn; });

function refused(res, status, error) {
  assert.equal(res.ok, false, 'expected a refusal');
  assert.equal(res.status, status);
  assert.equal(res.error, error || (status === 500 ? 'unavailable' : 'not_authorized'));
  assert.equal(res.staff, undefined);
}

const lastReason = () => JSON.parse(logs[logs.length - 1]).reason;

/* ------------------------------------------------------- the good path */

test('a valid ES256 owner token with MFA resolves to the staff member', async () => {
  const res = await run(token());
  assert.equal(res.ok, true);
  assert.deepEqual({ ...res.staff }, { id: OWNER_STAFF_ID, email: 'owner@example.org', displayName: 'Owner', role: 'owner' });
  assert.ok(Object.isFrozen(res.staff));
});

test('a valid RS256 token is accepted with its own key', async () => {
  const res = await run(token({}, { alg: 'RS256', kid: 'rsa-1' }));
  assert.equal(res.ok, true);
  assert.equal(res.staff.id, OWNER_STAFF_ID);
});

test('the staff lookup is a service-role read filtered only by the verified subject', async () => {
  await run(token());
  const lookup = calls.find((c) => c.url.includes('/rest/v1/staff_members'));
  assert.ok(lookup);
  const u = new URL(lookup.url);
  assert.equal(u.searchParams.get('auth_user_id'), `eq.${OWNER_AUTH_ID}`);
  assert.equal(u.searchParams.get('select'), 'id,auth_user_id,email,display_name,role_code,active');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['auth_user_id', 'limit', 'select']);
  assert.equal(lookup.init.headers.apikey, SERVICE_KEY);
  assert.equal(lookup.init.headers.Authorization, `Bearer ${SERVICE_KEY}`);
  // The key set is fetched without any credential.
  const keys = calls.find((c) => c.url === JWKS_URL);
  assert.ok(keys);
  assert.equal(JSON.stringify(keys.init).includes(SERVICE_KEY), false);
});

test('staff are looked up on every request, so deactivation is immediate', async () => {
  const tok = token();
  assert.equal((await run(tok)).ok, true);
  staffRows = [ownerRow({ active: false })];
  refused(await run(tok), 403);
  assert.equal(calls.filter((c) => c.url.includes('/rest/v1/staff_members')).length, 2);
});

test('the Authorization header is found whatever its case', async () => {
  const res = await auth.authenticateStaff({ headers: { AUTHORIZATION: `bearer ${token()}` } });
  assert.equal(res.ok, true);
});

/* ------------------------------------------------- the actor rule */

test('nothing in the request other than the verified token can name the actor', async () => {
  const res = await run(token(), {
    body: { actor: OTHER_STAFF_ID, actor_id: OTHER_STAFF_ID, staff_id: OTHER_STAFF_ID, p_actor: OTHER_STAFF_ID,
            sub: '99999999-9999-4999-8999-999999999999', auth_user_id: '99999999-9999-4999-8999-999999999999' },
    query: { actor_id: OTHER_STAFF_ID, staff_id: OTHER_STAFF_ID, auth_user_id: '99999999-9999-4999-8999-999999999999' },
    headers: { 'x-staff-id': OTHER_STAFF_ID, 'x-actor-id': OTHER_STAFF_ID, 'x-user-id': OTHER_STAFF_ID,
               cookie: `staff_id=${OTHER_STAFF_ID}` }
  });
  assert.equal(res.ok, true);
  assert.equal(res.staff.id, OWNER_STAFF_ID);
  for (const c of calls) {
    assert.equal(c.url.includes(OTHER_STAFF_ID), false, 'a client-supplied id reached a lookup');
    assert.equal(c.url.includes('99999999'), false, 'a client-supplied user id reached a lookup');
  }
});

test('without a token, ids in the body, query or headers get nothing and look nothing up', async () => {
  const res = await run(undefined, {
    body: { actor_id: OWNER_STAFF_ID, sub: OWNER_AUTH_ID },
    query: { actor_id: OWNER_STAFF_ID },
    headers: { 'x-staff-id': OWNER_STAFF_ID, cookie: `sb-access-token=${token()}` }
  });
  refused(res, 401);
  assert.equal(calls.length, 0);
});

test('the actor is the looked-up staff id, not anything in the token', async () => {
  // A token whose extra claims try to name a staff member is still resolved by sub.
  const res = await run(token({ staff_id: OTHER_STAFF_ID, actor_id: OTHER_STAFF_ID, user_metadata: { staff_id: OTHER_STAFF_ID } }));
  assert.equal(res.staff.id, OWNER_STAFF_ID);
});

test('a lookup row that does not belong to the verified subject is refused', async () => {
  staffRows = [ownerRow({ auth_user_id: '99999999-9999-4999-8999-999999999999' })];
  refused(await run(token()), 500);
});

/* ------------------------------------------------------ token shape */

test('missing, malformed and oversized tokens are refused before any fetch', async () => {
  const cases = [
    [undefined, 'no_token'],
    ['', 'malformed_token'],
    ['abc', 'malformed_token'],
    ['a.b', 'malformed_token'],
    ['a.b.c.d', 'malformed_token'],
    ['a+b.c/d.e=f', 'malformed_token'],
    [`${b64('not json')}.${b64({})}.sig`, 'malformed_token'],
    [`${b64([1, 2])}.${b64({})}.sig`, 'malformed_token']
  ];
  for (const [tok, reason] of cases) {
    calls = [];
    refused(await run(tok), 401);
    assert.equal(lastReason(), reason, String(tok));
    assert.equal(calls.length, 0);
  }
  refused(await auth.authenticateStaff({ headers: { authorization: `Basic ${b64('u:p')}` } }), 401);
  refused(await auth.authenticateStaff({ headers: { authorization: token() } }), 401);
  refused(await auth.authenticateStaff({}), 401);
  refused(await auth.authenticateStaff(null), 401);
});

test('a token larger than the bound is refused unread', async () => {
  const big = token({ padding: 'x'.repeat(I.MAX_HEADER_BYTES) });
  refused(await run(big), 401);
  assert.equal(lastReason(), 'token_too_large');
  assert.equal(calls.length, 0);
});

test('two different Authorization values are refused', async () => {
  const a = token();
  const b = token({ sub: '33333333-3333-4333-8333-333333333333' });
  refused(await auth.authenticateStaff({ headers: { authorization: `Bearer ${a}`, Authorization: `Bearer ${b}` } }), 401);
  refused(await auth.authenticateStaff({ headers: { authorization: `Bearer ${a}` },
                                         multiValueHeaders: { authorization: [`Bearer ${a}`, `Bearer ${b}`] } }), 401);
  assert.equal(lastReason(), 'ambiguous_authorization');
});

/* ------------------------------------------------- algorithm and key */

test('alg none, HS256 and anything but ES256/RS256 are refused', async () => {
  const p = claims();
  const none = `${b64({ alg: 'none', typ: 'JWT', kid: 'ec-1' })}.${b64(p)}.`;
  refused(await run(none), 401);
  const noneSigned = `${b64({ alg: 'none', typ: 'JWT', kid: 'ec-1' })}.${b64(p)}.${b64('x')}`;
  refused(await run(noneSigned), 401);
  for (const alg of ['HS256', 'HS384', 'ES384', 'RS512', 'PS256', 'EdDSA', 'es256', '__proto__', 'toString']) {
    const t = `${b64({ alg, typ: 'JWT', kid: 'ec-1' })}.${b64(p)}.${b64('sig')}`;
    refused(await run(t), 401);
    assert.equal(lastReason(), 'unsupported_algorithm', alg);
  }
  assert.equal(calls.length, 0, 'an unsupported algorithm caused a fetch');
});

test('the public key used as an HMAC secret (algorithm confusion) is refused', async () => {
  const pem = EC.publicKey.export({ type: 'spki', format: 'pem' });
  refused(await run(token({}, { alg: 'HS256', secret: pem })), 401);
  const rsaPem = RSA.publicKey.export({ type: 'spki', format: 'pem' });
  refused(await run(token({}, { alg: 'HS256', kid: 'rsa-1', secret: rsaPem })), 401);
});

test('a token must name a kid, and the kid must be in the key set', async () => {
  refused(await run(token({}, { header: { kid: undefined } })), 401);
  assert.equal(lastReason(), 'no_key_id');
  refused(await run(token({}, { kid: 'nope' })), 401);
  assert.equal(lastReason(), 'unknown_key');
});

test('the key type must match the algorithm', async () => {
  // ES256 header pointing at the RSA key, and RS256 pointing at the EC key.
  refused(await run(token({}, { alg: 'ES256', kid: 'rsa-1' })), 401);
  assert.equal(lastReason(), 'bad_signature');
  refused(await run(token({}, { alg: 'RS256', kid: 'ec-1' })), 401);
  assert.equal(lastReason(), 'bad_signature');
});

test("a key's declared alg must match the token's", async () => {
  jwksBody = { keys: [jwk(RSA, 'rsa-1', { alg: 'PS256' })] };
  refused(await run(token({}, { alg: 'RS256', kid: 'rsa-1' })), 401);
});

test('keys not meant for signature verification are ignored', async () => {
  jwksBody = { keys: [jwk(EC, 'ec-1', { use: 'enc' })] };
  refused(await run(token()), 401);
  I.resetKeyCache();
  jwksBody = { keys: [jwk(EC, 'ec-1', { key_ops: ['encrypt'] })] };
  refused(await run(token()), 401);
  I.resetKeyCache();
  jwksBody = { keys: [jwk(EC, 'ec-1', { key_ops: ['verify'] })] };
  assert.equal((await run(token())).ok, true);
});

test('RSA keys under 2048 bits are refused', async () => {
  jwksBody = { keys: [jwk(RSA_SMALL, 'rsa-small')] };
  refused(await run(token({}, { alg: 'RS256', kid: 'rsa-small', pair: RSA_SMALL })), 401);
  assert.equal(lastReason(), 'bad_signature');
});

test('a kid published twice is ambiguous and refused', async () => {
  jwksBody = { keys: [jwk(EC, 'ec-1'), jwk(EC2, 'ec-1')] };
  refused(await run(token()), 401);
  assert.equal(lastReason(), 'unknown_key');
});

test('a private key in the key set is used only for its public half', async () => {
  const priv = EC.privateKey.export({ format: 'jwk' });
  jwksBody = { keys: [Object.assign(priv, { kid: 'ec-1' })] };
  assert.equal((await run(token())).ok, true);
});

test('a header with crit or a non-JWT typ is refused', async () => {
  refused(await run(token({}, { header: { crit: ['exp'] } })), 401);
  refused(await run(token({}, { header: { typ: 'at+jwt+x' } })), 401);
  assert.equal((await run(token({}, { header: { typ: 'jwt' } }))).ok, true);
});

/* ---------------------------------------------------------- signature */

test('a changed payload or signature is refused', async () => {
  const good = token();
  const [h, , s] = good.split('.');
  const forged = `${h}.${b64(claims({ sub: '33333333-3333-4333-8333-333333333333' }))}.${s}`;
  refused(await run(forged), 401);
  assert.equal(lastReason(), 'bad_signature');

  const sig = Buffer.from(s, 'base64url');
  sig[10] ^= 1;
  refused(await run(`${good.split('.').slice(0, 2).join('.')}.${sig.toString('base64url')}`), 401);
  refused(await run(`${good.split('.').slice(0, 2).join('.')}.${b64('short')}`), 401);
});

test('a token signed by a different key with the same kid is refused', async () => {
  refused(await run(token({}, { pair: EC2 })), 401);
  assert.equal(lastReason(), 'bad_signature');
});

test('a signature over a payload that is not JSON is refused after verification', async () => {
  const header = b64({ alg: 'ES256', typ: 'JWT', kid: 'ec-1' });
  const payload = b64('not json');
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: EC.privateKey, dsaEncoding: 'ieee-p1363' });
  refused(await run(`${header}.${payload}.${sig.toString('base64url')}`), 401);
  assert.equal(lastReason(), 'malformed_token');
});

/* -------------------------------------------------------------- claims */

test('issuer must be exactly this project', async () => {
  for (const iss of [undefined, `${BASE}/auth/v1/`, `${BASE}/auth`, 'https://other-ref.supabase.co/auth/v1',
                     `${BASE.replace('https', 'http')}/auth/v1`, 'supabase', [ISSUER]]) {
    refused(await run(token({ iss })), 401);
    assert.equal(lastReason(), 'wrong_issuer', String(iss));
  }
});

test('audience must be authenticated', async () => {
  for (const aud of [undefined, 'anon', 'service_role', [], ['anon'], 'Authenticated']) {
    refused(await run(token({ aud })), 401);
    assert.equal(lastReason(), 'wrong_audience', JSON.stringify(aud));
  }
  assert.equal((await run(token({ aud: ['authenticated'] }))).ok, true);
});

test('role must be authenticated', async () => {
  for (const role of [undefined, 'anon', 'service_role', 'owner', 'supabase_admin']) {
    refused(await run(token({ role })), 401);
    assert.equal(lastReason(), 'wrong_role', String(role));
  }
});

test('expiry is required and enforced with a bounded skew', async () => {
  refused(await run(token({ exp: undefined })), 401);
  refused(await run(token({ exp: String(NOW + 60) })), 401);
  refused(await run(token({ exp: NOW - I.CLOCK_SKEW_SECONDS })), 401);
  assert.equal(lastReason(), 'expired');
  assert.equal((await run(token({ exp: NOW - I.CLOCK_SKEW_SECONDS + 1 }))).ok, true);
  refused(await run(token({ exp: NOW + 25 * 3600 })), 401);
  assert.equal(lastReason(), 'lifetime_too_long');
});

test('a token that expires while in use stops working', async () => {
  const tok = token({ exp: NOW + 120 });
  assert.equal((await run(tok)).ok, true);
  NOW += 120 + I.CLOCK_SKEW_SECONDS;
  refused(await run(tok), 401);
});

test('iat is required and may not be in the future; nbf may not be in the future', async () => {
  refused(await run(token({ iat: undefined })), 401);
  assert.equal(lastReason(), 'no_issued_at');
  refused(await run(token({ iat: NOW + I.CLOCK_SKEW_SECONDS + 1 })), 401);
  assert.equal(lastReason(), 'issued_in_future');
  assert.equal((await run(token({ iat: NOW + I.CLOCK_SKEW_SECONDS }))).ok, true);
  refused(await run(token({ nbf: NOW + I.CLOCK_SKEW_SECONDS + 1 })), 401);
  assert.equal(lastReason(), 'not_yet_valid');
  refused(await run(token({ nbf: 'soon' })), 401);
  assert.equal((await run(token({ nbf: NOW - 10 }))).ok, true);
});

test('the subject must be a UUID, so it cannot carry a PostgREST filter', async () => {
  for (const sub of [undefined, '', 'admin', `${OWNER_AUTH_ID}&role_code=eq.owner`, `${OWNER_AUTH_ID},or(active.eq.true)`,
                     'not-a-uuid-at-all-0000-000000000000', 12345]) {
    calls = [];
    refused(await run(token({ sub })), 401);
    assert.equal(lastReason(), 'bad_subject', String(sub));
    assert.equal(calls.some((c) => c.url.includes('/rest/v1/')), false);
  }
});

test('anonymous users are refused', async () => {
  refused(await run(token({ is_anonymous: true })), 401);
  assert.equal(lastReason(), 'anonymous_user');
  refused(await run(token({ is_anonymous: 'true' })), 401);
  assert.equal((await run(token({ is_anonymous: undefined }))).ok, true);
});

test('MFA (aal2) is required, and is checked before any staff lookup', async () => {
  for (const aal of [undefined, 'aal1', 'AAL2', 'aal3', 2]) {
    calls = [];
    const res = await run(token({ aal }));
    refused(res, 403, 'mfa_required');
    assert.equal(calls.some((c) => c.url.includes('/rest/v1/')), false, 'staff looked up before MFA');
  }
});

test('mfa_required is only said to a holder of an otherwise valid token', async () => {
  refused(await run(token({ aal: 'aal1', iss: 'https://evil.example/auth/v1' })), 401, 'not_authorized');
  refused(await run(token({ aal: 'aal1' }, { pair: EC2 })), 401, 'not_authorized');
});

/* ------------------------------------------------------------ staff */

test('unknown, inactive and not-allowed-role users are refused alike', async () => {
  for (const rows of [[], [ownerRow({ active: false })], [ownerRow({ active: null })], [ownerRow({ active: 'true' })],
                      [ownerRow({ role_code: 'test_readonly' })], [ownerRow({ role_code: 'fulfilment' })]]) {
    staffRows = rows;
    const res = await run(token());
    refused(res, 403);
    assert.equal(res.error, 'not_authorized');
  }
  assert.deepEqual(auth.ALLOWED_ROLES, ['owner']);
  assert.ok(Object.isFrozen(auth.ALLOWED_ROLES));
});

test('more than one staff row for a user fails closed', async () => {
  staffRows = [ownerRow(), ownerRow({ id: OTHER_STAFF_ID })];
  refused(await run(token()), 500);
  assert.equal(lastReason(), 'staff_lookup_ambiguous');
});

test('a malformed staff response fails closed', async () => {
  for (const rows of [null, {}, 'x', [ownerRow({ id: 'not-a-uuid' })], [ownerRow({ id: undefined })]]) {
    staffRows = rows;
    refused(await run(token()), 500);
  }
  staffRows = () => { throw new Error('bad json'); };
  refused(await run(token()), 500);
});

test('PostgREST errors and outages fail closed', async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    staffStatus = status;
    refused(await run(token()), 500);
    assert.equal(lastReason(), 'staff_lookup_http_error');
  }
  staffStatus = 200;
  failNext = (u) => u.includes('/rest/v1/');
  refused(await run(token()), 500);
  assert.equal(lastReason(), 'staff_lookup_unreachable');
});

/* ----------------------------------------------------- the key set */

test('the key set is cached between requests', async () => {
  await run(token());
  await run(token());
  await run(token({}, { alg: 'RS256', kid: 'rsa-1' }));
  assert.equal(calls.filter((c) => c.url === JWKS_URL).length, 1);
});

test('concurrent requests share one key set fetch', async () => {
  await Promise.all([run(token()), run(token()), run(token())]);
  assert.equal(calls.filter((c) => c.url === JWKS_URL).length, 1);
});

test('the key set is refetched once it is stale', async () => {
  await run(token());
  NOW += I.JWKS_TTL_MS / 1000;
  await run(token({ iat: NOW - 10, exp: NOW + 600 }));
  assert.equal(calls.filter((c) => c.url === JWKS_URL).length, 2);
});

test('key rotation: a new kid triggers a refetch, but not more than once a minute', async () => {
  await run(token());
  jwksBody = { keys: [jwk(EC, 'ec-1'), jwk(EC2, 'ec-2')] };

  // Within the minimum interval, an unknown kid is refused without a fetch.
  NOW += 10;
  refused(await run(token({ iat: NOW - 10, exp: NOW + 600 }, { kid: 'ec-2', pair: EC2 })), 401);
  assert.equal(calls.filter((c) => c.url === JWKS_URL).length, 1);

  // After it, the new key is fetched and accepted.
  NOW += I.JWKS_MIN_REFETCH_MS / 1000;
  const res = await run(token({ iat: NOW - 10, exp: NOW + 600 }, { kid: 'ec-2', pair: EC2 }));
  assert.equal(res.ok, true);
  assert.equal(calls.filter((c) => c.url === JWKS_URL).length, 2);

  // Random kids cannot make it fetch again inside the interval.
  for (let i = 0; i < 20; i++) await run(token({ iat: NOW - 10, exp: NOW + 600 }, { kid: `junk-${i}` }));
  assert.equal(calls.filter((c) => c.url === JWKS_URL).length, 2);
});

test('a key removed from the set stops working once the set is refreshed', async () => {
  assert.equal((await run(token())).ok, true);
  jwksBody = { keys: [jwk(EC2, 'ec-2')] };
  NOW += I.JWKS_TTL_MS / 1000;
  refused(await run(token({ iat: NOW - 10, exp: NOW + 600 })), 401);
  assert.equal(lastReason(), 'unknown_key');
});

test('an unreachable or broken key set fails closed', async () => {
  const cases = [
    () => { failNext = (u) => u === JWKS_URL; },
    () => { jwksStatus = 500; },
    () => { jwksStatus = 404; },
    () => { jwksBody = 'not json'; },
    () => { jwksBody = { nokeys: true }; },
    () => { jwksBody = 'x'.repeat(70 * 1024); }
  ];
  for (const setup of cases) {
    I.resetKeyCache();
    failNext = null; jwksStatus = 200; jwksBody = defaultKeys();
    setup();
    calls = [];
    refused(await run(token()), 500);
    assert.equal(calls.some((c) => c.url.includes('/rest/v1/')), false);
  }
});

test('a stale key set that cannot be refreshed fails closed rather than trusting old keys', async () => {
  assert.equal((await run(token())).ok, true);
  NOW += I.JWKS_TTL_MS / 1000;
  jwksStatus = 503;
  refused(await run(token({ iat: NOW - 10, exp: NOW + 600 })), 500);
});

/* ------------------------------------------------------ configuration */

test('missing or unsafe configuration fails closed without looking anything up', async () => {
  const cases = [
    { SUPABASE_URL: undefined },
    { SUPABASE_SERVICE_ROLE_KEY: undefined },
    { SUPABASE_URL: '' },
    { SUPABASE_SERVICE_ROLE_KEY: ' key ' },
    { SUPABASE_URL: 'http://test-ref.supabase.co' },
    { SUPABASE_URL: 'not a url' },
    { SUPABASE_URL: `${BASE}?x=1` },
    { SUPABASE_URL: 'https://user:pass@test-ref.supabase.co' }
  ];
  for (const env of cases) {
    process.env.SUPABASE_URL = BASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    calls = [];
    refused(await run(token()), 500);
    assert.equal(calls.length, 0, JSON.stringify(env));
  }
});

test('a trailing slash on SUPABASE_URL does not change the expected issuer', async () => {
  process.env.SUPABASE_URL = `${BASE}/`;
  assert.equal((await run(token())).ok, true);
});

test('an unexpected internal error fails closed', async () => {
  const orig = global.fetch;
  global.fetch = () => { throw new TypeError('boom'); };
  try {
    refused(await run(token()), 500);
  } finally {
    global.fetch = orig;
  }
});

/* ----------------------------------------------------- what leaves */

test('logs carry reason codes only: never the token, its signature or a key', async () => {
  const tok = token({ aal: 'aal1' });
  await run(tok);
  await run(token({}, { pair: EC2 }));
  staffRows = [];
  await run(token());
  staffStatus = 500;
  await run(token());
  const all = logs.join('\n');
  assert.ok(logs.length >= 4);
  for (const t of [tok, token(), tok.split('.')[2], tok.split('.')[1]]) assert.equal(all.includes(t), false);
  assert.equal(all.includes(SERVICE_KEY), false);
  assert.equal(all.includes(jwk(EC, 'ec-1').x), false);
  for (const line of logs) {
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).filter((k) => !['admin_auth', 'reason', 'user'].includes(k)), []);
  }
});

test('refusals are generic and the response helper carries nothing else', async () => {
  const bodies = new Set();
  for (const tok of [undefined, 'a.b.c', token({}, { pair: EC2 }), token({ iss: 'x' }), token({ exp: NOW - 999 })]) {
    const res = await run(tok);
    const r = auth.denialResponse(res);
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.headers['WWW-Authenticate'], 'Bearer');
    bodies.add(r.body);
  }
  assert.deepEqual([...bodies], ['{"error":"not_authorized"}']);
  staffRows = [];
  const r = auth.denialResponse(await run(token()));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body, '{"error":"not_authorized"}');
  assert.equal(r.headers['WWW-Authenticate'], undefined);
});

test('a successful result exposes no token, claims or key', async () => {
  const tok = token();
  const res = await run(tok);
  const text = JSON.stringify(res);
  assert.equal(text.includes(tok.split('.')[2]), false);
  assert.equal(text.includes(SERVICE_KEY), false);
  assert.deepEqual(Object.keys(res).sort(), ['ok', 'staff']);
});
