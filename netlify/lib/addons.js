/*
 * Optional add-ons, server side. Payment-provider agnostic on purpose.
 *
 * The flow this serves:
 *
 *   product -> eligible add-on offered on its cart line -> customer ticks it
 *   -> cart -> HERE: validated and priced -> the payment integration charges
 *   the neutral lines this returns, in its own format -> payment confirmed ->
 *   the order records each add-on as its own line (orderItemRows) -> the
 *   database's record_addon_sales() takes it out of stock.
 *
 * Nothing in this file knows which processor takes the money. It reads the
 * table tools/build.py writes to netlify/functions/addons.json, takes product
 * lines the caller has ALREADY validated and priced, and returns either an
 * error sentence for the customer or plain line objects with amounts in cents.
 *
 * The same rule as the catalogue: the browser says which add-ons it wants and
 * nothing else. Prices, quantities, the rule an add-on was offered under and
 * whether it may be offered on that product at all are all decided here.
 *
 * Add-ons never change the product line they are attached to: not its price,
 * not its volume tier, not the free-shipping threshold, which stays measured on
 * catalogue goods. Callers keep the two totals apart.
 */
'use strict';

const MAX_ADDONS_PER_LINE = 10;

function cents(price) {
  return Math.round(Number(price) * 100);
}

/* [{addon, rule}] that may be offered on a line of this product. */
function offeredFor(table, productId) {
  const e = table && table.eligibility;
  return (e && Object.prototype.hasOwnProperty.call(e, productId) && e[productId]) || [];
}

function fail(error, code) {
  return { ok: false, error, code };
}

/**
 * Validates and prices the add-ons selected on each product line.
 *
 * table  the parsed netlify/functions/addons.json
 * lines  [{ id, size, qty, name?, addons? }] — product lines already checked
 *        by the caller (known product, buyable, valid size, integer qty).
 *        `addons` is what the browser sent: an array of add-on ids.
 * stock  { addonId: units available } for add-ons that track inventory, or
 *        null when stock could not be read. A tracked add-on with no figure is
 *        refused: selling stock we cannot see is how orders go unfilled.
 *
 * Returns { ok: true, lines, totalCents } or { ok: false, error, code }.
 */
function priceAddons(table, lines, stock) {
  const out = [];
  const demand = new Map();
  const anySelected = (lines || []).some((l) => Array.isArray(l.addons) && l.addons.length);

  if (anySelected && !(table && table.paymentIntegrationReady)) {
    return fail('Add-ons are not available yet. Please remove them from your cart.', 'not_ready');
  }

  for (const line of lines || []) {
    const sel = line.addons === undefined ? [] : line.addons;
    if (!Array.isArray(sel)) return fail('That cart could not be read.', 'bad_request');
    if (sel.length > MAX_ADDONS_PER_LINE) return fail('That item has too many add-ons.', 'bad_request');

    const offered = offeredFor(table, line.id);
    const seen = new Set();
    for (const addonId of sel) {
      if (typeof addonId !== 'string') return fail('That cart could not be read.', 'bad_request');
      if (seen.has(addonId)) return fail('That cart has the same add-on on one item twice.', 'duplicate');
      seen.add(addonId);

      const def = Object.prototype.hasOwnProperty.call(table.addons || {}, addonId)
        ? table.addons[addonId] : null;
      if (!def) return fail('An add-on in your cart is no longer offered. Please remove it.', 'unknown_addon');

      const offer = offered.find((o) => o.addon === addonId);
      if (!offer) {
        return fail(`${def.name} cannot be added to ${line.name || 'that item'}.`, 'not_eligible');
      }

      const quantity = def.quantity === 'per-unit' ? line.qty : 1;
      if (def.trackInventory) demand.set(addonId, (demand.get(addonId) || 0) + quantity);

      const unitCents = cents(def.price);
      out.push({
        kind: 'addon',
        addonId,
        ruleId: offer.rule,
        addonKind: def.kind,
        name: def.name,
        description: def.description,
        label: line.name ? `${def.name} (for ${line.name}, ${line.size})` : def.name,
        parentId: line.id,
        parentSize: line.size,
        quantity,
        unitCents,
        amountCents: unitCents * quantity,
        trackInventory: !!def.trackInventory
      });
    }
  }

  for (const [addonId, wanted] of demand) {
    const have = stock && typeof stock[addonId] === 'number' ? stock[addonId] : null;
    const name = table.addons[addonId].name;
    if (have === null) return fail(`${name} is unavailable right now. Please remove it and try again.`, 'stock_unknown');
    if (wanted > have) {
      return fail(have > 0
        ? `Only ${have} of ${name} left. Please reduce it and try again.`
        : `${name} is out of stock. Please remove it and try again.`, 'out_of_stock');
    }
  }

  return { ok: true, lines: out, totalCents: out.reduce((t, l) => t + l.amountCents, 0) };
}

/**
 * In stock or not, per tracked add-on, for the cart. Booleans only: stock
 * counts are the operator's business, not the visitor's.
 * levels is { addonId: units available }, or null when it could not be read.
 */
function availability(table, levels) {
  const out = {};
  for (const [id, def] of Object.entries((table && table.addons) || {})) {
    if (!def.trackInventory) continue;
    out[id] = !!(levels && typeof levels[id] === 'number' && levels[id] > 0);
  }
  return out;
}

/**
 * Rows for public.order_items (supabase/migrations/0002_addons.sql), for
 * whichever integration records a confirmed payment. Product lines carry the
 * add-ons they were offered, decided here from the table rather than from
 * anything the browser said, which is what the attach-rate report divides by.
 *
 * productLines [{ id, size, qty, name, unitCents, amountCents }]
 * addonLines   the `lines` from a successful priceAddons()
 */
function orderItemRows(table, orderId, productLines, addonLines) {
  const rows = productLines.map((p) => ({
    order_id: orderId,
    kind: 'product',
    sku: p.id,
    pack_size: p.size,
    description: p.name ? `${p.name} — ${p.size}` : null,
    quantity: p.qty,
    unit_amount: p.unitCents,
    amount_total: p.amountCents,
    offered_addons: offeredFor(table, p.id)
  }));
  for (const a of addonLines) {
    rows.push({
      order_id: orderId,
      kind: 'addon',
      sku: a.addonId,
      addon_id: a.addonId,
      rule_id: a.ruleId,
      parent_sku: a.parentId,
      parent_pack_size: a.parentSize,
      description: a.label,
      quantity: a.quantity,
      unit_amount: a.unitCents,
      amount_total: a.amountCents,
      offered_addons: null
    });
  }
  return rows;
}

module.exports = { priceAddons, availability, offeredFor, orderItemRows, MAX_ADDONS_PER_LINE };
