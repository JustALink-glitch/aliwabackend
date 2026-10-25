-- Settings part B: Data & privacy (F1.10 export, F1.11 delete organisation).

-- F1.10: what each export includes, and the ZIP itself (kept 7 days).
alter table public.data_exports
  add column if not exists parts text[] not null default '{}',
  add column if not exists content bytea,
  add column if not exists file_name text,
  add column if not exists size_bytes bigint;

alter table public.data_exports drop constraint if exists data_exports_check;
alter table public.data_exports drop constraint if exists data_exports_ready_check;
alter table public.data_exports
  add constraint data_exports_ready_check
  check (status <> 'ready' or ((storage_path is not null or content is not null) and expires_at is not null));

-- F1.11b: who scheduled the deletion, and when everyone was told.
alter table public.organisations
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_requested_by uuid references public.organisation_members (id) on delete set null;
