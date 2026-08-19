-- Per-account name used in the "{sender} here" part of message templates —
-- previously hardcoded to "John" everywhere, which was wrong the moment a
-- second real account (Ethan) started using the app. Nullable: null means
-- "no override set yet," and the app falls back to a sensible default
-- derived from the account's email (capitalized local-part) at render time
-- rather than needing every account to explicitly set one.
alter table public.app_settings add column sender_name text;
