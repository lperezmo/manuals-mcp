-- manuals-mcp: initial schema.
--
-- Everything hangs off a household, so a partner can join later without a
-- migration. Every table has row-level security keyed on household
-- membership, and the MCP server talks to the database with the signed-in
-- user's own token, so these policies are the whole access story.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Households
-- ---------------------------------------------------------------------------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Home',
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index household_members_user_idx on public.household_members (user_id);

-- True when the signed-in user belongs to the household.
create function public.is_member(h uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = h and m.user_id = (select auth.uid())
  );
$$;

-- The signed-in user's household (the oldest one, until invites exist).
create function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.household_id from public.household_members m
  where m.user_id = (select auth.uid())
  order by m.created_at
  limit 1;
$$;

-- Returns the user's household, creating one if they have none yet
-- (covers accounts created before the sign-up trigger existed).
create function public.ensure_household()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  hid := public.current_household_id();
  if hid is null then
    insert into public.households default values returning id into hid;
    insert into public.household_members (household_id, user_id, role) values (hid, uid, 'owner');
  end if;
  return hid;
end;
$$;

-- Every new account gets its own household.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  insert into public.households default values returning id into hid;
  insert into public.household_members (household_id, user_id, role) values (hid, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Children and measurements (for car seat timing)
-- ---------------------------------------------------------------------------

create table public.children (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  nickname text not null check (length(nickname) between 1 and 60),
  birth_date date,
  -- Only used to pick the WHO growth table. Null means "average both".
  growth_sex text check (growth_sex in ('female', 'male')),
  created_at timestamptz not null default now(),
  unique (household_id, id)
);

create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  child_id uuid not null,
  measured_on date not null default current_date,
  height_cm numeric(5, 1) check (height_cm between 30 and 200),
  weight_kg numeric(5, 2) check (weight_kg between 1 and 100),
  source text not null default 'app' check (source in ('app', 'ai', 'import')),
  created_at timestamptz not null default now(),
  check (height_cm is not null or weight_kg is not null),
  foreign key (household_id, child_id) references public.children (household_id, id) on delete cascade
);

create index measurements_child_idx on public.measurements (child_id, measured_on desc);

-- ---------------------------------------------------------------------------
-- Items, manuals and pages
-- ---------------------------------------------------------------------------

create table public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  kind text not null default 'appliance' check (kind in ('appliance', 'baby_gear', 'vehicle', 'other')),
  -- Free text such as washer, dishwasher, car_seat, crib, stroller.
  category text,
  nickname text not null check (length(nickname) between 1 and 80),
  brand text,
  model text,
  serial text,
  purchased_on date,
  -- How often the thing is used, so "every 30 washes" can become a date.
  uses_per_week numeric(5, 1) check (uses_per_week > 0),
  -- For car seats and other gear that belongs to one child.
  child_id uuid,
  notes text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, child_id) references public.children (household_id, id) on delete set null (child_id)
);

create index items_household_idx on public.items (household_id);
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

