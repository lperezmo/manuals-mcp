-- Model spend: tokens per model across every household, for the credit
-- tracker on the Model log page. The credits (Baseten for Muse, TypeSafe for
-- Jev) are shared by the whole site, and members only see their own runs, so
-- this one total comes from above RLS. Counts only, nothing per household.

create function public.model_spend_all()
returns table (model text, runs bigint, tokens_in bigint, tokens_out bigint, first_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select
    r.model,
    count(*),
    coalesce(sum(r.tokens_in), 0)::bigint,
    coalesce(sum(r.tokens_out), 0)::bigint,
    min(r.created_at)
  from public.model_runs r
  where r.model is not null
  group by r.model;
$$;

revoke all on function public.model_spend_all() from public, anon;
grant execute on function public.model_spend_all() to authenticated;
