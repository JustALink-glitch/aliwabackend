-- A2.02 / A2.04: resources can belong to the whole course (every cohort that runs it), not just one cohort's copy.
alter table public.resources
  alter column cohort_course_id drop not null,
  add column if not exists course_id uuid references public.courses (id) on delete cascade;

alter table public.resources drop constraint if exists resources_owner_check;
alter table public.resources
  add constraint resources_owner_check check ((cohort_course_id is null) <> (course_id is null));

create index if not exists resources_course_idx on public.resources (course_id, created_at desc) where course_id is not null;
