-- Follow-up (D1.03, T7.03): "Review again on" for an intervention. Safe to run more than once.
alter table public.interventions add column if not exists review_on date;

create index if not exists interventions_org_idx on public.interventions (organisation_id, contacted_at desc);
create index if not exists attention_flags_enrolment_idx on public.attention_flags (enrolment_id, raised_at desc);
