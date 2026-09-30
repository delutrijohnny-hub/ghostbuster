-- Allow the 'revival' stage.
--
-- The long-term nurture touch was added to logic.js without widening these
-- constraints, so the moment the app tried to store its templates every write
-- in the same save was rejected and nothing saved at all. The save-health
-- banner caught it immediately, which is the only reason it was a minute's
-- confusion rather than another silent week.
--
-- Three tables carry the same list and all three have to agree, which is
-- exactly the kind of duplication that causes this. Worth collapsing into one
-- shared enum or a stages table next time a stage is added.
alter table public.message_log drop constraint message_log_stage_check;
alter table public.message_log add constraint message_log_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','rebooked','followup','revival'));

alter table public.variants drop constraint variants_stage_check;
alter table public.variants add constraint variants_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','rebooked','followup','revival'));

alter table public.variant_stats drop constraint variant_stats_stage_check;
alter table public.variant_stats add constraint variant_stats_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','rebooked','followup','revival'));
