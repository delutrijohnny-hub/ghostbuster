-- A backup table created during the 2026-10-12 learning repair, left
-- readable through PostgREST with the public anon key. Nothing in it is
-- personal data -- it is aggregate send/reply counts per builtin variant --
-- but the project has shipped an anon-readable table once before and it is
-- not a mistake worth making twice.
--
-- Service role only: RLS on with no policy, and the API roles revoked, which
-- is how the other archive tables here are locked.
alter table if exists public.builtin_variant_stats_backup_20261012 enable row level security;
revoke all on public.builtin_variant_stats_backup_20261012 from anon, authenticated;
