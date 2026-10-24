-- Scheduling and cancelling sessions (C1.02, C1.05). Safe to run more than once.

-- Who cancelled a session (shown in lists as "Cancelled by …").
alter table public.sessions add column if not exists cancelled_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_cancelled_by_fkey') then
    alter table public.sessions
      add constraint sessions_cancelled_by_fkey foreign key (organisation_id, cancelled_by)
        references public.organisation_members (organisation_id, id) on delete set null (cancelled_by);
  end if;
end
$$;

create index if not exists sessions_series_idx on public.sessions (series_id);
