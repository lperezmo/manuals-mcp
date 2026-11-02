-- The credit tracker on the Model log is for whoever runs the site, not for
-- every signed-in account (the judges share one). The spend totals now come
-- back only for accounts on app_admins; anyone else gets no rows and the page
-- shows no credit cards. Add an admin by hand, once per project:
--   insert into public.app_admins (user_id)
--   select id from auth.users where email = '<the owner''s email>';

create table public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- No policies: nobody reads or writes it from the browser.
alter table public.app_admins enable row level security;

create function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

revoke all on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;

-- Totals per model, admins only, now with the runs that succeeded (an image
-- that came back counts toward the image cap; a failed one isn't billed).
drop function public.model_spend_all();

create function public.model_spend_all()
returns table (
  model text,
  runs bigint,
  ok_runs bigint,
  tokens_in bigint,
  tokens_out bigint,
  first_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    r.model,
    count(*),
    count(*) filter (where r.ok),
    coalesce(sum(r.tokens_in), 0)::bigint,
    coalesce(sum(r.tokens_out), 0)::bigint,
    min(r.created_at)
  from public.model_runs r
  where r.model is not null and public.is_app_admin()
  group by r.model;
$$;

revoke all on function public.model_spend_all() from public, anon;
grant execute on function public.model_spend_all() to authenticated;
