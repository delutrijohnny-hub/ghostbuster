-- Sync health for the team view, without handing over the keys.
--
-- Companion to 20261005160000, which made google_oauth_tokens owner-only
-- because refresh_token is a live credential rather than a record.
--
-- That left a hole the team view falls straight into. loadTeamRows reads
-- last_sync directly from that table to answer "is this person's calendar
-- working?". Once the team shares an organisation, a manager reading that
-- table gets nothing back — and the view would report every teammate as "no
-- calendar connected". Not an error, not a warning: a confident, wrong answer
-- that looks exactly like the real thing. That is the silent failure the whole
-- migration ordering exists to avoid, so this lands WITH the merge, not after.
--
-- The function returns four columns and no others. refresh_token and
-- access_token are not selectable through it at all, so a manager can see that
-- a calendar stopped syncing on Tuesday without ever being able to act as that
-- person against Google.
--
-- SECURITY DEFINER means this runs as the owner and bypasses RLS, so the where
-- clause below IS the access control — there is no policy underneath it to
-- catch a mistake. It is deliberately the same test the policies use: your own
-- row, or a row in an organisation you manage. For an unauthenticated caller
-- auth.uid() is null, so both halves are false and it returns nothing; execute
-- is revoked from anon as well, belt and braces.

create or replace function public.team_calendar_health()
returns table (
  user_id      uuid,
  calendar_id  text,
  last_sync    timestamptz,
  connected_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select t.user_id, t.calendar_id, t.last_sync, t.connected_at
    from public.google_oauth_tokens t
   where t.user_id = auth.uid()
      or t.org_id in (select public.user_managed_org_ids())
$$;

revoke all on function public.team_calendar_health() from public;
revoke all on function public.team_calendar_health() from anon;
grant execute on function public.team_calendar_health() to authenticated;
