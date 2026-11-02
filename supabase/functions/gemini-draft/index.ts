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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_MODEL = 'gemini-flash-latest';

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
  });
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
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` } },
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

  let prompt: string;
  try {
    const body = await req.json();
    prompt = body?.prompt;
    if (!prompt || typeof prompt !== 'string') throw new Error('missing prompt');
  } catch {
    return jsonResponse({ error: 'Request body must be JSON with a "prompt" string' }, 400);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // thinkingBudget:0 — without it this model can spend its whole output
    // budget on internal "thinking" and return finishReason STOP with empty
    // visible text; not needed for a short texting-voice draft anyway.
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 400 },
    }),
  });

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
