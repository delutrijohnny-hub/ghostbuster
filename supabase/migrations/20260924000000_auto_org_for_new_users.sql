-- New signups had no organization, which broke them completely.
--
-- The organizations migration backfilled one org per account that existed at
-- the time, via a DO block over auth.users. Nothing created an org for anyone
-- who signed up afterwards. Their memberships row does not exist, so
-- set_org_id_from_user() finds no org_id, leaves it NULL, and the NOT NULL
-- constraint rejects every insert — settings, clients, messages, all of it.
-- The app does not fail loudly either: loadState's first write is the
-- app_settings seed, so a new user gets an app that appears to load and then
-- silently refuses to save anything.
--
-- niklaus.c@marketmakermgmt.com had already hit this before it was noticed.
--
-- Two halves: make it impossible going forward, and repair anyone already
-- stranded.

-- 1) Every new auth user gets their own organization, as its owner.
--    SECURITY DEFINER because the trigger runs as the signing-up user, who by
--    definition has no rights to organizations or memberships yet.
create or replace function public.provision_org_for_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_org uuid;
begin
  -- Guard against double-provisioning if this ever runs twice for one user.
  if exists (select 1 from public.memberships where user_id = new.id) then
    return new;
  end if;
  insert into public.organizations (name)
    values (coalesce(nullif(split_part(new.email, '@', 1), ''), 'Workspace'))
    returning id into new_org;
  insert into public.memberships (org_id, user_id, role) values (new_org, new.id, 'owner');
  return new;
end $$;

drop trigger if exists on_auth_user_created_provision_org on auth.users;
create trigger on_auth_user_created_provision_org
  after insert on auth.users
  for each row execute function public.provision_org_for_new_user();

-- 2) Repair anyone who signed up between the org migration and this one.
do $$
declare u record; new_org uuid;
begin
  for u in
    select id, email from auth.users
    where id not in (select user_id from public.memberships)
  loop
    insert into public.organizations (name)
      values (coalesce(nullif(split_part(u.email, '@', 1), ''), 'Workspace'))
      returning id into new_org;
    insert into public.memberships (org_id, user_id, role) values (new_org, u.id, 'owner');
    raise notice 'provisioned organization for %', u.email;
  end loop;
end $$;
