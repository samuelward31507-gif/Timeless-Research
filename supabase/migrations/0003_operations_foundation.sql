-- Operations foundation: order lifecycle, product inventory and lots,
-- financials, and read-only customer aggregates.
--
-- Payment-provider agnostic. Nothing here knows how an order was paid for or
-- which processor recorded it. Schema, rules and reporting views only: there
-- is no user interface yet, and nothing on the public website reads any of it.
-- Apply after 0001 and 0002. Safe to run twice. Existing order rows are kept
-- exactly as they are.
--
-- Money stays in the smallest currency unit, as integers.

-- ======================================================================
-- 1. Order lifecycle
-- ======================================================================
--
--   paid -> processing -> packed -> shipped -> delivered -> completed
--
-- with cancelled (before anything ships) and refunded (at any point) as exits.
-- The allowed moves are rows in order_status_transitions, enforced by a
-- trigger, so a status can only move the way the business moves an order.
--
-- "paid" is the state an order is recorded in once payment is confirmed. A
-- payment notification can arrive again, late or out of order, after the order
-- has moved on; the recording code then writes status = 'paid' over whatever
-- is there. That write is not an error the sender can fix, so the trigger keeps
-- the current status rather than refusing the whole row, and the order never
-- moves backward. Any other move that is not in the table is refused.

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (
  status in ('paid', 'processing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded')
);

alter table public.orders
  add column if not exists processing_at     timestamptz,
  add column if not exists packed_at         timestamptz,
  add column if not exists delivered_at      timestamptz,
  add column if not exists completed_at      timestamptz,
  add column if not exists cancelled_at      timestamptz,
  add column if not exists refunded_at       timestamptz,
  add column if not exists status_changed_at timestamptz;

create table if not exists public.order_status_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status),
  check (from_status <> to_status)
);

insert into public.order_status_transitions (from_status, to_status) values
  ('paid',       'processing'), ('paid',       'cancelled'), ('paid',       'refunded'),
  ('processing', 'packed'),     ('processing', 'cancelled'), ('processing', 'refunded'),
  -- unpacking, e.g. to change the lot before it leaves
  ('packed',     'processing'),
  ('packed',     'shipped'),    ('packed',     'cancelled'), ('packed',     'refunded'),
  ('shipped',    'delivered'),  ('shipped',    'refunded'),
  ('delivered',  'completed'),  ('delivered',  'refunded'),
  ('completed',  'refunded'),
  ('cancelled',  'refunded')
on conflict do nothing;

create table if not exists public.order_status_history (
  id           bigint generated always as identity primary key,
  order_id     uuid        not null references public.orders(id) on delete cascade,
  from_status  text,
  to_status    text        not null,
  changed_at   timestamptz not null default now(),
  changed_by   text        not null default current_user,
  note         text
);
create index if not exists order_status_history_order_idx
  on public.order_status_history (order_id, changed_at);

-- Every order that exists before this migration gets one history row: the
-- state it was in, dated when it was created. Its earlier moves were never
-- recorded and are not invented.
insert into public.order_status_history (order_id, from_status, to_status, changed_at, changed_by, note)
select o.id, null, o.status, o.created_at, 'migration-0003', 'status when history began'
from public.orders o
where not exists (select 1 from public.order_status_history h where h.order_id = o.id);

create or replace function public.orders_guard_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if not exists (select 1 from public.order_status_transitions t
                 where t.from_status = old.status and t.to_status = new.status) then
    if new.status = 'paid' then
      -- A repeated or late payment confirmation. Keep where the order is.
      new.status := old.status;
      return new;
    end if;
    raise exception 'order %: status cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  new.status_changed_at := now();
  case new.status
    when 'processing' then new.processing_at := coalesce(new.processing_at, now());
    when 'packed'     then new.packed_at     := coalesce(new.packed_at, now());
    when 'shipped'    then new.shipped_at    := coalesce(new.shipped_at, now());
    when 'delivered'  then new.delivered_at  := coalesce(new.delivered_at, now());
    when 'completed'  then new.completed_at  := coalesce(new.completed_at, now());
    when 'cancelled'  then new.cancelled_at  := coalesce(new.cancelled_at, now());
    when 'refunded'   then new.refunded_at   := coalesce(new.refunded_at, now());
    else null;
  end case;
  return new;
end $$;

drop trigger if exists orders_guard_status on public.orders;
create trigger orders_guard_status
  before update of status on public.orders
  for each row execute function public.orders_guard_status();

