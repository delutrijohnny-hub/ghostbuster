-- A record of whether the alerter itself worked.
--
-- Caught the hard way: the Resend key was invalid, so ops-alert would have
-- sat there looking configured -- every presence check passing, armed:true
-- -- and said nothing through a real outage. The function did return the
-- reason, correctly; nothing was reading it. The cron fires and discards
-- the response.
--
-- You cannot alert about a broken alerter down the channel that is broken.
-- What you can do is write down what happened on every run, so the question
-- "is the watchdog alive?" has an answer that does not depend on anybody
-- having watched at the time.
create table if not exists public.ops_alert_runs (
  id          bigserial primary key,
  ran_at      timestamptz not null default now(),
  broken      integer not null default 0,
  armed       boolean not null default false,
  sent        boolean not null default false,
  error       text
);

create index if not exists ops_alert_runs_ran_at on public.ops_alert_runs (ran_at desc);

alter table public.ops_alert_runs enable row level security;
revoke all on public.ops_alert_runs from anon, authenticated;

comment on table public.ops_alert_runs is
  'One row per ops-alert run. Exists so a silently broken alerter is discoverable after the fact.';

-- One question, one answer: is anything wrong, and is the thing that would
-- tell me still working?
create or replace function public.ops_status()
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'broken_connections', (select count(*) from public.ops_sync_health()),
    'alerter', (
      select jsonb_build_object(
        'last_run_at',        max(ran_at),
        'hours_since_run',    round(extract(epoch from (now() - max(ran_at)))/3600.0, 1),
        'last_armed',         (array_agg(armed      order by ran_at desc))[1],
        'last_error',         (array_agg(error      order by ran_at desc))[1],
        'last_successful_send', (select max(ran_at) from public.ops_alert_runs where sent),
        'failed_runs_7d',     count(*) filter (where error is not null and ran_at > now() - interval '7 days')
      )
      from public.ops_alert_runs
    )
  );
$$;

revoke all on function public.ops_status() from anon, authenticated, public;
