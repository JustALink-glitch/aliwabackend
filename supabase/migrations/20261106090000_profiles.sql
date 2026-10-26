-- T9.01 / T1.03 / P1.02: a short bio and a profile photo for each member.
alter table public.organisation_members
  add column if not exists bio text,
  add column if not exists photo_path text;
alter table public.organisation_members drop constraint if exists organisation_members_bio_length;
alter table public.organisation_members add constraint organisation_members_bio_length check (bio is null or char_length(bio) <= 300);
