-- Notes a team writes to itself, inside a client conversation.
--
-- clients.notes and clients.recap already exist, but both are single blobs
-- attached to the contact. A note that belongs in a thread is a different
-- thing: it has a moment, an author, and a place in the sequence of what was
-- said. "He mentioned budget is tight" is only useful next to the message it
-- came after.
--
-- Deliberately a SEPARATE TABLE from message_log, not a channel on it.
-- Everything that reads message_log -- reply rates, the bandit, cadence
-- progress, the delivery pipeline -- treats every row as something sent to a
-- customer. One stray note in there would be counted as an unanswered text,
-- would enter the learning, and could in principle be handed to a provider.
-- The separation is what makes "this can never be sent" true structurally
-- rather than by remembering to filter.
create table if not exists public.conversation_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists conversation_notes_client_idx
  on public.conversation_notes (client_id, created_at);
create index if not exists conversation_notes_org_idx
  on public.conversation_notes (org_id);

alter table public.conversation_notes enable row level security;

drop policy if exists conversation_notes_select on public.conversation_notes;
create policy conversation_notes_select on public.conversation_notes
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

drop policy if exists conversation_notes_insert on public.conversation_notes;
create policy conversation_notes_insert on public.conversation_notes
  for insert to authenticated
  with check (org_id in (select public.user_org_ids()) and user_id = auth.uid());

drop policy if exists conversation_notes_update on public.conversation_notes;
create policy conversation_notes_update on public.conversation_notes
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists conversation_notes_delete on public.conversation_notes;
create policy conversation_notes_delete on public.conversation_notes
  for delete to authenticated using (user_id = auth.uid());

comment on table public.conversation_notes is
  'Internal notes shown inside a client conversation. Separate from message_log on purpose: nothing here is ever sendable, counted as a send, or fed to the learning.';
