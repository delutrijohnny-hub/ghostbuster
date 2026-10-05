-- Make the data policies role-aware. Still a no-op on today's data.
--
-- Step 2b of 3; the plan lives in scripts/manager-access-plan.md.
--
-- Every policy here currently says "the row's organisation is one of mine",
-- granted for ALL commands, with no notion of role. That is fine while every
-- account is alone in its own organisation and wrong the moment a real team
-- shares one: every member would get read and write over every other member's
-- book.
--
-- The new rule is: your own rows, OR any row in an organisation you manage.
--
-- WHY IT IS SAFE TO LAND BEFORE THE TEAM ACTUALLY MERGES
-- It changes nobody's access today. Each person is currently the only member
-- of their own organisation, so "user_id = auth.uid()" already matches every
-- row they can see, and user_managed_org_ids() returns that same organisation
-- anyway. Verified: all 11 accounts manage exactly the one org they belong to.
--
-- Landing the risky rewrite while it is still a no-op is the entire point of
-- the ordering. If it is wrong, it is wrong now, when nothing depends on it,
-- rather than in the same change that moves eleven people's records.
--
-- HOW TO VERIFY, AND THE MISTAKE NOT TO MAKE
-- Sign in as an ordinary account and confirm the contact count is unchanged.
-- Do NOT check this as service_role: it bypasses RLS entirely and will report
-- everything healthy when it is not. The failure mode is silent — an app that
-- loads with zero contacts looks exactly like an account that has none.
--
-- google_oauth_tokens is deliberately absent. It was tightened to owner-only
-- in 20261005160000 because refresh_token is a live credential, not a record.
-- Do not add it to the loop below.

do $$
declare
  t text;
begin
  foreach t in array array[
    'clients', 'app_settings', 'variants', 'variant_stats',
    'todos', 'email_library'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_org_all', t);
    execute format($p$
      create policy %I on public.%I
        for all
        using (
          org_id in (select public.user_org_ids())
          and (
            user_id = auth.uid()
            or org_id in (select public.user_managed_org_ids())
          )
        )
        with check (
          org_id in (select public.user_org_ids())
          and (
            user_id = auth.uid()
            or org_id in (select public.user_managed_org_ids())
          )
        )
    $p$, t || '_org_all', t);
  end loop;
end $$;

-- events splits SELECT from INSERT, so it cannot go through the loop.
drop policy if exists "events_org_select" on public.events;
create policy "events_org_select" on public.events
  for select
  using (
    org_id in (select public.user_org_ids())
    and (
      user_id = auth.uid()
      or org_id in (select public.user_managed_org_ids())
    )
  );

-- Appending to a timeline is always about yourself. A manager has no reason to
-- write into somebody else's history, so this stays narrow on purpose.
drop policy if exists "events_org_insert" on public.events;
create policy "events_org_insert" on public.events
  for insert
  with check (
    org_id in (select public.user_org_ids())
    and user_id = auth.uid()
  );

-- message_log has neither org_id nor user_id of its own; it reaches through
-- its parent client, so the same rule is mirrored one join away.
drop policy if exists "message_log_org_all" on public.message_log;
create policy "message_log_org_all" on public.message_log
  for all
  using (exists (
    select 1 from public.clients c
     where c.id = message_log.client_id
       and c.org_id in (select public.user_org_ids())
       and (
         c.user_id = auth.uid()
         or c.org_id in (select public.user_managed_org_ids())
       )
  ))
  with check (exists (
    select 1 from public.clients c
     where c.id = message_log.client_id
       and c.org_id in (select public.user_org_ids())
       and (
         c.user_id = auth.uid()
         or c.org_id in (select public.user_managed_org_ids())
       )
  ));
