-- Which calendar events become contacts, per organization.
--
-- This was the last hard-coded assumption tying the engine to one company.
-- isStrategySessionEvent() returned true only for events whose title contained
-- "strategy session" or whose description said "booked by" — MarketMaker's own
-- wording. Every other business syncing a calendar got nothing at all, and the
-- app sat empty with no indication why. Two people onboarding right now are in
-- exactly that state.
--
-- Three modes:
--   attendees  an event with a guest from outside the organizer's own domain.
--              An internal standup has no outside guest; a booked appointment
--              does. Industry-agnostic, and the sensible default for anyone
--              new — it needs no configuration to be right.
--   keywords   explicit title matching, for businesses whose booking tool
--              names events predictably.
--   all        everything on the calendar, for a dedicated booking calendar.
--
-- `exclude` applies in every mode, because a recurring internal meeting on a
-- booking calendar is the one thing nobody wants as a contact.
--
-- Existing accounts are backfilled with keywords mode carrying exactly the old
-- behaviour, so nothing about MarketMaker's sync changes.
alter table public.app_settings add column calendar_filter jsonb;

update public.app_settings
set calendar_filter = jsonb_build_object(
  'mode', 'keywords',
  'include', jsonb_build_array('strategy session'),
  'matchDescription', jsonb_build_array('booked by'),
  'exclude', jsonb_build_array('weekly team meeting')
)
where calendar_filter is null;
