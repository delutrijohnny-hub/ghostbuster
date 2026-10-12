-- Tell the operator once a day, and only when something is wrong.
--
-- 12:30 UTC: ninety minutes after the 11:00 sync, so a connection that
-- failed this morning is reported this morning rather than tomorrow.
--
-- Authorised with the service-role key from the vault, the same way the
-- calendar sync crons are. ops-alert refuses anything else, because a
-- report about every customer's broken connection is itself customer data.
select cron.schedule(
  'ghostrecall-ops-alert',
  '30 12 * * *',
  $$
  select net.http_post(
    url := 'https://gqfpsjksosxvszzhhezu.functions.supabase.co/ops-alert',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ghostbuster_service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
