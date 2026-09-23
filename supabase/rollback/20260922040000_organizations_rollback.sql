-- ROLLBACK for 20260922040000_organizations.sql
--
-- NOT a migration — deliberately kept outside supabase/migrations so it is
-- never applied automatically. Paste it into the SQL editor if the org
-- boundary misbehaves.
--
-- This is lossless. The org migration moved no data and dropped no column: it
-- added org_id alongside user_id and swapped which one the policies read. So
-- undoing it is restoring the old policies. Client data, message history,
-- variants and stats are untouched either way.
--
-- After running this, every account is back to seeing exactly its own rows via
-- user_id = auth.uid(). organizations and memberships are left in place
-- (harmless; re-running the forward migration would then conflict on the
-- backfill — drop them too only if you intend a clean re-run).

-- 1) restore user_id-scoped policies on the seven org-scoped tables
do $$
declare t text;
begin
  foreach t in array array['clients','variants','variant_stats','app_settings','todos','events','google_oauth_tokens']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_org_all', t);
    execute format($p$create policy %I on public.%I for all
      using (user_id = auth.uid()) with check (user_id = auth.uid())$p$, t || '_owner_all', t);
    execute format('drop trigger if exists %I on public.%I', t || '_set_org', t);
  end loop;
end $$;

-- events must stay append-only: no update or delete policy
drop policy if exists "events_owner_all" on public.events;
drop policy if exists "events_org_select" on public.events;
drop policy if exists "events_org_insert" on public.events;
create policy "events_owner_select" on public.events for select using (user_id = auth.uid());
create policy "events_owner_insert" on public.events for insert with check (user_id = auth.uid());

-- 2) message_log back to scoping through clients.user_id
drop policy if exists "message_log_org_all" on public.message_log;
create policy "message_log_owner_all" on public.message_log
  for all
  using (exists (select 1 from public.clients c where c.id = message_log.client_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.clients c where c.id = message_log.client_id and c.user_id = auth.uid()));

-- 3) org_id columns are left in place and simply stop being consulted.
--    To remove them entirely (only if abandoning the org model):
--      alter table public.clients drop column org_id;  -- etc for each table
--      drop function if exists public.set_org_id_from_user();
--      drop function if exists public.user_org_ids();
--      drop table if exists public.memberships;
--      drop table if exists public.organizations;
