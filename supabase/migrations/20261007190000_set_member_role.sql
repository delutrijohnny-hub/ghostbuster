-- Let a manager appoint another manager, from inside the app.
--
-- Until now role lived only in the database and every change was a hand-written
-- UPDATE. memberships is SELECT-only to the client, deliberately, because it is
-- the table that decides who can see whose book.
--
-- WHY THIS CANNOT LOCK AN ORGANISATION OUT
-- An org with no manager is unrecoverable from inside the product: nobody can
-- invite, nobody can appoint, and the team view belongs to nobody. The obvious
-- guard is "refuse if this would leave zero managers", which means counting,
-- and counting races with a second manager doing the same thing.
--
-- The rule used instead is simpler and needs no count: YOU CANNOT CHANGE YOUR
-- OWN ROLE. Demotion therefore only ever applies to somebody else, so whoever
-- performs it is still a manager when it finishes. At least one manager always
-- remains, under any interleaving, with no locking.
--
-- It also prevents the likelier accident — a sole manager demoting themselves
-- while tidying up — which no count-based check would catch until it was the
-- very last one.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- No removal from the organisation. Leaving is not the inverse of joining:
-- accepting an invite re-stamps org_id across eight tables, so "remove" would
-- have to decide where that person's contacts and history go, and silently
-- guessing is how a book gets lost. That is a separate decision with its own
-- confirmation, not a dropdown.
--
-- SECURITY DEFINER because memberships has no UPDATE policy for the client,
-- so the checks below ARE the access control, with nothing underneath to catch
-- a mistake. They are the same test the data policies use.

create or replace function public.set_member_role(target uuid, new_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  tgt_org  uuid;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;

  if new_role not in ('member', 'admin') then
    return jsonb_build_object('ok', false, 'error', 'unknown role');
  end if;

  -- The whole lockout guarantee. Keep this first and keep it unconditional:
  -- first also means the refusal is identical whoever the target is, so it
  -- never reveals who is on your team.
  if target = me then
    return jsonb_build_object('ok', false,
      'error', 'You cannot change your own role. Ask another manager.');
  end if;

  select m.org_id into tgt_org from public.memberships m where m.user_id = target;

  -- Same message whether they are in another org or do not exist: telling a
  -- caller which addresses have accounts is a leak in itself.
  if tgt_org is null or tgt_org not in (select public.user_managed_org_ids()) then
    return jsonb_build_object('ok', false, 'error', 'not someone you manage');
  end if;

  update public.memberships set role = new_role
   where user_id = target and org_id = tgt_org;

  return jsonb_build_object('ok', true, 'role', new_role);
end $$;

revoke all on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;
