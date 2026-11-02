// Authenticated proxy in front of the Gemini API, so the API key never ships
// to the browser.
//
// It used to say here that the prompt is built client-side and that none of
// the client's notes, recap or voice-example data is "secret", as though that
// settled it. It does not. Those are somebody else's words about somebody
// else's business, and the question is not whether they are secret but
// whether anyone decided to send them to Google. Nothing recorded that
// anyone had, so the switch below now does.
//
// WHAT IS STILL WRONG, and it is the next piece of work: the body is a bare
// `prompt` string that the browser composed. This function can decide WHETHER
// anything goes, and cannot decide WHAT goes, because it never sees structure
// -- only a blob. Selling this to a company that asks "what exactly leaves
// our account?" needs the prompt built HERE, from rows read under the
// caller's own token, the way ghost-assistant does it. The prompt builders
// (replyDraftPrompt, conversationSummaryPrompt) already live in logic.js and
// are already tested, so the move is mechanical; it is not done yet and this
// comment is not pretending otherwise.
//
// Platform-level JWT verification alone isn't enough here: Supabase's
// default "verify_jwt" accepts any validly-signed project JWT, and the
// public anon/publishable key IS one — it's already visible in the page
// source, so relying on verify_jwt alone would let anyone holding that
// public key burn Gemini quota without ever signing in. Explicitly resolve
// the caller to a real authenticated user first (same pattern as
// google-calendar-sync's resolveTargetUserIds) and reject anyone who isn't.

/* The prompt builders, and the only copy of them. aiMessagePrompt,
   conversationSummaryPrompt, replyDraftPrompt and buildNotesPrompt all live in
   logic.js, so the browser and this function compose the same words from the
   same rules, and test.js checks them. This is the seventh function to bundle
   logic.js, which means it joins the set needing a redeploy when logic.js
   changes. */
import '../_shared/logic.js';
const GB = (globalThis as any).GBLogic;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_MODEL = 'gemini-flash-latest';

/* Deadlines on every outbound call, matching ghost-assistant's.
 *
 * The first real draft on this account took 92 SECONDS: the function's own
 * reads all finished inside 600ms and the rest was Google. There was no
 * timeout on that fetch, so a slow or wedged Gemini call hangs until the
 * worker is reclaimed -- and the button sits on "Generating..." with no
 * error, which is precisely the symptom that cost an evening to chase
 * earlier today. A second way to produce it is not worth keeping.
 *
 * The two Supabase calls had no deadline either. They are fast, but a hang
 * there is the same silence from a different direction. */
const GEMINI_TIMEOUT_MS = 45000;
const SUPABASE_TIMEOUT_MS = 10000;

