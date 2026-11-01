-- Set while Muse reads a manual, cleared when the read ends. A second read of
-- the same manual is refused while it is set, so repeated taps cost one read.
-- A read that died without clearing it is treated as over after a few minutes.
alter table public.manuals add column if not exists reading_since timestamptz;
