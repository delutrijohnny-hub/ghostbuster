/* Whether this account may send client text to Google for drafting.
 *
 * gemini-draft is live, and its own header argued that the prompt is built in
 * the browser and that none of the client's notes, recap or voice-example
 * data is "secret" -- as though that settled it. It does not. Those are
 * somebody else's words about somebody else's business, and the question is
 * not whether they are secret but whether anyone decided to send them to
 * Google. Nothing recorded that anyone had.
 *
 * DEFAULT FALSE, and it costs nobody anything today, because the integration
 * is dormant: zero gemini-draft calls across the whole 24-hour log window --
 * a window holding 784 calls to four other functions, so the absence is real
 * and not a broken query -- and zero of 1,130 contacts have ever had a
 * conversation_summary stored. This stops a data flow nobody is using rather
 * than removing a feature somebody relies on.
 *
 * Turning it on is one row, by the account that wants it:
 *   update app_settings set ai_drafting_enabled = true where user_id = '...';
 *
 * Deliberately separate from ASSISTANT_AI_ENABLED, which gates the briefing
 * narrative and remains unset. Two features, two decisions; a key being
 * present is not consent for either -- and the key has been set all along for
 * drafting, which is exactly why the assistant refuses to key off its
 * presence.
 *
 * Per account rather than per org because app_settings is per user and that is
 * the finer grain. A company that asks "does this send our client data to
 * Google?" needs an answer the server enforces, which is this column -- not a
 * button the browser chooses to hide.
 *
 * Applied to production 2026-11-02; recorded here so the next environment
 * gets it too.
 */
alter table public.app_settings
  add column if not exists ai_drafting_enabled boolean not null default false;

comment on column public.app_settings.ai_drafting_enabled is
  'Allows gemini-draft to send this account''s client text to Google. Default false. Enforced server-side in the function, not in the browser.';
