-- Follow-up and completion: Needs attention flags, interventions, outcomes, completion reviews, certificates.
-- Platform: invitations, notifications, preferences, exports, generated reports, audit log, Zoom connection.
-- Then: lock down every product table so only the API (secret key) can read or write it.
-- Reference: §05, §06 (Follow-up, Completion, Organisation deletion), §07.

create type public.attention_rule as enum
  ('low_attendance', 'missed_in_row', 'overdue_assignments', 'inactive', 'low_grade');
create type public.intervention_method as enum ('call', 'email', 'visit', 'message', 'other');
create type public.intervention_outcome as enum ('awaiting_response', 'reached', 'resolved', 'no_response');
create type public.completion_decision as enum ('completed', 'not_completed');
create type public.job_status as enum ('queued', 'running', 'ready', 'failed', 'expired');

-- ─────────────────────────────────────────────────────────────
-- Needs attention (D1, T7). One open flag per enrolment and rule.
-- Clears automatically when the rule no longer matches; admins can resolve with a note.
-- Calculated from the whole cohort; trainers see that a participant is flagged.
-- ─────────────────────────────────────────────────────────────
create table public.attention_flags (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  enrolment_id    uuid not null,
  rule            public.attention_rule not null,
  -- What triggered it, e.g. {"attendance_pct": 62.5} or {"missed": 3}
  details         jsonb not null default '{}',
  raised_at       timestamptz not null default now(),
  cleared_at      timestamptz,
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution_note text,
  unique (organisation_id, id),
  check ((resolved_at is null) = (resolution_note is null)),
  check (resolution_note is null or length(trim(resolution_note)) > 0),
  foreign key (organisation_id, enrolment_id) references public.enrolments (organisation_id, id) on delete cascade,
  foreign key (organisation_id, resolved_by)
    references public.organisation_members (organisation_id, id) on delete set null (resolved_by)
);

create unique index attention_flags_one_open
  on public.attention_flags (enrolment_id, rule) where cleared_at is null and resolved_at is null;
create index attention_flags_org_open_idx
  on public.attention_flags (organisation_id, raised_at desc) where cleared_at is null and resolved_at is null;

-- Contact attempts and their outcome (D1.03, T7.03). Messaging happens outside Synqop.
create table public.interventions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  enrolment_id    uuid not null,
  flag_id         uuid,
  method          public.intervention_method not null,
  contacted_at    timestamptz not null default now(),
  notes           text,
  outcome         public.intervention_outcome not null default 'awaiting_response',
  recorded_by     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (organisation_id, enrolment_id) references public.enrolments (organisation_id, id) on delete cascade,
  foreign key (organisation_id, flag_id)
    references public.attention_flags (organisation_id, id) on delete set null (flag_id),
  foreign key (organisation_id, recorded_by)
    references public.organisation_members (organisation_id, id) on delete set null (recorded_by)
);

create index interventions_enrolment_idx on public.interventions (enrolment_id, contacted_at desc);

-- Programme outcomes recorded per participant (D3).
create table public.participant_outcomes (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  enrolment_id      uuid not null,
  outcome_option_id uuid not null,
  achieved_on       date,
  notes             text,
  recorded_by       uuid,
  created_at        timestamptz not null default now(),
  unique (enrolment_id, outcome_option_id),
  foreign key (organisation_id, enrolment_id) references public.enrolments (organisation_id, id) on delete cascade,
  foreign key (organisation_id, outcome_option_id)
    references public.programme_outcome_options (organisation_id, id) on delete restrict,
  foreign key (organisation_id, recorded_by)
    references public.organisation_members (organisation_id, id) on delete set null (recorded_by)
);

-- ─────────────────────────────────────────────────────────────
-- Completion and certificates (P7, D2).
-- Eligibility (Not yet eligible · Eligible) is calculated; the admin decision is stored here.
-- ─────────────────────────────────────────────────────────────
create table public.completion_reviews (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  enrolment_id    uuid not null unique,
  decision        public.completion_decision not null,
  note            text,
  decided_by      uuid,
  decided_at      timestamptz not null default now(),
  foreign key (organisation_id, enrolment_id) references public.enrolments (organisation_id, id) on delete cascade,
  foreign key (organisation_id, decided_by)
    references public.organisation_members (organisation_id, id) on delete set null (decided_by)
);

create table public.certificates (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  enrolment_id      uuid not null unique,
  -- Short public code printed on the certificate and used on the verification page.
  verification_code text not null unique check (verification_code ~ '^[A-Z0-9-]{8,32}$'),
  signatory_name    text,
  signatory_title   text,
  issued_by         uuid,
  issued_at         timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_reason    text,
  check ((revoked_at is null) = (revoked_reason is null)),
  foreign key (organisation_id, enrolment_id) references public.enrolments (organisation_id, id) on delete cascade,
  foreign key (organisation_id, issued_by)
    references public.organisation_members (organisation_id, id) on delete set null (issued_by)
);

