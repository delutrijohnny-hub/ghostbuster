-- ============================================================
-- Repair the mangled dashes in the email library.
--
-- The emails loaded fine, but every em-dash arrived as three
-- wrong characters: the file was UTF-8 and something between the
-- clipboard and the SQL editor read those bytes as MacRoman.
-- So "Before the call - what we do" became "Before the call ...".
--
-- This script is deliberately PURE ASCII. Naming the bad
-- characters literally would mean sending them through the same
-- clipboard that mangled them in the first place, so they are
-- built with chr() from their code points instead:
--   chr(8218) chr(196) chr(238)  =  a mis-read em-dash
--
-- Safe to run twice: once the bad sequence is gone there is
-- nothing left to match.
-- ============================================================

do $do$
declare
  bad  text := chr(8218) || chr(196) || chr(238);   -- em-dash, mis-decoded
  good text := chr(45);                             -- a plain hyphen
  n    int;
begin
  update public.email_library
  set title        = replace(title, bad, good),
      subject      = replace(subject, bad, good),
      body         = replace(body, bad, good),
      when_to_send = replace(when_to_send, bad, good),
      updated_at   = now()
  where title like '%' || bad || '%'
     or subject like '%' || bad || '%'
     or body like '%' || bad || '%'
     or when_to_send like '%' || bad || '%';

  get diagnostics n = row_count;
  raise notice 'repaired % email(s)', n;
end $do$;

-- Should come back with 0 in every column.
select
  count(*) filter (where title like '%' || chr(8218) || chr(196) || chr(238) || '%')   as bad_titles,
  count(*) filter (where subject like '%' || chr(8218) || chr(196) || chr(238) || '%') as bad_subjects,
  count(*) filter (where body like '%' || chr(8218) || chr(196) || chr(238) || '%')    as bad_bodies,
  count(*)                                                                             as total_emails
from public.email_library;
