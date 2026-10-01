-- ============================================================
-- Sign the pre-call email as "Johnny the YouTube Guy", and a
-- light proofread across the library.
--
-- {sender} renders the account's sender name, which is right for
-- most of these. This one email wants a specific sign-off, so it
-- is written in rather than templated -- a per-email sender field
-- would be a setting to maintain for one case.
--
-- Safe to run twice. Pure ASCII.
-- ============================================================

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
