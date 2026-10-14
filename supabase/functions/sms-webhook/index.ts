// Receives inbound texts and delivery receipts from the SMS provider.
//
// This endpoint is the point of the whole channel. Every other path records a
// reply only if a salesperson remembers to say one arrived, and the evidence
// is that they do not: 67 sends since the review path was repaired, zero
// reviewed, while 43 review questions sit unanswered on the owner's own
// account. The prompt is visible and ignored. A reply that lands here needs
// nobody to log it.
//
// Setup: point the provider's inbound-message webhook at this URL, set
// TWILIO_AUTH_TOKEN to the account's auth token, and insert a row in
// org_phone_numbers for each number.

import { createHmac } from 'node:crypto';
// A STATIC import, deliberately: the deploy bundler cannot trace a dynamic
// createRequire, and shipped auto-send-email without logic.js once, so every
// invocation died with WORKER_ERROR. logic.js assigns its exports to
// globalThis precisely so it can be imported for the side effect.
import '../_shared/logic.js';
// deno-lint-ignore no-explicit-any
const GB = (globalThis as any).GBLogic;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');

function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/* Twilio signs the full request URL plus every POST parameter sorted by name
   and concatenated, HMAC-SHA1 under the auth token. Verifying it is what
   stops this being an open endpoint that can mark any contact as having
   replied -- or, worse, read back which contacts exist by watching what it
   matches. */
