-- Owner operations console: the data layer it needs.
--
-- Phase 1, Pass 1. Database only: no user interface, no authentication code,
-- no API. Payment-provider agnostic. Apply after 0001-0003. Safe to run twice.
--
-- The rule this migration enforces in the database itself, not only in the
-- server code that will call it:
--
--   Every console write names the staff member making it. The database checks
--   that the person is an active staff member whose role allows the action,
--   records the change against them, and writes an audit entry, all in one
--   transaction. Nothing else can write the console's tables.
--
-- How: each console action is a SECURITY DEFINER function (it runs with the
-- table owner's rights) that takes the acting staff member's id first. The
-- service role, which the server functions use, keeps read access but loses
-- direct INSERT/UPDATE/DELETE on those tables, so a leaked service key cannot
-- forge an audit row, rewrite history, or move stock without an actor.
-- Browser roles (anon, authenticated) still have no access to anything.
--
-- Deliberately unchanged: the payment path. The service role can still write
-- orders and order_items exactly as before, because the payment integration
-- (whatever it becomes) records paid orders that way.

-- ======================================================================
-- 1. Who can act: staff, roles, permissions
-- ======================================================================
--
-- Roles and permissions are rows, not code. Only 'owner' exists now; adding a
-- fulfilment or staff role later is inserting a role and its permissions,
-- with no change to how authorization is checked.

create table if not exists public.permissions (
  code        text primary key check (code ~ '^[a-z]+\.[a-z]+$'),
  description text not null
);

insert into public.permissions (code, description) values
  ('orders.read',       'See orders, customers on orders, history and notes'),
  ('orders.write',      'Move orders through their statuses, add notes, ship'),
  ('fulfilment.write',  'Allocate stock to orders and map order lines to products'),
  ('inventory.read',    'See stock items, lots, movements and levels'),
  ('inventory.write',   'Receive lots, edit lots and stock items, record movements'),
  ('finance.read',      'See revenue, expenses, cost of goods and margin'),
  ('finance.write',     'Create, edit, delete and import expenses'),
  ('customers.read',    'See customer aggregates'),
  ('audit.read',        'See the audit log'),
  ('staff.manage',      'Add, change and deactivate console users')
on conflict (code) do nothing;

create table if not exists public.staff_roles (
  code        text primary key check (code ~ '^[a-z_]+$'),
  name        text not null,
  description text
);

insert into public.staff_roles (code, name, description) values
  ('owner', 'Owner', 'Full access to the operations console')
on conflict (code) do nothing;

create table if not exists public.role_permissions (
  role_code       text not null references public.staff_roles(code) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

insert into public.role_permissions (role_code, permission_code)
select 'owner', code from public.permissions
on conflict do nothing;

create table if not exists public.staff_members (
  id              uuid        primary key default gen_random_uuid(),
  -- The Supabase Auth user. Linked to auth.users below where that schema
  -- exists; sign-in itself is Pass 2.
  auth_user_id    uuid        unique,
  email           text        not null check (email = lower(btrim(email)) and email like '%_@_%'),
  display_name    text,
  role_code       text        not null references public.staff_roles(code),
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  created_by      text        not null default session_user,
  deactivated_at  timestamptz
);
create unique index if not exists staff_members_email_key on public.staff_members (email);

do $$
begin
  if to_regclass('auth.users') is not null
     and not exists (select 1 from pg_constraint where conname = 'staff_members_auth_user_fkey') then
    alter table public.staff_members
      add constraint staff_members_auth_user_fkey
      foreign key (auth_user_id) references auth.users(id) on delete set null;
  end if;
end $$;

-- The console must never lose its last owner.
create or replace function public.staff_keep_an_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.role_code = 'owner' and old.active
     and (new.active is distinct from true or new.role_code <> 'owner')
     and not exists (select 1 from public.staff_members
                     where id <> old.id and role_code = 'owner' and active) then
    raise exception 'cannot remove the last active owner' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists staff_keep_an_owner on public.staff_members;
create trigger staff_keep_an_owner
  before update on public.staff_members
  for each row execute function public.staff_keep_an_owner();

-- Who is acting, for column defaults and history: the staff member set by the
-- calling console function, otherwise the database login (a payment-path
-- write, a migration, or a person in the SQL editor).
create or replace function public.current_actor()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(current_setting('app.actor', true), ''), session_user::text);
$$;

-- Columns that record who did something now record the staff member when a
-- console function is acting. Inside a SECURITY DEFINER function
-- current_user is the function owner, which would record nothing useful.
alter table public.order_status_history alter column changed_by   set default public.current_actor();
alter table public.order_line_lots      alter column allocated_by set default public.current_actor();
alter table public.stock_movements      alter column created_by   set default public.current_actor();
alter table public.expenses             alter column created_by   set default public.current_actor();
alter table public.lots add column if not exists created_by text not null default public.current_actor();

-- Authorization, inside the database. Refuses anyone who is not an active
-- staff member whose role grants the permission, then marks them as the actor
-- for the rest of the transaction. Internal: not callable by any API role.
create or replace function public.app_require(p_actor uuid, p_permission text)
returns public.staff_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.staff_members;
begin
  select * into v from public.staff_members where id = p_actor and active;
  if not found then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.role_permissions
                 where role_code = v.role_code and permission_code = p_permission) then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.actor', v.email, true);
  perform set_config('app.actor_id', v.id::text, true);
  return v;
end $$;

-- For the API layer's read checks (Pass 3): may this staff member do this?
create or replace function public.staff_can(p_actor uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff_members s
    join public.role_permissions rp on rp.role_code = s.role_code
    where s.id = p_actor and s.active and rp.permission_code = p_permission);
