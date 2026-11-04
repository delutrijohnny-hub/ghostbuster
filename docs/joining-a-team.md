# Joining a team

## What went wrong, once

Celeste signed up on 13 October. The `on_auth_user_created_provision_org`
trigger made her an organization named `celeste.m` and her its owner,
`organizations_start_trial` put a 14-day clock on it, and on **27 October the
trial ended and her app went read-only**. She reported it on 4 November as
"a lot of the functions are not active", which points nowhere near the cause.

She was never on the Market Maker Management team. Six people were merged into
it by hand on 5 October; she arrived afterwards and nobody ran it again. No
invite was ever sent to her address.

Two separate faults, stacked:

1. **Signup ignored the invite table.** `org_invites`,
   `my_pending_invites()` and `accept_org_invite()` all work — but only for
   somebody who already has a personal organization and then finds the
   button. Until they do, they are a separate company on a trial clock.
2. **The team runs on an unbilled organization.** Market Maker Management has
   no `org_subscriptions` row, and no row means `'none' / 'full'` — unlimited.
   That is why nobody else ever hit the trial wall, and it is worth deciding
   about before Stripe ever writes a row for that org, because the moment one
   appears all members inherit whatever it says.

## The fix

`supabase/migrations/20261104190000_signup_honours_invites.sql` — **not yet
applied**. It changes no existing row. It changes what happens to the *next*
person who signs up, and what `accept_org_invite` moves when next called.

- **An outstanding invite to that address now wins at signup.** No personal
  organization is created, so no trial clock starts. Somebody with no invite
  still gets their own organization and trial, which is the product working
  as intended.
- **Matching on email domain was considered and rejected.** It would mean
  anybody who can obtain an address at a company's domain joins its CRM
  uninvited — a security decision disguised as a convenience.
- **`accept_org_invite` moved 8 tables and there are 15.** It was stranding
  `conversation_notes`, `client_facts`, `client_message_texts`,
  `clients_archive`, `scheduled_messages` and the token archive — precisely
  the tables added after that list was written. The list is now read from the
  schema, so a table added later cannot be forgotten the same way. Inbound
  texts move by `client_id`, since `sms_events` has no `user_id`.
- **Two tables deliberately never move:** `org_subscriptions`, because billing
  belongs to the organization and moving a trial row into an established team
  puts everyone in it read-only at once; and `org_phone_numbers`, because a
  sending number is registered with the carrier against one organization.

### Applying it

`supabase db push` **does not work on this repo** — see
`docs/desk-assistant.md`. Paste the file into the Supabase SQL editor.

## Adding somebody now

**Invite them before they sign up.** Use the invite control in the app, which
writes `org_invites`. Once the migration above is applied, their first sign-in
puts them straight onto the team with no personal organization and no trial.

If they have already signed up (as Celeste had), they need the merge instead:
move their membership and every table carrying their `org_id` + `user_id`,
back it up to `org_merge_backup` first, and **leave their subscription row
behind**.

## Still open

- **8 empty organizations** from earlier signups: `colin`, `tanner.b`,
  `chase`, `ethan`, `zachary.l`, `delutrijohnny`, `ethan.m`, `ronin`. Zero
  members, zero data. Harmless, and the residue of the same behaviour.
- **5 of 9 members have no `sender_name`**, so their messages would render
  `{your name} here`: Chase, Colin, Ethan M, Tanner B, Zachary L. Celeste's
  was set to `Celeste` on 4 November, matching the first-name convention.
- **Nobody can send a text except Johnny.** `org_phone_numbers` is empty for
  every organization, so there is no provider route, and only Johnny has a
  Mac agent registered. Everybody else gets `smsSendMode → 'handoff'` and has
  to send by hand.
