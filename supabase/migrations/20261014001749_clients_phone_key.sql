-- The indexed form of logic.js's phoneKey(), so the SMS webhook can find the
-- contact who texted without scanning the book.
--
-- It must agree with phoneKey() EXACTLY or inbound replies match in the
-- browser and not in the webhook, or the reverse. phoneKey is
-- normalizedPhone() -- strip every non-digit -- then the last ten digits if
-- there are more than ten. right(s,10) on a shorter string returns the whole
-- string, which is the same rule.
--
-- The first attempt at this lookup had no column and filtered with
-- `phone like '*5550100*'` on the raw text. 520 of 899 stored numbers are
-- formatted -- "(213) 555-0100" -- so the digits never appear contiguously
-- and the filter matched 383 of 899. It would have dropped 57% of replies
-- while looking like it worked.
alter table public.clients
  add column if not exists phone_key text
  generated always as (right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10)) stored;

-- Partial: only a full ten digits is a usable key. A shorter one is the tail
-- of every number ending the same way, and phoneKey refuses it for that
-- reason, so there is nothing to look up.
create index if not exists clients_phone_key_org_idx
  on public.clients (org_id, phone_key)
  where length(phone_key) = 10;

comment on column public.clients.phone_key is
  'Last 10 digits of phone, generated. Mirrors phoneKey() in logic.js; the SMS webhook matches an inbound text on (org_id, phone_key). Do not change without changing phoneKey().';
