-- House Atlas tables: households can't see each other's sorts or views, and a
-- sort is forgotten when the words it came from change. Run after
-- stub_supabase.sql and the migrations; any failure raises.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'f1@example.com'),
  ('00000000-0000-0000-0000-0000000000f2', 'f2@example.com');

set role authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', false);
select public.ensure_household();

do $$
declare
  wid uuid;
  tid uuid;
  n integer;
begin
  insert into public.items (nickname, category) values ('Washer', 'washer') returning id into wid;
  insert into public.tasks (item_id, title, interval_unit, interval_value)
    values (wid, 'Clean the drain pump filter', 'months', 1) returning id into tid;
  insert into public.item_facets (item_id, lens, value, p) values
    (wid, 'room', 'laundry', 0.9), (wid, 'room', 'basement', 0.4),
    (wid, 'system', 'water', 0.95), (wid, 'whose', 'anyone', 0.8);
  insert into public.task_facets (task_id, lens, value, p) values
    (tid, 'effort', 'fifteen_minutes', 0.9), (tid, 'season', 'any_time', 0.9);
  insert into public.saved_views (phrase, scores) values ('Uses water', jsonb_build_object(wid::text, 0.99));

  -- Due dates move without touching the sort.
  update public.tasks set next_due_on = current_date + 3 where id = tid;
  update public.items set uses_per_week = 5, pinned = true where id = wid;
  select count(*) into n from public.item_facets where item_id = wid;
  assert n = 4, format('an unrelated change cleared the sort (%s left)', n);
  select count(*) into n from public.task_facets where task_id = tid;
  assert n = 2, 'a due date change cleared the task sort';

  -- New words, new sort.
  update public.items set notes = 'In the basement now' where id = wid;
  select count(*) into n from public.item_facets where item_id = wid;
  assert n = 0, 'changing the notes kept the old sort';
  update public.tasks set title = 'Clean the pump filter' where id = tid;
  select count(*) into n from public.task_facets where task_id = tid;
  assert n = 0, 'changing the title kept the old task sort';

  -- A new child changes who things can be for.
  insert into public.item_facets (item_id, lens, value, p) values
    (wid, 'room', 'laundry', 0.9), (wid, 'whose', 'anyone', 0.8);
  insert into public.children (nickname) values ('Rio');
  select count(*) into n from public.item_facets where item_id = wid and lens = 'whose';
  assert n = 0, 'a new child kept the old "who it''s for" sort';
  select count(*) into n from public.item_facets where item_id = wid and lens = 'room';
  assert n = 1, 'a new child cleared the room sort too';

  -- Lenses are checked.
  begin
    insert into public.item_facets (item_id, lens, value, p) values (wid, 'effort', 'pro', 0.5);
    raise exception 'a task lens was accepted on a thing';
  exception when check_violation then null;
  end;
end;
$$;

-- The other household sees none of it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', false);
select public.ensure_household();

do $$
declare
  n integer;
begin
  select count(*) into n from public.item_facets;
  assert n = 0, format('household 2 sees %s of household 1''s sorts', n);
  select count(*) into n from public.saved_views;
  assert n = 0, 'household 2 sees household 1''s views';
  -- Writing a sort onto someone else's thing is refused.
  begin
    insert into public.item_facets (household_id, item_id, lens, value, p)
      select i.household_id, i.id, 'room', 'garage', 0.9 from public.items i limit 1;
    select count(*) into n from public.item_facets;
    assert n = 0, 'household 2 wrote a sort it can then see';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
end;
$$;

-- Manual atlas: page kinds, and searching only one kind of page.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', false);
do $$
declare
  wid uuid;
  mid uuid;
  n integer;
begin
  select id into wid from public.items where nickname = 'Washer';
  insert into public.manuals (item_id, title, source) values (wid, 'Washer manual', 'pdf_upload')
    returning id into mid;
  insert into public.manual_pages (manual_id, page_number, content) values
    (mid, 18, 'Clean the drain pump filter once a month, the filter is behind the lower panel.'),
    (mid, 31, 'Troubleshooting: if the drain pump filter is clogged the washer shows F9 E1.'),
    (mid, 40, 'Warranty: parts and labor for one year.');
  update public.manual_pages set kind = 'care', kind_p = 0.9 where manual_id = mid and page_number = 18;
  update public.manual_pages set kind = 'fix', kind_p = 0.85 where manual_id = mid and page_number = 31;

  select count(*) into n from public.search_manual_pages_of_kind('drain pump filter', 'fix', wid);
  assert n = 1, format('a fix search found %s pages, not just the troubleshooting one', n);
  select count(*) into n from public.search_manual_pages('drain pump filter', wid);
  assert n = 2, 'the plain search changed';

  begin
    update public.manual_pages set kind = 'recipe' where manual_id = mid and page_number = 40;
    raise exception 'an unknown page kind was accepted';
  exception when check_violation then null;
  end;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', false);
do $$
declare
  n integer;
begin
  select count(*) into n from public.search_manual_pages_of_kind('drain pump filter', 'fix');
  assert n = 0, 'household 2 finds household 1''s manual pages';
end;
$$;

-- Deleting the thing deletes its sort.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', false);
do $$
declare
  n integer;
begin
  delete from public.items where nickname = 'Washer';
  select count(*) into n from public.item_facets;
  assert n = 0, 'a deleted thing left its sort behind';
  select count(*) into n from public.task_facets;
  assert n = 0, 'a deleted thing left its task sorts behind';
end;
$$;

reset role;
\echo atlas_test ok
