-- Twice-daily automatic calendar sync (John's ask: never manually drop in an
-- .ics file again). pg_cron schedules run in UTC; 16:00/21:00 UTC is
-- noon/5pm US Eastern during EDT (the current daylight-saving period). This
-- will drift by an hour during EST (roughly early November to mid March) —
-- a known limitation of plain pg_cron, not worth the complexity of a
-- DST-aware scheduler for a "close enough, twice a day" convenience sync.
-- The manual "Sync now" button in the app always works immediately either way.
--
-- The service_role key used to call the Edge Function is NOT in this file —
-- it's stored in Supabase Vault (supabase_vault, already enabled on this
-- project) via a one-off `select vault.create_secret(...)` run directly
-- against the DB, outside of version control. This migration only ever
-- reads it back by name at cron execution time.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'ghostbuster-calendar-sync-noon',
  '0 16 * * *',
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

select cron.schedule(
  'ghostbuster-calendar-sync-5pm',
  '0 21 * * *',
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
