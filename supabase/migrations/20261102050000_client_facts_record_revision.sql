/* The history writes itself.
 *
 * The browser could insert a revision row before each PATCH, and that was the
 * first plan. It is wrong in a way worth naming: the two writes are not
 * atomic, so every ordering loses something. Revision first and the PATCH
 * fails, and the history records a change that never happened. PATCH first
 * and the revision fails, and the change has no history. And either way a
 * second client -- an Edge Function, a script, the extraction pass in Stage 3
 * -- gets the history wrong by simply not knowing it was supposed to write
 * one.
 *
 * So the database does it. An UPDATE that changes the body, the status or the
 * origin records what was there before, in the same transaction as the change
 * itself, and nothing that can reach the table can skip it. Same reasoning as
 * client_fact_revisions having no UPDATE or DELETE policy: a rule the storage
 * enforces is a rule, and a rule each caller is asked to remember is a hope.
 *
 * Only those three columns. An approval, a supersede link or a touched
 * updated_at did not change what the fact SAYS, and a history of
 * "approved_at went from null to a timestamp" buries the one entry somebody
 * is actually looking for.
 *
 * SECURITY DEFINER with a pinned search_path: the insert must not depend on
 * the caller happening to satisfy the revisions INSERT policy, or a legitimate
 * edit would fail on the bookkeeping rather than on the edit. The actor is
 * still auth.uid(), so who made the change is recorded, not assumed.
 *
 * Applied to production 2026-11-02 and verified in a rolled-back transaction:
 * a rewording and a resolve left two rows reading "too expensive -> [reworded]"
 * then "too expensive for this quarter -> [resolved]", an approval on its own
 * added none, and a reworded AI fact came out owned by the person who reworded
 * it with was_origin='ai' in the history.
 */
create or replace function public.client_facts_record_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.body is distinct from old.body
     or new.status is distinct from old.status
     or new.origin is distinct from old.origin then
    insert into public.client_fact_revisions(fact_id, actor, was_body, was_status, was_origin, note)
    values (old.id, auth.uid(), old.body, old.status, old.origin,
            case
              when new.body is distinct from old.body
                   and new.status is distinct from old.status then 'reworded and ' || new.status
              when new.body is distinct from old.body then 'reworded'
              when new.origin is distinct from old.origin
                   and new.origin = 'human' then 'taken over by a person'
              else new.status
            end);
    /* A person rewriting a model's wording takes ownership of it: the row
       stops being something a model said and becomes something they said,
       and the model's version is in the line just inserted above. Without
       this, origin stays 'ai' forever and every later reader is told a
       machine wrote a sentence a person actually wrote. */
    if new.body is distinct from old.body and old.origin = 'ai'
       and new.origin = old.origin and auth.uid() is not null then
      new.origin := 'human';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists client_facts_revision on public.client_facts;
create trigger client_facts_revision before update on public.client_facts
  for each row execute function public.client_facts_record_revision();

comment on function public.client_facts_record_revision() is
  'Records the previous body/status/origin on every meaningful UPDATE, so the history cannot be skipped by a caller that does not know about it.';
