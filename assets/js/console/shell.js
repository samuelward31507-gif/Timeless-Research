/* Operations console: the shell around every screen.

   - The navigation is in the page already (tools/console_build.py), complete
     without JavaScript. On a narrow screen it collapses behind the Menu
     button: the button says whether it is open (aria-expanded), Escape closes
     it and puts focus back on the button.
   - The session line in the header and the alert under it answer the auth
     seam (auth.js): no provider, a session, a session the server refused
     (sign-in required), or one that needs a second factor.
   - The overview page shows the session state. There are no business screens
     yet; each one, when it is built, starts from TRConsole.ready(). */
(function (w, d) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};
  var ui = C.ui;
  var auth = C.auth;
  var queue = [];
  var started = false;

  C.ready = function (fn) {
    if (started) fn(C);
    else queue.push(fn);
  };

  /* ------------------------------------------------------------- navigation */

  function setupNav() {
    var btn = d.getElementById('console-menu-btn');
    var nav = d.getElementById('console-nav');
    if (!btn || !nav) return;
    function setOpen(isOpen) {
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      nav.classList.toggle('is-open', isOpen);
    }
    btn.addEventListener('click', function () {
      setOpen(btn.getAttribute('aria-expanded') !== 'true');
    });
    d.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || btn.getAttribute('aria-expanded') !== 'true') return;
      if (d.querySelector('dialog[open]')) return;
      setOpen(false);
      btn.focus();
    });
    // Collapsed is the default; a wide screen shows the navigation whatever
    // the button says, so returning to a narrow one starts closed again.
    if (w.matchMedia) {
      var wide = w.matchMedia('(min-width: 861px)');
      var reset = function () { if (wide.matches) setOpen(false); };
      if (wide.addEventListener) wide.addEventListener('change', reset);
    }
  }

  /* ---------------------------------------------------------------- session */

  function showAlert(text) {
    var a = d.getElementById('console-alert');
    if (!a) return;
    a.textContent = text;
    a.hidden = false;
  }

  function setSession(text) {
    var s = d.getElementById('console-session');
    if (s) s.textContent = text;
  }

  function setupSession() {
    auth.onSignInRequired(function () {
      setSession('Not signed in');
      showAlert('Sign-in required. Your session has ended or has not started.');
    });
    auth.onMfaRequired(function () {
      showAlert('A second factor is required for this session.');
    });
  }

  /* --------------------------------------------------------------- overview */

  function overview() {
    var node = d.getElementById('console-status');
    if (!node) return;
    if (!auth.hasProvider()) {
      setSession('Not signed in');
      ui.states.empty(node, 'Sign-in is not set up yet',
        'The console has no sign-in provider. Its screens and sign-in are built in later phases.');
      return;
    }
    ui.states.loading(node, 'Checking for a session…');
    auth.getAccessToken().then(function (token) {
      if (token) {
        setSession('Session available');
        ui.states.empty(node, 'A session is available', 'The console’s screens are built in a later phase.');
      } else {
        setSession('Not signed in');
        ui.states.empty(node, 'Not signed in', 'Sign in to use the console.');
      }
    });
  }

  function start() {
    setupNav();
    setupSession();
    if (d.body.getAttribute('data-console-page') === 'overview') overview();
    started = true;
    var fns = queue.splice(0);
    for (var i = 0; i < fns.length; i++) fns[i](C);
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start);
  else start();
})(window, document);
