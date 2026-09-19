/* Timeless Research — shared site behaviour.
   No dependencies. Every block guards for the elements it needs, so the same
   file is safe to load on every page. */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- mobile nav */
  var header = document.getElementById('header');
  var navToggle = document.getElementById('nav-toggle');
  if (header && navToggle) {
    navToggle.addEventListener('click', function () {
      var open = header.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
  }

  /* ------------------------------------------------------------------ reveal */
  var revealables = document.querySelectorAll('[data-reveal]');
  if (revealables.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealables.forEach(function (el) { el.classList.add('is-in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
      revealables.forEach(function (el) { io.observe(el); });
    }
  }

  /* --------------------------------------------------------------- accordion */
  document.querySelectorAll('.acc-q').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('.acc-item');
      var isOpen = item.classList.contains('is-open');
      item.classList.toggle('is-open', !isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  /* ------------------------------------------------------------------- toast */
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2400);
  }

  /* -------------------------------------------------------------- cart store */
  /* The DOM ids and CSS classes below still carry the `rfq-` prefix from when
     this was a request-for-quote list. They are load-bearing across the
     generated pages and the stylesheet; the behaviour is a cart. */
  var CFG = window.TR_CONFIG || {};
  var RESTRICTED = CFG.restricted || [];
  var KEY = 'tr_cart_v1';

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  }

  var CART = {
    all: read,
    add: function (id, name, size, price) {
      /* Belt and braces: a restricted compound has no add control on any page,
         so reaching here means the markup was edited or the console was used.
         The checkout function refuses it again on the server, where it counts. */
      if (RESTRICTED.indexOf(id) !== -1) {
        toast(name + ' is a restricted standard — please enquire');
        return;
      }
      var list = read();
      var hit = list.filter(function (i) { return i.id === id && i.size === size; })[0];
      if (hit) { hit.qty += 1; hit.price = price; }
      else { list.push({ id: id, name: name, size: size, qty: 1, price: price }); }
      write(list); sync(); toast(name + ' · ' + size + ' added to cart');
    },
    setQty: function (idx, delta) {
      var list = read();
      if (!list[idx]) return;
      list[idx].qty = Math.max(1, list[idx].qty + delta);
      write(list); sync();
    },
    remove: function (idx) { var l = read(); l.splice(idx, 1); write(l); sync(); },
    clear: function () { write([]); sync(); },
    count: function () { return read().reduce(function (t, i) { return t + i.qty; }, 0); }
  };
  window.TR_CART = CART;

  /* -------------------------------------------------------------- cart drawer */
  var drawer = document.getElementById('rfq-drawer');
  var scrim = document.getElementById('rfq-scrim');
  var body = document.getElementById('rfq-body');
  var foot = document.getElementById('rfq-foot');
  var countEl = document.getElementById('rfq-count');
  var lastFocus = null;

  function render() {
    if (!body) return;
    var list = read();
    if (!list.length) {
      body.innerHTML = '<div class="empty-state" style="padding:3rem 0">' +
        '<strong>Your cart is empty.</strong>' +
        '<p>Choose a pack size on any catalog or product page and add it here.</p></div>';
      if (foot) foot.hidden = true;
      return;
    }
    body.innerHTML = list.map(function (i, idx) {
      return '<div class="rfq-line">' +
        '<div class="rfq-line-main"><div class="rfq-line-name">' + esc(i.name) + '</div>' +
        '<div class="rfq-line-size">' + esc(i.size) +
        (i.price != null ? ' &middot; ' + money(i.price) : '') + '</div></div>' +
        '<div class="qty"><button type="button" data-q="-1" data-i="' + idx + '" aria-label="Decrease quantity">−</button>' +
        '<span>' + i.qty + '</span>' +
        '<button type="button" data-q="1" data-i="' + idx + '" aria-label="Increase quantity">+</button></div>' +
        '<button class="rfq-remove" type="button" data-rm="' + idx + '" aria-label="Remove ' + esc(i.name) + '">✕</button>' +
        '</div>';
    }).join('');

    /* The goods subtotal only. Shipping is chosen at checkout and tax depends
       on the destination, so neither can be known here; saying so is better
       than showing a total the checkout page will disagree with. */
    var priced = list.filter(function (i) { return i.price != null; });
    if (priced.length) {
      var sum = priced.reduce(function (t, i) { return t + i.price * i.qty; }, 0);
      var partial = priced.length < list.length;
      body.innerHTML += '<div class="rfq-total"><span>Subtotal' +
        (partial ? ' (priced items)' : '') + '</span><strong>' + money(sum) + '</strong></div>' +
        '<p class="rfq-total-note">Shipping and any tax are added at checkout, before you pay.</p>';
    }
    if (foot) foot.hidden = false;
  }

  function sync() {
    var n = CART.count();
    if (countEl) {
      countEl.textContent = String(n);
      countEl.classList.toggle('is-on', n > 0);
    }
    render();
  }

  function openDrawer() {
    if (!drawer) return;
    lastFocus = document.activeElement;
    render();
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    if (scrim) scrim.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    var close = document.getElementById('rfq-close');
    if (close) close.focus();
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (scrim) scrim.classList.remove('is-open');
    document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
  }

  var openBtn = document.getElementById('rfq-open');
  if (openBtn) openBtn.addEventListener('click', openDrawer);
  var closeBtn = document.getElementById('rfq-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (scrim) scrim.addEventListener('click', closeDrawer);
  var clearBtn = document.getElementById('rfq-clear');
  if (clearBtn) clearBtn.addEventListener('click', function () { CART.clear(); });

  if (body) {
    body.addEventListener('click', function (e) {
      var q = e.target.closest('[data-q]');
      if (q) { CART.setQty(+q.dataset.i, +q.dataset.q); return; }
      var rm = e.target.closest('[data-rm]');
      if (rm) CART.remove(+rm.dataset.rm);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeDrawer();
    if (header) { header.classList.remove('is-open'); if (navToggle) navToggle.setAttribute('aria-expanded', 'false'); }
  });

  /* keep focus inside the drawer while it is open */
  if (drawer) {
    drawer.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = drawer.querySelectorAll('button, a[href], select, input, textarea');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ------------------------------------------- keep the vial label in step */
  /* The printed label is the most prominent thing on a product card, and it sat
     on sizes[0] whatever the pack-size control said. Selecting 300 mg next to a
     vial reading 30 mg looks like the selection was not registered. */
  function scopeOf(el) {
    return el.closest('.product') || el.closest('.split') || document;
  }

  function priceOf(sel) {
    var opt = sel.options[sel.selectedIndex];
    return opt && opt.dataset.price ? Number(opt.dataset.price) : null;
  }

  function money(v) {
    return '$' + (v % 1 === 0 ? v.toLocaleString('en-US')
                              : v.toLocaleString('en-US', { minimumFractionDigits: 2 }));
  }
  window.TR_money = money;

  document.addEventListener('change', function (e) {
    var sel = e.target.closest ? e.target.closest('[data-size]') : null;
    if (!sel) return;
    var scope = scopeOf(sel);
    var dose = scope.querySelector('.vp-dose');
    if (dose) dose.textContent = sel.value;
    var price = priceOf(sel);
    var out = scope.querySelector('[data-price-display]');
    if (out && price !== null) out.textContent = money(price);
  });

  /* --------------------------------------------------- add-to-cart delegation */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-add]');
    if (!btn) return;
    var scope = btn.closest('.product') || btn.closest('form') || btn.closest('.split') || document;
    var sel = scope.querySelector('[data-size]');
    CART.add(btn.dataset.add, btn.dataset.name, sel ? sel.value : 'Standard',
             sel ? priceOf(sel) : null);
  });

  /* ---------------------------------------------------------------- checkout */
  /* The cart holds prices so it can show a subtotal, but only ids, pack sizes
     and quantities are sent: the amount charged is priced by the function from
     its own copy of the catalogue. A price posted from a browser is a number
     the customer chose. */
  var checkoutBtn = document.getElementById('cart-checkout');
  var consent = document.getElementById('cart-confirm');
  var cartError = document.getElementById('cart-error');

  function showCartError(msg) {
    if (!cartError) return;
    cartError.textContent = msg;
    cartError.hidden = !msg;
  }

  if (consent) consent.addEventListener('change', function () { showCartError(''); });

  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', function () {
      var list = read();
      if (!list.length) { showCartError('Your cart is empty.'); return; }
      if (consent && !consent.checked) {
        showCartError('Please confirm the research use condition before checking out.');
        consent.focus();
        return;
      }
      if (CFG.demo) {
        showCartError('This is a demonstration site. No order can be placed and no payment is taken.');
        return;
      }
      showCartError('');
      checkoutBtn.disabled = true;
      var label = checkoutBtn.textContent;
      checkoutBtn.textContent = 'Opening checkout\u2026';

      fetch(CFG.checkoutEndpoint || '/.netlify/functions/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: list.map(function (i) { return { id: i.id, size: i.size, qty: i.qty }; }),
          researchUseConfirmed: true
        })
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      }).then(function (res) {
        if (!res.ok || !res.data || !res.data.url) {
          throw new Error((res.data && res.data.error) || 'Checkout could not be started.');
        }
        window.location.href = res.data.url;
      }).catch(function (err) {
        showCartError(err.message + ' Nothing has been charged \u2014 try again, or email us and we will take the order by hand.');
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = label;
      });
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  window.TR_esc = esc;

  sync();

})();
