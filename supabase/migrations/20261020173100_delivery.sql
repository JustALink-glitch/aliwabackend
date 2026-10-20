-- Delivery: sessions, attendance, Zoom imports, recordings, session reports, session feedback.
-- Reference: §05 (Session, Attendance record, Session report, Session feedback), §07 (Zoom).

create type public.session_mode as enum ('online', 'in_person');
create type public.attendance_status as enum ('present', 'absent', 'excused');
create type public.attendance_source as enum ('zoom', 'manual', 'edited');

-- ─────────────────────────────────────────────────────────────
-- Sessions. Status: Scheduled · In progress · Held · Cancelled (derived from time + cancelled_at)
-- ─────────────────────────────────────────────────────────────

-- A repeating schedule. Its sessions are created as rows so each can be edited or cancelled alone.
create table public.session_series (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  cohort_course_id uuid not null,
  -- iCalendar RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261218T000000Z
  rrule            text not null check (rrule like 'FREQ=%'),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, cohort_course_id)
    references public.cohort_courses (organisation_id, id) on delete cascade,
  foreign key (organisation_id, created_by)
    references public.organisation_members (organisation_id, id) on delete set null (created_by)
);

create table public.sessions (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null,
  cohort_course_id    uuid not null,
  series_id           uuid,
  title               text not null check (length(trim(title)) between 1 and 160),
  description         text,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  mode                public.session_mode not null default 'online',
  location            text,
  trainer_member_id   uuid,
  cancelled_at        timestamptz,
  cancellation_reason text,
  zoom_meeting_id     text,
  -- Shared join link. Personal links live in session_join_links.
  zoom_join_url       text,
  -- Set when the Zoom participants report has been imported.
  attendance_imported_at timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organisation_id, id),
  check (ends_at > starts_at),
  check (mode = 'online' or location is not null),
  foreign key (organisation_id, cohort_course_id)
    references public.cohort_courses (organisation_id, id) on delete cascade,
  foreign key (organisation_id, series_id)
    references public.session_series (organisation_id, id) on delete set null (series_id),
  foreign key (organisation_id, trainer_member_id)
    references public.organisation_members (organisation_id, id) on delete set null (trainer_member_id),
  foreign key (organisation_id, created_by)
    references public.organisation_members (organisation_id, id) on delete set null (created_by)
);

create index sessions_cohort_course_starts_idx on public.sessions (cohort_course_id, starts_at);
create index sessions_org_starts_idx on public.sessions (organisation_id, starts_at);
create index sessions_trainer_starts_idx on public.sessions (trainer_member_id, starts_at);
create unique index sessions_zoom_meeting_key on public.sessions (zoom_meeting_id) where zoom_meeting_id is not null;

create or replace function public.status(session public.sessions)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when session.cancelled_at is not null then 'cancelled'
    when now() < session.starts_at then 'scheduled'
    when now() < session.ends_at then 'in_progress'
    else 'held'
  end
$$;

-- Personal Zoom join link per participant (registrant link), when join_link_mode = 'personal'.
create table public.session_join_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  session_id      uuid not null,
  member_id       uuid not null,
  join_url        text not null,
  zoom_registrant_id text,
  created_at      timestamptz not null default now(),
  unique (session_id, member_id),
  foreign key (organisation_id, session_id) references public.sessions (organisation_id, id) on delete cascade,
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete cascade
);

-- ─────────────────────────────────────────────────────────────
-- Attendance. No row = Not recorded.
-- ─────────────────────────────────────────────────────────────
create table public.attendance_records (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null,
  session_id         uuid not null,
  member_id          uuid not null,
  status             public.attendance_status not null,
  source             public.attendance_source not null,
  joined_at          timestamptz,
  minutes_in_meeting integer check (minutes_in_meeting >= 0),
  is_late            boolean not null default false,
  note               text,
  recorded_by        uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organisation_id, id),
  unique (session_id, member_id),
  foreign key (organisation_id, session_id) references public.sessions (organisation_id, id) on delete cascade,
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete restrict,
  foreign key (organisation_id, recorded_by)
    references public.organisation_members (organisation_id, id) on delete set null (recorded_by)
);

create index attendance_records_member_idx on public.attendance_records (member_id);

