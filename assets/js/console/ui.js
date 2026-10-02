/* Operations console: the shared pieces every screen is built from.

   Everything here builds DOM nodes and writes text with textContent. Nothing
   is ever parsed as HTML: the console shows names, addresses, notes and audit
   details that customers and staff typed, so a string is always just text
   (the same rule as the support assistant, assets/js/chat.js). el() refuses
   the properties and attributes that would undo that.

     el(tag, props, children)        build an element
     states.loading(node, label)     a busy placeholder
     states.empty(node, title, hint) nothing to show
     states.error(node, err, retry)  a ConsoleError, explained, with a retry
     confirm(opts) -> Promise        the confirmation dialog
     toast(text)                     a short status message */
(function (w, d) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};

  var REFUSED = /^(innerHTML|outerHTML|insertAdjacentHTML|srcdoc|style|on.*)$/i;

  function el(tag, props, children) {
    var node = d.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (REFUSED.test(k)) throw new Error('el(): ' + k + ' is not allowed');
      if (k === 'text') node.textContent = String(v);
      else if (k === 'className') node.className = String(v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? d.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* ----------------------------------------------------------------- states */

  function setState(node, state, children) {
    clear(node);
    node.setAttribute('data-state', state);
    if (state === 'loading') node.setAttribute('aria-busy', 'true');
    else node.removeAttribute('aria-busy');
    [].concat(children).forEach(function (c) { node.appendChild(c); });
  }

  // What to tell the operator for each kind of ConsoleError (api.js). Fixed
  // sentences: nothing from the response is shown except the API's own
  // message for 404 and 422, and the name of a refused field or parameter.
  var EXPLAIN = {
    signin: ['Sign-in required', 'Your session has ended or has not started. Sign in to continue.'],
    mfa: ['Second factor required', 'This session has not passed a second factor. Complete it to continue.'],
    forbidden: ['Not available to you', 'Your account does not have access to this.'],
    invalid: ['That request was refused', 'Something in it was not accepted.'],
    not_found: ['Not found', 'It may have been removed, or the link is out of date.'],
    conflict: ['Already exists', 'That already exists.'],
    retry: ['Please try again', 'Someone else changed this at the same moment.'],
    rejected: ['Not allowed', 'The change was refused.'],
    unavailable: ['Unavailable', 'The console could not reach its data. Try again shortly.'],
    network: ['No connection', 'The request did not get an answer. Check the connection and try again.']
  };

  var states = {
    loading: function (node, label) {
      setState(node, 'loading', el('p', { className: 'console-state-text', text: label || 'Loading…' }));
    },
    empty: function (node, title, hint) {
      setState(node, 'empty', [
        el('p', { className: 'console-state-title', text: title || 'Nothing here yet' }),
        hint ? el('p', { className: 'console-state-text', text: hint }) : null
      ].filter(Boolean));
    },
    error: function (node, err, retry) {
      var kind = err && EXPLAIN[err.kind] ? err.kind : 'unavailable';
      var words = EXPLAIN[kind];
      var detail = words[1];
      if (err && err.message && (kind === 'not_found' || kind === 'rejected')) detail = err.message;
      var which = err && (err.field || err.parameter);
      var parts = [
        el('p', { className: 'console-state-title', text: words[0] }),
        el('p', { className: 'console-state-text', text: detail }),
        which ? el('p', { className: 'console-state-text', text: 'Refused: ' + which }) : null
      ];
      if (typeof retry === 'function' && kind !== 'forbidden' && kind !== 'not_found') {
        var b = el('button', { type: 'button', className: 'btn btn--ghost btn--sm', text: 'Try again' });
        b.addEventListener('click', function () { retry(); });
        parts.push(b);
      }
      setState(node, 'error', parts.filter(Boolean));
      node.setAttribute('data-error-kind', kind);
    }
  };

  /* ----------------------------------------------------------------- dialog */

  /* confirm({ title, body, confirmLabel, danger, reason: { label, max } })
     resolves to { confirmed: true, reason } or { confirmed: false }. Uses the
     page's <dialog id="console-confirm">: modal, so focus stays inside it and
     Escape cancels; focus starts on Cancel (or the reason box) and returns to
     whatever opened it. With a reason, Confirm stays disabled until one is
     typed. One dialog at a time: a second call while one is open is refused. */
  var open = false;

  function confirm(opts) {
    opts = opts || {};
    var dlg = d.getElementById('console-confirm');
    if (!dlg || typeof dlg.showModal !== 'function') return Promise.reject(new Error('no confirmation dialog on this page'));
    if (open) return Promise.reject(new Error('a confirmation is already open'));
    open = true;

    var title = d.getElementById('console-confirm-title');
    var body = d.getElementById('console-confirm-body');
    var wrap = d.getElementById('console-confirm-reason-wrap');
    var label = d.getElementById('console-confirm-reason-label');
    var reason = d.getElementById('console-confirm-reason');
    var ok = d.getElementById('console-confirm-ok');
    var cancel = d.getElementById('console-confirm-cancel');
    var form = d.getElementById('console-confirm-form');
    var opener = d.activeElement;

    title.textContent = opts.title || 'Confirm';
    body.textContent = opts.body || '';
    ok.textContent = opts.confirmLabel || 'Confirm';
    ok.className = 'btn btn--sm ' + (opts.danger ? 'btn--danger' : 'btn--primary');
    var needReason = !!opts.reason;
    wrap.hidden = !needReason;
    reason.value = '';
    if (needReason) {
      label.textContent = opts.reason.label || 'Reason';
      reason.maxLength = opts.reason.max || 1000;
    }
    function sync() { ok.disabled = needReason && reason.value.trim() === ''; }
    sync();

    return new Promise(function (resolve) {
      function done(confirmed) {
        reason.removeEventListener('input', sync);
        form.removeEventListener('submit', onSubmit);
        cancel.removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onEscape);
        dlg.removeEventListener('keydown', onKey);
        if (dlg.open) dlg.close();
        open = false;
        if (opener && typeof opener.focus === 'function') opener.focus();
        resolve(confirmed ? { confirmed: true, reason: needReason ? reason.value.trim() : undefined } : { confirmed: false });
        reason.value = '';
      }
      function onSubmit(e) {
        e.preventDefault();
        if (ok.disabled) return;
        done(true);
      }
      function onCancel() { done(false); }
      function onEscape(e) { e.preventDefault(); done(false); }
      // A modal <dialog> makes the page behind it inert, but Tab past the last
      // control can still leave for the browser itself; keep it in the dialog.
      function onKey(e) {
        if (e.key !== 'Tab') return;
        var items = [].filter.call(dlg.querySelectorAll('button, textarea, input, select, [href], [tabindex]'), function (n) {
          return !n.disabled && n.tabIndex !== -1 && n.offsetParent !== null;
        });
        if (!items.length) return;
        var first = items[0];
        var last = items[items.length - 1];
        if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
      }

      reason.addEventListener('input', sync);
      form.addEventListener('submit', onSubmit);
      cancel.addEventListener('click', onCancel);
      dlg.addEventListener('cancel', onEscape);
      dlg.addEventListener('keydown', onKey);
      dlg.showModal();
      (needReason ? reason : cancel).focus();
    });
  }

  /* ------------------------------------------------------------------ toast */

  var toastTimer = null;

  function toast(text, ms) {
    var node = d.getElementById('console-toast');
    if (!node) return;
    node.textContent = String(text);
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; node.textContent = ''; }, ms || 5000);
  }

  C.ui = { el: el, clear: clear, states: states, confirm: confirm, toast: toast };
})(window, document);