-- History is written for every real change, whoever makes it. The note and
-- actor come from set_order_status() when it is used; a direct update still
-- leaves a row, attributed to the database role.
create or replace function public.orders_log_status()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_from text;
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      return null;
    end if;
    v_from := old.status;
  end if;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (new.id, v_from, new.status,
          coalesce(nullif(current_setting('app.actor', true), ''), current_user),
          nullif(current_setting('app.status_note', true), ''));
  return null;
end $$;

drop trigger if exists orders_log_status on public.orders;
create trigger orders_log_status
  after insert or update of status on public.orders
  for each row execute function public.orders_log_status();

-- The way the operations console (Phase 1) will move an order. Refuses
-- 'paid' as a target: only payment confirmation puts an order there.
create or replace function public.set_order_status(
  p_order_id uuid, p_status text, p_note text default null, p_actor text default null)
returns public.orders
language plpgsql
set search_path = public
as $$
declare
  v_current text;
  v_row     public.orders;
begin
  select status into v_current from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if p_status = 'paid' and v_current <> 'paid' then
    raise exception 'order %: status cannot move from % to paid', p_order_id, v_current
      using errcode = 'check_violation';
  end if;
  perform set_config('app.status_note', coalesce(p_note, ''), true);
  perform set_config('app.actor', coalesce(p_actor, ''), true);
  update public.orders set status = p_status where id = p_order_id returning * into v_row;
  perform set_config('app.status_note', '', true);
  perform set_config('app.actor', '', true);
  return v_row;
end $$;

-- The add-on reports from 0002 counted 'paid' and 'shipped' as sales, which
-- were the only live statuses then. With the full lifecycle, an order that is
-- processing, packed, delivered or completed is just as much a sale; without
-- this, it would silently drop out of add-on revenue and attach rate. Same
-- views, same columns, the complete list of sale statuses.
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
  where i.kind = 'addon' and o.status in ('paid', 'processing', 'packed', 'shipped', 'delivered', 'completed')
  group by 1, 2;

