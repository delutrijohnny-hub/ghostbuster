-- Email as a second channel.
--
-- Everything so far assumed SMS: a variant is a blob of text, and a logged
-- message has no channel because there was only one. Email needs a subject
-- line, a verified sending address, and — unlike an sms: link handed to the
-- salesperson's own phone — it is actually sent BY GhostBuster, which is what
-- finally makes automatic reply detection possible.
--
-- Defaults keep every existing row exactly as it is: channel 'sms' on both
-- tables, so no variant changes meaning and no logged message is
-- reinterpreted.

alter table public.variants add column channel text not null default 'sms'
  check (channel in ('sms','email'));
alter table public.variants add column subject text;

-- A stage can now hold both an SMS and an email version of the same idea, so
-- the uniqueness that made a variant addressable has to include the channel.
alter table public.variants drop constraint if exists variants_user_id_stage_variant_key_key;
create unique index if not exists variants_user_stage_channel_key_idx
  on public.variants (user_id, stage, channel, variant_key);

alter table public.message_log add column channel text not null default 'sms'
  check (channel in ('sms','email'));
-- Provider message id, so a delivery webhook or a reply can be matched back to
-- the send it belongs to. Null for SMS, which GhostBuster never sends itself.
alter table public.message_log add column provider_id text;
create index if not exists message_log_provider_idx on public.message_log (provider_id);

-- Per-organization sending identity and permission.
--
-- email_enabled and auto_send_email are separate on purpose. Being able to
-- send a single email by hand is a different decision from letting the system
-- send on its own while nobody is watching, and collapsing them into one
-- switch would mean turning on the first silently grants the second.
-- Both default false: no account starts out able to send mail to real people.
alter table public.app_settings add column email_enabled boolean not null default false;
alter table public.app_settings add column auto_send_email boolean not null default false;
alter table public.app_settings add column email_from_name text;
alter table public.app_settings add column email_from_address text;
alter table public.app_settings add column email_reply_to text;
