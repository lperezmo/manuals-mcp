-- Model runs: one row per manual read or chat turn, for debugging and the
-- daily chat cap. Demo households reset to the demo data every night.

-- ---------------------------------------------------------------------------
-- Model runs
-- ---------------------------------------------------------------------------

create table public.model_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  kind text not null check (kind in ('read', 'chat')),
  -- Reads: the manual and item. Plain ids, so the log outlives a reset.
  item_id uuid,
  manual_id uuid,
  model text,
  ok boolean not null,
  error text,
  ms integer,
  tokens_in integer,
  tokens_out integer,
  -- Reads: the pages sent and how much text. Chats: the tools used.
  pages_sent integer[],
  chars_sent integer,
  tools_used text[],
  -- Reads: the model's raw answer (capped), to see why a manual came out odd.
  raw_output text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index model_runs_household_time on public.model_runs (household_id, created_at desc);

alter table public.model_runs enable row level security;

-- Members read and add their household's runs; nobody edits or deletes them,
-- so the chat cap can't be reset from the browser.
create policy "members read runs" on public.model_runs
  for select to authenticated using (public.is_member(household_id));
create policy "members add runs" on public.model_runs
  for insert to authenticated with check (public.is_member(household_id));

-- ---------------------------------------------------------------------------
-- Demo households
-- ---------------------------------------------------------------------------

alter table public.households add column is_demo boolean not null default false;

-- Puts a demo household back to the demo data: whatever judges added, logged
-- or revised is cleared. Model runs stay, so the chat cap still holds.
create function public.reset_demo_household(hid uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from public.households where id = hid and is_demo) then
    raise exception 'Household % is not a demo household.', hid;
  end if;
  delete from public.items where household_id = hid;
  delete from public.children where household_id = hid;
  delete from public.revisions where household_id = hid;
  perform public.fill_demo_household(hid);
end;
$$;

create function public.reset_demo_households()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  hid uuid;
begin
  for hid in select id from public.households where is_demo loop
    perform public.reset_demo_household(hid);
  end loop;
end;
$$;

-- Only the database owner (and so the nightly job) may reset.
revoke execute on function public.reset_demo_household(uuid) from public, anon, authenticated;
revoke execute on function public.reset_demo_households() from public, anon, authenticated;

-- Nightly at 08:00 UTC (3 or 4 AM Eastern). Skipped where pg_cron isn't
-- available, like the plain Postgres the SQL tests run on.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('reset-demo-households', '0 8 * * *', 'select public.reset_demo_households()');
  end if;
end;
$$;
