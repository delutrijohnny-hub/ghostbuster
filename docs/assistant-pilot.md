# Johnny's assistant pilot

Adds a private My assistant tab: five explainable priorities, appointments in the next 24 hours, open tasks, deterministic workflow checks, and AI questions about a bounded summary. Priority selection reuses the existing conversation and follow-up rules. Review buttons open the current conversation; text drafting and review remain in its existing composer.

Access is checked in `gemini-draft` against the private `ASSISTANT_PILOT_USER_ID` server setting. It must contain Johnny's Supabase Auth user ID; missing configuration denies access. No role or browser flag grants access. Other accounts retain normal text drafting. Missing or old backend code leaves the tab hidden, without blocking the CRM.

## Deploy

1. In the Supabase project, set the private function secret `ASSISTANT_PILOT_USER_ID` to Johnny's UUID from Authentication → Users. Deploy the updated function with `supabase functions deploy gemini-draft` from the linked project. It reuses the existing GEMINI_API_KEY; no migration or new AI key is required.
2. Deploy the `hosted` directory using the existing site deployment configuration.
3. Sign in as Johnny and open My assistant. Verify priority links, then ask about the day. Compare against real conversations before using suggestions.
4. Sign in as a different account: no assistant tab; direct assistant requests must return 403, and ordinary draft requests must still work.

Rollback: redeploy the previous function and frontend. The assistant writes no data, so there is no data rollback.

## Boundaries

The assistant uses loaded account data, not a continuously synchronized feed. Questions send a summary of up to 20 priorities and 10 open tasks to the existing Gemini service only when Ask assistant is pressed. Names and task text are included, but raw message history, phone numbers and notes are not automatically included. Text is rendered as text, not HTML. Responses are ephemeral, cleared at sign-out, and have no tools or sending path.

Workflow suggestions are limited to visible checks (waiting conversations, stale Google calendar sync and missing contact methods). This version does not inspect usage telemetry or edit the application's code. There is no background agent, persistent conversation memory, automatic texting, or wider rollout. Calendar totals cover the next 24 hours rather than guessing the user's local day.

## Validation

Run `node --test tests/assistant.test.cjs` (Node 24 for the endpoint TypeScript stripping helper). The tests cover rule reuse, paused/skipped follow-ups, missing data, calendar checks, authentication, pilot enforcement, request limits and existing draft compatibility. Run the existing `node test.js` suite using its expected ignored local mirrors (`logic.js`, `app.js`, `index.html`) pointing to the hosted files.
