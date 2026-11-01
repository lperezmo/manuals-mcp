-- "Doesn't apply to mine": a manual line for a part this model doesn't have
-- ("if the washer includes lint filters"). The row stays, with its history,
-- but drops out of review, reminders and what assistants read.

alter table public.manual_facts drop constraint if exists manual_facts_status_check;
alter table public.manual_facts add constraint manual_facts_status_check
  check (status in ('extracted', 'needs_review', 'revised', 'confirmed', 'not_applicable'));

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('extracted', 'needs_review', 'revised', 'confirmed', 'not_applicable'));

alter table public.seat_modes drop constraint if exists seat_modes_status_check;
alter table public.seat_modes add constraint seat_modes_status_check
  check (status in ('extracted', 'needs_review', 'revised', 'confirmed', 'not_applicable'));
