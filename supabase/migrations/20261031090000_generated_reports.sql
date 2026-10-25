-- E1 Reports: what was asked for and the file itself. Reports are small, so the file is kept in the row.
alter table public.generated_reports add column if not exists format text not null default 'pdf' check (format in ('pdf', 'csv'));
alter table public.generated_reports add column if not exists title text;
alter table public.generated_reports add column if not exists subtitle text;
alter table public.generated_reports add column if not exists file_name text;
alter table public.generated_reports add column if not exists content bytea;
