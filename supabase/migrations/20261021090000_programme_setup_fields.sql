-- Fields the programme, course and cohort forms need (A1.03, A2.03, A3.07).

-- Programme lead (A1.03 "Programme lead"): the admin participants and trainers can contact.
alter table public.programmes
  add column lead_member_id uuid,
  add foreign key (organisation_id, lead_member_id)
    references public.organisation_members (organisation_id, id) on delete set null (lead_member_id);

-- Default lead trainer (A2.03): used when the course is added to a cohort; can change per cohort.
alter table public.courses
  add column default_lead_member_id uuid,
  add foreign key (organisation_id, default_lead_member_id)
    references public.organisation_members (organisation_id, id) on delete set null (default_lead_member_id);

-- How sessions in a cohort usually run (A3.07 "Delivery"). Each session can still differ.
create type public.delivery_mode as enum ('in_person', 'online', 'both');

alter table public.cohorts
  add column delivery_mode  public.delivery_mode not null default 'online',
  add column usual_location text check (usual_location is null or length(trim(usual_location)) between 1 and 120);

-- The designs have no draft step for cohorts: a new cohort is Upcoming until its start date.
alter table public.cohorts alter column is_draft set default false;

create index programmes_org_idx on public.programmes (organisation_id);
create index courses_programme_idx on public.courses (programme_id);
create index cohorts_programme_idx on public.cohorts (programme_id);
