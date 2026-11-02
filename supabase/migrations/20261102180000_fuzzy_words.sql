-- Fuzzy manual search: a misspelled word ("flote", "overfil") is matched to the
-- closest word that really appears in the manual's pages, by trigram
-- similarity, and the search runs again with that word. Runs as the caller, so
-- it only sees their household's pages.

create extension if not exists pg_trgm with schema extensions;

create function public.closest_manual_words(p_item uuid, p_words text[])
returns table (word text, closest text, similarity real)
language sql
stable
security invoker
set search_path = ''
as $$
  with vocab as (
    select distinct lower(w) as v
    from public.manual_pages p
    join public.manuals m on m.id = p.manual_id,
    lateral regexp_split_to_table(p.content, '[^A-Za-z0-9]+') as w
    where (p_item is null or m.item_id = p_item) and length(w) >= 3
  )
  select q.word, best.v, best.s
  from unnest(p_words) as q(word)
  cross join lateral (
    select v, extensions.similarity(v, lower(q.word)) as s
    from vocab
    order by extensions.similarity(v, lower(q.word)) desc
    limit 1
  ) as best;
$$;

grant execute on function public.closest_manual_words(uuid, text[]) to authenticated;
