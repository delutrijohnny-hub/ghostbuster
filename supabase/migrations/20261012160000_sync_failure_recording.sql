-- Why a sync stopped, not just that it did.
--
-- last_sync is only written on success, so a stale timestamp already means
-- "something broke" -- but it cannot say what, and nobody is watching it.
-- Every failure mode so far (a revoked grant, an expired refresh token, a
-- Google API error) was found because a person eventually complained.
--
-- consecutive_failures rather than a boolean: one failed run is a blip,
-- usually a timeout. Repeated failure is a broken connection, and the
-- difference decides whether anybody should be told.
alter table public.google_oauth_tokens
  add column if not exists last_error           text,
  add column if not exists last_error_at        timestamptz,
  add column if not exists consecutive_failures integer not null default 0;

comment on column public.google_oauth_tokens.consecutive_failures is
  'Reset to 0 by a successful sync. Two or more means the connection is broken rather than unlucky.';

-- The operator view: every connection that is failing or has gone quiet,
-- with enough context to know who to contact and about what.
--
-- Security definer because it reads auth.users for the email, and it is
-- deliberately NOT granted to anon or authenticated -- this is the operator
-- looking across every customer, which is exactly what RLS exists to stop a
-- signed-in user doing. Service role only.
create or replace function public.ops_sync_health()
returns table (
  email            text,
  calendar_id      text,
  last_sync        timestamptz,
  hours_since_sync numeric,
  consecutive_failures integer,
  last_error       text,
  last_error_at    timestamptz
)
language sql
security definer
set search_path to 'public'
as $$
  select u.email::text, t.calendar_id, t.last_sync,
         round(extract(epoch from (now() - t.last_sync)) / 3600.0, 1),
         t.consecutive_failures, t.last_error, t.last_error_at
  from public.google_oauth_tokens t
  join auth.users u on u.id = t.user_id
  where t.consecutive_failures >= 2
     or t.last_sync is null
     -- The cron runs at 11:00, 16:00 and 21:00 UTC, so a healthy connection
     -- is never more than ~19 hours stale. 36 is two missed days' worth of
     -- runs, which is a real fault rather than one skipped job.
     or t.last_sync < now() - interval '36 hours'
  order by t.consecutive_failures desc, t.last_sync asc nulls first;
$$;

revoke all on function public.ops_sync_health() from anon, authenticated, public;
