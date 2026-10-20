-- Programme structure: organisation settings, programmes, cohorts, courses, trainers, enrolments.
-- Reference: Development Reference V1 §05 (core objects, status values, rules).
--
-- Conventions for every tenant table from here on
--   * `organisation_id` on every row, and a UNIQUE (organisation_id, id) so children can use
--     composite foreign keys. A child can never point at a parent in another organisation.
--   * Row-level security on, no client grants. The browser reads product data through the API.
--   * Statuses that follow from dates (cohort Upcoming/Active/Completed, session In progress/Held)
--     are derived, never stored, so they can't drift.

-- ─────────────────────────────────────────────────────────────
-- Shared types
-- ─────────────────────────────────────────────────────────────
create domain public.percent as numeric(5, 2) check (value between 0 and 100);

create type public.course_library_mode as enum ('shared', 'per_cohort');
create type public.join_link_mode as enum ('personal', 'shared');
create type public.grading_scale as enum ('points', 'percentage', 'letter', 'pass_fail', 'rubric');
create type public.enrolment_status as enum ('active', 'deferred', 'withdrawn', 'completed');

alter table public.organisation_members
  add constraint organisation_members_org_id_key unique (organisation_id, id);

-- ─────────────────────────────────────────────────────────────
-- Organisation settings (one row per organisation; defaults from §05 "Rules")
-- ─────────────────────────────────────────────────────────────
create table public.organisation_settings (
  organisation_id uuid primary key references public.organisations (id) on delete cascade,

  -- Programme setup (F1.04)
  course_library_mode              public.course_library_mode not null default 'shared',
  allow_multi_cohort_enrolment     boolean not null default false,
  allowed_grading_scales           public.grading_scale[] not null
                                     default '{points,percentage,letter,pass_fail,rubric}'
                                     check (cardinality(allowed_grading_scales) > 0),
  -- What assistant trainers can do (lead trainers can always do all of them)
  assistant_can_take_attendance    boolean not null default true,
  assistant_can_add_resources      boolean not null default true,
  assistant_can_create_assignments boolean not null default false,
  assistant_can_grade              boolean not null default true,
  assistant_can_write_reports      boolean not null default false,

  -- Completion (F1.05). Each criterion can be switched off.
  completion_attendance_enabled    boolean not null default true,
  completion_attendance_min_pct    public.percent not null default 75,
  completion_submissions_enabled   boolean not null default true,
  completion_submissions_min_pct   public.percent not null default 80,
  completion_grade_enabled         boolean not null default true,
  completion_grade_min_pct         public.percent not null default 50,
  completion_requires_approval     boolean not null default true,
  certificates_auto_issue          boolean not null default false,
  certificate_signatory_name       text,
  certificate_signatory_title      text,

  -- Needs attention rules (F1.06), checked nightly. "N" values are not fixed by the design;
  -- these defaults are placeholders until confirmed.
  flag_attendance_enabled          boolean not null default true,
  flag_attendance_below_pct        public.percent not null default 75,
  flag_missed_in_row_enabled       boolean not null default true,
  flag_missed_in_row_count         integer not null default 2 check (flag_missed_in_row_count >= 1),
  flag_overdue_enabled             boolean not null default true,
  flag_overdue_count               integer not null default 1 check (flag_overdue_count >= 1),
  flag_inactivity_enabled          boolean not null default true,
  flag_inactivity_days             integer not null default 7 check (flag_inactivity_days >= 1),
  flag_grade_enabled               boolean not null default true,
  flag_grade_below_pct             public.percent not null default 50,

  -- Zoom and sessions (F1.07)
  zoom_present_min_pct             public.percent not null default 70,
  zoom_late_after_minutes          integer not null default 10 check (zoom_late_after_minutes >= 0),
  join_link_mode                   public.join_link_mode not null default 'personal',
  in_person_reminder_hours         integer not null default 2 check (in_person_reminder_hours >= 1),
  recording_retention_days         integer not null default 30 check (recording_retention_days >= 1),

  -- Session reports (F1.08)
  report_due_hours                 integer not null default 24 check (report_due_hours >= 1),
  report_reminder_hours_before     integer not null default 2 check (report_reminder_hours_before >= 0),

  -- Submissions, grades, notifications (proposals in §12)
  upload_limit_mb                  integer not null default 25 check (upload_limit_mb between 1 and 100),
  grades_visible_on_save           boolean not null default true,
  session_reminder_minutes_before  integer not null default 60 check (session_reminder_minutes_before >= 0),
  assignment_reminder_hours_before integer not null default 24 check (assignment_reminder_hours_before >= 0),
  digest_local_time                time not null default '08:00',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.create_organisation_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organisation_settings (organisation_id) values (new.id);
  return new;
end;
$$;

create trigger organisations_create_settings
  after insert on public.organisations
  for each row execute function private.create_organisation_settings();

-- Organisations created before this migration
insert into public.organisation_settings (organisation_id)
select id from public.organisations
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Programmes
-- ─────────────────────────────────────────────────────────────
create table public.programmes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 120),
  description     text,
  -- Completion overrides; null = use the organisation default.
  completion_attendance_min_pct  public.percent,
  completion_submissions_min_pct public.percent,
  completion_grade_min_pct       public.percent,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id)
);

