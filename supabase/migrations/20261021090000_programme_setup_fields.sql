-- Fields the programme, course and cohort forms need (A1.03, A2.03, A3.07).
-- Written to be safe to run more than once (SQL Editor or `supabase db push`).

-- Programme lead (A1.03 "Programme lead"): the admin participants and trainers can contact.
alter table public.programmes add column if not exists lead_member_id uuid;

-- Default lead trainer (A2.03): used when the course is added to a cohort; can change per cohort.
alter table public.courses add column if not exists default_lead_member_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'programmes_lead_member_fkey') then
    alter table public.programmes
      add constraint programmes_lead_member_fkey foreign key (organisation_id, lead_member_id)
        references public.organisation_members (organisation_id, id) on delete set null (lead_member_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'courses_default_lead_member_fkey') then
    alter table public.courses
      add constraint courses_default_lead_member_fkey foreign key (organisation_id, default_lead_member_id)
        references public.organisation_members (organisation_id, id) on delete set null (default_lead_member_id);
  end if;
  -- How sessions in a cohort usually run (A3.07 "Delivery"). Each session can still differ.
  if not exists (select 1 from pg_type where typname = 'delivery_mode' and typnamespace = 'public'::regnamespace) then
    create type public.delivery_mode as enum ('in_person', 'online', 'both');
  end if;
end
$$;

alter table public.cohorts
  add column if not exists delivery_mode  public.delivery_mode not null default 'online',
  add column if not exists usual_location text check (usual_location is null or length(trim(usual_location)) between 1 and 120);

-- The designs have no draft step for cohorts: a new cohort is Upcoming until its start date.
alter table public.cohorts alter column is_draft set default false;

create index if not exists programmes_org_idx on public.programmes (organisation_id);
create index if not exists courses_programme_idx on public.courses (programme_id);
create index if not exists cohorts_programme_idx on public.cohorts (programme_id);
