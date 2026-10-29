-- Manual searches from the website are logged as model runs too, so they
-- show in the model log and count toward the daily search cap.

alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check check (kind in ('read', 'chat', 'search'));
