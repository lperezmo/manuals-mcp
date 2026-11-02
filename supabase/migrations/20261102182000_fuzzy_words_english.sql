-- Fuzzy words, take two: pages marked as another language ("filtre") leave the
-- vocabulary, and on a tie the word the manual uses most wins over trigram
-- similarity.

drop function public.closest_manual_words(uuid, text[]);

create function public.closest_manual_words(p_item uuid, p_words text[])
returns table (word text, closest text, similarity real, edits integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with vocab as (
    select lower(w) as v, count(*) as n
    from public.manual_pages p
    join public.manuals m on m.id = p.manual_id,
    lateral regexp_split_to_table(p.content, '[^A-Za-z0-9]+') as w
    where (p_item is null or m.item_id = p_item)
      and length(w) >= 3
      and p.kind is distinct from 'language'
    group by lower(w)
  )
  select q.word, best.v, best.s, best.e
  from unnest(p_words) as q(word)
  cross join lateral (
    select
      v,
      extensions.similarity(v, lower(q.word)) as s,
      extensions.levenshtein(v, lower(q.word)) as e
    from vocab
    where extensions.levenshtein(v, lower(q.word)) <= 3
    order by
      (extensions.dmetaphone(v) = extensions.dmetaphone(lower(q.word))) desc,
      extensions.levenshtein(v, lower(q.word)),
      n desc,
      extensions.similarity(v, lower(q.word)) desc
    limit 1
  ) as best;
$$;

grant execute on function public.closest_manual_words(uuid, text[]) to authenticated;