function signatureOk(url: string, params: Record<string, string>, given: string | null) {
  if (!given) return false;
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = createHmac('sha1', AUTH_TOKEN!).update(data, 'utf8').digest('base64');
  // Constant-time: a timing-distinguishable compare on a signature is a
  // slow oracle for forging one.
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Same reasoning as the email webhook: refusing outright when the secret is
  // absent is the only safe default. A webhook that trusts its caller is
  // worse than one that does not exist.
  if (!AUTH_TOKEN) return json({ error: 'Provider auth token is not configured.' }, 503);

  const raw = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });

  /* The signature covers the exact URL the provider called, so this has to
     reconstruct the PUBLIC url -- and inside the edge runtime req.url is not
     it. What arrives is:
         http://<ref>.supabase.co/sms-webhook
     with the scheme downgraded to http and the /functions/v1 prefix
     stripped by the proxy, while Twilio signed
         https://<ref>.supabase.co/functions/v1/sms-webhook
     Signing over req.url therefore rejects every genuine request, which from
     the outside looks exactly like "SMS is broken" rather than like a bug
     here. It was written that way first and every valid probe got a 401.
     There is no x-forwarded-host to lean on; x-forwarded-proto is present. */
  const inbound = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const derived = `${proto}://${inbound.host}/functions/v1${inbound.pathname}${inbound.search}`;
  // An explicit override for a custom domain or a proxy in front, where the
  // url Twilio was given cannot be derived from what arrives here. It must
  // match the webhook url in the Twilio console character for character.
  const url = Deno.env.get('SMS_WEBHOOK_URL') || derived;
  if (!signatureOk(url, params, req.headers.get('x-twilio-signature'))) {
    return json({ error: 'Signature did not verify.' }, 401);
  }

  const providerId = params.MessageSid || params.SmsSid || null;
  const fromPhone = params.From || null;
  const toPhone = params.To || null;
  const body = params.Body || '';
  // Inbound messages carry no MessageStatus; status callbacks do.
  const kind = params.MessageStatus ? `sms.${params.MessageStatus}` : 'sms.inbound';

  /* A retried webhook must not be processed twice. On the email side this was
     not merely wasteful, it was wrong: a second run credits whatever is NOW
     the most recent message, so a different send gets a reply that never
     happened, which inflates the reply rate and teaches the bandit that the
     wrong copy worked. The unique index on (provider_id, kind) closes the
     race; this check keeps the error path quiet. */
  if (providerId) {
    const seen = await db(`/sms_events?provider_id=eq.${encodeURIComponent(providerId)}` +
      `&kind=eq.${encodeURIComponent(kind)}&select=id&limit=1`);
    const prior = await seen.json().catch(() => []);
    if (Array.isArray(prior) && prior.length) {
      return json({ ok: true, handled: 'duplicate' });
    }
  }

  /* The receiving number is the tenant key, and this is the only thing
     keeping inbound matching inside one company. On the live book 107 phone
     numbers belong to contacts in MORE THAN ONE organization, because the
     same person booked with two different teams. Matching on the from-number
     alone would mark another company's contact as replied, and disclose --
     via the reply landing there -- that they are also somebody else's
     customer. An unrecognised To number matches nothing at all. */
  /* Which of the two numbers is OURS depends on the direction, and getting
     this wrong is not cosmetic. On an inbound text our number is To. On a
     status callback for a message we sent, our number is From and To is the
     contact -- so looking the org up by To sent every delivery receipt down
     the unknown-number path and delivery_status was never written at all.
     That is how it behaved when first deployed; the probe showed
     sms.delivered logged as 'the receiving number is not registered'. */
  const ourNumber = params.MessageStatus ? fromPhone : toPhone;
  let orgId: string | null = null;
  if (ourNumber) {
    const nRes = await db(
      `/org_phone_numbers?phone_number=eq.${encodeURIComponent(ourNumber)}&select=org_id&limit=1`);
    const nums = await nRes.json().catch(() => []);
    if (Array.isArray(nums) && nums.length) orgId = nums[0].org_id;
  }

  const record = async (extra: Record<string, unknown>) => {
    const res = await db('/sms_events', {
      method: 'POST',
      body: JSON.stringify([{
        provider_id: providerId, kind, from_phone: fromPhone,
        to_phone: toPhone, body, org_id: orgId, payload: params, ...extra,
      }]),
    });
    // With the unique index in place a simultaneous retry loses the insert
    // rather than the check above. Either way the second one stops here.
    return res.ok || res.status !== 409;
  };

  /* --- delivery receipts ------------------------------------------------
     Handled BEFORE the unregistered-number check, and deliberately. The
     provider_id is one we minted on our own outbound send, so patching by it
     cannot touch another org's row whether or not the number resolved -- and
     a receipt for a number that has since been released is still true about
     a message we sent. Refusing it would lose exactly the evidence that says
     'this text never arrived', which is the difference between a contact
     ignoring us and a carrier dropping us. */
  if (kind !== 'sms.inbound') {
    const status = params.MessageStatus === 'delivered' ? 'delivered'
                 : (params.MessageStatus === 'failed' || params.MessageStatus === 'undelivered')
                   ? 'bounced' : null;
    if (status && providerId) {
      await db(`/message_log?provider_id=eq.${encodeURIComponent(providerId)}`, {
        method: 'PATCH', body: JSON.stringify({ delivery_status: status }),
      });
    }
    /* A number the carrier could not reach is a wrong number, not a refusal,
       and it is recorded separately from an opt-out for that reason -- the
       two need different fixes. Marking it stops the cadence spending weeks
       texting a landline and reading the silence as disinterest, which is
       the same mistake email made before bounces were tracked.
       Deliberately NOT applied to an opt-out: only 'ok' is textable, so a
       contact who sent STOP must not be overwritten back to a textable
       state by a later receipt. */
    const failKey = status === 'bounced' && orgId ? GB.phoneKey(toPhone) : '';
    if (failKey.length >= 10) {
      await db(`/clients?org_id=eq.${orgId}&phone_key=eq.${encodeURIComponent(failKey)}` +
        `&sms_status=eq.ok`, {
        method: 'PATCH',
        body: JSON.stringify({ sms_status: 'undelivered', sms_status_at: new Date().toISOString() }),
      });
    }
    await record({ match_reason: orgId ? null : 'number not registered, receipt still applied' });
    return json({ ok: true, handled: kind, delivery: status });
  }

  if (!orgId) {
    // Logged with a null org, visible to service_role only: an unknown
    // number is not known to belong to anyone, so showing it to a team
    // would be a guess at whose it is.
    await record({ match_reason: 'the receiving number is not registered to an organization' });
    return json({ ok: true, handled: kind, note: 'unknown receiving number' });
  }

  /* --- opt-out, before anything else is read into the message ----------
     A STOP is not a reply and must not be attributed as one. Crediting it to
     the message that provoked it would teach the bandit that the copy worked,
     when what it actually did was lose the contact -- the exact inverse of
     the signal.

     It opts out EVERY row in this org carrying that number, not just the best
     match, because the person is the number: 424 of 830 contacts share theirs
     with another row, and leaving the duplicate textable would text someone
     who just asked us to stop. That is a TCPA violation and it is also what
     gets a 10DLC campaign filtered, which takes texting down for everyone
     else in the same stroke. */
  const keyword = GB.smsKeyword(body);
  if (keyword) {
    const key0 = GB.phoneKey(fromPhone);
    if (key0.length >= 10) {
      await db(`/clients?org_id=eq.${orgId}&phone_key=eq.${encodeURIComponent(key0)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sms_status: keyword === 'stop' ? 'opted_out' : 'ok',
          sms_status_at: new Date().toISOString(),
        }),
      });
    }
    await record({ match_reason: keyword === 'stop' ? 'opted out' : 'opted back in' });
    return json({ ok: true, handled: 'inbound', keyword });
  }

  // --- an actual reply ---------------------------------------------------
  /* Loaded as a state-shaped object so the SAME matchInboundReply the browser
     uses decides this. Two implementations of "which message did this answer"
     would drift, and the one that drifted would be the one nobody could test
     -- the rule here is subtle enough that it already had to be rewritten
     once, after the live data showed 424 of 830 contacts share a number. */
  const key = GB.phoneKey(fromPhone);
  let matched: any = { client: null, idx: -1, reason: 'unusable number' };
  if (key.length >= 10) {
    /* Matched on clients.phone_key, a generated column holding exactly what
       phoneKey() computes, indexed on (org_id, phone_key). The first version
       of this filtered `phone like '*5550100*'` on the raw text instead --
       520 of the 899 stored numbers are formatted, "(213) 555-0100", so the
       digits are not contiguous and it matched 383. It would have dropped
       57% of replies while appearing to work. */
    const cRes = await db(
      `/clients?org_id=eq.${orgId}&ignored=is.false` +
      `&phone_key=eq.${encodeURIComponent(key)}&select=id,name,phone,ignored`);
    const cands = await cRes.json().catch(() => []);
    const state: any = { clients: {} };
    if (Array.isArray(cands)) {
      for (const c of cands) {
        if (GB.phoneKey(c.phone) !== key) continue;
        const mRes = await db(
          `/message_log?client_id=eq.${encodeURIComponent(c.id)}&channel=eq.sms` +
          `&responded=is.false&select=id,sent_at&order=sent_at.desc&limit=50`);
        const msgs = await mRes.json().catch(() => []);
        state.clients[c.id] = {
          id: c.id, name: c.name, phone: c.phone, ignored: false,
          messageLog: (Array.isArray(msgs) ? msgs : []).map((m: any) =>
            ({ id: m.id, sentAt: m.sent_at, responded: false, reviewed: false })),
        };
      }
    }
    matched = GB.matchInboundReply(state, fromPhone, new Date());
  }

  if (!matched.client || matched.idx < 0) {
    await record({
      client_id: matched.client ? matched.client.id : null,
      match_reason: matched.reason,
    });
    return json({ ok: true, handled: 'inbound', note: matched.reason });
  }

  const msg = matched.client.messageLog[matched.idx];
  await db(`/message_log?id=eq.${encodeURIComponent(msg.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      responded: true,
      responded_at: new Date().toISOString(),
      // Reviewed too: a reply GhostBuster saw arrive needs no human
      // confirmation, which is the entire reason this endpoint exists.
      reviewed: true,
    }),
  });
  await record({ client_id: matched.client.id, message_id: msg.id, match_reason: null });
  return json({ ok: true, handled: 'inbound', client_id: matched.client.id, message_id: msg.id });
});
