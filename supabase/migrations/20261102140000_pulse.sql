-- Household Pulse (issue #19): the home page's few "worth doing now" lines,
-- picked by one Jev call over what's coming up (server/src/pulse.ts). Pulse is
-- worked out on read, so the only thing it keeps is what the household put
-- off: "Not now" hides one line until a date. The key names the event and its
-- date (task:<id>:<due date>, warranty:<item id>:<end date>), so a task done
-- and due again is a new event and can show again.

create table public.pulse_snoozes (
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  event_key text not null check (length(event_key) between 1 and 200),
  -- Shown again from this day.
  until date not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, event_key)
);

alter table public.pulse_snoozes enable row level security;

create policy "household members" on public.pulse_snoozes
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- A Pulse refresh that asked Jev is logged like an instant answer. It is not
-- a Muse call, so model_runs_today_all leaves it out of the daily budget.
alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check
  check (kind in ('read', 'chat', 'search', 'snap', 'plan', 'fast', 'pulse'));

-- Demo reset also clears what judges put off.
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
  delete from public.pulse_snoozes where household_id = hid;
  delete from public.household_notes where household_id = hid;
  delete from public.items where household_id = hid;
  delete from public.children where household_id = hid;
  delete from public.revisions where household_id = hid;
  perform public.fill_demo_household(hid);
end;
$$;

revoke execute on function public.reset_demo_household(uuid) from public, anon, authenticated;