$$;

-- The first owner. Run once from the Supabase SQL editor after inviting the
-- owner through Supabase Auth. Refuses if an active owner already exists, and
-- is not callable through the API, so a server key cannot mint an owner.
create or replace function public.bootstrap_owner(p_email text, p_auth_user_id uuid, p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.staff_members where role_code = 'owner' and active) then
    raise exception 'an active owner already exists' using errcode = 'check_violation';
  end if;
  insert into public.staff_members (auth_user_id, email, display_name, role_code)
  values (p_auth_user_id, lower(btrim(p_email)), p_display_name, 'owner')
  returning id into v_id;
  insert into public.admin_audit_log (actor_id, actor_email, action, entity_type, entity_id, details)
  values (v_id, lower(btrim(p_email)), 'staff.bootstrap_owner', 'staff_member', v_id::text,
          jsonb_build_object('by', session_user::text));
  return v_id;
end $$;

-- ======================================================================
-- 2. Audit log
-- ======================================================================
--
-- One row per console action: who, when, what, to which record, and the
-- before and after where a record changed. Append-only, written only by the
-- console functions in this migration.

create table if not exists public.admin_audit_log (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  actor_id     uuid        not null references public.staff_members(id) on delete restrict,
  actor_email  text        not null,
  action       text        not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type  text        not null,
  entity_id    text,
  details      jsonb       not null default '{}'::jsonb
);
create index if not exists admin_audit_log_time_idx   on public.admin_audit_log (occurred_at desc);
create index if not exists admin_audit_log_entity_idx on public.admin_audit_log (entity_type, entity_id);

create or replace function public.audit_event(
  p_staff public.staff_members, p_action text, p_entity_type text, p_entity_id text, p_details jsonb default '{}'::jsonb)
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.admin_audit_log (actor_id, actor_email, action, entity_type, entity_id, details)
  values (p_staff.id, p_staff.email, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb))
  returning id;
$$;

-- Append-only: neither the audit log nor the status history can be edited or
-- deleted, by anyone, including the table owner.
create or replace function public.append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end $$;

drop trigger if exists admin_audit_log_append_only on public.admin_audit_log;
create trigger admin_audit_log_append_only
  before update or delete on public.admin_audit_log
  for each row execute function public.append_only();

drop trigger if exists order_status_history_append_only on public.order_status_history;
create trigger order_status_history_append_only
  before update or delete on public.order_status_history
  for each row execute function public.append_only();

-- ======================================================================
-- 3. Orders: status, notes, shipping
-- ======================================================================

-- History rows are written by trigger. With the service role no longer able
-- to write history directly, the trigger runs with the owner's rights, and
-- records the console actor when there is one.
create or replace function public.orders_log_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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
  values (new.id, v_from, new.status, public.current_actor(),
          nullif(current_setting('app.status_note', true), ''));
  return null;
end $$;

-- Stock released by a cancellation is written to protected tables, so this
-- trigger also runs with the owner's rights.
create or replace function public.orders_release_allocations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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

create table if not exists public.order_notes (
  id           bigint generated always as identity primary key,
  order_id     uuid        not null references public.orders(id) on delete restrict,
  body         text        not null check (length(btrim(body)) between 1 and 4000),
  author_id    uuid        not null references public.staff_members(id) on delete restrict,
  author_email text        not null,
  created_at   timestamptz not null default now()
);
create index if not exists order_notes_order_idx on public.order_notes (order_id, created_at);

drop trigger if exists order_notes_append_only on public.order_notes;
create trigger order_notes_append_only
  before update or delete on public.order_notes
  for each row execute function public.append_only();

create index if not exists orders_name_lower_idx on public.orders (lower(name) text_pattern_ops);
create index if not exists orders_email_lower_pattern_idx on public.orders (lower(email) text_pattern_ops);

