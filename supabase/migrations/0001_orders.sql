-- Orders recorded by netlify/functions/stripe-webhook.js.
--
-- Apply with the Supabase MCP tools, the CLI (`supabase db push`), or by
-- pasting into the SQL editor. It is written to be safe to run twice.
--
-- Money is stored in the smallest currency unit (cents), as integers, because
-- that is what Stripe sends and because a float has no business holding a
-- price. Divide by 100 for display, never for arithmetic.

create table if not exists public.orders (
  id                      uuid primary key default gen_random_uuid(),

  -- Stripe's session id is the natural key: the webhook upserts on it so a
  -- retried delivery updates this row rather than creating a second order for
  -- one payment.
  stripe_session_id       text not null unique,
  stripe_payment_intent   text,

  email                   text,
  name                    text,
  phone                   text,

  amount_total            integer not null,
  amount_subtotal         integer,
  amount_shipping         integer not null default 0,
  amount_discount         integer not null default 0,
  currency                text    not null,

  shipping_address        jsonb,

  -- The research-use condition the customer confirmed before checkout opened.
  -- Recorded per order because it is a term of the sale, and the one thing the
  -- operator would need to produce if an order were ever questioned.
  research_use_confirmed  boolean not null default false,

  status                  text not null default 'paid'
                            check (status in ('paid','shipped','cancelled','refunded')),
  tracking_number         text,
  carrier                 text,
  notes                   text,

  created_at              timestamptz not null default now(),
  shipped_at              timestamptz
);

create table if not exists public.order_items (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references public.orders(id) on delete cascade,
  description   text,
  quantity      integer not null,
  unit_amount   integer,
  amount_total  integer
);

create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists orders_created_at_idx     on public.orders (created_at desc);
create index if not exists orders_email_idx          on public.orders (lower(email));
create index if not exists orders_status_idx         on public.orders (status);

-- Row level security on, and deliberately NO policies.
--
-- With RLS enabled and no policy granting access, the anon and authenticated
-- roles can read nothing. Only the service role key can touch these tables,
-- and that key exists in exactly one place: the server-side environment of the
-- Netlify functions. A browser never sees it.
--
-- This is the default that matters. These rows are names, email addresses,
-- phone numbers and home addresses of people buying research chemicals; a
-- readable orders table is the worst possible leak this site could have.
-- Anything that needs to read an order — an order status page, an admin view —
-- goes through a function that checks who is asking first.
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
