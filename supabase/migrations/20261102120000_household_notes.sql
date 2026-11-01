-- House memory: lasting facts people mention in chat ("we have really hard
-- water", "the dryer vents through a 20 ft duct"). Jev's fast lane call spots
-- them, and the person's own sentence is saved as written, never a summary.
-- Muse reads the recent ones as background; household.html lists them with a
-- delete button. Car seat and safety notes are kept as plain notes only:
-- they never reach Muse's context, so they can't change a safety answer.

create table public.household_notes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  -- The thing it's about, when Jev was sure; null for the whole house.
  item_id uuid,
  -- The person's own words, trimmed and capped by the server.
  note text not null check (length(btrim(note)) between 1 and 300),
  -- Jev's "remember" score when it was saved.
  p real check (p between 0 and 1),
  -- About a car seat or safety: shown, never used in answers.
  safety boolean not null default false,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade
);

-- Saying the same thing twice saves it once.
create unique index household_notes_same on public.household_notes (household_id, lower(note));
create index household_notes_recent on public.household_notes (household_id, created_at desc);

alter table public.household_notes enable row level security;

create policy "household members" on public.household_notes
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- Demo reset also clears what judges told Muse about the house. Notes on a
-- thing already go with the thing; this clears the whole-house ones too.
create or replace function public.reset_demo_household(hid uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from public.households where id = hid and is_demo) then
    raise exception 'Household % is not a demo household.', hid;
  end if;
  delete from public.household_notes where household_id = hid;
  delete from public.items where household_id = hid;
  delete from public.children where household_id = hid;
  delete from public.revisions where household_id = hid;
  perform public.fill_demo_household(hid);
end;
$$;

revoke execute on function public.reset_demo_household(uuid) from public, anon, authenticated;