create or replace function public.admin_set_order_status(
  p_actor uuid, p_order_id uuid, p_status text, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_from  text;
  v_row   public.orders;
begin
  v_staff := public.app_require(p_actor, 'orders.write');
  if p_status = 'shipped' then
    raise exception 'use ship_order() to ship, so carrier and tracking are recorded with it'
      using errcode = 'check_violation';
  end if;
  select status into v_from from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if p_status = 'paid' and v_from <> 'paid' then
    raise exception 'order %: status cannot move from % to paid', p_order_id, v_from using errcode = 'check_violation';
  end if;
  perform set_config('app.status_note', coalesce(p_note, ''), true);
  update public.orders set status = p_status where id = p_order_id returning * into v_row;
  perform set_config('app.status_note', '', true);
  perform public.audit_event(v_staff, 'order.set_status', 'order', p_order_id::text,
    jsonb_build_object('from', v_from, 'to', p_status, 'note', p_note));
  return v_row;
end $$;

create or replace function public.admin_add_order_note(p_actor uuid, p_order_id uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_id    bigint;
begin
  v_staff := public.app_require(p_actor, 'orders.write');
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  insert into public.order_notes (order_id, body, author_id, author_email)
  values (p_order_id, btrim(p_body), v_staff.id, v_staff.email)
  returning id into v_id;
  perform public.audit_event(v_staff, 'order.add_note', 'order', p_order_id::text,
    jsonb_build_object('note_id', v_id));
  return v_id;
end $$;

-- Ships an order: carrier, tracking number and the shipped status in one
-- transaction, so there is never a shipped order without its tracking or a
-- tracking number on an order that did not ship. The carrier is free text,
-- not tied to any one carrier; tracking links are built from it later.
-- A line that names its product must be fully drawn from lots first; a line
-- recorded with only a description (see section 6) does not block shipping,
-- and is listed in the audit entry instead.
create or replace function public.ship_order(
  p_actor uuid, p_order_id uuid, p_carrier text, p_tracking_number text, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff     public.staff_members;
  v_status    text;
  v_carrier   text := btrim(coalesce(p_carrier, ''));
  v_tracking  text := btrim(coalesce(p_tracking_number, ''));
  v_short     jsonb;
  v_unmapped  integer;
  v_row       public.orders;
begin
  v_staff := public.app_require(p_actor, 'orders.write');
  if length(v_carrier) not between 1 and 60 then
    raise exception 'carrier is required (at most 60 characters)' using errcode = 'check_violation';
  end if;
  if length(v_tracking) not between 1 and 100 or v_tracking !~ '^[A-Za-z0-9][A-Za-z0-9 -]*$' then
    raise exception 'tracking number is required: letters, digits, spaces and hyphens, at most 100 characters'
      using errcode = 'check_violation';
  end if;
  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_status <> 'packed' then
    raise exception 'order % is %; only a packed order can be shipped', p_order_id, v_status
      using errcode = 'check_violation';
  end if;

  select jsonb_agg(jsonb_build_object('product_id', l.sku, 'pack_size', l.pack_size,
                                      'ordered', l.ordered, 'allocated', coalesce(a.allocated, 0)))
    into v_short
  from (select sku, pack_size, sum(quantity)::integer as ordered from public.order_items
        where order_id = p_order_id and kind = 'product' and sku is not null group by 1, 2) l
  left join (select product_id, pack_size, sum(quantity)::integer as allocated from public.order_line_lots
             where order_id = p_order_id and released_at is null group by 1, 2) a
    on a.product_id = l.sku and a.pack_size = l.pack_size
  where coalesce(a.allocated, 0) < l.ordered;
  if v_short is not null then
    raise exception 'order % has lines not yet drawn from a lot: %', p_order_id, v_short
      using errcode = 'check_violation';
  end if;
  select count(*) into v_unmapped from public.order_items
   where order_id = p_order_id and kind = 'product' and sku is null;

  perform set_config('app.status_note', coalesce(p_note, ''), true);
  update public.orders
     set carrier = v_carrier, tracking_number = v_tracking, status = 'shipped'
   where id = p_order_id
   returning * into v_row;
  perform set_config('app.status_note', '', true);
  perform public.audit_event(v_staff, 'order.ship', 'order', p_order_id::text,
    jsonb_build_object('carrier', v_carrier, 'tracking_number', v_tracking,
                       'lines_without_product', v_unmapped, 'note', p_note));
  return v_row;
end $$;

-- ======================================================================
-- 4. Inventory: stock items, lots, movements, allocation
-- ======================================================================

-- Brings the stock item list in line with the catalogue. The server passes
-- the catalogue's product and pack-size pairs (it reads them from the build's
-- catalog.json); the database adds the missing ones and marks ones no longer
-- in the catalogue inactive. Nothing is deleted: an inactive item keeps its
-- lots and history.
create or replace function public.sync_inventory_items(p_actor uuid, p_items jsonb)
returns table (added integer, reactivated integer, deactivated integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  n_add integer; n_re integer; n_de integer;
begin
  v_staff := public.app_require(p_actor, 'inventory.write');
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array of {product_id, pack_size}' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where jsonb_typeof(e) <> 'object'
                or coalesce(btrim(e->>'product_id'), '') = '' or coalesce(btrim(e->>'pack_size'), '') = '') then
    raise exception 'every item needs product_id and pack_size' using errcode = 'check_violation';
  end if;

  create temporary table if not exists _catalog (product_id text, pack_size text) on commit drop;
  delete from _catalog;
  insert into _catalog select distinct btrim(e->>'product_id'), btrim(e->>'pack_size') from jsonb_array_elements(p_items) e;

  with ins as (
    insert into public.inventory_items (product_id, pack_size)
    select c.product_id, c.pack_size from _catalog c
    on conflict (product_id, pack_size) do nothing
    returning 1)
  select count(*) into n_add from ins;

  with re as (
    update public.inventory_items i set active = true
    from _catalog c where c.product_id = i.product_id and c.pack_size = i.pack_size and not i.active
    returning 1)
  select count(*) into n_re from re;

  with de as (
    update public.inventory_items i set active = false
    where i.active and not exists (select 1 from _catalog c where c.product_id = i.product_id and c.pack_size = i.pack_size)
    returning 1)
  select count(*) into n_de from de;

  perform public.audit_event(v_staff, 'inventory.sync_items', 'inventory_items', null,
    jsonb_build_object('catalogue_items', (select count(*) from _catalog), 'added', n_add,
                       'reactivated', n_re, 'deactivated', n_de));
  return query select n_add, n_re, n_de;
end $$;

create or replace function public.admin_update_inventory_item(
  p_actor uuid, p_product_id text, p_pack_size text, p_changes jsonb)
returns public.inventory_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff  public.staff_members;
  v_before public.inventory_items;
  v_after  public.inventory_items;
  v_bad    text;
begin
  v_staff := public.app_require(p_actor, 'inventory.write');
  select k into v_bad from jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) k
   where k not in ('low_stock_threshold', 'active', 'notes') limit 1;
  if v_bad is not null then
    raise exception 'cannot change % on a stock item', v_bad using errcode = 'check_violation';
  end if;
  select * into v_before from public.inventory_items where product_id = p_product_id and pack_size = p_pack_size for update;
  if not found then
    raise exception 'stock item % % not found', p_product_id, p_pack_size using errcode = 'no_data_found';
  end if;
  update public.inventory_items set
    low_stock_threshold = case when p_changes ? 'low_stock_threshold' then (p_changes->>'low_stock_threshold')::integer else low_stock_threshold end,
    active              = case when p_changes ? 'active' then (p_changes->>'active')::boolean else active end,
    notes               = case when p_changes ? 'notes' then p_changes->>'notes' else notes end
  where product_id = p_product_id and pack_size = p_pack_size
  returning * into v_after;
  perform public.audit_event(v_staff, 'inventory.update_item', 'inventory_item', p_product_id || '|' || p_pack_size,
    jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after)));
  return v_after;
