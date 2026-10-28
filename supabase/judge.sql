-- Fills the judges' demo account with the fictional demo household.
--
-- 1. Supabase dashboard, Authentication, Users, Add user: an email and a
--    password, with "auto confirm" on. Signing up gives the account a household.
-- 2. Put that email below and run this file in the SQL editor.
--
-- Running it twice does nothing the second time. The household is marked as a
-- demo, so it goes back to the demo data every night.

do $$
declare
  judge_email text := 'judge@example.com';
  hid uuid;
begin
  select m.household_id into hid
  from auth.users u
  join public.household_members m on m.user_id = u.id
  where u.email = judge_email
  order by m.created_at
  limit 1;

  if hid is null then
    raise exception 'No account with email %. Add the user in Authentication first.', judge_email;
  end if;

  perform public.fill_demo_household(hid);
  -- Reset to the demo data every night (see reset_demo_households).
  update public.households set is_demo = true where id = hid;
  raise notice 'Demo household ready for %.', judge_email;
end;
$$;
