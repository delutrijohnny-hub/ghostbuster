-- Phase 1: organizations become the security boundary.
--
-- Until now every table was gated on `user_id = auth.uid()`, which made each
-- account a sealed island: no shared pipeline config, no shared templates, no
-- manager view, no lead assignment, and no way for two people to work the same
-- book of business. Nothing in the multi-industry roadmap is reachable from
-- there.
--
-- Two deliberate choices keep this reversible:
--
--   1. user_id columns are KEPT. They stop being the security boundary and
--      become ownership — which rep a record belongs to — which per-rep
--      analytics and lead assignment need anyway. Because no data moves and no
--      column is dropped, rollback is restoring the old policies and nothing
--      else. See the companion _rollback file.
--
--   2. Every account is backfilled into its OWN one-person organization.
--      Nobody gains visibility of anybody else's data in this migration, so it
--      changes no one's experience. Merging a real team into one org is a
--      separate, deliberate step.
--
-- The application is not changed by this migration. Its queries still filter by
-- user_id, so behaviour is identical; RLS simply enforces the org boundary
-- underneath. Switching to shared visibility later is a query change, not a
-- cutover.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- The whole migration turns on this function. Every table's policy needs to ask
-- "which orgs is the caller in?", and that answer lives in memberships — so a
-- policy ON memberships that queries memberships would recurse. SECURITY
-- DEFINER runs the lookup as the owner, bypassing RLS on memberships and
-- breaking the cycle. It is STABLE so the planner evaluates it once per
-- statement rather than once per row.
create or replace function public.user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$ select org_id from public.memberships where user_id = auth.uid() $$;

revoke all on function public.user_org_ids() from public;
grant execute on function public.user_org_ids() to authenticated;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;

create policy "orgs_member_select" on public.organizations
  for select using (id in (select public.user_org_ids()));

-- Readable via the definer function, so no recursion. Writes are deliberately
-- omitted: nobody may add themselves to an organization from the client.
-- Invitations will go through a server-side function when that exists.
create policy "memberships_self_select" on public.memberships
  for select using (user_id = auth.uid() or org_id in (select public.user_org_ids()));

-- One solo org per existing account, owner role.
do $$
declare u record; new_org uuid;
begin
  for u in select id, email from auth.users loop
    insert into public.organizations (name)
      values (coalesce(nullif(split_part(u.email, '@', 1), ''), 'Workspace'))
      returning id into new_org;
    insert into public.memberships (org_id, user_id, role) values (new_org, u.id, 'owner');
  end loop;
end $$;

-- The app still inserts rows without an org_id, so the database fills it in.
-- Doing this with a trigger rather than an app change is what lets org_id be
-- NOT NULL while the client stays untouched this phase. BEFORE triggers run
-- ahead of the RLS WITH CHECK, so the row is already stamped by the time the
-- policy evaluates it.
create or replace function public.set_org_id_from_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    select m.org_id into new.org_id
      from public.memberships m
      where m.user_id = coalesce(new.user_id, auth.uid())
      limit 1;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['clients','variants','variant_stats','app_settings','todos','events','google_oauth_tokens']
  loop
    execute format('alter table public.%I add column org_id uuid references public.organizations(id) on delete cascade', t);
    execute format('update public.%I x set org_id = m.org_id from public.memberships m where m.user_id = x.user_id', t);
    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('create index %I on public.%I (org_id)', t || '_org_idx', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.set_org_id_from_user()', t || '_set_org', t);

    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format($p$create policy %I on public.%I for all
      using (org_id in (select public.user_org_ids()))
      with check (org_id in (select public.user_org_ids()))$p$, t || '_org_all', t);
  end loop;
end $$;

-- message_log has no user_id of its own; it was always scoped through clients,
-- and still is — just via the org boundary now.
drop policy if exists "message_log_owner_all" on public.message_log;
create policy "message_log_org_all" on public.message_log
  for all
  using (exists (select 1 from public.clients c where c.id = message_log.client_id and c.org_id in (select public.user_org_ids())))
  with check (exists (select 1 from public.clients c where c.id = message_log.client_id and c.org_id in (select public.user_org_ids())));

-- events was created with separate select/insert policies (append-only); the
-- loop above replaced them with a single org_all, which would have granted
-- update and delete. Restore the append-only guarantee.
drop policy if exists "events_org_all" on public.events;
drop policy if exists "events_owner_select" on public.events;
drop policy if exists "events_owner_insert" on public.events;
create policy "events_org_select" on public.events
  for select using (org_id in (select public.user_org_ids()));
create policy "events_org_insert" on public.events
  for insert with check (org_id in (select public.user_org_ids()));
