-- Inbound email events: replies, bounces, complaints.
--
-- This is the point of the email channel. Every text GhostBuster produces is
-- handed to a phone, so a reply is invisible and someone has to remember to
-- record it — which is why reply logging sat at 4% for months. Mail that
-- GhostBuster sends is mail whose replies it can see, and a reply it can see
-- is one nobody has to log.
--
-- email_status stops a dead address being mailed forever. A bounced or
-- complained-about address is not a delivery problem to retry, it is an
-- address to stop using: continuing to send to it is how a sending domain's
-- reputation is destroyed, which then breaks delivery for every other contact.
alter table public.clients add column email_status text not null default 'ok'
  check (email_status in ('ok','bounced','complained','unsubscribed'));
alter table public.clients add column email_status_at timestamptz;

-- Delivery state per sent message, so a send that silently failed is
-- distinguishable from one that landed and got no answer. Without it, a
-- bounced email looks exactly like a contact ignoring you, and the bandit
-- learns the template was bad.
alter table public.message_log add column delivery_status text
  check (delivery_status in ('sent','delivered','bounced','complained'));

-- Raw webhook events, kept append-only. Matching a reply to the message it
-- answers is guesswork at the edges, so the original payload is retained:
-- when an attribution looks wrong, the evidence is still there.
create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  provider_id text,
  kind text not null,
  to_address text,
  from_address text,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
create index email_events_provider_idx on public.email_events (provider_id);
create index email_events_from_idx on public.email_events (lower(from_address));

-- No policies: written only by the webhook running as service role, and read
-- only by server-side code. Nothing in the browser needs it.
alter table public.email_events enable row level security;
