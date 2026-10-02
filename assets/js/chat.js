/* Timeless Research — order and product help assistant.
   No dependencies, ES5 like site.js. The drawer markup is in every page's
   shared chrome (tools/build.py, chat_chrome()); this file brings it to life
   and reveals the launcher, so with JavaScript off there is no dead button.

   Replies are written with textContent, never innerHTML. The only markup this
   file creates from a reply is a link, and only for a bare site-relative path
   such as products/bpc-157.html, so nothing the model says can inject HTML.

   The conversation lives in sessionStorage: it survives moving between pages
   and is gone when the tab closes. Each assistant turn is stored with the
   signature the function gave it, because the function refuses a history it
   did not write. */
(function () {
  'use strict';

  var drawer = document.getElementById('chat-drawer');
  var launcher = document.getElementById('chat-open');
  if (!drawer || !launcher) return;

  var scrim = document.getElementById('chat-scrim');
  var log = document.getElementById('chat-log');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var send = document.getElementById('chat-send');
  var closeBtn = document.getElementById('chat-close');
  var resetBtn = document.getElementById('chat-reset');

  var CFG = window.TR_CONFIG || {};
  var ENDPOINT = CFG.chatEndpoint || '/.netlify/functions/chat';
  var ROOT = drawer.getAttribute('data-root') || '';
  var KEY = 'tr_chat_v1';
  var KEEP = 10;          // messages sent back; the function keeps the same number
  var MAX_CHARS = 1000;

  var GREETING = 'Hello. I can help with products, specifications, CAS numbers, ' +
    'certificates of analysis, pricing and volume tiers, shipping, returns, payment ' +
    'and how ordering works. Everything we sell is for in-vitro laboratory research only, ' +
    'so I can’t advise on dosing, preparation or use.';
  var OFFLINE = 'The assistant can’t be reached right now. Please try again later, ' +
    'or use contact.html to reach a person.';

  var history = load();
  var pending = false;
  var lastFocus = null;

  function load() {
    try {
      var raw = sessionStorage.getItem(KEY);
      var h = raw ? JSON.parse(raw) : [];
      return Array.isArray(h) ? h : [];
    } catch (e) {
      return [];
    }
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-KEEP))); } catch (e) { /* private mode */ }
  }

  /* ------------------------------------------------------------ rendering */

  var LINK = /((?:products|legal)\/[a-z0-9-]+\.html|\b[a-z0-9-]+\.html)(#[a-z0-9-]+)?/gi;
  var EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

  /* Appends text to el, turning site paths and email addresses into links. */
  function appendLinked(el, text) {
    var parts = [];
    var m, re;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(text))) parts.push({ i: m.index, len: m[0].length, href: ROOT + m[0], label: m[0] });
    EMAIL.lastIndex = 0;
    while ((m = EMAIL.exec(text))) parts.push({ i: m.index, len: m[0].length, href: 'mailto:' + m[0], label: m[0] });
    parts.sort(function (a, b) { return a.i - b.i; });
    var at = 0;
    for (var k = 0; k < parts.length; k++) {
      re = parts[k];
      if (re.i < at) continue; // overlapping match
      if (re.i > at) el.appendChild(document.createTextNode(text.slice(at, re.i)));
      var a = document.createElement('a');
      a.href = re.href;
      a.textContent = re.label;
      el.appendChild(a);
      at = re.i + re.len;
    }
    if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
  }

  function bubble(role, text, note) {
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg--' + role + (note ? ' chat-msg--note' : '');
    var who = document.createElement('span');
    who.className = 'sr-only';
    who.textContent = role === 'user' ? 'You: ' : 'Assistant: ';
    div.appendChild(who);
    var body = document.createElement('p');
    if (role === 'user') body.textContent = text;
    else appendLinked(body, text);
    div.appendChild(body);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function render() {
    log.textContent = '';
    bubble('bot', GREETING, true);
    for (var i = 0; i < history.length; i++) bubble(history[i].role === 'user' ? 'user' : 'bot', history[i].content);
  }

  function setPending(on) {
    pending = on;
    send.disabled = on;
    log.setAttribute('aria-busy', on ? 'true' : 'false');
    var t = document.getElementById('chat-typing');
    if (on && !t) {
      t = document.createElement('div');
      t.id = 'chat-typing';
      t.className = 'chat-msg chat-msg--bot chat-typing';
      t.textContent = 'Finding an answer…';
      log.appendChild(t);
      log.scrollTop = log.scrollHeight;
    } else if (!on && t) {
      t.parentNode.removeChild(t);
    }
  }

  /* ---------------------------------------------------------------- send */

  /* The messages to send: the stored history trimmed to fit, starting with a
     question, then the new one. */
  function outgoing(question) {
    var h = history.slice(-(KEEP - 1));
    while (h.length && h[0].role !== 'user') h.shift();
    var out = [];
    for (var i = 0; i < h.length; i++) {
      out.push(h[i].role === 'user'
        ? { role: 'user', content: h[i].content }
        : { role: 'assistant', content: h[i].content, sig: h[i].sig });
    }
    out.push({ role: 'user', content: question });
    return out;
  }

  function ask(question) {
    bubble('user', question);
    setPending(true);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', ENDPOINT, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 20000;
    xhr.onload = function () {
      setPending(false);
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      if (xhr.status === 200 && data && data.reply && data.sig) {
        history.push({ role: 'user', content: question });
        history.push({ role: 'assistant', content: data.reply, sig: data.sig });
        save();
        bubble('bot', data.reply);
      } else if (xhr.status === 400) {
        /* The stored history no longer verifies (the key was rotated, say).
           Start again rather than fail on every message. */
        history = [];
        save();
        bubble('bot', 'Sorry, that conversation could not be continued. Please ask again.', true);
        input.value = question;
      } else {
        bubble('bot', (data && data.reply) || OFFLINE, true);
        input.value = question;
      }
      input.focus();
    };
    xhr.onerror = xhr.ontimeout = function () {
      setPending(false);
      bubble('bot', OFFLINE, true);
      input.value = question;
      input.focus();
    };
    xhr.send(JSON.stringify({ messages: outgoing(question) }));
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pending) return;
    var q = input.value.replace(/^\s+|\s+$/g, '');
    if (!q) { input.focus(); return; }
    if (q.length > MAX_CHARS) q = q.slice(0, MAX_CHARS);
    input.value = '';
    ask(q);
  });

  /* Enter sends; Shift+Enter is a new line. */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else send.click();
    }
  });

  resetBtn.addEventListener('click', function () {
    history = [];
    save();
    render();
    input.value = '';
    input.focus();
  });

  /* -------------------------------------------------------- open / close */

  function open() {
    lastFocus = document.activeElement;
    /* One drawer at a time: the cart and the assistant share the right edge. */
    var cart = document.getElementById('rfq-drawer');
    if (cart && cart.classList.contains('is-open')) {
      var cartClose = document.getElementById('rfq-close');
      if (cartClose) cartClose.click();
    }
    render();
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    if (scrim) scrim.classList.add('is-open');
    launcher.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    input.focus();
  }

  function close() {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (scrim) scrim.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    (lastFocus && document.body.contains(lastFocus) ? lastFocus : launcher).focus();
  }

  launcher.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  if (scrim) scrim.addEventListener('click', close);

  /* Escape closes, and Tab stays inside, while the drawer is open. Handled on
     the drawer and stopped there, so site.js's page-level Escape handler (which
     closes the cart and restores focus to wherever the cart was opened from)
     does not also run and pull focus away from the launcher. */
  drawer.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    var f = drawer.querySelectorAll('button:not([disabled]), a[href], textarea, input, select');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  launcher.setAttribute('aria-expanded', 'false');
  launcher.hidden = false;
})();
