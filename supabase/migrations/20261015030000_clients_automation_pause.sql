-- An explicit "stop following up with this person for now".
--
-- Three things already hold a cadence back: a per-stage snooze ("not today"),
-- a permanent per-stage skip, and the three-day hold after somebody replies.
-- None of them is a contact-level instruction, and none is visible as one --
-- a salesperson who wants this person off their list until next month has to
-- snooze each touch individually and then remember why.
--
-- Null means automation runs. A timestamp means it is held until then.
--
-- Deliberately ABSOLUTE, unlike the reply pause. The reply hold lets
-- appointment-critical reminders through, because somebody who just wrote
-- back is engaged and still wants to know when the call is. A manual pause is
-- an instruction, and a system that keeps texting after being told to stop is
-- worse than one that never had the control.
alter table public.clients
  add column if not exists automation_paused_until timestamptz;

alter table public.clients
  add column if not exists automation_paused_note text;

create index if not exists clients_automation_paused_idx
  on public.clients (org_id, automation_paused_until)
  where automation_paused_until is not null;

comment on column public.clients.automation_paused_until is
  'Follow-ups are held for this contact until this moment. Null means automation runs. Absolute: unlike the reply hold, nothing is exempt, because this is an explicit instruction rather than an inference.';
