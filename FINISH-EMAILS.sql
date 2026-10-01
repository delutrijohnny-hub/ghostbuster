-- ============================================================
-- GhostBuster email library: everything outstanding, one paste.
--
-- Combines the three scripts into one so there is nothing to keep
-- track of. Every step checks before it acts, so this is safe to
-- run twice, and safe whether or not any earlier script was run.
--
--   1. repair em-dashes mangled in transit through the clipboard
--   2. pre-call email uses {when} (reads right with or without a
--      time booked)
--   3. add the "no time booked yet" intro email
--   4. drop the Google scheduling link everywhere one was needed
--   5. rebuild the post-call recap around {recap}, the contact's
--      own call notes
--   6. scheduling link into the re-engagement emails
--   7. both onboarding questionnaires into the payment email
--
-- PURE ASCII on purpose: mangled characters are rebuilt with chr()
-- rather than written out, because writing them would send them
-- back through the clipboard that mangled them.
-- ============================================================

do $do$
declare
  bad text := chr(8218) || chr(196) || chr(238);
  n   int;
begin
  update public.email_library
  set title        = replace(title, bad, chr(45)),
      subject      = replace(subject, bad, chr(45)),
      body         = replace(body, bad, chr(45)),
      when_to_send = replace(when_to_send, bad, chr(45)),
      updated_at   = now()
  where title like '%' || bad || '%' or subject like '%' || bad || '%'
     or body like '%' || bad || '%'  or when_to_send like '%' || bad || '%';
  get diagnostics n = row_count;
  raise notice 'step 1: repaired % email(s)', n;
end $do$;

-- 2. The pre-call email adapts to whether a time is booked.
do $do$
declare n int;
begin
  update public.email_library
  set body = $pre$Hey {name},

Thanks again for taking the time to connect. Looking forward to our call {when}.

Quick version of what we do. We help realtors and brands use YouTube for lead generation, not views. Long-form builds the authority and does the converting, short-form expands reach and funnels people back to the page. On our end that covers branding, thumbnails, editing, and the short-form cuts, and we will get into what that looks like for you on the call.

One thing worth saying up front. Views and business are two different things. One of our agents averages a few hundred views a video and the channel is one of the best performing ones we run. That will make more sense once I can show you.

I've attached links to a variety of our clients' YouTube channels. You'll see a mix of different people here, some realtors, some not. For certain clients we mainly focus on long-form content, while for others we primarily post on short-form. Some are just getting started with under 500 subscribers, while others have grown past 200,000. This should give you a sense of the range of work we do and how we tailor our approach to each client.

https://www.youtube.com/@LivinginJohnsonCityTennessee/videos
https://youtube.com/@lowcountrylifestyles
https://youtube.com/@livinginsouthernmo
https://youtube.com/@living-in-raleigh-nc
https://youtube.com/@tulsatom
https://www.youtube.com/@TheManginTeam
https://www.youtube.com/@LivinginIndiana/videos
https://www.youtube.com/@StefTheAlterNerd
https://www.youtube.com/@carquestionsanswered
https://www.youtube.com/@RobertBorelliStories
https://www.youtube.com/@Tatlondonolive/shorts

Talk soon,
{sender}$pre$,
      updated_at = now()
  where title like 'Before the call%' and body not like '%{when}%';
  get diagnostics n = row_count;
  raise notice 'step 2: updated % pre-call email(s)', n;
end $do$;

-- 3. The intro for when nothing is on the calendar at all.
do $do$
declare
  target_user uuid; target_org uuid; n int;
begin
  select id into target_user from auth.users where email = 'delutrijohnny@gmail.com';
  if target_user is null then raise exception 'no auth user for delutrijohnny@gmail.com'; end if;
  select org_id into target_org from public.memberships where user_id = target_user limit 1;

  insert into public.email_library (user_id, org_id, title, when_to_send, subject, body, sort_order)
  select target_user, target_org,
         'Intro - no time booked yet',
         'after you speak but before anything is on the calendar',
         'Great connecting - let us find a time',
         $nod$Hey {name},

Thanks again for taking the time to connect. I'd love to get a time on the calendar so I can walk you through what this would look like for your channel specifically.

Quick version of what we do. We help realtors and brands use YouTube for lead generation, not views. Long-form builds the authority and does the converting, short-form expands reach and funnels people back to the page. On our end that covers branding, thumbnails, editing, and the short-form cuts.

