-- Household invites and copying a shared thing. Run after the migrations
-- (on a fresh database with stub_supabase.sql); any failure raises.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'carla@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'dev@example.com'),
  ('00000000-0000-0000-0000-0000000000e1', 'eve@example.com');

set role authenticated;

-- Carla fills her home and makes an invite and a share link.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', false);
select public.load_demo_household();
update public.manual_facts set value = 'Fixed by Carla', source = 'user', status = 'revised'
where label = (select label from public.manual_facts order by label limit 1);
insert into public.household_invites (code) values ('invite-c1');
insert into public.item_shares (code, item_id) select 'share-washer', id from public.items where nickname = 'Washer';

-- Dev sees the preview, joins, sees Carla's things, and can add to them.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', false);
do $$
declare
  p jsonb := public.invite_preview('invite-c1');
  n integer;
begin
  assert p ->> 'invited_by' = 'carla@example.com', format('preview %s', p);
  assert (p ->> 'usable')::boolean, 'invite should be usable';
  select count(*) into n from public.items;
  assert n = 0, 'Dev starts with an empty home';
  perform public.accept_invite('invite-c1');
  select count(*) into n from public.items;
  assert n = 3, format('Dev should see Carla''s 3 things, saw %s', n);
  insert into public.items (nickname) values ('Dev''s kettle');
  select count(*) into n from public.household_people();
  assert n = 2, 'two people in the home';
  begin
    perform public.accept_invite('invite-c1');
    raise exception 'an invite should only work once';
  exception when raise_exception then
    if sqlerrm not like '%expired or was already used%' then raise; end if;
  end;
end;
$$;

-- Eve can't use the spent invite and can't see Carla's home.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', false);
do $$
declare
  n integer;
  new_item uuid;
  p jsonb := public.shared_item_preview('share-washer');
begin
  assert not (public.invite_preview('invite-c1') ->> 'usable')::boolean, 'spent invite is not usable';
  select count(*) into n from public.household_invites;
  assert n = 0, 'Eve should not see Carla''s invites';
  assert p ->> 'model' = 'BW-4100' and not (p ? 'serial'), format('share preview %s', p);

  -- Eve copies the washer: schedule, facts and Carla's correction come along.
  new_item := public.copy_shared_item('share-washer');
  select count(*) into n from public.items;
  assert n = 1, format('Eve should have 1 thing, saw %s', n);
  select count(*) into n from public.tasks where item_id = new_item and next_due_on is not null;
  assert n > 0, 'copied tasks get due dates';
  select count(*) into n from public.manual_facts where item_id = new_item and value = 'Fixed by Carla';
  assert n = 1, 'the correction comes along';
  select count(*) into n from public.manuals where item_id = new_item and storage_path is null;
  assert n = 1, 'one manual, no stored PDF';
end;
$$;

-- Carla sees one copy made, removes Dev, and Dev is back in his own home.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', false);
do $$
declare
  n integer;
begin
  select copies into n from public.item_shares where code = 'share-washer';
  assert n = 1, format('one copy, saw %s', n);
  begin
    perform public.leave_household();
    raise exception 'owners should not leave their own home';
  exception when raise_exception then
    if sqlerrm not like '%your own home%' then raise; end if;
  end;
  perform public.remove_member('00000000-0000-0000-0000-0000000000d1');
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', false);
do $$
declare
  n integer;
begin
  select count(*) into n from public.items;
  assert n = 0, format('Dev should be back in his own empty home, saw %s', n);
end;
$$;

reset role;
