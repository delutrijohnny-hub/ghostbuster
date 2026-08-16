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
    return htmlResponse('Connection cancelled', `Google reported: ${errorParam}. You can close this tab and try again from GhostBuster.`, 400);
  }
  if (!code || !stateRaw) {
    return htmlResponse('Missing parameters', 'This link is missing required information. Close this tab and try connecting again from GhostBuster.', 400);
  }

  let state: { userId: string; priority: number; label: string };
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
    return htmlResponse(
      'Connection failed',
      tokenJson.refresh_token === undefined && tokenRes.ok
        ? 'Google did not return a refresh token — this usually means the account was already connected once before without revoking access first. Go to your Google Account\'s "Third-party access" settings, remove GhostBuster, then try connecting again.'
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
    return htmlResponse('Connection failed', 'Could not determine which Google account this is. Close this tab and try again.', 400);
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
    return htmlResponse('Connection failed', 'Connected to Google, but saving the connection failed. Close this tab and try again.', 500);
  }

  return htmlResponse(
    'Calendar connected!',
    `${calendarId} (${state.label}) is now connected. You can close this tab and go back to GhostBuster.`
  );
});
