-- When each teammate last opened the app.
--
-- A manager can already see that Chase has sent nothing. What they cannot see
-- is whether Chase has even opened Ghost Recall, and those are completely
-- different conversations: one is "you are not working your list", the other
-- is "you have not logged in since the third of September". Getting that wrong
-- is how you tell somebody off for ignoring a tool they could not get into.
--
-- auth.users is not reachable from the browser, and should not be — it holds
-- email addresses, password hashes, recovery tokens and provider identities.
-- So this exposes exactly two timestamps and nothing else, for the people the
-- caller manages.
--
-- SECURITY DEFINER because auth.users is unreadable to `authenticated` at all.
-- That means it bypasses RLS and the where clause IS the access control, with
-- no policy underneath to catch a mistake — the same test the data policies
-- use: yourself, or somebody in an organisation you manage.
--
-- Deliberately NOT included: email, phone, provider, confirmation state. A
-- manager seeing a colleague's sign-in time is reasonable; a manager pulling
-- their recovery address out of the CRM is not.

create or replace function public.team_sign_in_activity()
returns table (
  user_id      uuid,
  last_sign_in timestamptz,
  signed_up    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.last_sign_in_at, u.created_at
    from auth.users u
   where u.id = auth.uid()
      or exists (
        select 1 from public.memberships m
         where m.user_id = u.id
           and m.org_id in (select public.user_managed_org_ids())
      )
$$;

revoke all on function public.team_sign_in_activity() from public;
revoke all on function public.team_sign_in_activity() from anon;
grant execute on function public.team_sign_in_activity() to authenticated;
