-- Sharing, two ways: invite people into your household with a link, and hand
-- anyone a link that copies one thing's manual (schedule, facts, car seat
-- limits and searchable pages) into their own home.

-- ---------------------------------------------------------------------------
-- Households with more than one person
-- ---------------------------------------------------------------------------

-- The household you joined most recently is the one you see. Leaving it puts
-- you back in the one before (every account keeps its own from sign-up).
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.household_id from public.household_members m
  where m.user_id = (select auth.uid())
  order by m.created_at desc
  limit 1;
$$;

-- One-time invite links, good for a week.
create table public.household_invites (
  code text primary key default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  household_id uuid not null default public.current_household_id()
    references public.households (id) on delete cascade,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz
);

create index household_invites_household_idx on public.household_invites (household_id);

alter table public.household_invites enable row level security;

create policy "members manage invites" on public.household_invites
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- What the join page shows before you accept: who invited you, and whether
-- the link still works. Anyone signed in with the code can see this much.
create function public.invite_preview(p_code text)
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
    'usable', i.used_at is null and i.expires_at > now() and not h.is_demo,
    'already_in', public.is_member(i.household_id)
  )
  from public.household_invites i
  join public.households h on h.id = i.household_id
  left join auth.users u on u.id = i.created_by
  where i.code = p_code;
$$;

create function public.accept_invite(p_code text)
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
  if exists (select 1 from public.households where id = inv.household_id and is_demo) then
    raise exception 'The example home can''t be joined.';
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