// Called from the browser via supabase-js, which is a cross-origin fetch
// (the app runs on its own domain, the function on *.functions.supabase.co) —
// the browser sends a CORS preflight OPTIONS request first and silently
// blocks the real request if these headers aren't present on both the
// preflight response AND the real response.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` },
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  }).catch(() => null);
  /* Distinguished from "not signed in" on purpose: a check that could not be
     made is not a caller who failed it, and telling somebody they are signed
     out when the auth service was slow sends them to re-authenticate for no
     reason. Still refuses, either way. */
  if (!userRes) {
    return jsonResponse({
      error: 'Could not check who you are just now, so nothing was drafted. Try again.',
    }, 503);
  }
  const who = userRes.ok ? await userRes.json().catch(() => null) : null;
  const userId = who?.id;
  if (!userId) {
    return jsonResponse({ error: 'Not signed in' }, 401);
  }

  /* THE SWITCH. Sending a client's words to Google is a decision about
   * somebody else's data, and until this column existed nothing recorded that
   * anyone had made it -- the prompt was assembled in the browser and this
   * function forwarded whatever string it was handed, so no server-side rule
   * could narrow it and no answer could be given to "does this send our
   * client data to Google?" except "yes, whenever anyone clicks draft".
   *
   * Read as the CALLER and filtered to the caller's OWN row: app_settings is
   * readable org-wide by a manager, so `select` without the filter would let
   * one person's switch authorise another's.
   *
   * FAILS CLOSED. A settings read that errors refuses rather than permits,
   * because the cost of being wrong is one missing draft in one direction and
   * a client's conversation leaving the building in the other.
   */
  const setRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_settings?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=ai_drafting_enabled&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) },
  ).catch(() => null);
  const settings = setRes && setRes.ok
    ? ((await setRes.json().catch(() => [])) || [])[0] : null;
  if (!settings || settings.ai_drafting_enabled !== true) {
    return jsonResponse({
      error: 'AI drafting is switched off for this account, so nothing was sent anywhere. '
           + 'It writes drafts by sending this conversation to Google Gemini, which is why '
           + 'it is off until somebody turns it on.',
      aiDraftingEnabled: false,
    }, 403);
  }

  /* STRUCTURED INPUTS, NOT A PROMPT.
   *
   * This used to accept `{prompt}` -- a string the browser had already
   * composed -- which is why the switch above could only decide WHETHER
   * anything went to Google and never WHAT. Anything the page chose to put in
   * that string went, and no rule here could narrow it.
   *
   * Now the caller names a mode and a contact, and the prompt is built HERE
   * from rows read under the CALLER'S OWN token, so RLS decides which contact
   * they may draft for and this function decides which of that contact's
   * fields leave. The builders are logic.js's, the same ones the browser used,
   * so the words are unchanged and test.js still checks them.
   *
   * `notes` is the exception and has to be: the notes drafter works on text
   * somebody has just typed and not yet saved, so it cannot be read back from
   * any row. It arrives as a bounded field rather than as a blob, and the
   * prompt around it is still composed here.
   */
  const MODES = ['message', 'summary', 'reply', 'notes'];
  const NOTES_MAX = 4000;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Request body must be JSON' }, 400);
  }
  const mode = String(body?.mode || '');
  const clientId = String(body?.clientId || '');
  const stage = body?.stage == null ? '' : String(body.stage);
  const channel = body?.channel === 'email' ? 'email' : 'sms';
  const notes = body?.notes == null ? '' : String(body.notes);
  if (!MODES.includes(mode)) {
    return jsonResponse({ error: 'Choose a mode: ' + MODES.join(', ') }, 400);
  }
  if (!clientId) return jsonResponse({ error: 'A contact is required' }, 400);
  if (mode === 'message' && !stage) {
    return jsonResponse({ error: 'A stage is required to draft a touch' }, 400);
  }
  if (mode === 'notes' && !notes.trim()) {
    return jsonResponse({ error: 'There are no notes to draft from' }, 400);
  }
  if (notes.length > NOTES_MAX) {
    return jsonResponse({ error: 'Those notes are longer than this can draft from' }, 413);
  }

  /* Read as the caller, with the anon key, so RLS answers "may this person
     draft for this contact?" -- and no service-role key exists in this
     function to reach around it. One contact, by id. */
  const asCaller = { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` };
  async function rest(path: string) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: asCaller, signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!r || !r.ok) return null;
    return await r.json().catch(() => null);
  }

  const clients = await rest(
    `clients?id=eq.${encodeURIComponent(clientId)}` +
    `&select=id,name,phone,email,status,call_date_time,booked_date,timezone,` +
    `timezone_confirmed,organizer_email,event_title,notes,recap,ignored,` +
    `close_outcome,sms_status,google_event_id,automation_paused_until,` +
    `snoozed_until,skipped_stages,reschedules,reschedule_count,stalled_since,` +
    `manually_added,conversation_summary,conversation_summary_at,` +
    `conversation_summary_through,` +
    `message_log(id,channel,stage,variant_key,text,sent_at,responded,responded_at,` +
    `reviewed,delivery_status,provider_id)&limit=1`);
  if (!Array.isArray(clients) || !clients.length) {
    // RLS hid it, or it does not exist. Both are "not yours to draft for".
    return jsonResponse({ error: 'That contact could not be read on this account' }, 404);
  }

  const [inbound, settingsRows, variantRows] = await Promise.all([
    rest(`sms_events?client_id=eq.${encodeURIComponent(clientId)}&kind=eq.sms.inbound` +
         `&select=id,client_id,body,created_at,provider_id&order=created_at.desc&limit=200`),
    rest(`app_settings?user_id=eq.${encodeURIComponent(userId)}` +
         `&select=sender_name,pipeline,terminology,sequence&limit=1`),
    rest(`variants?user_id=eq.${encodeURIComponent(userId)}` +
         `&select=stage,variant_key,text,builtin,channel,retired`),
  ]);

  /* `acct`, not `settings`: the switch check above already holds a `settings`
     in this scope, and a second `const` of the same name in the same function
     is a SyntaxError at module load -- the function does not start at all. It
     deployed cleanly and then every request came back
     {"code":"BOOT_ERROR"}, caught by an anon-key probe rather than by a user
     clicking draft. */
  const acct = (settingsRows || [])[0] || {};
  /* Always called, with null resetting each to its default -- a stale global
     must not survive between requests on a warm instance. Same order
     loadState uses. */
  GB.setPipeline(Array.isArray(acct.pipeline) && acct.pipeline.length ? acct.pipeline : null);
  GB.setTerminology(acct.terminology || null);
  GB.setSequence(Array.isArray(acct.sequence) && acct.sequence.length ? acct.sequence : null);

  const state = GB.assistantStateFromRows(clients, inbound || [], 'UTC', []);
  state.senderName = acct.sender_name || 'the sender';
  /* voiceExamples reads state.variants: a person's own wording must outrank
     the starter templates, or somebody who wrote their own copy gets drafts
     in the stock voice. Retired wordings are left out. */
  state.variants = {};
  (variantRows || []).forEach((v: any) => {
    if (!v || v.retired || (v.channel && v.channel !== 'sms')) return;
    (state.variants[v.stage] = state.variants[v.stage] || []).push(
      { id: v.variant_key, text: v.text, builtin: !!v.builtin });
  });

  const client = state.clients[clientId];
  if (!client) {
    return jsonResponse({ error: 'That contact could not be read on this account' }, 404);
  }

  let prompt: string;
  if (mode === 'message') {
    prompt = GB.aiMessagePrompt(state, client, stage);
  } else if (mode === 'summary') {
    prompt = GB.conversationSummaryPrompt(state, client);
  } else if (mode === 'reply') {
    prompt = GB.replyDraftPrompt(state, client);
  } else {
    /* The business's own words, so the model has a voice to match -- picked
       here now, exactly as the browser picked them.
     *
     * NOT raw template source: voiceExamples renders the wordings against
     * this contact and puts anything the person wrote themselves ahead of the
     * starter copy, or somebody who has written their own texts gets drafts
     * in the stock voice. The stage is 'welcome' because that is the one the
     * notes drafter has always used; it has no stage of its own.
     *
     * On email the examples are the account's library documents, which means
     * loading them -- and a missing library degrades to no examples rather
     * than to no draft. */
    let pool: string[] = [];
    if (channel === 'sms') {
      pool = GB.voiceExamples(state, 'welcome', client, state.senderName)
               .examples.map((e: any) => e.text);
    } else {
      const libRows = await rest(
        `email_library?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=id,title,when_to_send,subject,body,touch,sort_order,archived,updated_at` +
        `&order=sort_order`);
      state.emailLibrary = (libRows || []).map((r: any) => ({
        id: r.id, title: r.title, whenToSend: r.when_to_send || '',
        subject: r.subject || '', body: r.body || '', touch: r.touch || '',
        sortOrder: Number.isFinite(r.sort_order) ? r.sort_order : 0,
        archived: !!r.archived, updatedAt: r.updated_at,
      }));
      pool = GB.emailLibrary(state).map((d: any) => d.body);
    }
    prompt = GB.buildNotesPrompt({
      client, notes, channel, senderName: state.senderName, examples: pool,
    });
  }
  if (!prompt || typeof prompt !== 'string') {
    return jsonResponse({ error: 'Nothing could be drafted for that contact' }, 422);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      // thinkingBudget:0 — without it this model can spend its whole output
      // budget on internal "thinking" and return finishReason STOP with empty
      // visible text; not needed for a short texting-voice draft anyway.
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 400 },
      }),
    });
  } catch (e) {
    /* A deadline, reported as one. The prompt went to Google and no draft
       came back; nothing was sent to the contact, and nothing was stored. */
    const name = e instanceof Error ? e.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    console.error('Gemini unreachable (%s): %s', name,
      e instanceof Error ? e.message : String(e));
    return jsonResponse({
      error: timedOut
        ? 'Google did not answer within 45 seconds, so no draft was written. '
          + 'Nothing was sent to anybody — try again.'
        : 'Google could not be reached, so no draft was written.',
    }, 504);
  }

  const json = await res.json();
  if (!res.ok) {
    console.error('Gemini request failed', json);
    return jsonResponse({ error: `Gemini request failed (${res.status})` }, 502);
  }

  const text = (json?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('').trim();
  if (!text) {
    return jsonResponse({ error: 'Gemini returned an empty response' }, 502);
  }

  return jsonResponse({ text });
});
