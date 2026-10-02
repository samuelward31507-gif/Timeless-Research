-- Neon: the roles the peptide database runs with. Run once, as the branch's
-- database owner (neondb_owner), BEFORE supabase/migrations/0001-0006.
-- Idempotent. Creates no tables and holds no secrets.
--
--   peptide_owner     Owns every object the migrations create, including the
--                     SECURITY DEFINER functions. NOLOGIN: migrations are run
--                     by the database owner with SET ROLE peptide_owner, and
--                     nothing at runtime ever acts as it.
--
--   peptide_app       What the Netlify Functions will log in as (N1b). Owns
--                     nothing. Its privileges come only from membership of
--                     service_role, which the migrations grant to and revoke
--                     from exactly as they do on Supabase, plus the explicit
--                     grants of 0006. No password is set here; it is given
--                     one when the application is wired to Neon.
--
--   peptide_readonly  For audits and reporting: SELECT only, read-only by
--                     default. Not used by the application.
--
-- service_role, anon and authenticated are the role names the migrations
-- were written against (Supabase's). On Neon they exist so those grants and
-- revokes mean the same thing:
--
--   service_role      NOLOGIN group. Carries the server's privileges; nobody
--                     logs in as it. peptide_app is its only member.
--   anon,             NOLOGIN, no privileges. The migrations revoke from them;
--   authenticated     nothing grants to them.
--
-- Row level security: every table has it on with no policies, so a role that
-- does not bypass it sees no rows. Supabase's service role bypasses it; so do
-- peptide_app and peptide_readonly here, deliberately. What they may touch is
-- decided by grants, which is how the migrations were designed.

do $$
begin
  if not exists (select from pg_roles where rolname = 'peptide_owner') then
    create role peptide_owner nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'peptide_app') then
    create role peptide_app login inherit bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'peptide_readonly') then
    create role peptide_readonly login noinherit bypassrls;
  end if;
end $$;

-- The owner creates objects in public; nobody else may. It also needs
-- temporary tables: sync_inventory_items() (0004) runs as its owner and
-- stages the catalogue in one. Granted explicitly rather than relying on the
-- database's PUBLIC default.
grant usage, create on schema public to peptide_owner;
do $$ begin
  execute format('grant temporary on database %I to peptide_owner', current_database());
end $$;
grant usage on schema public to service_role, peptide_readonly;

-- peptide_app's privileges are service_role's.
grant service_role to peptide_app;

-- Read-only by default as well as by grant.
alter role peptide_readonly set default_transaction_read_only = on;

-- The operator running migrations and checks may act as these roles, but
-- does not inherit their privileges.
grant peptide_owner to current_user with set true, inherit false;
grant peptide_app to current_user with set true, inherit false;
grant peptide_readonly to current_user with set true, inherit false;
