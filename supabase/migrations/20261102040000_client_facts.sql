/* What is known about a contact, one fact at a time.
 *
 * Until now the only memory was clients.conversation_summary: one block of
 * prose, rewritten whole, with no way to say WHEN something was true, WHO said
 * it, whether it was stated or inferred, or whether it still holds. Every
 * pre-call briefing therefore had to open by admitting that objections,
 * promises and budgets were not tracked at all.
 *
 * A fact is one sentence with a provenance, and that is what makes it
 * checkable: "they asked what it costs, on the 14th, in this message" can be
 * verified in ten seconds; "they are price sensitive" cannot be verified at
 * all.
 *
 * NO MODEL IS INVOLVED YET, deliberately. These are written and corrected by
 * hand first, so the mechanism is trustworthy before anything proposes a fact
 * automatically. The columns an extraction pass will need (origin, confidence,
 * source_*, approved_*) exist now so that pass needs no migration, and so the
 * rules are enforced from the first row rather than retrofitted to a table
 * already full of data.
 *
 * The status list here includes 'proposed', which production received as a
 * separate ALTER a few minutes after the table (migration
 * client_facts_proposed_status) because the gap was spotted immediately. A
 * fresh environment gets it from this CREATE and needs neither step.
 *
 * Applied to production 2026-11-02; recorded here so the next environment gets
 * it too. Verified in a rolled-back transaction: an AI fact cannot reach
 * 'active' unapproved, an unknown kind is refused, a blank body is refused, a
 * fact cannot supersede itself, and the org trigger fills org_id.
 */
