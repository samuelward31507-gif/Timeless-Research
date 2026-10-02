/* Operations console: what a screen does before it asks for data.

   signedIn(notice) resolves true when there is a session to make requests
   with. Otherwise it explains why in `notice` (a .console-view element),
   shows it, and resolves false, so the screen makes no request at all. As
   shipped there is no sign-in provider (auth.js), so this is what a screen
   shows until one is chosen. */
(function (w, d) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};

  function setSession(text) {
    var s = d.getElementById('console-session');
    if (s) s.textContent = text;
  }

  function signedIn(notice) {
    var auth = C.auth;
    var states = C.ui.states;
    if (!auth.hasProvider()) {
      setSession('Not signed in');
      states.empty(notice, 'Sign-in is not set up yet',
        'The console has no sign-in provider yet, so it cannot show business data.');
      notice.hidden = false;
      return Promise.resolve(false);
    }
    return auth.getAccessToken().then(function (token) {
      if (token) {
        setSession('Session available');
        notice.hidden = true;
        return true;
      }
      setSession('Not signed in');
      states.empty(notice, 'Not signed in', 'Sign in to see the business.');
      notice.hidden = false;
      return false;
    });
  }

  C.page = { signedIn: signedIn };
})(window, document);
