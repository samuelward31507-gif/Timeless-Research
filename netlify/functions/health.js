/*
 * Says whether this deploy is configured, in plain words.
 *
 * Setting an environment variable is the one step in the deploy that gives no
 * feedback: you type a name and a value into a panel, and the only way to find
 * out whether you got it right is to try to buy something and watch it fail.
 * A typo in the name, a stray space in the value, the publishable key instead
 * of the secret one, or forgetting that a variable added after the last build
 * does nothing until the next one — all four look identical from the outside.
 *
 * Visit /.netlify/functions/health and this answers it.
 *
 * It never returns a key, or any part of one. Only whether a value is present,
 * and — for the Stripe key — which of the two obvious mistakes was made, since
 * "starts with pk_" and "starts with sk_live_ on a demo" are the two that
 * actually happen. None of that is secret: the demo bar on every page already
 * says louder what mode the site is in.
 */
'use strict';

const notify = require('../lib/notify.js');

let CATALOG = null;
try {
  CATALOG = require('./catalog.json');
} catch (e) {
  CATALOG = null;
}

function check(name, validate) {
  const raw = process.env[name];
  if (raw === undefined) return { set: false, status: 'missing', note: `${name} is not set.` };
  if (raw.trim() === '') return { set: false, status: 'empty', note: `${name} is set but has no value.` };
  if (raw !== raw.trim()) {
    return { set: true, status: 'whitespace',
             note: `${name} has a space or newline around it — usually a copy-paste slip. Re-paste it.` };
  }
  return validate ? validate(raw) : { set: true, status: 'ok', note: `${name} is set.` };
}

exports.handler = async function () {
  const demo = !!(CATALOG && CATALOG.demo);

  const stripe = check('STRIPE_SECRET_KEY', (v) => {
    if (v.startsWith('pk_')) {
      return { set: true, status: 'wrong-key',
               note: 'That is the publishable key. You need the secret one — same page, ' +
                     'it starts with sk_ and has to be revealed first.' };
    }
    if (!v.startsWith('sk_')) {
      return { set: true, status: 'wrong-key',
               note: 'That does not look like a Stripe secret key. It should start with sk_test_ or sk_live_.' };
    }
    const live = v.startsWith('sk_live_');
    if (demo && live) {
      return { set: true, status: 'live-key-on-demo', mode: 'live',
               note: 'This is a demonstration deploy and that is a LIVE key. Checkout is ' +
                     'refused on purpose — a site telling everyone it is not trading must ' +
                     'not be able to take real money. Use an sk_test_ key here.' };
    }
    return { set: true, status: 'ok', mode: live ? 'live' : 'test',
             note: live ? 'Live key. Real cards, real money.'
                        : 'Test key. Pay with 4242 4242 4242 4242 — nothing is charged.' };
  });

  const orders = {
    url: check('SUPABASE_URL'),
    key: check('SUPABASE_SERVICE_ROLE_KEY'),
    webhook: check('STRIPE_WEBHOOK_SECRET', (v) => v.startsWith('whsec_')
      ? { set: true, status: 'ok', note: 'Webhook signing secret is set.' }
      : { set: true, status: 'wrong-key',
          note: 'A webhook signing secret starts with whsec_. This does not.' })
  };
  const ordersReady = orders.url.status === 'ok' && orders.key.status === 'ok'
                      && orders.webhook.status === 'ok';

  const canCheckOut = stripe.status === 'ok';

  // The support assistant. Optional: without a key it tells visitors it is
  // unavailable and points them to the contact page.
  const anthropic = check('ANTHROPIC_API_KEY', (v) => v.startsWith('sk-ant-')
    ? { set: true, status: 'ok', note: 'Anthropic API key is set. Make sure its Claude Console workspace has a monthly spend limit.' }
    : { set: true, status: 'wrong-key', note: 'An Anthropic API key starts with sk-ant-. This does not.' });

  // New-order notifications to the owner. Each setting is reported as ok,
  // missing or invalid (the wrong shape for its kind of value); never the
  // value. Nothing is sent unless NOTIFY_ENABLED is exactly "1".
  const n = notify.configState(process.env);
  const notifications = {
    working: n.enabled && n.email.ready && n.sms.ready,
    enabled: n.NOTIFY_ENABLED,
    email: n.email,
    sms: n.sms,
    note: !n.enabled
      ? (n.NOTIFY_ENABLED === 'missing'
          ? 'Off. Nothing is sent until NOTIFY_ENABLED is set to 1.'
          : 'Off. NOTIFY_ENABLED must be exactly 1.')
      : (n.email.ready && n.sms.ready
          ? 'On. New paid orders are emailed and texted to the owner.'
          : 'On, but a channel is not fully configured: its notifications wait until the settings marked missing or invalid are fixed.')
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      summary: canCheckOut
        ? (ordersReady
            ? 'Ready. Checkout works and orders are being recorded.'
            : 'Checkout works. Orders are NOT being recorded — that needs the three order settings below.')
        : 'Checkout will not work yet. See stripe.note.',
      mode: demo ? 'demonstration' : 'trading',
      checkout: { working: canCheckOut, stripe },
      order_records: { working: ordersReady, ...orders },
      support_assistant: { working: anthropic.status === 'ok', key: anthropic },
      notifications,
      next_step: canCheckOut
        ? (ordersReady ? 'Nothing. Place a test order to confirm.'
                       : 'Optional: set the three order settings to record orders in a database.')
        : 'Fix the stripe note above, then Deploys > Trigger deploy. A variable added ' +
          'after the last build does nothing until the next one.'
    }, null, 2)
  };
};
