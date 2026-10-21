-- Minimal stand-in for what Supabase provides, so migrations can run on plain Postgres in tests and CI.
-- Roles are cluster-wide and test files run in parallel, so another file may create them at the
-- same moment: ignore "already exists" rather than check first.
do $$
begin
  begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role authenticated nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role service_role nologin bypassrls; exception when duplicate_object or unique_violation then null; end;
end
$$;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, last_sign_in_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
