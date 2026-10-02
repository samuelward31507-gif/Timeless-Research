/*
 * The operations console, offline: a local server for building and testing
 * the console UI without Supabase, Neon, a payment provider, an identity
 * provider or any other service. Test and development only; never deployed.
 *
 *   node tests/console/server.mjs [--port 4317] [--test]
 *
 * It serves:
 *
 *   /console/*, /assets/*      the built files (run python3 tools/build.py
 *                              first), with the headers netlify.toml gives
 *                              them, read from netlify.toml itself
 *   /.netlify/functions/admin-*
 *                              the REAL handlers from netlify/functions, run
 *                              in this process on tests/helpers/admin-fixtures.js:
 *                              a fake key set, staff lookup, staff_can and
 *                              canned PostgREST rows, all answered in memory.
 *                              There is no second API implementation here.
 *   /__dev/token               a token the fixture signed with its own
 *                              throwaway key (never a real credential)
 *   /__dev/console-dev.js      registers that token with the console's auth
 *                              seam; injected into console pages only while
 *                              the dev session is on
 *   /__test/*                  controls for the browser tests: fixture state,
 *                              token mode, dev session on or off, call log
 *
 * Nothing else in the repository is served. It listens on 127.0.0.1 only,
 * and the fixture's fetch stub throws on any URL it does not recognise, so
 * no request can leave the machine.
 *
 * Without --test the dev session starts on, so the console opens with a
 * session and the fixture's default data (none) for building screens.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

// The fixture points SUPABASE_URL at a fake host and replaces global.fetch
// with its in-memory stub. Never a real project, never a real key.
delete process.env.DATABASE_URL;
const fx = require(path.join(ROOT, 'tests', 'helpers', 'admin-fixtures.js'));

const ENDPOINTS = ['admin-dashboard', 'admin-orders', 'admin-inventory', 'admin-expenses',
  'admin-financials', 'admin-customers', 'admin-audit'];
const HANDLERS = Object.fromEntries(ENDPOINTS.map((n) => [n, require(path.join(ROOT, 'netlify', 'functions', `${n}.js`)).handler]));

const args = process.argv.slice(2);
const PORT = Number((args[args.indexOf('--port') + 1]) || 4317) || 4317;
const TEST = args.includes('--test');

/* ----------------------------------------------------------- netlify.toml */

/* The [[headers]] blocks, in file order: { pattern, values }. */
function netlifyHeaders() {
  const text = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const blocks = [];
  for (const chunk of text.split('[[headers]]').slice(1)) {
    const pattern = /for\s*=\s*"([^"]+)"/.exec(chunk);
    const values = {};
    const body = chunk.split('[headers.values]')[1] || '';
    for (const line of body.split('\n')) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"/.exec(line);
      if (m) values[m[1]] = m[2];
    }
    if (pattern) blocks.push({ pattern: pattern[1], values });
  }
  return blocks;
}

function matches(pattern, pathname) {
  if (pattern.startsWith('/*.')) return pathname.endsWith(pattern.slice(2));
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

/* Every matching block applies; a later, more specific block wins on the
   same header (the console's no-store over the pages' revalidate). */
function headersFor(pathname) {
  const out = {};
  for (const b of netlifyHeaders()) if (matches(b.pattern, pathname)) Object.assign(out, b.values);
  return out;
}

/* ---------------------------------------------------------------- state */

const state = { devSession: !TEST, tokenMode: 'valid', calls: [] };

function devToken() {
  const now = Math.floor(Date.now() / 1000);
  switch (state.tokenMode) {
    case 'none': return null;
    case 'garbage': return 'not a bearer token!';
    case 'expired': return fx.token({ iat: now - 7200, exp: now - 3600 });
    case 'aal1': return fx.token({ aal: 'aal1' });
    default: return fx.token();
  }
}

function applyState(body) {
  if (body.reset) {
    fx.reset();
    state.devSession = !TEST;
    state.tokenMode = 'valid';
    state.calls = [];
  }
  if (body.permissions) fx.state.permissions = new Set(body.permissions);
  for (const k of ['tables', 'errors', 'rpc', 'rpcErrors']) if (body[k]) fx.state[k] = body[k];
  if (typeof body.down === 'boolean') fx.state.down = body.down;
  if (typeof body.devSession === 'boolean') state.devSession = body.devSession;
  if (typeof body.tokenMode === 'string') state.tokenMode = body.tokenMode;
}

const DEV_SCRIPT = `/* Offline development only (tests/console/server.mjs); never deployed. */
(function () {
  'use strict';
  window.TRConsole.auth.setTokenProvider(function () {
    return fetch('/__dev/token', { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return j.token; });
  });
})();
`;

/* ---------------------------------------------------------------- serving */

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveFunction(req, res, name, url) {
  const body = await readBody(req);
  const single = {};
  const multi = {};
  for (const [k, v] of url.searchParams) {
    single[k] = v;
    (multi[k] = multi[k] || []).push(v);
  }
  state.calls.push({ endpoint: name, method: req.method, search: url.search,
                     authorization: req.headers.authorization ? req.headers.authorization.split(' ')[0] : null,
                     cookie: req.headers.cookie !== undefined });
  const result = await HANDLERS[name]({
    httpMethod: req.method,
    headers: Object.assign({}, req.headers),
    queryStringParameters: url.search ? single : null,
    multiValueQueryStringParameters: url.search ? multi : null,
    body: body || null,
    isBase64Encoded: false
  });
  send(res, result.statusCode, result.headers || {}, result.body || '');
}

function serveFile(res, pathname) {
  const allowed = pathname.startsWith('/console/') || pathname.startsWith('/assets/');
  const file = path.resolve(ROOT, '.' + decodeURIComponent(pathname));
  const inside = file.startsWith(path.join(ROOT, 'console') + path.sep) || file.startsWith(path.join(ROOT, 'assets') + path.sep);
  if (!allowed || !inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
  }
  let body = fs.readFileSync(file);
  if (state.devSession && file.endsWith('.html') && pathname.startsWith('/console/')) {
    // After auth.js, so the provider is registered before the shell starts.
    body = Buffer.from(body.toString('utf8').replace(
      /(<script src="[^"]*assets\/js\/console\/auth\.js[^"]*" defer><\/script>)/,
      '$1\n<script src="/__dev/console-dev.js" defer></script>'));
  }
  const headers = Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }, headersFor(pathname));
  send(res, 200, headers, body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const fn = /^\/\.netlify\/functions\/([a-z-]+)$/.exec(p);
    if (fn) {
      if (!HANDLERS[fn[1]]) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
      return await serveFunction(req, res, fn[1], url);
    }
    if (p === '/') return send(res, 302, { Location: '/console/index.html' }, '');
    if (p === '/__dev/token') {
      return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify({ token: devToken() }));
    }
    if (p === '/__dev/console-dev.js') {
      return send(res, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }, DEV_SCRIPT);
    }
    if (p === '/__test/health') return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok');
    if (p === '/__test/state' && req.method === 'POST') {
      applyState(JSON.parse((await readBody(req)) || '{}'));
      return send(res, 204, {}, '');
    }
    if (p === '/__test/calls') {
      return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(state.calls));
    }
    return serveFile(res, p);
  } catch (e) {
    send(res, 500, { 'Content-Type': 'text/plain' }, 'dev server error');
  }
});

if (!fs.existsSync(path.join(ROOT, 'console', 'index.html'))) {
  console.error('console/index.html is missing: run python3 tools/build.py first.');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`console (offline): http://127.0.0.1:${PORT}/console/index.html${TEST ? ' [test mode]' : ''}`);
});
