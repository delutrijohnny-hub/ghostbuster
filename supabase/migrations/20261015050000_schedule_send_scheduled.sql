-- Work the queue every five minutes.
--
-- Five rather than one: a scheduled text is wanted "around 9am", not at
-- 09:00:00, and a tighter loop would multiply the cost of a runner that does
-- a handful of reads per message for nothing most of the time.
--
-- It is also what makes the quiet-hours hold work. A message queued for 3am
-- is not cancelled, it is left pending and skipped; this schedule is what
-- picks it up again once the window opens at 8am their time.
select cron.schedule(
  'ghostrecall-send-scheduled',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://gqfpsjksosxvszzhhezu.functions.supabase.co/send-scheduled',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ghostbuster_service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
