-- A short read of where a conversation stands.
--
-- For picking a thread up cold: covering a colleague's client, or coming back
-- to somebody after three weeks. Forty messages is a transcript, not an
-- answer, and the question is always the same -- what did we agree, what did
-- they ask for, what is outstanding.
--
-- Cached rather than generated on view. It costs a model call and a second of
-- waiting, and a summary regenerated on every render would charge for both
-- every time somebody clicks a row.
--
-- summary_through is what makes staleness detectable: it holds the timestamp
-- of the newest message the summary actually covers. Anything newer and the
-- summary is out of date, which must be visible -- a confident summary that
-- silently predates the last three messages is worse than none, because it
-- will be believed.
alter table public.clients
  add column if not exists conversation_summary text;
alter table public.clients
  add column if not exists conversation_summary_at timestamptz;
alter table public.clients
  add column if not exists conversation_summary_through timestamptz;

comment on column public.clients.conversation_summary_through is
  'Timestamp of the newest message this summary covers. Anything newer means it is stale and must be shown as such rather than presented as current.';
