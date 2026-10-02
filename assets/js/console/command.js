/* Operations console: the business overview (console/index.html).

   One screen: sales, orders, customers and stock at a glance, the orders in
   each stage, what needs attention, recent orders, recent activity and low
   stock. Read-only. Everything shown is a value the read API returns; the
   only arithmetic is presentation (formatting, "N more").

   One refresh asks every source at once and draws them together. A refresh
   started later always wins: an answer to an earlier one is dropped (seq).
   A section the signed-in person has no access to (403) is left out, not
   shown as refused; any other failure is shown in that section with a retry.
   No polling: the data changes when Refresh is pressed. */
(function (w, d) {
  'use strict';

  var C = w.TRConsole;
  var el, ui, f;
  var seq = 0;
  var loaded = false;

  var RECENT = 8;
  var ATTENTION_LIST = 5;
  var ACTIVITY = 6;
  var STOCK = 6;

  // What each audit action means, in the owner's words (admin_audit_log,
  // migration 0004). An action not listed here reads "Change recorded".
  var ACTIONS = {
    'order.add_note': 'Note added to an order',
    'order.ship': 'Order shipped',
    'fulfilment.allocate': 'Stock set aside for an order',
    'fulfilment.release': 'Stock released from an order',
    'fulfilment.map_line': 'Order line matched to a product',
    'fulfilment.unmap_line': 'Order line match undone',
    'inventory.sync_items': 'Stock list updated from the catalogue',
    'inventory.update_item': 'Stock item updated',
    'inventory.receive_lot': 'Stock received',
    'inventory.update_lot': 'Lot details updated',
    'inventory.record_movement': 'Stock adjusted',
    'finance.create_expense': 'Expense recorded',
    'finance.update_expense': 'Expense updated',
    'finance.delete_expense': 'Expense removed',
    'finance.restore_expense': 'Expense restored',
    'finance.stage_import': 'Expense import prepared',
    'finance.import_expenses': 'Expenses imported'
  };

  function $(id) { return d.getElementById(id); }

  function settle(p) {
    return p.then(function (data) { return { ok: true, data: data }; },
                  function (err) { return { ok: false, err: err }; });
  }

  function plural(n, one, many) { return f.count(n) + ' ' + (n === 1 ? one : many); }

  // A link to an order's own page, only for an id that is a real UUID;
  // otherwise the same words, unlinked.
  function toOrder(id, words, cls) {
    return f.isUuid(id)
      ? el('a', { className: cls, href: 'order.html?id=' + encodeURIComponent(id), text: words })
      : el('span', { className: cls, text: words });
  }

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function list(v) { return Array.isArray(v) ? v : []; }

  /* ---------------------------------------------------------------- loading */

  function load() {
    var mine = ++seq;
    var workspace = $('cc-workspace');
    if (loaded) workspace.setAttribute('aria-busy', 'true');

    var api = C.api;
    var asks = [
      api.requestAdmin('admin-dashboard', {}),
      api.requestAdmin('admin-orders', { params: { limit: String(RECENT) } }),
      api.requestAdmin('admin-orders', { params: { attention: '1', limit: String(ATTENTION_LIST) } }),
      api.requestAdmin('admin-customers', { params: { limit: '1' } }),
      api.requestAdmin('admin-inventory', { params: { active: 'true', low: '1' } }),
      api.requestAdmin('admin-audit', { params: { limit: String(ACTIVITY) } })
    ].map(settle);

    Promise.all(asks).then(function (r) {
      if (mine !== seq) return; // a later refresh has started: its answer wins
      workspace.removeAttribute('aria-busy');
      draw({ dashboard: r[0], recent: r[1], attention: r[2], customers: r[3], stock: r[4], activity: r[5] });
    });
  }

  function draw(r) {
    var notice = $('cc-notice');
    if (!r.dashboard.ok) {
      // Everything here needs orders.read, which the dashboard checks first.
      ui.states.error(notice, r.dashboard.err, load);
      notice.hidden = false;
      if (!loaded) $('cc-workspace').hidden = true;
      return;
    }
    var dash = r.dashboard.data || {};
    notice.hidden = true;
    loaded = true;
    $('cc-workspace').hidden = false;
    $('cc-updated').textContent = 'Updated ' + f.time(new Date());

    snapshot(dash, r.customers);
    stages(isObject(dash.orders) ? dash.orders : {});
    attention(dash, r.attention);
    section('recent', r.recent, recent);
    section('activity', r.activity, activity);
    if (isObject(dash.inventory)) section('stock', r.stock, stock);
    else $('cc-stock').hidden = true;
  }

  // A section's own answer: drawn, left out (no access), or an error with retry.
  function section(key, result, render) {
    var box = $('cc-' + key);
    var body = $('cc-' + key + '-body');
    if (!result.ok && result.err && result.err.kind === 'forbidden') {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (!result.ok) {
      ui.states.error(body, result.err, load);
      return;
    }
    ui.clear(body);
    body.removeAttribute('data-error-kind');
    body.setAttribute('data-state', 'ready');
    render(body, result.data || {});
  }

  /* --------------------------------------------------------------- snapshot */

  function figure(label, value, opts) {
    opts = opts || {};
    return el('div', { className: 'cc-figure' + (opts.warn ? ' is-warn' : '') }, [
      el('dt', { className: 'cc-figure-label', text: label }),
      el('dd', { className: 'cc-figure-value', text: value })
    ]);
  }

  function group(key, title, figures, foot) {
    return el('div', { className: 'cc-group', 'data-group': key }, [
      el('h3', { className: 'cc-group-title', text: title }),
      el('dl', { className: 'cc-figures' }, figures),
      foot || null
    ]);
  }

  function snapshot(dash, customers) {
    var body = $('cc-snapshot-body');
    ui.clear(body);
    var groups = [];
    var fin = isObject(dash.finance) ? dash.finance : null;
    var inv = isObject(dash.inventory) ? dash.inventory : null;

    if (fin) {
      var mixed = typeof fin.currencies === 'number' && fin.currencies > 1;
      groups.push(group('sales', 'Sales', [
        figure('Today', f.minorAmount(fin.revenue_today_cents)),
        figure('Last 7 days', f.minorAmount(fin.revenue_7d_cents)),
        figure('Last 30 days', f.minorAmount(fin.revenue_30d_cents))
      ], el('p', { className: 'cc-caption' + (mixed ? ' is-warn' : ''),
                   text: mixed ? 'Adds together ' + f.count(fin.currencies) + ' currencies. Gross, including shipping, before fees and tax.'
                               : 'Gross, including shipping, before fees and tax.' })));
      groups.push(group('orders', 'Orders', [
        figure('Today', f.count(fin.orders_today)),
        figure('Last 7 days', f.count(fin.orders_7d)),
        figure('Average order, 30 days', f.minorAmount(fin.average_order_30d_cents))
      ]));
    }

    if (customers.ok) {
      var rows = list((customers.data || {}).summary);
      var figs = [];
      if (rows.length <= 1) {
        var one = rows[0] || {};
        figs.push(figure('Customers', f.count(one.customers)));
        figs.push(figure('Repeat customers', f.count(one.repeat_customers)));
      } else {
        rows.forEach(function (row) {
          figs.push(figure('Customers (' + f.dash(row.currency) + ')', f.count(row.customers)));
        });
      }
      groups.push(group('customers', 'Customers', figs));
    } else if (!(customers.err && customers.err.kind === 'forbidden')) {
      groups.push(group('customers', 'Customers', [figure('Customers', '—')],
        el('p', { className: 'cc-caption', text: 'Could not be loaded. Refresh to try again.' })));
    }

    if (inv) {
      groups.push(group('inventory', 'Inventory', [
        figure('Low stock', f.count(inv.low_stock_items), { warn: inv.low_stock_items > 0 }),
        figure('Retest due within 30 days', f.count(inv.lots_retest_due_30d), { warn: inv.lots_retest_due_30d > 0 }),
        figure('Retest overdue', f.count(inv.lots_retest_overdue), { warn: inv.lots_retest_overdue > 0 })
      ]));
    }

    groups.forEach(function (g) { body.appendChild(g); });
    $('cc-snapshot').hidden = groups.length === 0;
  }

  /* ----------------------------------------------------------------- stages */

  function stages(orders) {
    var body = $('cc-stages-body');
    ui.clear(body);
    body.setAttribute('data-state', 'ready');
    var counts = {};
    list(orders.status_counts).forEach(function (row) {
      if (row && f.isStatus(row.status)) counts[row.status] = row.orders;
    });
    var cells = f.STATUSES.map(function (s) {
      var n = counts[s];
      return el('li', { className: 'cc-stage' + (n ? '' : ' is-zero'), 'data-status': s }, [
        el('span', { className: 'cc-stage-label', text: f.statusLabel(s) }),
        el('span', { className: 'cc-stage-count', text: f.count(typeof n === 'number' ? n : null) })
      ]);
    });
    body.appendChild(el('ul', { className: 'cc-stages' }, cells));
  }

  /* -------------------------------------------------------------- attention */

  function item(text, children) {
    return el('li', { className: 'cc-alert' }, [
      el('span', { className: 'cc-alert-mark', 'aria-hidden': 'true' }),
      el('div', { className: 'cc-alert-body' }, [el('p', { className: 'cc-alert-text', text: text })].concat(children || []))
    ]);
  }

  function attention(dash, listResult) {
    var body = $('cc-attention-body');
    ui.clear(body);
    body.setAttribute('data-state', 'ready');
    var items = [];
    var orders = isObject(dash.orders) ? dash.orders : {};
    var inv = isObject(dash.inventory) ? dash.inventory : {};
    var fin = isObject(dash.finance) ? dash.finance : {};

    var n = orders.orders_needing_attention;
    if (typeof n === 'number' && n > 0) {
      var rows = listResult.ok ? list((listResult.data || {}).orders).filter(function (o) {
        return o && typeof o.attention_reason === 'string' && o.attention_reason !== '';
      }).slice(0, ATTENTION_LIST) : [];
      var sub = rows.length ? el('ul', { className: 'cc-alert-list' }, rows.map(function (o) {
        return el('li', null, [
          toOrder(o.order_id, f.dash(o.name), 'cc-alert-who'),
          el('span', { className: 'cc-alert-why', text: o.attention_reason })
        ]);
      })) : null;
      items.push(item(plural(n, 'order needs attention', 'orders need attention'), [sub]));
    }
    if (inv.low_stock_items > 0) items.push(item(plural(inv.low_stock_items, 'product is low on stock', 'products are low on stock')));
    if (inv.lots_retest_overdue > 0) items.push(item(plural(inv.lots_retest_overdue, 'lot is overdue for retest', 'lots are overdue for retest')));
    if (inv.lots_retest_due_30d > 0) {
      items.push(item(plural(inv.lots_retest_due_30d, 'lot needs', 'lots need') + ' retesting within 30 days, overdue ones included'));
    }
    if (fin.currencies > 1) {
      items.push(item('Sales figures add together ' + f.count(fin.currencies) + ' currencies, so the totals cannot be read as one figure'));
    }

    if (!items.length) {
      body.appendChild(el('p', { className: 'cc-clear' }, [
        el('span', { className: 'cc-clear-mark', 'aria-hidden': 'true', text: '✓' }),
        'Nothing needs attention right now.'
      ]));
      return;
    }
    body.appendChild(el('ul', { className: 'cc-alerts' }, items));
  }

  /* ---------------------------------------------------------- recent orders */

  function badge(status) {
    return el('span', { className: 'console-badge', 'data-status': f.isStatus(status) ? status : 'other', text: f.statusLabel(status) });
  }

  function recent(body, data) {
    var rows = list(data.orders).slice(0, RECENT);
    if (!rows.length) {
      ui.states.empty(body, 'No orders yet');
      return;
    }
    var head = el('thead', null, el('tr', null, ['Received', 'Customer', 'Total', 'Status'].map(function (h) {
      return el('th', { scope: 'col', text: h });
    })));
    var trs = rows.map(function (o) {
      return el('tr', null, [
        el('td', { 'data-label': 'Received', className: 'cc-num', text: f.when(o.created_at) }),
        el('td', { 'data-label': 'Customer' }, toOrder(o.order_id, f.dash(o.name), 'cc-order-link')),
        el('td', { 'data-label': 'Total', className: 'cc-num', text: f.money(o.amount_total, o.currency) }),
        el('td', { 'data-label': 'Status' }, badge(o.status))
      ]);
    });
    body.appendChild(el('table', { className: 'console-table cc-recent-table' }, [
      el('caption', { className: 'sr-only', text: 'The most recent orders, newest first' }), head, el('tbody', null, trs)
    ]));
  }

  /* ---------------------------------------------------------------- activity */

  function describe(entry) {
    if (entry.action === 'order.set_status') {
      var to = isObject(entry.details) ? entry.details.to : null;
      return f.isStatus(to) ? 'Order moved to ' + f.statusLabel(to) : 'Order status changed';
    }
    return Object.prototype.hasOwnProperty.call(ACTIONS, entry.action) ? ACTIONS[entry.action] : 'Change recorded';
  }

  function activity(body, data) {
    var rows = list(data.entries).slice(0, ACTIVITY);
    if (!rows.length) {
      ui.states.empty(body, 'No recent changes', 'Changes made in the console appear here.');
      return;
    }
    body.appendChild(el('ol', { className: 'cc-activity' }, rows.map(function (e) {
      var meta = f.when(e.occurred_at) + (e.actor_email ? ' \u00b7 ' + e.actor_email : '');
      return el('li', { className: 'cc-activity-item' }, [
        e.entity_type === 'order' ? toOrder(e.entity_id, describe(e), 'cc-activity-what')
                                  : el('span', { className: 'cc-activity-what', text: describe(e) }),
        el('span', { className: 'cc-activity-meta cc-num', text: meta })
      ]);
    })));
  }

  /* ------------------------------------------------------------------- stock */

  function stock(body, data) {
    var rows = list(data.items).filter(function (i) { return i && i.is_low === true; });
    if (!rows.length) {
      ui.states.empty(body, 'Nothing is low on stock');
      return;
    }
    var shown = rows.slice(0, STOCK);
    var items = shown.map(function (i) {
      return el('li', { className: 'cc-stock-item' }, [
        el('span', { className: 'cc-stock-name' }, [
          el('span', { text: f.dash(i.product_id) }),
          el('span', { className: 'cc-stock-pack', text: f.dash(i.pack_size) })
        ]),
        el('span', { className: 'cc-stock-level cc-num' }, [
          el('span', { text: f.count(i.available) + ' available' }),
          el('span', { className: 'cc-stock-threshold', text: 'reorder at ' + f.count(i.low_stock_threshold) })
        ])
      ]);
    });
    body.appendChild(el('ul', { className: 'cc-stock' }, items));
    if (rows.length > shown.length) {
      body.appendChild(el('p', { className: 'cc-caption', text: 'and ' + f.count(rows.length - shown.length) + ' more' }));
    }
  }

  /* --------------------------------------------------------------------- CSV */

  // Every order, as a file (csv.js). The button waits while one is being
  // built, so a second click cannot start a second export.
  function downloadCsv() {
    var btn = $('cc-csv');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    C.csv.exportOrders().then(function (r) {
      ui.toast(r.capped
        ? 'Downloaded the ' + f.count(r.count) + ' most recent orders. Older orders are not in this file.'
        : 'Downloaded ' + plural(r.count, 'order', 'orders') + '.');
    }, function (err) {
      var kind = err && err.kind === 'forbidden' ? 'Your account does not have access to orders.'
        : 'The orders could not all be read, so nothing was downloaded. Try again shortly.';
      ui.toast(kind, 8000);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Download CSV';
    });
  }

  /* -------------------------------------------------------------------- start */

  C.ready(function () {
    el = C.ui.el;
    ui = C.ui;
    f = C.format;
    $('cc-refresh').addEventListener('click', load);
    $('cc-csv').addEventListener('click', downloadCsv);
    C.page.signedIn($('cc-notice')).then(function (ok) {
      if (!ok) return;
      $('cc-refresh').hidden = false;
      ui.states.loading($('cc-notice'), 'Loading the business overview…');
      $('cc-notice').hidden = false;
      load();
    });
  });
})(window, document);
