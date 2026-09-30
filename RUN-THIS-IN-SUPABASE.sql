-- ============================================================
-- GhostBuster — paste the WHOLE of this into the Supabase SQL
-- editor and press Run. Safe to run twice.
--
-- Written defensively: it checks for each thing it depends on
-- and adapts instead of failing, and prints a NOTICE saying
-- what it did. A migration that has to be pasted by hand
-- should not assume anything about the database it lands in.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The email library.
-- ------------------------------------------------------------
create table if not exists public.email_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- No inline foreign key: organizations may not exist on every database.
  -- The reference is added below only if it does.
  org_id uuid,
  title text not null,
  when_to_send text,
  subject text,
  body text,
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_library_user_idx on public.email_library (user_id);
create index if not exists email_library_org_idx on public.email_library (org_id);

-- Link org_id to organizations, if that table is there.
do $$
begin
  if to_regclass('public.organizations') is null then
    raise notice 'organizations table not found - email_library.org_id left unlinked';
  elsif not exists (
    select 1 from pg_constraint where conname = 'email_library_org_id_fkey'
  ) then
    alter table public.email_library
      add constraint email_library_org_id_fkey
      foreign key (org_id) references public.organizations(id) on delete cascade;
    raise notice 'linked email_library.org_id to organizations';
  end if;
end $$;

-- Stamp org_id on insert, if the shared function exists.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_org_id_from_user') then
    drop trigger if exists email_library_set_org on public.email_library;
    create trigger email_library_set_org before insert on public.email_library
      for each row execute function public.set_org_id_from_user();
    raise notice 'org stamping trigger installed';
  else
    raise notice 'set_org_id_from_user() not found - skipping org trigger';
  end if;
end $$;

alter table public.email_library enable row level security;

-- The org boundary if this database has one, otherwise per-user. Either way
-- nobody can read anybody else's emails.
do $$
begin
  drop policy if exists "email_library_org_all" on public.email_library;
  drop policy if exists "email_library_user_all" on public.email_library;

  if exists (select 1 from pg_proc where proname = 'user_org_ids') then
    create policy "email_library_org_all" on public.email_library for all
      using (org_id in (select public.user_org_ids()))
      with check (org_id in (select public.user_org_ids()));
    raise notice 'org-scoped policy installed';
  else
    create policy "email_library_user_all" on public.email_library for all
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
    raise notice 'user_org_ids() not found - installed per-user policy instead';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Allow the 'email' stage, so logging a library send does
--    not fail the whole save.
-- ------------------------------------------------------------
do $$
declare
  t text;
  stages text := $list$'welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'$list$;
begin
  foreach t in array array['variants','variant_stats','message_log'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I drop constraint if exists %I', t, t || '_stage_check');
      execute format('alter table public.%I add constraint %I check (stage in (%s))', t, t || '_stage_check', stages);
    end if;
  end loop;
  raise notice 'stage constraints now allow the email stage';
end $$;

-- ------------------------------------------------------------
-- 3. Every account gets a working calendar filter.
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_settings'
      and column_name = 'calendar_filter'
  ) then
    alter table public.app_settings
      alter column calendar_filter set default
        jsonb_build_object('mode', 'attendees', 'exclude', jsonb_build_array());

    update public.app_settings
    set calendar_filter = jsonb_build_object('mode', 'attendees', 'exclude', jsonb_build_array())
    where calendar_filter is null;

    raise notice 'calendar filter default set, and null accounts repaired';
  else
    raise notice 'app_settings.calendar_filter column not found - skipped';
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. Tell the API about the new table.
--
-- Supabase serves the REST API through PostgREST, which keeps a
-- cached picture of the schema. A table created in this editor
-- can stay invisible to the app until that cache reloads — the
-- app then gets "Could not find the table in the schema cache",
-- which looks exactly like the table not existing at all.
-- ------------------------------------------------------------
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Did it work? This should return one row.
-- ------------------------------------------------------------
select
  to_regclass('public.email_library')                                              as email_library_table,
  (select count(*) from pg_policies where tablename = 'email_library')             as policies,
  (select count(*) from public.app_settings where calendar_filter is null)         as accounts_still_unconfigured,
  (select count(*) from public.app_settings)                                       as total_accounts,
  (select count(*) from public.email_library)                                      as emails_in_library;
