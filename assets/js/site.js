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

  /* --------------------------------------------------------------- RFQ store */
  var KEY = 'tr_rfq_v1';

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

  var RFQ = {
    all: read,
    add: function (id, name, size) {
      var list = read();
      var hit = list.filter(function (i) { return i.id === id && i.size === size; })[0];
      if (hit) { hit.qty += 1; } else { list.push({ id: id, name: name, size: size, qty: 1 }); }
      write(list); sync(); toast(name + ' · ' + size + ' added to request list');
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
  window.TR_RFQ = RFQ;

  /* -------------------------------------------------------------- RFQ drawer */
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
        '<strong>Your request list is empty.</strong>' +
        '<p>Add compounds from the catalog to request a quotation.</p></div>';
      if (foot) foot.hidden = true;
      return;
    }
    body.innerHTML = list.map(function (i, idx) {
      return '<div class="rfq-line">' +
        '<div class="rfq-line-main"><div class="rfq-line-name">' + esc(i.name) + '</div>' +
        '<div class="rfq-line-size">' + esc(i.size) + '</div></div>' +
        '<div class="qty"><button type="button" data-q="-1" data-i="' + idx + '" aria-label="Decrease quantity">−</button>' +
        '<span>' + i.qty + '</span>' +
        '<button type="button" data-q="1" data-i="' + idx + '" aria-label="Increase quantity">+</button></div>' +
        '<button class="rfq-remove" type="button" data-rm="' + idx + '" aria-label="Remove ' + esc(i.name) + '">✕</button>' +
        '</div>';
    }).join('');
    if (foot) foot.hidden = false;
  }

  function sync() {
    var n = RFQ.count();
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
  if (clearBtn) clearBtn.addEventListener('click', function () { RFQ.clear(); });

  if (body) {
    body.addEventListener('click', function (e) {
      var q = e.target.closest('[data-q]');
      if (q) { RFQ.setQty(+q.dataset.i, +q.dataset.q); return; }
      var rm = e.target.closest('[data-rm]');
      if (rm) RFQ.remove(+rm.dataset.rm);
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

  /* --------------------------------------------------- add-to-list delegation */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-add]');
    if (!btn) return;
    var scope = btn.closest('.product') || btn.closest('form') || document;
    var sel = scope.querySelector('[data-size]');
    RFQ.add(btn.dataset.add, btn.dataset.name, sel ? sel.value : 'Standard');
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  window.TR_esc = esc;

  sync();

  /* -------------------------------------------------------- hero particle field */
  var canvas = document.getElementById('hero-canvas');
  if (canvas && !reduceMotion) {
    var ctx = canvas.getContext('2d');
    var pts = [], pointer = { x: -9999, y: -9999 }, raf = null, dpr = Math.min(window.devicePixelRatio || 1, 2);

    function size() {
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function seed() {
      var w = canvas.offsetWidth, h = canvas.offsetHeight;
      var n = Math.min(Math.floor(w * h / 16000), 70);
      pts = [];
      for (var i = 0; i < n; i++) {
        pts.push({ x: Math.random() * w, y: Math.random() * h,
                   vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
                   r: Math.random() * 1.4 + 0.4, a: Math.random() * 0.35 + 0.12 });
      }
    }
    function frame() {
      var w = canvas.offsetWidth, h = canvas.offsetHeight, link = 138;
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var dx = pointer.x - p.x, dy = pointer.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 110 && d > 0) { p.vx -= (dx / d) * 0.014; p.vy -= (dy / d) * 0.014; }
        p.vx *= 0.992; p.vy *= 0.992;
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        for (var j = i + 1; j < pts.length; j++) {
          var q = pts[j], ex = p.x - q.x, ey = p.y - q.y, ed = Math.sqrt(ex * ex + ey * ey);
          if (ed < link) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(79,172,254,' + (1 - ed / link) * 0.11 + ')';
            ctx.lineWidth = 0.5;
            ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(79,172,254,' + p.a + ')';
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    size(); seed(); start();
    window.addEventListener('resize', function () { size(); seed(); }, { passive: true });
    canvas.addEventListener('mousemove', function (e) {
      var r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
    }, { passive: true });
    canvas.addEventListener('mouseleave', function () { pointer.x = pointer.y = -9999; });

    /* stop painting when the hero scrolls away or the tab is hidden */
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es[0].isIntersecting ? start() : stop();
      }, { threshold: 0 }).observe(canvas);
    }
  }
})();
