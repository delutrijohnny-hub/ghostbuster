-- Reverses 20260930030000_email_library.
-- Destructive: every email in the library is in this table and nowhere else
-- (the stage-keyed originals in `variants` survive, but anything written after
-- the library shipped does not). Export the library before running this.
drop table if exists public.email_library;
