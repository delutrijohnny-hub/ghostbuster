-- Phase 2: a business's own pipeline and vocabulary, stored per organization.
--
-- Stage ROLES already exist in logic.js, so the engine no longer cares what a
-- stage is called. What was missing was anywhere to put a custom one: the
-- pipeline was still whatever buildDefaultPipeline() returned, identical for
-- everybody. These two columns are that place.
--
-- Deliberately jsonb rather than pipeline_stages and terminology tables. The
-- shape is still moving — stages may grow colours, targets, automation hooks —
-- and every read is "give me the whole config for this org", never a query
-- across stages. A table per concept would buy joins nobody needs and cost a
-- migration per field. If stage-level analytics later want real rows, the jsonb
-- is trivially normalisable; the reverse is not true.
--
-- Both default to NULL, meaning "use the built-in defaults", so every existing
-- account keeps behaving exactly as it does today until someone edits theirs.
-- That is also why the app treats an empty array as absent rather than as a
-- pipeline with no stages, which would strand every contact.
--
-- pipeline shape:    [{"key":"New Inquiry","label":"New Inquiry","role":"open"}, ...]
--   role is one of open | won | missed | stalled | lost — see logic.js.
-- terminology shape: {"contact":"Lead","contactPlural":"Leads","appointment":"Estimate", ...}
alter table public.app_settings add column pipeline jsonb;
alter table public.app_settings add column terminology jsonb;

-- Score weights live here too: the Ghost Score is a rules engine whose numbers
-- were calibrated against one book of ~140 contacts. Another business will
-- weight a missed appointment differently, and the weights were built to be
-- configurable for exactly that reason.
alter table public.app_settings add column score_weights jsonb;
