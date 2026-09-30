-- 'email' as a logged stage.
--
-- A library email is not a cadence touch. It has no trigger and no position in
-- the five, so there is no stage to advance — but it still has to be LOGGED,
-- for two reasons that both matter: the timeline should show what was actually
-- sent, and "has this person been contacted today" is what stops an automated
-- text landing on top of an email sent by hand ten minutes earlier.
--
-- So it logs against stage 'email'. Which the CHECK constraint rejected, and a
-- rejected insert fails the whole batched save — the same failure mode as
-- 'revival', where every save in the app died silently and the only symptom
-- the user saw was "changes are not being saved".
--
-- Third time this list has needed extending, which is the argument for making
-- it one shared enum rather than three literals in three tables. Left as three
-- for now because changing it is a separate migration with its own risk, and
-- doing both at once is how the risky half gets shipped unnoticed.
alter table public.variants drop constraint if exists variants_stage_check;
alter table public.variants add constraint variants_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'));

alter table public.variant_stats drop constraint if exists variant_stats_stage_check;
alter table public.variant_stats add constraint variant_stats_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'));

alter table public.message_log drop constraint if exists message_log_stage_check;
alter table public.message_log add constraint message_log_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'));