-- ─────────────────────────────────────────────────────────────
-- Invitations: one-time link valid 72 h; resend revokes the old link (T0/P0, B2.02i).
-- Only a SHA-256 hash of the token is stored.
-- ─────────────────────────────────────────────────────────────
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  member_id       uuid not null,
  token_hash      bytea not null unique check (length(token_hash) = 32),
  expires_at      timestamptz not null,
  invited_by      uuid,
  sent_at         timestamptz not null default now(),
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  check (accepted_at is null or revoked_at is null),
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete cascade,
  foreign key (organisation_id, invited_by)
    references public.organisation_members (organisation_id, id) on delete set null (invited_by)
);

create unique index invitations_one_live
  on public.invitations (member_id) where accepted_at is null and revoked_at is null;

-- ─────────────────────────────────────────────────────────────
-- Notifications (G1.01) and preferences (F1.09, T9.02, P8.02)
-- ─────────────────────────────────────────────────────────────
create table public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null,
  recipient_member_id uuid not null,
  event               text not null,
  title               text not null,
  body                text,
  link_path           text check (link_path is null or link_path like '/%'),
  read_at             timestamptz,
  created_at          timestamptz not null default now(),
  foreign key (organisation_id, recipient_member_id)
    references public.organisation_members (organisation_id, id) on delete cascade
);

create index notifications_unread_idx
  on public.notifications (recipient_member_id, created_at desc) where read_at is null;
create index notifications_recipient_idx on public.notifications (recipient_member_id, created_at desc);

-- No row = the event's default. Event keys are defined in the API.
create table public.notification_preferences (
  organisation_id uuid not null,
  member_id       uuid not null,
  event           text not null,
  email           boolean not null,
  in_app          boolean not null,
  updated_at      timestamptz not null default now(),
  primary key (member_id, event),
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete cascade
);

-- ─────────────────────────────────────────────────────────────
-- Background jobs people wait for: data exports (F1.10) and generated reports (E1).
-- ─────────────────────────────────────────────────────────────
create table public.data_exports (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  requested_by    uuid,
  status          public.job_status not null default 'queued',
  storage_path    text,
  error           text,
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  check (status <> 'ready' or (storage_path is not null and expires_at is not null)),
  foreign key (organisation_id, requested_by)
    references public.organisation_members (organisation_id, id) on delete set null (requested_by)
);

create table public.generated_reports (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  requested_by    uuid,
  kind            text not null,
  parameters      jsonb not null default '{}',
  status          public.job_status not null default 'queued',
  storage_path    text,
  error           text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  foreign key (organisation_id, requested_by)
    references public.organisation_members (organisation_id, id) on delete set null (requested_by)
);

create index generated_reports_org_idx on public.generated_reports (organisation_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Zoom: one account per organisation (F1.07).
-- The refresh token is stored in Supabase Vault; only its secret id is kept here.
-- ─────────────────────────────────────────────────────────────
create table public.zoom_connections (
  organisation_id          uuid primary key references public.organisations (id) on delete cascade,
  zoom_account_id          text not null,
  zoom_user_email          text,
  refresh_token_secret_id  uuid not null,
  scopes                   text[] not null default '{}',
  connected_by             uuid,
  connected_at             timestamptz not null default now(),
  -- Set when Zoom rejects the token; shown as a partial error on Overview / Today.
  broken_at                timestamptz,
  broken_reason            text,
  foreign key (organisation_id, connected_by)
    references public.organisation_members (organisation_id, id) on delete set null (connected_by)
);

-- ─────────────────────────────────────────────────────────────
-- Audit log: who did what. Written by the API; never updated or deleted.
-- ─────────────────────────────────────────────────────────────
create table public.audit_events (
  id              bigint generated always as identity primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  actor_member_id uuid,
  action          text not null,
  entity_type     text not null,
  entity_id       uuid,
  data            jsonb not null default '{}',
  request_id      text,
  created_at      timestamptz not null default now()
);

create index audit_events_org_created_idx on public.audit_events (organisation_id, created_at desc);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id);

create or replace function private.forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.forbid_change();

-- ─────────────────────────────────────────────────────────────
-- Lock-down
-- ─────────────────────────────────────────────────────────────
do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    -- organisations and organisation_members keep their read-only policies from the foundation.
    if t.relname not in ('organisations', 'organisation_members') then
      execute format('revoke all on table public.%I from anon, authenticated', t.relname);
    end if;
  end loop;

  -- updated_at triggers for every table that has the column and no trigger yet.
  for t in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'updated_at'
      and not exists (
        select 1 from pg_trigger tg
        where tg.tgrelid = format('public.%I', c.table_name)::regclass
          and tg.tgname = c.table_name || '_updated_at'
      )
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
      t.table_name || '_updated_at', t.table_name
    );
  end loop;
end;
$$;

revoke all on all sequences in schema public from anon, authenticated;
revoke execute on function public.status(public.cohorts), public.status(public.sessions) from public, anon, authenticated;
revoke execute on function private.organisation_today(uuid) from public, anon, authenticated;
-- The API (service_role) reads the derived statuses, which call into the private schema.
grant usage on schema private to service_role;
grant execute on function private.organisation_today(uuid) to service_role;

-- New tables and functions are closed by default; grant explicitly if a client ever needs one.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
