-- A person's chosen appearance.
--
-- On app_settings because that table is already per-user: its primary key is
-- the user, so one person's theme cannot reach another's screen. The brief
-- asks for that explicitly and the existing table already guarantees it --
-- adding a separate table would mean writing the isolation again.
--
-- jsonb to match the columns beside it (pipeline, terminology, sequence,
-- score_weights all work this way), and because the shape will change: a
-- future version adding a colour must not need a migration to store it.
-- sanitizeTheme is what makes that safe, replacing anything missing or
-- malformed with the default rather than letting it reach the page.
--
-- Nullable, meaning "never chosen". Null is not the same as the default
-- theme written out: somebody who has never opened Appearance should follow
-- their device, and a row full of light-theme hexes would silently pin them
-- to light the first time their OS went dark.
alter table public.app_settings
  add column if not exists theme jsonb;

comment on column public.app_settings.theme is
  'Chosen appearance: {mode, preset, colors}. Null means never chosen -- follow the device. Per-user by the table''s own key, so one person''s theme cannot affect another''s.';
