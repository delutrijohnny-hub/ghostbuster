-- Let somebody fix a contact's name, and make it stick.
--
-- The name is derived: the parentheses in the calendar title, then "booked
-- by:" in the description, then the guest's displayName from Google, then the
-- literal string "Unknown". Three of those are somebody else's data entry and
-- the fourth is a placeholder, so getting a wrong one is normal — and until
-- now there was no way to correct it. The client modal lets you edit the date,
-- the phone, the timezone, the notes and the recap, but not who the person is.
--
-- "Unknown" is not cosmetic. firstName('Unknown') is 'there', so every one of
-- those contacts is lined up to receive "Hey there," in a message that is
-- otherwise personal and signed by name. On this book one person has seven,
-- two of which can never resolve on their own: the guest is a shared mailbox
-- with no display name for Google to send.
--
-- WHY A FLAG RATHER THAN JUST AN EDIT
-- The sync patches name on every re-read of an event. Without a marker, a
-- hand-typed correction survives until the next time Google resends that
-- event and is then silently replaced by "Unknown" again — the worst kind of
-- bug, because the person fixed it, saw it fixed, and finds it undone later.
--
-- Exactly the pattern timezone_confirmed already uses for the same reason: the
-- zone is guessed from an area code, corrected by hand, and must then survive
-- the next sync.

alter table public.clients
  add column if not exists name_confirmed boolean not null default false;
