-- Owner notifications for new paid orders: a transactional outbox.
--
-- Apply after 0001-0004. Safe to run twice. Nothing earlier is changed, and
-- orders that exist before this migration are never notified (no backfill).
--
-- How a notification comes to exist, exactly once per order and channel:
--
--   The payment webhook records an order with a PostgREST upsert on
--   stripe_session_id. A first delivery inserts the row; every retry of the
--   same payment becomes an UPDATE of that row. An AFTER INSERT trigger
--   therefore fires once per genuinely new order and never for a retry
--   (0003's orders_log_status relies on the same behaviour, and its tests
--   replay the webhook's upsert to prove it). The trigger writes one 'email'
--   and one 'sms' row, unique per (order_id, channel), in the same
--   transaction as the order.
--
--   If that insert fails, the order insert fails with it, so the webhook
--   answers 500 and Stripe retries. An order is never recorded while its
--   notification is silently lost.
--
-- What it holds: ids, channel, delivery state and error codes. No message
-- text and no customer details: the message is built from the order when it
-- is sent, by netlify/functions/notify-dispatch.js.
--
-- How it is sent: notify-dispatch runs every minute and claims due rows with
-- claim_order_notifications(), which leases them (FOR UPDATE SKIP LOCKED, so
-- two overlapping runs never claim the same row), then reports each outcome
-- with complete_order_notification(). Nothing else can change the table.

-- ======================================================================
-- 1. The outbox
-- ======================================================================

create table if not exists public.order_notifications (
  id                  bigint      generated always as identity primary key,
  order_id            uuid        not null references public.orders(id) on delete restrict,
  channel             text        not null check (channel in ('email', 'sms')),
  status              text        not null default 'pending'
                                  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts            integer     not null default 0 check (attempts >= 0),
  next_attempt_at     timestamptz not null default now(),
  locked_until        timestamptz,
  -- A short code ('postmark_422_406', 'twilio_429', 'timeout'), never a
  -- provider's message: those echo addresses and phone numbers.
  last_error_code     text        check (last_error_code ~ '^[a-z0-9_]{1,60}$'),
  provider_message_id text        check (provider_message_id ~ '^[A-Za-z0-9_.-]{1,100}$'),
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  unique (order_id, channel)
);
create index if not exists order_notifications_due_idx
  on public.order_notifications (next_attempt_at, id) where status in ('pending', 'sending');

-- ======================================================================
-- 2. One row per channel for every new paid order
-- ======================================================================

-- SECURITY DEFINER: the webhook writes orders as the service role, which has
-- no write access to this table; the trigger inserts with the table owner's
-- rights. It is not callable directly.
create or replace function public.orders_enqueue_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.order_notifications (order_id, channel)
  values (new.id, 'email'), (new.id, 'sms')
  on conflict (order_id, channel) do nothing;
  return null;
end $$;

drop trigger if exists orders_enqueue_notifications on public.orders;
create trigger orders_enqueue_notifications
  after insert on public.orders
  for each row
  when (new.status = 'paid')
  execute function public.orders_enqueue_notifications();

-- ======================================================================
-- 3. Claiming due notifications
-- ======================================================================
--
-- A row is due when it is pending (or was being sent by a run whose lease has
-- expired), its next attempt time has come, and its order either has line
-- items or is more than five minutes old (the webhook writes the lines just
-- after the order; past five minutes the message says they are unavailable).
-- Rows more than a day old are marked skipped instead of sent: a notification
-- is about a new order, and switching notifications on, or recovering from
-- an outage, must not send a flood of old ones.
--
-- Returns what a message needs and nothing more: no customer email or phone.

create or replace function public.claim_order_notifications(p_limit integer default 5, p_lease_seconds integer default 120)
returns table (
  notification_id       bigint,
  channel               text,
  attempt               integer,
  order_id              uuid,
  order_created_at      timestamptz,
  stripe_session_id     text,
  customer_name         text,
  amount_total          integer,
  currency              text,
  shipping_address      jsonb,
  research_use_confirmed boolean,
  items                 jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'limit must be 1 to 20' using errcode = 'check_violation';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'lease must be 30 to 900 seconds' using errcode = 'check_violation';
  end if;

  update public.order_notifications
     set status = 'skipped', last_error_code = 'stale', locked_until = null
   where status in ('pending', 'sending')
     and created_at < now() - interval '24 hours'
     and (locked_until is null or locked_until < now());

  return query
  with due as (
    select n.id
      from public.order_notifications n
      join public.orders o on o.id = n.order_id
     where n.status in ('pending', 'sending')
       and n.next_attempt_at <= now()
       and (n.locked_until is null or n.locked_until < now())
       and (exists (select 1 from public.order_items i where i.order_id = n.order_id)
            or o.created_at < now() - interval '5 minutes')
     order by n.next_attempt_at, n.id
     limit p_limit
     for update of n skip locked
  ),
  claimed as (
    update public.order_notifications n
       set status = 'sending',
           attempts = n.attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds)
      from due
     where n.id = due.id
    returning n.id, n.channel, n.attempts, n.order_id
  )
  select c.id, c.channel, c.attempts, o.id, o.created_at, o.stripe_session_id, o.name,
         o.amount_total, o.currency, o.shipping_address, o.research_use_confirmed,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'kind', i.kind, 'description', i.description, 'quantity', i.quantity,
                     'amount_total', i.amount_total) order by i.id)
                     from public.order_items i where i.order_id = o.id), '[]'::jsonb)
    from claimed c
    join public.orders o on o.id = c.order_id
   order by c.id;
