/*
 * Order intake: records a paid order, whoever took the payment.
 *
 * Payment is an abstraction here. A payment integration (the Stripe webhook
 * today, or any other provider later) verifies its own event, turns it into
 * the plain object below, and calls recordPaidOrder(). Nothing in this file
 * knows which provider took the money, and no provider code depends on it
 * yet: the Stripe webhook still records orders its own way until it is moved
 * over.
 *
 *   recordPaidOrder({
 *     reference,            the provider's unique id for this payment (a
 *                           checkout session id, an invoice number); stored
 *                           in orders.stripe_session_id, the schema's name for
 *                           "the payment's reference", which is what makes a
 *                           redelivered event a no-op
 *     paymentReference,     optional second id (a payment intent, a charge)
 *     email, name, phone,   optional, as the provider collected them (tidied,
 *                           never refused for their content: see prose())
 *     amountTotal,          integer minor units (cents), required
 *     amountSubtotal,       optional
 *     amountShipping,       default 0
 *     amountDiscount,       default 0
 *     currency,             ISO 4217, three capital letters
 *     shippingAddress,      null or { line1, line2, city, state, postal_code, country }
 *     researchUseConfirmed, boolean, as confirmed at checkout
 *     items                 order_items rows exactly as addons.orderItemRows()
 *                           builds them (its order_id is ignored)
 *   })
 *   -> { orderId, created, status, consistent }
 *
 * Everything happens in one transaction (netlify/lib/db.js), as peptide_app:
 *
 *   1. insert the order, or do nothing if this reference is already recorded;
 *   2. insert its lines, only if the order has none yet;
 *   3. record its add-on stock sales (record_addon_sales, idempotent);
 *   4. read back what is stored.
 *
 * A new order and its lines appear together or not at all, and the order's
 * two owner notifications are queued by the database in the same transaction
 * (migration 0005's trigger). A redelivery of an order already recorded
 * changes nothing: not its status (it may have shipped since), not its lines
 * (they may be allocated to lots), not its stock. `created` says which
 * happened, and `consistent` is false when the redelivery's total or currency
 * differ from what is stored, for the caller to log; the stored order wins.
 *
 * The input is validated in full before anything is sent. A malformed order
 * is an OrderInputError naming the field, never a partial write; a database
 * failure is db.js's DbError, unchanged.
 */
'use strict';

const db = require('./db.js');

const INT_MAX = 2147483647;
const MAX_LINES = 100;
const MAX_OFFERED = 50;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/; // product, add-on and rule ids (products.json, addons.json)
const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'];
const ORDER_FIELDS = ['reference', 'paymentReference', 'email', 'name', 'phone', 'amountTotal', 'amountSubtotal',
  'amountShipping', 'amountDiscount', 'currency', 'shippingAddress', 'researchUseConfirmed', 'items'];
const LINE_FIELDS = ['order_id', 'kind', 'sku', 'pack_size', 'addon_id', 'rule_id', 'parent_sku', 'parent_pack_size',
  'description', 'quantity', 'unit_amount', 'amount_total', 'offered_addons'];

class OrderInputError extends Error {
  constructor(field) {
    super(`invalid order: ${field}`);
    this.name = 'OrderInputError';
    this.field = field;
  }
}

/* ------------------------------------------------------------- validation */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAmount = (v) => Number.isInteger(v) && v >= 0 && v <= INT_MAX;

/* An identifier (a sku, an add-on id, a pack size): exact, or refused. */
function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new OrderInputError(field);
    return null;
  }
  if (typeof value !== 'string' || value.length > max || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OrderInputError(field);
  }
  return value;
}

/* What a customer typed (a name, an address line, a line description): kept,
   not refused, because refusing it would lose the record of a payment that has
   been taken. Control characters become spaces and the ends are trimmed; only
   a value that is not a string, or absurdly long, is refused. */
/* A catalogue id: a slug, exactly as products.json and addons.json write it. */
function slug(value, field, { required = false } = {}) {
  const v = text(value, field, 100, { required });
  if (v !== null && !SLUG.test(v)) throw new OrderInputError(field);
  return v;
}

function prose(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new OrderInputError(field);
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (v.length > max) throw new OrderInputError(field);
  return v === '' ? null : v;
}

function amount(value, field, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new OrderInputError(field);
    return fallback;
  }
  if (!isAmount(value)) throw new OrderInputError(field);
  return value;
}

function address(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new OrderInputError('shippingAddress');
  const out = {};
  for (const k of Object.keys(value)) {
    if (!ADDRESS_FIELDS.includes(k)) throw new OrderInputError(`shippingAddress.${k}`);
  }
  for (const k of ADDRESS_FIELDS) {
    const v = prose(value[k], `shippingAddress.${k}`, 500);
    if (k === 'country' && v !== null && !/^[A-Z]{2}$/.test(v)) throw new OrderInputError('shippingAddress.country');
    out[k] = v;
  }
  return out;
}

function offered(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_OFFERED) throw new OrderInputError(field);
  return value.map((e, i) => {
    if (!isObject(e) || Object.keys(e).some((k) => k !== 'addon' && k !== 'rule')) throw new OrderInputError(`${field}[${i}]`);
    return { addon: slug(e.addon, `${field}[${i}].addon`, { required: true }),
             rule: slug(e.rule, `${field}[${i}].rule`, { required: true }) };
  });
}

