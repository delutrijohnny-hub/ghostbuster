-- Teach the database what a manager is. Grants nobody anything, yet.
--
-- Step 1 of 3; the plan and the reasoning live in scripts/manager-access-plan.md.
--
-- The existing user_org_ids() answers "which organisations is the caller in?"
-- and ignores role completely. Every data table's policy is built on it and
-- granted for ALL commands, which is why putting a real team into one shared
-- organisation would hand every member read AND WRITE over every other
-- member's contacts.
--
-- This adds the narrower question next to it: "which organisations does the
-- caller MANAGE?" Nothing reads it yet. No policy changes, no data moves, and
-- no account's access differs by a single row after this runs.
--
-- On today's data it returns, for every account, exactly their own
-- one-person organisation, because each person is the owner of theirs. That
-- is deliberate: it means the policy rewrite in step 2 is also a no-op, and a
-- no-op is a thing you can deploy and verify calmly.
--
-- SECURITY DEFINER for the same reason user_org_ids() is: a policy on
-- memberships that queries memberships would recurse. STABLE so the planner
-- evaluates it once per statement rather than once per row.

create or replace function public.user_managed_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id
    from public.memberships
   where user_id = auth.uid()
     and role in ('owner', 'admin')
$$;

-- Same posture as user_org_ids(): never reachable by an unauthenticated
-- caller, and never by PUBLIC, which anon inherits from.
revoke all on function public.user_managed_org_ids() from public;
revoke all on function public.user_managed_org_ids() from anon;
grant execute on function public.user_managed_org_ids() to authenticated;
