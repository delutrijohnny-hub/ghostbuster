/* Credit a wording for a reply the Mac agent attributed.
 *
 * reviewMessage, in the browser, is the only thing that has ever moved these
 * counters, and it runs when somebody answers "did they reply?". Nobody has:
 * zero message.replied / message.no_reply events in 685, back to 2026-09-30.
 * imessage-sync had already answered that question 139 times by writing
 * responded/reviewed straight onto message_log, which no counter ever saw, so
 * pickVariant explored forever and learned nothing.
 *
 * ADDITIVE, which is why it is a function at all: the browser saves
 * variant_stats as a WHOLE ROW from its in-memory state, so a plain upsert
 * from the server would be overwritten by the next browser save, and
 * PostgREST cannot express `sends = sends + 1`.
 *
 * IT MIRRORS reconcileVariantStats, or it resurrects what the 2026-10-12
 * reset exists to discard. Every one of this account's 16 rows still holds
 * its pre-reset counters (450 sends / 94 responses) with text_hash NULL,
 * because the browser retires them in memory on each load and never persists
 * it -- SYNCED is snapshotted after the reconcile. A first version of this
 * function filled a missing hash with coalesce, which would have stamped
 * today's wording onto those rows, stopped reconcile retiring them, and made
 * pooled numbers from 2 to 23 different messages read as evidence for current
 * copy. So:
 *     hash matches -> add to the live counters
 *     hash differs -> retire the live counters into prior_*, then start this
 *                     wording's count at the credit
 * with NULL counting as "differs", which is what retires the pre-reset rows
 * the first time a reply credits them.
 *
 * p_text_hash is therefore REQUIRED: without it the two cases cannot be told
 * apart, and either guess loses something. The caller skips rather than
 * guesses.
 *
 * SECURITY INVOKER, deliberately -- only the service role calls it and the
 * service role can already write this table, so DEFINER would add privilege
 * for nothing. EXECUTE is revoked from PUBLIC as well as from anon and
 * authenticated: Postgres grants it to PUBLIC on creation, so revoking the
 * two roles alone leaves /rest/v1/rpc/credit_variant_reply reachable.
 *
 * org_id is left to the variant_stats_set_org trigger, so one place decides
 * it.
 *
 * Applied to production 2026-11-02; recorded here so the next environment
 * gets it too.
 */
create or replace function public.credit_variant_reply(
  p_user        uuid,
  p_stage       text,
  p_variant_key text,
  p_sends       integer,
  p_responses   integer,
  p_text_hash   text default null
) returns void
language plpgsql
set search_path to 'public'
as $$
begin
  if p_sends not between 0 and 1 or p_responses not between 0 and 1 then
    raise exception 'credit_variant_reply: sends/responses must be 0 or 1, got %/%',
      p_sends, p_responses;
  end if;
  if p_user is null or p_stage is null or p_variant_key is null then
    raise exception 'credit_variant_reply: user, stage and variant_key are required';
  end if;
  if p_text_hash is null or p_text_hash = '' then
    raise exception 'credit_variant_reply: a wording hash is required, see the header';
  end if;
  if p_variant_key = 'custom' or p_stage = 'email' then return; end if;
  if p_sends = 0 and p_responses = 0 then return; end if;

  insert into public.variant_stats
         (user_id, stage, variant_key, sends, responses, text_hash)
  values (p_user, p_stage, p_variant_key, p_sends, p_responses, p_text_hash)
  on conflict (user_id, stage, variant_key) do update
     set prior_sends = case
           when public.variant_stats.text_hash is distinct from p_text_hash
           then coalesce(public.variant_stats.prior_sends, 0) + coalesce(public.variant_stats.sends, 0)
           else coalesce(public.variant_stats.prior_sends, 0) end,
         prior_responses = case
           when public.variant_stats.text_hash is distinct from p_text_hash
           then coalesce(public.variant_stats.prior_responses, 0) + coalesce(public.variant_stats.responses, 0)
           else coalesce(public.variant_stats.prior_responses, 0) end,
         sends = case
           when public.variant_stats.text_hash is distinct from p_text_hash
           then p_sends else coalesce(public.variant_stats.sends, 0) + p_sends end,
         responses = case
           when public.variant_stats.text_hash is distinct from p_text_hash
           then p_responses else coalesce(public.variant_stats.responses, 0) + p_responses end,
         text_hash = p_text_hash;
end $$;

revoke all on function public.credit_variant_reply(uuid, text, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.credit_variant_reply(uuid, text, text, integer, integer, text)
  to service_role;
