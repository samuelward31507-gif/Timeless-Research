/*
 * Sends the owner an email and a text for every new paid order.
 *
 * Runs on a schedule (every minute; netlify.toml) and takes no input, so
 * calling it any other way can only do what the schedule does: send what is
 * already due. Each run:
 *
 *   1. Does nothing at all unless NOTIFY_ENABLED is exactly "1". Until then
 *      new orders still queue (migration 0005), and anything over a day old
 *      is skipped rather than sent when notifications are switched on.
 *   2. Claims up to five due notifications from the outbox with
 *      claim_order_notifications(), which leases them so an overlapping run
 *      cannot claim the same row. The claim returns the order's reference,
 *      name, total, address, lines and research-use confirmation; never the
 *      customer's email or phone.
 *   3. Sends each through Postmark (email) or Twilio (SMS), built from that
 *      order data now (netlify/lib/notify.js), and reports the outcome with
 *      complete_order_notification(): sent, retry later (1, 5, 15, 60, 360
 *      minutes, then failed), or failed. A channel that is not fully
 *      configured is retried, not dropped, so fixing the setting sends it.
 *   4. Stops sending after about 20 seconds; anything claimed but not sent
 *      waits for its lease to expire and is claimed again.
 *
 * Delivery is at least once: if a run dies after a provider accepted a
 * message but before the outcome was recorded, that message is sent again.
 * Nothing is lost in the other direction.
 *
 * It logs the notification id, channel, outcome and an error code. Never a
 * message, a provider's answer, a name, address, email, phone or key.
 */
'use strict';

const notify = require('../lib/notify.js');

let CATALOG = null;
try {
  CATALOG = require('./catalog.json');
} catch (e) {
  CATALOG = null;
}

const CLAIM_LIMIT = 5;
const LEASE_SECONDS = 120;
const BUDGET_MS = 20000;
const FETCH_TIMEOUT_MS = 8000;

const clock = { now: () => Date.now() };

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function log(fields) {
  console.log(JSON.stringify(Object.assign({ notify: 'dispatch' }, fields)));
}

/* A database function, with the service role key, on the server. */
async function rpc(name, args) {
  const url = new URL(process.env.SUPABASE_URL);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`db_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function supabaseConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

exports.handler = async function () {
  const config = notify.configState(process.env);
  if (!config.enabled) return json(200, { enabled: false });
  if (!supabaseConfigured()) {
    log({ outcome: 'not_configured', reason: 'supabase' });
    return json(500, { error: 'not configured' });
  }

  const started = clock.now();
  const demo = !!(CATALOG && CATALOG.demo);
  let rows;
  try {
    rows = await rpc('claim_order_notifications', { p_limit: CLAIM_LIMIT, p_lease_seconds: LEASE_SECONDS });
  } catch (e) {
    log({ outcome: 'claim_failed', reason: /^db_\d{3}$/.test(e.message) ? e.message : 'unreachable' });
    return json(500, { error: 'claim failed' });
  }
  if (!Array.isArray(rows)) {
    log({ outcome: 'claim_failed', reason: 'malformed' });
    return json(500, { error: 'claim failed' });
  }

  const counts = { claimed: rows.length, sent: 0, retry: 0, failed: 0, deferred: 0 };
  for (const row of rows) {
    if (clock.now() - started >= BUDGET_MS) {
      counts.deferred += 1;
      continue;
    }
    const channel = row && row.channel;
    let result;
    if (channel === 'email') {
      result = config.email.ready ? await notify.sendEmail(row, process.env, demo) : { outcome: 'retry', errorCode: 'email_not_configured' };
    } else if (channel === 'sms') {
      result = config.sms.ready ? await notify.sendSms(row, process.env, demo) : { outcome: 'retry', errorCode: 'sms_not_configured' };
    } else {
      result = { outcome: 'failed', errorCode: 'unknown_channel' };
    }

    let status = null;
    try {
      status = await rpc('complete_order_notification', {
        p_id: row.notification_id,
        p_outcome: result.outcome,
        p_provider_message_id: result.outcome === 'sent' ? result.providerMessageId || null : null,
        p_error_code: result.outcome === 'sent' ? null : result.errorCode
      });
    } catch (e) {
      // The lease expires and the row is claimed again: for a message that
      // was sent, that is the one duplicate this design allows.
      status = 'complete_failed';
    }
    counts[result.outcome] += 1;
    log({ id: row.notification_id, channel, outcome: result.outcome, code: result.errorCode || null,
          status: typeof status === 'string' ? status : null });
  }
  return json(200, Object.assign({ enabled: true }, counts));
};

// For the test suite; not part of the handler contract.
exports._internals = {
  clock,
  setCatalog(c) {
    CATALOG = c;
  },
  CLAIM_LIMIT,
  LEASE_SECONDS,
  BUDGET_MS
};
