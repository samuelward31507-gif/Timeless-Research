/* Operations console: one order, read-only (console/order.html?id=<uuid>).

   Opened from the business overview when an order needs more than a line.
   Shows what the API returns for the order (admin-orders?id=), in the
   owner's words, and changes nothing: there are no actions on this page.
   The only request is that one read; an address without a valid order id
   makes none. */
(function (w, d) {
  'use strict';

  var C = w.TRConsole;
  var el, ui, f;
  var seq = 0;
  var orderId = null;

  var STAGES = [
    ['processing_at', 'Processing'], ['packed_at', 'Packed'], ['shipped_at', 'Shipped'],
    ['delivered_at', 'Delivered'], ['completed_at', 'Completed'], ['cancelled_at', 'Cancelled'],
    ['refunded_at', 'Refunded']
  ];

  function $(id) { return d.getElementById(id); }
  function list(v) { return Array.isArray(v) ? v : []; }
  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function text(v) { return typeof v === 'string' && v.trim() !== '' ? v : null; }

  /* --------------------------------------------------------------- building */

  function section(title, children, cls) {
    return el('section', { className: 'cc-section od-section' + (cls ? ' ' + cls : '') }, [
      el('div', { className: 'cc-section-head' }, el('h2', { className: 'cc-section-title', text: title }))
    ].concat(children));
  }

  // A definition list of [label, value] pairs; a value may be a node.
  function facts(pairs) {
    return el('dl', { className: 'od-dl' }, pairs.filter(Boolean).map(function (p) {
      return el('div', { className: 'od-dl-row' }, [
        el('dt', { text: p[0] }),
        typeof p[1] === 'string' ? el('dd', { text: p[1] }) : el('dd', null, p[1])
      ]);
    }));
  }

  function badge(status) {
    return el('span', { className: 'console-badge', 'data-status': f.isStatus(status) ? status : 'other', text: f.statusLabel(status) });
  }

  function none(words) { return el('p', { className: 'od-none', text: words }); }

  /* ---------------------------------------------------------------- sections */

  function header(o, attention) {
    $('od-title').textContent = 'Order placed ' + f.dateTime(o.created_at);
    var stages = STAGES.filter(function (s) { return text(o[s[0]]); }).map(function (s) {
      return el('li', null, [el('span', { className: 'od-stage-name', text: s[1] }), el('span', { className: 'cc-num', text: f.dateTime(o[s[0]]) })]);
    });
    var parts = [
      el('div', { className: 'od-status' }, [
        badge(o.status),
        el('span', { className: 'od-since', text: 'since ' + f.dateTime(o.status_changed_at || o.created_at) })
      ]),
      stages.length ? el('ul', { className: 'od-stages' }, stages) : null
    ];
    if (isObject(attention) && text(attention.attention_reason)) {
      var more = [];
      if (attention.unmapped_lines > 0) more.push(f.count(attention.unmapped_lines) + (attention.unmapped_lines === 1 ? ' line has' : ' lines have') + ' no product matched');
      if (attention.unallocated_units > 0) more.push(f.count(attention.unallocated_units) + (attention.unallocated_units === 1 ? ' unit is' : ' units are') + ' not yet drawn from stock');
      parts.push(el('div', { className: 'od-attention', role: 'note' }, [
        el('p', { className: 'od-attention-title', text: 'Needs attention: ' + attention.attention_reason })
      ].concat(more.map(function (m) { return el('p', { className: 'od-attention-text', text: m }); }))));
    }
    return el('div', { className: 'od-header' }, parts);
  }

  function customer(o) {
    return section('Customer', facts([['Name', f.dash(o.name)], ['Email', f.dash(o.email)], ['Phone', f.dash(o.phone)]]));
  }

  function shipping(o) {
    var addr = isObject(o.shipping_address) ? o.shipping_address : {};
    // As an address is written: street lines, "City, State Postcode", country.
    var place = [text(addr.city), [text(addr.state), text(addr.postal_code)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    var lines = [text(addr.line1), text(addr.line2), place || null, text(addr.country)].filter(Boolean);
    var address = lines.length
      ? el('span', { className: 'od-address' }, lines.map(function (l) { return el('span', { text: l }); }))
      : 'No shipping address recorded';
    var research = o.research_use_confirmed === true ? 'Yes' : o.research_use_confirmed === false ? 'No' : '—';
    return section('Shipping', facts([
      ['Address', address], ['Carrier', f.dash(o.carrier)], ['Tracking number', f.dash(o.tracking_number)],
      ['Research use confirmed', research]
    ]));
  }

  function totals(o) {
    var m = function (v) { return f.money(v, o.currency); };
    return section('Totals', [
      facts([['Subtotal', m(o.amount_subtotal)], ['Shipping', m(o.amount_shipping)], ['Discount', m(o.amount_discount)],
             ['Total', m(o.amount_total)], ['Currency', f.dash(o.currency)]]),
      el('p', { className: 'cc-caption', text: 'As recorded at payment.' })
    ], 'od-totals');
  }

  function reference(o) {
    return section('Reference', facts([['Payment reference', f.dash(o.stripe_session_id)], ['Order ID', f.dash(o.id)]]));
  }

  function lines(items, currency) {
    if (!items.length) return section('Items', none('No items recorded'));
    var head = el('thead', null, el('tr', null, ['Item', 'Product', 'Qty', 'Unit price', 'Line total'].map(function (h) {
      return el('th', { scope: 'col', text: h });
    })));
    var rows = items.map(function (i) {
      var addon = i.kind === 'addon';
      var product = addon
        ? 'Add-on for ' + f.dash(i.parent_sku) + ' · ' + f.dash(i.parent_pack_size)
        : (text(i.sku) ? i.sku + ' · ' + f.dash(i.pack_size) : 'No product matched');
      return el('tr', addon ? { className: 'is-addon' } : null, [
        el('td', { 'data-label': 'Item', text: f.dash(i.description) }),
        el('td', { 'data-label': 'Product', className: !addon && !text(i.sku) ? 'od-missing' : null, text: product }),
        el('td', { 'data-label': 'Qty', className: 'cc-num', text: f.count(i.quantity) }),
        el('td', { 'data-label': 'Unit price', className: 'cc-num', text: f.money(i.unit_amount, currency) }),
        el('td', { 'data-label': 'Line total', className: 'cc-num', text: f.money(i.amount_total, currency) })
      ]);
    });
    return section('Items', el('table', { className: 'console-table od-lines' }, [head, el('tbody', null, rows)]));
  }

  function history(rows) {
    if (!rows.length) return section('Status history', none('No changes recorded'));
    return section('Status history', el('ol', { className: 'od-timeline' }, rows.map(function (h) {
      var what = h.from_status === null || h.from_status === undefined
        ? 'Recorded as ' + f.statusLabel(h.to_status)
        : f.statusLabel(h.from_status) + ' → ' + f.statusLabel(h.to_status);
      return el('li', null, [
        el('p', { className: 'od-timeline-what', text: what }),
        el('p', { className: 'od-meta cc-num', text: f.dateTime(h.changed_at) + (text(h.changed_by) ? ' · ' + h.changed_by : '') }),
        text(h.note) ? el('p', { className: 'od-note-body', text: h.note }) : null
      ]);
    })));
  }

  function notes(rows, legacy) {
    var children = [];
    if (text(legacy)) {
      children.push(el('div', { className: 'od-note' }, [
        el('p', { className: 'od-meta', text: 'Note on the order record' }),
        el('p', { className: 'od-note-body', text: legacy })
      ]));
    }
    rows.forEach(function (n) {
      children.push(el('div', { className: 'od-note' }, [
        el('p', { className: 'od-note-body', text: f.dash(n.body) }),
        el('p', { className: 'od-meta cc-num', text: f.dateTime(n.created_at) + (text(n.author_email) ? ' · ' + n.author_email : '') })
      ]));
    });
    return section('Notes', children.length ? children : none('No notes'));
  }

  function allocations(rows) {
    if (!rows.length) return null;
    return section('Stock drawn for this order', el('ul', { className: 'od-rows' }, rows.map(function (a) {
      var released = text(a.released_at);
      return el('li', { className: released ? 'is-released' : null }, [
        el('p', { className: 'od-row-main' }, [
          el('span', { text: f.dash(a.product_id) + ' · ' + f.dash(a.pack_size) }),
          el('span', { className: 'cc-num', text: f.count(a.quantity) + (a.quantity === 1 ? ' unit' : ' units') })
        ]),
        el('p', { className: 'od-meta cc-num', text: (released ? 'Released ' + f.dateTime(a.released_at) : 'Held')
          + ' · drawn ' + f.dateTime(a.allocated_at) + (text(a.allocated_by) ? ' by ' + a.allocated_by : '') })
      ]);
    })));
  }

  function mappings(rows) {
    if (!rows.length) return null;
    return section('Items matched to products', el('ul', { className: 'od-rows' }, rows.map(function (m) {
      var undone = text(m.reverted_at);
      return el('li', { className: undone ? 'is-released' : null }, [
        el('p', { className: 'od-row-main' }, [
          el('span', { text: f.dash(m.match_description) + ' × ' + f.count(m.match_quantity) }),
          el('span', { text: f.dash(m.product_id) + ' · ' + f.dash(m.pack_size) })
        ]),
        text(m.note) ? el('p', { className: 'od-note-body', text: m.note }) : null,
        el('p', { className: 'od-meta cc-num', text: 'Matched ' + f.dateTime(m.mapped_at) + (text(m.mapped_by) ? ' by ' + m.mapped_by : '') }),
        undone ? el('p', { className: 'od-meta', text: 'Undone ' + f.dateTime(m.reverted_at) + ' by ' + f.dash(m.reverted_by)
          + (text(m.revert_note) ? ': ' + m.revert_note : '') }) : null
      ]);
    })));
  }

  function cost(c) {
    return section('Cost of goods', [
      facts([
        ['Cost of goods', f.minorAmount(c.cogs_cents)],
        ['Units ordered', f.count(c.units_ordered)],
        ['Units costed', f.count(c.units_costed)],
        ['Complete', c.cost_complete === true ? 'Complete' : c.cost_complete === false
          ? 'Incomplete: some units are not drawn from stock or have no cost' : '—']
      ]),
      el('p', { className: 'cc-caption', text: 'Lot costs carry their own currency, so cost of goods is shown without one.' })
    ]);
  }

  /* -------------------------------------------------------------------- draw */

  function draw(data) {
    var o = isObject(data.order) ? data.order : {};
    var ws = $('od-workspace');
    ui.clear(ws);
    var main = el('div', { className: 'od-main' }, [
      lines(list(data.items), o.currency),
      history(list(data.history)),
      notes(list(data.notes), o.notes),
      allocations(list(data.allocations)),
      mappings(list(data.mappings))
    ]);
    var side = el('div', { className: 'od-side' }, [
      customer(o), shipping(o), totals(o), reference(o),
      isObject(data.cost) ? cost(data.cost) : null
    ]);
    ws.appendChild(header(o, data.attention));
    ws.appendChild(el('div', { className: 'od-grid' }, [main, side]));
    ws.hidden = false;
    $('od-updated').textContent = 'Updated ' + f.time(new Date());
  }

  function load() {
    var mine = ++seq;
    var notice = $('od-notice');
    if ($('od-workspace').hidden) {
      ui.states.loading(notice, 'Loading the order…');
      notice.hidden = false;
    } else {
      $('od-workspace').setAttribute('aria-busy', 'true');
    }
    C.api.requestAdmin('admin-orders', { params: { id: orderId } }).then(function (data) {
      if (mine !== seq) return;
      $('od-workspace').removeAttribute('aria-busy');
      notice.hidden = true;
      draw(data || {});
    }, function (err) {
      if (mine !== seq) return;
      $('od-workspace').removeAttribute('aria-busy');
      ui.states.error(notice, err, load);
      notice.hidden = false;
    });
  }

  C.ready(function () {
    el = C.ui.el;
    ui = C.ui;
    f = C.format;
    var notice = $('od-notice');
    var id = new w.URLSearchParams(w.location.search).get('id');
    if (!f.isUuid(id)) {
      ui.states.empty(notice, 'No order selected', 'Open an order from the business overview.');
      return;
    }
    orderId = id;
    $('od-refresh').addEventListener('click', load);
    C.page.signedIn(notice).then(function (ok) {
      if (!ok) return;
      $('od-refresh').hidden = false;
      load();
    });
  });
})(window, document);
