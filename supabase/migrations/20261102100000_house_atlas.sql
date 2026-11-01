-- House Atlas: Jev sorts every thing and upkeep task along a few lenses
-- (room, system, who it's for; effort and season for tasks), keeping the
-- probabilities so a thing that fits two rooms can show in both. Dates and
-- due state stay in tasks; these tables only say where things belong.
--
-- Sorting happens the first time the atlas is opened after a thing or task is
-- added or changed: the triggers below clear a row's facets when the words it
-- was sorted from change, and the server sorts whatever has none.

create table public.item_facets (
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  lens text not null check (lens in ('room', 'system', 'whose')),
  -- An option key from the server's lens list; for "whose", a child is child:<id>.
  value text not null check (length(value) between 1 and 80),
  p real not null check (p >= 0 and p <= 1),
  sorted_at timestamptz not null default now(),
  primary key (item_id, lens, value),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade
);

create index item_facets_household_idx on public.item_facets (household_id, lens);

create table public.task_facets (
  household_id uuid not null default public.current_household_id(),
  task_id uuid not null,
  lens text not null check (lens in ('effort', 'season')),
  value text not null check (length(value) between 1 and 80),
  p real not null check (p >= 0 and p <= 1),
  sorted_at timestamptz not null default now(),
  primary key (task_id, lens, value),
  foreign key (household_id, task_id) references public.tasks (household_id, id) on delete cascade
);

create index task_facets_household_idx on public.task_facets (household_id, lens);

-- Views the household described in its own words ("things that could flood
-- the floor"), with Jev's yes probability per thing. Recomputed when a thing
-- is added or changed after computed_at.
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  phrase text not null check (length(phrase) between 2 and 120),
  -- item id -> probability the thing fits the view.
  scores jsonb not null default '{}'::jsonb,
  -- jev: scored by meaning; text: Jev was away, so a plain word match.
  mode text not null default 'jev' check (mode in ('jev', 'text')),
  computed_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (household_id, phrase)
);

alter table public.item_facets enable row level security;
alter table public.task_facets enable row level security;
alter table public.saved_views enable row level security;

create policy "household members" on public.item_facets
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "household members" on public.task_facets
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy "household members" on public.saved_views
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- ---------------------------------------------------------------------------
-- Forget a sort when the words it came from change
-- ---------------------------------------------------------------------------

create function public.atlas_forget_item()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.item_facets where item_id = new.id;
  return new;
end;
$$;

create trigger items_atlas_forget
  after update of nickname, brand, model, category, kind, child_id, notes on public.items
  for each row
  when (
    old.nickname is distinct from new.nickname
    or old.brand is distinct from new.brand
    or old.model is distinct from new.model
    or old.category is distinct from new.category
    or old.kind is distinct from new.kind
    or old.child_id is distinct from new.child_id
    or old.notes is distinct from new.notes
  )
  execute function public.atlas_forget_item();

create function public.atlas_forget_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.task_facets where task_id = new.id;
  return new;
end;
$$;

create trigger tasks_atlas_forget
  after update of title, details on public.tasks
  for each row
  when (old.title is distinct from new.title or old.details is distinct from new.details)
  execute function public.atlas_forget_task();

-- A child added, renamed or removed changes the "who it's for" options.
create function public.atlas_forget_whose()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.item_facets
  where lens = 'whose' and household_id = coalesce(new.household_id, old.household_id);
  return coalesce(new, old);
end;
$$;

create trigger children_atlas_forget
  after insert or delete or update of nickname on public.children
  for each row execute function public.atlas_forget_whose();

revoke execute on function public.atlas_forget_item() from public, anon;
revoke execute on function public.atlas_forget_task() from public, anon;
revoke execute on function public.atlas_forget_whose() from public, anon;
