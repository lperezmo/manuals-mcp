-- Instant answers: chat questions the fast lane (Jev) answered from a saved
-- fact or task, without Muse. Logged so the share answered without Muse shows
-- on the model log. They are not Muse calls, so model_runs_today_all leaves
-- them out of the daily budget, and the chat limit doesn't count them.
alter table public.model_runs drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check check (kind in ('read', 'chat', 'search', 'snap', 'plan', 'fast'));
