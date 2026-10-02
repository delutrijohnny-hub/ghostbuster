-- ============================================================
-- The last two bits of database work, in one paste.
--
--   1. one provider event is processed once (webhook idempotency)
--   2. sign the pre-call email, and proofread the library
--
-- Safe to run twice. Pure ASCII. Nothing here deletes anything.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Webhook idempotency.
-- ------------------------------------------------------------
-- One provider event, processed once.
--
-- The webhook's reply path marks "the most recent unanswered email to this
-- contact" as replied. Providers retry on a timeout or a 5xx, and on a retry
-- the most recent unanswered email is a DIFFERENT, older message -- so a
-- second message gets credited with a reply that never happened. That
-- inflates the reply rate and teaches the bandit that the wrong copy worked.
--
-- (provider_id, kind) is the natural key: the same email id with the same
-- event type is the same event, and a retry carries both unchanged. Two
-- genuine replies from one person arrive as different email ids; a
-- delivered-then-bounced pair differs by kind. Neither collapses.
--
-- The function also checks before inserting. That check is what makes it
-- correct today; this index is what closes the race when two retries land in
-- the same instant, and it turns the loser into a clean 409 rather than a
-- duplicate row.
--
-- Rows with a null provider_id are not constrained: Postgres treats nulls as
-- distinct, and an event with no id cannot be deduplicated anyway.
create unique index if not exists email_events_provider_kind_uniq
  on public.email_events (provider_id, kind)
  where provider_id is not null;


-- ------------------------------------------------------------
-- 2. Email sign-off and proofread.
-- ------------------------------------------------------------
do $do$
declare n int;
begin
  -- The pre-call email signs off with the full name.
  update public.email_library
  set body = regexp_replace(body, 'Talk soon,' || chr(10) || '\{sender\}$',
                            'Talk soon,' || chr(10) || 'Johnny the YouTube Guy'),
      updated_at = now()
  where title like 'Before the call%' and body like '%Talk soon,%{sender}';
  get diagnostics n = row_count;
  raise notice 'signed % pre-call email(s) as Johnny the YouTube Guy', n;
end $do$;

do $do$
declare n int := 0; m int;
begin
  -- Small corrections across every email. Each is a no-op where the text is
  -- already right, so this is safe whatever state the library is in.

  -- British spelling crept in from my drafting.
  update public.email_library
  set body = replace(replace(body, 'optimisation', 'optimization'), 'specialise', 'specialize'),
      updated_at = now()
  where body like '%optimisation%' or body like '%specialise%';
  get diagnostics m = row_count; n := n + m;

  update public.email_library
  set body = replace(body, 'colours', 'colors'), updated_at = now()
  where body like '%colours%';
  get diagnostics m = row_count; n := n + m;

  -- Double spaces and space-before-punctuation, from edits over the day.
  update public.email_library
  set body = regexp_replace(regexp_replace(body, '[ ]{2,}', ' ', 'g'), ' ([.,!?;:])', '\1', 'g'),
      subject = regexp_replace(regexp_replace(subject, '[ ]{2,}', ' ', 'g'), ' ([.,!?;:])', '\1', 'g'),
      updated_at = now()
  where body ~ '[ ]{2,}' or body ~ ' [.,!?;:]' or subject ~ '[ ]{2,}' or subject ~ ' [.,!?;:]';
  get diagnostics m = row_count; n := n + m;

  -- Trailing whitespace at the end of lines.
  update public.email_library
  set body = regexp_replace(body, '[ \t]+$', '', 'gn'), updated_at = now()
  where body ~ '[ \t]+$';
  get diagnostics m = row_count; n := n + m;

  raise notice 'tidied % row-update(s) across the library', n;
end $do$;

-- Anything left that would look wrong in an inbox.
select title,
       case when body like '%  %' then 'double space'
            when body ~ ' [.,!?;:]' then 'space before punctuation'
            when body like '%optimisation%' or body like '%colours%' then 'british spelling'
            else 'clean' end as proofread,
       case when body like '%[%]%' then 'NEEDS: ' || substring(body from '\[[^\]]+\]')
            else '' end as placeholder
from public.email_library
order by sort_order;