create or replace view public.addon_attach_rate
  with (security_invoker = true) as
  with offered as (
    select o.id as order_id, p.sku, p.pack_size,
           e->>'addon' as addon_id, e->>'rule' as rule_id
    from public.order_items p
    join public.orders o on o.id = p.order_id
    cross join lateral jsonb_array_elements(coalesce(p.offered_addons, '[]'::jsonb)) e
    where p.kind = 'product' and o.status in ('paid', 'processing', 'packed', 'shipped', 'delivered', 'completed')
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

-- ======================================================================
-- 2. Product inventory and lots
-- ======================================================================
--
-- A stock item is a product and pack size, matching order_items.sku and
-- order_items.pack_size. Stock exists only in lots: a lot is received, and its
-- quantity is the sum of its movements. Nothing is ever overwritten; a
-- correction is another movement.
--
-- Stock leaves a lot when an order line is allocated to it (order_line_lots).
-- One line may draw on several lots: each allocation row is one (line, lot)
-- pair, so splitting a line is more rows, not a different schema. Today the
-- operator allocates one lot per line.

create table if not exists public.inventory_items (
  product_id           text        not null,
  pack_size            text        not null,
  low_stock_threshold  integer     check (low_stock_threshold >= 0),
  active               boolean     not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  primary key (product_id, pack_size)
);

create table if not exists public.lots (
  id                 uuid        primary key default gen_random_uuid(),
  product_id         text        not null,
  pack_size          text        not null,
  lot_number         text        not null check (length(btrim(lot_number)) > 0),
  received_on        date        not null default current_date,
  quantity_received  integer     not null check (quantity_received > 0),
  -- Where the analytical programme sets one; null where it does not apply.
  retest_date        date,
  -- Where the certificate of analysis for this lot lives: a file path, URL or
  -- document reference. Only a reference; no document is stored here.
  coa_reference      text,
  -- Landed cost per unit. Null until known; gross margin treats an order that
  -- draws on an uncosted lot as not yet costed rather than as free.
  unit_cost_cents    integer     check (unit_cost_cents >= 0),
  currency           text        not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  supplier           text,
  notes              text,
  created_at         timestamptz not null default now(),
  foreign key (product_id, pack_size) references public.inventory_items (product_id, pack_size)
    on update restrict on delete restrict,
  unique (product_id, pack_size, lot_number)
);

create table if not exists public.order_line_lots (
  id           bigint generated always as identity primary key,
  order_id     uuid        not null references public.orders(id) on delete restrict,
  product_id   text        not null,
  pack_size    text        not null,
  lot_id       uuid        not null references public.lots(id) on delete restrict,
  quantity     integer     not null check (quantity > 0),
  allocated_at timestamptz not null default now(),
  allocated_by text        not null default current_user,
  -- Set when the allocation is undone (deallocated, or the order cancelled
  -- before it shipped). The row stays, as the record that it happened.
  released_at  timestamptz
);
-- One live allocation per line per lot; a released one does not count.
create unique index if not exists order_line_lots_live
  on public.order_line_lots (order_id, product_id, pack_size, lot_id) where released_at is null;
create index if not exists order_line_lots_order_idx on public.order_line_lots (order_id);

create table if not exists public.stock_movements (
  id            bigint generated always as identity primary key,
  lot_id        uuid        not null references public.lots(id) on delete restrict,
  delta         integer     not null check (delta <> 0),
  reason        text        not null check (reason in ('receipt', 'sale', 'release', 'return', 'adjustment', 'write_off')),
  order_id      uuid        references public.orders(id) on delete restrict,
  allocation_id bigint      references public.order_line_lots(id) on delete restrict,
  note          text,
  created_by    text        not null default current_user,
  created_at    timestamptz not null default now(),
  check ((reason in ('sale', 'release')) = (allocation_id is not null and order_id is not null)),
  check (reason <> 'receipt'   or delta > 0),
  check (reason <> 'sale'      or delta < 0),
  check (reason <> 'release'   or delta > 0),
  check (reason <> 'return'    or delta > 0),
  check (reason <> 'write_off' or delta < 0)
);
create unique index if not exists stock_movements_receipt_once
  on public.stock_movements (lot_id) where reason = 'receipt';
create unique index if not exists stock_movements_allocation_once
  on public.stock_movements (allocation_id, reason) where reason in ('sale', 'release');
create index if not exists stock_movements_lot_idx on public.stock_movements (lot_id, created_at);

-- Receiving a lot puts its quantity into stock, once.
create or replace function public.lots_receive()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.stock_movements (lot_id, delta, reason, note)
  values (new.id, new.quantity_received, 'receipt', 'lot received');
  return null;
end $$;

drop trigger if exists lots_receive on public.lots;
create trigger lots_receive
  after insert on public.lots
  for each row execute function public.lots_receive();

-- What a lot is (its product, pack size and received quantity) cannot be
-- edited after the fact: the receipt movement already counted it. Correct a
-- count with an adjustment; the rest of the lot record stays editable.
create or replace function public.lots_freeze_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.product_id <> old.product_id or new.pack_size <> old.pack_size
     or new.quantity_received <> old.quantity_received then
    raise exception 'lot %: product, pack size and quantity received cannot change; record an adjustment instead', old.lot_number
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists lots_freeze_identity on public.lots;
create trigger lots_freeze_identity
  before update on public.lots
  for each row execute function public.lots_freeze_identity();

-- No movement may take a lot below zero. The lot row is locked first so two
-- movements on the same lot cannot both pass the check.
create or replace function public.stock_movements_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_on_hand integer;
begin
  perform 1 from public.lots where id = new.lot_id for update;
  if new.delta < 0 then
    select coalesce(sum(delta), 0) into v_on_hand from public.stock_movements where lot_id = new.lot_id;
    if v_on_hand + new.delta < 0 then
      raise exception 'lot %: only % on hand, cannot remove %', new.lot_id, v_on_hand, -new.delta
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists stock_movements_guard on public.stock_movements;
create trigger stock_movements_guard
  before insert on public.stock_movements
  for each row execute function public.stock_movements_guard();

-- The ledger is append-only.
create or replace function public.stock_movements_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'stock movements cannot be changed or deleted; record a correcting movement'
    using errcode = 'check_violation';
end $$;

drop trigger if exists stock_movements_append_only on public.stock_movements;
create trigger stock_movements_append_only
  before update or delete on public.stock_movements
  for each row execute function public.stock_movements_append_only();

-- Draw an order line from a lot. Checks that the order can still be packed,
-- that the lot is for that product and pack size, and that the line is not
-- drawn beyond what was ordered; then takes the units out of the lot.
create or replace function public.allocate_order_line(
  p_order_id uuid, p_product_id text, p_pack_size text, p_lot_id uuid, p_quantity integer)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_status    text;
  v_lot       public.lots;
  v_ordered   integer;
  v_allocated integer;
  v_id        bigint;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be positive' using errcode = 'check_violation';
  end if;
  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_status not in ('paid', 'processing', 'packed') then
    raise exception 'order % is %; stock can only be allocated before it ships', p_order_id, v_status
      using errcode = 'check_violation';
  end if;
  select * into v_lot from public.lots where id = p_lot_id;
  if not found then
    raise exception 'lot % not found', p_lot_id using errcode = 'no_data_found';
  end if;
  if v_lot.product_id <> p_product_id or v_lot.pack_size <> p_pack_size then
    raise exception 'lot % is % %, not % %', v_lot.lot_number, v_lot.product_id, v_lot.pack_size, p_product_id, p_pack_size
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(quantity), 0) into v_ordered
    from public.order_items
   where order_id = p_order_id and kind = 'product' and sku = p_product_id and pack_size = p_pack_size;
  if v_ordered = 0 then
    raise exception 'order % has no line for % %', p_order_id, p_product_id, p_pack_size
      using errcode = 'no_data_found';
  end if;
  select coalesce(sum(quantity), 0) into v_allocated
    from public.order_line_lots
   where order_id = p_order_id and product_id = p_product_id and pack_size = p_pack_size and released_at is null;
  if v_allocated + p_quantity > v_ordered then
    raise exception 'order % line % %: % ordered, % already allocated, cannot allocate % more',
      p_order_id, p_product_id, p_pack_size, v_ordered, v_allocated, p_quantity
      using errcode = 'check_violation';
  end if;

  insert into public.order_line_lots (order_id, product_id, pack_size, lot_id, quantity)
  values (p_order_id, p_product_id, p_pack_size, p_lot_id, p_quantity)
  returning id into v_id;
  insert into public.stock_movements (lot_id, delta, reason, order_id, allocation_id, note)
  values (p_lot_id, -p_quantity, 'sale', p_order_id, v_id, 'allocated to order');
  return v_id;
