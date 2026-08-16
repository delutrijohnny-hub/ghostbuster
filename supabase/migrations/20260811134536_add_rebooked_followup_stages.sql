-- The original stage check constraints only ever listed the six base cadence
-- stages. "rebooked" (a returning contact who never actually had a call) and
-- "followup" (a returning contact who already had a Completed call) fire
-- instead of "welcome" for repeat bookings — both need to be legal stage
-- values wherever "stage" is constrained.
alter table public.message_log drop constraint message_log_stage_check;
alter table public.message_log add constraint message_log_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow','rebooked','followup'));

alter table public.variants drop constraint variants_stage_check;
alter table public.variants add constraint variants_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow','rebooked','followup'));

alter table public.variant_stats drop constraint variant_stats_stage_check;
alter table public.variant_stats add constraint variant_stats_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow','rebooked','followup'));
