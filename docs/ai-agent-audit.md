# Technical audit — Ghost Recall as an AI sales assistant over external CRMs

Audit date: 2026-11-01. Baseline commit `c04c67a`, working tree clean, suite green
(603 blocks / 3,087 assertions), `logic.js` mirrors identical.

Everything below was read from the live project (`gqfpsjksosxvszzhhezu`) and the
repository, not from the brief. Where I could not establish something, it says so.

---

## 0. The headline

**The brief asks for four things that already exist, one that exists but is the
wrong shape, and two that are genuinely new.**

| Brief section | Reality |
|---|---|
| 1. Persistent client memory | Exists as **one free-text column**. Wrong shape — see §3. |
| 2. Pre-call intelligence | `assistantBriefing` + `upcomingCalls` already compute this. Missing only the 15-minute trigger. |
| 3. AI note-taking | Prompt + staleness tracking exist. No transcript ingestion, no approval step. |
| 4. Intelligent follow-up | **Substantially done**, and safer than the brief asks for. |
| 5. External CRM integration | Genuinely new. Nothing exists. |
| 6. Company-wide functionality | **Substantially done.** Orgs, roles, RLS, invites, reassignment all live. |
| 7. Personal ghost assistant | Live, read-only, enrolled to one account. |

The single most important finding: **the architecture the brief asks for is already
the architecture that is there.** `ghost-assistant/index.ts` computes findings
deterministically from the account's own records, then optionally hands *those
findings* — never the raw book — to a model that is forbidden to add facts. That
pattern is the right one and the whole build should extend it rather than introduce
a second one.

The second most important finding is in §2.1, and you need to make a decision about
it before any of this starts.

---

## 1. What already exists and can be reused

### 1.1 The deterministic assistant core — ~1,700 lines, reusable almost as-is

`hosted/logic.js:4537–6253`, "THE GHOST ASSISTANT, DETERMINISTIC PART". Directly
relevant to the brief:

| Function | Serves |
|---|---|
| `assistantBriefing(state, now)` | §2 pre-call intelligence |
| `upcomingCalls(state, now)` | §2 appointment detection |
| `assistantCoverage(state, now)` | States what the briefing *cannot* see |
| `assistantDataFindings(state, now)` | Data-quality findings with client ids |
| `assistantStateFromRows(rows, inbound, tz, cals)` | **The seam an external CRM plugs into** |
| `conversationSummaryPrompt(state, client)` | §1/§3 memory extraction |
| `summaryState` / `summaryThrough` | Staleness: "3 new messages since this summary" |
| `replyDraftPrompt` / `canDraftReply` | §4 suggested follow-ups |
| `automationState` / `setAutomationPause` | §4 opt-out and pause |
| `scheduledSendCheck(client, now, opts)` | The pre-send gate |
| `smsKeyword(body)` | STOP detection |
| `matchInboundReply(state, phone, at)` | Reply attribution across shared numbers |

`assistantStateFromRows` matters more than the rest combined. It converts **raw
database rows** into the state every other function consumes. An external CRM
adapter's whole job becomes: produce rows of that shape. Nothing downstream needs
to know where a contact came from.

### 1.2 Multi-tenancy — already real, not a stub

- `organizations`, `memberships` (roles `owner` / `admin` / `member`), `org_invites`,
  `org_phone_numbers`, `org_subscriptions` with a 14-day trial trigger.
- RLS enabled on **all 32 public tables**. The pattern, on `clients`:
  ```
  org_id IN (SELECT user_org_ids())
  AND (user_id = auth.uid() OR org_id IN (SELECT user_managed_org_ids()))
  ```
  — org membership *and* either ownership or management. Both helpers are
  `STABLE SECURITY DEFINER` with a pinned `search_path`.
- `events` has INSERT and SELECT policies and **no UPDATE or DELETE policy**:
  history is append-only at the database level, not by convention.
- `reassign_client` is a `SECURITY DEFINER` rpc that refuses to hand a contact to
  someone outside the org, and logs `owner.changed` against the *new* owner.
- Live: 17 orgs, 16 memberships, 1,130 clients across 4 orgs, 11 distinct owners,
  **zero clients without an org**.

Requirement §6 is largely a question of UI and of the two defects in §2.3.

### 1.3 The send-authorization model — already stronger than the brief requires

