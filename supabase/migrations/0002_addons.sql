-- Optional add-ons: their order lines, their stock, and how well they sell.
--
-- Payment-provider agnostic. Nothing here knows how an order was paid for:
-- whichever integration records a confirmed payment writes the order and its
-- order_items rows (netlify/lib/addons.js, orderItemRows, builds them), then
-- calls record_addon_sales(order_id). Safe to run twice.
--
-- Money stays in cents, as integers, as in 0001_orders.sql.

-- ------------------------------------------------------------- order lines
-- An add-on is recorded as its own line, next to the product line it was
-- attached to. Existing rows are product lines; the new columns are nullable
-- so nothing already recorded changes meaning.
alter table public.order_items
  add column if not exists kind             text not null default 'product',
  add column if not exists sku              text,
  add column if not exists pack_size        text,
  add column if not exists addon_id         text,
  add column if not exists rule_id          text,
  add column if not exists parent_sku       text,
  add column if not exists parent_pack_size text,
  -- On a product line: the add-ons it was offered, [{"addon": id, "rule": id}],
  -- decided by the server at order time from the add-on table. The denominator
  -- of the attach rate. No browser event or cookie is involved.
  add column if not exists offered_addons   jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_kind_check') then
    alter table public.order_items
      add constraint order_items_kind_check check (kind in ('product', 'addon'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_addon_shape_check') then
    alter table public.order_items
      add constraint order_items_addon_shape_check check (
        kind <> 'addon' or (addon_id is not null and parent_sku is not null)
      );
  end if;
end $$;

create index if not exists order_items_addon_idx on public.order_items (addon_id) where kind = 'addon';

-- ------------------------------------------------------------------ stock
-- A ledger, not a counter. Stock on hand is the sum of movements, so a
-- delivery, a sale, a cancellation and a stock-take correction are each one
-- row that can be read back later, and nothing is ever overwritten.
--
-- Restock or correct by inserting a row:
--   insert into addon_stock_movements (addon_id, delta, reason, note)
--   values ('insulated-shipper', 200, 'restock', 'PO 1182');
create table if not exists public.addon_stock_movements (
  id          bigint generated always as identity primary key,
  addon_id    text        not null,
  delta       integer     not null check (delta <> 0),
  reason      text        not null check (reason in ('restock', 'adjustment', 'sale', 'release')),
  -- restrict: an order whose add-ons moved stock is cancelled or refunded,
  -- not deleted, so the stock history stays true.
  order_id    uuid        references public.orders(id) on delete restrict,
  -- For a sale or its release: which order line it belongs to, so a retried
  -- recording, or a webhook that rewrites the items, cannot count it twice.
  line_key    text,
  note        text,
  created_at  timestamptz not null default now(),
  check ((reason in ('sale', 'release')) = (order_id is not null and line_key is not null))
);

create unique index if not exists addon_stock_movements_once
  on public.addon_stock_movements (order_id, line_key, reason)
  where reason in ('sale', 'release');
create index if not exists addon_stock_movements_addon_idx
  on public.addon_stock_movements (addon_id);

create or replace view public.addon_stock_levels
  with (security_invoker = true) as
  select addon_id, sum(delta)::integer as available
  from public.addon_stock_movements
  group by addon_id;

-- Takes an order's add-ons out of stock. Call it after the order and its
-- order_items rows are written. Idempotent: calling it again for the same
-- order, or after its items were deleted and rewritten, records nothing new.
-- It records the sale even if that takes stock below zero: the payment has
-- already happened, and a negative level is how an oversell shows up.
create or replace function public.record_addon_sales(p_order_id uuid)
returns integer
language sql
set search_path = public
as $$
  with ins as (
    insert into public.addon_stock_movements (addon_id, delta, reason, order_id, line_key)
    select i.addon_id,
           -sum(i.quantity)::integer,
           'sale',
           p_order_id,
           i.addon_id || '|' || i.parent_sku || '|' || coalesce(i.parent_pack_size, '')
    from public.order_items i
    where i.order_id = p_order_id and i.kind = 'addon' and i.quantity > 0
    group by i.addon_id, i.parent_sku, i.parent_pack_size
    on conflict (order_id, line_key, reason) where reason in ('sale', 'release') do nothing
    returning 1
  )
  select count(*)::integer from ins;
$$;

-- Puts a cancelled or refunded order's add-ons back. Releases only what was
-- actually recorded as sold, once.
create or replace function public.release_addon_sales(p_order_id uuid)
returns integer
language sql
set search_path = public
as $$
  with ins as (
    insert into public.addon_stock_movements (addon_id, delta, reason, order_id, line_key)
    select m.addon_id, -m.delta, 'release', m.order_id, m.line_key
    from public.addon_stock_movements m
    where m.order_id = p_order_id and m.reason = 'sale'
    on conflict (order_id, line_key, reason) where reason in ('sale', 'release') do nothing
    returning 1
  )
  select count(*)::integer from ins;
$$;

-- Cancelling or refunding an order in the orders table returns its add-ons to
-- stock without anyone having to remember to.
create or replace function public.orders_release_addons()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('cancelled', 'refunded') and old.status is distinct from new.status then
    perform public.release_addon_sales(new.id);
  end if;
  return new;
end $$;

drop trigger if exists orders_release_addons on public.orders;
create trigger orders_release_addons
  after update of status on public.orders
  for each row execute function public.orders_release_addons();

-- --------------------------------------------------------------- reporting
-- Both views count paid and shipped orders only. Read them in the Supabase
-- SQL editor or table view; nothing on the website can.

-- Units and revenue per add-on per month.
create or replace view public.addon_revenue
  with (security_invoker = true) as
  select date_trunc('month', o.created_at)::date as month,
         i.addon_id,
         count(distinct o.id)                     as orders,
         sum(i.quantity)::integer                 as units,
         sum(i.amount_total)::bigint              as revenue_cents,
         max(o.currency)                          as currency
  from public.order_items i
  join public.orders o on o.id = i.order_id
  where i.kind = 'addon' and o.status in ('paid', 'shipped')
  group by 1, 2;

-- Of the product lines an add-on was offered on, how many took it. Offered
-- comes from offered_addons, recorded by the server at order time, so this
-- needs no tracking of what visitors looked at.
create or replace view public.addon_attach_rate
  with (security_invoker = true) as
  with offered as (
    select o.id as order_id, p.sku, p.pack_size,
           e->>'addon' as addon_id, e->>'rule' as rule_id
    from public.order_items p
    join public.orders o on o.id = p.order_id
    cross join lateral jsonb_array_elements(coalesce(p.offered_addons, '[]'::jsonb)) e
    where p.kind = 'product' and o.status in ('paid', 'shipped')
  ),
  taken as (
    select order_id, parent_sku, parent_pack_size, addon_id,
           sum(amount_total)::bigint as revenue_cents
    from public.order_items
    where kind = 'addon'
    group by 1, 2, 3, 4
  )
  select f.addon_id,
         f.rule_id,
         count(*)                                              as lines_offered,
         count(t.addon_id)                                     as lines_taken,
         round(100.0 * count(t.addon_id) / nullif(count(*), 0), 1) as attach_rate_percent,
         coalesce(sum(t.revenue_cents), 0)::bigint             as revenue_cents
  from offered f
  left join taken t
    on t.order_id = f.order_id and t.parent_sku = f.sku
   and coalesce(t.parent_pack_size, '') = coalesce(f.pack_size, '')
   and t.addon_id = f.addon_id
  group by f.addon_id, f.rule_id;

-- ----------------------------------------------------------------- access
-- Same stance as 0001: RLS on, no policies, so only the service role key held
-- by the server-side functions can read or write any of this. The views run
-- with the caller's rights (security_invoker), so they cannot be used to read
-- around RLS, and the functions are not callable from a browser.
alter table public.addon_stock_movements enable row level security;

revoke all on public.addon_stock_levels, public.addon_revenue, public.addon_attach_rate
  from public, anon, authenticated;
revoke execute on function public.record_addon_sales(uuid), public.release_addon_sales(uuid)
  from public, anon, authenticated;
