-- One provider event, processed once.
--
-- The webhook's reply path marks "the most recent unanswered email to this
-- contact" as replied. Providers retry on a timeout or a 5xx, and on a retry
-- the most recent unanswered email is a DIFFERENT, older message -- so a
-- second message gets credited with a reply that never happened. That
-- inflates the reply rate and teaches the bandit that the wrong copy worked.
--
-- (provider_id, kind) is the natural key: the same email id with the same
-- event type is the same event, and a retry carries both unchanged. Two
-- genuine replies from one person arrive as different email ids; a
-- delivered-then-bounced pair differs by kind. Neither collapses.
--
-- The function also checks before inserting. That check is what makes it
-- correct today; this index is what closes the race when two retries land in
-- the same instant, and it turns the loser into a clean 409 rather than a
-- duplicate row.
--
-- Rows with a null provider_id are not constrained: Postgres treats nulls as
-- distinct, and an event with no id cannot be deduplicated anyway.
create unique index if not exists email_events_provider_kind_uniq
  on public.email_events (provider_id, kind)
  where provider_id is not null;
