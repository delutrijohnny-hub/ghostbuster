-- Every new account gets a working calendar filter.
--
-- The filter migration backfilled the accounts that existed at the time and
-- gave the column no default. So every account created afterwards had
-- calendar_filter NULL, and NULL fell back — in parse.ts — to MarketMaker's
-- own event titles: import nothing unless the event is called "strategy
-- session".
--
-- Three people hit this one after another. niklaus, ronin and ethan each
-- connected a calendar, synced, got nothing, and reported it as a separate
-- mystery. Each was diagnosed from scratch. The app told them nothing was
-- wrong: "Synced: 0 new, 0 updated".
--
-- Two halves, same as the org-provisioning fix: make it impossible going
-- forward, and repair anyone already stranded.

-- 1) A default on the column, so a new row is correct without anyone
--    remembering to set it. parse.ts also defaults to this now, but relying
--    on a fallback is what caused this — the row should say what it means.
alter table public.app_settings
  alter column calendar_filter set default jsonb_build_object(
    'mode', 'attendees',
    'exclude', jsonb_build_array()
  );

-- 2) Repair every account still carrying NULL.
--
-- Deliberately NOT touching rows that already hold a filter: an account that
-- explicitly chose keyword matching (MarketMaker's own, backfilled earlier)
-- keeps it. This only fixes accounts that were never configured at all.
update public.app_settings
set calendar_filter = jsonb_build_object(
  'mode', 'attendees',
  'exclude', jsonb_build_array()
)
where calendar_filter is null;
