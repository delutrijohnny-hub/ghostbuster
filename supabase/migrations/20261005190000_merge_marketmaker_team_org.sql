-- Step 3 of 3: the MarketMaker staff share one organisation, Johnny manages it.
--
-- This is the only migration in the sequence that changes what anyone can see.
-- Steps 1, 2a and 2b all landed as no-ops precisely so that this one could be a
-- data move against policies already known to work.
--
-- VERIFIED BEFORE IT RAN, NOT AFTER
-- The whole thing was first executed as a dry run ending in ROLLBACK, with
-- real RLS exercised as each person (set local role authenticated, with their
-- sub in request.jwt.claims). Checking as service_role proves nothing: it has
-- BYPASSRLS and reports everything healthy regardless. The dry run showed
-- every member seeing exactly their own rows, Johnny seeing all 775, and
-- nobody — including Johnny — able to read another person's Google token.
-- Re-verified identically after committing.
--
-- WHO IS IN
-- The six active staff accounts. Deliberately excluded: john (empty by
-- design), niklaus.c (never completed setup), daniel (left the team), and the
-- two retired duplicate accounts richardsonchase06 and rsns625. They keep
-- their own one-person organisations and are unaffected.
--
-- WHY RE-STAMPING EVERY TABLE MATTERS
-- Policies test org_id. Moving somebody's membership without moving their rows
-- would leave them unable to see their own book — silently, because an app
-- with no contacts looks exactly like an account that has none. Missing one
-- table out of the eight would do it.
--
-- REVERSIBLE
-- org_merge_backup holds each person's previous organisation per table, and
-- the membership rows replaced. The undo is at the bottom, commented out.
-- Keep it until the team view has been used in anger for a week.

create table if not exists public.org_merge_backup (
  tbl          text not null,
  user_id      uuid not null,
  old_org_id   uuid,
  old_role     text,
  backed_up_at timestamptz not null default now()
);

do $$
declare
  mm uuid;
  t  text;
begin
  insert into public.organizations (name) values ('Market Maker Management')
  returning id into mm;

  create temporary table _mm on commit drop as
  select u.id as user_id,
         case when u.email = 'delutrijohnny@gmail.com' then 'admin' else 'member' end as new_role
    from auth.users u
   where u.email in ('delutrijohnny@gmail.com','ethan@marketmakermgmt.com',
                     'ethan.m@marketmakermgmt.com','chase@marketmakermgmt.com',
                     'ronin@marketmakermgmt.com','zachary.l@marketmakermgmt.com');

  if (select count(*) from _mm) <> 6 then
    raise exception 'Expected 6 staff accounts, found %. Aborting.', (select count(*) from _mm);
  end if;

  insert into public.org_merge_backup (tbl, user_id, old_org_id, old_role)
  select 'memberships', m.user_id, m.org_id, m.role
    from public.memberships m
   where m.user_id in (select user_id from _mm);

  delete from public.memberships where user_id in (select user_id from _mm);
  insert into public.memberships (org_id, user_id, role)
  select mm, user_id, new_role from _mm;

  -- app_settings is keyed by user_id and has no id column, which is why the
  -- snapshot records (table, user, old org) rather than row identifiers. The
  -- re-stamp is by user anyway, so the undo can be too.
  foreach t in array array['clients','app_settings','variants','variant_stats',
                           'todos','email_library','events','google_oauth_tokens']
  loop
    execute format(
      'insert into public.org_merge_backup (tbl, user_id, old_org_id)
         select distinct %L, x.user_id, x.org_id
           from public.%I x where x.user_id in (select user_id from _mm)', t, t);
    execute format(
      'update public.%I x set org_id = %L from _mm m where x.user_id = m.user_id', t, mm);
  end loop;

  raise notice 'merged 6 accounts into %', mm;
end $$;

-- ---------------------------------------------------------------------------
-- UNDO. Restores every row's previous organisation and the old memberships.
-- ---------------------------------------------------------------------------
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['clients','app_settings','variants','variant_stats',
--                            'todos','email_library','events','google_oauth_tokens']
--   loop
--     execute format(
--       'update public.%I x set org_id = b.old_org_id
--          from public.org_merge_backup b
--         where b.tbl = %L and b.user_id = x.user_id', t, t);
--   end loop;
--   delete from public.memberships m
--    where m.user_id in (select user_id from public.org_merge_backup where tbl='memberships');
--   insert into public.memberships (org_id, user_id, role)
--   select old_org_id, user_id, old_role from public.org_merge_backup where tbl='memberships';
--   delete from public.organizations where name = 'Market Maker Management';
-- end $$;
