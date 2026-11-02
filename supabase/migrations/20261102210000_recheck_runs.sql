-- The second read: a separate Muse call re-checks each line the first read
-- flagged, against its own page. Its verdicts are logged as a model run, so
-- check_flagged can apply exactly what the person was shown.
alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check
  check (kind in ('read', 'chat', 'search', 'snap', 'plan', 'fast', 'pulse', 'image', 'recheck'));
