# The Desk Assistant — pilot

A phone on a stand. Thirty seconds before a call, and two minutes after it.

Pick the appointment, read or hear a brief, talk, then say what was promised
and have it become a note and a task. Four steps, one screen, no new concepts
for a rep to learn.

## What it is built on

Almost all of the hard part already existed. `callBriefing` has composed a
pre-call brief from records since 2026-11-02, and `client_facts` has carried
objections, promises and goals *with provenance* since 2026-11-03. The Desk
Assistant reshapes those into something readable at arm's length and adds the
two things that were genuinely missing: a voice, and a way back in afterwards.

**Nothing here calls a model.** The brief is composed by `deskCheatSheet` from
records the account already holds; the recap is parsed by `deskParseRecap` with
a regex. That is a deliberate limit. A rep reading a brief at speed can only
safely repeat a claim that can be checked against the thread in ten seconds,
and every sourced line carries where it came from.

## The one rule the whole thing rests on

**Sourced and suggested are different shapes, everywhere.**

`sheet.sourced` is quoted, never paraphrased, and each entry carries a
`source` string — "recorded objection (stated)", "their message, Oct 29",
"rep-provided, from https://…". `sheet.suggested` is templates filled from
those records: an opener, one focus, two questions, a goal.

On screen they are separate blocks with separate headings and a dashed border.
In the spoken script every suggestion is announced as one, because a voice has
no italics and the only way to keep the halves apart in the ear is to say
which is which.

A rep who cannot tell *"she said her budget is 20k"* from *"ask about budget"*
will eventually say the second as though it were the first, on a call, to the
person who would know.

## Research is pasted, not fetched

**This app has no retrieval integration.** Its twelve server-side `fetch`
calls all go to fixed provider APIs; nothing fetches an arbitrary URL. So the
rep pastes a public excerpt they have read, optionally with the URL they got
it from, and it is labelled **rep-provided** wherever it appears — vouched for
by a human, which is a weaker and more honest claim than "we fetched it".

The excerpt is data and never instruction: nothing parses it for commands,
control characters are stripped, it is capped at `DESK_RESEARCH_CHARS` (1200)
and says when it was truncated, and a URL that is not plainly `http(s)` is not
echoed as anybody's source. There is no model in this path for an injected
instruction to reach.

When nothing is pasted the brief *says so* in its gaps list, rather than
implying it looked outside and found nothing.

**No server-side URL fetching was added.** It would be a new egress surface
needing SSRF validation on destinations and redirects, and it cannot be
verified from here without deploying. The paste path is exactly what the brief
specifies when retrieval is unavailable, and it is fully verifiable locally.

## Dates

Resolved in the **rep's** timezone, read from the browser — there is no column
for it, and a rep who travels is in a different zone from the one a settings
page would remember.

`today`, `tomorrow`, `in N days/weeks`, a named weekday, and `Nov 14` /
`14 January` all resolve to an exact date, shown in a date field the rep can
change. A month already past means the one coming.

**Anything vague is left blank**, with the phrase quoted back: "next week",
"end of the month", "soon" and the rest of `DESK_VAGUE`. So is a weekday
spoken on that same weekday — "by Tuesday" said on a Tuesday is genuinely
ambiguous. So is a numeric date: `11/4` is two different days.

A wrong date on a follow-up task is worse than no date. A blank asks the rep a
question; a wrong one does not.

## What it writes

Exactly two rows, both through tables the app already owns, both only after a
person has read the proposal and pressed Save:

- `conversation_notes` — the same table `doAddNote` uses, which nothing can send
- `todos` — the same checklist the Today tab shows

The **note is the recap verbatim**. It is the only part that records what was
actually said, so it is never summarised or trimmed. The task is a suggestion
built by cutting the date phrase out of the clause mentioning a deliverable,
and it is deliberately crude and editable — a cleverer extraction that was
wrong would still have to be read and corrected, and a rep who stopped reading
because it usually gets it right is the failure mode.

Both ids are generated **once**, when the proposal is built. That is what makes
a retry safe: the second attempt carries the same primary key, the database
refuses it as a duplicate, and that refusal is treated as success. Each half
records its own outcome, so a note that saved while the task failed is not
saved twice when the rep presses Save again — and the status line says which
half landed rather than just "it failed".

## Access

Gated on `public.assistant_pilot_users`, the **same list `ghost-assistant`
uses** — one pilot roster, not a second to keep in step. Johnny
(`0853ce2b-…`) is the only member.

Hiding the launcher is a courtesy. Verified against the live database in a
rolled-back transaction, as a signed-in user in no org:

| | |
|---|---|
| owner reads their own appointment | 1 row |
| outsider reads that appointment | 0 rows |
| outsider writes a note on it | refused |
| outsider writes a task in that org | refused |
| outsider enrols themselves in the pilot | refused |
| outsider reads the pilot list | 0 rows |

## Setup

1. **Apply `supabase/migrations/20261104010000_todos_client_and_due.sql`.**
   Additive and nullable: `todos.client_id` and `todos.due_at`, no RLS change.
   **It is not applied.** The feature works without it — the insert falls back
   to omitting those two columns, and the date is written into the task text
   either way — so applying it adds sorting and the contact link and changes
   nothing else.
2. Deploy the hosted assets. `desk.js`, `desk.css` and `app.html` are new or
   changed; `logic.js` changed, so the Edge Functions that bundle it want a
   redeploy on the usual terms.
3. Nobody else needs enrolling. To add the second rep, insert their verified
   auth UUID into `assistant_pilot_users`.

## Trying it with one rep

1. Open the app on a phone, signed in as an enrolled account. Tap **☎ Desk**,
   bottom right.
2. The next upcoming call on *their own book* is shown, with the time in their
   zone and the prospect's, the countdown, and whether it is confirmed. If it
   is unconfirmed and a confirmation touch is due, there is a button that sends
   the existing one. Another call can be picked from the dropdown.
3. Optionally open **Add research you have checked** and paste a public
   excerpt. It will be labelled rep-provided.
4. Tap **▶ Read brief** to hear it, **■ Stop** to cut it off. Playback never
   starts on its own.
5. Take the call.
6. Tap **● Start listening** and say what happened, or type it. Tap **Turn
   into a note and a task**.
7. Check the client and appointment named at the top of the review, edit the
   note and task, fill the date if it was left blank, and press **Save**.

## Limits worth saying out loud

- One appointment at a time, one note and one task per recap.
- No external messaging, no call recording, no dedicated hardware. The
  controls are ordinary buttons, so a physical button mapped to a keypress can
  reach them later without any of this changing.
- Speech recognition and synthesis are the browser's. Where either is missing
  the panel says so and the written brief and typed recap carry the whole
  flow — verified with both disabled.
- `docs/assistant-pilot.md` is stale: it says nothing is live and sits on a
  branch, but `ghost-assistant` is deployed and enrolled, and
  `reserve_assistant_run` is **not** `SECURITY DEFINER` as that doc claims
  (`prosecdef = false`). Not touched here; flagged for whoever owns it.
