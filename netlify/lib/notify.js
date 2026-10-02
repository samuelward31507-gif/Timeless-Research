/*
 * Owner notifications for new paid orders: configuration, the two messages,
 * and the two providers (Postmark for email, Twilio for SMS), over fetch with
 * no SDK.
 *
 * netlify/functions/notify-dispatch.js claims due rows from the outbox
 * (migration 0005) and uses this to build and send each one. Nothing here
 * reads the database or logs anything: it turns a claimed row into a message,
 * sends it, and classifies the answer.
 *
 * Privacy rules, enforced here and tested:
 *   - the SMS says only that an order arrived, its reference, total and item
 *     count; no name, address, email or phone;
 *   - the email adds the customer's name, the shipping address, the lines and
 *     the research-use confirmation; never the customer's email or phone
 *     (the outbox claim does not even return them);
 *   - a test order is always marked [TEST]. An order counts as live only when
 *     its Stripe session id starts cs_live_ and this deploy is not a demo;
 *     anything else, including anything unrecognised, is a test;
 *   - provider answers are reduced to a status and a numeric error code: their
 *     messages can quote addresses and phone numbers, so they are never kept.
 */
'use strict';

const FETCH_TIMEOUT_MS = 5000;

const POSTMARK_URL = 'https://api.postmarkapp.com/email';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

/* ---------------------------------------------------------- configuration */

