-- Issue reports from the website's "Report an issue" button. The server also
-- pushes each one to the maintainer's phone (NTFY_TOPIC); this table is the
-- lasting record.

create table public.issue_reports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  message text not null check (length(message) between 1 and 2000),
  -- Where it happened, and the model run it is about when there is one.
  page text check (length(page) <= 200),
  run_id uuid,
  debug text check (length(debug) <= 20000),
  user_agent text check (length(user_agent) <= 400),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index issue_reports_household_time on public.issue_reports (household_id, created_at desc);

alter table public.issue_reports enable row level security;

-- Members file and read their household's reports; nobody edits or deletes
-- them from the browser, so the daily cap holds.
create policy "members read reports" on public.issue_reports
  for select to authenticated using (public.is_member(household_id));
create policy "members file reports" on public.issue_reports
  for insert to authenticated with check (public.is_member(household_id));
