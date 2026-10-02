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
  function dismissToast() {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastEl.classList.remove('is-on');
  }

  /* -------------------------------------------------------------- cart store */
  /* The DOM ids and CSS classes below still carry the `rfq-` prefix from when
     this was a request-for-quote list. They are load-bearing across the
     generated pages and the stylesheet; the behaviour is a cart. */
  var CFG = window.TR_CONFIG || {};
  var NO_CART = CFG.noCart || [];
  var TIERS = (CFG.volumeTiers || []).slice().sort(function (a, b) { return a.minQty - b.minQty; });
  var FREE_OVER = Number(CFG.freeShippingOver || 0);

  /* Optional add-ons (tools/addons.py, assets/data/addons.json). Which add-ons
     a product may carry was resolved at build time into ADDON_ELIG, the same
     map the server prices from, so the cart never offers what checkout would
     refuse. Shown only once the payment integration charges for them
     (ADDONS.show), or in a local preview build that says so. An add-on is
     priced on its own: it never changes its line's price, the line's volume
     tier, or the free-shipping threshold, which counts products only. */
  var ADDONS = CFG.addons || {};
  var ADDON_DEFS = ADDONS.addons || {};
  var ADDON_ELIG = ADDONS.eligibility || {};
  var SHOW_ADDONS = !!ADDONS.show;
  var addonStock = null;      // { id: true|false } once known; null until fetched
  var addonStockLoading = false;

  function offeredOn(item) {
    if (!SHOW_ADDONS || !Object.prototype.hasOwnProperty.call(ADDON_ELIG, item.id)) return [];
    return ADDON_ELIG[item.id].filter(function (o) { return ADDON_DEFS[o.addon]; });
  }
  function addonUnits(def, item) { return def.quantity === 'per-unit' ? item.qty : 1; }
  /* true / false / null (not known yet). Untracked add-ons are always in stock. */
  function addonInStock(id) {
    var d = ADDON_DEFS[id];
    if (!d || !d.trackInventory) return true;
    if (addonStock === null) return null;
    return addonStock[id] === true;
  }
  /* The add-ons a line actually carries: still offered on it, and in stock. */
  function addonsOn(item) {
    var offered = offeredOn(item).map(function (o) { return o.addon; });
    return (item.addons || []).filter(function (id) {
      return offered.indexOf(id) !== -1 && addonInStock(id) === true;
    });
  }
  function addonsTotal(item) {
    var t = addonsOn(item).reduce(function (sum, id) {
      return sum + Math.round(ADDON_DEFS[id].price * 100) * addonUnits(ADDON_DEFS[id], item);
    }, 0);
    return t / 100;
  }

  /* The best quantity break a line qualifies for, or null. Mirrored exactly in
     netlify/lib/payment.js (priceCart), which is the one that counts — this
     copy only decides what the drawer says. If the two ever disagree the
     customer sees one number and is charged another, so both read their tiers
     from the same place: products.json, via the build. */
  function tierFor(qty) {
    var best = null;
    for (var i = 0; i < TIERS.length; i++) {
      if (qty >= TIERS[i].minQty) best = TIERS[i];
    }
    return best;
  }

  function lineTotal(item) {
    if (item.price == null) return null;
    var t = tierFor(item.qty);
    var unit = t ? item.price * (1 - t.percent / 100) : item.price;
    return Math.round(unit * item.qty * 100) / 100;
  }
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
      /* Belt and braces: a compound the operator has taken out of the cart has
         no add control on any page, so reaching here means the markup was
         edited or the console was used. The checkout function refuses it again
         on the server, where it counts. */
      if (NO_CART.indexOf(id) !== -1) {
        toast(name + ' is not sold through the cart — please enquire');
        return;
      }
      var list = read();
      var hit = list.filter(function (i) { return i.id === id && i.size === size; })[0];
      if (hit) { hit.qty += 1; hit.price = price; }
      else { list.push({ id: id, name: name, size: size, qty: 1, price: price, addons: [] }); }
      write(list); sync(); toast(name + ' · ' + size + ' added to cart');
    },
    setQty: function (idx, delta) {
      var list = read();
      if (!list[idx]) return;
      list[idx].qty = Math.max(1, list[idx].qty + delta);
      write(list); sync();
    },
    remove: function (idx) { var l = read(); l.splice(idx, 1); write(l); sync(); },
    setAddon: function (idx, addonId, on) {
      var list = read();
      if (!list[idx]) return;
      var cur = (list[idx].addons || []).filter(function (a) { return a !== addonId; });
      if (on) cur.push(addonId);
      list[idx].addons = cur;
      write(list); sync();
    },
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

  /* The add-ons offered on one cart line, as a labelled group of checkboxes.
     A tracked add-on stays disabled until its stock is known, and says why. */
  function addonFieldset(item, idx) {
    var offered = offeredOn(item);
    if (!offered.length) return '';
    var rows = offered.map(function (o) {
      var d = ADDON_DEFS[o.addon];
      var id = 'ad-' + idx + '-' + o.addon;
      var stock = addonInStock(o.addon);
      var on = stock === true && (item.addons || []).indexOf(o.addon) !== -1;
      var units = addonUnits(d, item);
      var price = money(d.price) + (d.quantity === 'per-unit' ? ' each' : '') +
        (units > 1 ? ' &middot; ' + money(Math.round(d.price * 100 * units) / 100) : '');
      var status = stock === null ? 'Checking availability\u2026' : (stock === false ? 'Out of stock' : '');
      return '<div class="addon">' +
        '<label class="check" for="' + id + '"><input type="checkbox" id="' + id + '" data-addon="' + esc(o.addon) +
        '" data-i="' + idx + '"' + (on ? ' checked' : '') + (stock !== true ? ' disabled' : '') +
        ' aria-describedby="' + id + '-d">' +
        '<span><span class="addon-name">' + esc(d.name) + '</span> <span class="addon-price">' + price + '</span></span></label>' +
        '<p class="addon-desc" id="' + id + '-d">' + esc(d.description) +
        (status ? ' <strong class="addon-status">' + status + '</strong>' : '') + '</p></div>';
    }).join('');
    return '<fieldset class="addons"><legend>Optional add-ons<span class="sr-only"> for ' + esc(item.name) +
      ', ' + esc(item.size) + '</span></legend>' + rows + '</fieldset>';
  }

  /* Stock for tracked add-ons, fetched once per page when the cart first
     needs it. Fails closed: if it cannot be read, tracked add-ons show as out
     of stock, which is also what the server would decide. */
  function loadAddonStock() {
    if (!SHOW_ADDONS || addonStock !== null || addonStockLoading) return;
    var needs = read().some(function (i) {
      return offeredOn(i).some(function (o) { return ADDON_DEFS[o.addon].trackInventory; });
    });
    if (!needs) return;
    addonStockLoading = true;
    fetch(CFG.addonAvailabilityEndpoint || '/.netlify/functions/addon-availability')
      .then(function (r) { if (!r.ok) throw new Error('stock'); return r.json(); })
      .then(function (d) { addonStock = (d && d.available) || {}; })
      .catch(function () { addonStock = {}; })
      .then(function () { addonStockLoading = false; render(); });
  }

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
    var previewNote = ADDONS.preview
      ? '<p class="addon-preview" role="note">Add-on preview build: add-ons are shown here but are not charged at checkout. Do not deploy.</p>'
      : '';
    body.innerHTML = previewNote + list.map(function (i, idx) {
      var t = tierFor(i.qty);
      var next = null;
      for (var n = 0; n < TIERS.length; n++) {
        if (i.qty < TIERS[n].minQty) { next = TIERS[n]; break; }
      }
      var addonRow = addonFieldset(i, idx);
      return '<div class="rfq-line' + (addonRow ? ' rfq-line--addons' : '') + '">' +
        '<div class="rfq-line-main"><div class="rfq-line-name">' + esc(i.name) + '</div>' +
        '<div class="rfq-line-size">' + esc(i.size) +
        (i.price != null ? ' &middot; ' + money(i.price) : '') + '</div>' +
        (t ? '<div class="rfq-line-tier">' + t.percent + '% volume discount &middot; ' +
             money(lineTotal(i)) + '</div>' : '') +
        (!t && next && i.price != null
          ? '<div class="rfq-line-next">Add ' + (next.minQty - i.qty) +
            ' more for ' + next.percent + '% off this line</div>' : '') +
        '</div>' +
        '<div class="qty"><button type="button" data-q="-1" data-i="' + idx + '" aria-label="Decrease quantity">−</button>' +
        '<span>' + i.qty + '</span>' +
        '<button type="button" data-q="1" data-i="' + idx + '" aria-label="Increase quantity">+</button></div>' +
        '<button class="rfq-remove" type="button" data-rm="' + idx + '" aria-label="Remove ' + esc(i.name) + '">✕</button>' +
        addonRow +
        '</div>';
    }).join('');

    /* The goods subtotal only. Shipping is chosen at checkout and tax depends
       on the destination, so neither can be known here; saying so is better
       than showing a total the checkout page will disagree with. */
    var priced = list.filter(function (i) { return i.price != null; });
    if (priced.length) {
      var gross = priced.reduce(function (t, i) { return t + i.price * i.qty; }, 0);
      var sum = priced.reduce(function (t, i) { return t + lineTotal(i); }, 0);
      var saved = Math.round((gross - sum) * 100) / 100;
      var partial = priced.length < list.length;
      var addonSum = Math.round(list.reduce(function (t, i) { return t + addonsTotal(i); }, 0) * 100) / 100;
      var extra = '';
      if (saved > 0) {
        extra += '<div class="rfq-total rfq-total--sub"><span>Volume discount</span>' +
                 '<strong>&minus;' + money(saved) + '</strong></div>';
      }
      if (addonSum > 0) {
        /* Products and add-ons shown apart, because the free-shipping
           threshold is measured on products alone. */
        extra += '<div class="rfq-total rfq-total--part"><span>Products</span><strong>' + money(sum) + '</strong></div>' +
                 '<div class="rfq-total rfq-total--part"><span>Add-ons</span><strong>' + money(addonSum) + '</strong></div>';
      }
      extra += '<div class="rfq-total"><span>Subtotal' +
        (partial ? ' (priced items)' : '') + '</span><strong>' +
        money(Math.round((sum + addonSum) * 100) / 100) + '</strong></div>';
      if (FREE_OVER > 0) {
        extra += sum >= FREE_OVER
          ? '<p class="rfq-total-note rfq-free">Standard shipping is free on this order.</p>'
          : '<p class="rfq-total-note">Add ' + money(Math.round((FREE_OVER - sum) * 100) / 100) +
            (addonSum > 0 ? ' more in products' : '') + ' for free standard shipping.</p>';
      }
      extra += '<p class="rfq-total-note">Shipping and any tax are added at checkout, before you pay.</p>';
      body.innerHTML += extra;
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
    /* The toast sits bottom-centre and the drawer is full-width on a phone, so
       an "added to cart" message raised a moment earlier lands on top of the
       drawer's own footnote, which says how to order. The open cart is a better confirmation than the toast
       was, so retire it rather than stack the two. */
    dismissToast();
    render();
    loadAddonStock();
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
    /* Re-rendering replaces the checkbox, so put focus back on its successor:
       otherwise a keyboard user is thrown to the top of the page per tick. */
    body.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-addon]');
      if (!cb) return;
      var addonId = cb.getAttribute('data-addon');
      var i = +cb.getAttribute('data-i');
      CART.setAddon(i, addonId, cb.checked);
      var again = body.querySelector('[data-addon="' + addonId + '"][data-i="' + i + '"]');
      if (again) again.focus();
    });
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
     and quantities are sent: the amount charged is priced on the server
     (netlify/lib/payment.js) from its own copy of the catalogue. A price posted from a browser is a number
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
      // No payment provider is connected yet, so there is no checkout to open.
      if (!CFG.checkoutEndpoint) {
        showCartError('Online payment is not available yet, so nothing can be paid for here and nothing has been charged. ' +
          'Email ' + (CFG.contactEmail || 'us') + ' with your cart and we will take the order by hand.');
        return;
      }
      if (consent && !consent.checked) {
        showCartError('Please confirm the research use condition before checking out.');
        consent.focus();
        return;
      }
      showCartError('');
      checkoutBtn.disabled = true;
      var label = checkoutBtn.textContent;
      checkoutBtn.textContent = 'Opening checkout\u2026';

      fetch(CFG.checkoutEndpoint, {
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
