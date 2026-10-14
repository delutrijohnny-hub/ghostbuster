-- One texting number per salesperson, not one per company.
--
-- The first version of this table keyed a number to an organisation, and
-- send-sms picked that org's first registered row. Every rep would then text
-- from the same line, and a client who has been dealing with Ethan for a
-- month would get a reminder from a number that is not his -- which is the
-- opposite of the point. The whole reason to own the number is that the
-- client recognises the sender.
--
-- user_id is nullable on purpose. A row with a user is that person's own
-- number. A row without one is an org-wide fallback, which is what a small
-- team with a single shared line actually wants, and what an account uses
-- before every rep has been provisioned.
alter table public.org_phone_numbers
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create unique index if not exists org_phone_numbers_one_per_user
  on public.org_phone_numbers (user_id) where user_id is not null;

create unique index if not exists org_phone_numbers_one_org_fallback
  on public.org_phone_numbers (org_id) where user_id is null;

create index if not exists org_phone_numbers_user_idx
  on public.org_phone_numbers (user_id, status);

comment on column public.org_phone_numbers.user_id is
  'The salesperson this number belongs to. Null means an org-wide fallback used when a rep has no number of their own. send-sms prefers the caller''s own number so clients always see the same sender for the same rep.';
