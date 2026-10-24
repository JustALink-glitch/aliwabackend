-- Completion, certificates and outcomes (F1.05, D2, D3, P7). Safe to run more than once.

-- F1.05 Certificate title and the outcome options new programmes start with.
alter table public.organisation_settings add column if not exists certificate_title text not null default 'Certificate of Completion';
alter table public.organisation_settings add column if not exists default_outcome_options text[] not null
  default '{Employed,Internship,"Further study","Started a business",Freelancing}';

-- F1.06 Who sees flags and how they close.
alter table public.organisation_settings add column if not exists flag_trainers_see boolean not null default true;
alter table public.organisation_settings add column if not exists flag_clear_automatically boolean not null default true;
alter table public.organisation_settings add column if not exists flag_trainers_can_resolve boolean not null default false;

-- D2 The title is kept on each certificate as issued.
alter table public.certificates add column if not exists title text;

-- D3.02 Where and as what, for an outcome such as "Employed".
alter table public.participant_outcomes add column if not exists organisation_name text;
alter table public.participant_outcomes add column if not exists role_title text;

create index if not exists certificates_org_idx on public.certificates (organisation_id, issued_at desc);
create index if not exists participant_outcomes_org_idx on public.participant_outcomes (organisation_id, created_at desc);