One thing worth saying up front. Views and business are two different things. One of our agents averages a few hundred views a video and the channel is one of the best performing ones we run. That will make more sense once I can show you.

I've attached links to a variety of our clients' YouTube channels. You'll see a mix of different people here, some realtors, some not. For certain clients we mainly focus on long-form content, while for others we primarily post on short-form. Some are just getting started with under 500 subscribers, while others have grown past 200,000. This should give you a sense of the range of work we do and how we tailor our approach to each client.

https://www.youtube.com/@LivinginJohnsonCityTennessee/videos
https://youtube.com/@lowcountrylifestyles
https://youtube.com/@livinginsouthernmo
https://youtube.com/@living-in-raleigh-nc
https://youtube.com/@tulsatom
https://www.youtube.com/@TheManginTeam
https://www.youtube.com/@LivinginIndiana/videos
https://www.youtube.com/@StefTheAlterNerd
https://www.youtube.com/@carquestionsanswered
https://www.youtube.com/@RobertBorelliStories
https://www.youtube.com/@Tatlondonolive/shorts

Grab whichever time suits you here and I'll come prepared:

https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ15gdR6L_RxtIS4-qdyoUyPNWg1_4j6D0dgoTLpqCLVgRdqhp8m17qFovK4dovqTfsvmZUmxIdM

Best,
{sender}$nod$,
         5
  where not exists (select 1 from public.email_library e
                    where e.user_id = target_user and e.title = 'Intro - no time booked yet');
  get diagnostics n = row_count;
  raise notice 'step 3: added % intro email(s)', n;
end $do$;

-- 4. The real scheduling link, everywhere one was waiting.
do $do$
declare
  cal text := 'https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ15gdR6L_RxtIS4-qdyoUyPNWg1_4j6D0dgoTLpqCLVgRdqhp8m17qFovK4dovqTfsvmZUmxIdM';
  n   int;
begin
  update public.email_library
  set body = replace(replace(body, '[CALENDAR LINK]', cal), '[BOOKING LINK]', cal),
      updated_at = now()
  where body like '%[CALENDAR LINK]%' or body like '%[BOOKING LINK]%';
  get diagnostics n = row_count;
  raise notice 'step 4: put the scheduling link into % email(s)', n;

  -- The onboarding email asks them to pick an onboarding time but had no link.
  update public.email_library
  set body = replace(body,
        'please pick the time that works best for our initial onboarding call.',
        'please pick the time that works best for our initial onboarding call:' ||
        chr(10) || chr(10) || cal),
      updated_at = now()
  where title like 'Onboarding%'
    and body like '%initial onboarding call.%'
    and body not like '%' || cal || '%';
  get diagnostics n = row_count;
  raise notice 'step 4: added the link to % onboarding email(s)', n;
end $do$;

-- What is left needing a human. Should be two: the package link (you are
-- grabbing a fresh one) and the questionnaire (the document had two Airtable
-- links and nothing said which).

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

do $do$
declare n int;
begin
  update public.email_library
  set body = replace(body,
        '[CLIENT ONBOARDING QUESTIONNAIRE LINK]',
        $q$There are two short forms to fill in -- they capture a few more details about your audience and brand voice, and let our team start preparing before your onboarding call:

Onboarding form 1:
https://airtable.com/appS49YcdAlU5c1mX/pagEp1WtEPQMxxJ5b/form

Onboarding form 2:
https://airtable.com/appQzCkh6j1r5SUhl/pag3ko8boVDx0zx8V/form$q$),
      updated_at = now()
  where body like '%[CLIENT ONBOARDING QUESTIONNAIRE LINK]%';
  get diagnostics n = row_count;
  raise notice 'added both questionnaires to % email(s)', n;
end $do$;

-- Only the package link should be left. Anything else listed here is
-- something I have not filled in and you should know about.

-- ============================================================
-- Where everything stands. Only the package link should be left.
-- ============================================================
select title,
       case when body like '%[%]%' then 'NEEDS: ' || substring(body from '\[[^\]]+\]')
            when body like '%{recap}%' then 'uses your call notes'
            else 'ready to send' end as status,
       case when body like '%calendar.google.com%' then 'booking link' else '' end as extras
from public.email_library
order by sort_order;
