-- The app has always generated its own client/todo ids client-side (via a
-- short uid() helper, not real UUIDs — e.g. "c1a2b3c4d5ef"), and
-- commitImportedClients() matches/dedupes on a separate google_event_id
-- field rather than treating that id as anything Google-issued. Using those
-- existing ids directly as primary keys (instead of a DB-generated uuid)
-- means data.js never has to round-trip a server-generated id back into an
-- in-memory client/todo object before it's addressable — the id the app
-- already created is the row's real primary key from the start.
-- Table is empty (pre-launch), so drop-and-recreate is safe.

drop table if exists public.message_log cascade;
drop table if exists public.clients cascade;
drop table if exists public.todos cascade;

create table public.clients (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  google_event_id text,
  organizer_email text,
  name text not null default 'Unknown',
  phone text not null default '',
  email text not null default '',
  youtube_link text not null default '',
  meet_link text not null default '',
  call_date_time timestamptz,
  booked_date timestamptz not null default now(),
  timezone text not null default 'America/New_York',
  status text not null default 'Booked'
    check (status in ('Booked','Confirmed','Reminded','Completed','No-show','Rescheduled','Ghosted')),
  notes text not null default '',
  recap text not null default '',
  close_outcome text check (close_outcome in ('Closed','Not closed')),
  reschedules timestamptz[] not null default '{}',
  reschedule_count integer not null default 0,
  stalled_since timestamptz,
  ignored boolean not null default false,
  manually_added boolean not null default false,
  snoozed_until jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, google_event_id)
);
create index clients_user_id_idx on public.clients(user_id);
create index clients_call_date_time_idx on public.clients(call_date_time);

create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients(id) on delete cascade,
  stage text not null check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow')),
  variant_key text not null default '',
  text text not null default '',
  sent_at timestamptz not null default now(),
  responded boolean not null default false,
  responded_at timestamptz
);
create index message_log_client_id_idx on public.message_log(client_id);

create table public.todos (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index todos_user_id_idx on public.todos(user_id);

alter table public.clients enable row level security;
alter table public.message_log enable row level security;
alter table public.todos enable row level security;

create policy "clients_owner_all" on public.clients
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "message_log_owner_all" on public.message_log
  for all using (exists (
    select 1 from public.clients where clients.id = message_log.client_id and clients.user_id = auth.uid()
  )) with check (exists (
    select 1 from public.clients where clients.id = message_log.client_id and clients.user_id = auth.uid()
  ));

create policy "todos_owner_all" on public.todos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
