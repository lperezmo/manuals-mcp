-- Checks that households can't see each other and that the schedule math
-- works. Run after stub_supabase.sql, the migrations and example_home.sql; any failure raises.

\set ON_ERROR_STOP on

insert into public.allowed_emails (email) values ('a@example.com'), ('b@example.com');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

-- New accounts are closed: an email that isn't on the list can't sign up.
do $$
begin
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'stranger@example.com');
  raise exception 'a stranger should not be able to sign up';
exception when others then
  if sqlerrm <> 'New accounts are closed' then raise; end if;
end;
$$;

set role authenticated;

-- User A loads the example home.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
select public.load_example_home();

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

-- The example home: pages are searchable, review items and history exist,
-- and loading it twice adds nothing.
select public.load_example_home();

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
    perform public.fill_example_home(a_household);
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

-- A thing's photo: A sets one, B can't see, add, or point at it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
do $$
declare
  hid uuid := public.current_household_id();
  wid uuid;
begin
  select id into wid from public.items order by created_at limit 1;
  insert into storage.objects (bucket_id, name) values ('item-photos', hid || '/' || wid || '-1.jpg');
  update public.items set photo_path = hid || '/' || wid || '-1.jpg' where id = wid;
  assert (select count(*) from public.items where photo_path is not null) = 1, 'user A should see their photo path';
  assert (select count(*) from storage.objects where bucket_id = 'item-photos') = 1, 'user A should see their photo';
  begin
    update public.items set photo_path = gen_random_uuid() || '/x.jpg' where id = wid;
    raise exception 'a photo path outside the household was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
do $$
declare
  n integer;
  a_household uuid;
begin
  select count(*) into n from storage.objects where bucket_id = 'item-photos';
  assert n = 0, 'user B can see A''s thing photos';

  reset role;
  select household_id into a_household from public.household_members
    where user_id = '00000000-0000-0000-0000-00000000000a';
  set role authenticated;

  begin
    insert into storage.objects (bucket_id, name) values ('item-photos', a_household || '/sneaky.jpg');
    raise exception 'user B uploaded into A''s photo folder';
  exception when insufficient_privilege then
    null;
  end;
  delete from storage.objects where bucket_id = 'item-photos';
  get diagnostics n = row_count;
  assert n = 0, 'user B deleted A''s thing photo';
end;
$$;

-- House memory: A's notes are A's household's only, and the same words save once.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
do $$
declare
  wid uuid;
  n integer;
begin
  select id into wid from public.items where nickname = 'Washer' limit 1;
  insert into public.household_notes (note, p) values ('We have really hard water.', 0.86);
  insert into public.household_notes (item_id, note, p) values (wid, 'We only run it on weekends.', 0.7);
  begin
    insert into public.household_notes (note) values ('we have really hard water.');
    raise exception 'the same note should save once';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.household_notes (note) values ('   ');
    raise exception 'a blank note should be refused';
  exception when check_violation then
    null;
  end;
  select count(*) into n from public.household_notes;
  assert n = 2, format('user A should see 2 notes, saw %s', n);
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);
do $$
declare
  n integer;
  a_household uuid;
begin
  select count(*) into n from public.household_notes;
  assert n = 0, 'user B can read A''s notes';
  delete from public.household_notes;

  reset role;
  select household_id into a_household from public.household_members
    where user_id = '00000000-0000-0000-0000-00000000000a';
  select count(*) into n from public.household_notes where household_id = a_household;
  assert n = 2, 'user B deleted A''s notes';
  set role authenticated;

  begin
    insert into public.household_notes (household_id, note) values (a_household, 'Sneaky');
    raise exception 'user B wrote a note into A''s household';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- A forgets one note from the household page.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
do $$
declare
  n integer;
begin
  delete from public.household_notes where note = 'We only run it on weekends.';
  select count(*) into n from public.household_notes;
  assert n = 1, format('user A should have 1 note left, saw %s', n);
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
end;
$$;

reset role;

-- Back history: user A saves a washer's past and a catch-up step, logs a
-- plan run, and user B sees none of it.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);

do $$
declare
  wid uuid;
  n integer;
begin
  select id into wid from public.items where nickname = 'Washer' limit 1;
  update public.items set condition = 'stored', idle_months = 24, history_note = 'never touched',
    upkeep_goal = 'keep_running', caught_up_at = now(), catch_up_summary = 'Flush it first.'
  where id = wid;
  insert into public.tasks (item_id, title, interval_unit, next_due_on, catch_up, status)
  values (wid, 'Flush the drain pump before the first load', 'once', current_date, true, 'needs_review');
  insert into public.model_runs (kind, ok, item_id) values ('plan', true, wid);
  select count(*) into n from public.tasks where catch_up;
  assert n = 1, 'catch-up step missing';
  begin
    update public.items set condition = 'broken' where id = wid;
    raise exception 'condition should only take new, used or stored';
  exception when check_violation then
    null;
  end;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', false);

do $$
declare
  n integer;
begin
  select count(*) into n from public.tasks where catch_up;
  assert n = 0, 'user B should not see A''s catch-up steps';
  select count(*) into n from public.items where condition is not null;
  assert n = 0, 'user B should not see A''s history';
end;
$$;

reset role;

\echo 'rls_test: all checks passed'
