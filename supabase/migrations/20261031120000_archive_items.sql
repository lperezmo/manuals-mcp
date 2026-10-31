-- Archived things: sold, given away or thrown out. Hidden from the lists, the
-- upcoming tasks and Muse, but kept (manual, history) until deleted for good.
alter table public.items add column if not exists archived_at timestamptz;

create index if not exists items_not_archived_idx
  on public.items (household_id) where archived_at is null;
