-- Team-wide pooled stats for the built-in (shared) message templates. Before
-- this, variant_stats was per-user only — with 5 real accounts now sending
-- from the exact same 22 templates, each person's bandit only ever learned
-- from their own small trickle of sends, when everyone's results on the same
-- wording are actually the same signal. This table holds one row per
-- (stage, variant_key) shared across every account, so a reply from anyone
-- helps everyone's champion-picking converge faster.
--
-- Custom/hand-added variants (builtin=false in the per-user `variants`
-- table) are NOT pooled — those are genuinely personal to whoever added
-- them, so their stats stay in the existing per-user variant_stats table.
--
-- Writes only ever happen through increment_builtin_stat() (security
-- definer, atomic +1) rather than direct client UPDATEs — a buggy or
-- malicious client can only ever increment by exactly one send or one
-- response, never set the numbers to anything arbitrary.
create table public.builtin_variant_stats (
  stage text not null,
  variant_key text not null,
  sends int not null default 0,
  responses int not null default 0,
  primary key (stage, variant_key)
);

alter table public.builtin_variant_stats enable row level security;

-- Readable by anyone signed in — it's just aggregate counts, no client PII,
-- and every account needs to read everyone's pooled numbers to render the
-- leaderboard and pick a champion.
create policy "builtin_variant_stats_read_all" on public.builtin_variant_stats
  for select using (auth.role() = 'authenticated');

create or replace function public.increment_builtin_stat(p_stage text, p_variant_key text, p_field text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_field not in ('sends', 'responses') then
    raise exception 'p_field must be sends or responses';
  end if;

  insert into public.builtin_variant_stats (stage, variant_key, sends, responses)
  values (
    p_stage, p_variant_key,
    case when p_field = 'sends' then 1 else 0 end,
    case when p_field = 'responses' then 1 else 0 end
  )
  on conflict (stage, variant_key) do update set
    sends = public.builtin_variant_stats.sends + (case when p_field = 'sends' then 1 else 0 end),
    responses = public.builtin_variant_stats.responses + (case when p_field = 'responses' then 1 else 0 end);
end;
$$;

grant execute on function public.increment_builtin_stat(text, text, text) to authenticated;
