-- Receipts and warranty cards: a photo of one, read by Muse into purchase
-- date, store, price and warranty length, so the app can say when the
-- warranty ends and whether a repair is likely still covered.

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  -- What the photo showed: a store receipt or the maker's warranty card.
  kind text not null default 'receipt' check (kind in ('receipt', 'warranty_card', 'other')),
  purchased_on date,
  store text check (length(store) <= 120),
  price numeric(12, 2) check (price >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  warranty_months integer check (warranty_months between 1 and 1200),
  -- Only when the card prints an end date; otherwise it is purchased_on plus warranty_months.
  warranty_ends_on date,
  -- What the warranty covers, in the card's words ("parts and labor 1 year, motor 10 years").
  warranty_note text check (length(warranty_note) <= 500),
  -- Path inside the private "receipts" storage bucket: <household_id>/<receipt_id>.jpg
  image_path text,
  -- Who filled it in: Muse from the photo, or the user by hand.
  read_by text not null default 'server' check (read_by in ('server', 'user')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade
);

create index receipts_item_idx on public.receipts (item_id, created_at desc);
create trigger receipts_touch before update on public.receipts
  for each row execute function public.touch_updated_at();

alter table public.receipts enable row level security;

create policy "household members" on public.receipts
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- ---------------------------------------------------------------------------
-- Storage: private bucket, one folder per household, like manuals
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "household receipts read" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household receipts write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household receipts update" on storage.objects
  for update to authenticated
  using (bucket_id = 'receipts' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household receipts delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and public.is_member(((storage.foldername(name))[1])::uuid));
