-- The server's privileges, stated explicitly.
--
-- Apply after 0001-0005. Safe to run twice.
--
-- On Supabase, every new table, view and function is granted to the service
-- role by default, and 0001-0005 only take away what it must not have. A
-- plain PostgreSQL database (Neon) grants nothing by default, so the server
-- would be unable to read or record anything. This states the privileges the
-- server relies on, so they are the same wherever the schema is applied. On
-- Supabase it changes nothing.
--
-- Reads: everything, as before (README, Operations data, Access). The console
-- views run with the caller's rights, so reading them needs SELECT on the
-- tables beneath them too.
--
-- Writes: only the payment path's.
--   - The webhook upserts orders on stripe_session_id (INSERT ... ON CONFLICT
--     DO UPDATE ... RETURNING) and replaces an order's lines (DELETE, then
--     INSERT).
--   - record_addon_sales() and release_addon_sales() (0002), which the
--     payment integration calls to take add-ons out of stock, run with the
--     caller's rights and append to addon_stock_movements.
-- Every other change goes through the SECURITY DEFINER functions 0004 and
-- 0005 grant to the service role, which check the actor, write the audit
-- entry and run as their owner.
--
-- Not granted, by design: TRUNCATE anywhere, writes to any other table,
-- DELETE on orders, and UPDATE or DELETE on the add-on stock ledger.
--
-- Also closed here: 0002's trigger function orders_release_addons(), which
-- was left executable by everyone. A trigger fires without its caller holding
-- EXECUTE, and calling it directly can only fail, but nothing should hold a
-- privilege it does not use (0003 and 0004 revoke theirs the same way).

grant usage on schema public to service_role;

grant select on all tables in schema public to service_role;

grant insert, update on public.orders to service_role;
grant insert, delete on public.order_items to service_role;
grant insert on public.addon_stock_movements to service_role;
grant execute on function public.record_addon_sales(uuid), public.release_addon_sales(uuid) to service_role;

revoke execute on function public.orders_release_addons() from public, anon, authenticated, service_role;
