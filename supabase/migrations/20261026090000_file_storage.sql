-- Private storage for assignment files and submissions (T6.02 attach files, P5.02 submit a file).
-- Safe to run more than once. Files are only reached through short-lived links the API signs,
-- so the bucket is private and has no policies for signed-in users.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('synqop-files', 'synqop-files', false, 26214400)
    on conflict (id) do update set public = false, file_size_limit = 26214400;
  end if;
end
$$;