create table public.manuals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  title text,
  source text not null check (source in ('pdf_upload', 'url', 'model_number', 'chat_photos', 'chat_text')),
  source_url text,
  -- True when the PDF came from the maker's own site.
  official boolean,
  -- Path inside the private "manuals" storage bucket: <household_id>/<manual_id>.pdf
  storage_path text,
  page_count integer check (page_count > 0),
  status text not null default 'pending'
    check (status in ('pending', 'needs_source', 'text_ready', 'distilled', 'failed')),
  status_detail text,
  -- Who turned the pages into a schedule: this server's model, the user's AI, or the user.
  read_by text check (read_by in ('server', 'client_ai', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade
);

create index manuals_item_idx on public.manuals (item_id);
create trigger manuals_touch before update on public.manuals
  for each row execute function public.touch_updated_at();

-- Raw extracted text, one row per manual page. This is the searchable layer.
create table public.manual_pages (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  manual_id uuid not null,
  page_number integer not null check (page_number > 0),
  content text not null,
  extracted_by text not null default 'pdf_text' check (extracted_by in ('pdf_text', 'server_model', 'client_ai')),
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  unique (manual_id, page_number),
  foreign key (household_id, manual_id) references public.manuals (household_id, id) on delete cascade
);

create index manual_pages_fts_idx on public.manual_pages using gin (fts);

-- Distilled key facts (error codes, capacities, settings), each with its page.
create table public.manual_facts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  manual_id uuid,
  -- What the fact is: lets ask_manual answer "error E4" or "max load" exactly.
  kind text not null default 'other' check (kind in ('error_code', 'part', 'spec', 'safety', 'other')),
  label text not null,
  value text not null,
  source_page integer check (source_page > 0),
  -- Who said it last (reader = the server's model, Muse Spark), and whether it has been checked.
  source text not null default 'reader' check (source in ('reader', 'assistant', 'user')),
  status text not null default 'extracted' check (status in ('extracted', 'needs_review', 'revised', 'confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade,
  foreign key (household_id, manual_id) references public.manuals (household_id, id) on delete set null (manual_id)
);

create index manual_facts_item_idx on public.manual_facts (item_id);
create index manual_facts_review_idx on public.manual_facts (household_id) where status = 'needs_review';
create trigger manual_facts_touch before update on public.manual_facts
  for each row execute function public.touch_updated_at();

-- Car seat limits per mode, straight from the seat's manual.
create table public.seat_modes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  manual_id uuid,
  mode text not null check (mode in ('rear_facing', 'forward_facing', 'booster_high_back', 'booster_backless')),
  min_weight_kg numeric(5, 2),
  max_weight_kg numeric(5, 2),
  min_height_cm numeric(5, 1),
  max_height_cm numeric(5, 1),
  min_age_months integer,
  -- Limits that aren't a number, e.g. "head at least 1 inch below the top of the shell".
  fit_note text,
  source_page integer check (source_page > 0),
  source text not null default 'reader' check (source in ('reader', 'assistant', 'user')),
  status text not null default 'extracted' check (status in ('extracted', 'needs_review', 'revised', 'confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, mode),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade,
  foreign key (household_id, manual_id) references public.manuals (household_id, id) on delete set null (manual_id)
);

create trigger seat_modes_touch before update on public.seat_modes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Upkeep schedule
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  title text not null check (length(title) between 1 and 160),
  details text,
  interval_unit text not null check (interval_unit in ('days', 'weeks', 'months', 'cycles', 'once', 'as_needed')),
  interval_value integer check (interval_value > 0),
  next_due_on date,
  last_done_on date,
  source_manual_id uuid,
  source_page integer check (source_page > 0),
  source text not null default 'reader' check (source in ('reader', 'assistant', 'user')),
  status text not null default 'extracted' check (status in ('extracted', 'needs_review', 'revised', 'confirmed')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  check (interval_unit in ('once', 'as_needed') or interval_value is not null),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade,
  foreign key (household_id, source_manual_id) references public.manuals (household_id, id) on delete set null (source_manual_id)
);

create index tasks_due_idx on public.tasks (household_id, next_due_on) where active;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

create table public.task_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  task_id uuid not null,
  done_on date not null default current_date,
  done_by uuid default auth.uid() references auth.users (id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  foreign key (household_id, task_id) references public.tasks (household_id, id) on delete cascade
);

create index task_log_task_idx on public.task_log (task_id, done_on desc);

-- When is a task next due, counted from a given day?
-- Cycle-based tasks ("every 30 washes") use the item's uses per week; without
-- it there is no date, only the count.
create function public.next_due(unit text, amount integer, from_day date, uses_per_week numeric)
returns date
language sql
immutable
set search_path = ''
as $$
  select case unit
    when 'days' then from_day + amount
    when 'weeks' then from_day + amount * 7
    when 'months' then (from_day + make_interval(months => amount))::date
    when 'cycles' then case when uses_per_week > 0
      then from_day + ceil(amount / uses_per_week * 7)::integer end
    else null
  end;
$$;

create function public.tasks_fill_next_due()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  upw numeric;
begin
  if new.next_due_on is null and new.active and new.interval_unit not in ('once', 'as_needed') then
    select i.uses_per_week into upw from public.items i where i.id = new.item_id;
    new.next_due_on := public.next_due(
      new.interval_unit, new.interval_value, coalesce(new.last_done_on, current_date), upw
    );
  end if;
  return new;
end;
$$;

create trigger tasks_next_due before insert on public.tasks
  for each row execute function public.tasks_fill_next_due();

-- Marks a task done and starts its next interval. Used by the app and the MCP server.
create function public.log_task_done(p_task uuid, p_done_on date default current_date, p_note text default null)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t public.tasks;
  upw numeric;
begin
  select * into t from public.tasks where id = p_task;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  select i.uses_per_week into upw from public.items i where i.id = t.item_id;

  insert into public.task_log (household_id, task_id, done_on, note)
  values (t.household_id, t.id, p_done_on, p_note);

  update public.tasks set
    last_done_on = greatest(coalesce(last_done_on, p_done_on), p_done_on),
    next_due_on = public.next_due(interval_unit, interval_value, p_done_on, upw),
    active = interval_unit <> 'once'
  where id = t.id
  returning * into t;
  return t;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revisions: every change to a fact, task or seat limit, with who and why
-- ---------------------------------------------------------------------------

-- Sources rank user over assistant over reader: an assistant can't overwrite
-- something the user said (enforced in revise_fact).
create table public.revisions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  target_table text not null check (target_table in ('manual_facts', 'tasks', 'seat_modes')),
  target_id uuid not null,
  before jsonb not null,
  after jsonb not null,
  source text not null check (source in ('assistant', 'user')),
  reason text not null check (length(reason) between 1 and 1000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index revisions_target_idx on public.revisions (target_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Item readings: cycle counts and hours, so "every 30 washes" tracks real use
-- ---------------------------------------------------------------------------

create table public.item_readings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null,
  measured_on date not null default current_date,
  kind text not null check (kind in ('cycles', 'hours')),
  value numeric(10, 1) not null check (value >= 0),
  created_at timestamptz not null default now(),
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade
);

create index item_readings_item_idx on public.item_readings (item_id, kind, measured_on desc);

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

-- Full-text search over manual pages the caller can see (RLS applies).
create function public.search_manual_pages(query text, p_item uuid default null, max_results integer default 5)
returns table (
  manual_id uuid,
  item_id uuid,
  item_name text,
  page_number integer,
  snippet text,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (select websearch_to_tsquery('english', query) as tsq)
  select p.manual_id, m.item_id, i.nickname, p.page_number,
    ts_headline('english', p.content, q.tsq,
      'MaxFragments=2, MinWords=12, MaxWords=40, StartSel=**, StopSel=**'),
    ts_rank(p.fts, q.tsq)
  from public.manual_pages p
  join public.manuals m on m.id = p.manual_id
  join public.items i on i.id = m.item_id
  cross join q
  where p.fts @@ q.tsq and (p_item is null or m.item_id = p_item)
  order by ts_rank(p.fts, q.tsq) desc
  limit least(greatest(max_results, 1), 20);
$$;

-- ---------------------------------------------------------------------------
-- Demo data (clearly labelled examples, for an empty home)
-- ---------------------------------------------------------------------------

create function public.load_demo_household()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  hid uuid := public.ensure_household();
  washer uuid;
  dishwasher uuid;
  seat uuid;
  kid uuid;
begin
  insert into public.items (household_id, kind, category, nickname, brand, model, uses_per_week, notes)
  values (hid, 'appliance', 'washer', 'Washer', 'Example brand', 'EXAMPLE-W100', 6, 'Example data')
  returning id into washer;
  insert into public.items (household_id, kind, category, nickname, brand, model, notes)
  values (hid, 'appliance', 'dishwasher', 'Dishwasher', 'Example brand', 'EXAMPLE-D200', 'Example data')
  returning id into dishwasher;
  insert into public.children (household_id, nickname, birth_date)
  values (hid, 'Little one', current_date - 600)
  returning id into kid;
  insert into public.items (household_id, kind, category, nickname, brand, model, child_id, notes)
  values (hid, 'baby_gear', 'car_seat', 'Car seat', 'Example brand', 'EXAMPLE-C300', kid, 'Example data')
  returning id into seat;

  insert into public.tasks (household_id, item_id, title, interval_unit, interval_value, source) values
    (hid, washer, 'Run the tub clean cycle', 'cycles', 30, 'user'),
    (hid, washer, 'Wipe the door gasket', 'months', 1, 'user'),
    (hid, dishwasher, 'Rinse the filter', 'weeks', 2, 'user');

  insert into public.seat_modes (household_id, item_id, mode, min_weight_kg, max_weight_kg, max_height_cm, fit_note)
  values (hid, seat, 'rear_facing', 2.3, 18, 102, 'Example limits, not from a real manual');

  insert into public.measurements (household_id, child_id, measured_on, height_cm, weight_kg)
  values (hid, kid, current_date - 30, 82.0, 11.0);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.children enable row level security;
alter table public.measurements enable row level security;
alter table public.items enable row level security;
alter table public.manuals enable row level security;
alter table public.manual_pages enable row level security;
alter table public.manual_facts enable row level security;
alter table public.seat_modes enable row level security;
alter table public.tasks enable row level security;
alter table public.task_log enable row level security;
alter table public.revisions enable row level security;
alter table public.item_readings enable row level security;

create policy "members read their household" on public.households
  for select to authenticated using (public.is_member(id));
create policy "owners rename their household" on public.households
  for update to authenticated using (
    exists (
      select 1 from public.household_members m
      where m.household_id = id and m.user_id = (select auth.uid()) and m.role = 'owner'
    )
  );

create policy "members see each other" on public.household_members
  for select to authenticated using (public.is_member(household_id));

do $$
declare
  t text;
begin
  foreach t in array array[
    'children', 'measurements', 'items', 'manuals', 'manual_pages', 'manual_facts',
    'seat_modes', 'tasks', 'task_log', 'revisions', 'item_readings'
  ] loop
    execute format(
      'create policy "household members" on public.%I for all to authenticated '
      'using (public.is_member(household_id)) with check (public.is_member(household_id))',
      t
    );
  end loop;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.ensure_household() from public, anon;
grant execute on function public.ensure_household() to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, one folder per household
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('manuals', 'manuals', false)
on conflict (id) do nothing;

create policy "household manuals read" on storage.objects
  for select to authenticated
  using (bucket_id = 'manuals' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household manuals write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'manuals' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household manuals update" on storage.objects
  for update to authenticated
  using (bucket_id = 'manuals' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "household manuals delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'manuals' and public.is_member(((storage.foldername(name))[1])::uuid));

-- ---------------------------------------------------------------------------
-- Realtime: the website hears about new items and tasks right away
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.items, public.tasks;
  end if;
end;
$$;
