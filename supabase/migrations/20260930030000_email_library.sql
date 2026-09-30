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
