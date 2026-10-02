#!/usr/bin/env node
/*
 * DEVELOPMENT AND TESTING ONLY. Not a payment. Never deployed.
 *
 * Plays the part of a payment provider reporting a payment, so the order flow
 * can be exercised before a real provider is chosen:
 *
 *   cart -> priceCart() -> [simulated payment] -> paidOrderFromCart()
 *        -> recordPaymentEvent() -> recordPaidOrder() -> Neon order + owner notifications
 *
 * It writes to whatever DATABASE_URL points at, which must be a development or
 * staging Neon branch, as the runtime role (netlify/lib/db.js). Every order it
 * makes is a test order: its reference starts test_sim_, its customer is
 * "TEST ORDER (simulated)" at an .invalid address, and the owner's email and
 * text say [TEST] (netlify/lib/notify.js treats no simulated reference as live).
 *
 * It refuses to run unless TR_SIMULATE_PAYMENTS=1 is set, and refuses inside
 * anything that looks like production: a Netlify build or function (NETLIFY,
 * CONTEXT=production) or NODE_ENV=production. It lives in tools/, which is not
 * deployed (tools/dist.py), and nothing under netlify/ imports it
 * (tests/payment.test.js checks both).
 *
 *   python3 tools/build.py      # writes netlify/functions/catalog.json
 *   TR_SIMULATE_PAYMENTS=1 DATABASE_URL=postgresql://peptide_app:...@<staging>/... \
 *     node tools/simulate_paid_order.mjs --cart '{"items":[{"id":"bpc-157","size":"10 mg","qty":2}]}'
 *
 * Options:
 *   --cart <json>         the cart, as the browser sends it ({"items":[{"id","size","qty"}]});
 *                         research use is confirmed for you
 *   --event <status>      paid (default), failed or cancelled
 *   --shipping <method>   standard (default) or express
 *   --reference <ref>     replay an earlier simulated payment (must start test_sim_)
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const payment = require(path.join(ROOT, 'netlify/lib/payment.js'));

export const PREFIX = 'test_sim_';

export const TEST_CUSTOMER = Object.freeze({
  name: 'TEST ORDER (simulated)',
  email: 'simulated@example.invalid',
  phone: null
});

export const TEST_ADDRESS = Object.freeze({
  line1: 'TEST ORDER - not a real address', line2: null, city: 'Testville', state: 'TX', postal_code: '00000', country: 'US'
});

/* Why this environment may not run the simulator, or null when it may. */
export function refusal(env) {
  if (env.TR_SIMULATE_PAYMENTS !== '1') return 'Set TR_SIMULATE_PAYMENTS=1 to run the payment simulator (development and testing only).';
  if (env.NETLIFY || env.CONTEXT === 'production') return 'Refusing to simulate payments inside a Netlify build or function.';
  if (env.NODE_ENV === 'production') return 'Refusing to simulate payments with NODE_ENV=production.';
  if (!env.DATABASE_URL) return 'Set DATABASE_URL to a development or staging Neon branch.';
  return null;
}

export function newReference() {
  return PREFIX + randomBytes(12).toString('hex');
}

/*
 * One simulated payment outcome for a cart, through the real boundary.
 * Returns what recordPaymentEvent() returned, plus the reference and the
 * priced cart.
 */
export async function simulate({ catalog, cart, event = 'paid', shipping = 'standard', reference, env = process.env }) {
  const why = refusal(env);
  if (why) throw new Error(why);
  if (reference !== undefined && !(typeof reference === 'string' && reference.startsWith(PREFIX))) {
    throw new Error(`A simulated payment's reference must start ${PREFIX}.`);
  }
  const priced = payment.priceCart(catalog, Object.assign({}, cart, { researchUseConfirmed: true }),
    { shipping, rates: payment.shippingRates(env) });
  const ref = reference || newReference();
  const order = payment.paidOrderFromCart(priced, {
    reference: ref,
    amountPaid: priced.totalCents,
    customer: TEST_CUSTOMER,
    shippingAddress: TEST_ADDRESS
  });
  const result = await payment.recordPaymentEvent({ status: event, order });
  return Object.assign({ reference: ref, priced }, result);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!/^--(cart|event|shipping|reference)$/.test(k) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

async function main() {
  const why = refusal(process.env);
  if (why) {
    console.error(why);
    process.exit(2);
  }
  const opts = args(process.argv.slice(2));
  if (!opts.cart) throw new Error('Give a cart: --cart \'{"items":[{"id":"...","size":"...","qty":1}]}\'');
  const catalogFile = path.join(ROOT, 'netlify/functions/catalog.json');
  if (!fs.existsSync(catalogFile)) throw new Error('netlify/functions/catalog.json is missing: run python3 tools/build.py first.');
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const res = await simulate({ catalog, cart: JSON.parse(opts.cart), event: opts.event, shipping: opts.shipping, reference: opts.reference });

  const summary = { test_order: true, event: res.status, reference: res.reference, recorded: res.recorded,
                    total_cents: res.priced.totalCents, currency: res.priced.currency };
  if (res.recorded) {
    const db = require(path.join(ROOT, 'netlify/lib/db.js'));
    summary.order_id = res.orderId;
    summary.created = res.created;
    summary.notifications = await db.query(
      'select channel, status from public.order_notifications where order_id = $1 order by channel', [res.orderId]);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : String(e));
    process.exit(1);
  });
}
