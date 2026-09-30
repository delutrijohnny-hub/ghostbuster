// Sends one email on behalf of a signed-in user and logs it.
//
// This is the first thing GhostBuster sends itself. Every message until now
// was handed to the salesperson's own phone via an sms: link, which is why
// reply detection was never possible — there was no channel to watch. Mail
// GhostBuster sends is mail GhostBuster can see replies to.
//
// Requires RESEND_API_KEY as a function secret. Without it the function
// refuses clearly rather than failing somewhere deeper:
//   supabase secrets set RESEND_API_KEY=re_xxx
//
// The provider is isolated to sendViaResend() so swapping to Postmark or SES
// later is one function, not a rewrite.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function sendViaResend(args: {
  from: string; to: string; subject: string; text: string; replyTo?: string;
}) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: args.subject,
      text: args.text,
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false as const, error: body?.message || `provider returned ${res.status}` };
  }
  return { ok: true as const, id: body?.id as string | undefined };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  if (!RESEND_API_KEY) {
    return json({
      error: 'Email is not configured yet. Set RESEND_API_KEY on this function.',
      code: 'no_provider',
    }, 503);
  }

  // Who is calling. The anon key alone proves nothing, so resolve the bearer
  // token to a real user before sending anything on their behalf.
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not signed in' }, 401);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY },
  });
  if (!userRes.ok) return json({ error: 'Not signed in' }, 401);
  const user = await userRes.json();
  const userId = user?.id;
  if (!userId) return json({ error: 'Not signed in' }, 401);

  let payload: { clientId?: string; subject?: string; text?: string; stage?: string; variantId?: string };
  try { payload = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const { clientId, subject, text, stage, variantId } = payload;
  if (!clientId || !subject || !text) return json({ error: 'clientId, subject and text are required' }, 400);

  const db = (path: string, init?: RequestInit) =>
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });

  // Settings carry both the permission and the identity to send as.
  const setRes = await db(`app_settings?user_id=eq.${userId}&select=*`);
  const settings = (await setRes.json())?.[0];
  if (!settings?.email_enabled) {
    return json({ error: 'Email sending is switched off for this account.', code: 'disabled' }, 403);
  }
  const fromAddress = settings.email_from_address;
  if (!fromAddress) {
    return json({ error: 'No sending address configured.', code: 'no_from' }, 400);
  }
  const from = settings.email_from_name
    ? `${settings.email_from_name} <${fromAddress}>`
    : fromAddress;

  // Ownership check. Service role bypasses RLS, so the caller's right to this
  // contact has to be proven explicitly rather than assumed.
  const cRes = await db(`clients?id=eq.${clientId}&select=id,name,email,user_id`);
  const client = (await cRes.json())?.[0];
  if (!client || client.user_id !== userId) return json({ error: 'Not your contact' }, 403);
  if (!client.email) return json({ error: 'That contact has no email address.', code: 'no_email' }, 400);

  const sent = await sendViaResend({
    from, to: client.email, subject, text,
    replyTo: settings.email_reply_to || undefined,
  });
  if (!sent.ok) return json({ error: sent.error, code: 'provider_error' }, 502);

  // Logged the same way a text is, so every count, rate and bandit stat treats
  // the two channels identically. Logging failure must not read as a send
  // failure — the mail has already gone.
  const logRes = await db('message_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      client_id: clientId,
      stage: stage || 'custom',
      variant_key: variantId || 'custom',
      text: `${subject}\n\n${text}`,
      sent_at: new Date().toISOString(),
      responded: false,
      reviewed: false,
      channel: 'email',
      provider_id: sent.id || null,
    }]),
  });
  const logged = logRes.ok;

  return json({ ok: true, providerId: sent.id, logged });
});
