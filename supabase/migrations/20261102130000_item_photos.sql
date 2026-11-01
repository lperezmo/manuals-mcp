-- A real photo of a thing, shown instead of its icon wherever the icon tile
-- appears. Optional: things without one keep their icon and color. The page
-- shrinks the photo (about 512 px on the long side, JPEG) and uploads it
-- straight to a private bucket with the person's own session, like manuals.

-- Path inside the private "item-photos" bucket: <household_id>/<item_id>-<stamp>.jpg
-- A shared copy of a thing (copy_shared_item) lists its columns, so it never
-- carries the photo into another household.
alter table public.items
  add column photo_path text,
  add constraint items_photo_path_in_household
    check (photo_path is null or (length(photo_path) <= 200 and split_part(photo_path, '/', 1) = household_id::text));

-- ---------------------------------------------------------------------------
-- Storage: private bucket, one folder per household, like receipts
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "household item photos read" on storage.objects
  for select to authenticated
  using (bucket_id = 'item-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household item photos write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household item photos update" on storage.objects
  for update to authenticated
  using (bucket_id = 'item-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household item photos delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
