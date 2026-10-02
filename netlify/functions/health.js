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
 * It never returns a key, or any part of one: only whether a value is present
 * and, where a value has a recognisable shape, whether it has that shape.
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

  // No payment provider is connected (netlify/lib/payment.js is the boundary
  // one will plug into), so the storefront's cart says payment is unavailable.
  const payments = {
    working: false,
    note: 'No payment provider is connected. The cart tells customers that online payment is not available yet.'
  };

  // The Neon database (netlify/lib/db.js): where paid orders are recorded
  // (netlify/lib/orders.js) and read by the notification dispatcher and the
  // add-on stock check. Reports only whether the value is
  // a postgres URL for the runtime role, never the value or any part of it.
  const database = check('DATABASE_URL', (v) => {
    let u;
    try {
      u = new URL(v);
    } catch (e) {
      return { set: true, status: 'invalid', note: 'DATABASE_URL is not a URL.' };
    }
    if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname || !u.password) {
      return { set: true, status: 'invalid', note: 'DATABASE_URL must be a postgresql:// connection string with a password.' };
    }
    if (decodeURIComponent(u.username) !== 'peptide_app') {
      return { set: true, status: 'wrong-role',
               note: 'DATABASE_URL must log in as peptide_app, the runtime role. Any other role is refused.' };
    }
    return { set: true, status: 'ok', note: 'DATABASE_URL is set for peptide_app.' };
  });

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
      summary: database.status === 'ok'
        ? 'No payment provider is connected, so no orders can be taken yet. The order database is configured.'
        : 'No payment provider is connected, so no orders can be taken yet. DATABASE_URL is not configured: see database.url.note.',
      mode: demo ? 'demonstration' : 'trading',
      payments,
      database: { working: database.status === 'ok', url: database },
      support_assistant: { working: anthropic.status === 'ok', key: anthropic },
      notifications,
      next_step: 'Choose a payment provider; its adapter reports payments through netlify/lib/payment.js.'
    }, null, 2)
  };
};
