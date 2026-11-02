-- Photo markup in the chat: Meta's image model circles a part on the person's
-- photo. Each call is logged as an "image" model run, and the site stops at a
-- hard cap kept under the free credits, counted across every household.

alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check
  check (kind in ('read', 'chat', 'search', 'snap', 'plan', 'fast', 'pulse', 'image'));

-- Every image call that came back with a picture, ever. Members only see their
-- own runs, so the shared cap needs this one count from above RLS.
create function public.image_runs_total()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.model_runs where kind = 'image' and ok;
$$;

revoke all on function public.image_runs_total() from public, anon;
grant execute on function public.image_runs_total() to authenticated;
