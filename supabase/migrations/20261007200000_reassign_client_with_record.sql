-- Hand an appointment to somebody else, atomically, and leave a record.
--
-- WHY THIS CANNOT BE DONE FROM THE CLIENT
-- The move itself already could: the clients policy lets a manager update any
-- row in an organisation they manage. The RECORD could not. events_org_insert
-- requires user_id = auth.uid() — you may only write history about yourself —
-- which is exactly the right rule and which a handover must cross, because the
-- entry has to land on the NEW OWNER's timeline or the person who inherits the
-- work cannot see where it came from. Filing it against the actor instead
-- would put it somewhere the rep is not allowed to read.
--
-- Verified rather than assumed: the direct insert came back "new row violates
-- row-level security policy for table events", and the try/catch around it in
-- the browser would have swallowed that into a console line — the contact
-- changing hands with no trace anywhere, silently, forever.
--
-- Doing the two writes separately from the browser also meant the audit could
-- fail on its own. Here they are one statement or neither.
--
-- WHAT IT CHECKS THAT NOTHING CHECKED BEFORE
-- That the destination is actually on the team. The clients WITH CHECK
-- constrains org_id and manager-ness but never the incoming user_id, so a
-- reassignment to any uuid at all was permitted — stranding the contact with
-- an owner who is not in the organisation and cannot see it. Not reachable
-- from the interface, which only ever offers teammates, and not enforced
-- anywhere either.
--
-- SECURITY DEFINER, so the checks below ARE the access control:
--   - the caller manages the contact's organisation, or owns the contact
--   - the destination is a member of that same organisation
-- The events table stays append-only to the browser; nothing here grants a
-- client the ability to write history about anyone else.

create or replace function public.reassign_client(
  p_client text,
  p_to     uuid,
  p_meta   jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me        uuid := auth.uid();
  c_org     uuid;
  c_owner   uuid;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;

  select org_id, user_id into c_org, c_owner
    from public.clients where id = p_client;

  if c_org is null then
    return jsonb_build_object('ok', false, 'error', 'no such contact');
  end if;

  if c_owner <> me and c_org not in (select public.user_managed_org_ids()) then
    return jsonb_build_object('ok', false, 'error', 'not allowed');
  end if;

  if c_owner = p_to then
    return jsonb_build_object('ok', false, 'error', 'already theirs');
  end if;

  -- The check that did not exist. Without it a contact can be handed to
  -- somebody outside the organisation and effectively disappears.
  if not exists (select 1 from public.memberships m
                  where m.user_id = p_to and m.org_id = c_org) then
    return jsonb_build_object('ok', false, 'error', 'that person is not on this team');
  end if;

  update public.clients
     set user_id = p_to, updated_at = now()
   where id = p_client;

  -- Against the new owner, so it sits on the contact where it now lives and
  -- the person inheriting it can actually read it. The actor is in the
  -- payload, because those are different people and that is the point.
  insert into public.events (user_id, client_id, org_id, kind, data)
  values (p_to, p_client, c_org, 'owner.changed',
          jsonb_build_object('from', c_owner, 'to', p_to, 'by', me)
            || coalesce(p_meta, '{}'::jsonb));

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.reassign_client(text, uuid, jsonb) from public, anon;
grant execute on function public.reassign_client(text, uuid, jsonb) to authenticated;
