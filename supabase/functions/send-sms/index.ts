// Sends one text on behalf of a signed-in user and logs it.
//
// This is the half of two-way SMS that makes the other half mean anything.
// Until now every text was handed to the salesperson's own phone via an
// sms: link, so the reply landed on that phone, where GhostBuster could not
// see it and a human had to remember to record it. They do not: 0 of the 67
// sends since the review path was repaired have been reviewed, while 43
// review questions sit unanswered on the owner's own account. Pointing
// sms-webhook at a number changes nothing while the texts still go out from
// a rep's handset -- the contact replies to the handset. The text has to
// leave from the org's own number for the reply to come back somewhere the
// system can see it.
//
// Requires, as function secrets:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// and a row in org_phone_numbers for the caller's org. Without either it
// refuses clearly rather than failing somewhere deeper.
//
// The provider lives behind the interface in _shared/providers.ts, picked per
// NUMBER rather than per deployment -- so one rep can run on a sandbox number
// that carries nothing anywhere while the rest send for real, and the whole
// loop can be exercised without a carrier account or a real customer's phone.

import '../_shared/logic.js';
import { providerFor } from '../_shared/providers.ts';
// deno-lint-ignore no-explicit-any
const GB = (globalThis as any).GBLogic;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  /* No global provider check here any more.

     Which provider a message uses depends on the NUMBER it goes out from, so
     a team can run one rep on a sandbox number while the rest send for real.
     Refusing everything because Twilio is unconfigured would make the sandbox
     impossible to use, which is the one thing it is for. The check happens
     once the number is known, below. */

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

  let payload: { clientId?: string; text?: string; stage?: string; variantId?: string;
                 route?: string };
  try { payload = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const { clientId, text, stage, variantId } = payload;
  if (!clientId || !text) return json({ error: 'clientId and text are required' }, 400);

  /* Two ways out of here, and every guard below applies to both.

     'provider' hands the text to Twilio from a registered 10DLC number.
     'mac' queues it for the Mac agent to send through the Messages app, from
     the number the recipient already knows -- which is the whole point, and
     is also why it is not the default: it only works while that Mac is awake
     and signed in.

     The guards are deliberately NOT relaxed for the Mac route. There is no
     A2P campaign to get filtered and iMessage is not carrier SMS, so the
     carrier argument for them is weaker here. The other two reasons hold
     completely: a contact who replied STOP should not then get a text from
     somebody's personal Apple ID, and the moment Messages falls back to a
     green bubble it IS carrier SMS again, with the same rules it always had.
     A route that quietly dropped the checks would be the one route that
     texts an opted-out contact at 3am. */
  const route = payload.route === 'mac' ? 'mac' : 'provider';

  const db = (path: string, init?: RequestInit) =>
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json', ...(init?.headers || {}),
      },
    });

  /* Ownership check. Service role bypasses RLS, so the caller's right to this
     contact has to be proven explicitly rather than assumed. */
  const cRes = await db(
    `clients?id=eq.${encodeURIComponent(clientId)}&select=id,name,phone,user_id,org_id,sms_status,timezone`);
  const client = (await cRes.json())?.[0];
  if (!client || client.user_id !== userId) return json({ error: 'Not your contact' }, 403);
  if (!client.phone) return json({ error: 'That contact has no phone number.', code: 'no_phone' }, 400);

  /* An opt-out is a hard stop, and the only one here with a regulator behind
     it. Texting someone who replied STOP violates the TCPA, and carriers
     enforce it themselves by filtering or killing the 10DLC campaign -- which
     would take texting down for every other contact at the same time. */
  if ((client.sms_status || 'ok') !== 'ok') {
    return json({
      error: client.sms_status === 'opted_out'
        ? 'That contact replied STOP and cannot be texted.'
        : 'That number could not be reached by the carrier.',
      code: 'bad_number',
    }, 400);
  }

  /* The sending number belongs to the ORG, not the user, and it is the same
     row sms-webhook uses to decide which org an inbound text belongs to.
     Reading it from the contact's org rather than from a setting is what
     keeps the two directions describing one number: a text that goes out
     from a number the webhook does not know about would get a reply that
     lands nowhere, which is the current situation with extra steps. */
  /* The CALLER's own number first, the org's shared one only as a fallback.

     A client who has been dealing with Ethan for a month should not get a
     reminder from a number that is not his -- the entire reason to own the
     number is that the recipient recognises the sender. The first version of
     this took the org's first registered row, which would have put the whole
     team on one line and quietly undone that.

     Ordered so a row with a user_id wins: PostgREST sorts nulls last here, so
     the personal number comes before the org fallback. */
  /* Only the provider route needs one. The Mac sends from whatever Apple ID
     and phone number that Mac is signed in as, so demanding a registered
     10DLC row here would block the one route that works without it -- and
     this org has no registered number at all, which is exactly why the Mac
     route is being built. */
  let num: { phone_number: string; user_id: string | null; provider: string } | null = null;
  if (route === 'provider') {
    const nRes = await db(
      `org_phone_numbers?org_id=eq.${client.org_id}&status=eq.registered` +
      `&or=(user_id.eq.${userId},user_id.is.null)` +
      `&select=phone_number,user_id,provider&order=user_id.asc.nullslast&limit=1`);
    num = (await nRes.json())?.[0] || null;
    if (!num?.phone_number) {
      return json({
        error: 'This team has no registered texting number yet. A2P 10DLC registration has to clear first.',
        code: 'no_number',
      }, 503);
    }
  }

  /* Quiet hours, enforced HERE rather than only in the browser.

     8am-9pm in the recipient's local time is the TCPA window, and carriers
     enforce it themselves: a campaign caught sending at 3am gets filtered or
     shut off, taking texting down for every other contact at once. The window
     and the check both already existed in logic.js and were used for exactly
     one thing -- a grey warning chip on the card. A warning is not a guard,
     and the person most likely to clear their list at 2am is the one least
     likely to read it.

     Server-side because that is the only place it cannot be skipped: a
     disabled button is a suggestion, and any later caller -- a cadence
     runner, a bulk action, a retry -- would otherwise have to remember this
     rule on its own. */
  const windowCheck = GB.smsSendWindow(
    {timezone: client.timezone || 'America/New_York'}, new Date());
  if (!windowCheck.ok) {
    return json({
      error: 'Too late to text them \u2014 ' + windowCheck.reason +
        '. Texting is allowed 8am to 9pm their time; this opens again in ' +
        windowCheck.hoursUntilOpen + ' hour' + (windowCheck.hoursUntilOpen === 1 ? '' : 's') + '.',
      code: 'quiet_hours',
      hoursUntilOpen: windowCheck.hoursUntilOpen,
    }, 400);
  }

  const toDigits = GB.phoneKey(client.phone);
  if (toDigits.length < 10) {
    return json({ error: 'That phone number is not a full number.', code: 'bad_number' }, 400);
  }

  /* Carrier opt-out language on the first text to this contact.

     Appended HERE, on the server, rather than trusted to whatever called in.
     Every route has to carry it -- the card, focus mode, and anything added
     later -- and a compliance requirement that depends on each caller
     remembering is one that eventually ships without it. A campaign whose
     messages lack opt-out language gets filtered by the carriers, which fails
     silently: the texts report as sent and simply never arrive. */
  const priorRes = await db(
    `message_log?client_id=eq.${encodeURIComponent(clientId)}&channel=eq.sms&select=id&limit=1`);
  const prior = await priorRes.json().catch(() => []);
  const body = GB.withOptOutNotice(text, {
    messageLog: (Array.isArray(prior) ? prior : []).map(() => ({channel: 'sms'})),
  });

  /* What goes in the row depends on who is carrying the message.

     On the Mac route NOTHING has been sent at the moment this row is written
     -- it is a request, and 'queued' with no provider_id is what the agent
     looks for. Saying 'sent' here would be the same lie "Open in Messages"
     told 637 times: a status nobody earned. */
  let providerId: string | null = null;
  let status = 'queued';
  let providerName = 'messages-app';
  let real = true;
  let fromLabel: string | null = null;

  if (route === 'provider') {
    const picked = providerFor(num!.provider, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN });
    if (!picked.provider) {
      return json({ error: picked.error, code: 'no_provider' }, 503);
    }

    const sent = await picked.provider.send({
      from: num!.phone_number,
      // E.164. phoneKey gives the last ten digits, which for a US number is
      // the whole thing after the country code.
      to: `+1${toDigits}`,
      body: body,
      statusCallback: `${SUPABASE_URL}/functions/v1/sms-webhook`,
    });
    if (!sent.ok) return json({ error: sent.error, code: 'provider_error' }, 502);

    providerId = sent.id || null;
    /* What the provider said, not what we hoped. A provider that cannot
       confirm anything reports 'queued', and that is what gets stored --
       the delivery states are only worth having if each one is earned. */
    status = sent.status || 'queued';
    providerName = picked.provider.name;
    real = picked.provider.real;
    fromLabel = num!.phone_number;
  }

  /* Logged exactly the way a hand-sent text is, so every count, rate and
     bandit stat treats them identically. provider_id is what ties the
     delivery receipt and any reply back to THIS message -- without it the
     webhook has a reply and no idea what it answers. Logging failure must
     not read as a send failure: the text has already gone. */
  const logRes = await db('message_log', {
    method: 'POST',
    /* The inserted row comes back so the browser can adopt its id.

       This is the difference between one row and two. send-sms has to do the
       logging, because provider_id is minted here and it is the only thing
       tying a later receipt or reply back to this message. But the browser
       also logs the send into its own state and upserts it on the next save.
       Two ids for one text is two rows, and 297 duplicate message_log rows
       had already inflated every reply figure in this product once.

       So the id is returned, the browser overwrites its local one with it,
       and its upsert merges onto this row instead of creating a sibling.
       rowMessage omits provider_id and delivery_status, and a PostgREST
       upsert only writes the columns it is given, so that merge leaves both
       of them intact. */
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      client_id: clientId,
      stage: stage || 'custom',
      variant_key: variantId || 'custom',
      // The text as it actually went out, opt-out notice included. The
      // bandit is unaffected: stripOptOutNotice removes it before the
      // customization comparison, so a first message still logs against
      // its template rather than as a one-off.
      text: body,
      sent_at: new Date().toISOString(),
      responded: false,
      reviewed: false,
      channel: 'sms',
      provider_id: providerId,
      delivery_status: status,
    }]),
  });

  const loggedRow = logRes.ok ? (await logRes.json().catch(() => []))?.[0] : null;
  return json({
    ok: true, providerId: providerId, logged: logRes.ok,
    messageId: loggedRow?.id || null, from: fromLabel,
    /* The Mac route returns queued, and the UI has to say that rather than
       "sent". Nothing has left the building yet: the agent has not even seen
       this row. */
    route: route, status: status,
    // So the UI can say plainly that nothing reached a real phone.
    provider: providerName, real: real,
    /* What actually went out, so the browser logs the same string rather
       than recomputing the opt-out rule and risking a different answer. Its
       own upsert would otherwise overwrite this row's text with a version
       missing the notice, leaving the record disagreeing with the message. */
    sentText: body,
  });
});
