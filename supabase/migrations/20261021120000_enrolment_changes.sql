-- Enrolment changes from the participant page (B1.05a defer, B1.05b withdraw, B1.05c transfer).
-- Safe to run more than once (SQL Editor or `supabase db push`).

-- A transfer ends one enrolment and starts another; the old one is kept as "transferred"
-- so it doesn't count as a withdrawal in reports.
alter type public.enrolment_status add value if not exists 'transferred';

alter table public.enrolments
  -- The date the admin chose ("Deferred from", "Withdrawal date"); status_changed_at is when it was recorded.
  add column if not exists status_effective_on date,
  -- Optional context for other admins.
  add column if not exists status_note text check (status_note is null or length(status_note) <= 1000);
