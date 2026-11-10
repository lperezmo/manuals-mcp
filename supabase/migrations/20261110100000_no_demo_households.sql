-- The judges' demo household is gone, and so is everything that existed for
-- it: the example data, the nightly reset and the is_demo flag. The database
-- tests bring their own example home (supabase/tests/example_home.sql).

drop function public.reset_demo_households();
drop function public.reset_demo_household(uuid);
drop function public.load_demo_household();
drop function public.fill_demo_household(uuid);

-- Invites no longer check for a demo household.
create or replace function public.invite_preview(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'invited_by', u.email,
    'people', (select count(*) from public.household_members m where m.household_id = i.household_id),
    'things', (select count(*) from public.items t where t.household_id = i.household_id),
    'usable', i.used_at is null and i.expires_at > now(),
    'already_in', public.is_member(i.household_id)
  )
  from public.household_invites i
  left join auth.users u on u.id = i.created_by
  where i.code = p_code;
$$;

create or replace function public.accept_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  inv public.household_invites;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into inv from public.household_invites where code = p_code for update;
  if inv.code is null or inv.used_at is not null or inv.expires_at <= now() then
    raise exception 'That invite link has expired or was already used. Ask for a new one.';
  end if;
  if public.is_member(inv.household_id) then
    raise exception 'You''re already in that home.';
  end if;
  insert into public.household_members (household_id, user_id, role)
  values (inv.household_id, uid, 'member');
  update public.household_invites set used_by = uid, used_at = now() where code = p_code;
  return inv.household_id;
end;
$$;

alter table public.households drop column is_demo;
