-- Per-contact wording for a cadence touch.
--
-- The five touches are shared templates, which is what makes the A/B
-- learning possible: every contact at touch 3 gets one of a small number of
-- known variants, so a reply rate means something. That is right for the
-- book as a whole and wrong for the contact you actually know something
-- about. "Hey Teresa, following up" is the correct thing to send to 780
-- people and the weakest thing to send to the one who told you her CFO
-- signs off on Fridays.
--
-- So an override here REPLACES the template for one contact at one touch,
-- and changes nothing else. computeDue still decides when each touch fires,
-- the sequence still stops on a reply or an opt-out, and a contact with no
-- row here keeps using the shared template exactly as before.
--
-- This already half-existed and silently did not work. editedTextCache in
-- logic.js held exactly this -- keyed 'clientId|stage' -- but it was a plain
-- in-memory object that nothing ever persisted. Every hand-tailored touch
-- and every AI draft was discarded on the next reload, and getCardText fell
-- back to the template without saying so. This table is that cache made real.
--
-- A SEPARATE TABLE rather than a column on clients, deliberately. The
-- browser's rowClient writes the whole contact row on save, and it already
-- clobbers one webhook-written column that way. Copy somebody spent time on
-- must not be exposed to that race.
create table if not exists public.client_message_texts (
  client_id  text not null,
  stage      text not null,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  text       text not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, stage),
  -- Cadence touches only. 'custom' and 'email' are deliberately absent:
  -- a custom send is a one-off that is already recorded in message_log, and
  -- an override for it would be a template for something that by definition
  -- has none.
  constraint client_message_texts_stage_check check (stage in
    ('welcome','monday','midcheckin','dayof','hourbefore','recovery',
     'noshow','revival','rebooked','followup'))
);

create index if not exists client_message_texts_org_idx
  on public.client_message_texts (org_id);

alter table public.client_message_texts enable row level security;

-- Org-scoped throughout. Within one organisation these are colleagues
-- working the same book -- a manager fixing a rep's wording is a normal
-- thing -- so the boundary that matters is the tenant, not the author.
drop policy if exists client_message_texts_select on public.client_message_texts;
create policy client_message_texts_select on public.client_message_texts
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

drop policy if exists client_message_texts_insert on public.client_message_texts;
create policy client_message_texts_insert on public.client_message_texts
  for insert to authenticated
  with check (org_id in (select public.user_org_ids()));

drop policy if exists client_message_texts_update on public.client_message_texts;
create policy client_message_texts_update on public.client_message_texts
  for update to authenticated
  using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

drop policy if exists client_message_texts_delete on public.client_message_texts;
create policy client_message_texts_delete on public.client_message_texts
  for delete to authenticated
  using (org_id in (select public.user_org_ids()));

comment on table public.client_message_texts is
  'Per-contact wording for one cadence touch. Replaces the shared template for that contact only; the cadence, the stop-on-reply rule and every other contact are unaffected. A send that does not match its template is already logged as variant ''custom'', so an override never moves a template''s A/B numbers.';
