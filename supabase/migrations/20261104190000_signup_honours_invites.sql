/* Signing up should not strand you in a company of one.
 *
 * NOT YET APPLIED -- see docs/joining-a-team.md. Applying it changes no
 * existing row; it only changes what happens to the next person who signs up,
 * and what accept_org_invite moves when it is next called.
 *
 * What happened to Celeste: she signed up on 13 October, the trigger below
 * made her an organization named after her email prefix and her its owner,
 * organizations_start_trial gave that organization a 14-day clock, and on 27
 * October the trial ended and her app went read-only. She was never on the
 * team, nobody had invited her, and the symptom -- "a lot of the functions are
 * not active" -- pointed nowhere near the cause. Six people were merged by
 * hand on 5 October; she arrived after and nobody ran it again.
 *
 * Two things were wrong, and both are fixed here.
 *
 * ONE: the invite table existed and signup ignored it. org_invites,
 * my_pending_invites() and accept_org_invite() all work -- but they only help
 * somebody who has already been given a personal organization and then finds
 * the button. Until they do, they are a separate company on a trial clock.
 * Now an unused invite to that address wins, and no personal organization is
 * created at all.
 *
 * A genuinely new customer with no invite still gets their own organization
 * and their own trial, which is the product working as intended. The rule is
 * narrow on purpose: an invite is an explicit act by somebody who already
 * belongs. Matching on email DOMAIN was considered and rejected -- it would
 * mean anybody who can obtain an address at a company's domain joins its CRM
 * uninvited, which is a security decision disguised as a convenience.
 *
 * TWO: accept_org_invite moved eight tables and there are fifteen. Anybody
 * accepting an invite today would leave their notes, their recorded facts,
 * their per-contact wording, their scheduled messages, their archived
 * contacts and their inbound texts behind in an organization they no longer
 * belong to -- invisible to them and to everyone else. The list is now
 * derived from the schema rather than typed out, so a table added later
 * cannot be forgotten in the same way.
 *
 * Two tables are deliberately NOT moved:
 *   org_subscriptions -- billing belongs to the organization, not the person.
 *     Moving a trial row into an established team is how all eight people end
 *     up read-only at once; that nearly happened during Celeste's merge.
 *   org_phone_numbers -- a sending number is registered with the carrier
 *     against one organization. It does not follow a person out of it.
 */

create or replace function public.provision_org_for_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  new_org uuid;
  inv     public.org_invites%rowtype;
begin
  -- Guard against double-provisioning if this ever runs twice for one user.
  if exists (select 1 from public.memberships where user_id = new.id) then
    return new;
  end if;

  /* An outstanding invite to this address wins. Most recent first: if two
     people invited them, the later invitation is the current intent. */
  select * into inv
    from public.org_invites
   where coalesce(new.email, '') <> ''
     and lower(email) = lower(new.email)
     and accepted_at is null
     and revoked_at is null
   order by created_at desc
   limit 1;

  if inv.id is not null then
    insert into public.memberships (org_id, user_id, role)
      values (inv.org_id, new.id, inv.role);
    update public.org_invites set accepted_at = now() where id = inv.id;
    return new;
  end if;

  insert into public.organizations (name)
    values (coalesce(nullif(split_part(new.email, '@', 1), ''), 'Workspace'))
    returning id into new_org;
  insert into public.memberships (org_id, user_id, role)
    values (new_org, new.id, 'owner');
  return new;
end $function$;

create or replace function public.accept_org_invite(invite uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  me       uuid := auth.uid();
  my_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  inv      public.org_invites%rowtype;
  old_org  uuid;
  t        text;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;

  select * into inv from public.org_invites
   where id = invite and accepted_at is null and revoked_at is null;

  if inv.id is null then
    return jsonb_build_object('ok', false, 'error', 'invite not found or already used');
  end if;

  if lower(inv.email) <> my_email or my_email = '' then
    return jsonb_build_object('ok', false, 'error', 'invite not found or already used');
  end if;

  select m.org_id into old_org from public.memberships m
   where m.user_id = me order by m.created_at limit 1;

  if old_org = inv.org_id then
    return jsonb_build_object('ok', false, 'error', 'already a member');
  end if;

  delete from public.memberships where user_id = me;
  insert into public.memberships (org_id, user_id, role) values (inv.org_id, me, inv.role);

  /* Every table that carries both org_id and user_id, read from the schema
     rather than listed by hand. The hand-written list had eight of fifteen,
     and the six it was missing -- conversation_notes, client_facts,
     client_message_texts, clients_archive, scheduled_messages and the token
     archive -- are exactly the tables added after it was written. A list that
     has to be remembered is a list that goes stale. */
  for t in
    select c.table_name
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.column_name in ('org_id', 'user_id')
       and c.table_name not in ('memberships', 'org_invites', 'organizations',
                                'org_subscriptions', 'org_phone_numbers')
     group by c.table_name
    having count(distinct c.column_name) = 2
  loop
    execute format('update public.%I x set org_id = $1 where x.user_id = $2', t)
      using inv.org_id, me;
  end loop;

  /* Inbound texts hang off the contact, not the person, so they move with
     the contacts rather than by user_id. Left behind they would be scoped to
     an organization nobody is in, and the thread would lose its replies. */
  update public.sms_events e
     set org_id = inv.org_id
   where e.client_id in (select id from public.clients where user_id = me);

  update public.org_invites set accepted_at = now() where id = inv.id;
  return jsonb_build_object('ok', true, 'org_id', inv.org_id);
end $function$;

comment on function public.provision_org_for_new_user() is
  'New signup: an outstanding invite to that address wins, otherwise a personal org with its own trial.';
comment on function public.accept_org_invite(uuid) is
  'Moves the member and every table carrying their org_id+user_id, plus their contacts inbound texts. Billing and carrier numbers stay with the old org.';
