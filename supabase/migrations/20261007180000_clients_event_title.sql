-- Keep the calendar event's title.
--
-- Asked for directly: whether show-up rates can be explained by "changes in
-- use in calendar titles". The answer was that it cannot be analysed at all,
-- and not because the sample is thin — because nothing has ever stored the
-- title. clientFromGCalEvent reads ev.summary, pulls the name out of the
-- parentheses, and discards the rest. No table in the schema holds it.
--
-- So this is the groundwork rather than the finding. Nothing can be said about
-- titles until there is a few weeks of them, and inventing a conclusion from
-- the handful of distinct titles already inferable would be the same mistake
-- as the touches-per-call correlation that was refused twice.
--
-- Useful immediately regardless of the analysis: "Second Call | Youtube
-- Strategy Session" and "Discovery" are different kinds of appointment and
-- neither the contact nor the manager's team queue could tell you which one a
-- call is. It also makes a mis-filtered import diagnosable — you can see what
-- came in and why it matched.
--
-- Nullable with no default and no backfill: every existing row keeps a null,
-- which reads honestly as "imported before we kept this" rather than as a
-- blank title. The UI must not print an empty string for those.
--
-- NOTE: the column exists but NOTHING WRITES IT YET. parse.ts, the sync and
-- data.js still have to carry ev.summary through. Until they do this stays
-- null on every row, which is inert rather than wrong.

alter table public.clients
  add column if not exists event_title text;
