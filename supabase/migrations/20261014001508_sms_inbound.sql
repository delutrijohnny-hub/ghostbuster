-- Two-way SMS: the number a text arrives on, and the texts that arrive.
--
-- Why this is the piece that matters. Reply logging has never worked on the
-- text channel, because a text is handed to the salesperson's own phone and
-- its reply lands there, invisible to GhostBuster, where someone has to
-- remember to record it. They do not: 67 sends since the review path was
-- fixed, zero reviewed, while 43 review questions sit unanswered on the
-- owner's own account. The question is visible and ignored. No amount of
-- further prompting fixes that -- the reply has to arrive somewhere the
-- system can see it, which means GhostBuster has to own the number.
--
-- ---------------------------------------------------------------------
-- The one thing that makes this dangerous: WHOSE contact replied?
-- ---------------------------------------------------------------------
-- An inbound text carries a from-number and nothing else. Matching it to a
-- contact by number alone crosses tenants, and not hypothetically: on the
-- live book 107 phone numbers belong to contacts in MORE THAN ONE
-- organization (the same person booked with two different teams). A match
-- that ignored the org would mark another company's contact as having
-- replied, and leak -- through the reply itself -- that they are also
-- somebody else's customer.
--
-- So the receiving number is the tenant key. Each org sends from its own
-- number, the webhook resolves To -> org_id here, and the contact lookup is
-- scoped to that org. An inbound text for a number in this table can only
-- ever touch that org's rows.
create table if not exists public.org_phone_numbers (
  -- E.164, digits only with the leading +, exactly as the carrier reports it
  -- in the To field. Primary key: one number serves one org, which is the
  -- property the scoping above depends on.
  phone_number  text primary key check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  provider      text not null default 'twilio',
  -- A2P 10DLC registration takes weeks and carriers filter unregistered
  -- traffic silently. Recording the state means "our texts stopped arriving"
  -- is answerable without logging into the carrier.
  status        text not null default 'pending'
                check (status in ('pending','registered','suspended','released')),
  label         text not null default '',
  created_at    timestamptz not null default now()
);

create index if not exists org_phone_numbers_org_idx
  on public.org_phone_numbers (org_id);

alter table public.org_phone_numbers enable row level security;

-- A team can see its own number -- it has to, to tell contacts who is
-- texting them. It cannot see another org's, which would hand over the
-- tenant key itself.
drop policy if exists org_phone_numbers_select on public.org_phone_numbers;
create policy org_phone_numbers_select on public.org_phone_numbers
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

-- Numbers are provisioned by us, never by the browser. A client that could
-- insert a row here could point any number at its own org and harvest every
-- reply sent to it.
revoke insert, update, delete on public.org_phone_numbers from anon, authenticated;

-- ---------------------------------------------------------------------
-- The raw inbound text, kept before anything is interpreted
-- ---------------------------------------------------------------------
-- Same reason email_events exists: matching a reply to the message it answers
-- involves judgement, and the judgement here is sharper than on email --
-- 424 of 830 live contacts share a phone number with another row. When an
-- attribution turns out wrong, the original payload has to still be here.
create table if not exists public.sms_events (
  id            bigserial primary key,
  provider_id   text,
  kind          text not null,
  from_phone    text,
  to_phone      text,
  body          text,
  -- Null when nothing could be matched; the reason says why, so a human can
  -- see an unattributed reply rather than it vanishing.
  org_id        uuid references public.organizations(id) on delete set null,
  client_id     text,
  message_id    text,
  match_reason  text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists sms_events_provider_idx on public.sms_events (provider_id);
create index if not exists sms_events_from_idx on public.sms_events (from_phone);
create index if not exists sms_events_org_idx on public.sms_events (org_id, created_at desc);

-- Providers retry on a timeout or a 5xx, and replaying an inbound reply is
-- not merely wasteful, it is wrong: the second run credits whatever is now
-- the most recent unanswered message, inflating the reply rate and teaching
-- the bandit that the wrong copy worked. (provider_id, kind) is the natural
-- key -- a retry carries both unchanged, two genuine replies arrive as
-- different message ids.
create unique index if not exists sms_events_provider_kind_key
  on public.sms_events (provider_id, kind) where provider_id is not null;

alter table public.sms_events enable row level security;

-- Readable by the org it was matched to, so an unattributed reply can be
-- placed by hand. An event that matched nothing has a null org_id and is
-- visible to nobody but service_role -- which is correct: an unmatched
-- number is not known to belong to anyone.
drop policy if exists sms_events_select on public.sms_events;
create policy sms_events_select on public.sms_events
  for select to authenticated
  using (org_id is not null and org_id in (select public.user_org_ids()));

revoke insert, update, delete on public.sms_events from anon, authenticated;

comment on table public.org_phone_numbers is
  'The SMS number each org sends and receives on. The receiving number is the tenant key for inbound matching: 107 phone numbers on the live book belong to contacts in more than one org, so a match that ignored this would cross tenants. Written only by service_role.';
comment on table public.sms_events is
  'Raw inbound SMS and delivery events, stored before interpretation. Unique on (provider_id, kind) so a provider retry cannot re-credit a reply.';