end $$;

-- Undo one allocation: the units go back to their lot, once.
create or replace function public.release_allocation(p_allocation_id bigint, p_note text default null)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_a public.order_line_lots;
begin
  update public.order_line_lots set released_at = now()
   where id = p_allocation_id and released_at is null
   returning * into v_a;
  if not found then
    return false;
  end if;
  insert into public.stock_movements (lot_id, delta, reason, order_id, allocation_id, note)
  values (v_a.lot_id, v_a.quantity, 'release', v_a.order_id, v_a.id, coalesce(p_note, 'allocation released'));
  return true;
end $$;

-- An order cancelled, or refunded before it shipped, gives its allocated
-- stock back. One refunded after shipping does not: the goods have left, and
-- anything that comes back is recorded as a 'return' when it arrives.
create or replace function public.orders_release_allocations()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_id bigint;
begin
  if new.status is distinct from old.status
     and (new.status = 'cancelled' or (new.status = 'refunded' and new.shipped_at is null)) then
    for v_id in select id from public.order_line_lots where order_id = new.id and released_at is null loop
      perform public.release_allocation(v_id, 'order ' || new.status);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists orders_release_allocations on public.orders;
create trigger orders_release_allocations
  after update of status on public.orders
  for each row execute function public.orders_release_allocations();

-- Stock in, stock out by hand: a count correction, damage, a returned parcel.
create or replace function public.record_stock_movement(
  p_lot_id uuid, p_delta integer, p_reason text, p_note text)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_reason not in ('return', 'adjustment', 'write_off') then
    raise exception 'record_stock_movement takes return, adjustment or write_off; receipts come from lots and sales from allocations'
      using errcode = 'check_violation';
  end if;
  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'a stock movement needs a note saying why' using errcode = 'check_violation';
  end if;
  insert into public.stock_movements (lot_id, delta, reason, note)
  values (p_lot_id, p_delta, p_reason, p_note)
  returning id into v_id;
  return v_id;
end $$;

-- Per lot: what came in, what went out and why, what is left, retest status.
create or replace view public.lot_levels
  with (security_invoker = true) as
  select l.id as lot_id, l.product_id, l.pack_size, l.lot_number, l.received_on,
         l.quantity_received, l.retest_date,
         (l.retest_date is not null and l.retest_date < current_date)                    as retest_overdue,
         (l.retest_date is not null and l.retest_date < current_date + 30)               as retest_due_30d,
         l.coa_reference, l.unit_cost_cents, l.currency,
         coalesce(sum(m.delta), 0)::integer                                              as on_hand,
         coalesce(sum(-m.delta) filter (where m.reason = 'sale'), 0)::integer            as allocated_out,
         coalesce(sum(m.delta)  filter (where m.reason = 'release'), 0)::integer         as released_back,
         coalesce(sum(m.delta)  filter (where m.reason = 'return'), 0)::integer          as returned,
         coalesce(sum(m.delta)  filter (where m.reason in ('adjustment', 'write_off')), 0)::integer as adjusted
  from public.lots l
  left join public.stock_movements m on m.lot_id = l.id
  group by l.id;

