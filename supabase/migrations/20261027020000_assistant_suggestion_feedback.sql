-- Feedback on a SUGGESTION, which is not the same thing as feedback on a run.
--
-- assistant_runs.feedback already records helpful/incorrect for one answer.
-- That cannot silence anything: the workflow review is deterministic, so a
-- suggestion somebody has already considered and rejected comes back
-- identically every single time it is asked. A helper that repeats a
-- rejected suggestion every morning is just more clutter, which is the exact
-- thing this work is meant to remove.
--
-- So dismissal is keyed by the SUGGESTION id -- 'missing_outcomes',
-- 'timezone_all_derived' -- and not by the run it happened to appear in.
--
-- 'dismissed' and 'incorrect' are deliberately different answers. Dismissed
-- means "true, and I do not want to be told again". Incorrect means "this is
-- wrong about my book". Collapsing them would destroy the only signal here
-- worth anything: whether the deterministic checks are actually right.
create table if not exists public.assistant_suggestion_feedback (
  user_id uuid not null references auth.users(id) on delete cascade,
  suggestion_id text not null check (length(suggestion_id) between 1 and 80),
  verdict text not null check (verdict in ('helpful','incorrect','dismissed')),
  note text not null default '' check (length(note) <= 1000),
  updated_at timestamptz not null default now(),
  primary key (user_id, suggestion_id)
);

alter table public.assistant_suggestion_feedback enable row level security;
revoke all on public.assistant_suggestion_feedback from anon, authenticated;
grant select, insert, update, delete on public.assistant_suggestion_feedback to authenticated;

-- Owner-only AND pilot-only, the same pair assistant_runs uses. Enrollment
-- being revoked must close this off too, or a disabled pilot leaves a live
-- write surface behind it.
create policy assistant_suggestion_read on public.assistant_suggestion_feedback
  for select to authenticated using (
    user_id = auth.uid()
    and exists (select 1 from public.assistant_pilot_users p
                where p.user_id = auth.uid() and p.enabled)
  );

create policy assistant_suggestion_write on public.assistant_suggestion_feedback
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (select 1 from public.assistant_pilot_users p
                where p.user_id = auth.uid() and p.enabled)
  );

create policy assistant_suggestion_update on public.assistant_suggestion_feedback
  for update to authenticated using (
    user_id = auth.uid()
    and exists (select 1 from public.assistant_pilot_users p
                where p.user_id = auth.uid() and p.enabled)
  ) with check (user_id = auth.uid());

-- Un-dismissing is a thing somebody will want the moment they dismiss the
-- wrong one, and it must not require an operator.
create policy assistant_suggestion_delete on public.assistant_suggestion_feedback
  for delete to authenticated using (
    user_id = auth.uid()
    and exists (select 1 from public.assistant_pilot_users p
                where p.user_id = auth.uid() and p.enabled)
  );

comment on table public.assistant_suggestion_feedback is
  'Per-suggestion verdicts for the assistant pilot. dismissed = true but stop telling me; incorrect = wrong about my records. Kept apart deliberately: only the second says anything about whether the checks work.';
