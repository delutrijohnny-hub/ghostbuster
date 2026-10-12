-- Per-seat billing, attached to the organization rather than the user.
--
-- The org is the billing unit because seats are what gets sold: a manager
-- buys five and puts five salespeople in them. Keying this to a user would
-- mean a team's access died with whoever happened to sign up first.
--
-- Nothing here is written by the browser. Stripe is the source of truth and
-- the webhook (service role) is the only writer; the client reads its own
-- org's row to decide what to show. That is why there is a select policy and
-- no insert/update/delete policy at all.
create table if not exists public.org_subscriptions (
  org_id                 uuid primary key references public.organizations(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  -- Stripe's own vocabulary, stored verbatim rather than mapped to ours:
  -- trialing | active | past_due | canceled | incomplete | incomplete_expired
  -- | unpaid | paused. Translating it here would mean guessing at states
  -- Stripe adds later.
  status                 text,
  seats                  integer not null default 0,
  price_id               text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  trial_ends_at          timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.org_subscriptions enable row level security;

-- Anyone in the org can see whether the team is paid up; a salesperson
-- locked out by an expired card should be able to see that is why.
drop policy if exists org_subscriptions_select on public.org_subscriptions;
create policy org_subscriptions_select on public.org_subscriptions
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

-- No write policies on purpose: a client that could set its own status to
-- 'active' would make the whole thing decorative.
revoke insert, update, delete on public.org_subscriptions from anon, authenticated;

comment on table public.org_subscriptions is
  'Stripe subscription state per organization. Written only by the Stripe webhook running as service_role; readable by members of that org.';
