-- A morning calendar sync, because the day's first one was at noon.
--
-- WHY
-- The two existing runs are 16:00 and 21:00 UTC — noon and 5pm Eastern during
-- EDT. That means the queue somebody works at 9am was built from the 5pm sync
-- the day before, and nothing new reaches the app until noon. On 2026-10-02
-- John's first call of the day was 11:00 ET, an hour BEFORE the first sync of
-- that day. Nothing was actually missed that morning, but a lead booked
-- overnight or early would have sat invisible through exactly the hours he
-- works the morning list, which is the one thing this app exists to prevent.
--
-- 11:00 UTC is 7am Eastern during EDT. Same DST caveat as the original
-- migration: it becomes 6am ET during EST (roughly early November to mid
-- March). That drift is harmless in this direction — a morning sync landing
-- earlier is still a morning sync — and is the reason this is a third fixed
-- run rather than a DST-aware scheduler.
--
-- The sync is incremental (Google syncToken), so a third run is cheap: it
-- fetches only what changed since the last one rather than rescanning.
--
-- cron.schedule() upserts by job name, so re-running this is safe. The
-- service_role key is read from Vault at execution time and is not in this
-- file, exactly as in 20260803200000_schedule_calendar_sync_cron.sql.

select cron.schedule(
  'ghostbuster-calendar-sync-morning',
  '0 11 * * *',
  $$
  select net.http_post(
    url := 'https://gqfpsjksosxvszzhhezu.functions.supabase.co/google-calendar-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ghostbuster_service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
