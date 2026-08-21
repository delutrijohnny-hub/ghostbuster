-- toggleReplied() can flip a reply mark back off (someone checked it by
-- mistake) — the original increment_builtin_stat only ever added 1, with no
-- way to undo that in the pooled table, which would let it drift out of
-- sync with the per-message truth forever. Replace it with a version that
-- takes an explicit delta (still only ever +1 or -1 in practice, matching
-- the exact same semantics the per-user path already has via
-- Math.max(0, stats.responses + (m.responded ? 1 : -1)) in toggleReplied()) —
-- never lets a client set the count to an arbitrary value, only nudge it by
-- one in either direction, and never below zero.
drop function if exists public.increment_builtin_stat(text, text, text);

create or replace function public.increment_builtin_stat(p_stage text, p_variant_key text, p_field text, p_delta int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_field not in ('sends', 'responses') then
    raise exception 'p_field must be sends or responses';
  end if;
  if p_delta not in (1, -1) then
    raise exception 'p_delta must be 1 or -1';
  end if;

  insert into public.builtin_variant_stats (stage, variant_key, sends, responses)
  values (
    p_stage, p_variant_key,
    case when p_field = 'sends' then greatest(p_delta, 0) else 0 end,
    case when p_field = 'responses' then greatest(p_delta, 0) else 0 end
  )
  on conflict (stage, variant_key) do update set
    sends = greatest(0, public.builtin_variant_stats.sends + (case when p_field = 'sends' then p_delta else 0 end)),
    responses = greatest(0, public.builtin_variant_stats.responses + (case when p_field = 'responses' then p_delta else 0 end));
end;
$$;

grant execute on function public.increment_builtin_stat(text, text, text, int) to authenticated;