The brief says the AI must not independently send messages. That is **already
structurally impossible from the browser**, and not by UI convention:

```
scheduled_messages INSERT  WITH CHECK (… user_id = auth.uid() AND status = 'pending')
scheduled_messages UPDATE  USING (status = 'pending') WITH CHECK (status = 'cancelled')
```

A signed-in client can queue a *pending* message and can only ever transition it to
*cancelled*. Marking something `sent` requires the service role. `send-scheduled`
(pg_cron, every 5 minutes) re-runs `scheduledSendCheck` immediately before sending
and cancels on archived contact, STOP, carrier failure, a reply inside the pause
window, or a manual pause.

This is the correct place to attach every future authorization gate. Build on it;
do not route agent sends around it.

### 1.4 Infrastructure

- 12 Edge Functions. 5 pg_cron jobs (3× calendar sync, daily ops alert,
  `send-scheduled` every 5 min).
- Google OAuth already works end to end (`google-calendar-callback` +
  `google-calendar-sync`) — a working template for HubSpot OAuth.
- `device_tokens` with sha256-hashed tokens for the Mac agent.
- `test.js`: 603 blocks, 3,087 assertions, zero dependencies, runs the **tracked**
  copies of `logic.js`.

### 1.5 The external-record pattern already exists

All 1,130 clients carry a `google_event_id` and **none** is manually added. The
entire book is already derived from an external system of record. Ghost Recall has
never been the source of truth for its own contacts. That is a real head start on
"preserve each external CRM as the source of truth" — it is the existing situation,
not a new constraint.

---

## 2. What must be fixed before the AI agent

### 2.1 The Gemini decision is already made, in one direction, silently — DECIDE THIS FIRST

This is the finding I most need you to read.

`supabase/functions/gemini-draft/index.ts` is **live** (version 14, ACTIVE). Its own
header says the app builds the prompt in the browser and the function's only job is
to hold the key. So:

- Client notes, recap, and conversation text **already go to Google today**, whenever
  a reply draft is generated.
- The function is a **prompt pass-through**. It authenticates the caller and then
  forwards whatever string it was given. It cannot enforce data minimization,
  redaction, or scope, because it never sees structure — only a blob.

Meanwhile `ghost-assistant` deliberately keeps its own switch off behind
`ASSISTANT_AI_ENABLED === 'true'` **and** a key being present, with a comment
explaining that a key alone is not consent and that keying off its presence would
have enabled it silently.

