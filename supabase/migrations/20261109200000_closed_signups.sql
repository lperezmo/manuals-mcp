-- New accounts are closed. Only an email on allowed_emails can sign up;
-- accounts that already exist sign in as before. Let someone in by hand:
--   insert into public.allowed_emails (email) values ('someone@example.com');

create table public.allowed_emails (
  email text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- No policies: nobody reads or writes it from the browser.
alter table public.allowed_emails enable row level security;

create function public.only_allowed_signups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.allowed_emails where email = lower(new.email)) then
    raise exception 'New accounts are closed';
  end if;
  return new;
end;
$$;

revoke all on function public.only_allowed_signups() from public, anon, authenticated;

create trigger only_allowed_signups
  before insert on auth.users
  for each row execute function public.only_allowed_signups();