create unique index programmes_name_key on public.programmes (organisation_id, lower(name));

-- Outcome options a programme records for participants (employed, internship…)
create table public.programme_outcome_options (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  programme_id    uuid not null,
  label           text not null check (length(trim(label)) between 1 and 80),
  position        integer not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, programme_id) references public.programmes (organisation_id, id) on delete cascade
);

create unique index programme_outcome_options_label_key
  on public.programme_outcome_options (programme_id, lower(label));

-- ─────────────────────────────────────────────────────────────
-- Cohorts. Status: Draft · Upcoming · Active · Completed · Archived (derived)
-- ─────────────────────────────────────────────────────────────
create table public.cohorts (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  programme_id    uuid not null,
  name            text not null check (length(trim(name)) between 1 and 120),
  starts_on       date not null,
  ends_on         date not null,
  is_draft        boolean not null default true,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, programme_id, id),
  check (ends_on >= starts_on),
  foreign key (organisation_id, programme_id) references public.programmes (organisation_id, id) on delete restrict
);

create unique index cohorts_name_key on public.cohorts (programme_id, lower(name));
create index cohorts_org_dates_idx on public.cohorts (organisation_id, starts_on, ends_on);

/** Organisation-local "today", the reference point for date-based statuses. */
create or replace function private.organisation_today(organisation_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone o.time_zone)::date
  from public.organisations o
  where o.id = organisation_id
$$;

-- Computed column: select=*,status via the API.
create or replace function public.status(cohort public.cohorts)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when cohort.archived_at is not null then 'archived'
    when cohort.is_draft then 'draft'
    when today < cohort.starts_on then 'upcoming'
    when today <= cohort.ends_on then 'active'
    else 'completed'
  end
  from (select private.organisation_today(cohort.organisation_id) as today) t
$$;

-- ─────────────────────────────────────────────────────────────
-- Courses. A course belongs to a programme (the library); it runs in cohorts through
-- cohort_courses. In "per_cohort" mode each course simply runs in one cohort.
-- ─────────────────────────────────────────────────────────────
create table public.courses (
  id                    uuid primary key default gen_random_uuid(),
  organisation_id       uuid not null,
  programme_id          uuid not null,
  name                  text not null check (length(trim(name)) between 1 and 120),
  description           text,
  planned_session_count integer check (planned_session_count >= 0),
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, programme_id, id),
  foreign key (organisation_id, programme_id) references public.programmes (organisation_id, id) on delete restrict
);

create unique index courses_name_key on public.courses (programme_id, lower(name));

-- A course running in a cohort. Sessions, assignments and resources hang off this.
-- The composite keys guarantee the course and cohort belong to the same programme.
create table public.cohort_courses (
  id                    uuid primary key default gen_random_uuid(),
  organisation_id       uuid not null,
  programme_id          uuid not null,
  cohort_id             uuid not null,
  course_id             uuid not null,
  planned_session_count integer check (planned_session_count >= 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organisation_id, id),
  unique (cohort_id, course_id),
  foreign key (organisation_id, programme_id, cohort_id)
    references public.cohorts (organisation_id, programme_id, id) on delete cascade,
  foreign key (organisation_id, programme_id, course_id)
    references public.courses (organisation_id, programme_id, id) on delete restrict
);

create index cohort_courses_course_idx on public.cohort_courses (course_id);

-- Trainers on a course in a cohort. One lead per cohort course.
create table public.cohort_course_trainers (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  cohort_course_id uuid not null,
  member_id        uuid not null,
  is_lead          boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (organisation_id, id),
  unique (cohort_course_id, member_id),
  foreign key (organisation_id, cohort_course_id)
    references public.cohort_courses (organisation_id, id) on delete cascade,
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete restrict
);

create unique index cohort_course_trainers_one_lead
  on public.cohort_course_trainers (cohort_course_id) where is_lead;
create index cohort_course_trainers_member_idx on public.cohort_course_trainers (member_id);

-- ─────────────────────────────────────────────────────────────
-- Enrolments: participant ↔ cohort. Active · Deferred · Withdrawn · Completed
-- Whether a participant may be in several cohorts is an organisation setting, checked by the API.
-- ─────────────────────────────────────────────────────────────
create table public.enrolments (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null,
  cohort_id           uuid not null,
  member_id           uuid not null,
  status              public.enrolment_status not null default 'active',
  status_reason       text,
  status_changed_at   timestamptz not null default now(),
  enrolled_at         timestamptz not null default now(),
  transferred_from_id uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organisation_id, id),
  unique (cohort_id, member_id),
  foreign key (organisation_id, cohort_id) references public.cohorts (organisation_id, id) on delete restrict,
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete restrict,
  foreign key (organisation_id, transferred_from_id)
    references public.enrolments (organisation_id, id) on delete set null (transferred_from_id)
);

create index enrolments_member_idx on public.enrolments (member_id);
create index enrolments_cohort_status_idx on public.enrolments (cohort_id, status);
