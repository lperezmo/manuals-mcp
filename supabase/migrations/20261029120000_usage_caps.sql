-- Label photos are logged as model runs too, so they count toward the caps.

alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check check (kind in ('read', 'chat', 'search', 'snap'));

create index model_runs_time on public.model_runs (created_at desc);

-- Model calls across every household in the last day. Members only see their
-- own runs, so the site-wide budget needs this one count from above RLS.
create function public.model_runs_today_all()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.model_runs
  where kind in ('read', 'chat', 'snap') and created_at > now() - interval '1 day';
$$;

revoke all on function public.model_runs_today_all() from public, anon;
grant execute on function public.model_runs_today_all() to authenticated;
