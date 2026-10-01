-- ============================================================
-- Both onboarding questionnaires into the payment-received email.
--
-- The source document listed two Airtable links with no labels, so
-- the first pass left a placeholder rather than guessing which one
-- a paying customer should get. The answer is both.
--
-- The package payment link is deliberately still a placeholder:
-- those links encode the price, so the right one depends on what
-- was sold and can only be chosen at the time.
--
-- Safe to run twice.
-- ============================================================

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
select title,
       case when body like '%[%]%' then 'needs: ' || substring(body from '\[[^\]]+\]')
            else 'ready to send' end as status
from public.email_library
order by sort_order;
