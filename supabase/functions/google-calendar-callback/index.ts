// Receives Google's OAuth redirect after the user approves calendar.readonly
// access, exchanges the code for tokens using the Calendar Sync client's
// secret (this is exactly why the exchange has to happen server-side — the
// secret can never reach the browser), and stores the refresh token.
//
// The "which app user does this belong to, and what priority/label" info
// travels in the OAuth `state` param, base64-JSON-encoded by the frontend
// when it kicks off the redirect (see connectGoogleCalendar() in app.js).
// Not signed — acceptable for this threat model (see supabase/functions/README.md).

const CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTION_SELF_URL = `${SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co')}/google-calendar-callback`;

/* Where we are allowed to send somebody afterwards.

   The return origin travels in `state`, which is base64 JSON the browser
   wrote and nothing signs. Redirecting to whatever it says would be an open
   redirect: craft a state, send somebody through a real Google consent screen,
   and land them anywhere. So the origin is matched against this list and
   anything else falls back to the plain page it used to show.

   localhost and 127.0.0.1 on any port, so the flow can be exercised against a
   dev build without editing this file. */
const ALLOWED_ORIGINS = [
  'https://www.ghostrecallcrm.com',
  'https://ghostrecallcrm.com',
  'https://www.ghostbustercrm.com',
  'https://ghostbustercrm.com',
];

function appUrl(origin: string | undefined, params: Record<string, string>): string | null {
  if (!origin) return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  const ok = ALLOWED_ORIGINS.includes(u.origin) ||
             ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:');
  if (!ok) return null;
  const out = new URL('/app', u.origin);
  for (const k of Object.keys(params)) out.searchParams.set(k, params[k]);
  return out.toString();
}

/* Back to the app, not a dead end.

   This used to finish on a page saying "you can close this tab and go back to
   GhostBuster". Three things went wrong with that, all of them reported from
   real use: the page lives on functions.supabase.co, so it looks nothing like
   the product and reads as something having gone wrong; getting back is
   manual; and arriving at the app from a different origin is how people ended
   up signing in again. Then, because nothing told the app a calendar had just
   been connected, they pressed "Sync calendar" by hand — for a sync this
   function has already run and awaited. */
function backToApp(origin: string | undefined, params: Record<string, string>,
                   fallbackTitle: string, fallbackBody: string, status = 200) {
  const to = appUrl(origin, params);
  if (!to) return htmlResponse(fallbackTitle, fallbackBody, status);
  return new Response(null, { status: 303, headers: { Location: to } });
}

function htmlResponse(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html><head><title>${title}</title><style>
      body{font-family:-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center;color:#1c1a17;}
      h2{margin-bottom:8px;} p{color:#59544a;}
    </style></head><body><h2>${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html' } }
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    /* No state has been parsed yet, so there is no origin to go back to and
       this one still has to be a page. Cancelling at the Google screen is the
       common case and reads fine. */
    return htmlResponse('Connection cancelled', `Google reported: ${errorParam}. You can close this tab and try again from Ghost Recall.`, 400);
  }
  if (!code || !stateRaw) {
    return htmlResponse('Missing parameters', 'This link is missing required information. Close this tab and try connecting again from GhostBuster.', 400);
  }

  let state: { userId: string; priority: number; label: string; origin?: string };
  try {
    state = JSON.parse(atob(decodeURIComponent(stateRaw)));
  } catch {
    return htmlResponse('Invalid request', 'Could not read the connection request. Close this tab and try again.', 400);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: FUNCTION_SELF_URL,
      grant_type: 'authorization_code',
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    console.error('Google token exchange failed', tokenJson);
    /* The reason travels home rather than being spent on a page nobody
       returns from. The no-refresh-token case has real instructions attached
       — remove the old grant in Google first — and those are worth keeping
       wherever the person actually ends up. */
    const already = tokenJson.refresh_token === undefined && tokenRes.ok;
    return backToApp(state.origin, {calendar: 'error', reason: already ? 'already' : 'exchange'},
      'Connection failed',
      already
        ? 'Google did not return a refresh token — this usually means the account was already connected once before without revoking access first. Go to your Google Account\'s "Third-party access" settings, remove Ghost Recall, then try connecting again.'
        : 'Something went wrong exchanging the authorization code. Close this tab and try again.',
      400
    );
  }

  const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const userinfo = await userinfoRes.json();
  const calendarId = userinfo.email;
  if (!calendarId) {
    return backToApp(state.origin, {calendar: 'error', reason: 'account'},
      'Connection failed', 'Could not determine which Google account this is. Close this tab and try again.', 400);
  }

  const tokenExpiry = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString();
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/google_oauth_tokens?on_conflict=user_id,calendar_id`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      user_id: state.userId,
      calendar_id: calendarId,
      priority: state.priority,
      refresh_token: tokenJson.refresh_token,
      access_token: tokenJson.access_token,
      token_expiry: tokenExpiry,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!upsertRes.ok) {
    console.error('Failed to store token', await upsertRes.text());
    return backToApp(state.origin, {calendar: 'error', reason: 'save'},
      'Connection failed', 'Connected to Google, but saving the connection failed. Close this tab and try again.', 500);
  }

  // Connecting only stores the token — nothing pulls events until something
  // syncs. Left as a separate manual step, the first thing a newly-connected
  // person sees is an empty app, which reads as broken. Trigger one sync run
  // for just this user right away so bookings are already there when they
  // land back on GhostBuster. Best-effort: a failure here shouldn't block the
  // "connected" response — the scheduled cron runs and the "Sync now" button are
  // still there as fallbacks.
  try {
    const syncFnUrl = `${SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co')}/google-calendar-sync`;
    await fetch(syncFnUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId }),
    });
  } catch (e) {
    console.error('Post-connect sync trigger failed (non-fatal)', e);
  }

  // The sync above is awaited, so the bookings are already in by the time this
  // lands. Nothing left for the person to press.
  return backToApp(state.origin, {calendar: 'connected', cal: calendarId},
    'Calendar connected!',
    `${calendarId} (${state.label}) is now connected. You can close this tab and go back to Ghost Recall.`);
});
