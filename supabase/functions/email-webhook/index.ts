// Receives delivery events and replies from the email provider.
//
// This is what makes email worth having as a channel. A text is handed to the
// salesperson's phone, so its reply is invisible and someone has to remember
// to record it — which is why reply logging sat at 4% for months before being
// rebuilt from the Mac Messages database. Mail GhostBuster sends is mail whose
// replies arrive here, and a reply that arrives here is one nobody has to log.
//
// Three things are handled:
//   bounced / complained   stop mailing that address, and mark the send so a
//                          failed delivery is not mistaken for being ignored
//   delivered              record it, so "sent but never arrived" is visible
//   inbound reply          mark the message answered, automatically
//
// Setup: point a Resend webhook at this URL and set RESEND_WEBHOOK_SECRET to
// the signing secret it gives you.

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET');

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
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // An unverified webhook is an open endpoint that can mark any contact as
  // having replied, or blacklist any address. Refusing outright when the
  // secret is missing is the only safe default — a webhook that trusts its
  // caller is worse than one that does not exist.
  if (!WEBHOOK_SECRET) {
    return json({ error: 'Webhook signing secret is not configured.' }, 503);
  }

  const raw = await req.text();
  let event: any;
  try {
    const wh = new Webhook(WEBHOOK_SECRET);
    event = wh.verify(raw, {
      'webhook-id': req.headers.get('webhook-id') || req.headers.get('svix-id') || '',
      'webhook-timestamp': req.headers.get('webhook-timestamp') || req.headers.get('svix-timestamp') || '',
      'webhook-signature': req.headers.get('webhook-signature') || req.headers.get('svix-signature') || '',
    });
  } catch (_e) {
    return json({ error: 'Signature did not verify.' }, 401);
  }

  const type: string = event?.type || '';
  const data = event?.data || {};
  const providerId: string | null = data?.email_id || data?.id || null;
  const toAddress: string | null = Array.isArray(data?.to) ? data.to[0] : (data?.to || null);
  const fromAddress: string | null = data?.from || null;

  /* A retried webhook must not be processed twice.

     Providers retry on a timeout or a 5xx, and the reply path below was not
     merely wasteful on a retry, it was WRONG. It marks "the most recent
     unanswered email to this contact" as replied. Run it again and the most
     recent unanswered email is now a different, older message -- so a second
     message gets credited with a reply that never happened, which inflates
     the reply rate and teaches the bandit that the wrong copy worked.

     (provider_id, kind) is the natural key: the same email id with the same
     event type is the same event, and a retry carries both unchanged. Two
     genuine replies from one person arrive as different email ids, and a
     delivered-then-bounced pair differs by kind, so neither collapses.

     Check-then-act leaves a small race if two retries land at the same
     instant. The migration adds a unique index that closes it properly; this
     check is what makes the function correct before that is run, and it is
     also what keeps the error path quiet afterwards. */
  if (providerId) {
    const seen = await db(
      `/email_events?provider_id=eq.${encodeURIComponent(providerId)}` +
      `&kind=eq.${encodeURIComponent(type)}&select=id&limit=1`);
    const prior = await seen.json().catch(() => []);
    if (Array.isArray(prior) && prior.length) {
      return json({ ok: true, handled: 'duplicate', note: 'already processed this event' });
    }
  }

  // Kept before anything is interpreted. Matching a reply to the message it
  // answers involves judgement, so the original payload stays available for
  // when an attribution turns out to be wrong.
  const stored = await db('/email_events', {
    method: 'POST',
    body: JSON.stringify([{
      provider_id: providerId, kind: type,
      to_address: toAddress, from_address: fromAddress, payload: event,
    }]),
  });
  // With the unique index in place a simultaneous retry loses this insert
  // rather than the check. Either way the second one stops here.
  if (!stored.ok && stored.status === 409) {
    return json({ ok: true, handled: 'duplicate', note: 'raced with another delivery' });
  }

  // --- delivery outcomes -------------------------------------------------
  if (type === 'email.delivered' || type === 'email.bounced' || type === 'email.complained') {
    const status = type === 'email.delivered' ? 'delivered'
                 : type === 'email.bounced' ? 'bounced' : 'complained';
    if (providerId) {
      await db(`/message_log?provider_id=eq.${encodeURIComponent(providerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ delivery_status: status }),
      });
    }
    // A bounce or a complaint is not a retry, it is a stop. Continuing to mail
    // a dead address is how a sending domain's reputation goes, which breaks
    // delivery for every other contact.
    if (toAddress && status !== 'delivered') {
      await db(`/clients?email=eq.${encodeURIComponent(toAddress)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          email_status: status === 'bounced' ? 'bounced' : 'complained',
          email_status_at: new Date().toISOString(),
        }),
      });
    }
    return json({ ok: true, handled: status });
  }

  // --- an actual reply ---------------------------------------------------
  if (type === 'email.inbound' || type === 'inbound.received' || type === 'email.replied') {
    if (!fromAddress) return json({ ok: true, handled: 'inbound', note: 'no sender address' });

    const cRes = await db(`/clients?email=eq.${encodeURIComponent(fromAddress)}&select=id,name`);
    const clients = await cRes.json();
    if (!Array.isArray(clients) || !clients.length) {
      // Someone not in the book. Logged above, ignored here — guessing at a
      // match would be worse than leaving it for a human to notice.
      return json({ ok: true, handled: 'inbound', note: 'sender not recognised' });
    }

    let marked = 0;
    for (const c of clients) {
      // The message being answered is the most recent unanswered email to that
      // contact. Anything cleverer — threading on subject, matching quoted
      // text — is guesswork, and attributing a reply to the wrong message
      // teaches the bandit the wrong lesson about which copy works.
      const mRes = await db(
        `/message_log?client_id=eq.${c.id}&channel=eq.email&responded=is.false` +
        `&order=sent_at.desc&limit=1&select=id`);
      const msgs = await mRes.json();
      if (!Array.isArray(msgs) || !msgs.length) continue;
      await db(`/message_log?id=eq.${msgs[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          responded: true,
          responded_at: new Date().toISOString(),
          // Reviewed too: a reply GhostBuster saw itself needs no human
          // confirmation, which is the entire point of this endpoint.
          reviewed: true,
        }),
      });
      marked++;
    }
    return json({ ok: true, handled: 'inbound', marked });
  }

  return json({ ok: true, handled: 'ignored', type });
});
