-- Session reports (T5, C3, F1.08): drafts, multiple-choice questions, default questions. Safe to run more than once.

-- T5.01 "Save draft": a report exists before it is submitted.
alter table public.session_reports alter column submitted_at drop not null;
alter table public.session_reports alter column submitted_at drop default;
alter table public.session_reports drop constraint if exists session_reports_summary_check;
alter table public.session_reports alter column summary set default '';

-- F1.08 Single or multiple choice.
alter table public.report_questions add column if not exists multiple boolean not null default false;

-- Each choice ticked; `answer` keeps them as readable text.
alter table public.session_report_answers add column if not exists choices text[] not null default '{}';

-- F1.08 "Remind the trainer" and "Show overdue reports on the overview".
alter table public.organisation_settings add column if not exists report_reminder_enabled boolean not null default true;
alter table public.organisation_settings add column if not exists report_overdue_on_overview boolean not null default true;

create index if not exists session_reports_org_idx on public.session_reports (organisation_id, submitted_at desc);

-- The questions F1.08 starts with. Organisations can change them in Settings › Session reports.
create or replace function private.create_default_report_questions(org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.report_questions (organisation_id, prompt, options, multiple, position)
  select org, q.prompt, q.options, q.multiple, q.position
  from (values
    ('How much of the planned content did you cover?', array['All of it', 'Most of it', 'About half', 'Little or none'], false, 1),
    ('How engaged were participants overall?', array['Very engaged', 'Mostly engaged', 'Mixed', 'Mostly disengaged'], false, 2),
    ('Did anything get in the way?', array['Nothing', 'Connectivity', 'Venue or equipment', 'Low attendance', 'Content too advanced', 'Other'], true, 3)
  ) as q(prompt, options, multiple, position)
  where not exists (select 1 from public.report_questions r where r.organisation_id = org);
$$;

create or replace function private.organisation_report_questions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.create_default_report_questions(new.id);
  return new;
end;
$$;

drop trigger if exists organisations_report_questions on public.organisations;
create trigger organisations_report_questions
  after insert on public.organisations
  for each row execute function private.organisation_report_questions();

-- Organisations created before this migration.
select private.create_default_report_questions(id) from public.organisations;

revoke execute on function private.create_default_report_questions(uuid), private.organisation_report_questions() from public, anon, authenticated;
