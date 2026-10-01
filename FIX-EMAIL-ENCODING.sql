-- ============================================================
-- Email library: repair the dashes, and handle "no time booked yet".
--
-- Three things, all safe to run twice:
--   1. repairs em-dashes that arrived mangled through the clipboard
--   2. makes the pre-call email work whether or not a time is set
--   3. adds an intro email for when nothing is booked yet
--
-- PURE ASCII on purpose. The mangled characters are rebuilt with
-- chr() from their code points rather than written literally,
-- because writing them would mean sending them back through the
-- same clipboard that mangled them in the first place.
-- ============================================================

-- 1. Repair the mis-decoded em-dashes.
do $do$
declare
  bad  text := chr(8218) || chr(196) || chr(238);
  good text := chr(45);
  n    int;
begin
  update public.email_library
  set title        = replace(title, bad, good),
      subject      = replace(subject, bad, good),
      body         = replace(body, bad, good),
      when_to_send = replace(when_to_send, bad, good),
      updated_at   = now()
  where title like '%' || bad || '%' or subject like '%' || bad || '%'
     or body like '%' || bad || '%'  or when_to_send like '%' || bad || '%';
  get diagnostics n = row_count;
  raise notice 'repaired % email(s)', n;
end $do$;

-- 2. The pre-call email now uses {when}, which reads "on Tuesday" inside the
--    coming week, "on Oct 31" beyond it, and "soon" when nothing is booked --
--    so the same email works either way.
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
      when_to_send = 'after they book, a day or two before the call',
      updated_at = now()
  where title like 'Before the call%';
  get diagnostics n = row_count;
  raise notice 'updated % pre-call email(s) to use {when}', n;
end $do$;

-- 3. A separate intro for when there is no time on the calendar at all.
--    Different job from the pre-call email: this one exists to get something
--    booked, so it ends with the booking link rather than "see you then".
do $do$
declare
  target_user uuid;
  target_org  uuid;
  n           int;
begin
  select id into target_user from auth.users where email = 'delutrijohnny@gmail.com';
  if target_user is null then
    raise exception 'No auth user found for delutrijohnny@gmail.com';
  end if;
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

[BOOKING LINK]

Best,
{sender}$nod$,
         5
  where not exists (
    select 1 from public.email_library e
    where e.user_id = target_user and e.title = 'Intro - no time booked yet'
  );
  get diagnostics n = row_count;
  raise notice 'added % intro email(s)', n;
end $do$;

-- Should show 10 emails, no mangled characters anywhere.
select
  (select count(*) from public.email_library)                                            as total_emails,
  (select count(*) from public.email_library
     where title like '%' || chr(8218) || chr(196) || chr(238) || '%'
        or body  like '%' || chr(8218) || chr(196) || chr(238) || '%')                   as still_mangled,
  (select count(*) from public.email_library where body like '%{when}%')                 as emails_using_when;

select title, when_to_send from public.email_library order by sort_order;
