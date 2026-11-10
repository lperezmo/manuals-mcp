-- Test data: a fictional household the database tests fill and check against.
-- Brands, models and manual text are made up; nothing here is a real manual.
-- Run after the migrations and before the test files.

-- Fills one household with a washer, a dishwasher and a car seat: manual pages,
-- typed facts, upkeep tasks (one overdue), two facts waiting for review, one
-- past revision, cycle readings, a child and her measurements.
create function public.fill_example_home(hid uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  washer uuid;
  washer_manual uuid;
  dishwasher uuid;
  dish_manual uuid;
  seat uuid;
  seat_manual uuid;
  kid uuid;
  rinse_aid uuid;
begin
  if exists (select 1 from public.items where household_id = hid and notes = 'Demo data') then
    raise notice 'This household already has the demo data.';
    return;
  end if;

  -- Washer -------------------------------------------------------------------
  insert into public.items (household_id, kind, category, nickname, brand, model, uses_per_week, notes)
  values (hid, 'appliance', 'washer', 'Washer', 'Brightwash', 'BW-4100', 6, 'Demo data')
  returning id into washer;

  insert into public.manuals (household_id, item_id, title, source, source_url, official, page_count,
    status, read_by, reader_at, reader_model)
  values (hid, washer, 'Brightwash BW-4100 owner''s manual (demo)', 'url',
    'https://example.com/brightwash/bw-4100.pdf', true, 64, 'distilled', 'server', now(), 'demo')
  returning id into washer_manual;

  insert into public.manual_pages (household_id, manual_id, page_number, content) values
    (hid, washer_manual, 12, 'Detergent. Use only high-efficiency (HE) detergent. Add no more than 2 tablespoons for a normal load. Too much detergent leaves residue and causes odors.'),
    (hid, washer_manual, 38, 'Cleaning the drain pump filter. Do this every 3 months. Turn off the washer and place a towel under the access panel. Unscrew the filter slowly and let the water drain. Rinse the filter under warm running water and remove lint and coins. Do not use vinegar or bleach on the filter. Screw it back in firmly.'),
    (hid, washer_manual, 40, 'Door gasket. Once a month, wipe the rubber door gasket with a soft cloth and dry it. Leave the door open after washing so the drum can air out.'),
    (hid, washer_manual, 41, 'Tub Clean. Run the Tub Clean cycle every 30 washes, with the drum empty and no detergent. The display shows tCL when it is time.'),
    (hid, washer_manual, 44, 'Hoses. Check the inlet hoses once a year for bulges, cracks or leaks. Replace hoses every 5 years.'),
    (hid, washer_manual, 52, 'Error codes. E4: water is not draining. Check that the drain hose is not kinked and clean the drain pump filter (page 38). UE: the load is unbalanced. Redistribute the items and restart. dE: the door is open. Close it firmly until it clicks.');

  insert into public.manual_facts (household_id, item_id, manual_id, kind, label, value, source_page, status) values
    (hid, washer, washer_manual, 'error_code', 'E4', 'Water is not draining. Check the drain hose for kinks and clean the drain pump filter.', 52, 'extracted'),
    (hid, washer, washer_manual, 'error_code', 'UE', 'Unbalanced load. Redistribute the items and restart.', 52, 'extracted'),
    (hid, washer, washer_manual, 'error_code', 'dE', 'Door open. Close it firmly until it clicks.', 52, 'extracted'),
    (hid, washer, washer_manual, 'part', 'Drain pump filter', 'Behind the access panel, bottom right of the front.', 38, 'extracted'),
    (hid, washer, washer_manual, 'spec', 'Detergent', 'High-efficiency (HE) only, at most 2 tablespoons per normal load.', 12, 'extracted'),
    (hid, washer, washer_manual, 'part', 'Inlet hoses', 'Replace every 5 years.', 44, 'extracted');

  -- The demo's "that doesn't sound right" moment: the reader got the filter
  -- cleaning wrong, flagged it, and page 38 says otherwise.
  insert into public.tasks (household_id, item_id, title, details, interval_unit, interval_value,
    source_manual_id, source_page, status) values
    (hid, washer, 'Run the tub clean cycle', 'Empty drum, no detergent.', 'cycles', 30, washer_manual, 41, 'extracted'),
    (hid, washer, 'Wipe the door gasket', 'Soft cloth, then dry it.', 'months', 1, washer_manual, 40, 'extracted'),
    (hid, washer, 'Clean the drain pump filter', 'Soak the filter in vinegar for 2 hours.', 'months', 3, washer_manual, 38, 'needs_review'),
    (hid, washer, 'Check the inlet hoses', 'Look for bulges, cracks or leaks.', 'months', 12, washer_manual, 44, 'extracted');

  insert into public.item_readings (household_id, item_id, measured_on, kind, value) values
    (hid, washer, current_date - 21, 'cycles', 200),
    (hid, washer, current_date, 'cycles', 218);

  -- Dishwasher ---------------------------------------------------------------
  insert into public.items (household_id, kind, category, nickname, brand, model, notes)
  values (hid, 'appliance', 'dishwasher', 'Dishwasher', 'Clearwave', 'CW-300', 'Demo data')
  returning id into dishwasher;

  insert into public.manuals (household_id, item_id, title, source, source_url, official, page_count,
    status, read_by, reader_at, reader_model)
  values (hid, dishwasher, 'Clearwave CW-300 use and care guide (demo)', 'url',
    'https://example.com/clearwave/cw-300.pdf', true, 40, 'distilled', 'server', now(), 'demo')
  returning id into dish_manual;

  insert into public.manual_pages (household_id, manual_id, page_number, content) values
    (hid, dish_manual, 18, 'Rinse aid. The dispenser has settings 1 to 5. Start at 3. In hard water areas, use setting 3 or higher to prevent spots.'),
    (hid, dish_manual, 22, 'Filter. Every 2 weeks, twist out the cylindrical filter, rinse it under running water and scrub gently with a soft brush. Put it back and twist until it locks.'),
    (hid, dish_manual, 24, 'Spray arms. Every 6 months, remove the spray arms and clear the holes with a toothpick.'),
    (hid, dish_manual, 26, 'Descaling. Every 3 months, run an empty hot cycle with a dishwasher cleaner.'),
    (hid, dish_manual, 30, 'Error codes. E15: water in the base pan, usually a leak. Turn off the water supply and call service. E24: water is not draining. Clean the filter (page 22) and check the drain hose.');

  insert into public.manual_facts (household_id, item_id, manual_id, kind, label, value, source_page, source, status) values
    (hid, dishwasher, dish_manual, 'error_code', 'E15', 'Water in the base pan, usually a leak. Turn off the water supply and call service.', 30, 'reader', 'extracted'),
    (hid, dishwasher, dish_manual, 'error_code', 'E24', 'Water is not draining. Clean the filter and check the drain hose.', 30, 'reader', 'extracted'),
    (hid, dishwasher, dish_manual, 'part', 'Filter', 'Cylindrical, twist out from the floor of the tub.', 22, 'reader', 'extracted');

  -- Already revised once, so the history has something to show.
  insert into public.manual_facts (household_id, item_id, manual_id, kind, label, value, source_page, source, status)
  values (hid, dishwasher, dish_manual, 'spec', 'Rinse aid setting', 'Setting 3 (hard water: 3 or higher).', 18, 'assistant', 'revised')
  returning id into rinse_aid;
  insert into public.revisions (household_id, target_table, target_id, before, after, source, reason, created_at)
  values (hid, 'manual_facts', rinse_aid,
    jsonb_build_object('label', 'Rinse aid setting', 'value', 'Setting 1', 'source', 'reader', 'status', 'extracted', 'source_page', 18),
    jsonb_build_object('label', 'Rinse aid setting', 'value', 'Setting 3 (hard water: 3 or higher).', 'source', 'assistant', 'status', 'revised', 'source_page', 18),
    'assistant', 'Page 18 says to start at 3, and 3 or higher for hard water. Setting 1 was misread.',
    now() - interval '2 days');

  insert into public.tasks (household_id, item_id, title, details, interval_unit, interval_value,
    last_done_on, source_manual_id, source_page) values
    (hid, dishwasher, 'Rinse the filter', 'Twist out, rinse, scrub gently.', 'weeks', 2, current_date - 20, dish_manual, 22),
    (hid, dishwasher, 'Clean the spray arms', 'Clear the holes with a toothpick.', 'months', 6, current_date - 60, dish_manual, 24),
    (hid, dishwasher, 'Descale', 'Empty hot cycle with dishwasher cleaner.', 'months', 3, current_date - 85, dish_manual, 26);

  -- Car seat -----------------------------------------------------------------
  insert into public.children (household_id, nickname, birth_date)
  values (hid, 'Mia', current_date - 600)
  returning id into kid;

  insert into public.items (household_id, kind, category, nickname, brand, model, child_id, notes)
  values (hid, 'baby_gear', 'car_seat', 'Car seat', 'Tandem', 'Grow 3-in-1', kid, 'Demo data')
  returning id into seat;

  insert into public.manuals (household_id, item_id, title, source, source_url, official, page_count,
    status, read_by, reader_at, reader_model)
  values (hid, seat, 'Tandem Grow 3-in-1 manual (demo)', 'url',
    'https://example.com/tandem/grow-3-in-1.pdf', true, 48, 'distilled', 'server', now(), 'demo')
  returning id into seat_manual;

  insert into public.manual_pages (household_id, manual_id, page_number, content) values
    (hid, seat_manual, 8, 'Expiration. Do not use this seat more than 10 years after the date of manufacture printed on the label under the seat.'),
    (hid, seat_manual, 24, 'Rear-facing. Child weight 2.3 to 18 kg (5 to 40 lb) and height up to 102 cm (40 in). The top of the child''s head must be at least 2.5 cm (1 in) below the top of the headrest.'),
    (hid, seat_manual, 26, 'Forward-facing with harness. Child weight 10 to 29.5 kg (22 to 65 lb), height 74 to 125 cm (29 to 49 in), and at least 2 years old. Keep your child rear-facing as long as possible within the limits.');

  insert into public.seat_modes (household_id, item_id, manual_id, mode, min_weight_kg, max_weight_kg,
    min_height_cm, max_height_cm, min_age_months, fit_note, source_page, status) values
    (hid, seat, seat_manual, 'rear_facing', 2.3, 18, null, 102, null, 'Head at least 2.5 cm below the top of the headrest.', 24, 'extracted'),
    (hid, seat, seat_manual, 'forward_facing', 10, 29.5, 74, 125, 24, null, 26, 'needs_review');

  insert into public.manual_facts (household_id, item_id, manual_id, kind, label, value, source_page) values
    (hid, seat, seat_manual, 'safety', 'Expiration', '10 years after the date of manufacture on the label under the seat.', 8);

  insert into public.measurements (household_id, child_id, measured_on, height_cm, weight_kg) values
    (hid, kid, current_date - 120, 78.0, 10.2),
    (hid, kid, current_date - 30, 81.5, 11.0);
end;
$$;

-- The signed-in user fills their own household (RLS still applies).
create function public.load_example_home()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.fill_example_home(public.ensure_household());
end;
$$;

revoke execute on function public.fill_example_home(uuid) from public, anon;
grant execute on function public.fill_example_home(uuid) to authenticated;
revoke execute on function public.load_example_home() from public, anon;
grant execute on function public.load_example_home() to authenticated;
