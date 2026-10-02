-- Clean up contacts created by ONE recurring calendar series.
--
-- WHY THIS EXISTS
-- Google is asked for singleEvents, which expands a recurring series into one
-- event per occurrence. Until the fix deployed on 2026-10-02 nothing in the
-- pipeline worked at the level of the set, so a single standing meeting on
-- Zachary's calendar became 133 upcoming "clients" running out to March 2027.
-- The eight real bookings on that account were buried in them, and every fake
-- one carried its own follow-up cadence.
--
-- The code fix stops this happening again (collapseRecurringSeries, plus a
-- guard so an incremental sync cannot rebuild the pile a few rows per run).
-- It does NOT remove the rows already written. That is what this does.
--
-- WHY IT IS SAFE
-- Verified on 2026-10-02 against all 133 rows: 0 messages sent, 0 notes,
-- 0 recaps, 0 close outcomes, 0 status changes, 0 reschedules, 0 snoozes,
-- 0 skipped stages, 0 manually added. The only non-null field beyond the
-- import itself is email_status = 'ok', which is set on all 941 rows in the
-- table and is a default rather than a record of anything.
--
-- Nothing else on the account is touched: every other duplicate contact in
-- the system is the same person booking a SECOND call weeks later, which is
-- real repeat business and a separate event with its own series key.
--
-- HOW TO RUN
-- Paste the whole file into the Supabase SQL editor and run it. Step 1 only
-- reads, so run it first and check the numbers. Step 2 does the delete and
-- is wrapped in a transaction that refuses to touch a row carrying any human
-- work, so a surprise aborts the whole thing rather than half-deleting.

-- ---------------------------------------------------------------------------
-- STEP 1 — read only. Expect: 133 rows, 132 to delete, 1 kept, 0 with work.
-- ---------------------------------------------------------------------------
with series as (
  select c.*
  from public.clients c
  join auth.users u on u.id = c.user_id
  where u.email like 'zachary.l%'
    and c.google_event_id like '9a8n5ds6dfqsq2smuctj43qq9b%'
),
keeper as (
  select id from series where call_date_time >= now()
  order by call_date_time limit 1
)
select
  (select count(*) from series)                                   as series_rows,
  (select count(*) from series) - 1                               as will_delete,
  (select count(*) from keeper)                                   as will_keep,
  (select count(*) from public.message_log m
     where m.client_id in (select id from series))                as messages_sent_must_be_0,
  (select count(*) from series s
     where coalesce(s.notes,'') <> '' or coalesce(s.recap,'') <> ''
        or coalesce(s.close_outcome,'') <> '' or s.status <> 'Booked'
        or s.manually_added is true or coalesce(s.reschedule_count,0) > 0
        or s.ignored is true or s.snoozed_until <> '{}'::jsonb
        or coalesce(s.skipped_stages,'{}'::jsonb) <> '{}'::jsonb) as rows_with_work_must_be_0;

-- ---------------------------------------------------------------------------
-- STEP 2 — the delete. Keeps the next upcoming occurrence so the standing
-- meeting still shows up once, which is also what the sync would now create.
-- ---------------------------------------------------------------------------
begin;

create temporary table _series_doomed on commit drop as
with series as (
  select c.*
  from public.clients c
  join auth.users u on u.id = c.user_id
  where u.email like 'zachary.l%'
    and c.google_event_id like '9a8n5ds6dfqsq2smuctj43qq9b%'
),
keeper as (
  select id from series where call_date_time >= now()
  order by call_date_time limit 1
)
select s.id
from series s
where s.id not in (select id from keeper)
  -- Belt and braces: never delete a row somebody has actually worked.
  and coalesce(s.notes,'') = '' and coalesce(s.recap,'') = ''
  and coalesce(s.close_outcome,'') = '' and s.status = 'Booked'
  and s.manually_added is not true and coalesce(s.reschedule_count,0) = 0
  and s.ignored is not true and s.snoozed_until = '{}'::jsonb
  and coalesce(s.skipped_stages,'{}'::jsonb) = '{}'::jsonb
  and not exists (select 1 from public.message_log m where m.client_id = s.id);

-- Refuse to proceed unless this is exactly the 132 rows expected. If the
-- number moved, something changed since this was written and it should be
-- re-checked rather than guessed at.
do $$
declare n int;
begin
  select count(*) into n from _series_doomed;
  if n <> 132 then
    raise exception 'Expected 132 rows to delete, found %. Aborting.', n;
  end if;
end $$;

delete from public.clients where id in (select id from _series_doomed);

commit;

-- ---------------------------------------------------------------------------
-- STEP 3 — confirm. Expect 1 series row left, and the 8 real bookings intact.
-- ---------------------------------------------------------------------------
select
  count(*) filter (where c.google_event_id like '9a8n5ds6dfqsq2smuctj43qq9b%') as series_rows_left,
  count(*) filter (where c.call_date_time >= now())                            as upcoming_total,
  count(*)                                                                     as contacts_total
from public.clients c
join auth.users u on u.id = c.user_id
where u.email like 'zachary.l%';
