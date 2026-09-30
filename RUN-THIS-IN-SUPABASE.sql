-- ============================================================
-- GhostBuster — run this once in the Supabase SQL editor.
-- All three pending migrations, in order. Safe to run as one
-- block, and safe to run twice.
-- ============================================================

-- Email as a library, not a cadence.
--
-- Email was built as the five touches wearing a different hat: a variant keyed
-- by stage, fired when that touch came due. That was wrong about how email is
-- actually used here. A text is a nudge — three seconds on a lock screen, one
-- of five, timed to a call. An email is a DOCUMENT: the pricing breakdown, the
-- case study, the onboarding walkthrough, the "here's everything we discussed"
-- recap. It holds ten times the information and it goes out when the
-- conversation calls for it, not when a clock says touch three is due.
--
-- Forcing those into five stage slots meant the long ones had nowhere to live
-- and the good ones could only be reached by whichever contact happened to be
-- at the matching stage.
--
-- So: a flat, ordered library of emails the business wrote, each labelled with
-- when to send it, each holding as much as it needs. Reachable for any contact
-- at any time, and exportable so the copy is not trapped in one web app.
--
-- Nothing is deleted. The existing stage-keyed rows in `variants` where
-- channel='email' stay exactly as they are; the app seeds the library from
-- them on first load so no email anyone wrote is lost, and the old rows remain
-- as a fallback until that seeding is confirmed everywhere.

create table if not exists public.email_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,

  -- What this email IS, in the salesperson's own words: "Pricing breakdown",
  -- "Post-call recap". This is what they scan when picking one.
  title text not null,

  -- When to send it, as free text rather than a stage key. The whole point of
  -- the change: "after they ask what it costs" is a real answer and is not one
  -- of five stages. Kept because an unlabelled template is a template sent at
  -- the wrong moment.
  when_to_send text,

  subject text,
  -- No length constraint, deliberately. This is the column that exists so an
  -- email can hold what a text cannot.
  body text,

  -- Hand-ordered. The library reads as the order the business sells in, which
  -- alphabetical would destroy.
  sort_order integer not null default 0,

  archived boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_library_user_idx on public.email_library (user_id);
create index if not exists email_library_org_idx on public.email_library (org_id);

-- Same org stamping and boundary as every other table.
drop trigger if exists email_library_set_org on public.email_library;
create trigger email_library_set_org before insert on public.email_library
  for each row execute function public.set_org_id_from_user();

alter table public.email_library enable row level security;

drop policy if exists "email_library_org_all" on public.email_library;
create policy "email_library_org_all" on public.email_library for all
  using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));


-- 'email' as a logged stage.
--
-- A library email is not a cadence touch. It has no trigger and no position in
-- the five, so there is no stage to advance — but it still has to be LOGGED,
-- for two reasons that both matter: the timeline should show what was actually
-- sent, and "has this person been contacted today" is what stops an automated
-- text landing on top of an email sent by hand ten minutes earlier.
--
-- So it logs against stage 'email'. Which the CHECK constraint rejected, and a
-- rejected insert fails the whole batched save — the same failure mode as
-- 'revival', where every save in the app died silently and the only symptom
-- the user saw was "changes are not being saved".
--
-- Third time this list has needed extending, which is the argument for making
-- it one shared enum rather than three literals in three tables. Left as three
-- for now because changing it is a separate migration with its own risk, and
-- doing both at once is how the risky half gets shipped unnoticed.
alter table public.variants drop constraint if exists variants_stage_check;
alter table public.variants add constraint variants_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'));

alter table public.variant_stats drop constraint if exists variant_stats_stage_check;
alter table public.variant_stats add constraint variant_stats_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'));

alter table public.message_log drop constraint if exists message_log_stage_check;
alter table public.message_log add constraint message_log_stage_check
  check (stage in ('welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival','rebooked','followup','email'));


-- Every new account gets a working calendar filter.
--
-- The filter migration backfilled the accounts that existed at the time and
-- gave the column no default. So every account created afterwards had
-- calendar_filter NULL, and NULL fell back — in parse.ts — to MarketMaker's
-- own event titles: import nothing unless the event is called "strategy
-- session".
--
-- Three people hit this one after another. niklaus, ronin and ethan each
-- connected a calendar, synced, got nothing, and reported it as a separate
-- mystery. Each was diagnosed from scratch. The app told them nothing was
-- wrong: "Synced: 0 new, 0 updated".
--
-- Two halves, same as the org-provisioning fix: make it impossible going
-- forward, and repair anyone already stranded.

-- 1) A default on the column, so a new row is correct without anyone
--    remembering to set it. parse.ts also defaults to this now, but relying
--    on a fallback is what caused this — the row should say what it means.
alter table public.app_settings
  alter column calendar_filter set default jsonb_build_object(
    'mode', 'attendees',
    'exclude', jsonb_build_array()
  );

-- 2) Repair every account still carrying NULL.
--
-- Deliberately NOT touching rows that already hold a filter: an account that
-- explicitly chose keyword matching (MarketMaker's own, backfilled earlier)
-- keeps it. This only fixes accounts that were never configured at all.
update public.app_settings
set calendar_filter = jsonb_build_object(
  'mode', 'attendees',
  'exclude', jsonb_build_array()
)
where calendar_filter is null;