Both things are true at once: the assistant is correctly waiting for your approval,
and a different feature has been sending client data to Google for some time. I am
not raising this as an alarm — drafting may well be exactly what you want. I am
raising it because every per-company promise in this brief ("no real-data
transmission to a new AI destination without approval") becomes a promise *to your
customers*, and right now the answer to "does Ghost Recall send our client data to
Google?" is yes, through a path that cannot be audited from the server side.

Three options, and this is your call:

1. **Keep it, make it honest.** Move prompt construction server-side so the function
   decides what may leave; add a per-org switch defaulting to off; disclose it.
2. **Narrow it.** Keep drafting but send only the extracted facts, never raw thread text.
3. **Turn it off** until §5 (memory) can supply structured input.

Option 1 is the one I would build. It is also a prerequisite for selling to another
company, because a per-org AI switch cannot be enforced in the browser.

### 2.2 `logic.js` is 9,894 lines and mirrored three ways — this is the velocity risk

`logic.js` must stay byte-identical across the repo root, `hosted/`, and
`supabase/functions/_shared/`. The suite doesn't merely fail on a mismatch — it
**throws and aborts**, so one stale copy hides every other result. `app.js` is a
further 9,096 lines; `app.html` 2,170; no build step anywhere.

The brief adds memory extraction, briefing scheduling, transcript ingestion, and
adapters for several CRMs. Put that in `logic.js` and it becomes ~15,000 lines
mirrored three ways.

**Recommendation: CRM adapters never enter `logic.js`.** The file is mirrored only
because it must run in both the browser and Edge Functions. Adapters are server-side
only — they belong in `supabase/functions/_shared/crm/` as TypeScript, which is
mirrored nowhere. Keep in `logic.js` only what the browser genuinely needs to
recompute: eligibility, cadence, memory *shape*, briefing *composition*.

The cost is that `_shared/crm/` cannot be covered by `test.js` (node, zero-dep,
loads `.js`). That is a real gap and §7 Stage 0 addresses it.

### 2.3 Two multi-org defects

**(a) `set_org_id_from_user()` picks an arbitrary org.**

```sql
select m.org_id into new.org_id from public.memberships m
 where m.user_id = coalesce(new.user_id, auth.uid())
 limit 1;
```

No `order by`, no error on ambiguity. Today this is latent: zero users belong to two
orgs. The moment one does — an agency, a consultant, somebody onboarding their
second company — new records land in whichever org Postgres returns first, and RLS
then hides them from the person who created them. Silent, and hard to trace after
the fact.

The same function is why a user with **no** membership cannot create a contact at
all: `org_id` stays NULL and the insert dies on the NOT NULL constraint, which is
exactly the failure mode that cost us Wednesday.

**(b) 8 of 17 organizations have no members.** Just under half the orgs ever created
are orphans. Something in the signup or invite path creates an org and fails to
attach its creator. Worth finding before onboarding real companies, because it is
probably a broken first-run experience.

### 2.4 Client memory is a single text column

```
clients.conversation_summary          text
clients.conversation_summary_at       timestamptz
clients.conversation_summary_through  timestamptz
```

`summaryState()` compares `conversation_summary_through` against the thread and
reports "3 new messages since this summary" — the staleness design is sound and
should be kept. But a blob cannot do what the brief asks: track objections, goals,
budgets and promises as distinct facts; cite the source message and time; separate
what a client *stated* from what was *inferred*; preserve human edits separately
from generated text; or keep change history. §3 replaces it.

`conversation_notes` has `body`, `client_id`, `org_id`, nullable `user_id`,
`created_at` — and **no `source` column and no `updated_at`**. So an AI-written note
and a human-written note are indistinguishable, and the brief's "keep generated notes
separately identifiable, editable, and correctable, with change history" is not
expressible. Note also that its DELETE policy is `user_id = auth.uid()`, so a note
with a NULL `user_id` can never be deleted by anyone.

### 2.5 Things that are fine — recorded so nobody re-raises them

- **8 tables with RLS on and no policies** (`clients_archive`, `message_log_archive`,
  `email_events`, `ops_alert_runs`, `org_merge_backup`, 2 dated backups,
  `google_oauth_tokens_archive`). RLS with no policy denies everything to
  `anon`/`authenticated`; only the service role reaches them. Correct for archives.
  Should be documented as deliberate so the advisor's INFO lines stop reading as debt.
- **3 `SECURITY DEFINER` functions callable by `anon`.** `create_device_token` raises
  on `auth.uid() is null`; `revoke_device_token` is the same shape;
  `start_trial_for_new_org` is a trigger function and cannot be invoked as an RPC.
  Effectively false positives. Revoking the `anon` grant is tidy, not urgent.
- **Leaked-password protection is off.** One toggle in Supabase Auth. Worth enabling
  before other companies' staff hold accounts.

### 2.6 Still open from before this brief

These are the kind of thing that erodes trust in the numbers an agent reports.

**Correction to an earlier draft of this audit.** It claimed the Mac agent still
drops ~1 in 3 messages because `attributedBody` is not read. **That is wrong — it was
fixed on 2026-10-21** in commit `48e8072`, and verified in production on 2026-11-01:
a full-history rescan of all 33,344 messages on the Mac finds 878 outbound messages
across 113 client numbers, and `message_log` holds **exactly 878** rows with
`provider_id like 'imsg:%'`. Inbound reconciles too (337 found, 345 stored). Capture
is complete. The 34-test agent suite passes.

**The real capture defect is send confirmation, and it is growing.** Of 1,578
`message_log` rows, **696 SMS rows have `provider_id is null`** — logged
optimistically when "Open in Messages" was clicked, never linked to a real message.
That is 44% of the table, up from 657 after the October recovery. Breaking it down
against the messages the Mac actually has:

| | rows | reading |
|---|---|---|
| Has a real message for that contact within ±20 min, **text differs** | 123 | Edited before sending. Recoverable. |
| Has one with identical text | 1 | — |
| **No real message anywhere near it** | **572** | **No evidence it was ever sent.** |

The 123 are the known cause: adoption requires an exact text match within 20 minutes,
and the first name is routinely edited before sending, so the match fails. Relaxing
adoption to "same contact, ±20 min, no other candidate" would recover them.

The 572 are more serious and are a product-truth problem, not a sync problem: Ghost
Recall logged a send that has no corroboration from the Mac at all. Some will be
green-bubble SMS the Mac never saw; some are drafts that opened and were never sent.
**An agent reasoning "we texted them thricefold and they never replied" would be
building on 572 sends that may not have happened.** This, not `attributedBody`, is
the data-quality item to settle before Stage 3.

Also still open:
- §4 of the earlier plan: the taper (months 4–5) and **Dormant at month 6** are
  unbuilt. Monthly recovery currently runs forever.
- One unexplained anomaly, logged for honesty: at 23:29 UTC on 2026-11-01 the agent
  reported `Synced 5 messages: 5 replies, 0 skipped, 0 REJECTED`, and the Edge
  Function returned 200 — but no `sms_events` row exists after Oct 30, the sequence
  never advanced past 1341, and no `message_log` row was marked `responded`. In the
  function, `inbound++` runs only after a successful insert that also PATCHes the
  prior row, so those effects cannot be absent if the count were real. There are no
  triggers or rules on `sms_events`, no `GR_ENDPOINT` override, and one project only.
  I could not explain it and did not guess; it needs the agent's response body logged
  to resolve.

---

## 3. New database structures

Described as fields, not DDL — no migrations until you've reviewed this.

### 3.1 Client memory

**`client_facts`** — the core of §1. One row per discrete fact, not a blob.

| Field | Why |
|---|---|
| `id`, `client_id`, `org_id`, `user_id` | Scoping, same pattern as `conversation_notes` |
| `kind` | `objection` / `goal` / `budget` / `promise` / `preference` / `timing` / `next_action` |
| `body` | The fact in one sentence |
| `status` | `active` / `resolved` / `superseded` / `rejected` |
| `confidence` | `stated` vs `inferred` — the brief asks for this explicitly |
| `source_kind`, `source_id`, `source_at` | Which message/call, and when. Makes a fact checkable. |
| `origin` | `ai` / `human` — the column `conversation_notes` is missing |
| `approved_by`, `approved_at` | §3 "update memory after employee approval" |
| `superseded_by` | Contradiction handling without destroying the older fact |
| `created_at`, `updated_at` | |

Two rules worth enforcing in the schema rather than the UI: a human edit never
silently becomes an AI fact (`origin` is immutable once set), and an AI fact is not
`active` until approved. The brief's "surface unresolved contradictions rather than
silently treating an older fact as current" is why `superseded_by` is a link and not
a delete — two `active` facts of the same `kind` that disagree is the signal to show.

**`client_fact_revisions`** — append-only history: `fact_id`, `at`, `actor`,
`was_body`, `was_status`. The brief asks for change history; `events` is the wrong
home because this needs to be queryable per fact.

Keep `clients.conversation_summary` as a **derived cache** of the facts for cheap
display. Do not delete it — `summaryState`/`summaryThrough` and the UI read it today.

### 3.2 Pre-call briefings

**`call_briefings`** — `client_id`, `org_id`, `user_id`, `appointment_at`,
`generated_at`, `payload` (the structured findings), `narrative` (nullable),
`delivered_at`, `dismissed_at`.

Persisted rather than computed on demand for one reason: the brief wants a reminder
15 minutes before a call. A notification you can prove was delivered needs a row.
`delivered_at` also makes the job idempotent — essential when a cron runs every
5 minutes and a user has two devices.

### 3.3 External CRM integration

**`integrations`** — `org_id`, `provider` (`hubspot` / `salesforce` / …), `status`,
`external_account_id`, `scopes`, `connected_by`, `connected_at`, `last_sync_at`,
`last_error`.

**`integration_credentials`** — separated from the row above so tokens are never
returned by an ordinary read. `integration_id`, `refresh_token`, `access_token`,
`expires_at`. **RLS: no policies at all** — service role only. The browser must
never be able to select a refund token, and the cleanest way to guarantee that is
for no policy to exist.

> Flag: `google_oauth_tokens.refresh_token` appears to be stored in plain text today.
> It is reachable only through a `user_id = auth.uid()` policy, so it is not exposed,
> but before holding *other companies'* CRM tokens this deserves a deliberate
> decision about encryption at rest. I have not verified how Supabase encrypts the
> underlying volume, so I am flagging it rather than asserting a problem.

**`crm_links`** — the idempotency backbone. `org_id`, `local_kind`
(`client`/`activity`/`appointment`), `local_id`, `provider`, `external_id`,
`external_updated_at`, `last_pushed_at`, `last_pulled_at`, `sync_state`.
Unique on `(org_id, provider, local_kind, external_id)` **and** on
`(org_id, provider, local_kind, local_id)`.

Why a link table and not an `external_id` column on `clients`: one org may connect
two CRMs; `clients.id` is already an opaque client-generated text id
(e.g. `cms5fjd201joa0b`) and overloading it with foreign ids invites exactly the
duplicate-contact problems the existing book already struggles with.

**`sync_cursors`** — `integration_id`, `resource`, `cursor`, `updated_at`. HubSpot
incremental pulls need a watermark per object type.

**`crm_outbox`** — approved writes *back* to the external CRM: `integration_id`,
`local_kind`, `local_id`, `operation`, `payload`, `idempotency_key`, `status`,
`attempts`, `last_error`, `approved_by`, `approved_at`.

This mirrors `scheduled_messages` on purpose, and for the same reason: **nothing
leaves Ghost Recall without a row somebody can inspect, and nothing is written to a
customer's CRM without an approval recorded against it.** `status` transitions and
`approved_by` are enforced by RLS exactly as `scheduled_messages` does it.

### 3.4 Call transcripts (§3)

**`call_transcripts`** — `client_id`, `org_id`, `user_id`, `source`, `occurred_at`,
`body`, `consent_basis`, `created_at`.

`consent_basis` is not bureaucracy. The brief says "authorized call transcripts";
two-party-consent recording law varies by state and you will be selling into
several. A transcript with no recorded basis for holding it is a liability, and the
column forces the question at write time.

---

## 4. How the agent talks to external CRMs

### 4.1 Shape: an adapter behind one interface, server-side only

```
supabase/functions/_shared/crm/
  types.ts        canonical shapes + the adapter interface
  hubspot.ts      first implementation
  (salesforce.ts, pipedrive.ts later)
```

Each adapter implements roughly: `listContactsSince(cursor)`,
`listActivitiesSince(cursor)`, `listAppointmentsSince(cursor)`, `pushActivity(…)`,
`pushNote(…)`, `pushPropertyUpdate(…)`, plus `normalize()` / `denormalize()` between
the provider's fields and Ghost Recall's canonical shape.

Nothing above `_shared/crm/` knows which CRM is connected. Per §2.2, none of this
enters `logic.js`.

### 4.2 Direction of truth

**Inbound (CRM → Ghost Recall), authoritative:** contacts, company/deal context,
appointments, and activity history. Written on `crm_links`, never blindly upserted
onto `clients` — a pulled change updates the local mirror and is tagged as
externally-sourced, so a salesperson's local edit is never silently overwritten by
the next pull. Conflicts surface rather than resolve.

**Outbound (Ghost Recall → CRM), approved only:** logged texts/calls, approved notes
and extracted facts, outcome and stage changes. Everything goes through `crm_outbox`
with an idempotency key. Nothing is pushed because a model suggested it.

**Never synced:** Ghost Recall's cadence state, variant statistics, and internal
notes. Those are our mechanics, not the customer's record.

### 4.3 Mechanics

- **OAuth** reuses the `google-calendar-callback` shape: `verify_jwt=false` on the
  callback (the provider's redirect carries no JWT — the same lesson as the
  email webhook), state parameter bound to the org, tokens straight into
  `integration_credentials`.
- **Pull** on a new `crm-sync` function, pg_cron every 15 minutes, plus HubSpot
  webhooks for low-latency contact changes. Cursor per resource; resumable.
- **Push** on a `crm-push` runner draining `crm_outbox`, exactly as
  `send-scheduled` drains `scheduled_messages` — including re-checking the gate
  immediately before the call, and leaving a failed row for retry with
  `attempts`/`last_error` rather than losing it.
- **Rate limits and partial failure** are the normal case, not the exception.
  HubSpot will 429. A sync that half-completes must leave the cursor where it was.

### 4.4 The thing to get right

A contact can legitimately exist in HubSpot, in a Google Calendar booking, and in
Ghost Recall, describing one human. Half this book already shares phone numbers
between contacts, and the duplicate problem is live. The identity rule must be
decided deliberately and in one place — `crm_links` first, then provider id, then
phone scoped by org, and **surface a possible duplicate for review rather than
merging it**. That is already the brief's instruction and already the product's
behaviour; it must not be relaxed for sync convenience.

---

## 5. Automatic memory and pre-call briefings

### 5.1 Memory — extraction proposes, a human accepts

Established pattern, unchanged: deterministic first, model second, model never
authoritative.

1. **Trigger.** `summaryState()` already knows a thread has unsummarized messages.
   Reuse it: when `newSince` crosses a threshold, or a call completes, queue an
   extraction. Not on every inbound message — that is cost with no benefit.
2. **Extract.** A model is given the thread and asked for candidate facts in the
   `client_facts` shape, each **with the source message id it came from**. A
   candidate with no resolvable source is discarded automatically — that single rule
   removes most invention.
3. **Stage.** Candidates land as `origin='ai'`, not `active`.
4. **Approve.** The salesperson accepts, edits, or rejects. Approval is what makes a
   fact `active`. Edits become `origin='human'` and the AI version is kept in
   `client_fact_revisions`.
5. **Contradict.** A new fact matching an `active` fact of the same `kind` is linked
   via `superseded_by` and **both are shown** until someone resolves it.

Idempotency, which the brief asks for: extraction is keyed on
`(client_id, source_id)`, so processing the same message twice produces no second
fact, and a late-arriving older message cannot overwrite a newer one because facts
carry `source_at` and are ordered by it rather than by arrival.

`conversationSummaryPrompt` is already written to the right standard — it forbids
describing as agreed anything that was only discussed, because "she agreed to Friday"
and "she asked about Friday" send someone into a call with different beliefs. That
rule should govern fact extraction verbatim.

### 5.2 Briefings — compose deterministically, narrate optionally

1. `upcomingCalls(state, now)` already finds the appointments.
2. A `briefing-runner` (pg_cron, every 5 minutes) finds calls starting in 15–20
   minutes with no `call_briefings` row, and inserts one. The window plus
   `delivered_at` makes it idempotent and survives a missed tick.
3. The payload is **composed, not generated**: active facts by kind, unresolved
   objections, outstanding promises, last contact and last reply with dates, current
   cadence stage and next planned send, and `assistantCoverage`'s statement of what
   is *not* known.
4. Only then, if the org's AI switch is on, a narrative over that payload — same
   constraint as today: may not introduce a fact, may not round a count.
5. Delivery via `device_tokens`, which already exists.

A briefing must still be useful with AI off. If it isn't, the deterministic layer is
too thin — and that is the measure to hold the build to.

---

## 6. How not to break the existing application

1. **`test.js` is the contract.** 603 blocks, 3,087 assertions, green at `c04c67a`.
   Nothing merges that doesn't keep it green. New guards get a mutation check:
   reintroduce the bug, confirm a named test fails.
2. **Additive schema only.** New tables, new nullable columns. No column drops, no
   type changes, no renames. `clients.conversation_summary` stays and keeps working
   while `client_facts` fills alongside it.
3. **Deploy code before data.** Already learned the hard way: ship the reader before
   the rows it depends on, or `loadState` throws on a table that doesn't exist and
   nobody can open the app at all.
4. **Every new surface is off by default, per org.** The `ASSISTANT_AI_ENABLED`
   pattern — two independent conditions, a key's presence never implying consent —
   becomes a per-org setting rather than a project-wide env var.
5. **`logic.js` stays mirrored and verified.** `md5 -q` across the three copies must
   equal 1 on every commit touching it; bump the cache stamp or the stamp test fails.
6. **New Edge Functions, not changes to the six that bundle `logic.js`.** Each
   redeploy of those is a chance to ship a stale bundle. Memory extraction, briefing
   generation, and CRM sync are new endpoints.
7. **Don't touch the send path's authorization.** New senders enqueue
   `scheduled_messages` or `crm_outbox`. Nobody gains the service role.
8. **Verify against a second source before reporting a number.** Including me: this
   audit's counts came from the live database, and the one query I wrote from memory
   in this session returned an empty result that would have been reported as "no
   errors" if I hadn't checked the field names first.

---

## 7. Build order

Each stage is independently testable and independently shippable. Nothing after
Stage 0 depends on a later stage.

### Stage 0 — Foundations (no features)
- **Decide §2.1.** Nothing AI-facing should be built on an unresolved answer.
- Fix `set_org_id_from_user()`: deterministic org choice, explicit error on ambiguity,
  clear failure when the user has no membership.
- Find the orphan-org leak (8 of 17).
- Establish a test path for `supabase/functions/_shared/` TypeScript. Without it,
  every CRM adapter is untested code, and §2.2 moved the adapters there deliberately.
- Document the deny-all archive tables; enable leaked-password protection.

*Testable:* suite green; a user in two orgs creates a contact in the intended org; a
user in none gets a real error instead of a 23502; adapter tests run in CI.

### Stage 1 — Structured memory, no AI
`client_facts` + `client_fact_revisions`. UI to add, edit, resolve and supersede facts
**by hand**. `conversation_summary` kept as a derived cache.

*Testable:* a salesperson records an objection, resolves it, and sees the history —
with no model involved. This stage is worth shipping on its own.

### Stage 2 — Briefings, no AI
`call_briefings` + the runner + the 15-minute notification, composed from Stage 1
facts and existing cadence state.

*Testable:* a booked call produces exactly one briefing, once, 15 minutes ahead,
containing facts and dates that can be checked against the records — with no model
involved.

### Stage 3 — AI extraction behind approval
Only now add the model, gated per org. Candidates must cite a resolvable source.
Nothing becomes `active` without a human accept.

*Testable:* a thread yields candidates; an unsourced candidate is dropped; the same
message processed twice yields no duplicate; rejection is remembered.

### Stage 4 — Reply drafts, consolidated
Fold the existing `gemini-draft` path into whatever §2.1 decided. Drafts drawn from
facts rather than raw thread text, reviewed before sending, through the existing
`scheduled_messages` gate.

*Testable:* a draft is proposed, edited, sent, and logged once; an opted-out contact
produces no draft at all.

### Stage 5 — HubSpot, read-only
`integrations`, `integration_credentials`, `crm_links`, `sync_cursors`, OAuth, and
inbound pull. **No writes to HubSpot in this stage.**

*Testable:* connect a sandbox portal; contacts and activities appear; a second sync
creates no duplicates; a revoked token surfaces as a clear error rather than silence.

### Stage 6 — HubSpot, approved writes
`crm_outbox` + the push runner. Logged texts and approved facts flow back.

*Testable:* an approved note appears once in HubSpot; a replayed outbox row does not
duplicate it; a 429 retries without loss; an unapproved row is never pushed.

### Stage 7 — Multi-company hardening
Per-org AI switches, manager views over the new tables, onboarding, seats.

*Testable:* two orgs with overlapping phone numbers see strictly their own data,
verified by querying as each user rather than by reading policy text.

### Stage 8 — Second provider
Salesforce or Pipedrive against the same interface. The real test of Stage 5's
abstraction: if adding the second provider requires changing anything above
`_shared/crm/`, the interface was wrong.

**Deliberately last:** the recovery taper and Dormant-at-6-months from the earlier
plan. They're small, and they belong with Stage 1's memory rather than before it.

---

## Decisions I need from you

1. **§2.1 — the Gemini question.** Keep and make honest, narrow, or switch off?
   Everything AI-facing waits on this.
2. **Is the first external-CRM customer real or hypothetical?** If a specific company
   is waiting, Stage 5 moves ahead of Stages 1–3 and the memory work follows. If it's
   a roadmap item, the order above is right, because memory makes the product better
   for *you* on day one.
3. **Call transcripts (§3) — where would they come from?** No recording or
   transcription exists today. That's a whole product surface, with consent law
   attached, and I've deliberately not planned it beyond the table.
4. **What to do about the 696 unconfirmed sends** (§2.6). The `attributedBody` gap I
   originally flagged here is already fixed; this replaces it, and it is the same
   argument — an assistant reasoning from wrong data is worse than no assistant.
   Three separable pieces of work: recover the 123 editable matches, tell the truth
   about the 572 with no evidence, and log the agent's response body to resolve the
   anomaly above.