-- Full edit history: who, when, why (C2.02, C2.05). A reason is required.
create table public.attendance_changes (
  id                   uuid primary key default gen_random_uuid(),
  organisation_id      uuid not null,
  attendance_record_id uuid not null,
  changed_by           uuid,
  from_status          public.attendance_status,
  to_status            public.attendance_status not null,
  reason               text not null check (length(trim(reason)) > 0),
  created_at           timestamptz not null default now(),
  foreign key (organisation_id, attendance_record_id)
    references public.attendance_records (organisation_id, id) on delete cascade,
  foreign key (organisation_id, changed_by)
    references public.organisation_members (organisation_id, id) on delete set null (changed_by)
);

create index attendance_changes_record_idx on public.attendance_changes (attendance_record_id, created_at);

-- Zoom attendees who couldn't be matched by email (C2.04 / T4.04).
create table public.zoom_unmatched_attendees (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null,
  session_id         uuid not null,
  display_name       text not null,
  email              text,
  joined_at          timestamptz,
  minutes_in_meeting integer check (minutes_in_meeting >= 0),
  matched_member_id  uuid,
  resolved_by        uuid,
  resolved_at        timestamptz,
  dismissed          boolean not null default false,
  created_at         timestamptz not null default now(),
  check (resolved_at is not null or (matched_member_id is null and not dismissed)),
  foreign key (organisation_id, session_id) references public.sessions (organisation_id, id) on delete cascade,
  foreign key (organisation_id, matched_member_id)
    references public.organisation_members (organisation_id, id) on delete set null (matched_member_id),
  foreign key (organisation_id, resolved_by)
    references public.organisation_members (organisation_id, id) on delete set null (resolved_by)
);

create index zoom_unmatched_open_idx on public.zoom_unmatched_attendees (session_id) where resolved_at is null;

-- Cloud recordings: streaming only, kept for the retention period (P4.04).
create table public.session_recordings (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  session_id        uuid not null,
  zoom_recording_id text,
  storage_path      text,
  duration_seconds  integer check (duration_seconds >= 0),
  recorded_at       timestamptz,
  available_until   timestamptz not null,
  created_at        timestamptz not null default now(),
  foreign key (organisation_id, session_id) references public.sessions (organisation_id, id) on delete cascade
);

create unique index session_recordings_zoom_key
  on public.session_recordings (zoom_recording_id) where zoom_recording_id is not null;
create index session_recordings_session_idx on public.session_recordings (session_id);

-- ─────────────────────────────────────────────────────────────
-- Session reports: org-defined multiple-choice questions + written summary (F1.08, T5).
-- Due = session end + report_due_hours. Due · Overdue · Submitted is derived.
-- ─────────────────────────────────────────────────────────────
create table public.report_questions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  prompt          text not null check (length(trim(prompt)) between 1 and 200),
  options         text[] not null check (cardinality(options) between 2 and 10),
  position        integer not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (organisation_id, id)
);

create table public.session_reports (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  session_id       uuid not null unique,
  author_member_id uuid,
  summary          text not null check (length(trim(summary)) > 0),
  submitted_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, session_id) references public.sessions (organisation_id, id) on delete cascade,
  foreign key (organisation_id, author_member_id)
    references public.organisation_members (organisation_id, id) on delete set null (author_member_id)
);

-- The answer is copied as text so old reports still read correctly if a question changes.
create table public.session_report_answers (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  report_id       uuid not null,
  question_id     uuid,
  question_prompt text not null,
  answer          text not null,
  unique (report_id, question_id),
  foreign key (organisation_id, report_id) references public.session_reports (organisation_id, id) on delete cascade,
  foreign key (organisation_id, question_id)
    references public.report_questions (organisation_id, id) on delete set null (question_id)
);

-- ─────────────────────────────────────────────────────────────
-- Session feedback: optional 1–5 rating + comment from participants.
-- Anonymous to trainers and admins: the API never returns member_id to staff.
-- member_id is kept only so a participant can rate a session once.
-- ─────────────────────────────────────────────────────────────
create table public.session_feedback (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  session_id      uuid not null,
  member_id       uuid not null,
  rating          smallint not null check (rating between 1 and 5),
  comment         text,
  created_at      timestamptz not null default now(),
  unique (session_id, member_id),
  foreign key (organisation_id, session_id) references public.sessions (organisation_id, id) on delete cascade,
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete cascade
);
