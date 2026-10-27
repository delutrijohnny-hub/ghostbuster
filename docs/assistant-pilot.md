# Private Ghost assistant pilot

This change adds a read-only assistant drawer to the existing app. It offers a current-record briefing, account Q&A/draft suggestions, deterministic workflow checks, and evidence-based optimization suggestions. It cannot send, schedule, update clients, change application settings, or modify code. The existing texting system is untouched.

## Activate for Johnny only

1. Review and apply migration `20261027012032_assistant_pilot.sql` in the intended Supabase project. It enrolls nobody by default. Inspect migration history before applying; do not blindly apply unrelated pending migrations.
2. Verify Johnny's auth user UUID in that project. As the database operator, insert that verified UUID into `public.assistant_pilot_users(user_id)`. Do not use an email substring, organization membership, or a frontend-only flag to select users.
3. Deploy the `ghost-assistant` Supabase Edge Function. It reuses the existing `GEMINI_API_KEY`; optional `ASSISTANT_MODEL` overrides the same model family already used by the drafting function. Never put a private key in hosted files.
4. Deploy the hosted assets including assistant.js, assistant.css, app.html, and auth.js. No assistant entry point appears for accounts outside the pilot.
5. Sign in as Johnny and check briefing, optimization, Q&A, feedback, review-client links, and close/Escape on desktop and mobile. Confirm the panel's timestamp and read-only label.
6. Use a separate nonpilot account to verify the button stays hidden AND direct endpoint requests receive 403. Verify logged-out requests receive 401. Test with seeded data before live use.

## Data and boundaries

The function authenticates the session and checks an operator-managed allowlist before reading context or using AI. It uses the caller's token, RLS, an explicit clients.user_id filter, client ID filters on messages, and a second in-memory ownership filter. Team-manager visibility is not used to expand the snapshot. No service-role key is used.

The pilot reads at most 500 owned clients. It retrieves up to 300 outbound and 300 inbound records per group of 50 clients, most recent first, with a truncation flag. Notes, recaps, and message bodies are limited to 1,500 characters each. These limits mean missing history cannot establish that a person never replied. When context exceeds 160,000 characters, the oldest loaded message records are removed and history_limited is set; all client records are retained. If client metadata alone exceeds the limit, the request fails explicitly. Phone numbers are used only for deterministic exact-normalized duplicate checks and omitted from the model snapshot. Names, notes, recaps, and message text are sent to the existing Gemini provider only when the user requests an answer.

A database transaction reserves each request and limits requests to five per minute per user. Questions, answers and optional helpful/incorrect feedback are stored in assistant_runs, visible only to the enrolled owner. Failed requests can have blank answers and still count toward the quota. No secrets or full prompts are logged to server console. Plan retention/deletion before broader rollout.

Disable by setting enabled=false on the pilot row. This blocks new endpoint calls and feedback/history access; reload removes the launcher. An already in-flight read-only answer may finish. There is no background worker or autonomous sending.

## Validation

- `node --test tests/assistant*.test.mjs`: deterministic checks and endpoint tests using mocked network responses, including authentication, enrollment, quota, failed reads, owner filtering, and no send calls.
- `node --check hosted/assistant.js` and `node --check hosted/auth.js`.
- `git diff --check`.
- Existing `node test.js` cannot start in this checkout because it requires missing root `./logic.js`; this is pre-existing and is not repaired by this feature.
- Migration 20261027012032 applied successfully. Transactional database tests verified owner reservation/completion/feedback, five-per-minute quota, nonpilot rejection, and owner-only RLS; all test writes were rolled back. Post-change security advisors reported no assistant-specific finding.
- Live Gemini quality, browser appearance, and Edge Function deployment remain unverified. Deployment was blocked by automatic approval review pending explicit user approval to share CRM context with Google Gemini. No pilot users are enrolled and no assistant runs remain. The public frontend has not been merged or deployed.

## Follow-on stages

Start with Johnny's feedback and review inaccurate suggestions. Measure useful/incorrect suggestions and time saved, including missed commitments and false positives. Optimization suggestions currently reflect CRM records, not measured click behavior or causal experiments.

Next: reviewable proposed reminders and status changes with audit records, stale-data checks, and undo. Then: simulated texting decisions against the existing scheduler. Automatic sending remains off until explicit opt-in to named routines, tested reply suppression, opt-out enforcement, quiet hours, idempotency, confirmed delivery state, and a kill switch. Do not add a second independent sender or purchase new phone numbers as part of this pilot.
