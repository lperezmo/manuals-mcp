-- The judges' shared household keeps what's added to it: real things with
-- their real manuals, for judges to browse. The nightly reset is off; the
-- reset functions stay, to run by hand (select public.reset_demo_households()).

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from cron.job where jobname = 'reset-demo-households') then
    perform cron.unschedule('reset-demo-households');
  end if;
end;
$$;