-- Per stock item: on hand, sold but not yet allocated, available, low stock.
-- "Committed" needs order lines that carry sku and pack_size; lines recorded
-- with only a description (as the current payment integration writes them)
-- cannot be counted here until the payment integration records the sku.
create or replace view public.inventory_levels
  with (security_invoker = true) as
  with on_hand as (
    select l.product_id, l.pack_size, sum(m.delta)::integer as qty
    from public.lots l join public.stock_movements m on m.lot_id = l.id
    group by 1, 2
  ),
  demand as (
    select i.sku as product_id, i.pack_size, sum(i.quantity)::integer as qty
    from public.order_items i
    join public.orders o on o.id = i.order_id
    where i.kind = 'product' and i.sku is not null and o.status in ('paid', 'processing', 'packed')
    group by 1, 2
  ),
  allocated as (
    select a.product_id, a.pack_size, sum(a.quantity)::integer as qty
    from public.order_line_lots a
    join public.orders o on o.id = a.order_id
    where a.released_at is null and o.status in ('paid', 'processing', 'packed')
    group by 1, 2
  )
  select it.product_id, it.pack_size, it.active,
         coalesce(h.qty, 0)                                                     as on_hand,
         greatest(coalesce(d.qty, 0) - coalesce(a.qty, 0), 0)                   as committed_unallocated,
         coalesce(h.qty, 0) - greatest(coalesce(d.qty, 0) - coalesce(a.qty, 0), 0) as available,
         it.low_stock_threshold,
         (it.low_stock_threshold is not null and
          coalesce(h.qty, 0) - greatest(coalesce(d.qty, 0) - coalesce(a.qty, 0), 0) <= it.low_stock_threshold) as is_low
  from public.inventory_items it
  left join on_hand   h on h.product_id = it.product_id and h.pack_size = it.pack_size
  left join demand    d on d.product_id = it.product_id and d.pack_size = it.pack_size
  left join allocated a on a.product_id = it.product_id and a.pack_size = it.pack_size;

create or replace view public.low_stock
  with (security_invoker = true) as
  select * from public.inventory_levels where active and is_low;

-- Units that actually left (allocations net of releases) over 30 and 90 days.
create or replace view public.inventory_velocity
  with (security_invoker = true) as
  select l.product_id, l.pack_size,
         coalesce(sum(-m.delta) filter (where m.created_at >= now() - interval '30 days'), 0)::integer as units_out_30d,
         coalesce(sum(-m.delta) filter (where m.created_at >= now() - interval '90 days'), 0)::integer as units_out_90d
  from public.lots l
  join public.stock_movements m on m.lot_id = l.id and m.reason in ('sale', 'release')
  group by 1, 2;

-- ======================================================================
-- 3. Financials
-- ======================================================================
--
-- Revenue comes from orders as recorded. Processor fees, tax separated from
-- the total, and revenue by product (which needs a sku on every product line)
-- depend on the payment integration and are NOT complete here; the views say
-- so in their column names rather than presenting a guess as a figure.
--
-- Cost of goods comes from lots: the units allocated to an order times their
-- lot's unit cost. An order is "cost complete" only when every unit on it is
-- allocated to a lot with a known cost; gross margin is reported over those
-- orders only.
--
-- Inventory purchases are recorded as expenses with an 'inventory' category
-- for the cash view, and excluded from operating expenses, because they reach
-- the profit figure as cost of goods when the stock is sold.

