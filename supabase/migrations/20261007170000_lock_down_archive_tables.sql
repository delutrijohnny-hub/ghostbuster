-- Close a live credential leak in the archive tables.
--
-- WHAT WAS WRONG
-- Three cleanup scripts (retire-duplicate-calendar-connections.sql,
-- delete-daniel-account.sql and the org merge) each snapshotted rows into an
-- archive table before touching them. Every one of those tables was created
-- with a plain CREATE TABLE in the public schema: no RLS, and the default
-- grants to anon and authenticated left in place.
--
-- public + PostgREST + no RLS = served to anyone holding the anon key, and the
-- anon key ships in the app's JavaScript. Verified from outside with nothing
-- but that key, before this ran:
--
--   google_oauth_tokens_archive   HTTP 206, 3 rows   <- includes refresh_token
--   clients_archive               HTTP 206, 47 rows  <- real client records
--   org_merge_backup              HTTP 206, 38 rows
--   message_log_archive           reachable (column error, not 401)
--
-- while the live tables were correctly refused (clients -> 401).
--
-- google_oauth_tokens_archive is the serious one. A Google refresh token is a
-- live credential, not a record: it lets the holder read that person's
-- calendar until it is revoked. Migration 20261005160000 made the LIVE token
-- table owner-only for exactly this reason, and the archive copy of the same
-- rows was left behind.
--
-- THE FIX
-- RLS on with no policies at all, plus the grants revoked. Nothing in the app
-- reads these tables — checked across hosted/, supabase/functions/ and the
-- local build — they exist only as a rollback path, and a rollback is run by
-- an administrator through a service_role connection, which bypasses RLS.
-- So this removes browser access entirely and costs nothing operationally.
--
-- Belt and braces deliberately: either RLS or the revoke would be enough on
-- its own, and a future CREATE POLICY added without thinking should not be
-- able to re-open it by itself.

alter table public.google_oauth_tokens_archive enable row level security;
alter table public.clients_archive             enable row level security;
alter table public.message_log_archive         enable row level security;
alter table public.org_merge_backup            enable row level security;

revoke all on public.google_oauth_tokens_archive from anon, authenticated;
revoke all on public.clients_archive             from anon, authenticated;
revoke all on public.message_log_archive         from anon, authenticated;
revoke all on public.org_merge_backup            from anon, authenticated;

-- email_events already had RLS on with no policies, which is closed, but it
-- still carries the default grants. Revoke them so it matches the rest.
revoke all on public.email_events from anon, authenticated;

-- user_org_ids() is SECURITY DEFINER and was callable by anon over
-- /rest/v1/rpc. For an unauthenticated caller auth.uid() is null so it returns
-- nothing, but every other function in this schema revokes anon explicitly and
-- this one was missed.
revoke all on function public.user_org_ids() from public, anon;
grant execute on function public.user_org_ids() to authenticated;
