-- Home's chat starters: one Muse call writes a few questions for what's coming
-- up, logged as a model run so a household's calls a day can be capped. It is
-- a short call, so model_runs_today_all leaves it out of the daily budget.
alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check
  check (kind in ('read', 'chat', 'search', 'snap', 'plan', 'fast', 'pulse', 'image', 'recheck', 'starters'));