end $$;

-- Receives a delivery as a lot. The lot number and COA reference are whatever
-- the supplier and the analytical programme actually issued; nothing here
-- invents either.
create or replace function public.receive_lot(
  p_actor uuid, p_product_id text, p_pack_size text, p_lot_number text, p_quantity integer,
  p_received_on date default current_date, p_retest_date date default null, p_coa_reference text default null,
  p_unit_cost_cents integer default null, p_currency text default 'USD', p_supplier text default null,
  p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_id    uuid;
begin
  v_staff := public.app_require(p_actor, 'inventory.write');
  if not exists (select 1 from public.inventory_items
                 where product_id = p_product_id and pack_size = p_pack_size and active) then
    raise exception 'no active stock item % %; sync stock items from the catalogue first', p_product_id, p_pack_size
      using errcode = 'no_data_found';
  end if;
  if p_retest_date is not null and p_retest_date < p_received_on then
    raise exception 'retest date is before the date received' using errcode = 'check_violation';
  end if;
  insert into public.lots (product_id, pack_size, lot_number, quantity_received, received_on, retest_date,
                           coa_reference, unit_cost_cents, currency, supplier, notes)
  values (p_product_id, p_pack_size, btrim(p_lot_number), p_quantity, p_received_on, p_retest_date,
          nullif(btrim(p_coa_reference), ''), p_unit_cost_cents, upper(coalesce(p_currency, 'USD')),
          nullif(btrim(p_supplier), ''), p_notes)
  returning id into v_id;
  perform public.audit_event(v_staff, 'inventory.receive_lot', 'lot', v_id::text,
    jsonb_build_object('product_id', p_product_id, 'pack_size', p_pack_size, 'lot_number', btrim(p_lot_number),
                       'quantity', p_quantity, 'unit_cost_cents', p_unit_cost_cents));
  return v_id;
end $$;

-- Edits what can change about a lot after receipt: dates, COA reference,
-- cost, supplier, notes. Product, pack size and quantity stay frozen (0003).
create or replace function public.admin_update_lot(p_actor uuid, p_lot_id uuid, p_changes jsonb)
returns public.lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff  public.staff_members;
  v_before public.lots;
  v_after  public.lots;
  v_bad    text;
begin
  v_staff := public.app_require(p_actor, 'inventory.write');
  select k into v_bad from jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) k
   where k not in ('received_on', 'retest_date', 'coa_reference', 'unit_cost_cents', 'currency', 'supplier', 'notes') limit 1;
  if v_bad is not null then
    raise exception 'cannot change % on a lot; record an adjustment for quantity', v_bad using errcode = 'check_violation';
  end if;
  select * into v_before from public.lots where id = p_lot_id for update;
  if not found then
    raise exception 'lot % not found', p_lot_id using errcode = 'no_data_found';
  end if;
  update public.lots set
    received_on     = case when p_changes ? 'received_on'     then (p_changes->>'received_on')::date     else received_on end,
    retest_date     = case when p_changes ? 'retest_date'     then (p_changes->>'retest_date')::date     else retest_date end,
    coa_reference   = case when p_changes ? 'coa_reference'   then nullif(btrim(p_changes->>'coa_reference'), '') else coa_reference end,
    unit_cost_cents = case when p_changes ? 'unit_cost_cents' then (p_changes->>'unit_cost_cents')::integer else unit_cost_cents end,
    currency        = case when p_changes ? 'currency'        then upper(p_changes->>'currency')         else currency end,
    supplier        = case when p_changes ? 'supplier'        then nullif(btrim(p_changes->>'supplier'), '') else supplier end,
    notes           = case when p_changes ? 'notes'           then p_changes->>'notes'                   else notes end
  where id = p_lot_id
  returning * into v_after;
  perform public.audit_event(v_staff, 'inventory.update_lot', 'lot', p_lot_id::text,
    jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after)));
  return v_after;
end $$;

