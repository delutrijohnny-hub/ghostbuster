-- 'custom' is a real stage and the schema did not know it.
--
-- A message that is not a cadence touch has existed for a while -- a text
-- typed by hand in place of the template, a free-text reply inside a
-- conversation, a message imported from the Messages app. All of them are
-- logged against variant_key 'custom' precisely so they cannot move any
-- template's reply rate.
--
-- The stage column never allowed the matching value, so every one of those
-- inserts was rejected. Nothing noticed, because the two callers that do it
-- -- send-sms for a thread reply, and imessage-sync for an imported text --
-- both reported success without reading the response. The agent cheerfully
-- announced "388 texts you sent" while writing zero rows.
alter table public.message_log drop constraint if exists message_log_stage_check;
alter table public.message_log add constraint message_log_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery',
                   'noshow','revival','rebooked','followup','email','custom'));

comment on constraint message_log_stage_check on public.message_log is
  'Cadence stages plus ''email'' and ''custom''. ''custom'' covers anything that is not a sequence touch: a hand-typed send, a conversational reply, or a message imported from a phone.';
