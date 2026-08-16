// Thin authenticated proxy in front of the Gemini API, so the API key never
// ships to the browser. The app already builds the full prompt client-side
// (it has the client's notes/recap/voice-example data loaded there anyway,
// none of which is secret) — this function's only job is to hold the key
// and make the actual call.
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` },
  });
  if (!userRes.ok || !(await userRes.json())?.id) {
    return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let prompt: string;
  try {
    const body = await req.json();
    prompt = body?.prompt;
    if (!prompt || typeof prompt !== 'string') throw new Error('missing prompt');
  } catch {
    return new Response(JSON.stringify({ error: 'Request body must be JSON with a "prompt" string' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
    return new Response(JSON.stringify({ error: `Gemini request failed (${res.status})` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const text = (json?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('').trim();
  if (!text) {
    return new Response(JSON.stringify({ error: 'Gemini returned an empty response' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ text }), { headers: { 'Content-Type': 'application/json' } });
});
