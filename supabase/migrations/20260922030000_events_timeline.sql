-- An append-only timeline of everything that happens to a contact.
--
-- Today the only history GhostBuster keeps is message_log (messages only) and
-- clients.reschedules (a jsonb array). Status changes aren't recorded at all,
-- so "time in stage", "where do leads drop off" and "sales cycle length" are
-- not computable from existing data — not because the queries are hard, but
-- because the facts were never written down.
--
-- This table is deliberately added early and deliberately generic. It can only
-- ever record the future: every day without it is history that cannot be
-- recovered later. A narrow schema now would have to be widened for each new
-- event kind, so `kind` is free text and `data` is jsonb — the cost of a wrong
-- guess is a new kind string, not a migration.
--
-- Append-only by design: rows are inserted, never updated or deleted. That is
-- what makes it safe to write from the client without the destructive
-- read-modify-write that the rest of saveState is being rewritten to avoid.
create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text references public.clients(id) on delete cascade,
  kind text not null,
  at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- The two access patterns: one contact's timeline, and an org-wide feed.
create index events_client_at_idx on public.events (client_id, at desc);
create index events_user_at_idx on public.events (user_id, at desc);
-- Analytics will group by kind over a window; without this those scan the table.
create index events_user_kind_at_idx on public.events (user_id, kind, at desc);

alter table public.events enable row level security;

-- Insert-and-read only. No update/delete policy exists at all, so the
-- append-only guarantee is enforced by the database rather than by convention.
create policy "events_owner_select" on public.events
  for select using (user_id = auth.uid());
create policy "events_owner_insert" on public.events
  for insert with check (user_id = auth.uid());
