/* Operations console: the orders CSV.

   One row per order, built in the browser from the read API the overview
   already uses (admin-orders, newest first, 100 at a time), so no new
   endpoint and nothing written anywhere but the file the owner saves. The
   columns are the order queue's: no phone and no address. It is meant to be
   imported elsewhere, so it is predictable:

   - UTF-8 with a byte-order mark (spreadsheets then read accents correctly),
     comma-separated, CRLF line ends, RFC 4180 quoting;
   - the header row below is the contract: names, order and meaning stay put;
   - timestamps exactly as the API gives them (ISO 8601, UTC);
   - amounts twice: amount_total_minor, the integer the API holds, and
     amount_total, the same in the currency's own decimals;
   - a text cell that a spreadsheet would run as a formula (starting = + - @,
     tab or carriage return) is prefixed with an apostrophe.

   At most MAX_ROWS orders, the most recent; the caller is told when there
   were more. Nothing is saved unless every page arrives. */
(function (w, d) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};

  var PAGE = 100;
  var MAX_ROWS = 10000;

  // [header, value(row, format)] in file order.
  var COLUMNS = [
    ['order_id', function (r) { return r.order_id; }],
    ['created_at', function (r) { return r.created_at; }],
    ['status', function (r) { return r.status; }],
    ['status_since', function (r) { return r.in_status_since; }],
    ['customer_name', function (r) { return r.name; }],
    ['customer_email', function (r) { return r.email; }],
    ['currency', function (r) { return r.currency; }],
    ['amount_total_minor', function (r) { return r.amount_total; }],
    ['amount_total', function (r, f) { return decimal(r.amount_total, f.digits(r.currency)); }],
    ['product_lines', function (r) { return r.product_lines; }],
    ['product_units', function (r) { return r.product_units; }],
    ['addon_lines', function (r) { return r.addon_lines; }],
    ['carrier', function (r) { return r.carrier; }],
    ['tracking_number', function (r) { return r.tracking_number; }],
    ['shipped_at', function (r) { return r.shipped_at; }],
    ['delivered_at', function (r) { return r.delivered_at; }],
    ['payment_reference', function (r) { return r.reference; }],
    ['needs_attention', function (r) { return r.attention_reason; }],
    ['note_count', function (r) { return r.note_count; }]
  ];

  // Minor units to a plain decimal string ("14500", 2 -> "145.00"), exactly,
  // without floating point. Unknown currency or amount: empty.
  function decimal(minor, places) {
    if (typeof minor !== 'number' || !isFinite(minor) || Math.floor(minor) !== minor || typeof places !== 'number') return '';
    var sign = minor < 0 ? '-' : '';
    var digits = String(Math.abs(minor));
    if (places === 0) return sign + digits;
    while (digits.length <= places) digits = '0' + digits;
    return sign + digits.slice(0, -places) + '.' + digits.slice(-places);
  }

  function cell(v) {
    if (v === null || v === undefined) return '';
    var s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
    // Text a spreadsheet would run as a formula; a plain number is left alone.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function build(rows) {
    var f = C.format;
    var lines = [COLUMNS.map(function (c) { return c[0]; }).join(',')];
    rows.forEach(function (r) {
      lines.push(COLUMNS.map(function (c) { return cell(c[1](r || {}, f)); }).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // Every order, newest first, a page at a time. Resolves { rows, capped }.
  function fetchOrders() {
    var rows = [];
    function next(cursor) {
      var params = { limit: String(PAGE) };
      if (cursor) params.cursor = cursor;
      return C.api.requestAdmin('admin-orders', { params: params }).then(function (data) {
        var page = data && Array.isArray(data.orders) ? data.orders : [];
        rows = rows.concat(page);
        var more = data && typeof data.next_cursor === 'string' && data.next_cursor !== '';
        if (rows.length >= MAX_ROWS) return { rows: rows.slice(0, MAX_ROWS), capped: more || rows.length > MAX_ROWS };
        return more && page.length ? next(data.next_cursor) : { rows: rows, capped: false };
      });
    }
    return next(null);
  }

  function filename(now) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'orders-' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '.csv';
  }

  function save(content, name) {
    var url = w.URL.createObjectURL(new w.Blob([content], { type: 'text/csv;charset=utf-8' }));
    var a = C.ui.el('a', { href: url, download: name, hidden: true });
    d.body.appendChild(a);
    a.click();
    d.body.removeChild(a);
    w.setTimeout(function () { w.URL.revokeObjectURL(url); }, 10000);
  }

  // Fetches every order and saves the file. Resolves { count, capped };
  // rejects with the ConsoleError if any page fails (and saves nothing).
  function exportOrders() {
    return fetchOrders().then(function (result) {
      save(build(result.rows), filename(new Date()));
      return { count: result.rows.length, capped: result.capped };
    });
  }

  C.csv = { exportOrders: exportOrders, build: build, decimal: decimal, COLUMNS: COLUMNS.map(function (c) { return c[0]; }), MAX_ROWS: MAX_ROWS };
})(window, document);
