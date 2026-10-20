-- Run this in Supabase SQL editor after backing up production data.
-- The existing users table remains the authentication table; these tables
-- separate role-specific profile data while preserving current foreign keys.

create table if not exists admins (
  id uuid primary key references users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  phone text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists trainers (
  id uuid primary key references users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  phone text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists students (
  id uuid primary key references users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  phone text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into admins (id, first_name, last_name, email, phone, status, created_at, updated_at)
select id, first_name, last_name, email, phone, status, created_at, coalesce(updated_at, created_at)
from users
where role = 'admin'
on conflict (id) do update set
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  email = excluded.email,
  phone = excluded.phone,
  status = excluded.status,
  updated_at = now();

insert into trainers (id, first_name, last_name, email, phone, status, created_at, updated_at)
select id, first_name, last_name, email, phone, status, created_at, coalesce(updated_at, created_at)
from users
where role = 'trainer'
on conflict (id) do update set
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  email = excluded.email,
  phone = excluded.phone,
  status = excluded.status,
  updated_at = now();

insert into students (id, first_name, last_name, email, phone, status, created_at, updated_at)
select id, first_name, last_name, email, phone, status, created_at, coalesce(updated_at, created_at)
from users
where role = 'student'
on conflict (id) do update set
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  email = excluded.email,
  phone = excluded.phone,
  status = excluded.status,
  updated_at = now();

alter table courses
  alter column cohort_id set not null;

alter table courses
  drop constraint if exists courses_cohort_id_fkey,
  add constraint courses_cohort_id_fkey foreign key (cohort_id) references cohorts(id) on delete restrict;

alter table courses
  drop constraint if exists courses_trainer_id_fkey,
  add constraint courses_trainer_id_fkey foreign key (trainer_id) references trainers(id) on delete set null;

alter table sessions
  drop constraint if exists sessions_trainer_id_fkey,
  add constraint sessions_trainer_id_fkey foreign key (trainer_id) references trainers(id) on delete set null;

alter table enrollments
  drop constraint if exists enrollments_student_id_fkey,
  add constraint enrollments_student_id_fkey foreign key (student_id) references students(id) on delete cascade;
