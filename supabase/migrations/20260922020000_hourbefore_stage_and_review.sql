-- Two changes that go together, both aimed at the no-show rate.
--
-- 1) A new "hourbefore" cadence stage. "dayof" is date-granular, so in
--    practice it goes out whenever the morning list gets worked — often many
--    hours ahead of the call, which is exactly when a reminder is easiest to
--    forget a second time. "hourbefore" is clock-granular and only fires
--    inside a narrow window right before the call.
--
-- 2) message_log.reviewed. Until now "responded = false" meant two entirely
--    different things: "they didn't reply" and "nobody has checked yet".
--    pickVariant scores templates with (responses+1)/(sends+2), and sends were
--    counted the moment a message went out, so every unchecked message scored
--    as a rejection. With 762 sends and 31 logged replies the bandit was
--    ranking templates almost entirely on noise — and because more sends meant
--    a worse score, it drifted toward whichever template had been used least.
--
--    A send now enters the denominator only once someone answers the reply
--    question either way. Unreviewed sends are simply absent from the maths
--    instead of counting against the template.

alter table public.message_log drop constraint message_log_stage_check;
alter table public.message_log add constraint message_log_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','rebooked','followup'));

alter table public.variants drop constraint variants_stage_check;
alter table public.variants add constraint variants_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','rebooked','followup'));

alter table public.variant_stats drop constraint variant_stats_stage_check;
alter table public.variant_stats add constraint variant_stats_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','rebooked','followup'));

-- Backfill deliberately asymmetric: a message with a reply on file was
-- self-evidently looked at, so it counts as reviewed. A message with no reply
-- on file is genuinely unknown — it goes into the review queue rather than
-- being grandfathered in as a rejection it may never have been.
alter table public.message_log add column reviewed boolean not null default false;
update public.message_log set reviewed = true where responded = true;
