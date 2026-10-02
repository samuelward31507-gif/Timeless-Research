/*
 * Who is calling the operations console: the authentication foundation.
 *
 * Every console endpoint will start with authenticateStaff(event). It answers
 * one question — which staff member, if any, is making this request — from a
 * Supabase Auth access token and nothing else:
 *
 *   1. The token is taken from the Authorization: Bearer header only. Nothing
 *      in the body, the query string, a cookie or any other header can name
 *      the caller.
 *   2. Its signature is checked against the project's published signing keys
 *      (ES256 or RS256, matched by kid, fetched from Supabase Auth's JWKS
 *      endpoint). There is deliberately no shared-secret (HS256) path: a
 *      token's own header never chooses how it is verified, so the classic
 *      "alg: none" and "sign with the public key as an HMAC secret" forgeries
 *      have nothing to work with.
 *   3. Its claims must say it was issued by this project's Auth server, for a
 *      signed-in (not anonymous) user, is in date, and that the user passed a
 *      second factor (aal2). MFA is enforced here, on every request, whatever
 *      the dashboard settings say.
 *   4. The verified user id is looked up in staff_members on every request,
 *      with the service role key, which never leaves the server. Unknown,
 *      inactive or not-allowed-role users are refused; deactivating someone
 *      takes effect on their next request, not when their token expires.
 *
 * The staff member's id returned here is the only value the console may pass
 * to the database functions as the acting user (p_actor). It comes from
 * staff_members.id for the row whose auth_user_id is the verified token's
 * subject, and from nowhere else.
 *
 * Failure is always closed and always vague: a bad token, a forged one and a
 * non-staff user all get "not_authorized"; missing configuration or an
 * unreachable key set or database gets "unavailable" — never access. The log
 * records a reason code, never the token or any key.
 *
 * No npm dependency, like the other functions: Node has crypto and fetch.
 */
'use strict';

const crypto = require('crypto');

// Roles allowed into the console at all. Owner only for now; the database
// still checks each action's permission through app_require/staff_can.
const ALLOWED_ROLES = Object.freeze(['owner']);

const ALGORITHMS = Object.freeze({
  ES256: { kty: 'EC', crv: 'P-256', signatureBytes: 64 },
  RS256: { kty: 'RSA', minModulusBits: 2048 }
});

const MAX_HEADER_BYTES = 8192;          // Authorization header, token included
const CLOCK_SKEW_SECONDS = 30;          // tolerance on exp, nbf and iat
const MAX_LIFETIME_SECONDS = 24 * 3600; // longer-lived tokens are refused outright
const JWKS_TTL_MS = 10 * 60 * 1000;     // how long a fetched key set is trusted
const JWKS_MIN_REFETCH_MS = 60 * 1000;  // an unknown kid cannot force fetches faster than this
const JWKS_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const AUDIENCE = 'authenticated';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i;

const clock = { now: () => Date.now() };

/* ---------------------------------------------------------------- results */

class AuthFailure extends Error {
  constructor(status, error, reason) {
    super(reason);
    this.status = status;
    this.error = error;
    this.reason = reason;
  }
}

const deny = (reason) => new AuthFailure(401, 'not_authorized', reason);
const forbid = (reason) => new AuthFailure(403, 'not_authorized', reason);
const unavailable = (reason) => new AuthFailure(500, 'unavailable', reason);

/* Reason codes and, for staff-level refusals, the user id. Never the token,
   never a key, never a response body from Supabase. */
function log(reason, extra) {
  console.warn(JSON.stringify(Object.assign({ admin_auth: 'denied', reason }, extra || {})));
}

/* ------------------------------------------------------------ configuration */

function config() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key || rawUrl !== rawUrl.trim() || key !== key.trim()) throw unavailable('not_configured');
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw unavailable('not_configured');
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    throw unavailable('not_configured');
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return {
    base,
    key,
    issuer: `${base}/auth/v1`,
    jwksUrl: `${base}/auth/v1/.well-known/jwks.json`
  };
}

/* ---------------------------------------------------------------- the token */

function bearerToken(event) {
  const headers = (event && event.headers) || {};
  const values = Object.keys(headers)
    .filter((k) => k.toLowerCase() === 'authorization')
    .map((k) => headers[k]);
  const multi = (event && event.multiValueHeaders) || {};
  for (const k of Object.keys(multi)) {
    if (k.toLowerCase() === 'authorization') values.push(...[].concat(multi[k]));
  }
  const distinct = [...new Set(values)];
  if (distinct.length === 0) throw deny('no_token');
  if (distinct.length > 1) throw deny('ambiguous_authorization');
  const value = distinct[0];
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_HEADER_BYTES) throw deny('token_too_large');
  const m = BEARER.exec(value);
  if (!m) throw deny('malformed_token');
  return { header: m[1], payload: m[2], signature: m[3] };
}

