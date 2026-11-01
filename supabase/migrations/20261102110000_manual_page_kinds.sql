-- Manual atlas: each manual page gets a kind (safety, setup, use, care, fix,
-- parts, warranty, another language, other), chosen by Jev while the manual is
-- read. The thing's page shows a strip of jump links by kind, and ask_manual
-- can search only the "fix" pages for a fault. Additive: two nullable columns,
-- an index and a new search function. Pages read before this have no kind and
-- simply don't show in the strip.

alter table public.manual_pages
  add column kind text check (
    kind in ('safety', 'setup', 'use', 'care', 'fix', 'parts', 'warranty', 'language', 'other')
  ),
  add column kind_p real check (kind_p >= 0 and kind_p <= 1);

create index manual_pages_kind_idx on public.manual_pages (manual_id, kind) where kind is not null;

-- Full-text search over one kind of page (RLS applies, like search_manual_pages).
create function public.search_manual_pages_of_kind(
  query text,
  p_kind text,
  p_item uuid default null,
  max_results integer default 5
)
returns table (
  manual_id uuid,
  item_id uuid,
  item_name text,
  page_number integer,
  kind text,
  snippet text,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (select websearch_to_tsquery('english', query) as tsq)
  select p.manual_id, m.item_id, i.nickname, p.page_number, p.kind,
    ts_headline('english', p.content, q.tsq,
      'MaxFragments=2, MinWords=12, MaxWords=40, StartSel=**, StopSel=**'),
    ts_rank(p.fts, q.tsq)
  from public.manual_pages p
  join public.manuals m on m.id = p.manual_id
  join public.items i on i.id = m.item_id
  cross join q
  where p.fts @@ q.tsq and p.kind = p_kind and (p_item is null or m.item_id = p_item)
  order by ts_rank(p.fts, q.tsq) desc
  limit least(greatest(max_results, 1), 20);
$$;

revoke execute on function public.search_manual_pages_of_kind(text, text, uuid, integer) from public, anon;
grant execute on function public.search_manual_pages_of_kind(text, text, uuid, integer) to authenticated;
