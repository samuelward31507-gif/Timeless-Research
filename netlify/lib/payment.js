/*
 * The payment boundary: everything between a cart and a recorded order that
 * does not depend on who takes the money.
 *
 * No payment provider is connected. When one is chosen, its adapter (a
 * function that creates the payment, and one that verifies the provider's
 * "payment finished" event) uses this file and nothing below it:
 *
 *   cart  ->  priceCart(catalog, cart)              what to charge, from the catalogue
 *         ->  [provider takes the payment]
 *         ->  paidOrderFromCart(priced, payment)    the normalized paid order
 *         ->  recordPaymentEvent({ status, order }) the one way in for every provider
 *         ->  recordPaidOrder()  (orders.js)        order + lines + owner notifications,
 *                                                   one transaction on Neon
 *
 * priceCart is the only server-side pricing: the browser's cart shows totals
 * but sends only ids, pack sizes and quantities, because a price posted from a
 * browser is a number the customer chose.
 *
 * The normalized paid order is exactly what recordPaidOrder() takes (its
 * header documents every field). Nothing provider-specific belongs in it
 * beyond `reference`, the provider's unique id for the payment, which is what
 * makes a redelivered event a no-op.
 */
'use strict';

const { recordPaidOrder } = require('./orders.js');
const { orderItemRows } = require('./addons.js');

const MAX_LINES = 20;   // distinct cart lines
const MAX_QTY = 99;     // units of one pack size

const STATUSES = ['paid', 'failed', 'cancelled'];
const SHIPPING = ['standard', 'express'];

/* A cart the server will not price. `message` is a sentence the customer can
   act on; `field` names what was wrong, for logs and tests. */
class CartError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'CartError';
    this.field = field;
  }
}

/* A payment event that is not one of the three this boundary understands. */
class PaymentEventError extends Error {
  constructor(field) {
    super(`invalid payment event: ${field}`);
    this.name = 'PaymentEventError';
    this.field = field;
  }
}

const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);

/* The best quantity break a line qualifies for, from the table build.py wrote
   into catalog.json, or null. */
function tierFor(catalog, qty) {
  const tiers = (catalog.volumeTiers || []).slice().sort((a, b) => a.minQty - b.minQty);
  let best = null;
  for (const t of tiers) if (qty >= t.minQty) best = t;
  return best;
}

