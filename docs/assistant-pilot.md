# The private Ghost assistant — pilot

A read-only assistant for **one account**. It briefs the day, reviews the
workflow, answers questions about the book, and says what it cannot know.

It cannot send a message, change a record, merge a contact, alter settings or
edit its own code. That is not a promise made in a prompt — there is no code
path to any of them, and the test suite asserts their absence in both the
endpoint and the panel.

## What is actually in it

**The findings are arithmetic, not a model.** Everything the assistant reports
is computed in `logic.js` from records the account already holds:
`assistantBriefing`, `assistantWorkflowReview`, `assistantDataFindings`,
`assistantCoverage`. They run inside the Edge Function. Nothing is sent
anywhere.

**Priorities ARE the action queue.** `assistantBriefing().priorities` is
`actionQueue()`, the same rows in the same order that Today and Conversations
render. The assistant cannot hold a private opinion about the day that differs
from the screen — if it could, one of them would be lying and nobody could
tell which.

**Observations and suggestions are different shapes.** An observation carries
evidence and a confidence of `certain` (a property of the data) or `possible`
(a heuristic to confirm — every identity finding is `possible`). A suggestion
carries what was noticed, the evidence and the period it covers, why it
matters, a concrete proposed change, and what it cannot tell you.

**It does not know anything about usage.** No clicks, no time on screen, no
before-and-after. `usageMeasurement.available` is `false` and stays false until
something actually measures it. Three of the questions the brief asks —
what creates work, what am I postponing, what should we simplify — are partly
usage questions, and the honest answer to that part is that these records
cannot say.

**It admits what the schema cannot hold.** `snoozedUntil` stores the *current*
deferral, not a history, so "which follow-ups am I repeatedly postponing" is
unanswerable from the data. The suggestion says so rather than guessing.

## External AI is OFF and takes two deliberate switches to turn on

`ASSISTANT_AI_ENABLED === 'true'` **and** `GEMINI_API_KEY` must both be set.
A key alone is not consent, and `GEMINI_API_KEY` is already set on this project
for the drafting feature — so keying off its presence, which the first version
did, would have started sending the CRM to Google the moment this deployed with
nobody having decided to.

With AI off, the endpoint still answers in full. The only thing missing is a
prose summary.

When it is switched on, the model is handed the **computed findings**, not the
book, and is instructed that it may not introduce facts. A model summarising a
structured result can be checked against it; a model handed a thousand contacts
and asked what matters cannot. Client text reaching it is marked untrusted —
though the real defence is that there is no tool for an injected instruction to
reach.

## How access is enforced

Three layers, none of which is the frontend:

1. Every read uses the **caller's** Authorization header with the anon key, so
   RLS applies as that user. The function holds no service-role key.
2. Clients are fetched with an **explicit `user_id` filter** on top of RLS. A
   manager who can legitimately see their team must not pull the team into a
   personal pilot.
3. Enrollment is checked in the endpoint for a clean 403, and again inside
   `reserve_assistant_run`, a `SECURITY DEFINER` function that raises for
   anybody not enrolled. A frontend that skipped the check would still be
   refused.

Hiding the launcher is a courtesy, not a permission, and the panel says so in
its own source.

`assistantStateFromRows` drops any inbound message whose contact is outside the
owner-filtered set. That is the one path by which another account's data could
otherwise reach the pilot.

Five requests per minute per user, reserved atomically with an advisory lock.

## Feedback

Three verdicts, and they mean different things:

- **Helpful** — worth more of these.
- **Not right** — wrong about my records. The only verdict that says anything
  about whether the checks work.
- **Don't show again** — true, and stop telling me.

The checks are deterministic, so without the third one a rejected suggestion
returns identically every morning and the helper becomes the clutter it was
built to remove. Collapsing "dismissed" into "incorrect" would destroy the only
accuracy signal here.

Feedback is stored. **It does not retrain anything** and nothing claims it does.

## What is NOT live

Nothing. All of this is on the branch `simplify/shared-action-queue`.

To bring it up:

1. **Apply `supabase/migrations/20261027020000_assistant_suggestion_feedback.sql`.**
   Additive: one new table, owner-and-pilot-only RLS, nothing existing touched.
   Without it the panel still works and says dismissals are not persisting.
   (`20261027012032_assistant_pilot` is already applied.)
2. **Enrol one verified auth user id** into `public.assistant_pilot_users`.
   Not an email substring, not org membership, not a frontend flag — the
   verified UUID, inserted by the operator. Nobody is enrolled by default.
3. **Deploy the function**:
   `supabase functions deploy ghost-assistant --project-ref gqfpsjksosxvszzhhezu`
   It bundles `_shared/logic.js`, so it joins the functions needing a redeploy
   whenever `logic.js` changes.
4. **Deploy the hosted assets** — `assistant.js`, `assistant.css`, `app.html`,
   `auth.js` go out with the branch merge.
5. **Leave `ASSISTANT_AI_ENABLED` unset.** Set it only when the decision to
   share CRM context with Google has actually been made.

## What to check personally during the pilot

- The briefing's order matches Today. If they ever differ, one of them is wrong
  and it is a bug, not a preference.
- Spot-check three findings against the actual records. They are arithmetic;
  they should be exactly right or exactly wrong, never approximately right.
- Press "Don't show again" on something and confirm it stays gone after a
  reload (needs step 1).
- Open a finding's client link and confirm it lands on the right person.
- Read "What I looked at" and check the span is what you expected.
- Sign out and confirm the panel is gone, not merely hidden.

## Verification so far

- 1,241 assertions in `node test.js`, including 26 for the assistant: the
  briefing matching the queue, observations versus suggestions, duplicate
  findings never asserting identity, unconfirmed sends never reading as sent,
  the usage denial, the inbound-row owner drop, the AI gate requiring both
  switches, the absence of any mutator, and every entry point surviving a
  half-built state.
- The panel driven in a browser against a seeded book at 1280px and 375px, in
  light and dark: launcher, briefing, workflow review, evidence, client links,
  all three verdicts, dismissal removing a card, Escape closing, no console
  errors, no horizontal scroll.
- **Not verified:** the deployed Edge Function (not deployed), live Gemini
  output (off, and not approved), and behaviour against the real book.

## Stages after this one

1. Read-only pilot — this.
2. Reviewable proposed drafts, reminders and record changes, with audit records
   and undo.
3. Simulation: what it *would* have done, against the existing scheduler.
4. Narrowly named routines, explicitly switched on one at a time.

Before any automated send: fresh checks for replies, opt-outs, pauses, quiet
hours and timezone, changed appointments, duplicate sends and stale drafts —
`scheduledSendCheck` is already that gate and must stay the only one. Plus an
action log and a kill switch. No second sender, and no new phone numbers.
