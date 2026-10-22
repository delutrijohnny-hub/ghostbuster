-- Read markers, per channel.
--
-- Text and email are separate conversations with the same person, so their
-- unread counts have to be able to disagree. One marker for both meant
-- opening the texts cleared an unseen email -- which is the failure this
-- whole split exists to prevent, at the one point somebody would notice it
-- least.
--
-- Existing rows become 'sms', which is not a default so much as a statement
-- of fact: every reply in this account was written by sms-webhook or the Mac
-- agent, and neither of them sees email. There are zero inbound emails, so
-- no row changes meaning and no unread count moves.
alter table public.conversation_reads
  add column if not exists channel text not null default 'sms';

alter table public.conversation_reads
  drop constraint if exists conversation_reads_channel_check;
alter table public.conversation_reads
  add constraint conversation_reads_channel_check check (channel in ('sms','email'));

-- The key is now the conversation AND the channel.
alter table public.conversation_reads drop constraint if exists conversation_reads_pkey;
alter table public.conversation_reads
  add constraint conversation_reads_pkey primary key (user_id, client_id, channel);

comment on column public.conversation_reads.channel is
  'Which conversation this marker is for. Reading one channel must never mark the other read; rows predating this column are ''sms'', which is what every reply in the system is.';
