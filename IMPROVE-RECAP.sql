-- ============================================================
-- Rebuild the post-call recap around the actual call notes.
--
-- It was a generic list of what the service includes, which is not
-- a recap -- an email that says "here is what we discussed" and
-- then describes nothing in particular is worse than not sending
-- one at all.
--
-- {recap} pulls the Call recap field from the contact, so the email
-- carries what was really said. Until that field is filled it shows
-- "(paste your call notes here before sending)", which is visible
-- in the Gmail draft before you send.
--
-- Also drops the scheduling link in, so a follow-up conversation is
-- one click rather than a round of emails about timing.
--
-- Safe to run twice. Pure ASCII.
-- ============================================================

do $do$
declare n int;
begin
  update public.email_library
  set body = $r$Hi {name},

Great connecting today and getting into your channel goals properly.

Here is what we actually talked about:

{recap}

On our side, that means the editing, optimisation and consistency work does not hold you back, so you can focus on creating while still getting the views, leads and ROI you want from YouTube. Concretely that covers branding, thumbnails, editing, and cutting your long-form into short-form.

If anything above is wrong or I missed something, just reply and tell me -- better now than after we have started.

If it is easier to talk it through, grab whichever time suits you:

https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ15gdR6L_RxtIS4-qdyoUyPNWg1_4j6D0dgoTLpqCLVgRdqhp8m17qFovK4dovqTfsvmZUmxIdM

Best regards,
{sender}$r$,
      when_to_send = 'the same day as the call, once your notes are in',
      updated_at = now()
  where title like 'Post-call recap%';
  get diagnostics n = row_count;
  raise notice 'rebuilt % post-call recap email(s)', n;
  if n = 0 then
    raise notice 'no post-call recap email found -- was the loader run?';
  end if;
end $do$;

-- Put the scheduling link in the two re-engagement emails too, where the
-- whole point is to get back on the calendar.
do $do$
declare cal text := 'https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ15gdR6L_RxtIS4-qdyoUyPNWg1_4j6D0dgoTLpqCLVgRdqhp8m17qFovK4dovqTfsvmZUmxIdM'; n int;
begin
  update public.email_library
  set body = body || chr(10) || chr(10) || 'If you would rather just grab a time:' ||
             chr(10) || chr(10) || cal,
      updated_at = now()
  where (title like 'Gone quiet%' or title like 'Intro - no time%')
    and body not like '%' || cal || '%';
  get diagnostics n = row_count;
  raise notice 'added the scheduling link to % re-engagement email(s)', n;
end $do$;

select title,
       case when body like '%{recap}%' then 'uses your call notes'
            when body like '%[%]%' then 'needs: ' || substring(body from '\[[^\]]+\]')
            else 'ready to send' end as status,
       case when body like '%calendar.google.com%' then 'has booking link' else '' end as booking
from public.email_library
order by sort_order;
