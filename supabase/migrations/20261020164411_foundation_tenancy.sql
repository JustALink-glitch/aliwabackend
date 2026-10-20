-- Synqop foundation: organisations, members, roles and the tenant wall.
-- Reference: Development Reference V1 §03 (roles), §05 (organisation, one email = one organisation).
--
-- Access model
--   * The API uses the secret key (bypasses RLS) and scopes every query to the caller's organisation.
--   * RLS is the second wall: any client using a user's token can only ever see its own organisation.
--   * No write policies are granted to clients. All writes go through the API.

-- ─────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Types
-- ─────────────────────────────────────────────────────────────
create type public.member_role as enum ('owner', 'admin', 'trainer', 'assistant_trainer', 'participant');
create type public.member_status as enum ('invited', 'active', 'deactivated');
create type public.organisation_status as enum ('active', 'pending_deletion');

-- ─────────────────────────────────────────────────────────────
-- Organisations
-- ─────────────────────────────────────────────────────────────
create table public.organisations (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(trim(name)) between 1 and 120),
  time_zone              text not null default 'Africa/Lagos',
  status                 public.organisation_status not null default 'active',
  -- Set when an owner schedules deletion (F1.11); 30-day read-only grace period.
  deletion_scheduled_for timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint deletion_date_matches_status
    check ((status = 'pending_deletion') = (deletion_scheduled_for is not null))
);

create trigger organisations_updated_at
  before update on public.organisations
  for each row execute function private.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- Members: every person in an organisation, staff or participant
-- ─────────────────────────────────────────────────────────────
create table public.organisation_members (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  -- Null until an invited person sets their password and an auth account exists.
  user_id         uuid unique references auth.users (id) on delete set null,
  email           text not null check (email = lower(trim(email)) and email like '%_@_%'),
  first_name      text not null check (length(trim(first_name)) between 1 and 80),
  last_name       text not null check (length(trim(last_name)) between 1 and 80),
  phone           text,
  role            public.member_role not null,
  status          public.member_status not null default 'invited',
  invited_by      uuid references public.organisation_members (id) on delete set null,
  invited_at      timestamptz,
  joined_at       timestamptz,
  deactivated_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint active_member_has_account check (status <> 'active' or user_id is not null),
  constraint deactivated_has_date check ((status = 'deactivated') = (deactivated_at is not null))
);

-- One email belongs to one organisation (§03). Emails are stored lower-cased.
create unique index organisation_members_email_key on public.organisation_members (email);
create index organisation_members_org_role_idx on public.organisation_members (organisation_id, role);

create trigger organisation_members_updated_at
  before update on public.organisation_members
  for each row execute function private.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- Who is calling? (used by RLS policies on every tenant table)
-- security definer so policies can read members without recursing into members' own RLS.
-- ─────────────────────────────────────────────────────────────
create or replace function private.current_organisation_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_members m
  where m.user_id = (select auth.uid()) and m.status = 'active'
$$;

create or replace function private.current_member_role()
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.organisation_members m
  where m.user_id = (select auth.uid()) and m.status = 'active'
$$;

create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_member_role() <> 'participant', false)
$$;

revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function
  private.current_organisation_id(),
  private.current_member_role(),
  private.is_staff()
to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Row-level security: read-only, own organisation only
-- ─────────────────────────────────────────────────────────────
alter table public.organisations enable row level security;
alter table public.organisation_members enable row level security;

revoke all on public.organisations, public.organisation_members from anon;
revoke insert, update, delete, truncate on public.organisations, public.organisation_members from authenticated;

create policy "Members read their own organisation"
  on public.organisations for select
  to authenticated
  using (id = (select private.current_organisation_id()));

-- Staff see everyone in their organisation; participants see only themselves.
create policy "Members read people in their organisation"
  on public.organisation_members for select
  to authenticated
  using (
    organisation_id = (select private.current_organisation_id())
    and ((select private.is_staff()) or user_id = (select auth.uid()))
  );
