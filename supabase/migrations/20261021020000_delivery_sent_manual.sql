-- A send somebody confirmed by hand.
--
-- The external route -- a draft handed to Messages or Gmail -- produces no
-- receipt. Nothing in this system can see whether Send was pressed, so the
-- only remaining evidence is a person saying so. That is weaker than a
-- provider confirmation and far stronger than a draft having been opened,
-- which is why it is its own state rather than being folded into either.
--
-- ADDITIVE ONLY. No existing row is rewritten by this migration. 770 rows
-- carry a null delivery_status and 23 carry 'unverified'; both mean "a draft
-- was opened and nothing came back", and both must keep meaning that. A
-- migration that promoted them to 'sent' would manufacture a sending history
-- that never happened, and every reply rate computed from it would be wrong
-- in the flattering direction.
alter table public.message_log drop constraint if exists message_log_delivery_status_check;
alter table public.message_log add constraint message_log_delivery_status_check
  check (delivery_status is null or delivery_status in
    ('queued','sent','delivered','bounced','complained','failed','unverified','sent_manual'));

comment on constraint message_log_delivery_status_check on public.message_log is
  'Delivery states. ''unverified'' and null both mean a draft was opened and nothing came back -- never promote either to a sent state. ''sent_manual'' is a person confirming an external send; ''sent''/''delivered'' require a provider or the Mac agent.';