create or replace function public.admin_record_stock_movement(
  p_actor uuid, p_lot_id uuid, p_delta integer, p_reason text, p_note text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_id    bigint;
begin
  v_staff := public.app_require(p_actor, 'inventory.write');
  v_id := public.record_stock_movement(p_lot_id, p_delta, p_reason, p_note);
  perform public.audit_event(v_staff, 'inventory.record_movement', 'lot', p_lot_id::text,
    jsonb_build_object('movement_id', v_id, 'delta', p_delta, 'reason', p_reason, 'note', p_note));
  return v_id;
end $$;

create or replace function public.admin_allocate_order_line(
  p_actor uuid, p_order_id uuid, p_product_id text, p_pack_size text, p_lot_id uuid, p_quantity integer)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_id    bigint;
begin
  v_staff := public.app_require(p_actor, 'fulfilment.write');
  v_id := public.allocate_order_line(p_order_id, p_product_id, p_pack_size, p_lot_id, p_quantity);
  perform public.audit_event(v_staff, 'fulfilment.allocate', 'order', p_order_id::text,
    jsonb_build_object('allocation_id', v_id, 'product_id', p_product_id, 'pack_size', p_pack_size,
                       'lot_id', p_lot_id, 'quantity', p_quantity));
  return v_id;
end $$;

create or replace function public.admin_release_allocation(p_actor uuid, p_allocation_id bigint, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff  public.staff_members;
  v_order  uuid;
  v_status text;
  v_ok     boolean;
begin
  v_staff := public.app_require(p_actor, 'fulfilment.write');
  select a.order_id, o.status into v_order, v_status
    from public.order_line_lots a join public.orders o on o.id = a.order_id
   where a.id = p_allocation_id;
  if not found then
    raise exception 'allocation % not found', p_allocation_id using errcode = 'no_data_found';
  end if;
  if v_status not in ('paid', 'processing', 'packed') then
    raise exception 'order % is %; an allocation can only be released before it ships', v_order, v_status
      using errcode = 'check_violation';
  end if;
  v_ok := public.release_allocation(p_allocation_id, coalesce(p_note, 'released by ' || v_staff.email));
  if v_ok then
    perform public.audit_event(v_staff, 'fulfilment.release', 'order', v_order::text,
      jsonb_build_object('allocation_id', p_allocation_id, 'note', p_note));
  end if;
  return v_ok;
end $$;

-- ======================================================================
-- 5. Expenses: create, edit, delete (reversibly), import
-- ======================================================================

alter table public.expenses
  add column if not exists updated_at    timestamptz,
  add column if not exists updated_by    text,
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    text,
  add column if not exists delete_reason text;

-- A deleted expense stays in the table, out of every report, and can be
-- restored.
create or replace view public.monthly_expenses
  with (security_invoker = true) as
  select date_trunc('month', e.incurred_on)::date as month, e.currency,
         e.category_code, c.name as category, c.treatment,
         count(*)                   as entries,
         sum(e.amount_cents)::bigint as amount_cents
  from public.expenses e
  join public.expense_categories c on c.code = e.category_code
  where e.deleted_at is null
  group by 1, 2, 3, 4, 5;

create or replace function public.admin_create_expense(
  p_actor uuid, p_incurred_on date, p_category_code text, p_description text, p_amount_cents integer,
  p_currency text default 'USD', p_vendor text default null, p_reference text default null,
  p_lot_id uuid default null, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_id    uuid;
begin
  v_staff := public.app_require(p_actor, 'finance.write');
  if not exists (select 1 from public.expense_categories where code = p_category_code and active) then
    raise exception 'unknown or inactive category "%"', p_category_code using errcode = 'check_violation';
  end if;
  insert into public.expenses (incurred_on, category_code, description, amount_cents, currency,
                               vendor, reference, lot_id, notes)
  values (p_incurred_on, p_category_code, btrim(p_description), p_amount_cents, upper(coalesce(p_currency, 'USD')),
          nullif(btrim(p_vendor), ''), nullif(btrim(p_reference), ''), p_lot_id, p_notes)
  returning id into v_id;
  perform public.audit_event(v_staff, 'finance.create_expense', 'expense', v_id::text,
    jsonb_build_object('after', (select to_jsonb(e) from public.expenses e where id = v_id)));
  return v_id;
end $$;

create or replace function public.admin_update_expense(p_actor uuid, p_expense_id uuid, p_changes jsonb)
returns public.expenses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff  public.staff_members;
  v_before public.expenses;
  v_after  public.expenses;
  v_bad    text;
begin
  v_staff := public.app_require(p_actor, 'finance.write');
  select k into v_bad from jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) k
   where k not in ('incurred_on', 'category_code', 'description', 'amount_cents', 'currency',
                   'vendor', 'reference', 'lot_id', 'notes') limit 1;
  if v_bad is not null then
    raise exception 'cannot change % on an expense', v_bad using errcode = 'check_violation';
  end if;
  select * into v_before from public.expenses where id = p_expense_id for update;
  if not found or v_before.deleted_at is not null then
    raise exception 'expense % not found', p_expense_id using errcode = 'no_data_found';
  end if;
  if p_changes ? 'category_code'
     and not exists (select 1 from public.expense_categories where code = p_changes->>'category_code' and active) then
    raise exception 'unknown or inactive category "%"', p_changes->>'category_code' using errcode = 'check_violation';
  end if;
  update public.expenses set
    incurred_on   = case when p_changes ? 'incurred_on'   then (p_changes->>'incurred_on')::date    else incurred_on end,
    category_code = case when p_changes ? 'category_code' then p_changes->>'category_code'          else category_code end,
    description   = case when p_changes ? 'description'   then btrim(p_changes->>'description')     else description end,
    amount_cents  = case when p_changes ? 'amount_cents'  then (p_changes->>'amount_cents')::integer else amount_cents end,
    currency      = case when p_changes ? 'currency'      then upper(p_changes->>'currency')        else currency end,
    vendor        = case when p_changes ? 'vendor'        then nullif(btrim(p_changes->>'vendor'), '')    else vendor end,
    reference     = case when p_changes ? 'reference'     then nullif(btrim(p_changes->>'reference'), '') else reference end,
    lot_id        = case when p_changes ? 'lot_id'        then (p_changes->>'lot_id')::uuid         else lot_id end,
    notes         = case when p_changes ? 'notes'         then p_changes->>'notes'                  else notes end,
    updated_at    = now(),
    updated_by    = v_staff.email
  where id = p_expense_id
  returning * into v_after;
  perform public.audit_event(v_staff, 'finance.update_expense', 'expense', p_expense_id::text,
    jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after)));
  return v_after;
end $$;