end $$;

-- ======================================================================
-- 4. Reporting the outcome
-- ======================================================================
--
--   sent    delivered to the provider; the provider's message id is kept
--   retry   try again after 1, 5, 15, 60, then 360 minutes; the sixth
--           failed attempt marks it failed
--   failed  will not succeed by retrying (the provider refused the request)
--
-- Only a row currently being sent can be completed.

create or replace function public.complete_order_notification(
  p_id bigint, p_outcome text, p_provider_message_id text default null, p_error_code text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.order_notifications;
  v_status text;
begin
  if p_outcome not in ('sent', 'retry', 'failed') then
    raise exception 'outcome must be sent, retry or failed' using errcode = 'check_violation';
  end if;
  if p_outcome <> 'sent' and p_error_code is null then
    raise exception 'a failed attempt needs an error code' using errcode = 'check_violation';
  end if;
  select * into v from public.order_notifications where id = p_id for update;
  if not found then
    raise exception 'notification % not found', p_id using errcode = 'no_data_found';
  end if;
  if v.status <> 'sending' then
    raise exception 'notification % is %, not being sent', p_id, v.status using errcode = 'check_violation';
  end if;

  if p_outcome = 'sent' then
    update public.order_notifications
       set status = 'sent', sent_at = now(), locked_until = null, last_error_code = null,
           provider_message_id = p_provider_message_id
     where id = p_id;
    return 'sent';
  end if;

  v_status := case when p_outcome = 'failed' or v.attempts >= 6 then 'failed' else 'pending' end;
  update public.order_notifications
     set status = v_status,
         locked_until = null,
         last_error_code = p_error_code,
         next_attempt_at = case v.attempts
                             when 1 then now() + interval '1 minute'
                             when 2 then now() + interval '5 minutes'
                             when 3 then now() + interval '15 minutes'
                             when 4 then now() + interval '60 minutes'
                             else now() + interval '360 minutes' end
   where id = p_id;
  return v_status;
end $$;

-- ======================================================================
-- 5. Access
-- ======================================================================
--
-- Browser roles: nothing. Service role: may read the outbox (for the console
-- later) and call the two functions above; it cannot write the table
-- directly. The trigger function is not callable by anyone.

alter table public.order_notifications enable row level security;

revoke all on public.order_notifications from public, anon, authenticated;
revoke insert, update, delete, truncate on public.order_notifications from service_role;

revoke execute on function public.orders_enqueue_notifications() from public, anon, authenticated, service_role;
revoke execute on function public.claim_order_notifications(integer, integer) from public, anon, authenticated;
revoke execute on function public.complete_order_notification(bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_order_notifications(integer, integer) to service_role;
grant execute on function public.complete_order_notification(bigint, text, text, text) to service_role;
