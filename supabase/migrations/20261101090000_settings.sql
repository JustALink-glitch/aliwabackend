-- Settings part A: Organisation details (F1.01), Programme setup (F1.04), Attendance & Zoom (F1.07),
-- Notifications (F1.09) and Profile & password (G1.04).

-- F1.01: optional organisation type and country.
alter table public.organisations
  add column if not exists type text check (type is null or length(trim(type)) between 1 and 60),
  add column if not exists country text check (country is null or country ~ '^[A-Z]{2}$');

-- F1.04 Programme setup and F1.07 Attendance & Zoom switches.
do $$ begin
  create type public.trainer_assignment_mode as enum ('course', 'cohort');
exception when duplicate_object then null; end $$;

alter table public.organisation_settings
  add column if not exists trainer_assignment public.trainer_assignment_mode not null default 'course',
  add column if not exists assistants_enabled boolean not null default true,
  add column if not exists session_feedback_enabled boolean not null default true,
  add column if not exists zoom_late_enabled boolean not null default true,
  add column if not exists recordings_shared boolean not null default true,
  add column if not exists in_person_reminder_enabled boolean not null default true;

-- G1.04 display name and F1.09 digest time, per person. Empty means "use the default".
alter table public.organisation_members
  add column if not exists display_name text check (display_name is null or length(trim(display_name)) between 1 and 80),
  add column if not exists digest_time time;
