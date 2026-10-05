-- Fill in outcomes that were logged on the abandoned duplicate account.
--
-- Run AFTER scripts/retire-duplicate-calendar-connections.sql.
--
-- WHAT THIS IS, HONESTLY
-- Chase and Ronin each had two accounts syncing one calendar, so each
-- appointment exists on both, carrying the same google_event_id. Outcomes they
-- recorded on the account they later abandoned never reached the account they
-- actually use.
--
-- The first estimate of this was 40 rows and it was wrong. Measured on
-- 5 Oct 2026: Chase had 19 outcomes on the dead account, 17 matched a live
-- appointment, and only 7 were genuinely missing — he had logged most of them
-- in both places. Ronin had 21, 12 matched, 3 missing, and 5 where the two
-- accounts DISAGREE about what happened.
--
-- So this fills roughly ten blanks. That is worth doing because it costs
-- nothing and loses nothing, not because it is a big recovery.
--
-- THE RULE IT FOLLOWS
-- Only ever writes where the live row still says 'Booked', i.e. where nothing
-- has been recorded. It never overwrites an outcome, so the five
-- disagreements are left exactly alone: the live account is the one Ronin has
-- used since August, and a script has no business overruling it. If those five
-- matter, they are a conversation with Ronin, not a migration.
--
-- Nothing is deleted. Messages are not ported either — there are six, on
-- Ronin's dead account, and inserting copies would inflate his send counts and
-- reply statistics for no real gain.
--
-- HOW TO RUN
-- Paste into the Supabase SQL editor. Run Step 1, read it, then Step 2.

-- ---------------------------------------------------------------------------
-- STEP 1 - read only. Shows exactly which appointments would gain an outcome,
-- and separately lists the disagreements that will be left untouched.
-- ---------------------------------------------------------------------------
with pair as (
  select 'richardsonchase06@gmail.com' as dead, 'chase@marketmakermgmt.com' as live
  union all select 'rsns625@gmail.com', 'ronin@marketmakermgmt.com'
)
select 'WILL FILL' as what, lu.email as live_account, l.name,
       l.call_date_time::date as call_date,
       l.status as live_status_now, d.status as outcome_to_copy
  from pair p
  join auth.users du on du.email = p.dead
  join public.clients d on d.user_id = du.id and d.status <> 'Booked'
  join auth.users lu on lu.email = p.live
  join public.clients l on l.user_id = lu.id
                       and l.google_event_id = d.google_event_id
                       and l.status = 'Booked'
union all
select 'LEFT ALONE (they disagree)', lu.email, l.name,
       l.call_date_time::date,
       l.status, d.status
  from pair p
  join auth.users du on du.email = p.dead
  join public.clients d on d.user_id = du.id and d.status <> 'Booked'
  join auth.users lu on lu.email = p.live
  join public.clients l on l.user_id = lu.id
                       and l.google_event_id = d.google_event_id
                       and l.status <> 'Booked'
                       and l.status <> d.status
order by what, live_account, call_date;

-- ---------------------------------------------------------------------------
-- STEP 2 - apply. Aborts if the number of blanks has moved since Step 1 was
-- read, which would mean somebody has been working the list in between.
-- ---------------------------------------------------------------------------
begin;

create temporary table _to_fill on commit drop as
with pair as (
  select 'richardsonchase06@gmail.com' as dead, 'chase@marketmakermgmt.com' as live
  union all select 'rsns625@gmail.com', 'ronin@marketmakermgmt.com'
)
select l.id as live_id, l.status as was, d.status as becomes
  from pair p
  join auth.users du on du.email = p.dead
  join public.clients d on d.user_id = du.id and d.status <> 'Booked'
  join auth.users lu on lu.email = p.live
  join public.clients l on l.user_id = lu.id
                       and l.google_event_id = d.google_event_id
                       and l.status = 'Booked';

do $$
declare n int;
begin
  select count(*) into n from _to_fill;
  if n = 0 then
    raise exception 'Nothing to fill. Either this has already run, or the retirement script has not.';
  end if;
  if n > 15 then
    raise exception 'Expected around ten rows, found %. Something has changed - re-read Step 1 first.', n;
  end if;
  raise notice 'filling % outcome(s)', n;
end $$;

update public.clients c
   set status = f.becomes,
       updated_at = now()
  from _to_fill f
 where c.id = f.live_id
   and c.status = 'Booked';   -- belt and braces: never overwrite a real outcome

commit;

-- ---------------------------------------------------------------------------
-- STEP 3 - confirm. Expect zero rows: nothing left that could be filled.
-- ---------------------------------------------------------------------------
with pair as (
  select 'richardsonchase06@gmail.com' as dead, 'chase@marketmakermgmt.com' as live
  union all select 'rsns625@gmail.com', 'ronin@marketmakermgmt.com'
)
select count(*) as still_fillable_should_be_0
  from pair p
  join auth.users du on du.email = p.dead
  join public.clients d on d.user_id = du.id and d.status <> 'Booked'
  join auth.users lu on lu.email = p.live
  join public.clients l on l.user_id = lu.id
                       and l.google_event_id = d.google_event_id
                       and l.status = 'Booked';
