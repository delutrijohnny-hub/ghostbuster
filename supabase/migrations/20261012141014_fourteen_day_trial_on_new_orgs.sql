-- A 14-day trial, no card, starting when the organization is created.
--
-- No card means Stripe cannot be involved yet: there is nothing to charge
-- and no payment method to attach, so creating a Stripe customer at signup
-- would make an object per tyre-kicker and buy nothing. The trial is ours;
-- Stripe enters when somebody subscribes, and from that moment its status
-- is the truth.
--
-- Written by a trigger rather than by the client, because org_subscriptions
-- has no client write policy and must not get one -- a browser that could
-- set its own trial end could set it to 2099.
--
-- Deliberately only for NEW organizations. Every existing team has no row,
-- and subscriptionState reads "no row" as "nothing recorded" rather than
-- "not paying", so they keep full access untouched. Backfilling them would
-- start a 14-day clock on people already using the product and take the
-- operator's own team off the air a fortnight from now.
create or replace function public.start_trial_for_new_org()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.org_subscriptions (org_id, status, seats, trial_ends_at)
  values (new.id, 'trialing', 0, now() + interval '14 days')
  on conflict (org_id) do nothing;
  return new;
end $$;

drop trigger if exists organizations_start_trial on public.organizations;
create trigger organizations_start_trial
  after insert on public.organizations
  for each row execute function public.start_trial_for_new_org();

comment on function public.start_trial_for_new_org is
  '14-day no-card trial for new orgs. Existing orgs are deliberately left without a row, which reads as full access.';
