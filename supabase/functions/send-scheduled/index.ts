// Sends the texts that were queued for now.
//
// Run by pg_cron every few minutes. Its job is not to send things -- it is to
// decide, for each queued message, whether sending is still the right thing to
// do, and then send the ones that pass.
//
// That ordering is the point. Everything that makes a text unwise can change
// between queueing it and its moment arriving, and all of it changes in the
// direction of "do not send": they reply, they text STOP, somebody pauses
// follow-ups, the appointment is cancelled, the number turns out to be dead.
// A runner that trusted the decision made at schedule time would chase
// somebody who answered an hour ago, which is worse than having no scheduling
// at all, because they trusted it.
//
// Authorised with the service-role key from the vault, like the other crons.

import '../_shared/logic.js';
// deno-lint-ignore no-explicit-any
const GB = (globalThis as any).GBLogic;
import { providerFor } from '../_shared/providers.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');

// How many to take in one pass. A cap rather than a page: if a backlog ever
// builds up it is better to work through it over several runs than to hold one
// request open long enough to be killed halfway.
const BATCH = 50;

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

async function resolve(id: string, fields: Record<string, unknown>) {
  await db(`/scheduled_messages?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved_at: new Date().toISOString(), ...fields }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  /* Service-role only. This can send messages to customers, so it must not be
     reachable with the public anon key -- the same mistake was made once in
     ops-alert, where a dry-run path exposed every broken customer's email. */
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!auth || auth !== SERVICE_KEY) {
    return json({ error: 'Not authorised' }, 401);
  }

  const now = new Date();
  const dueRes = await db(
    `/scheduled_messages?status=eq.pending&send_at=lte.${encodeURIComponent(now.toISOString())}` +
    `&order=send_at.asc&limit=${BATCH}` +
    `&select=id,client_id,org_id,user_id,body,send_at`);
  const due = await dueRes.json().catch(() => []);
  if (!Array.isArray(due) || !due.length) {
    return json({ ok: true, considered: 0, sent: 0, cancelled: 0, held: 0, failed: 0 });
  }

  let sent = 0, cancelled = 0, held = 0, failed = 0;

  for (const row of due) {
    /* The contact as it is NOW, with its replies and its pause -- not as it
       was when this was queued. Everything below reads from this. */
    const cRes = await db(
      `/clients?id=eq.${encodeURIComponent(row.client_id)}` +
      `&select=id,name,phone,phone_key,timezone,status,ignored,sms_status,` +
      `automation_paused_until,org_id,user_id`);
    const c = (await cRes.json().catch(() => []))?.[0];
    if (!c) { await resolve(row.id, { status: 'cancelled', reason: 'the contact no longer exists' }); cancelled++; continue; }

    // Replies decide whether a follow-up should still go, so they have to be
    // loaded rather than assumed absent.
    const mRes = await db(
      `/message_log?client_id=eq.${encodeURIComponent(row.client_id)}&channel=eq.sms` +
      `&order=sent_at.desc&limit=30&select=id,sent_at,responded,responded_at,reviewed,channel`);
    const msgs = await mRes.json().catch(() => []);

    const client = GB.sanitizeClient({
      id: c.id, name: c.name, phone: c.phone || '', timezone: c.timezone,
      status: c.status, ignored: !!c.ignored, smsStatus: c.sms_status || 'ok',
      automationPausedUntil: c.automation_paused_until || null,
      messageLog: (Array.isArray(msgs) ? msgs : []).map((m: any) => ({
        id: m.id, stage: 'welcome', variantId: 'custom', channel: m.channel || 'sms',
        text: '', sentAt: m.sent_at, responded: !!m.responded,
        respondedAt: m.responded_at, reviewed: !!m.reviewed,
      })),
    });

    /* One decision, shared with the browser. scheduledSendCheck lives in
       logic.js so the rule a person sees in the app and the rule this applies
       at 9am tomorrow are literally the same code. */
    const verdict = GB.scheduledSendCheck(client, now);

    if (!verdict.ok) {
      if (verdict.hold) {
        /* Quiet hours: the content is still wanted, just not at 3am. Left
           pending so the next run picks it up once the window opens, rather
           than cancelled -- cancelling would throw away a message somebody
           meant to send. */
        held++;
        continue;
      }
      await resolve(row.id, { status: 'cancelled', reason: verdict.reason });
      cancelled++;
      continue;
    }

    // The sender's own number, same preference rule as send-sms.
    const nRes = await db(
      `/org_phone_numbers?org_id=eq.${row.org_id}&status=eq.registered` +
      `&or=(user_id.eq.${row.user_id},user_id.is.null)` +
      `&select=phone_number,provider,user_id&order=user_id.asc.nullslast&limit=1`);
    const num = (await nRes.json().catch(() => []))?.[0];
    if (!num?.phone_number) {
      await resolve(row.id, { status: 'cancelled', reason: 'no registered texting number' });
      cancelled++;
      continue;
    }

    const picked = providerFor(num.provider, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN });
    if (!picked.provider) {
      await resolve(row.id, { status: 'failed', reason: picked.error });
      failed++;
      continue;
    }

    const body = GB.withOptOutNotice(row.body, client);
    const result = await picked.provider.send({
      from: num.phone_number,
      to: '+1' + GB.phoneKey(client.phone),
      body,
      statusCallback: `${SUPABASE_URL}/functions/v1/sms-webhook`,
    });

    if (!result.ok) {
      await resolve(row.id, { status: 'failed', reason: result.error });
      failed++;
      continue;
    }

    const logRes = await db('/message_log', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        client_id: row.client_id,
        stage: 'custom', variant_key: 'custom',
        text: body, sent_at: new Date().toISOString(),
        responded: false, reviewed: false, channel: 'sms',
        provider_id: result.id || null,
        delivery_status: result.status || 'queued',
      }]),
    });
    const logged = logRes.ok ? (await logRes.json().catch(() => []))?.[0] : null;

    await resolve(row.id, {
      status: 'sent', reason: null,
      message_log_id: logged?.id || null, provider_id: result.id || null,
    });
    sent++;
  }

  return json({ ok: true, considered: due.length, sent, cancelled, held, failed });
});