-- Everyone in your current household, with emails (auth.users is private).
create function public.household_people()
returns table (user_id uuid, email text, role text, is_me boolean, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.user_id = (select auth.uid()), m.created_at
  from public.household_members m
  left join auth.users u on u.id = m.user_id
  where m.household_id = public.current_household_id()
  order by m.created_at;
$$;

-- The owner can take someone out of the household.
create function public.remove_member(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
begin
  if not exists (
    select 1 from public.household_members
    where household_id = hid and user_id = (select auth.uid()) and role = 'owner'
  ) then
    raise exception 'Only the person who made this home can remove people.';
  end if;
  delete from public.household_members where household_id = hid and user_id = p_user and role = 'member';
end;
$$;

-- A member leaves the household they joined; owners stay with their own.
create function public.leave_household()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
begin
  delete from public.household_members
  where household_id = hid and user_id = (select auth.uid()) and role = 'member';
  if not found then
    raise exception 'This is your own home, so there''s nothing to leave.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Copying a thing's manual into someone else's home
-- ---------------------------------------------------------------------------

-- One link per thing, until its owner stops sharing it.
create table public.item_shares (
  code text primary key default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  household_id uuid not null default public.current_household_id(),
  item_id uuid not null unique,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  copies integer not null default 0,
  foreign key (household_id, item_id) references public.items (household_id, id) on delete cascade
);

alter table public.item_shares enable row level security;

create policy "members manage shares" on public.item_shares
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- What a share link offers. Never the serial number, notes or history.
create function public.shared_item_preview(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'nickname', i.nickname,
    'brand', i.brand,
    'model', i.model,
    'category', i.category,
    'kind', i.kind,
    'icon', i.icon,
    'tint', i.tint,
    'manual', (select m.title from public.manuals m where m.item_id = i.id order by m.created_at limit 1),
    'pages', (select count(*) from public.manual_pages p join public.manuals m on m.id = p.manual_id where m.item_id = i.id),
    'tasks', (select count(*) from public.tasks t where t.item_id = i.id and t.active),
    'facts', (select count(*) from public.manual_facts f where f.item_id = i.id),
    'seat_modes', (select count(*) from public.seat_modes s where s.item_id = i.id),
    'corrected', (
      (select count(*) from public.manual_facts f where f.item_id = i.id and f.source <> 'reader')
      + (select count(*) from public.tasks t where t.item_id = i.id and t.source <> 'reader')
      + (select count(*) from public.seat_modes s where s.item_id = i.id and s.source <> 'reader')
    )
  )
  from public.item_shares sh
  join public.items i on i.id = sh.item_id
  where sh.code = p_code;
$$;

-- Adds a copy of the shared thing to your home and returns its id. The stored
-- PDF stays with the sharer; the pages' text comes along, so it's searchable.
create function public.copy_shared_item(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
  src public.items;
  new_item uuid;
  m public.manuals;
  new_manual uuid;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select i.* into src from public.item_shares sh join public.items i on i.id = sh.item_id
  where sh.code = p_code;
  if src.id is null then
    raise exception 'That share link no longer works. Ask for a new one.';
  end if;
  hid := public.ensure_household();

  insert into public.items (household_id, kind, category, nickname, brand, model, uses_per_week, icon, tint, created_by)
  values (hid, src.kind, src.category, src.nickname, src.brand, src.model, src.uses_per_week, src.icon, src.tint, uid)
  returning id into new_item;

  for m in select * from public.manuals where item_id = src.id order by created_at loop
    insert into public.manuals (household_id, item_id, title, source, source_url, official, page_count,
      status, status_detail, read_by)
    values (hid, new_item, m.title, m.source, m.source_url, m.official, m.page_count,
      m.status, 'Copied from a shared manual.', m.read_by)
    returning id into new_manual;

    insert into public.manual_pages (household_id, manual_id, page_number, content, extracted_by)
    select hid, new_manual, p.page_number, p.content, p.extracted_by
    from public.manual_pages p where p.manual_id = m.id;

    insert into public.manual_facts (household_id, item_id, manual_id, kind, label, value, source_page, source, status)
    select hid, new_item, new_manual, f.kind, f.label, f.value, f.source_page, f.source, f.status
    from public.manual_facts f where f.item_id = src.id and f.manual_id = m.id;

    insert into public.seat_modes (household_id, item_id, manual_id, mode, min_weight_kg, max_weight_kg,
      min_height_cm, max_height_cm, min_age_months, fit_note, source_page, source, status)
    select hid, new_item, new_manual, s.mode, s.min_weight_kg, s.max_weight_kg,
      s.min_height_cm, s.max_height_cm, s.min_age_months, s.fit_note, s.source_page, s.source, s.status
    from public.seat_modes s where s.item_id = src.id and s.manual_id = m.id;

    insert into public.tasks (household_id, item_id, title, details, interval_unit, interval_value,
      source_manual_id, source_page, source, status, active)
    select hid, new_item, t.title, t.details, t.interval_unit, t.interval_value,
      new_manual, t.source_page, t.source, t.status, t.active
    from public.tasks t where t.item_id = src.id and t.source_manual_id = m.id;
  end loop;

  -- Anything not tied to a manual (added by hand or by an assistant).
  insert into public.manual_facts (household_id, item_id, kind, label, value, source_page, source, status)
  select hid, new_item, f.kind, f.label, f.value, f.source_page, f.source, f.status
  from public.manual_facts f where f.item_id = src.id and f.manual_id is null;

  insert into public.seat_modes (household_id, item_id, mode, min_weight_kg, max_weight_kg,
    min_height_cm, max_height_cm, min_age_months, fit_note, source_page, source, status)
  select hid, new_item, s.mode, s.min_weight_kg, s.max_weight_kg,
    s.min_height_cm, s.max_height_cm, s.min_age_months, s.fit_note, s.source_page, s.source, s.status
  from public.seat_modes s where s.item_id = src.id and s.manual_id is null;

  insert into public.tasks (household_id, item_id, title, details, interval_unit, interval_value,
    source_page, source, status, active)
  select hid, new_item, t.title, t.details, t.interval_unit, t.interval_value,
    t.source_page, t.source, t.status, t.active
  from public.tasks t where t.item_id = src.id and t.source_manual_id is null;

  update public.item_shares set copies = copies + 1 where code = p_code;
  return new_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'invite_preview(text)', 'accept_invite(text)', 'household_people()', 'remove_member(uuid)',
    'leave_household()', 'shared_item_preview(text)', 'copy_shared_item(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