function decodeJson(segment, reason) {
  let value;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch (e) {
    throw deny(reason);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw deny(reason);
  return value;
}

/* ----------------------------------------------------------- signing keys */

const jwks = { url: null, keys: null, fetchedAt: 0, inflight: null };

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/* Only the public parts of a key are ever imported, and only keys that are
   unambiguously signing keys of a supported type. A kid that appears twice is
   dropped entirely rather than guessed at. */
function importKeys(body) {
  if (!body || !Array.isArray(body.keys)) throw unavailable('jwks_malformed');
  const byKid = new Map();
  const duplicated = new Set();
  for (const jwk of body.keys) {
    if (!jwk || typeof jwk !== 'object' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) continue;
    let pub;
    try {
      if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
        pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
      } else if (jwk.kty === 'RSA') {
        pub = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      } else {
        continue;
      }
    } catch (e) {
      continue;
    }
    if (byKid.has(jwk.kid)) duplicated.add(jwk.kid);
    byKid.set(jwk.kid, { kty: jwk.kty, alg: jwk.alg, key: pub });
  }
  for (const kid of duplicated) byKid.delete(kid);
  return byKid;
}

async function loadKeys(cfg) {
  if (jwks.inflight) return jwks.inflight;
  jwks.inflight = (async () => {
    let res;
    try {
      res = await fetchWithTimeout(cfg.jwksUrl, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw unavailable('jwks_unreachable');
    }
    if (!res || !res.ok) throw unavailable('jwks_http_error');
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw unavailable('jwks_unreachable');
    }
    if (typeof text !== 'string' || text.length > JWKS_MAX_BYTES) throw unavailable('jwks_malformed');
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw unavailable('jwks_malformed');
    }
    const keys = importKeys(body);
    jwks.url = cfg.jwksUrl;
    jwks.keys = keys;
    jwks.fetchedAt = clock.now();
    return keys;
  })();
  try {
    return await jwks.inflight;
  } finally {
    jwks.inflight = null;
  }
}

/* The key for this kid: from the cache while it is fresh; refetched when it
   has expired, or once (rate limited) when the kid is new — which is what a
   key rotation looks like. If the key set cannot be fetched when it is
   needed, nothing is verified. */
async function keyFor(cfg, kid) {
  const now = clock.now();
  const sameSource = jwks.url === cfg.jwksUrl && jwks.keys;
  if (!sameSource || now - jwks.fetchedAt >= JWKS_TTL_MS) {
    return (await loadKeys(cfg)).get(kid) || null;
  }
  const cached = jwks.keys.get(kid);
  if (cached) return cached;
  if (now - jwks.fetchedAt < JWKS_MIN_REFETCH_MS) return null;
  return (await loadKeys(cfg)).get(kid) || null;
}

/* ---------------------------------------------------------- verification */

