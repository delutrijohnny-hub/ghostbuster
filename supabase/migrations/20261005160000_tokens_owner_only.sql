-- Google refresh tokens become readable only by the person they belong to.
--
-- Part of step 2 in scripts/manager-access-plan.md, split out because it
-- NARROWS access and therefore stands alone. The rest of step 2 widens it and
-- is a separate decision.
--
-- WHY
-- google_oauth_tokens stores refresh_token, which is not data about a person,
-- it is a live credential. Anyone who can read it can act as that person
-- against their Google Calendar indefinitely, and keeps being able to after
-- they leave the company. The old policy said "any member of the row's
-- organisation", which was harmless only because every organisation happens to
-- contain exactly one person today.
--
-- The moment a real team shares an organisation, that policy would hand every
-- member their colleagues' Google credentials. Wanting to know whether a
-- teammate's calendar is syncing does not justify holding the key to it. This
-- was very nearly written the other way round.
--
-- SAFE TODAY
-- Verified before applying: all 6 token rows have a user_id that is a member of
-- that row's org_id, so nobody loses sight of their own connection and no
-- calendar page goes blank.
--
-- CONSEQUENCE, HANDLED SEPARATELY
-- The team view needs last_sync to report sync health and currently reads this
-- table directly in loadTeamRows. Under this policy it would report every
-- teammate as "no calendar connected" once orgs are shared. The fix is a
-- narrow function exposing only calendar_id and last_sync — never the token —
-- and must land in the same step as the org merge, not after it.

drop policy if exists "google_oauth_tokens_org_all" on public.google_oauth_tokens;

create policy "google_oauth_tokens_owner_only" on public.google_oauth_tokens
  for all
  using (
    org_id in (select public.user_org_ids())
    and user_id = auth.uid()
  )
  with check (
    org_id in (select public.user_org_ids())
    and user_id = auth.uid()
  );
