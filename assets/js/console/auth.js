/* Operations console: the authentication seam.

   The console does not know how staff sign in. That is deliberately
   undecided, so nothing here talks to any identity provider. A provider, once
   one is chosen, registers a single function with setTokenProvider() that
   resolves to the current access token, or to null when nobody is signed in;
   everything else in the console asks getAccessToken() and never sees how the
   token was obtained.

   The server reads exactly one credential, the Authorization: Bearer header
   (netlify/lib/admin-auth.js), so the token is only ever:
     - held in memory, by whatever provider supplies it;
     - put in that header by api.js.
   Never in localStorage, sessionStorage, a cookie, a URL or a log. A value
   that is not a plain bearer token is treated as no session at all.

   The provider is set once; a second call is refused, so a later script
   cannot swap in its own. Until one is set the console has no session, which
   is the state it ships in.

   onSignInRequired / onMfaRequired register what to do when the server says
   the session is missing or expired (401) or needs a second factor (403
   mfa_required). api.js calls signInRequired() / mfaRequired(); the shell
   shows a notice; a provider can also listen and start its own flow. */
(function (w) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};

  // RFC 6750 b64token: what can go in a bearer header without escaping.
  var TOKEN = /^[A-Za-z0-9\-._~+\/]+=*$/;
  var MAX_TOKEN = 8000;

  var provider = null;
  var listeners = { signin: [], mfa: [] };

  function notify(kind, detail) {
    var list = listeners[kind].slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](detail); } catch (e) { /* one listener must not stop the others */ }
    }
  }

  C.auth = {
    setTokenProvider: function (fn) {
      if (typeof fn !== 'function') throw new TypeError('setTokenProvider needs a function');
      if (provider) throw new Error('a token provider is already set');
      provider = fn;
    },

    hasProvider: function () { return provider !== null; },

    /* Resolves to the bearer token, or null: no provider, nobody signed in,
       a provider that failed, or a value that is not a bearer token. Never
       rejects. */
    getAccessToken: function () {
      if (!provider) return Promise.resolve(null);
      return Promise.resolve()
        .then(function () { return provider(); })
        .then(function (t) {
          return typeof t === 'string' && t.length <= MAX_TOKEN && TOKEN.test(t) ? t : null;
        }, function () { return null; });
    },

    onSignInRequired: function (fn) { if (typeof fn === 'function') listeners.signin.push(fn); },
    onMfaRequired: function (fn) { if (typeof fn === 'function') listeners.mfa.push(fn); },
    signInRequired: function (detail) { notify('signin', detail || {}); },
    mfaRequired: function (detail) { notify('mfa', detail || {}); }
  };
})(window);