function verifySignature(alg, entry, signingInput, signature) {
  const spec = ALGORITHMS[alg];
  if (entry.kty !== spec.kty) return false;
  if (entry.alg !== undefined && entry.alg !== alg) return false;
  const details = entry.key.asymmetricKeyDetails || {};
  try {
    if (alg === 'ES256') {
      if (details.namedCurve !== 'prime256v1' || signature.length !== spec.signatureBytes) return false;
      return crypto.verify('sha256', signingInput, { key: entry.key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    if (!(details.modulusLength >= spec.minModulusBits)) return false;
    return crypto.verify('sha256', signingInput, { key: entry.key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  } catch (e) {
    return false;
  }
}

function isNumericDate(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkClaims(claims, cfg) {
  const now = Math.floor(clock.now() / 1000);
  if (claims.iss !== cfg.issuer) throw deny('wrong_issuer');
  const aud = claims.aud;
  const audOk = aud === AUDIENCE || (Array.isArray(aud) && aud.length > 0 && aud.includes(AUDIENCE));
  if (!audOk) throw deny('wrong_audience');
  if (claims.role !== 'authenticated') throw deny('wrong_role');
  if (!isNumericDate(claims.exp)) throw deny('no_expiry');
  if (now >= claims.exp + CLOCK_SKEW_SECONDS) throw deny('expired');
  if (claims.exp - now > MAX_LIFETIME_SECONDS) throw deny('lifetime_too_long');
  if (!isNumericDate(claims.iat)) throw deny('no_issued_at');
  if (claims.iat > now + CLOCK_SKEW_SECONDS) throw deny('issued_in_future');
  if (claims.nbf !== undefined && (!isNumericDate(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS)) {
    throw deny('not_yet_valid');
  }
  if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) throw deny('bad_subject');
  if (claims.is_anonymous !== undefined && claims.is_anonymous !== false) throw deny('anonymous_user');
  // Checked last among the claims, so "mfa_required" is only ever said to the
  // holder of an otherwise valid token, and before anything about staff.
  if (claims.aal !== 'aal2') throw new AuthFailure(403, 'mfa_required', 'mfa_required');
}

async function verifyToken(event, cfg) {
  const parts = bearerToken(event);
  const header = decodeJson(parts.header, 'malformed_token');
  if (header.crit !== undefined) throw deny('unsupported_header');
  if (header.typ !== undefined && String(header.typ).toUpperCase() !== 'JWT') throw deny('unsupported_header');
  const alg = header.alg;
  if (typeof alg !== 'string' || !Object.prototype.hasOwnProperty.call(ALGORITHMS, alg)) throw deny('unsupported_algorithm');
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) throw deny('no_key_id');

  const entry = await keyFor(cfg, header.kid);
  if (!entry) throw deny('unknown_key');

  const signingInput = Buffer.from(`${parts.header}.${parts.payload}`, 'ascii');
  const signature = Buffer.from(parts.signature, 'base64url');
  if (!verifySignature(alg, entry, signingInput, signature)) throw deny('bad_signature');

  // Only now is the payload trusted enough to read.
  const claims = decodeJson(parts.payload, 'malformed_token');
  checkClaims(claims, cfg);
  return claims;
}

/* ---------------------------------------------------------- staff lookup */

/* The service role reads staff_members (0004 leaves it read access and no
   write access). The filter value is the verified subject, already proven to
   be a UUID, so it cannot carry PostgREST syntax. */
async function lookupStaff(cfg, authUserId) {
  const url = `${cfg.base}/rest/v1/staff_members` +
    `?select=id,auth_user_id,email,display_name,role_code,active` +
    `&auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=2`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' }
    });
  } catch (e) {
    throw unavailable('staff_lookup_unreachable');
  }
  if (!res || !res.ok) throw unavailable('staff_lookup_http_error');
  let rows;
  try {
    rows = await res.json();
  } catch (e) {
    throw unavailable('staff_lookup_malformed');
  }
  if (!Array.isArray(rows)) throw unavailable('staff_lookup_malformed');
  if (rows.length > 1) throw unavailable('staff_lookup_ambiguous');
  const row = rows[0];
  if (!row) throw forbid('not_staff');
  if (row.auth_user_id !== authUserId || typeof row.id !== 'string' || !UUID.test(row.id)) {
    throw unavailable('staff_lookup_malformed');
  }
  if (row.active !== true) throw forbid('staff_inactive');
  if (!ALLOWED_ROLES.includes(row.role_code)) throw forbid('role_not_allowed');
  return row;
}

/* ------------------------------------------------------------------ entry */

/* Resolves to { ok: true, staff: { id, email, displayName, role } } or
   { ok: false, status, error }. staff.id is the acting staff member for every
   database call this request makes. */
async function authenticateStaff(event) {
  let claims = null;
  try {
    const cfg = config();
    claims = await verifyToken(event, cfg);
    const row = await lookupStaff(cfg, claims.sub);
    return {
      ok: true,
      staff: Object.freeze({
        id: row.id,
        email: row.email,
        displayName: row.display_name || null,
        role: row.role_code
      })
    };
  } catch (e) {
    if (!(e instanceof AuthFailure)) {
      log('internal_error');
      return { ok: false, status: 500, error: 'unavailable' };
    }
    log(e.reason, claims && e.status !== 401 ? { user: claims.sub } : null);
    return { ok: false, status: e.status, error: e.error };
  }
}

/* The response for a refusal, for handlers to return as-is. */
function denialResponse(result) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (result.status === 401) headers['WWW-Authenticate'] = 'Bearer';
  return { statusCode: result.status, headers, body: JSON.stringify({ error: result.error }) };
}

module.exports = {
  authenticateStaff,
  denialResponse,
  ALLOWED_ROLES,
  _internals: {
    clock,
    resetKeyCache() {
      jwks.url = null; jwks.keys = null; jwks.fetchedAt = 0; jwks.inflight = null;
    },
    CLOCK_SKEW_SECONDS,
    JWKS_TTL_MS,
    JWKS_MIN_REFETCH_MS,
    MAX_HEADER_BYTES
  }
};
