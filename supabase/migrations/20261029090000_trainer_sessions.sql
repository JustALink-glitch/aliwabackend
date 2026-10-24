-- T8.01 Add a resource: trainers can keep a resource from participants. Safe to run more than once.
alter table public.resources add column if not exists visible_to_participants boolean not null default true;
