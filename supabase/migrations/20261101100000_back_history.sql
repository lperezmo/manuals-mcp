-- Back history for things that aren't new: a washer used for years with no
-- upkeep, or an AC coming out of two years in storage. What the owner says
-- about it is kept on the item, Muse turns it into a catch-up plan, and the
-- plan's one-time steps are marked so a second plan replaces them.

alter table public.items
  -- new, used (in service for a while) or stored (coming out of storage).
  add column if not exists condition text check (condition in ('new', 'used', 'stored')),
  add column if not exists age_years numeric(4, 1) check (age_years >= 0 and age_years <= 100),
  -- Months since it was last used: 0 means it's in use now.
  add column if not exists idle_months integer check (idle_months >= 0 and idle_months <= 1200),
  -- What has been done, in the owner's own words.
  add column if not exists history_note text check (length(history_note) <= 1000),
  add column if not exists upkeep_goal text check (upkeep_goal in ('keep_running', 'like_new', 'bare_minimum')),
  -- The last catch-up plan: when, and Muse's one or two sentence summary.
  add column if not exists caught_up_at timestamptz,
  add column if not exists catch_up_summary text check (length(catch_up_summary) <= 1000);

-- One-time steps from a catch-up plan (recommission, first clean in years).
alter table public.tasks add column if not exists catch_up boolean not null default false;

create index if not exists tasks_catch_up_idx on public.tasks (item_id) where catch_up;

-- Catch-up plans are model calls too, so they count toward the caps.
alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check check (kind in ('read', 'chat', 'search', 'snap', 'plan'));

create or replace function public.model_runs_today_all()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.model_runs
  where kind in ('read', 'chat', 'snap', 'plan') and created_at > now() - interval '1 day';
$$;

revoke all on function public.model_runs_today_all() from public, anon;
grant execute on function public.model_runs_today_all() to authenticated;
