-- Scheduler (X2): one row per reminder or digest already sent, so each goes out once
-- even if the API restarts or runs on more than one machine.
create table if not exists public.delivery_log (
  key             text primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  sent_at         timestamptz not null default now()
);
create index if not exists delivery_log_organisation_idx on public.delivery_log (organisation_id, sent_at);
alter table public.delivery_log enable row level security;

-- F1.11: the audit log stays append-only, except when the whole organisation is deleted after its
-- 30 days. The scheduler sets synqop.purging for that one transaction.
create or replace function private.forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('synqop.purging', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_events is append-only';
end;
$$;
