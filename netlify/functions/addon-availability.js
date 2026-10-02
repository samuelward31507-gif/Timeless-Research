/*
 * Which stock-tracked add-ons are in stock, for the cart.
 *
 *   GET /.netlify/functions/addon-availability
 *   -> { "available": { "insulated-shipper": true, ... } }
 *
 * Booleans only: stock counts are the operator's business, not a visitor's.
 * Read from the addon_stock_levels view (supabase/migrations/0002_addons.sql)
 * with the service role key, the same way stripe-webhook.js writes orders,
 * because RLS lets nothing else read it.
 *
 * Fails closed. If the database is not configured, cannot be reached, or has
 * no figure for an add-on, that add-on is reported unavailable, and the
 * server-side check (netlify/lib/addons.js) refuses it at checkout as well.
 * Add-ons that do not track inventory are not listed: they are always
 * available while enabled.
 *
 * Nothing here concerns payment.
 */
'use strict';

const TABLE = require('./addons.json');
const { availability } = require('../lib/addons.js');

function json(statusCode, body, cache) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cache || 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

async function stockLevels(ids) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    console.error('addon-availability: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to read stock; ' +
                  'reporting tracked add-ons as unavailable.');
    return null;
  }
  const filter = ids.map((id) => encodeURIComponent(`"${id}"`)).join(',');
  const res = await fetch(`${base}/rest/v1/addon_stock_levels?select=addon_id,available&addon_id=in.(${filter})`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  const rows = await res.json();
  const levels = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && typeof r.addon_id === 'string' && typeof r.available === 'number') levels[r.addon_id] = r.available;
  }
  return levels;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });

  const tracked = Object.keys(TABLE.addons || {}).filter((id) => TABLE.addons[id].trackInventory);
  if (!tracked.length) return json(200, { available: {} }, 'public, max-age=300');

  let levels = null;
  try {
    levels = await stockLevels(tracked);
  } catch (err) {
    console.error('addon-availability: could not read stock:', err.message);
    levels = null;
  }
  // A short cache: long enough to spare the database a query per cart
  // opening, short enough that a sell-out shows within a minute. The server
  // re-checks stock before taking payment, so this is never the last word.
  return json(200, { available: availability(TABLE, levels) },
              levels ? 'public, max-age=60' : 'no-store');
};
