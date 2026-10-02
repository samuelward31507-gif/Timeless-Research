/*
 * A version-independent fingerprint of the peptide schema and its privileges.
 *
 * Each query reduces one aspect of the public schema (tables, columns,
 * constraints, indexes, function bodies, triggers, ownership, and what each
 * role may do) to a row count and an md5 digest. The same queries run against
 * the local Neon-mode build (PGlite, PostgreSQL 16) and against a real Neon
 * branch (PostgreSQL 18): equal digests mean the branch holds exactly what
 * the tested migrations define.
 *
 * Only objects owned by peptide_owner are fingerprinted, so whatever a
 * platform adds on its own (extensions, console helpers) is left out.
 * PostgreSQL 18 records NOT NULL as constraints of type 'n'; those are left
 * out of the constraint digest because the column digest already covers them.
 *
 *   node tests/db/schema-snapshot.mjs     prints the digests of the local build
 */
import { fileURLToPath } from 'node:url';

const OWNED = `pg_get_userbyid(c.relowner) = 'peptide_owner'`;
const ROLES = `('peptide_owner','peptide_app','peptide_readonly','service_role','anon','authenticated')`;

export const SNAPSHOT = {
  relations: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' owner=' || pg_get_userbyid(c.relowner) as x
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')) s`,
  columns: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' nn=' || a.attnotnull ||
             ' id=' || a.attidentity::text || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as x
        from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') and ${OWNED}) s`,
  constraints: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select c.relname || ' ' || k.contype::text || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid) as x
        from pg_constraint k join pg_class c on c.oid = k.conrelid
       where k.connamespace = 'public'::regnamespace and k.contype <> 'n' and ${OWNED}) s`,
  indexes: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select i.indexname || ' ' || i.indexdef as x from pg_indexes i
        join pg_class c on c.relname = i.tablename and c.relnamespace = 'public'::regnamespace
       where i.schemaname = 'public' and ${OWNED}) s`,
  functions: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid) ||
             ' secdef=' || p.prosecdef || ' owner=' || pg_get_userbyid(p.proowner) ||
             ' config=' || coalesce(array_to_string(p.proconfig, ','), '') || ' src=' || md5(p.prosrc) as x
        from pg_proc p where p.pronamespace = 'public'::regnamespace and pg_get_userbyid(p.proowner) = 'peptide_owner') s`,
  triggers: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select pg_get_triggerdef(t.oid) as x from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and ${OWNED}) s`,
  table_privileges: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select r.rolname || ' ' || c.relname || ' ' ||
             concat_ws(',', case when has_table_privilege(r.oid, c.oid, 'SELECT') then 'select' end,
                            case when has_table_privilege(r.oid, c.oid, 'INSERT') then 'insert' end,
                            case when has_table_privilege(r.oid, c.oid, 'UPDATE') then 'update' end,
                            case when has_table_privilege(r.oid, c.oid, 'DELETE') then 'delete' end,
                            case when has_table_privilege(r.oid, c.oid, 'TRUNCATE') then 'truncate' end,
                            case when has_table_privilege(r.oid, c.oid, 'REFERENCES') then 'references' end,
                            case when has_table_privilege(r.oid, c.oid, 'TRIGGER') then 'trigger' end) as x
        from pg_roles r cross join pg_class c
       where r.rolname in ${ROLES} and c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
         and ${OWNED}) s`,
  function_privileges: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select r.rolname || ' ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as x
        from pg_roles r cross join pg_proc p
       where r.rolname in ${ROLES} and p.pronamespace = 'public'::regnamespace
         and pg_get_userbyid(p.proowner) = 'peptide_owner' and has_function_privilege(r.oid, p.oid, 'EXECUTE')) s`,
  roles: `
    select count(*) as n, md5(string_agg(x, E'\\n' order by x)) as digest from (
      select r.rolname || ' login=' || r.rolcanlogin || ' inherit=' || r.rolinherit || ' bypassrls=' || r.rolbypassrls ||
             ' super=' || r.rolsuper || ' createrole=' || r.rolcreaterole || ' createdb=' || r.rolcreatedb ||
             ' member_of=' || coalesce((select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m
                                          join pg_roles g on g.oid = m.roleid where m.member = r.oid
                                           and g.rolname in ${ROLES}), '') as x
        from pg_roles r where r.rolname in ${ROLES}) s`
};

/* Run directly: print the local Neon-mode build's digests. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { freshDb } = await import('./harness.mjs');
  const db = await freshDb({ platform: 'neon' });
  for (const [name, sql] of Object.entries(SNAPSHOT)) {
    const r = (await db.query(sql)).rows[0];
    console.log(`${name.padEnd(20)} ${String(r.n).padStart(4)}  ${r.digest}`);
  }
}
