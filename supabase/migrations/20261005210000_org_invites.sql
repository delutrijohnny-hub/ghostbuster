-- Let a manager build a team, with the invited person's consent.
--
-- Until now every account landed in its own one-person organisation from a
-- trigger, and nothing in the client could add anyone to anyone else's. The
-- only existing team was assembled by a migration running as service_role. So
-- every manager feature built this week was unreachable for any customer.
--
-- WHY ACCEPTANCE IS NOT OPTIONAL
-- Joining an organisation re-stamps org_id across the joiner's contacts,
-- messages, settings and templates — that is what makes them visible to their
-- manager, and it is the whole point. Which means a one-sided "add by email"
-- would let anybody type a stranger's address and pull that stranger's entire
-- book into their own organisation. Not a theoretical risk: it is a complete
-- data breach reachable from a text input.
--
-- So an invite is only ever a request. Nothing moves until the person whose
-- data it is accepts, and acceptance is an action taken by THEM, verified
-- against the email on their own token.
--
-- Invites to people who have not signed up yet are kept too: they sit until
-- that email appears, which is why the table is keyed on email rather than on
-- a user id that may not exist.

create table if not exists public.org_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('member','admin')),
  invited_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at  timestamptz
);

create unique index if not exists org_invites_pending
  on public.org_invites (org_id, lower(email))
  where accepted_at is null and revoked_at is null;
create index if not exists org_invites_email on public.org_invites (lower(email));

alter table public.org_invites enable row level security;

-- A manager sees and manages invites for organisations they manage. The
-- invited person sees invites addressed to them, and nothing else — not who
-- else was invited, not the rest of the organisation.
create policy "org_invites_manager" on public.org_invites
  for all
  using (org_id in (select public.user_managed_org_ids()))
  with check (
    org_id in (select public.user_managed_org_ids())
    and invited_by = auth.uid()
  );

create policy "org_invites_addressee_select" on public.org_invites
  for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

/* Accepting is the only thing that moves data, and only your own.

   SECURITY DEFINER because it writes rows the caller's own policies would
   refuse — their org_id is about to change out from under those policies. The
   checks below are therefore the whole of the access control:

     - the invite must exist, be unaccepted and unrevoked
     - its email must match the email on the caller's token
     - only the caller's own rows are ever touched

   There is deliberately no way to accept on somebody else's behalf, including
   for the manager who sent it. */
create or replace function public.accept_org_invite(invite uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me        uuid := auth.uid();
  my_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  inv       public.org_invites%rowtype;
  old_org   uuid;
  t         text;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;

  select * into inv from public.org_invites
   where id = invite and accepted_at is null and revoked_at is null;

  if inv.id is null then
    return jsonb_build_object('ok', false, 'error', 'invite not found or already used');
  end if;

  if lower(inv.email) <> my_email or my_email = '' then
    -- Deliberately the same message as a missing invite: telling a caller
    -- that an invite exists for an address they do not own is itself a leak.
    return jsonb_build_object('ok', false, 'error', 'invite not found or already used');
  end if;

  select m.org_id into old_org from public.memberships m where m.user_id = me limit 1;

  if old_org = inv.org_id then
    return jsonb_build_object('ok', false, 'error', 'already a member');
  end if;

  delete from public.memberships where user_id = me;
  insert into public.memberships (org_id, user_id, role) values (inv.org_id, me, inv.role);

  -- Every table carrying org_id, or the joiner stops seeing their own work.
  foreach t in array array['clients','app_settings','variants','variant_stats',
                           'todos','email_library','events','google_oauth_tokens']
  loop
    execute format('update public.%I x set org_id = $1 where x.user_id = $2', t)
      using inv.org_id, me;
  end loop;

  update public.org_invites set accepted_at = now() where id = inv.id;

  -- The organisation they came from, if now empty, is left in place rather
  -- than dropped: it costs nothing and it is the route back if this was a
  -- mistake.
  return jsonb_build_object('ok', true, 'org_id', inv.org_id);
end $$;

revoke all on function public.accept_org_invite(uuid) from public;
revoke all on function public.accept_org_invite(uuid) from anon;
grant execute on function public.accept_org_invite(uuid) to authenticated;

/* What an invited person is shown. Returns only invites addressed to the
   caller, with the inviting organisation's name — never its membership, its
   contacts or anything else about it. */
create or replace function public.my_pending_invites()
returns table (id uuid, org_id uuid, org_name text, role text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.org_id, o.name, i.role, i.created_at
    from public.org_invites i
    join public.organizations o on o.id = i.org_id
   where i.accepted_at is null
     and i.revoked_at is null
     and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
     and coalesce(auth.jwt() ->> 'email', '') <> ''
$$;

revoke all on function public.my_pending_invites() from public;
revoke all on function public.my_pending_invites() from anon;
grant execute on function public.my_pending_invites() to authenticated;
