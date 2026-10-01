-- ============================================================
-- Restore any missing emails, then re-apply everything.
--
-- The library is showing 7 where it should show 10. Rather than
-- work out which three and why, this re-runs the whole thing:
-- the insert only adds titles that are not already present, and
-- every later step checks before it acts. So anything missing
-- comes back, anything present is left alone, and all the links
-- and rewrites land on whatever is there at the end.
--
-- Safe to run as many times as you like. Pure ASCII.
-- ============================================================

do $do$
declare
  target_user uuid;
  target_org  uuid;
  inserted    int := 0;
begin
  select id into target_user from auth.users where email = 'delutrijohnny@gmail.com';
  if target_user is null then
    raise exception 'No auth user found for delutrijohnny@gmail.com - check the address';
  end if;
  select org_id into target_org from public.memberships where user_id = target_user limit 1;

  insert into public.email_library (user_id, org_id, title, when_to_send, subject, body, sort_order)
  select target_user, target_org, v.title, v.when_to_send, v.subject, v.body, v.sort_order
  from (values
  ($body$Before the call - what we do$body$, $body$after they book, a day or two before the call$body$, $body$Excited to chat {date} - a few examples inside$body$, $body$Hey {name},

Thanks again for taking the time to connect. Looking forward to our call on {weekday}.

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

See you {weekday},
{sender}$body$, 0),
  ($body$Post-call recap$body$, $body$the same day as the call, while it is fresh$body$, $body$Great talking with you - here's what I think we can build$body$, $body$Hi {name},

Great connecting with you today and diving deeper into your channel goals. I know you've got a strong setup and vision already, but it's our team's job to make sure the editing, optimization, and consistency side doesn't hold you back. That way you can focus on creating while still getting the views, leads, and ROI you want from YouTube.

What we talked about:

Branding - a strong visual identity. Custom banner, consistent thumbnail style, clear fonts and colours that align with your personal brand.

Thumbnails - eye-catching, high-conversion thumbnails that tell a story and boost click-through rates.

Editing - clean, modern editing that emphasises your insights, removes filler, and adds visual elements like maps, stats and B-roll.

Short-form clips - new cuts, or your long-form videos cut into high-performing Shorts, Reels and TikToks to build reach and engagement.

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

Excited to chat more.

Best regards,
{sender}$body$, 10),
  ($body$Channel references$body$, $body$when they ask to see examples of our work$body$, $body$Links to our YouTube services and examples$body$, $body$Hi {name},

As discussed, here are links to a variety of our clients' YouTube channels.

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

If you have any questions, or want to see more or different types of channels we run, just let me know.

Best,
{sender}$body$, 20),
  ($body$Onboarding - payment and channel access$body$, $body$as soon as they say yes$body$, $body$Let's get started - onboarding details inside$body$, $body$Hi {name},

It was great to meet with you! I'm really excited to work together. Below are the next steps to move forward.

Here is the payment link for our services:

[PASTE THE RIGHT PACKAGE LINK HERE]

Once you've paid, we'll need to be added as a manager of the channel. Here's how: on your desktop, go to your YouTube channel and click your profile picture in the top right. In the dropdown, select "YouTube Studio". Look on the left for options like Content and Dashboard, then scroll to the bottom left and find the "Settings" tab. Click it and a pop-up will appear. Go to the "Permissions" tab, and from there you can add us as a manager. Enter this email - youtubemanager@marketmakermgmt.com - and click save.

If you run into any issues, let me know.

Let's make some great things happen!

As soon as these steps are done, please pick the time that works best for our initial onboarding call.

Best regards,
{sender}$body$, 30),
  ($body$Payment received - questionnaire$body$, $body$once their payment clears$body$, $body$Excited to begin our partnership$body$, $body$Hi {name},

I wanted to personally confirm that we've received your payment. We're thrilled to have you on board and eager to begin building a YouTube presence that reflects the strength of your brand.

While we've already had a great conversation about your goals, this questionnaire will help capture a few more details about your audience and brand voice. It also lets our team start preparing and laying the groundwork before your official onboarding call, so we can make the most of our time together and move quickly.

[CLIENT ONBOARDING QUESTIONNAIRE LINK]

Thank you again for your trust in us. We're excited to collaborate and can't wait to get started.

Warm regards,
{sender}$body$, 40),
  ($body$Missed the call - easy reschedule$body$, $body$when they no-show and you want to make it easy$body$, $body$Let's reschedule your appointment$body$, $body$Hi {name},

I noticed we missed each other for our scheduled appointment to review your YouTube channel. I completely understand how busy things can get, and I'd still love the chance to connect with you.

You can use this link to easily reschedule a time that works best for you:

[CALENDAR LINK]

Looking forward to speaking with you soon!

Best,
{sender}$body$, 50),
  ($body$Missed the call - the direct one$body$, $body$when they no-show and you want to be straight about it$body$, $body$Missed appointment - I take these seriously$body$, $body$Hey {name},

I wanted to follow up because we had an appointment scheduled earlier, and I didn't see you on the call. I completely understand that clients, family, or unexpected issues come up - that's part of life and business.

That said, when you book a call with me or my assistant, I personally block off that time to focus on your channel strategy. I don't overbook or double-stack calls because I take these meetings seriously, whether you decide to work with us or not. I value professionalism and respect for each other's time.

No worries if something came up. I won't send you any follow-ups or spam after this. I just wanted to reach out personally and keep things professional.

If you'd still like to connect and talk about your YouTube channel and growth strategy, you can reschedule here:

[CALENDAR LINK]

Appreciate your understanding,
{sender}$body$, 60),
  ($body$Gone quiet after a call$body$, $body$when someone stops replying after you have already spoken$body$, $body$What do real estate agents and avocados have in common?$body$, $body$Hi {name},

It was a pleasure speaking with you, and I'm looking forward to hopefully speaking again soon.

I'm going to be completely honest - this has nothing to do with real estate or avocados. I just figured if I'm lucky enough to earn 15 seconds of your attention, like I did with the call, I'd better use it to show I'm not like the 17 other sales emails you're getting today.

Honestly {name}, when I checked out your channel, I really liked your energy. I just think with a little help we could tighten things up and make everything hit harder. I'd start with the branding - locking in colours and fonts that show up everywhere, from the banner to the thumbnails - and then bring that same feel into the editing. I also noticed you're not using any short-form content yet. I love using it to get quick attention and then funnel people into your longer videos where you can really build connection and trust.

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

If you have any questions, or want to see more or different types of channels, let me know.

Best,
{sender}$body$, 70),
  ($body$Not a fit - but they know someone$body$, $body$when they are not a fit themselves but offered to pass it on$body$, $body$For anyone you think might benefit$body$, $body$Hi {name},

It was such a pleasure speaking with you earlier. I'm so glad you liked the idea of using YouTube, and I appreciate you thinking of others who might benefit from this kind of visibility.

For anyone you share this with: my team and I specialise in helping real estate professionals quickly build brand awareness and credibility through YouTube. With just an hour or two of filming per month, we can turn that raw footage into:

Long-form YouTube videos to boost search visibility

Short-form clips for Instagram, Facebook and other platforms

An automated posting schedule, so they're always top-of-mind without extra work

Our goal is to make it easy, consistent and hands-off - so they can focus on their business while we handle the marketing side. If anyone you know would like to see how this might work for them, I'd be happy to offer a quick call or send over examples of what we do.

Thank you again for your time, and for thinking of us.

Warm regards,
{sender}$body$, 80)
  ) as v(title, when_to_send, subject, body, sort_order)
  where not exists (
    select 1 from public.email_library e
    where e.user_id = target_user and e.title = v.title
  );

  get diagnostics inserted = row_count;
  raise notice 'added % email(s) to the library', inserted;
end $do$;

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
-- Should be 10 emails. Only Onboarding should say NEEDS.
-- ============================================================
select sort_order, title,
       case when body like '%[%]%' then 'NEEDS: ' || substring(body from '\[[^\]]+\]')
            when body like '%{recap}%' then 'uses your call notes'
            else 'ready to send' end as status
from public.email_library
order by sort_order, title;

select count(*) as total_emails, count(distinct title) as distinct_titles
from public.email_library;
