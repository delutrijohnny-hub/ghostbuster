# Giving a manager sight of the team, safely

Three migrations, in this order, with a pause between each. The order is the
whole safety property: **every policy change lands while it is still a no-op,
and only then does any data move.** Reverse it and there is a window where the
team can read each other's books.

## Where things stand today

Every account is alone in its own one-person organisation, and every data table
carries the same policy, granted for ALL commands:

```sql
org_id in (select user_org_ids())
```

`user_org_ids()` returns the orgs the caller belongs to and **ignores role
entirely**. `message_log` is the one exception in shape — it has no `org_id` of
its own and reaches through `clients`.

That is why "put the team in one org" is not a one-line change. Do only that,
and because the policy is `for all` and role-blind, every member gets read
*and write* on every other member's contacts. Ethan could edit Johnny's book.

## Migration 1 — teach the database what a manager is

Adds a second function alongside the existing one. Changes no policy, moves no
data.

```sql
create or replace function public.user_managed_org_ids()
returns setof uuid
language sql stable security definer
set search_path = public
as $$ select org_id from public.memberships
      where user_id = auth.uid() and role in ('owner','admin') $$;

revoke all on function public.user_managed_org_ids() from public;
grant execute on function public.user_managed_org_ids() to authenticated;
```

Verify: for every current account it returns exactly their own org, because
everyone is `owner` of their own one-person org.

## Migration 2 — make the policies role-aware

Still a no-op on today's data, which is what makes it safe to land first. Each
person is the only member of their org, so `user_id = auth.uid()` already
matches every row they can currently see.

For each of `clients`, `app_settings`, `variants`, `variant_stats`, `todos`,
`email_library` — and `events`, which needs splitting because it separates
SELECT from INSERT:

```sql
using (
  org_id in (select public.user_org_ids())          -- unchanged outer boundary
  and (
    user_id = auth.uid()                            -- your own rows
    or org_id in (select public.user_managed_org_ids())   -- or you manage this org
  )
)
```

### `google_oauth_tokens` is excluded, on purpose

This was nearly a mistake. That table stores `refresh_token`, which is a live
credential: anyone who can read it can act as that person against their Google
Calendar indefinitely, and keep doing so after they leave. A manager who wants
to know whether somebody's calendar is syncing has no business holding the key
to it.

So it goes the other way — **tightened**, not loosened:

```sql
using (org_id in (select public.user_org_ids()) and user_id = auth.uid())
```

Today that changes nothing, because the only member of each org is the owner of
the credential. It matters the moment step 3 runs.

The team view still needs `last_sync` to report sync health, and it currently
reads that table directly in `loadTeamRows` — so under this policy it would
report every teammate as "no calendar connected", which is the silent failure
this whole plan is trying to avoid. That needs a narrow `security definer`
function returning only `user_id`, `calendar_id` and `last_sync` for managed
orgs, and `loadTeamRows` pointed at it instead. Do that in the same step, not
afterwards.

`message_log` mirrors the rule through its parent, since it has no `user_id`:

```sql
using (exists (
  select 1 from public.clients c
   where c.id = message_log.client_id
     and c.org_id in (select public.user_org_ids())
     and (c.user_id = auth.uid()
          or c.org_id in (select public.user_managed_org_ids()))
))
```

**Verify before going further.** This is the step that can quietly break
everyone, and the failure is silent — an app that loads with no contacts looks
identical to an account that has none. Signed in as an ordinary account, the
contact count must be unchanged. Run as each user, not as service role: service
role bypasses RLS entirely and will tell you everything is fine when it is not.

## Migration 3 — move the team into one organisation

Only now does data move, and only now does anything actually change.

1. Create one organisation, "Market Maker Management".
2. Move each staff member's membership into it, role `member`.
3. Johnny joins it as `admin`.
4. Re-stamp `org_id` on their rows to the new org.

Step 4 is the irreversible-feeling one, so snapshot `(id, org_id)` per table
into an archive first; the undo is a join back.

After this, a member still sees only their own rows — now because of the role
check rather than because they were alone in an org. Johnny sees everyone's.

## What this deliberately does not do

- **It does not make the manager read-only.** The policies are `for all`, so an
  `admin` can edit a member's records. Narrowing that means splitting every
  policy into SELECT and write variants, which doubles the surface. Worth doing
  the day a manager who is not the business owner exists; not before.
- **It does not touch the owner/platform view.** That reads across *other
  businesses* and is a different question with a different answer — account
  health only, never their contacts. See `renderOwnerTab` and the shape test in
  `test.js`.

## Rollback

Migrations 1 and 2 revert by restoring the previous policy text; nothing moved.
Migration 3 reverts from the `org_id` snapshot. Keep the snapshot until the
team view has been used for a week in anger.
