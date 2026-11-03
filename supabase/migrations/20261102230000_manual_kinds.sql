-- A thing can have several guides: an owner's manual, a quick start, a recipe
-- book. Each manual gets a kind (null until it is known), chosen when it's read
-- and changeable on the thing's page. A fact the second guide states
-- differently from the first gets a note naming the other guide's value and
-- page, so the "Check them" second read and the owner see both. Additive:
-- two nullable columns, no backfill.

alter table public.manuals
  add column if not exists kind text check (kind in ('owner', 'quick_start', 'recipes', 'other'));

alter table public.manual_facts
  add column if not exists note text check (length(note) <= 600);
