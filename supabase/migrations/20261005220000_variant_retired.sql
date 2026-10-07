-- A variant can be taken out of the running without losing its record.
--
-- Rewording a variant in place would have handed its reply history to copy
-- that never earned it: a template with 12 replies from 40 sends, rewritten,
-- would go on being preferred by pickVariant on the strength of the old
-- wording's performance. The bandit would be confidently optimising against
-- a number that had stopped meaning anything, and nothing would look wrong.
--
-- So editVariant forks instead of overwriting: the new wording starts from
-- zero and the original is retired. Retired means never picked again, never
-- deleted — its sends, its replies and the exact words that produced them
-- stay in the table, which is the only reason the comparison is worth having.
--
-- Defaults to false, so every existing row keeps its current behaviour and
-- this is a no-op until somebody rewords something.

alter table public.variants
  add column if not exists retired boolean not null default false;
