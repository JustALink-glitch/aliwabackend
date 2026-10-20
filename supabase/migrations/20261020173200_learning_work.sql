-- Learning work: resources, assignments, submissions, grades.
-- Reference: §05 (Assignment, Submission · grade, Grading scales, Submissions), T6, P5, P6.

create type public.resource_kind as enum ('file', 'link');
create type public.submission_type as enum ('file', 'link', 'text');
create type public.late_policy as enum ('accept_late', 'closed');
create type public.letter_grade as enum ('A', 'B', 'C', 'D', 'E', 'F');

-- ─────────────────────────────────────────────────────────────
-- Resources: files and links on a course in a cohort, optionally tied to one session.
-- Files live in Supabase Storage (private bucket); storage_path is the object key.
-- ─────────────────────────────────────────────────────────────
create table public.resources (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  cohort_course_id uuid not null,
  session_id       uuid,
  kind             public.resource_kind not null,
  name             text not null check (length(trim(name)) between 1 and 200),
  url              text,
  storage_path     text,
  size_bytes       bigint check (size_bytes >= 0),
  mime_type        text,
  added_by         uuid,
  created_at       timestamptz not null default now(),
  check ((kind = 'link') = (url is not null)),
  check ((kind = 'file') = (storage_path is not null)),
  foreign key (organisation_id, cohort_course_id)
    references public.cohort_courses (organisation_id, id) on delete cascade,
  foreign key (organisation_id, session_id)
    references public.sessions (organisation_id, id) on delete set null (session_id),
  foreign key (organisation_id, added_by)
    references public.organisation_members (organisation_id, id) on delete set null (added_by)
);

create index resources_cohort_course_idx on public.resources (cohort_course_id, created_at desc);
create index resources_session_idx on public.resources (session_id) where session_id is not null;

-- ─────────────────────────────────────────────────────────────
-- Assignments. Per-participant status (Not submitted · Submitted · Late · Overdue · Graded)
-- is derived from due_at, the submission and the grade.
-- Proposal (§12): grading scale and submission types lock once any work is submitted —
-- enforced by the API, since it depends on whether submissions exist.
-- ─────────────────────────────────────────────────────────────
create table public.assignments (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  cohort_course_id uuid not null,
  title            text not null check (length(trim(title)) between 1 and 200),
  brief            text,
  due_at           timestamptz not null,
  submission_types public.submission_type[] not null default '{file}'
                     check (cardinality(submission_types) > 0),
  late_policy      public.late_policy not null default 'accept_late',
  grading_scale    public.grading_scale not null,
  max_points       numeric(7, 2) check (max_points > 0),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organisation_id, id),
  check ((grading_scale = 'points') = (max_points is not null)),
  foreign key (organisation_id, cohort_course_id)
    references public.cohort_courses (organisation_id, id) on delete cascade,
  foreign key (organisation_id, created_by)
    references public.organisation_members (organisation_id, id) on delete set null (created_by)
);

create index assignments_cohort_course_due_idx on public.assignments (cohort_course_id, due_at);
create index assignments_org_due_idx on public.assignments (organisation_id, due_at);

-- Files and links attached to the brief.
create table public.assignment_materials (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  assignment_id   uuid not null,
  kind            public.resource_kind not null,
  name            text not null check (length(trim(name)) between 1 and 200),
  url             text,
  storage_path    text,
  size_bytes      bigint check (size_bytes >= 0),
  mime_type       text,
  created_at      timestamptz not null default now(),
  check ((kind = 'link') = (url is not null)),
  check ((kind = 'file') = (storage_path is not null)),
  foreign key (organisation_id, assignment_id) references public.assignments (organisation_id, id) on delete cascade
);

-- Rubric: criteria × score 1–4 (only for grading_scale = 'rubric').
create table public.rubric_criteria (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  assignment_id   uuid not null,
  title           text not null check (length(trim(title)) between 1 and 120),
  description     text,
  position        integer not null default 0,
  unique (organisation_id, id),
  foreign key (organisation_id, assignment_id) references public.assignments (organisation_id, id) on delete cascade
);

-- ─────────────────────────────────────────────────────────────
-- Submissions: file / link / text + optional note. Replaceable until the due time.
-- ─────────────────────────────────────────────────────────────
create table public.submissions (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  assignment_id   uuid not null,
  member_id       uuid not null,
  text_body       text,
  link_url        text,
  note            text,
  is_late         boolean not null default false,
  submitted_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  unique (assignment_id, member_id),
  foreign key (organisation_id, assignment_id) references public.assignments (organisation_id, id) on delete cascade,
  foreign key (organisation_id, member_id)
    references public.organisation_members (organisation_id, id) on delete restrict
);

create index submissions_member_idx on public.submissions (member_id);

create table public.submission_files (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  submission_id   uuid not null,
  name            text not null,
  storage_path    text not null,
  size_bytes      bigint not null check (size_bytes >= 0),
  mime_type       text,
  created_at      timestamptz not null default now(),
  foreign key (organisation_id, submission_id) references public.submissions (organisation_id, id) on delete cascade
);

create index submission_files_submission_idx on public.submission_files (submission_id);

-- ─────────────────────────────────────────────────────────────
-- Grades: one per submission, in the assignment's scale.
-- score_pct is the value used for "average grade" (completion, Needs attention).
-- The API sets it when grading; how letter and pass/fail convert to a percentage
-- is still to be confirmed, so it may be null for those scales.
-- ─────────────────────────────────────────────────────────────
create table public.grades (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  submission_id   uuid not null unique,
  points          numeric(7, 2) check (points >= 0),
  percentage      public.percent,
  letter          public.letter_grade,
  passed          boolean,
  score_pct       public.percent,
  feedback        text,
  graded_by       uuid,
  graded_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  -- Exactly one way of expressing the grade (rubric grades use rubric_scores and set none of these).
  check (num_nonnulls(points, percentage, letter, passed) <= 1),
  foreign key (organisation_id, submission_id) references public.submissions (organisation_id, id) on delete cascade,
  foreign key (organisation_id, graded_by)
    references public.organisation_members (organisation_id, id) on delete set null (graded_by)
);

create table public.rubric_scores (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  grade_id        uuid not null,
  criterion_id    uuid not null,
  score           smallint not null check (score between 1 and 4),
  unique (grade_id, criterion_id),
  foreign key (organisation_id, grade_id) references public.grades (organisation_id, id) on delete cascade,
  foreign key (organisation_id, criterion_id) references public.rubric_criteria (organisation_id, id) on delete cascade
);
