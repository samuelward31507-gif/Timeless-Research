-- Neon: access for the read-only role. Run as peptide_owner (SET ROLE
-- peptide_owner), AFTER supabase/migrations/0001-0006. Idempotent.
--
-- peptide_readonly may read every table and view, now and in future
-- migrations by peptide_owner, and nothing else. It is granted no INSERT,
-- UPDATE, DELETE or TRUNCATE anywhere and is not a member of service_role,
-- so the server's write functions are not available to it either.

grant select on all tables in schema public to peptide_readonly;

alter default privileges for role peptide_owner in schema public
  grant select on tables to peptide_readonly;