function intEnv(env, name, fallback) {
  const raw = parseInt(env[name], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/* The two shipping rates, in minor units, from the deploy's settings
   (TR_SHIP_STANDARD_CENTS, TR_SHIP_EXPRESS_CENTS; netlify.toml). */
function shippingRates(env) {
  env = env || process.env;
  return {
    standardCents: intEnv(env, 'TR_SHIP_STANDARD_CENTS', 1500),
    expressCents: intEnv(env, 'TR_SHIP_EXPRESS_CENTS', 3500)
  };
}

/*
 * priceCart(catalog, cart, { shipping, rates }) -> {
 *   currency, lines: [{ id, size, qty, name, unitCents, amountCents, tierPercent }],
 *   goodsCents, shipping: { method, cents }, totalCents
 * }
 *
 * `catalog` is netlify/functions/catalog.json. `cart` is what the browser
 * sends: { items: [{ id, size, qty }], researchUseConfirmed: true }. Standard
 * shipping is free once the goods clear the catalogue's threshold; express
 * never is. Throws CartError for anything it will not price.
 */
function priceCart(catalog, cart, opts) {
  opts = opts || {};
  if (!catalog || typeof catalog !== 'object' || !catalog.products) throw new Error('priceCart needs the catalogue');
  if (!cart || typeof cart !== 'object') throw new CartError('cart', 'That request could not be read.');
  if (cart.researchUseConfirmed !== true) {
    throw new CartError('researchUseConfirmed', 'The research use condition has to be confirmed before checkout.');
  }
  const items = Array.isArray(cart.items) ? cart.items : null;
  if (!items || !items.length) throw new CartError('items', 'Your cart is empty.');
  if (items.length > MAX_LINES) {
    throw new CartError('items', 'That is more separate items than checkout takes. Please contact us for a bulk order.');
  }
  const method = opts.shipping === undefined ? 'standard' : opts.shipping;
  if (!SHIPPING.includes(method)) throw new CartError('shipping', 'Please choose a shipping option.');
  const rates = opts.rates || shippingRates();

  const lines = [];
  const seen = new Set();
  let goodsCents = 0;
  items.forEach((item, i) => {
    const id = item && typeof item.id === 'string' ? item.id : '';
    const size = item && typeof item.size === 'string' ? item.size : '';
    // Strict: no coercion. The browser sends numbers; a payment path is the
    // wrong place to guess what a string meant.
    const qty = item && typeof item.qty === 'number' ? item.qty : NaN;

    const product = own(catalog.products, id) ? catalog.products[id] : null;
    if (!product) throw new CartError(`items[${i}].id`, 'Something in your cart is no longer in the catalogue.');
    if (!product.buyable) {
      throw new CartError(`items[${i}].id`, `${product.name} is not sold through checkout. Please use the Enquire button on its page.`);
    }
    const price = own(product.prices, size) ? product.prices[size] : null;
    if (typeof price !== 'number') throw new CartError(`items[${i}].size`, `That pack size of ${product.name} is no longer offered.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new CartError(`items[${i}].qty`, `Please choose a quantity between 1 and ${MAX_QTY}.`);
    }
    const key = `${id}|${size}`;
    if (seen.has(key)) throw new CartError(`items[${i}]`, 'That cart has the same item on it twice.');
    seen.add(key);

    const tier = tierFor(catalog, qty);
    const unitCents = Math.round(price * 100 * (tier ? 1 - tier.percent / 100 : 1));
    goodsCents += unitCents * qty;
    lines.push({ id, size, qty, name: product.name, unitCents, amountCents: unitCents * qty,
                 tierPercent: tier ? tier.percent : null });
  });

  const freeOver = Number(catalog.freeShippingOver || 0);
  const freeStandard = freeOver > 0 && goodsCents >= Math.round(freeOver * 100);
  const shippingCents = method === 'express' ? rates.expressCents : (freeStandard ? 0 : rates.standardCents);

  return {
    currency: String(catalog.currency || 'USD').toUpperCase(),
    lines,
    goodsCents,
    shipping: { method, cents: shippingCents },
    totalCents: goodsCents + shippingCents
  };
}

/*
 * paidOrderFromCart(priced, payment) -> the normalized paid order for
 * recordPaidOrder().
 *
 * `payment` is only what the provider confirms about the payment:
 *   { reference,            the provider's unique id for it (required)
 *     paymentReference,     optional second id
 *     amountPaid,           minor units actually paid (required)
 *     amountDiscount,       optional, minor units
 *     customer: { email, name, phone },
 *     shippingAddress }     { line1, line2, city, state, postal_code, country } or null
 *
 * The lines name their product and pack size, so the order record knows what
 * was sold. recordPaidOrder() validates the result in full.
 */
function paidOrderFromCart(priced, payment) {
  payment = payment || {};
  const customer = payment.customer || {};
  return {
    reference: payment.reference,
    paymentReference: payment.paymentReference === undefined ? null : payment.paymentReference,
    email: customer.email === undefined ? null : customer.email,
    name: customer.name === undefined ? null : customer.name,
    phone: customer.phone === undefined ? null : customer.phone,
    amountTotal: payment.amountPaid,
    amountSubtotal: priced.goodsCents,
    amountShipping: priced.shipping.cents,
    amountDiscount: payment.amountDiscount === undefined ? 0 : payment.amountDiscount,
    currency: priced.currency,
    shippingAddress: payment.shippingAddress === undefined ? null : payment.shippingAddress,
    // priceCart refuses a cart without it, so a priced cart always carries it.
    researchUseConfirmed: true,
    items: orderItemRows(null, null, priced.lines, [])
  };
}

/*
 * recordPaymentEvent({ status, order }) -> { recorded, status, ... }
 *
 * The one way a payment outcome reaches the order system, whichever provider
 * reported it. `status` is 'paid', 'failed' or 'cancelled':
 *   - paid: the order is recorded through recordPaidOrder() (once, however
 *     often the event is delivered) and its owner notifications are queued;
 *   - failed, cancelled: nothing is recorded and nothing is sent.
 * Anything else is refused before any database work.
 */
async function recordPaymentEvent(event) {
  if (!event || typeof event !== 'object') throw new PaymentEventError('event');
  if (!STATUSES.includes(event.status)) throw new PaymentEventError('status');
  if (event.status !== 'paid') return { recorded: false, status: event.status };
  const result = await recordPaidOrder(event.order);
  return Object.assign({ recorded: true, status: 'paid' }, result);
}

module.exports = {
  priceCart, paidOrderFromCart, recordPaymentEvent, shippingRates,
  CartError, PaymentEventError, STATUSES, MAX_LINES, MAX_QTY
};
