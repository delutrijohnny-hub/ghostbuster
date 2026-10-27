create schema ghost_assistant_internal;
revoke all on schema ghost_assistant_internal from public, anon;
grant usage on schema ghost_assistant_internal to authenticated;

-- Explicit opt-in, managed by an operator. No user is enrolled by default.
create table public.assistant_pilot_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true
);
alter table public.assistant_pilot_users enable row level security;
revoke all on public.assistant_pilot_users from anon, authenticated;
grant select on public.assistant_pilot_users to authenticated;
create policy assistant_pilot_read on public.assistant_pilot_users for select to authenticated
  using (user_id = auth.uid());

create table public.assistant_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  mode text not null check (mode in ('briefing','optimize','ask')),
  question text not null default '' check (length(question) <= 1500),
  answer text not null default '',
  feedback text check (feedback in ('helpful','incorrect'))
);
alter table public.assistant_runs enable row level security;
revoke all on public.assistant_runs from anon, authenticated;
grant select on public.assistant_runs to authenticated;
grant update (feedback) on public.assistant_runs to authenticated;
create policy assistant_run_read on public.assistant_runs for select to authenticated using (
  user_id = auth.uid() and exists (select 1 from public.assistant_pilot_users p where p.user_id = auth.uid() and p.enabled)
);
create policy assistant_run_feedback on public.assistant_runs for update to authenticated using (
  user_id = auth.uid() and exists (select 1 from public.assistant_pilot_users p where p.user_id = auth.uid() and p.enabled)
) with check (user_id = auth.uid());
create index assistant_runs_user_time on public.assistant_runs(user_id, created_at desc);

-- Atomic quota reservation. Also acts as the backend pilot gate.
create function ghost_assistant_internal.reserve_assistant_run(p_mode text, p_question text)
returns uuid language plpgsql security definer set search_path = public as $$
declare result uuid;
begin
  if auth.uid() is null or not exists(select 1 from assistant_pilot_users where user_id = auth.uid() and enabled) then
    raise exception 'Assistant pilot unavailable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  if (select count(*) from assistant_runs where user_id = auth.uid() and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Please wait a minute before asking again';
  end if;
  insert into assistant_runs(user_id, mode, question) values(auth.uid(), p_mode, p_question) returning id into result;
  return result;
end $$;
revoke all on function ghost_assistant_internal.reserve_assistant_run(text,text) from public, anon;
grant execute on function ghost_assistant_internal.reserve_assistant_run(text,text) to authenticated;

create function ghost_assistant_internal.finish_assistant_run(p_id uuid, p_answer text)
returns void language sql security definer set search_path = public as $$
  update assistant_runs set answer = left(p_answer, 16000)
  where id = p_id and user_id = auth.uid() and answer = ''
    and exists(select 1 from assistant_pilot_users where user_id = auth.uid() and enabled);
$$;
revoke all on function ghost_assistant_internal.finish_assistant_run(uuid,text) from public, anon;
grant execute on function ghost_assistant_internal.finish_assistant_run(uuid,text) to authenticated;

-- Exposed wrappers run with caller permissions; privileged implementations
-- live outside the Data API schema and check auth.uid() and enrollment.
create function public.reserve_assistant_run(p_mode text, p_question text)
returns uuid language sql security invoker set search_path = '' as $$
 select ghost_assistant_internal.reserve_assistant_run(p_mode,p_question);
$$;
create function public.finish_assistant_run(p_id uuid, p_answer text)
returns void language sql security invoker set search_path = '' as $$
 select ghost_assistant_internal.finish_assistant_run(p_id,p_answer);
$$;
revoke all on function public.reserve_assistant_run(text,text) from public, anon;
revoke all on function public.finish_assistant_run(uuid,text) from public, anon;
grant execute on function public.reserve_assistant_run(text,text) to authenticated;
grant execute on function public.finish_assistant_run(uuid,text) to authenticated;
