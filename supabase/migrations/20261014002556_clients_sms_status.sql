-- Opt-out state per contact, mirroring clients.email_status.
--
-- This one is not a quality nicety, it is the law. Texting someone who
-- replied STOP violates the TCPA, and carriers enforce it independently of
-- the regulator: an A2P 10DLC campaign that keeps texting opt-outs gets
-- filtered or shut off, which takes down texting for every other contact at
-- the same time. So a STOP has to be recorded the moment it arrives and the
-- send path has to refuse on it, with no human step in between -- the human
-- step is exactly what has never happened here (0 of 67 sends reviewed).
--
-- 'ok'         never asked us to stop
-- 'opted_out'  sent STOP / UNSUBSCRIBE / QUIT / CANCEL / END / STOPALL
-- 'undelivered' carrier could not deliver; a wrong number, not a refusal
alter table public.clients
  add column if not exists sms_status text not null default 'ok';
alter table public.clients
  add column if not exists sms_status_at timestamptz;

do $$ begin
  alter table public.clients add constraint clients_sms_status_check
    check (sms_status in ('ok','opted_out','undelivered'));
exception when duplicate_object then null; end $$;

-- The send path reads this on every send, scoped to one contact, so the
-- lookup is already by primary key. The index is for the opposite question:
-- "who has opted out", which is what an audit or a carrier complaint asks.
create index if not exists clients_sms_status_idx
  on public.clients (org_id, sms_status) where sms_status <> 'ok';

comment on column public.clients.sms_status is
  'SMS opt-out state. Set to opted_out by sms-webhook on a STOP keyword; send-sms refuses to text anything other than ok. Required for TCPA and for keeping the 10DLC campaign alive.';
