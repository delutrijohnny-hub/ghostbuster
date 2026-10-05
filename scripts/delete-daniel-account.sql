-- Permanently remove Daniel's account.
--
-- Authorised by Johnny on 5 Oct 2026: "delete all of them". Daniel has left
-- the team. His calendar connection was already retired and archived earlier
-- the same day; this removes everything else.
--
-- WHAT GOES, measured 5 Oct 2026:
--   47  contacts
--   63  messages (the only reply data on the system outside Johnny's account)
--   28  message templates
--   22  variant statistics rows
--    1  app_settings row
--    1  membership, and his own one-person organisation
--    1  auth login
--
-- WORTH SAYING ONCE, NOT TWICE
-- Those 47 contacts are leads. Three of them have appointments still in the
-- future. If anybody else might work them, reassigning is a different and
-- smaller job than this: update clients.user_id and clients.org_id to the new
-- owner instead of running Step 3. That decision has been made; this is here
-- so the choice is visible to whoever reads it next.
--
-- RECOVERABLE, UP TO A POINT
-- Step 2 copies the contacts and messages into archive tables first, so a
-- mistake is recoverable for as long as those archives exist. That means the
-- data is still IN the database. If the intent is genuine erasure rather than
-- deactivation - somebody asked to be forgotten, say - run Step 5 as well,
-- which empties the archives and makes this irreversible.
--
-- HOW TO RUN
-- Paste into the Supabase SQL editor. Run Step 1 and check the numbers match
-- the list above before running anything else.

-- ---------------------------------------------------------------------------
-- STEP 1 - read only. Confirm the account and what it holds.
-- ---------------------------------------------------------------------------
with d as (select id from auth.users where email = 'daniel@marketmakermgmt.com')
select
  (select count(*) from auth.users where email='daniel@marketmakermgmt.com')              as account_exists,
  (select count(*) from public.clients where user_id=(select id from d))                  as contacts,
  (select count(*) from public.message_log m join public.clients c on c.id=m.client_id
     where c.user_id=(select id from d))                                                  as messages,
  (select count(*) from public.clients where user_id=(select id from d)
     and call_date_time >= now())                                                         as future_appointments,
  (select count(*) from public.google_oauth_tokens where user_id=(select id from d))      as calendars_should_be_0;

-- ---------------------------------------------------------------------------
-- STEP 2 - archive the two things that are genuinely records, then delete.
-- ---------------------------------------------------------------------------
begin;

create table if not exists public.clients_archive (like public.clients including defaults);
alter table public.clients_archive add column if not exists archived_at timestamptz not null default now();
alter table public.clients_archive add column if not exists archived_reason text;

create table if not exists public.message_log_archive (like public.message_log including defaults);
alter table public.message_log_archive add column if not exists archived_at timestamptz not null default now();
alter table public.message_log_archive add column if not exists archived_reason text;

create temporary table _dan on commit drop as
select id from auth.users where email = 'daniel@marketmakermgmt.com';

do $$
declare n int;
begin
  select count(*) into n from _dan;
  if n <> 1 then
    raise exception 'Expected exactly one account for daniel@marketmakermgmt.com, found %. Aborting.', n;
  end if;
end $$;

insert into public.message_log_archive
select m.*, now(), 'account deleted - left the team'
  from public.message_log m
  join public.clients c on c.id = m.client_id
 where c.user_id in (select id from _dan);

insert into public.clients_archive
select c.*, now(), 'account deleted - left the team'
  from public.clients c
 where c.user_id in (select id from _dan);

commit;

-- ---------------------------------------------------------------------------
-- STEP 3 - remove the account. Child rows first, so no foreign key complains.
-- ---------------------------------------------------------------------------
begin;

create temporary table _dan2 on commit drop as
select u.id,
       (select m.org_id from public.memberships m where m.user_id = u.id limit 1) as org_id
  from auth.users u where u.email = 'daniel@marketmakermgmt.com';

delete from public.message_log m
 using public.clients c
 where m.client_id = c.id and c.user_id in (select id from _dan2);

delete from public.clients        where user_id in (select id from _dan2);
delete from public.variants       where user_id in (select id from _dan2);
delete from public.variant_stats  where user_id in (select id from _dan2);
delete from public.todos          where user_id in (select id from _dan2);
delete from public.app_settings   where user_id in (select id from _dan2);
delete from public.email_library  where user_id in (select id from _dan2);
delete from public.events         where user_id in (select id from _dan2);
delete from public.memberships    where user_id in (select id from _dan2);

-- Only his own one-person organisation, and only if nobody else is left in it.
delete from public.organizations o
 where o.id in (select org_id from _dan2 where org_id is not null)
   and not exists (select 1 from public.memberships m where m.org_id = o.id);

delete from auth.users where id in (select id from _dan2);

commit;

-- ---------------------------------------------------------------------------
-- STEP 4 - confirm. Every number should be zero.
-- ---------------------------------------------------------------------------
select
  (select count(*) from auth.users where email='daniel@marketmakermgmt.com') as account,
  (select count(*) from public.clients c
     where not exists (select 1 from auth.users u where u.id = c.user_id))   as orphaned_contacts,
  (select count(*) from public.clients_archive)                              as contacts_in_archive,
  (select count(*) from public.message_log_archive)                          as messages_in_archive;

-- ---------------------------------------------------------------------------
-- STEP 5 - OPTIONAL and IRREVERSIBLE. Only if the intent is genuine erasure
-- rather than deactivation. Until this runs, the data is still in the database
-- and recoverable from the archive tables.
-- ---------------------------------------------------------------------------
-- delete from public.message_log_archive where archived_reason = 'account deleted - left the team';
-- delete from public.clients_archive     where archived_reason = 'account deleted - left the team';
