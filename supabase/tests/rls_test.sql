-- Checks that households can't see each other and that the schedule math
-- works. Run after stub_supabase.sql and the migrations; any failure raises.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

set role authenticated;

-- User A loads the demo household.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
select public.load_demo_household();

do $$
declare
  n integer;
  t public.tasks;
  wid uuid;
begin
  select count(*) into n from public.items;
  assert n = 3, format('user A should see 3 items, saw %s', n);

  -- Cycle task: 30 washes at 6 a week is 35 days.
  select * into t from public.tasks where title = 'Run the tub clean cycle';
  assert t.next_due_on = current_date + 35, format('tub clean due %s', t.next_due_on);

  -- Monthly task logged today moves a month out.
  select id into wid from public.tasks where title = 'Wipe the door gasket';
  t := public.log_task_done(wid);
  assert t.next_due_on = (current_date + interval '1 month')::date, 'monthly task did not advance';
  assert t.last_done_on = current_date, 'last_done_on not set';
  select count(*) into n from public.task_log where task_id = wid;
  assert n = 1, 'task_log row missing';
end;
$$;

-- The demo household: pages are searchable, review items and history exist,
-- and loading it twice adds nothing.
select public.load_demo_household();

do $$
declare
  n integer;
  p integer;
begin
  select count(*), min(page_number) into n, p from public.search_manual_pages('tub clean');
  assert n = 1 and p = 41, format('search found %s page(s), first %s', n, p);
  select count(*) into n from public.manual_facts where kind = 'error_code' and label ilike 'e4';
  assert n = 1, 'error code E4 missing';
  select (select count(*) from public.tasks where status = 'needs_review')
       + (select count(*) from public.seat_modes where status = 'needs_review')
       + (select count(*) from public.manual_facts where status = 'needs_review') into n;
  assert n = 2, format('expected 2 items to review, saw %s', n);
  select count(*) into n from public.revisions;
  assert n = 1, 'revision history missing';
  select count(*) into n from public.tasks where active and next_due_on < current_date;
  assert n = 1, format('expected 1 overdue task, saw %s', n);
  select count(*) into n from public.items;
  assert n = 3, format('loading twice should not duplicate, saw %s items', n);
end;
$$;

-- User B sees none of it and can't write into A's household.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);

do $$
declare
  n integer;
  a_household uuid;
begin
  select count(*) into n from public.items;
  assert n = 0, format('user B should see 0 items, saw %s', n);
  select count(*) into n from public.manual_pages;
  assert n = 0, 'user B can read A''s manual pages';
  select count(*) into n from public.search_manual_pages('tub clean');
  assert n = 0, 'user B can search A''s manual pages';

  reset role;
  select household_id into a_household from public.household_members
    where user_id = '00000000-0000-0000-0000-00000000000a';
  set role authenticated;

  begin
    insert into public.items (household_id, nickname) values (a_household, 'Sneaky');
    raise exception 'user B wrote into A''s household';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.fill_demo_household(a_household);
    raise exception 'user B filled A''s household';
  exception when insufficient_privilege then
    null;
  end;

  -- B's own household works.
  insert into public.items (nickname) values ('Kettle');
  select count(*) into n from public.items;
  assert n = 1, 'user B should see their own item';
end;
$$;

-- Receipts and their photos: A saves one, B can't see or add to it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
do $$
declare
  hid uuid := public.current_household_id();
  wid uuid;
begin
  select id into wid from public.items order by created_at limit 1;
  insert into public.receipts (item_id, purchased_on, store, price, currency, warranty_months)
  values (wid, current_date - 100, 'Appliance Barn', 899.99, 'USD', 12);
  insert into storage.objects (bucket_id, name) values ('receipts', hid || '/r.jpg');
  assert (select count(*) from public.receipts) = 1, 'user A should see their receipt';
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
do $$
declare
  n integer;
  a_household uuid;
  a_item uuid;
begin
  select count(*) into n from public.receipts;
  assert n = 0, 'user B can read A''s receipts';
  select count(*) into n from storage.objects where bucket_id = 'receipts';
  assert n = 0, 'user B can see A''s receipt photos';

  reset role;
  select household_id into a_household from public.household_members
    where user_id = '00000000-0000-0000-0000-00000000000a';
  select id into a_item from public.items where household_id = a_household limit 1;
  set role authenticated;

  begin
    insert into public.receipts (household_id, item_id, store) values (a_household, a_item, 'Sneaky');
    raise exception 'user B wrote a receipt into A''s household';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('receipts', a_household || '/sneaky.jpg');
    raise exception 'user B uploaded into A''s receipts folder';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- Model runs: members log and read their own; nobody can delete them.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
insert into public.model_runs (kind, ok, model) values ('chat', true, 'test');
do $$
declare
  n integer;
begin
  select count(*) into n from public.model_runs;
  assert n = 1, 'user A should see their run';
  delete from public.model_runs;
  select count(*) into n from public.model_runs;
  assert n = 1, 'runs should not be deletable';
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
do $$
declare
  n integer;
begin
  select count(*) into n from public.model_runs;
  assert n = 0, 'user B should not see A''s runs';
  begin
    perform public.reset_demo_households();
    raise exception 'users should not be able to reset demo households';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- Demo reset: user A's household goes back to the demo data.
do $$
declare
  hid uuid;
  before_items integer;
  n integer;
begin
  select household_id into hid from public.household_members
  where user_id = '00000000-0000-0000-0000-00000000000a';
  update public.households set is_demo = true where id = hid;
  select count(*) into before_items from public.items where household_id = hid;

  insert into public.items (household_id, nickname) values (hid, 'Judge added this');
  delete from public.tasks where household_id = hid;
  perform public.reset_demo_households();

  select count(*) into n from public.items where household_id = hid;
  assert n = before_items, 'reset should restore the demo items';
  select count(*) into n from public.items where household_id = hid and nickname = 'Judge added this';
  assert n = 0, 'reset should clear what judges added';
  select count(*) into n from public.tasks where household_id = hid;
  assert n > 0, 'reset should restore the tasks';
  select count(*) into n from public.model_runs where household_id = hid;
  assert n = 1, 'reset should keep the model runs';
end;
$$;

\echo 'rls_test: all checks passed'