function line(row, i) {
  const f = (name) => `items[${i}].${name}`;
  if (!isObject(row)) throw new OrderInputError(`items[${i}]`);
  for (const k of Object.keys(row)) if (!LINE_FIELDS.includes(k)) throw new OrderInputError(f(k));
  if (row.order_id !== undefined && row.order_id !== null) throw new OrderInputError(f('order_id'));
  if (row.kind !== 'product' && row.kind !== 'addon') throw new OrderInputError(f('kind'));
  if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 10000) throw new OrderInputError(f('quantity'));
  const out = {
    kind: row.kind,
    sku: slug(row.sku, f('sku')),
    pack_size: text(row.pack_size, f('pack_size'), 50),
    addon_id: slug(row.addon_id, f('addon_id'), { required: row.kind === 'addon' }),
    rule_id: slug(row.rule_id, f('rule_id')),
    parent_sku: slug(row.parent_sku, f('parent_sku'), { required: row.kind === 'addon' }),
    parent_pack_size: text(row.parent_pack_size, f('parent_pack_size'), 50),
    description: prose(row.description, f('description'), 1000),
    quantity: row.quantity,
    unit_amount: amount(row.unit_amount, f('unit_amount')),
    amount_total: amount(row.amount_total, f('amount_total')),
    offered_addons: offered(row.offered_addons, f('offered_addons'))
  };
  if (row.kind === 'product') {
    for (const k of ['addon_id', 'rule_id', 'parent_sku', 'parent_pack_size']) {
      if (out[k] !== null) throw new OrderInputError(f(k));
    }
  } else if (out.offered_addons !== null) {
    throw new OrderInputError(f('offered_addons'));
  }
  return out;
}

/* The order as the values the database will store. Throws OrderInputError. */
function normalize(order) {
  if (!isObject(order)) throw new OrderInputError('order');
  for (const k of Object.keys(order)) if (!ORDER_FIELDS.includes(k)) throw new OrderInputError(k);

  const reference = text(order.reference, 'reference', 255, { required: true });
  if (!REFERENCE.test(reference)) throw new OrderInputError('reference');
  const paymentReference = text(order.paymentReference, 'paymentReference', 255);
  if (paymentReference !== null && !REFERENCE.test(paymentReference)) throw new OrderInputError('paymentReference');
  const email = prose(order.email, 'email', 320);
  if (typeof order.currency !== 'string' || !CURRENCY.test(order.currency)) throw new OrderInputError('currency');
  if (typeof order.researchUseConfirmed !== 'boolean') throw new OrderInputError('researchUseConfirmed');
  if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > MAX_LINES) {
    throw new OrderInputError('items');
  }

  return {
    reference,
    paymentReference,
    email,
    name: prose(order.name, 'name', 500),
    phone: prose(order.phone, 'phone', 100),
    amountTotal: amount(order.amountTotal, 'amountTotal', { required: true }),
    amountSubtotal: amount(order.amountSubtotal, 'amountSubtotal'),
    amountShipping: amount(order.amountShipping, 'amountShipping', { fallback: 0 }),
    amountDiscount: amount(order.amountDiscount, 'amountDiscount', { fallback: 0 }),
    currency: order.currency,
    shippingAddress: address(order.shippingAddress),
    researchUseConfirmed: order.researchUseConfirmed,
    items: order.items.map(line)
  };
}

/* ---------------------------------------------------------------- the SQL */

const INSERT_ORDER = `
  insert into public.orders (stripe_session_id, stripe_payment_intent, email, name, phone, amount_total,
                             amount_subtotal, amount_shipping, amount_discount, currency, shipping_address,
                             research_use_confirmed, status)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'paid')
  on conflict (stripe_session_id) do nothing
  returning id`;

/* All lines in one statement, in the order given, and only for an order that
   has none: a redelivery never touches lines that may already be allocated. */
const INSERT_LINES = `
  insert into public.order_items (order_id, kind, sku, pack_size, addon_id, rule_id, parent_sku, parent_pack_size,
                                  description, quantity, unit_amount, amount_total, offered_addons)
  select o.id, l.kind, l.sku, l.pack_size, l.addon_id, l.rule_id, l.parent_sku, l.parent_pack_size,
         l.description, l.quantity, l.unit_amount, l.amount_total, l.offered_addons
    from public.orders o
   cross join rows from (jsonb_to_recordset($2::jsonb) as (
           kind text, sku text, pack_size text, addon_id text, rule_id text, parent_sku text,
           parent_pack_size text, description text, quantity integer, unit_amount integer,
           amount_total integer, offered_addons jsonb)) with ordinality as l
   where o.stripe_session_id = $1
     and not exists (select 1 from public.order_items i where i.order_id = o.id)
   order by l.ordinality`;

const RECORD_ADDON_SALES = `
  select public.record_addon_sales(o.id) as recorded from public.orders o where o.stripe_session_id = $1`;

const READ_BACK = `
  select o.id, o.status, o.amount_total, o.currency from public.orders o where o.stripe_session_id = $1`;

/* -------------------------------------------------------------- the entry */

async function recordPaidOrder(order) {
  const o = normalize(order);
  const results = await db.transaction((tx) => [
    tx.query(INSERT_ORDER, [o.reference, o.paymentReference, o.email, o.name, o.phone, o.amountTotal,
      o.amountSubtotal, o.amountShipping, o.amountDiscount, o.currency,
      o.shippingAddress === null ? null : JSON.stringify(o.shippingAddress), o.researchUseConfirmed]),
    // As JSON text: the driver would otherwise send an array as a Postgres array literal.
    tx.query(INSERT_LINES, [o.reference, JSON.stringify(o.items)]),
    tx.query(RECORD_ADDON_SALES, [o.reference]),
    tx.query(READ_BACK, [o.reference])
  ]);
  const stored = results[3][0];
  if (!stored) throw new db.DbError('database', { reason: 'order_not_found_after_write' });
  return {
    orderId: stored.id,
    created: results[0].length === 1,
    status: stored.status,
    consistent: stored.amount_total === o.amountTotal && stored.currency === o.currency
  };
}

module.exports = { recordPaidOrder, OrderInputError, _internals: { normalize } };
