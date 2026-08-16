-- GhostBuster hosted rebuild — initial schema.
-- Every user-facing table carries user_id from day one (costs nothing with
-- one user, means adding teammates later is new auth.users rows, not a
-- migration) and is gated by RLS on user_id = auth.uid().

create table public.clients (
  id uuid primary key default gen_random_uuid(),
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
  -- kept as JSON per plan: read/written whole (stage -> 'YYYY-MM-DD'), never
  -- queried at the individual-stage level, so a relational table buys nothing.
  snoozed_until jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, google_event_id)
);
create index clients_user_id_idx on public.clients(user_id);
create index clients_call_date_time_idx on public.clients(call_date_time);

create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  stage text not null check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow')),
  variant_key text not null default '',
  text text not null default '',
  sent_at timestamptz not null default now(),
  responded boolean not null default false,
  responded_at timestamptz
);
create index message_log_client_id_idx on public.message_log(client_id);

create table public.variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stage text not null check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow')),
  variant_key text not null,
  text text not null default '',
  builtin boolean not null default false,
  needs_channel boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, stage, variant_key)
);
create index variants_user_id_idx on public.variants(user_id);

create table public.variant_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stage text not null check (stage in ('welcome','monday','midcheckin','dayof','recovery','noshow')),
  variant_key text not null,
  sends integer not null default 0,
  responses integer not null default 0,
  unique (user_id, stage, variant_key)
);
create index variant_stats_user_id_idx on public.variant_stats(user_id);

create table public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index todos_user_id_idx on public.todos(user_id);

create table public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  epsilon numeric not null default 0.2,
  updated_at timestamptz not null default now()
);

-- One row per connected Google Calendar. John connects both
-- john@marketmakermgmt.com (priority 0, checked first when merging/deduping
-- bookings that appear on both) and his personal Gmail (priority 1).
-- Never exposed to the browser — see RLS note below.
create table public.google_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null,
  priority integer not null default 0,
  refresh_token text not null,
  access_token text,
  token_expiry timestamptz,
  sync_token text,
  last_sync timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, calendar_id)
);

-- RLS: every user-facing table is gated on user_id = auth.uid(); message_log
-- has no user_id of its own, so its policy joins through clients.user_id.
alter table public.clients enable row level security;
alter table public.message_log enable row level security;
alter table public.variants enable row level security;
alter table public.variant_stats enable row level security;
alter table public.todos enable row level security;
alter table public.app_settings enable row level security;
alter table public.google_oauth_tokens enable row level security;

create policy "clients_owner_all" on public.clients
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "message_log_owner_all" on public.message_log
  for all using (exists (
    select 1 from public.clients where clients.id = message_log.client_id and clients.user_id = auth.uid()
  )) with check (exists (
    select 1 from public.clients where clients.id = message_log.client_id and clients.user_id = auth.uid()
  ));

create policy "variants_owner_all" on public.variants
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "variant_stats_owner_all" on public.variant_stats
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "todos_owner_all" on public.todos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "app_settings_owner_all" on public.app_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- google_oauth_tokens deliberately has RLS enabled with zero policies for
-- anon/authenticated — nothing in the browser can ever read or write it.
-- Only the service_role key (used exclusively by the Calendar Sync Edge
-- Function, never shipped to the client) can touch this table, since
-- service_role bypasses RLS by design.
