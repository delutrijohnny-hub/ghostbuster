-- Stop two calendars being imported twice.
--
-- WHY THIS EXISTS
-- Two people each have two Ghost Recall accounts, and both accounts in each
-- pair are connected to the SAME Google calendar:
--
--   chase@marketmakermgmt.com   and  richardsonchase06@gmail.com  -> chase@
--   ronin@marketmakermgmt.com   and  rsns625@gmail.com            -> ronin@
--
-- So every booking is imported twice into two separate lists, and the outcome
-- history is split across them. On 5 Oct 2026 Chase had logged 19 outcomes on
-- the account he last signed into on 3 September and 10 on the one he actually
-- uses. He is working one list while half his record lives in the other.
--
-- This retires the calendar connection on the account each person ABANDONED,
-- keeping the one they actually sign into. It is the smallest change that
-- fixes the problem.
--
-- WHAT IT DOES NOT DO
-- Nothing is deleted except the connection row itself, and even that is copied
-- into an archive table first, so this is reversible. No contact, message,
-- outcome or note is touched. The retired accounts keep everything they
-- already hold; they simply stop importing new bookings. Porting the split
-- outcome history across is a separate, later step.
--
-- AFTER RUNNING
-- The two retired accounts will report "no calendar connected", which is now
-- true and intended. Tell the daily team check so it stops flagging them.
--
-- HOW TO RUN
-- Paste into the Supabase SQL editor. Run Step 1 first and read the numbers.
-- Step 2 refuses to run unless it finds exactly the two expected rows and can
-- prove both calendars remain connected on the surviving accounts.

-- ---------------------------------------------------------------------------
-- STEP 1 - read only. Expect two rows marked RETIRE and two marked KEEP, and
-- every "calendar still covered" value to be true.
-- ---------------------------------------------------------------------------
select
  u.email,
  t.calendar_id,
  u.last_sign_in_at::date                                    as last_sign_in,
  case when u.email in ('richardsonchase06@gmail.com','rsns625@gmail.com')
       then 'RETIRE' else 'KEEP' end                          as action,
  (select count(*) from public.clients c where c.user_id = u.id)        as contacts_kept,
  (select count(*) from public.clients c
     where c.user_id = u.id and c.status <> 'Booked')                   as outcomes_kept,
  exists (
    select 1
      from public.google_oauth_tokens t2
      join auth.users u2 on u2.id = t2.user_id
     where t2.calendar_id = t.calendar_id
       and u2.email not in ('richardsonchase06@gmail.com','rsns625@gmail.com')
  )                                                           as calendar_still_covered
from public.google_oauth_tokens t
join auth.users u on u.id = t.user_id
where t.calendar_id in ('chase@marketmakermgmt.com','ronin@marketmakermgmt.com')
order by t.calendar_id, action;

-- ---------------------------------------------------------------------------
-- STEP 2 - archive, then remove. Wrapped in a transaction that aborts whole
-- rather than half-applying if anything is not as expected.
-- ---------------------------------------------------------------------------
begin;

-- The undo. Keeps the refresh token, so a restore is a plain insert back and
-- nobody has to re-authorise anything through Google.
create table if not exists public.google_oauth_tokens_archive
  (like public.google_oauth_tokens including defaults);
alter table public.google_oauth_tokens_archive
  add column if not exists archived_at timestamptz not null default now();
alter table public.google_oauth_tokens_archive
  add column if not exists archived_reason text;

create temporary table _retiring on commit drop as
select t.*
  from public.google_oauth_tokens t
  join auth.users u on u.id = t.user_id
 where u.email in ('richardsonchase06@gmail.com','rsns625@gmail.com');

do $$
declare
  n int;
  uncovered int;
begin
  select count(*) into n from _retiring;
  if n <> 2 then
    raise exception 'Expected exactly 2 connections to retire, found %. Aborting.', n;
  end if;

  -- The whole point is that the calendar keeps syncing on the surviving
  -- account. If that is not true for both, this would silently stop somebody's
  -- bookings arriving at all, which is far worse than importing them twice.
  select count(*) into uncovered
    from _retiring r
   where not exists (
     select 1
       from public.google_oauth_tokens t2
       join auth.users u2 on u2.id = t2.user_id
      where t2.calendar_id = r.calendar_id
        and t2.user_id <> r.user_id
        and u2.email not in ('richardsonchase06@gmail.com','rsns625@gmail.com')
   );
  if uncovered > 0 then
    raise exception '% calendar(s) would be left with no connection at all. Aborting.', uncovered;
  end if;
end $$;

insert into public.google_oauth_tokens_archive
select r.*, now(), 'duplicate account - same calendar already connected on the account in use'
  from _retiring r;

delete from public.google_oauth_tokens t
 where t.id in (select id from _retiring);

commit;

-- ---------------------------------------------------------------------------
-- STEP 3 - confirm. Expect one connection per calendar, on the work-email
-- account, and 2 rows sitting in the archive.
-- ---------------------------------------------------------------------------
select u.email, t.calendar_id, t.last_sync
  from public.google_oauth_tokens t
  join auth.users u on u.id = t.user_id
 where t.calendar_id in ('chase@marketmakermgmt.com','ronin@marketmakermgmt.com')
 order by t.calendar_id;

select count(*) as archived_rows from public.google_oauth_tokens_archive;

-- ---------------------------------------------------------------------------
-- UNDO, if ever needed. Puts both connections back exactly as they were.
-- ---------------------------------------------------------------------------
-- insert into public.google_oauth_tokens
--   (id, user_id, calendar_id, priority, refresh_token, access_token,
--    token_expiry, sync_token, last_sync, connected_at, updated_at, org_id)
-- select id, user_id, calendar_id, priority, refresh_token, access_token,
--        token_expiry, sync_token, last_sync, connected_at, updated_at, org_id
--   from public.google_oauth_tokens_archive;