const FORMATS = {
  NOTIFY_ENABLED: /^1$/,
  POSTMARK_SERVER_TOKEN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  NOTIFY_EMAIL_FROM: /^[^\s@<>"',;]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
  NOTIFY_EMAIL_TO: /^[^\s@<>"',;]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
  POSTMARK_MESSAGE_STREAM: /^[a-z0-9-]{1,30}$/,
  TWILIO_ACCOUNT_SID: /^AC[0-9a-f]{32}$/,
  TWILIO_AUTH_TOKEN: /^[0-9a-f]{32}$/,
  TWILIO_FROM: /^\+[1-9]\d{6,14}$/,
  TWILIO_MESSAGING_SERVICE_SID: /^MG[0-9a-f]{32}$/,
  NOTIFY_SMS_TO: /^\+[1-9]\d{6,14}$/
};

/* The state of one setting: 'ok', 'missing' or 'invalid'. Never its value. */
function state(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return 'missing';
  return FORMATS[name].test(raw) ? 'ok' : 'invalid';
}

/* What health.js reports and what the dispatcher acts on: states only. */
function configState(env) {
  env = env || process.env;
  const s = (name) => state(env, name);
  const email = {
    POSTMARK_SERVER_TOKEN: s('POSTMARK_SERVER_TOKEN'),
    NOTIFY_EMAIL_FROM: s('NOTIFY_EMAIL_FROM'),
    NOTIFY_EMAIL_TO: s('NOTIFY_EMAIL_TO'),
    // Optional: Postmark's default transactional stream is used when unset.
    POSTMARK_MESSAGE_STREAM: env.POSTMARK_MESSAGE_STREAM === undefined || env.POSTMARK_MESSAGE_STREAM === ''
      ? 'default' : s('POSTMARK_MESSAGE_STREAM')
  };
  const from = s('TWILIO_FROM');
  const service = s('TWILIO_MESSAGING_SERVICE_SID');
  const sms = {
    TWILIO_ACCOUNT_SID: s('TWILIO_ACCOUNT_SID'),
    TWILIO_AUTH_TOKEN: s('TWILIO_AUTH_TOKEN'),
    // One sender: a number or a messaging service, not neither, not both.
    sender: from === 'ok' && service === 'missing' ? 'ok'
      : service === 'ok' && from === 'missing' ? 'ok'
      : from === 'missing' && service === 'missing' ? 'missing' : 'invalid',
    NOTIFY_SMS_TO: s('NOTIFY_SMS_TO')
  };
  const ready = (group) => Object.values(group).every((x) => x === 'ok' || x === 'default');
  return {
    enabled: s('NOTIFY_ENABLED') === 'ok',
    NOTIFY_ENABLED: s('NOTIFY_ENABLED'),
    email: Object.assign({ ready: ready(email) }, email),
    sms: Object.assign({ ready: ready(sms) }, sms)
  };
}

/* ----------------------------------------------------------- the message */

// Printable text only, bounded. Anything from an order is treated as untrusted.
function clean(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function reference(orderId) {
  return `TR-${String(orderId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function isLive(row, demo) {
  return !demo && typeof row.stripe_session_id === 'string' && row.stripe_session_id.startsWith('cs_live_');
}

/* Minor units to "$123.45 USD". The currency's own decimal places come from
   Intl; a code Intl does not know is shown in minor units rather than guessed. */
function money(minor, currency) {
  const code = /^[A-Z]{3}$/.test(String(currency)) ? currency : 'XXX';
  if (!Number.isSafeInteger(minor)) return `? ${code}`;
  try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    const digits = f.resolvedOptions().maximumFractionDigits;
    return `${f.format(minor / 10 ** digits)} ${code}`;
  } catch (e) {
    return `${minor} ${code} (minor units)`;
  }
}

function units(items) {
  return items.reduce((n, i) => n + (Number.isSafeInteger(i.quantity) && i.quantity > 0 ? i.quantity : 0), 0);
}

function itemsOf(row) {
  return Array.isArray(row.items) ? row.items.filter((i) => i && typeof i === 'object') : [];
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* "[TEST] New order TR-1A2B3C4D: $123.45 USD, 3 items." and nothing else. */
function smsText(row, demo) {
  const items = itemsOf(row);
  const count = items.length ? plural(units(items), 'item') : 'line items not yet recorded';
  return `${isLive(row, demo) ? '' : '[TEST] '}New order ${reference(row.order_id)}: ${money(row.amount_total, row.currency)}, ${count}.`;
}

function utc(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function emailMessage(row, demo) {
  const live = isLive(row, demo);
  const ref = reference(row.order_id);
  const total = money(row.amount_total, row.currency);
  const items = itemsOf(row);
  const a = row.shipping_address && typeof row.shipping_address === 'object' ? row.shipping_address : {};
  const name = clean(row.customer_name, 120);

  const lines = [];
  if (!live) {
    lines.push('*** TEST ORDER - NOT A REAL SALE. No money was taken; do not ship. ***', '');
  }
  lines.push(`New paid order ${ref}`, '');
  lines.push(`Placed:   ${utc(row.order_created_at)}`);
  lines.push(`Customer: ${name || '(no name given)'}`);
  lines.push(`Total:    ${total}`);
  lines.push(`Order ID: ${clean(row.order_id, 36)}`, '');

  if (items.length) {
    lines.push(`Items (${units(items)}):`);
    for (const i of items.slice(0, 100)) {
      const qty = Number.isSafeInteger(i.quantity) ? i.quantity : '?';
      const kind = i.kind === 'addon' ? ' (add-on)' : '';
      const amount = Number.isSafeInteger(i.amount_total) ? ` - ${money(i.amount_total, row.currency)}` : '';
      lines.push(`  ${qty} x ${clean(i.description, 200) || '(no description)'}${kind}${amount}`);
    }
    if (items.length > 100) lines.push(`  ...and ${items.length - 100} more lines`);
  } else {
    lines.push('Items: line details were not yet available when this was sent.',
               'Check the order before packing.');
  }
  lines.push('');

  const address = [clean(name, 120), clean(a.line1, 200), clean(a.line2, 200),
    [clean(a.city, 100), clean(a.state, 100), clean(a.postal_code, 30)].filter(Boolean).join(', '),
    clean(a.country, 2)].filter(Boolean);
  lines.push('Ship to:');
  if (address.length > (name ? 1 : 0)) {
    for (const l of address) lines.push(`  ${l}`);
  } else {
    lines.push('  (no shipping address recorded)');
  }
  lines.push(`Shipping country/state: ${clean(a.country, 2) || '-'} / ${clean(a.state, 100) || '-'}`, '');
  lines.push(`Research-use confirmation: ${row.research_use_confirmed === true ? 'confirmed' : 'NOT CONFIRMED - check before shipping'}`);

  return {
    subject: `${live ? '' : '[TEST] '}New order ${ref} - ${total}`,
    text: lines.join('\n')
  };
}

/* ------------------------------------------------------------ providers */

async function post(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

const CODE = /^[0-9]{1,6}$/;
const MESSAGE_ID = /^[A-Za-z0-9_.-]{1,100}$/;

/* A provider's answer, reduced to what the outbox may store. */
function outcome(res, body, provider, idField, codeField) {
  const status = res.status;
  const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  const raw = body && typeof body === 'object' ? body : {};
  const code = CODE.test(text(raw[codeField]) || '') ? text(raw[codeField]) : null;
  if (status >= 200 && status < 300) {
    const id = MESSAGE_ID.test(text(raw[idField]) || '') ? text(raw[idField]) : null;
    // Accepted. Without a usable id it is still sent: retrying would send twice.
    return { outcome: 'sent', providerMessageId: id, errorCode: null };
  }
  const errorCode = `${provider}_${status}${code && code !== '0' ? `_${code}` : ''}`;
  // Throttled, a server fault, or credentials that may be corrected: retry.
  if (status === 429 || status >= 500 || status === 401 || status === 403) return { outcome: 'retry', errorCode };
  // The request itself was refused (bad recipient, unverified sender, ...).
  if (status >= 400) return { outcome: 'failed', errorCode };
  return { outcome: 'retry', errorCode };
}

async function readJson(res) {
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function call(provider, url, init, idField, codeField) {
  let res;
  try {
    res = await post(url, init);
  } catch (e) {
    // Unknown whether it arrived; retrying risks a duplicate, not a loss.
    return { outcome: 'retry', errorCode: e && e.name === 'AbortError' ? `${provider}_timeout` : `${provider}_network` };
  }
  return outcome(res, await readJson(res), provider, idField, codeField);
}

async function sendEmail(row, env, demo) {
  const m = emailMessage(row, demo);
  const body = {
    From: env.NOTIFY_EMAIL_FROM,
    To: env.NOTIFY_EMAIL_TO,
    Subject: m.subject,
    TextBody: m.text,
    Tag: 'new-order',
    // The outbox row, for tracing a delivery back to its notification.
    Metadata: { notification_id: String(row.notification_id) },
    MessageStream: env.POSTMARK_MESSAGE_STREAM || 'outbound'
  };
  return call('postmark', POSTMARK_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json',
               'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN },
    body: JSON.stringify(body)
  }, 'MessageID', 'ErrorCode');
}

async function sendSms(row, env, demo) {
  const form = new URLSearchParams();
  form.append('To', env.NOTIFY_SMS_TO);
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.append('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
  else form.append('From', env.TWILIO_FROM);
  form.append('Body', smsText(row, demo));
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  return call('twilio', `${TWILIO_BASE}/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    body: form.toString()
  }, 'sid', 'code');
}

module.exports = {
  configState,
  smsText,
  emailMessage,
  sendEmail,
  sendSms,
  reference,
  money,
  isLive,
  _internals: { outcome, clean, FORMATS, POSTMARK_URL, TWILIO_BASE }
};
