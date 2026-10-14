-- The states a message can actually be in, rather than the two we had.
--
-- Until now a text handed to the Messages app and a text a carrier confirmed
-- delivering were indistinguishable: both showed as sent. 753 rows carry no
-- delivery status at all because nothing ever knew, against 472 the Mac agent
-- later confirmed. Presenting the first group as "sent" is a claim the system
-- cannot support, and it is the specific thing that makes a follow-up tool
-- untrustworthy -- "I sent that" is the sentence a salesperson acts on.
--
-- queued      accepted by us, not yet handed to a provider
-- sent        the provider accepted it
-- delivered   the carrier confirmed it reached the handset
-- bounced     the carrier could not deliver it
-- complained  the recipient reported it as spam (email)
-- failed      the provider rejected it outright
-- unverified  handed to the Messages app on someone's own device. We know a
--             draft was opened. We do not know a message was sent, and must
--             not say otherwise.
alter table public.message_log drop constraint if exists message_log_delivery_status_check;
alter table public.message_log add constraint message_log_delivery_status_check
  check (delivery_status is null or delivery_status in
    ('queued','sent','delivered','bounced','complained','failed','unverified'));

comment on column public.message_log.delivery_status is
  'Lifecycle state. NULL means nothing is known (older rows). ''unverified'' means a draft was opened in the device Messages app and no send was ever confirmed -- it must never be displayed as sent.';
