/* Catalog filtering and search. Works against the server-rendered grid, so the
   full catalog is present and indexable with JavaScript disabled. */
(function () {
  'use strict';

  var grid = document.getElementById('product-grid');
  if (!grid) return;

  var cards = Array.prototype.slice.call(grid.querySelectorAll('.product'));
  var search = document.getElementById('catalog-search');
  var countEl = document.getElementById('result-count');
  var emptyEl = document.getElementById('empty-state');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filter-btn'));

  var state = { cat: 'all', q: '' };

  function apply() {
    var q = state.q.trim().toLowerCase();
    var shown = 0;

    cards.forEach(function (card) {
      var okCat = state.cat === 'all' || card.dataset.cat === state.cat;
      var okQ = !q || card.dataset.search.indexOf(q) !== -1;
      var show = okCat && okQ;
      card.hidden = !show;
      if (show) shown++;
    });

    if (countEl) {
      countEl.textContent = shown === cards.length
        ? cards.length + ' compounds'
        : shown + ' of ' + cards.length + ' compounds';
    }
    if (emptyEl) emptyEl.hidden = shown !== 0;
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.cat = btn.dataset.filter;
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      apply();
      if (state.cat !== 'all' && history.replaceState) {
        history.replaceState(null, '', '#' + state.cat);
      }
    });
  });

  if (search) {
    var t;
    search.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { state.q = search.value; apply(); }, 120);
    });
  }

  /* deep link: catalog.html#growth */
  var hash = (location.hash || '').replace('#', '');
  if (hash) {
    var target = buttons.filter(function (b) { return b.dataset.filter === hash; })[0];
    if (target) target.click();
  }

  apply();
})();
