-- When each person last read each conversation.
--
-- "6 waiting on you" is useful; "3 you have not read" is what makes somebody
-- open the tab. They are different questions: a contact can be waiting on a
-- reply you have already read and decided to answer later, and a reply you
-- have never seen is the one that actually goes missing.
--
-- Per USER, not per org. Two salespeople looking at the same shared contact
-- have read different things, and a shared read state would mark a message
-- read for someone who never saw it -- which is precisely the failure this
-- is meant to prevent.
--
-- Unlike nearly every other table here, the browser writes this one directly.
-- It is this person's own view state about their own conversations: there is
-- nothing to protect beyond their own row, and routing it through a function
-- would mean a round trip every time a thread is opened.
create table if not exists public.conversation_reads (
  user_id      uuid not null references auth.users(id) on delete cascade,
  client_id    text not null,
  last_read_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

create index if not exists conversation_reads_user_idx
  on public.conversation_reads (user_id);

alter table public.conversation_reads enable row level security;

drop policy if exists conversation_reads_select on public.conversation_reads;
create policy conversation_reads_select on public.conversation_reads
  for select to authenticated using (user_id = auth.uid());

drop policy if exists conversation_reads_insert on public.conversation_reads;
create policy conversation_reads_insert on public.conversation_reads
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists conversation_reads_update on public.conversation_reads;
create policy conversation_reads_update on public.conversation_reads
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists conversation_reads_delete on public.conversation_reads;
create policy conversation_reads_delete on public.conversation_reads
  for delete to authenticated using (user_id = auth.uid());

comment on table public.conversation_reads is
  'Per-user, per-conversation read marker. Written by the browser when a thread is opened; scoped to auth.uid() so one person cannot mark a conversation read for another.';
