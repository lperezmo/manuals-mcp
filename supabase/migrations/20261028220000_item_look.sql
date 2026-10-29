-- How a thing looks on the website: pinned to the top, and an icon and color
-- the owner picked. Unset icon and tint fall back to ones guessed from the
-- category and kind.

alter table public.items
  add column pinned boolean not null default false,
  add column icon text check (icon in (
    'washer', 'dryer', 'dishwasher', 'fridge', 'range', 'microwave', 'furnace', 'water_heater',
    'air_conditioner', 'car', 'car_seat', 'stroller', 'mower', 'vacuum', 'coffee', 'other'
  )),
  add column tint text check (tint in ('teal', 'gold', 'sage', 'slate'));