create or replace function public.admin_delete_expense(p_actor uuid, p_expense_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.app_require(p_actor, 'finance.write');
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'deleting an expense needs a reason' using errcode = 'check_violation';
  end if;
  update public.expenses set deleted_at = now(), deleted_by = v_staff.email, delete_reason = btrim(p_reason)
   where id = p_expense_id and deleted_at is null;
  if not found then
    raise exception 'expense % not found', p_expense_id using errcode = 'no_data_found';
  end if;
  perform public.audit_event(v_staff, 'finance.delete_expense', 'expense', p_expense_id::text,
    jsonb_build_object('reason', btrim(p_reason)));
  return true;
end $$;

create or replace function public.admin_restore_expense(p_actor uuid, p_expense_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
begin
  v_staff := public.app_require(p_actor, 'finance.write');
  update public.expenses set deleted_at = null, deleted_by = null, delete_reason = null,
                             updated_at = now(), updated_by = v_staff.email
   where id = p_expense_id and deleted_at is not null;
  if not found then
    raise exception 'no deleted expense %', p_expense_id using errcode = 'no_data_found';
  end if;
  perform public.audit_event(v_staff, 'finance.restore_expense', 'expense', p_expense_id::text, '{}'::jsonb);
  return true;
end $$;

-- CSV import, in two steps: the server parses the uploaded file into rows and
-- stages them; import_expenses() (0003) validates and books them.
create or replace function public.admin_stage_expense_import(p_actor uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_n     integer;
begin
  v_staff := public.app_require(p_actor, 'finance.write');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'rows must be an array of 1 to 5000 objects' using errcode = 'check_violation';
  end if;
  insert into public.expense_import (incurred_on, category, description, amount, currency, vendor, reference, notes)
  select r->>'incurred_on', r->>'category', r->>'description', r->>'amount',
         r->>'currency', r->>'vendor', r->>'reference', r->>'notes'
  from jsonb_array_elements(p_rows) r
  where jsonb_typeof(r) = 'object';
  get diagnostics v_n = row_count;
  perform public.audit_event(v_staff, 'finance.stage_import', 'expense_import', null, jsonb_build_object('rows', v_n));
  return v_n;
end $$;

create or replace function public.admin_import_expenses(p_actor uuid)
returns table (imported integer, duplicates integer, errors integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  r record;
begin
  v_staff := public.app_require(p_actor, 'finance.write');
  select * into r from public.import_expenses();
  perform public.audit_event(v_staff, 'finance.import_expenses', 'expense_import', null,
    jsonb_build_object('imported', r.imported, 'duplicates', r.duplicates, 'errors', r.errors));
  return query select r.imported, r.duplicates, r.errors;
end $$;

-- ======================================================================
-- 6. Mapping description-only order lines to products
-- ======================================================================
--
-- The current payment integration records product lines with a description
-- and no product code, so they cannot be drawn from lots or costed. This lets
-- the owner say, explicitly, which product and pack size a line is. It never
-- touches payment code: it only fills order_items.sku and pack_size where they
-- are empty. Every mapping is a row (who, when, why), audited, and reversible.
--
-- The payment integration rewrites an order's items when a confirmation is
-- redelivered. A mapping is therefore matched by order, description and
-- quantity, and re-applied automatically to a rewritten line.

create table if not exists public.order_line_mappings (
  id                bigint generated always as identity primary key,
  order_id          uuid        not null references public.orders(id) on delete restrict,
  match_description text        not null,
  match_quantity    integer     not null check (match_quantity > 0),
  product_id        text        not null,
  pack_size         text        not null,
  note              text,
  mapped_by         text        not null,
  mapped_at         timestamptz not null default now(),
  reverted_at       timestamptz,
  reverted_by       text,
  revert_note       text,
  foreign key (product_id, pack_size) references public.inventory_items (product_id, pack_size)
);
create unique index if not exists order_line_mappings_live
  on public.order_line_mappings (order_id, match_description, match_quantity) where reverted_at is null;

create or replace function public.admin_map_order_line(
  p_actor uuid, p_order_item_id bigint, p_product_id text, p_pack_size text, p_note text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_item  public.order_items;
  v_id    bigint;
  v_n     integer;
begin
  v_staff := public.app_require(p_actor, 'fulfilment.write');
  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'mapping a line needs a note saying how you know' using errcode = 'check_violation';
  end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then
    raise exception 'order line % not found', p_order_item_id using errcode = 'no_data_found';
  end if;
  if v_item.kind <> 'product' or v_item.sku is not null then
    raise exception 'order line % already names its product', p_order_item_id using errcode = 'check_violation';
  end if;
  if v_item.description is null or length(btrim(v_item.description)) = 0 then
    raise exception 'order line % has no description to match' , p_order_item_id using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.inventory_items where product_id = p_product_id and pack_size = p_pack_size) then
    raise exception 'no stock item % %', p_product_id, p_pack_size using errcode = 'no_data_found';
  end if;

  insert into public.order_line_mappings (order_id, match_description, match_quantity, product_id, pack_size, note, mapped_by)
  values (v_item.order_id, v_item.description, v_item.quantity, p_product_id, p_pack_size, btrim(p_note), v_staff.email)
  returning id into v_id;

  update public.order_items set sku = p_product_id, pack_size = p_pack_size
   where order_id = v_item.order_id and kind = 'product' and sku is null
     and description = v_item.description and quantity = v_item.quantity;
  get diagnostics v_n = row_count;

  perform public.audit_event(v_staff, 'fulfilment.map_line', 'order', v_item.order_id::text,
    jsonb_build_object('mapping_id', v_id, 'order_item_id', p_order_item_id, 'description', v_item.description,
                       'quantity', v_item.quantity, 'product_id', p_product_id, 'pack_size', p_pack_size,
                       'lines_updated', v_n, 'note', btrim(p_note)));
  return v_id;
end $$;

create or replace function public.admin_unmap_order_line(p_actor uuid, p_mapping_id bigint, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff_members;
  v_m     public.order_line_mappings;
  v_n     integer;
begin
  v_staff := public.app_require(p_actor, 'fulfilment.write');
  select * into v_m from public.order_line_mappings where id = p_mapping_id and reverted_at is null for update;
  if not found then
    raise exception 'no live mapping %', p_mapping_id using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.order_line_lots
             where order_id = v_m.order_id and product_id = v_m.product_id and pack_size = v_m.pack_size
               and released_at is null) then
    raise exception 'release the stock allocated to this line before undoing its mapping' using errcode = 'check_violation';
  end if;
  update public.order_items set sku = null, pack_size = null
   where order_id = v_m.order_id and kind = 'product' and sku = v_m.product_id and pack_size = v_m.pack_size
     and description = v_m.match_description and quantity = v_m.match_quantity;
  get diagnostics v_n = row_count;
  update public.order_line_mappings
     set reverted_at = now(), reverted_by = v_staff.email, revert_note = nullif(btrim(p_note), '')
   where id = p_mapping_id;
  perform public.audit_event(v_staff, 'fulfilment.unmap_line', 'order', v_m.order_id::text,
    jsonb_build_object('mapping_id', p_mapping_id, 'lines_updated', v_n, 'note', p_note));
  return true;
end $$;

-- A rewritten line picks its live mapping back up.
create or replace function public.order_items_apply_mapping()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m public.order_line_mappings;
begin
  if new.kind = 'product' and new.sku is null and new.description is not null then
    select * into v_m from public.order_line_mappings
     where order_id = new.order_id and match_description = new.description
       and match_quantity = new.quantity and reverted_at is null;
    if found then
      new.sku := v_m.product_id;
      new.pack_size := v_m.pack_size;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists order_items_apply_mapping on public.order_items;
create trigger order_items_apply_mapping
  before insert on public.order_items
  for each row execute function public.order_items_apply_mapping();

-- ======================================================================
-- 7. Console views: order queue and dashboard
-- ======================================================================
--
-- "Needs attention" thresholds are fixed here for now (24 hours paid or
-- packed, 48 hours processing, 14 days in transit) and can become settings
-- later.

create or replace view public.order_queue
  with (security_invoker = true) as
  with lines as (
    select order_id,
           count(*) filter (where kind = 'product')                                  as product_lines,
           coalesce(sum(quantity) filter (where kind = 'product'), 0)::integer       as product_units,
           count(*) filter (where kind = 'product' and sku is null)                  as unmapped_lines,
           coalesce(sum(quantity) filter (where kind = 'product' and sku is not null), 0)::integer as mapped_units,
           count(*) filter (where kind = 'addon')                                    as addon_lines
    from public.order_items group by order_id
  ),
  alloc as (
    select order_id, sum(quantity)::integer as allocated_units
    from public.order_line_lots where released_at is null group by order_id
  ),
  notes as (
    select order_id, count(*) as note_count, max(created_at) as last_note_at
    from public.order_notes group by order_id
  ),
  base as (
    select o.id as order_id, o.created_at, o.status, coalesce(o.status_changed_at, o.created_at) as in_status_since,
           o.name, o.email, o.stripe_session_id as reference, o.currency, o.amount_total,
           o.carrier, o.tracking_number, o.shipped_at, o.delivered_at,
           coalesce(l.product_lines, 0) as product_lines, coalesce(l.product_units, 0) as product_units,
           coalesce(l.unmapped_lines, 0) as unmapped_lines, coalesce(l.addon_lines, 0) as addon_lines,
           greatest(coalesce(l.mapped_units, 0) - coalesce(a.allocated_units, 0), 0) as unallocated_units,
           coalesce(n.note_count, 0) as note_count, n.last_note_at
    from public.orders o
    left join lines l on l.order_id = o.id
    left join alloc a on a.order_id = o.id
    left join notes n on n.order_id = o.id
  )
  select b.*,
         case
           when b.status in ('paid', 'processing', 'packed') and b.unmapped_lines > 0 then 'line needs product mapping'
           when b.status = 'packed' and b.unallocated_units > 0                      then 'packed with stock not drawn from a lot'
           when b.status = 'paid'       and b.in_status_since < now() - interval '24 hours' then 'paid over 24 hours, not started'
           when b.status = 'processing' and b.in_status_since < now() - interval '48 hours' then 'processing over 48 hours'
           when b.status = 'packed'     and b.in_status_since < now() - interval '24 hours' then 'packed over 24 hours, not shipped'
           when b.status = 'shipped'    and b.shipped_at < now() - interval '14 days'       then 'shipped 14+ days ago, not delivered'
         end as attention_reason
  from base b;

create or replace view public.dashboard_status_counts
  with (security_invoker = true) as
  select s.status, count(o.id)::integer as orders
  from (values ('paid'), ('processing'), ('packed'), ('shipped'), ('delivered'), ('completed'), ('cancelled'), ('refunded')) s(status)
  left join public.orders o on o.status = s.status
  group by s.status;

create or replace view public.dashboard_summary
  with (security_invoker = true) as
  select
    (select coalesce(sum(amount_total), 0) from public.revenue_orders where created_at >= date_trunc('day', now()))::bigint             as revenue_today_cents,
    (select coalesce(sum(amount_total), 0) from public.revenue_orders where created_at >= now() - interval '7 days')::bigint            as revenue_7d_cents,
    (select coalesce(sum(amount_total), 0) from public.revenue_orders where created_at >= now() - interval '30 days')::bigint           as revenue_30d_cents,
    (select count(*) from public.revenue_orders where created_at >= date_trunc('day', now()))::integer                                  as orders_today,
    (select count(*) from public.revenue_orders where created_at >= now() - interval '7 days')::integer                                 as orders_7d,
    (select round(avg(amount_total)) from public.revenue_orders where created_at >= now() - interval '30 days')::bigint                 as average_order_30d_cents,
    (select count(*) from public.order_queue where attention_reason is not null)::integer                                               as orders_needing_attention,
    (select count(*) from public.low_stock)::integer                                                                                    as low_stock_items,
    (select count(*) from public.lot_levels where retest_due_30d and on_hand > 0)::integer                                              as lots_retest_due_30d,
    (select count(*) from public.lot_levels where retest_overdue and on_hand > 0)::integer                                              as lots_retest_overdue,
    (select count(distinct currency) from public.revenue_orders)::integer                                                               as currencies,
    false                                                                                                                               as fees_and_tax_separated;

-- ======================================================================
-- 8. Access
-- ======================================================================
--
-- Browser roles: nothing, as before. Service role: may read everything (the
-- server needs to), may still write orders and order_items (the payment
-- path), and may otherwise change console data only through the admin_*
-- functions, ship_order, sync_inventory_items and receive_lot. The 0003
-- helpers that take a free-text actor are no longer callable through the API.

alter table public.permissions         enable row level security;
alter table public.staff_roles         enable row level security;
alter table public.role_permissions    enable row level security;
alter table public.staff_members       enable row level security;
alter table public.admin_audit_log     enable row level security;
alter table public.order_notes         enable row level security;
alter table public.order_line_mappings enable row level security;

revoke all on
  public.permissions, public.staff_roles, public.role_permissions, public.staff_members,
  public.admin_audit_log, public.order_notes, public.order_line_mappings
  from public, anon, authenticated;

revoke insert, update, delete, truncate on
  public.permissions, public.staff_roles, public.role_permissions, public.staff_members,
  public.admin_audit_log, public.order_notes, public.order_line_mappings,
  public.order_status_history, public.order_status_transitions,
  public.inventory_items, public.lots, public.order_line_lots, public.stock_movements,
  public.expense_categories, public.expenses, public.expense_import
  from service_role;

revoke all on
  public.order_queue, public.dashboard_status_counts, public.dashboard_summary, public.monthly_expenses
  from public, anon, authenticated;

-- Internal and legacy helpers: not callable through the API at all.
revoke execute on function
  public.app_require(uuid, text),
  public.audit_event(public.staff_members, text, text, text, jsonb),
  public.bootstrap_owner(text, uuid, text),
  public.current_actor(),
  public.append_only(), public.staff_keep_an_owner(), public.order_items_apply_mapping(),
  public.orders_log_status(), public.orders_release_allocations(),
  public.set_order_status(uuid, text, text, text),
  public.allocate_order_line(uuid, text, text, uuid, integer),
  public.release_allocation(bigint, text),
  public.record_stock_movement(uuid, integer, text, text),
  public.import_expenses()
  from public, anon, authenticated, service_role;

-- The console's actions: the service role only.
revoke execute on function
  public.staff_can(uuid, text),
  public.admin_set_order_status(uuid, uuid, text, text),
  public.admin_add_order_note(uuid, uuid, text),
  public.ship_order(uuid, uuid, text, text, text),
  public.sync_inventory_items(uuid, jsonb),
  public.admin_update_inventory_item(uuid, text, text, jsonb),
  public.receive_lot(uuid, text, text, text, integer, date, date, text, integer, text, text, text),
  public.admin_update_lot(uuid, uuid, jsonb),
  public.admin_record_stock_movement(uuid, uuid, integer, text, text),
  public.admin_allocate_order_line(uuid, uuid, text, text, uuid, integer),
  public.admin_release_allocation(uuid, bigint, text),
  public.admin_create_expense(uuid, date, text, text, integer, text, text, text, uuid, text),
  public.admin_update_expense(uuid, uuid, jsonb),
  public.admin_delete_expense(uuid, uuid, text),
  public.admin_restore_expense(uuid, uuid),
  public.admin_stage_expense_import(uuid, jsonb),
  public.admin_import_expenses(uuid),
  public.admin_map_order_line(uuid, bigint, text, text, text),
  public.admin_unmap_order_line(uuid, bigint, text)
  from public, anon, authenticated;

grant execute on function
  public.staff_can(uuid, text),
  public.admin_set_order_status(uuid, uuid, text, text),
  public.admin_add_order_note(uuid, uuid, text),
  public.ship_order(uuid, uuid, text, text, text),
  public.sync_inventory_items(uuid, jsonb),
  public.admin_update_inventory_item(uuid, text, text, jsonb),
  public.receive_lot(uuid, text, text, text, integer, date, date, text, integer, text, text, text),
  public.admin_update_lot(uuid, uuid, jsonb),
  public.admin_record_stock_movement(uuid, uuid, integer, text, text),
  public.admin_allocate_order_line(uuid, uuid, text, text, uuid, integer),
  public.admin_release_allocation(uuid, bigint, text),
  public.admin_create_expense(uuid, date, text, text, integer, text, text, text, uuid, text),
  public.admin_update_expense(uuid, uuid, jsonb),
  public.admin_delete_expense(uuid, uuid, text),
  public.admin_restore_expense(uuid, uuid),
  public.admin_stage_expense_import(uuid, jsonb),
  public.admin_import_expenses(uuid),
  public.admin_map_order_line(uuid, bigint, text, text, text),
  public.admin_unmap_order_line(uuid, bigint, text)
  to service_role;
