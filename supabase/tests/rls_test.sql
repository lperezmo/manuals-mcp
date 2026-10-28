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

reset role;
\echo 'rls_test: all checks passed'
