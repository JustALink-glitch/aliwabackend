-- Assignment drafts (T6.02 "Save draft" / "Publish"). Safe to run more than once.

-- When the assignment was published. Null means it's a draft: only its trainers see it.
alter table public.assignments add column if not exists published_at timestamptz;

create index if not exists assignment_materials_assignment_idx on public.assignment_materials (assignment_id);
create index if not exists rubric_criteria_assignment_idx on public.rubric_criteria (assignment_id, position);
