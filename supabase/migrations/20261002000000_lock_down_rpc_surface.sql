-- Close the RPC endpoints nothing is supposed to call.
--
-- Supabase exposes every function in `public` at /rest/v1/rpc/<name>, so these
-- were callable by anyone on the internet. Found by the database linter, which
-- only became visible once the Supabase connector was attached -- before that
-- nobody was looking.
--
-- A first attempt revoked from `anon` and reported success while changing
-- nothing: Postgres grants EXECUTE on every new function to PUBLIC, and anon
-- and authenticated inherit from it, so revoking from a role that holds the
-- privilege only through PUBLIC is a no-op. The grant has to come off PUBLIC
-- and then go back to the roles that need it. Recorded because a migration
-- that succeeds is not the same as a migration that did something.

-- increment_builtin_stat moves the SHARED pooled-learning numbers. The app
-- calls it as a signed-in user; an unauthenticated stranger adjusting
-- everyone's variant stats has no legitimate use.
revoke execute on function public.increment_builtin_stat(text, text, text, integer) from public;
grant  execute on function public.increment_builtin_stat(text, text, text, integer) to authenticated, service_role;

-- Trigger functions, never called directly -- confirmed against the client,
-- which only ever calls increment_builtin_stat. Postgres checks EXECUTE on a
-- trigger function when the trigger is CREATED, not when it fires, so this
-- does not stop org provisioning or org stamping. Verified against production
-- by inserting a row and confirming org_id was still stamped.
revoke execute on function public.provision_org_for_new_user() from public;
grant  execute on function public.provision_org_for_new_user() to service_role;
revoke execute on function public.set_org_id_from_user() from public;
grant  execute on function public.set_org_id_from_user() to service_role;

-- public.user_org_ids() is deliberately LEFT ALONE despite the linter
-- flagging it, and will keep being flagged.
--
-- Every RLS policy calls it -- `org_id in (select public.user_org_ids())` --
-- and policies evaluate as the querying user. Revoking EXECUTE from
-- `authenticated` would make every table unreadable and take the whole app
-- down for every account. The linter cannot see that it is load-bearing.
