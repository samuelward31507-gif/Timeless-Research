/* Operations console: the one way the console talks to its API.

     TRConsole.api.requestAdmin('admin-orders', { params: { status: 'paid' } })
     TRConsole.api.requestAdmin('admin-orders', { action: 'order.add_note', fields: { order_id: '…', body: '…' } })

   resolves to the endpoint's JSON body, or rejects with a ConsoleError. The
   contract is the one the functions already implement (netlify/lib/admin-api.js
   and admin-auth.js; README, "Operations console"):

   - only the seven admin-* endpoints, at /.netlify/functions/<name>;
   - a read is a GET with query parameters; a write is a POST of
     {"action": …, …fields} as application/json, with no query string;
   - the only credential is Authorization: Bearer <token> from
     TRConsole.auth.getAccessToken(). No cookie is sent (credentials: omit),
     nothing is cached (cache: no-store), redirects are refused, and the token
     never goes into the URL, an error or a log. With no token nothing is
     sent at all: the call fails as a sign-in error straight away.

   A ConsoleError says what happened in a form the screens can switch on:

     kind         status  when
     signin       401     no session, or the server refused the token
     mfa          403     error mfa_required: a second factor is needed
     forbidden    403     not staff, or missing this permission
     invalid      400/405/413/415   a parameter or field the API refused
     not_found    404
     conflict     409     already exists
     retry        409     error retry: try again
     rejected     422     a rule refused the change
     unavailable  500, or an answer that is not JSON
     network      0       no answer: offline, timed out, or blocked

   .code is the API's error code; .field / .parameter name what was refused;
   .message is the API's own explanation, which it gives only for 404 and 422
   and only when it is one of the migrations' sentences written for the
   operator. Nothing else from a response reaches the error. */
(function (w) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};

  var BASE = '/.netlify/functions/';
  var ENDPOINTS = ['admin-dashboard', 'admin-orders', 'admin-inventory', 'admin-expenses',
    'admin-financials', 'admin-customers', 'admin-audit'];
  var TIMEOUT_MS = 20000;

  function ConsoleError(kind, status, body) {
    body = body || {};
    this.name = 'ConsoleError';
    this.kind = kind;
    this.status = status;
    this.code = typeof body.error === 'string' ? body.error : null;
    this.field = typeof body.field === 'string' ? body.field : null;
    this.parameter = typeof body.parameter === 'string' ? body.parameter : null;
    this.message = (status === 404 || status === 422) && typeof body.message === 'string' ? body.message : '';
  }
  ConsoleError.prototype = Object.create(Error.prototype);
  ConsoleError.prototype.constructor = ConsoleError;

  function kindFor(status, code) {
    if (status === 401) return 'signin';
    if (status === 403) return code === 'mfa_required' ? 'mfa' : 'forbidden';
    if (status === 400 || status === 405 || status === 413 || status === 415) return 'invalid';
    if (status === 404) return 'not_found';
    if (status === 409) return code === 'retry' ? 'retry' : 'conflict';
    if (status === 422) return 'rejected';
    return 'unavailable';
  }

  function query(params) {
    var parts = [];
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
      var v = params[keys[i]];
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function requestAdmin(endpoint, opts) {
    opts = opts || {};
    if (ENDPOINTS.indexOf(endpoint) === -1) {
      return Promise.reject(new TypeError('unknown console endpoint'));
    }
    var write = opts.action !== undefined;
    if (write && opts.params) return Promise.reject(new TypeError('a write takes no query parameters'));
    if (write && typeof opts.action !== 'string') return Promise.reject(new TypeError('action must be a string'));

    return C.auth.getAccessToken().then(function (token) {
      if (!token) {
        C.auth.signInRequired({ endpoint: endpoint });
        throw new ConsoleError('signin', 401, { error: 'not_authorized' });
      }
      var headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
      var init = { method: write ? 'POST' : 'GET', headers: headers, cache: 'no-store',
                   credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };
      if (write) {
        headers['Content-Type'] = 'application/json';
        var body = {};
        var f = opts.fields || {};
        Object.keys(f).forEach(function (k) { body[k] = f[k]; });
        body.action = opts.action;
        init.body = JSON.stringify(body);
      }
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null;
      if (controller) {
        init.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      }
      var url = BASE + endpoint + (write ? '' : query(opts.params));
      return fetch(url, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (res.ok) {
            if (data === null || typeof data !== 'object') throw new ConsoleError('unavailable', res.status, {});
            return data;
          }
          var err = new ConsoleError(kindFor(res.status, data && data.error), res.status, data || {});
          if (err.kind === 'signin') C.auth.signInRequired({ endpoint: endpoint });
          if (err.kind === 'mfa') C.auth.mfaRequired({ endpoint: endpoint });
          throw err;
        });
      }, function () {
        throw new ConsoleError('network', 0, {});
      }).then(function (data) {
        if (timer) clearTimeout(timer);
        return data;
      }, function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
    });
  }

  C.api = { requestAdmin: requestAdmin, ConsoleError: ConsoleError, ENDPOINTS: ENDPOINTS.slice() };
})(window);
