/* Operations console: how values are shown. Shared by every screen, so a
   status, an amount or a date reads the same everywhere.

   Nothing here calculates a business figure: it only presents the values the
   API returns. Every function returns plain text, for ui.el()'s `text`.

     STATUSES, statusLabel(s), isStatus(s), isUuid(s)
     money(minor, currency)   an amount in the order's own currency
     minorAmount(minor)       an amount the API gives without a currency
     count(n), dateTime(iso), date(iso), time(iso), when(iso), dash(v) */
(function (w) {
  'use strict';

  var C = w.TRConsole = w.TRConsole || {};
  var NONE = '—';

  // The order statuses, in the API's order (admin-dashboard, admin-orders).
  var STATUSES = ['paid', 'processing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'];
  var LABELS = {
    paid: 'Paid', processing: 'Processing', packed: 'Packed', shipped: 'Shipped',
    delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded'
  };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var CURRENCY = /^[A-Za-z]{3}$/;

  function isStatus(s) { return typeof s === 'string' && Object.prototype.hasOwnProperty.call(LABELS, s); }
  function statusLabel(s) { return isStatus(s) ? LABELS[s] : dash(s); }
  function isUuid(s) { return typeof s === 'string' && UUID.test(s); }

  function isNumber(n) { return typeof n === 'number' && isFinite(n); }

  function dash(v) {
    if (v === null || v === undefined) return NONE;
    var s = String(v);
    return s.trim() === '' ? NONE : s;
  }

  function count(n) {
    return isNumber(n) ? Math.round(n).toLocaleString('en-US') : NONE;
  }

  // Grouped, two decimal places, no currency symbol: for the amounts the API
  // returns without a currency (dashboard sales, cost of goods).
  function minorAmount(minor) {
    if (!isNumber(minor)) return NONE;
    return (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // How many decimal places a currency shows (2 for USD, 0 for JPY), from the
  // browser's own currency data. Null for a code it does not know.
  function digits(code) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
    } catch (e) {
      return null;
    }
  }

  function money(minor, currency) {
    if (!isNumber(minor)) return NONE;
    var code = typeof currency === 'string' && CURRENCY.test(currency) ? currency.toUpperCase() : null;
    var places = code === null ? null : digits(code);
    if (places === null) return currency ? minorAmount(minor) + ' ' + String(currency) : minorAmount(minor);
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(minor / Math.pow(10, places));
  }

  function parse(iso) {
    if (typeof iso !== 'string' || iso === '') return null;
    var t = new Date(iso);
    return isNaN(t.getTime()) ? null : t;
  }

  function stamp(iso, opts) {
    var t = iso instanceof Date ? iso : parse(iso);
    return t ? new Intl.DateTimeFormat(undefined, opts).format(t) : NONE;
  }

  function dateTime(iso) { return stamp(iso, { dateStyle: 'medium', timeStyle: 'short' }); }
  function date(iso) { return stamp(iso, { dateStyle: 'medium' }); }
  function time(iso) { return stamp(iso, { timeStyle: 'short' }); }
  // Compact, for lists: "Oct 2, 9:59 AM".
  function when(iso) { return stamp(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

  C.format = {
    STATUSES: STATUSES.slice(), statusLabel: statusLabel, isStatus: isStatus, isUuid: isUuid,
    money: money, minorAmount: minorAmount, count: count, dateTime: dateTime, date: date, time: time, when: when,
    dash: dash, digits: digits
  };
})(window);