create table if not exists public.client_facts (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null references public.clients(id) on delete cascade,
  org_id      uuid not null,
  /* The author of the CURRENT body. An AI fact a person rewrites becomes
     theirs -- see origin below. */
  user_id     uuid not null,

  /* The seven things worth knowing before a call. Written as `kind in (...)`
     so the test that keeps this list and logic.js in agreement can parse it:
     a value logic.js can produce and the database rejects fails the whole
     save, not just the row, which is how 'revival' once broke saving outright. */
  kind        text not null check (kind in ('objection','goal','budget',
                                            'promise','preference','timing',
                                            'next_action')),
  body        text not null check (length(btrim(body)) > 0),

  /* A fact is never deleted when it stops being true. 'resolved' is an
     objection answered or a promise kept; 'superseded' is a newer fact that
     replaced it; 'rejected' is one that was wrong. All three stay readable,
     because "we talked them out of the price worry in March" is itself worth
     knowing, and a deleted row cannot say it.

     'proposed' is a candidate nobody has looked at yet, and it exists because
     the other four all assert something false about one: an unreviewed row is
     not resolved, not superseded, not rejected, and -- by the constraint
     below -- not allowed to be active either. It sits outside the live index
     and outside every read that reports what is known. A human fact may be
     proposed too; what is being enforced is approval, not authorship.

     Added minutes after the table, while it still held zero rows, rather
     than during the extraction work that needs it -- same reason the AI
     columns are here before any AI writes to them. */
  status      text not null default 'active'
              constraint client_facts_status_check
              check (status in ('active','proposed','resolved','superseded','rejected')),

  /* "She agreed to Friday" and "she asked about Friday" are different facts,
     and a briefing that blurs them sends somebody into a call with the wrong
     belief. Anything not plainly said is 'inferred' and reads as such. */
  confidence  text not null default 'stated' check (confidence in ('stated','inferred')),

  /* Who wrote the body that is here now. A person editing an AI fact takes
     ownership of it and the model's version goes to client_fact_revisions --
     so this always answers "did a human write what I am reading". */
  origin      text not null default 'human' check (origin in ('human','ai')),

  /* Where it came from, so it can be checked. Null for a fact somebody simply
     knows; required in practice for anything a model proposes, because a
     candidate with no resolvable source is the one rule that removes most
     invention. */
  source_kind text check (source_kind is null or source_kind in ('message','reply','call','note','manual')),
  source_id   text,
  source_at   timestamptz,

  /* NOTHING A MODEL WROTE IS A FACT UNTIL A PERSON ACCEPTS IT, and that is a
     constraint rather than a convention. An AI row may be inserted, reviewed
     and rejected, but it cannot reach 'active' with no approval recorded. */
  approved_by uuid,
  approved_at timestamptz,
  constraint client_facts_ai_needs_approval
    check (not (origin = 'ai' and status = 'active' and approved_at is null)),

  /* A contradiction is a link, not a delete: two facts that disagree are the
     signal to show somebody, and the older one explains how the newer came
     about. */
  superseded_by uuid references public.client_facts(id) on delete set null,
  constraint client_facts_not_its_own_successor check (superseded_by is null or superseded_by <> id),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists client_facts_client_idx on public.client_facts (client_id);
create index if not exists client_facts_user_idx   on public.client_facts (user_id);
create index if not exists client_facts_org_idx    on public.client_facts (org_id);
/* The briefing's hot path: this contact's live facts. */
create index if not exists client_facts_live_idx
  on public.client_facts (client_id, kind) where status = 'active';

/* org_id from the one place that decides it, as every other table does. */
drop trigger if exists client_facts_set_org on public.client_facts;
create trigger client_facts_set_org before insert on public.client_facts
  for each row execute function public.set_org_id_from_user();

/* The history, append-only.
 *
 * "Keep generated notes editable and correctable, with change history" is the
 * requirement, and a fact whose previous wording is gone cannot support it.
 * This is where a model's original phrasing lives after a person rewrites it,
 * and where a body lives after somebody fixes a typo in it.
 *
 * Deliberately not the events table: this needs reading per fact, and events
 * is a timeline. No UPDATE or DELETE policy below, so it is append-only in the
 * database the way events is, not by agreement.
 */
create table if not exists public.client_fact_revisions (
  id          uuid primary key default gen_random_uuid(),
  fact_id     uuid not null references public.client_facts(id) on delete cascade,
  at          timestamptz not null default now(),
  /* Who made the change, which is not always who wrote the version being
     replaced -- that is the point of keeping both. */
  actor       uuid,
  was_body    text,
  was_status  text,
  was_origin  text,
  note        text
);
create index if not exists client_fact_revisions_fact_idx
  on public.client_fact_revisions (fact_id, at desc);

/* RLS, mirroring conversation_notes exactly rather than inventing a fourth
   pattern: the org reads, the author writes. A teammate can see what is known
   about a shared contact; only the person who wrote a fact can change it. */
alter table public.client_facts enable row level security;
alter table public.client_fact_revisions enable row level security;

drop policy if exists client_facts_select on public.client_facts;
create policy client_facts_select on public.client_facts for select
  using (org_id in (select public.user_org_ids()));

drop policy if exists client_facts_insert on public.client_facts;
create policy client_facts_insert on public.client_facts for insert
  with check (org_id in (select public.user_org_ids()) and user_id = auth.uid());

drop policy if exists client_facts_update on public.client_facts;
create policy client_facts_update on public.client_facts for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists client_facts_delete on public.client_facts;
create policy client_facts_delete on public.client_facts for delete
  using (user_id = auth.uid());

drop policy if exists client_fact_revisions_select on public.client_fact_revisions;
create policy client_fact_revisions_select on public.client_fact_revisions for select
  using (fact_id in (select id from public.client_facts
                      where org_id in (select public.user_org_ids())));

drop policy if exists client_fact_revisions_insert on public.client_fact_revisions;
create policy client_fact_revisions_insert on public.client_fact_revisions for insert
  with check (fact_id in (select id from public.client_facts
                           where org_id in (select public.user_org_ids())));

comment on table public.client_facts is
  'One checkable fact about a contact, with provenance. Objections, goals, budgets, promises, preferences, timing and next actions. Written by hand today; the AI columns exist so an extraction pass needs no migration.';
comment on constraint client_facts_ai_needs_approval on public.client_facts is
  'Nothing a model wrote becomes an active fact without a person accepting it.';