create table if not exists public.expense_categories (
  code       text primary key check (code ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  name       text    not null,
  treatment  text    not null default 'operating' check (treatment in ('operating', 'inventory')),
  active     boolean not null default true
);

-- Generic starting categories. Rename, add or deactivate them freely.
insert into public.expense_categories (code, name, treatment) values
  ('inventory_purchases', 'Inventory purchases',        'inventory'),
  ('shipping_postage',    'Shipping and postage',       'operating'),
  ('packaging_supplies',  'Packaging and supplies',     'operating'),
  ('lab_testing',         'Third-party testing',        'operating'),
  ('payment_fees',        'Payment processing fees',    'operating'),
  ('software',            'Software and subscriptions', 'operating'),
  ('marketing',           'Marketing',                  'operating'),
  ('professional_fees',   'Professional fees',          'operating'),
  ('insurance',           'Insurance',                  'operating'),
  ('other',               'Other',                      'operating')
on conflict (code) do nothing;

create table if not exists public.expenses (
  id             uuid        primary key default gen_random_uuid(),
  incurred_on    date        not null,
  category_code  text        not null references public.expense_categories(code) on update cascade,
  description    text        not null check (length(btrim(description)) > 0),
  -- Negative for a credit or vendor refund.
  amount_cents   integer     not null check (amount_cents <> 0),
  currency       text        not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  vendor         text,
  reference      text,
  lot_id         uuid        references public.lots(id) on delete set null,
  notes          text,
  -- Set by import_expenses(): the same spreadsheet row imported twice is one expense.
  import_key     text        unique,
  created_by     text        not null default current_user,
  created_at     timestamptz not null default now()
);
create index if not exists expenses_incurred_idx on public.expenses (incurred_on);

-- CSV import. Load a CSV into expense_import (the Supabase table editor
-- imports CSV directly; the headers are the column names below, all text),
-- then run: select * from import_expenses();
-- Each row is validated on its own: good rows become expenses, bad rows stay
-- with an error saying why, rows already imported are marked duplicate.
create table if not exists public.expense_import (
  id           bigint generated always as identity primary key,
  incurred_on  text,
  category     text,
  description  text,
  amount       text,
  currency     text,
  vendor       text,
  reference    text,
  notes        text,
  status       text not null default 'pending' check (status in ('pending', 'imported', 'duplicate', 'error')),
  error        text,
  expense_id   uuid references public.expenses(id) on delete set null,
  loaded_at    timestamptz not null default now()
);

create or replace function public.import_expenses()
returns table (imported integer, duplicates integer, errors integer)
language plpgsql
set search_path = public
as $$
declare
  r          public.expense_import;
  v_date     date;
  v_cat      text;
  v_amount   numeric;
  v_cents    integer;
  v_currency text;
  v_key      text;
  v_id       uuid;
  n_ok integer := 0; n_dup integer := 0; n_err integer := 0;
begin
  for r in select * from public.expense_import where status = 'pending' order by id for update loop
    begin
      if r.incurred_on is null or btrim(r.incurred_on) !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'date must be YYYY-MM-DD';
      end if;
      v_date := btrim(r.incurred_on)::date;

      select code into v_cat from public.expense_categories
       where active and (code = lower(btrim(r.category)) or lower(name) = lower(btrim(r.category)));
      if v_cat is null then
        raise exception 'unknown category "%"', coalesce(r.category, '');
      end if;

      if r.description is null or length(btrim(r.description)) = 0 then
        raise exception 'description is required';
      end if;

      if r.amount is null or regexp_replace(r.amount, '[\s$,]', '', 'g') !~ '^-?\d+(\.\d{1,2})?$' then
        raise exception 'amount must be a number with at most two decimals';
      end if;
      v_amount := regexp_replace(r.amount, '[\s$,]', '', 'g')::numeric;
      v_cents  := round(v_amount * 100)::integer;
      if v_cents = 0 then
        raise exception 'amount cannot be zero';
      end if;

      v_currency := upper(coalesce(nullif(btrim(r.currency), ''), 'USD'));
      if v_currency !~ '^[A-Z]{3}$' then
        raise exception 'currency must be a three-letter code';
      end if;

      v_key := md5(concat_ws('|', v_date, v_cat, v_cents, v_currency, lower(btrim(r.description)),
                             coalesce(btrim(r.vendor), ''), coalesce(btrim(r.reference), '')));

      insert into public.expenses (incurred_on, category_code, description, amount_cents, currency,
                                   vendor, reference, notes, import_key)
      values (v_date, v_cat, btrim(r.description), v_cents, v_currency,
              nullif(btrim(r.vendor), ''), nullif(btrim(r.reference), ''), nullif(btrim(r.notes), ''), v_key)
      on conflict (import_key) do nothing
      returning id into v_id;

      if v_id is null then
        update public.expense_import set status = 'duplicate', error = null where id = r.id;
        n_dup := n_dup + 1;
      else
        update public.expense_import set status = 'imported', error = null, expense_id = v_id where id = r.id;
        n_ok := n_ok + 1;
      end if;
      v_id := null;
    exception when others then
      update public.expense_import set status = 'error', error = sqlerrm where id = r.id;
      n_err := n_err + 1;
    end;
  end loop;
  return query select n_ok, n_dup, n_err;
end $$;

-- Orders that count as sales: everything paid and not cancelled or refunded.
-- Partial refunds are not modelled yet (they depend on the payment
-- integration); a refunded order is excluded in full.
create or replace view public.revenue_orders
  with (security_invoker = true) as
  select o.*,
         date_trunc('month', o.created_at)::date as month,
         -- Goods after discount, excluding shipping. Tax is not separated from
         -- amount_total until the payment integration records it.
         (coalesce(o.amount_subtotal, o.amount_total - o.amount_shipping) - o.amount_discount) as goods_net_cents
  from public.orders o
  where o.status in ('paid', 'processing', 'packed', 'shipped', 'delivered', 'completed');

create or replace view public.monthly_revenue
  with (security_invoker = true) as
  select month, currency,
         count(*)                                  as orders,
         sum(amount_total)::bigint                 as total_cents,
         sum(goods_net_cents)::bigint              as goods_net_cents,
         sum(amount_shipping)::bigint              as shipping_cents,
         sum(amount_discount)::bigint              as discount_cents,
         round(avg(amount_total))::bigint          as average_order_cents,
         false                                     as fees_and_tax_separated
  from public.revenue_orders
  group by month, currency;

create or replace view public.order_metrics
  with (security_invoker = true) as
  select currency,
         count(*)                                  as orders,
         sum(amount_total)::bigint                 as total_cents,
         round(avg(amount_total))::bigint          as average_order_cents,
         min(created_at)                           as first_order_at,
         max(created_at)                           as last_order_at
  from public.revenue_orders
  group by currency;

create or replace view public.monthly_expenses
  with (security_invoker = true) as
  select date_trunc('month', e.incurred_on)::date as month, e.currency,
         e.category_code, c.name as category, c.treatment,
         count(*)                   as entries,
         sum(e.amount_cents)::bigint as amount_cents
  from public.expenses e
  join public.expense_categories c on c.code = e.category_code
  group by 1, 2, 3, 4, 5;

-- Cost of goods per order from allocated lots.
create or replace view public.order_cogs
  with (security_invoker = true) as
  with lines as (
    select i.order_id, i.sku as product_id, i.pack_size, sum(i.quantity)::integer as ordered
    from public.order_items i
    where i.kind = 'product'
    group by 1, 2, 3
  ),
  alloc as (
    select a.order_id, a.product_id, a.pack_size,
           sum(a.quantity)::integer                                                   as units,
           sum(a.quantity) filter (where l.unit_cost_cents is not null)::integer      as units_costed,
           sum(a.quantity::bigint * l.unit_cost_cents) filter (where l.unit_cost_cents is not null) as cost_cents
    from public.order_line_lots a
    join public.lots l on l.id = a.lot_id
    where a.released_at is null
    group by 1, 2, 3
  )
  select o.id as order_id,
         coalesce(sum(a.cost_cents), 0)::bigint                                       as cogs_cents,
         coalesce(sum(ln.ordered), 0)::integer                                        as units_ordered,
         coalesce(sum(a.units_costed), 0)::integer                                    as units_costed,
         -- Complete only when every product line names its sku and every
         -- ordered unit is allocated to a lot with a known cost.
         (count(ln.order_id) > 0
          and bool_and(ln.product_id is not null)
          and coalesce(sum(a.units_costed), 0) = coalesce(sum(ln.ordered), 0))       as cost_complete
  from public.orders o
  left join lines ln on ln.order_id = o.id
  left join alloc a  on a.order_id = ln.order_id and a.product_id = ln.product_id and a.pack_size = ln.pack_size
  group by o.id;

create or replace view public.monthly_gross_margin
  with (security_invoker = true) as
  select r.month, r.currency,
         count(*)                                                       as orders,
         count(*) filter (where c.cost_complete)                        as orders_cost_complete,
         sum(r.goods_net_cents) filter (where c.cost_complete)::bigint  as goods_net_cents_costed,
         sum(c.cogs_cents)      filter (where c.cost_complete)::bigint  as cogs_cents_costed,
         (sum(r.goods_net_cents) filter (where c.cost_complete)
          - sum(c.cogs_cents)    filter (where c.cost_complete))::bigint as gross_margin_cents,
         round(100.0 * (sum(r.goods_net_cents) filter (where c.cost_complete)
                        - sum(c.cogs_cents) filter (where c.cost_complete))
               / nullif(sum(r.goods_net_cents) filter (where c.cost_complete), 0), 1) as gross_margin_percent
  from public.revenue_orders r
  join public.order_cogs c on c.order_id = r.id
  group by r.month, r.currency;

-- One row per month and currency: sales, operating expenses, inventory
-- bought, and margin over the orders that can be costed.
create or replace view public.monthly_financial_summary
  with (security_invoker = true) as
  with months as (
    select month, currency from public.monthly_revenue
    union
    select month, currency from public.monthly_expenses
  )
  select m.month, m.currency,
         coalesce(r.orders, 0)                                       as orders,
         coalesce(r.total_cents, 0)                                  as revenue_total_cents,
         coalesce(r.goods_net_cents, 0)                              as revenue_goods_net_cents,
         r.average_order_cents,
         coalesce((select sum(amount_cents) from public.monthly_expenses e
                    where e.month = m.month and e.currency = m.currency and e.treatment = 'operating'), 0)::bigint
                                                                     as operating_expenses_cents,
         coalesce((select sum(amount_cents) from public.monthly_expenses e
                    where e.month = m.month and e.currency = m.currency and e.treatment = 'inventory'), 0)::bigint
                                                                     as inventory_purchases_cents,
         g.orders_cost_complete,
         g.gross_margin_cents,
         g.gross_margin_percent,
         false                                                       as fees_and_tax_separated
  from months m
  left join public.monthly_revenue r      on r.month = m.month and r.currency = m.currency
  left join public.monthly_gross_margin g on g.month = m.month and g.currency = m.currency;

-- ======================================================================
-- 4. Customer aggregates (read-only)
-- ======================================================================
--
-- Customers as they appear on orders, keyed by email address. No accounts, no
-- profiles, no marketing fields: these views only summarise orders that
-- already exist. Orders without an email are counted, not attributed.

create or replace view public.customer_aggregates
  with (security_invoker = true) as
  select lower(btrim(o.email))                                     as customer_email,
         o.currency,
         min(o.created_at)                                         as first_order_at,
         max(o.created_at)                                         as last_order_at,
         count(*)                                                  as order_count,
         sum(o.amount_total)::bigint                               as lifetime_revenue_cents,
         round(avg(o.amount_total))::bigint                        as average_order_cents,
         (count(*) > 1)                                            as is_repeat
  from public.revenue_orders o
  where o.email is not null and length(btrim(o.email)) > 0
  group by 1, 2;

create or replace view public.customer_summary
  with (security_invoker = true) as
  select c.currency,
         count(*)                                                  as customers,
         count(*) filter (where c.is_repeat)                       as repeat_customers,
         round(100.0 * count(*) filter (where c.is_repeat) / nullif(count(*), 0), 1) as repeat_rate_percent,
         round(avg(c.lifetime_revenue_cents))::bigint              as average_lifetime_revenue_cents,
         (select count(*) from public.revenue_orders r
           where r.currency = c.currency and (r.email is null or length(btrim(r.email)) = 0)) as orders_without_email
  from public.customer_aggregates c
  group by c.currency;

-- ======================================================================
-- Access
-- ======================================================================
-- As in 0001 and 0002: RLS on with no policies, so only the service role used
-- by server-side code can read or write. Views run with the caller's rights
-- and are revoked from browser roles; the functions are not callable from a
-- browser.

alter table public.order_status_transitions enable row level security;
alter table public.order_status_history     enable row level security;
alter table public.inventory_items          enable row level security;
alter table public.lots                     enable row level security;
alter table public.order_line_lots          enable row level security;
alter table public.stock_movements          enable row level security;
alter table public.expense_categories       enable row level security;
alter table public.expenses                 enable row level security;
alter table public.expense_import           enable row level security;

revoke all on
  public.addon_revenue, public.addon_attach_rate,
  public.lot_levels, public.inventory_levels, public.low_stock, public.inventory_velocity,
  public.revenue_orders, public.monthly_revenue, public.order_metrics, public.monthly_expenses,
  public.order_cogs, public.monthly_gross_margin, public.monthly_financial_summary,
  public.customer_aggregates, public.customer_summary
  from public, anon, authenticated;

revoke execute on function
  public.set_order_status(uuid, text, text, text),
  public.allocate_order_line(uuid, text, text, uuid, integer),
  public.release_allocation(bigint, text),
  public.record_stock_movement(uuid, integer, text, text),
  public.import_expenses(),
  public.orders_guard_status(), public.orders_log_status(), public.orders_release_allocations(),
  public.lots_receive(), public.lots_freeze_identity(),
  public.stock_movements_guard(), public.stock_movements_append_only()
  from public, anon, authenticated;
