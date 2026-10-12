-- Which wording a variant's numbers were earned by.
--
-- variant_key is not a stable identifier for copy. On the live book every
-- key had carried between 2 and 23 distinct messages, because migrations
-- rewrote builtin text in place while keeping the key -- so a reply rate
-- read per key is an average over messages that no longer exist. One key
-- showed "0 replies in 25 sends" for a text that had in fact never been
-- measured; the 25 belonged to two wordings it had already replaced.
--
-- text_hash records the wording these counters describe. When it stops
-- matching the variant's current text, the counters no longer describe that
-- text and are retired into prior_* rather than deleted: visible as context,
-- never fed to the bandit.
alter table public.variant_stats
  add column if not exists text_hash       text,
  add column if not exists prior_sends     integer not null default 0,
  add column if not exists prior_responses integer not null default 0;

comment on column public.variant_stats.text_hash is
  'Hash of the variant text these counters were earned by. Mismatch means the copy changed and sends/responses must reset.';
comment on column public.variant_stats.prior_sends is
  'Sends earned by earlier wording of this key. Context only -- never scored.';
