-- Sending through the Mac's Messages app, instead of handing off to it.
--
-- Until now "Open in Messages" opened a prefilled sms: link and Ghost Recall
-- logged the send optimistically, never knowing whether Send was pressed.
-- That is the origin of 637 rows with no provider_id and no delivery status.
--
-- A row with delivery_status = 'queued' and provider_id IS NULL now means
-- "the Mac agent should send this". That state was already allowed by
-- message_log_delivery_status_check and had zero rows, so nothing existing
-- changes meaning. The distinction matters:
--
--   delivery_status IS NULL  + no provider_id -> an old optimistic handoff
--                                                log. MUST NOT be re-sent.
--   delivery_status 'queued' + provider_id    -> Twilio accepted it.
--   delivery_status 'queued' + no provider_id -> ours to send.
--
-- claimed_at stops a double send. The agent claims a row by stamping it, and
-- only ever claims rows where this is null, so a run that dies between
-- sending and reporting leaves the row claimed rather than loose. A text sent
-- twice is worse than one sent late: the recipient sees it, and there is no
-- way to take it back.
alter table message_log
  add column if not exists claimed_at timestamptz,
  add column if not exists send_error text;

comment on column message_log.claimed_at is
  'When the Mac agent took this queued row to send. Non-null means do not claim again, even if it never reported back.';
comment on column message_log.send_error is
  'Why a queued send failed, in words fit to show the user. Null unless delivery_status is failed.';

-- The claim query runs every few seconds, so it gets its own small index
-- rather than scanning a table that only grows.
create index if not exists message_log_pending_send_idx
  on message_log (sent_at)
  where delivery_status = 'queued' and provider_id is null and claimed_at is null;
