-- Texts queued to go out later.
--
-- The whole correctness story is one idea: the rules are checked AT SEND
-- TIME, not when the message was queued. Everything that makes a text unwise
-- can change in between -- they reply, they text STOP, somebody pauses
-- follow-ups, the appointment is cancelled -- and all of it changes in the
-- direction of "do not send". A queue that decided at schedule time would
-- chase somebody who answered an hour ago, which is worse than having no
-- scheduling at all, because they trusted it.
--
-- Nothing is deleted. "Why did that not go out" is a question somebody asks
-- days later, and a row that vanished cannot answer it.
create table if not exists public.scheduled_messages (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  org_id         uuid not null references public.organizations(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  body           text not null,
  send_at        timestamptz not null,
  status         text not null default 'pending'
                 check (status in ('pending','sent','cancelled','failed')),
  reason         text,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  message_log_id uuid,
  provider_id    text
);

create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (send_at) where status = 'pending';
create index if not exists scheduled_messages_client_idx
  on public.scheduled_messages (client_id, send_at desc);
create index if not exists scheduled_messages_org_idx
  on public.scheduled_messages (org_id, status);

alter table public.scheduled_messages enable row level security;

drop policy if exists scheduled_messages_select on public.scheduled_messages;
create policy scheduled_messages_select on public.scheduled_messages
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

drop policy if exists scheduled_messages_insert on public.scheduled_messages;
create policy scheduled_messages_insert on public.scheduled_messages
  for insert to authenticated
  with check (org_id in (select public.user_org_ids()) and user_id = auth.uid()
              and status = 'pending');

-- Cancelling is the only edit a person makes. Deliberately cannot flip a row
-- to 'sent': only the runner does that, and a client that could would be able
-- to fake a delivery record.
drop policy if exists scheduled_messages_update on public.scheduled_messages;
create policy scheduled_messages_update on public.scheduled_messages
  for update to authenticated
  using (org_id in (select public.user_org_ids()) and status = 'pending')
  with check (org_id in (select public.user_org_ids()) and status = 'cancelled');

revoke delete on public.scheduled_messages from anon, authenticated;

comment on table public.scheduled_messages is
  'Queued texts. Every rule (opt-out, reply, pause, quiet hours, status) is re-evaluated by send-scheduled at send time, never at schedule time. Rows are kept after resolving so "why did that not go out" is answerable.';
