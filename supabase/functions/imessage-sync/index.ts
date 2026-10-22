// Receives client text conversations from the Mac Messages agent.
//
// Why this exists: Apple provides no way to read or send iMessage except from
// a Mac signed into that Apple ID, so the only software that can see these
// conversations is software running on the person's own machine. This is the
// door it pushes them through.
//
// ---------------------------------------------------------------------
// The thing that matters most here is what does NOT get uploaded
// ---------------------------------------------------------------------
// A Mac's Messages database is a person's whole life: 56,000 messages on the
// machine this was built against, overwhelmingly personal. None of that
// belongs in a CRM, and a sync that shipped everything and filtered later
// would have already done the damage by the time anybody noticed.
//
// So the filtering happens on the Mac, before anything leaves it. The agent
// asks this endpoint which phone numbers belong to clients ({action:
// 'numbers'}), and uploads only messages with those. Conversations with
// anybody else never travel.
//
// Auth is a device token: a long-lived credential created in the app, stored
// here only as a sha256 hash, shown to the person once. A browser session
// cannot be used -- it expires in an hour and nobody signs a background
// process in every morning.

/* logic.js for smsSendWindow, and for nothing else.
   The quiet-hours window is a product rule with a carrier behind it, and the
   one thing worse than not checking it here would be checking it with a
   second copy of the rule that drifts from the first. */
import '../_shared/logic.js';
const GB = (globalThis as any).GBLogic;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function phoneKey(raw: string) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'No device token' }, 401);

  const hash = await sha256Hex(token);
  const tRes = await db(
    `/device_tokens?token_hash=eq.${hash}&revoked_at=is.null&select=id,user_id&limit=1`);
  const tok = (await tRes.json().catch(() => []))?.[0];
  if (!tok) return json({ error: 'Device token not recognised' }, 401);

  // Useful on its own: "when did that Mac last check in" is how a dead agent
  // gets noticed, and how an unrecognised one does.
  await db(`/device_tokens?id=eq.${tok.id}`, {
    method: 'PATCH', body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  });

  const mRes = await db(`/memberships?user_id=eq.${tok.user_id}&select=org_id&limit=1`);
  const orgId = (await mRes.json().catch(() => []))?.[0]?.org_id;
  if (!orgId) return json({ error: 'No organisation for this user' }, 400);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  /* A queued send that must not go out, with the reason the person will read.
     Claimed at the same time so no later poll reconsiders it. */
  const fail = (id: string, why: string) =>
    db(`/message_log?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        delivery_status: 'failed', send_error: why,
        claimed_at: new Date().toISOString(),
      }),
    });

  /* The agent asks which numbers are worth uploading. This is the whole
     privacy design: it learns the client list and keeps everything else at
     home. */
  if (body?.action === 'numbers') {
    /* Each number carries the date from which its conversation is ours to
       read: the earliest moment that number became a contact here.

       Without it the agent swept in everything the Mac had ever held for that
       number, and the first real run filed somebody's 2023 group chat against
       a client. A booking made this year says nothing about a conversation
       from three years ago, and that history is personal. */
    const cRes = await db(
      `/clients?org_id=eq.${orgId}&ignored=is.false` +
      `&select=phone_key,created_at,booked_date&phone_key=not.is.null`);
    const clients = await cRes.json().catch(() => []);
    const earliest: Record<string, number> = {};
    if (Array.isArray(clients)) {
      for (const c of clients) {
        const k = c.phone_key || '';
        if (k.length !== 10) continue;
        // Whichever is earlier: when we first recorded them, or when the
        // booking was made. Both can predate the other depending on whether
        // the contact came from the calendar or was added by hand.
        const t = Math.min(
          Date.parse(c.created_at || '') || Infinity,
          Date.parse(c.booked_date || '') || Infinity);
        if (!isFinite(t)) continue;
        earliest[k] = Math.min(earliest[k] ?? Infinity, t);
      }
    }
    const numbers = Object.keys(earliest).map(k => ({
      key: k, since: new Date(earliest[k]).toISOString(),
    }));
    return json({ ok: true, numbers });
  }

  /* ------------------------------------------------------------------
     OUTBOX: texts the person typed in Ghost Recall, for this Mac to send.

     A row is ours to send when delivery_status is 'queued' AND provider_id
     is null. Both halves matter. 637 rows carry no provider_id and no
     status at all -- the old optimistic "Open in Messages" logs -- and
     re-sending those would text a chunk of the book a second time with
     messages from weeks ago. 'queued' is a state nothing else writes.

     claimed_at is stamped before the agent is told about a row, and only
     unclaimed rows are ever handed out. A run that dies between sending and
     reporting therefore loses the REPORT, not the message: the row stays
     claimed and is never sent twice. The regular sync picks the real message
     up out of chat.db afterwards and links it. A text sent twice cannot be
     taken back; a text whose status is late can.
     ------------------------------------------------------------------ */
  if (body?.action === 'outbox') {
    const qRes = await db(
      `/message_log?delivery_status=eq.queued&provider_id=is.null&claimed_at=is.null` +
      `&select=id,client_id,text,channel,sent_at&order=sent_at.asc&limit=50`);
    const queued = (await qRes.json().catch(() => [])) || [];
    if (!Array.isArray(queued) || !queued.length) {
      return json({ ok: true, sends: [], holding: 0, cancelled: 0 });
    }

    /* Scoped to THIS org by looking the contacts up rather than trusting the
       queue rows, which carry no org of their own. A device token for one
       org must never be handed another org's messages to send. */
    const ids = [...new Set(queued.map((r: any) => r.client_id))]
      .map((i) => `"${String(i).replace(/"/g, '')}"`).join(',');
    const cRes = await db(
      `/clients?id=in.(${ids})&org_id=eq.${orgId}&ignored=is.false` +
      `&select=id,name,phone,sms_status,timezone`);
    const cl = (await cRes.json().catch(() => [])) || [];
    const byId: Record<string, any> = {};
    if (Array.isArray(cl)) for (const c of cl) byId[c.id] = c;

    const sends: any[] = [];
    let holding = 0, cancelled = 0;

    for (const row of queued) {
      const c = byId[row.client_id];
      if (!c) continue;                  // another org's, or an ignored contact
      if (!c.phone) {
        await fail(row.id, 'That contact has no phone number.');
        cancelled++;
        continue;
      }

      /* An opt-out between typing and sending CANCELS the message. It does
         not wait, because there is no later time at which texting someone
         who replied STOP becomes acceptable. */
      if ((c.sms_status || 'ok') !== 'ok') {
        await fail(row.id, c.sms_status === 'opted_out'
          ? 'Not sent: they replied STOP after this was queued.'
          : 'Not sent: the carrier could not reach that number.');
        cancelled++;
        continue;
      }

      /* Outside 8am-9pm their time it HOLDS: left queued and unclaimed, so a
         later poll inside the window sends it. This is the case that needs
         re-checking here rather than only at the moment somebody pressed
         send -- a Mac asleep overnight wakes up holding a batch queued at
         8:50pm, and without this check it would deliver all of them at 7am. */
      const win = GB.smsSendWindow({ timezone: c.timezone || 'America/New_York' }, new Date());
      if (!win.ok) { holding++; continue; }

      /* The claim, guarded on claimed_at still being null. Two overlapping
         runs both read the same row above; only one of them gets it back
         here, and the other sends nothing. */
      const claim = await db(`/message_log?id=eq.${row.id}&claimed_at=is.null`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ claimed_at: new Date().toISOString() }),
      });
      const got = claim.ok ? ((await claim.json().catch(() => [])) || []) : [];
      if (!got.length) continue;         // somebody else claimed it first

      sends.push({
        id: row.id, phone: c.phone, name: c.name || '',
        body: row.text || '', channel: row.channel || 'sms',
      });
    }

    return json({ ok: true, sends, holding, cancelled });
  }

  /* ------------------------------------------------------------------
     DELIVERY_CHECK: rows still claiming only 'sent', for the Mac to look up.

     Delivery is not instant. Someone whose phone is off receives the message
     when it comes back on, and Apple flips is_delivered then -- long after
     the send loop has moved on. These rows are the ones with a guid to look
     up and no delivery confirmed yet.

     Two days, because a message undelivered after that is not going to be,
     and because this runs on a clock rather than on demand: an unbounded
     window would grow into a scan of the whole table every two minutes.
     ------------------------------------------------------------------ */
  if (body?.action === 'delivery_check') {
    const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const pRes = await db(
      `/message_log?delivery_status=eq.sent&provider_id=like.imsg:*&sent_at=gte.${since}` +
      `&select=id,provider_id,client_id&order=sent_at.desc&limit=200`);
    const rows = (await pRes.json().catch(() => [])) || [];
    if (!Array.isArray(rows) || !rows.length) return json({ ok: true, pending: [] });

    /* Scoped to this org the same way the outbox is, by looking the contacts
       up rather than trusting the rows. */
    const ids = [...new Set(rows.map((r: any) => r.client_id))]
      .map((i) => `"${String(i).replace(/"/g, '')}"`).join(',');
    const cRes = await db(`/clients?id=in.(${ids})&org_id=eq.${orgId}&select=id`);
    const mine = new Set(((await cRes.json().catch(() => [])) || []).map((c: any) => c.id));

    return json({
      ok: true,
      pending: rows.filter((r: any) => mine.has(r.client_id))
                   .map((r: any) => ({ id: r.id, providerId: r.provider_id })),
    });
  }

  /* ------------------------------------------------------------------
     SENT: what actually happened, reported by the Mac.

     The agent reads Apple's own columns back out of chat.db after sending --
     is_sent, is_delivered, error -- so these states are Apple's answer, not
     this product's hope. Where the message cannot be found again at all the
     row is marked 'sent' with no provider_id, which is honest: Messages took
     it and nothing has confirmed delivery. The ordinary sync links it later.
     ------------------------------------------------------------------ */
  if (body?.action === 'sent') {
    if (!Array.isArray(body?.results)) {
      return json({ error: 'Expected {action:\'sent\', results:[...]}' }, 400);
    }
    let updated = 0, rejected = 0;

    for (const r of body.results.slice(0, 100)) {
      const id = typeof r?.id === 'string' ? r.id : '';
      if (!id) { rejected++; continue; }

      /* The id came from this machine, so prove it is one of ours before
         writing to it. A device token is a long-lived credential and this
         endpoint can set delivery states. */
      const own = await db(
        `/message_log?id=eq.${id}&select=id,client_id,clients!inner(org_id)` +
        `&clients.org_id=eq.${orgId}&limit=1`);
      const ok = ((await own.json().catch(() => [])) || []).length;
      if (!ok) { rejected++; continue; }

      const patch: Record<string, unknown> = {};
      if (!r?.ok) {
        patch.delivery_status = 'failed';
        patch.send_error = String(r?.error || 'The Messages app would not send it.').slice(0, 300);
      } else if (Number(r?.errorCode || 0) !== 0) {
        patch.delivery_status = 'failed';
        patch.send_error = 'Messages reported error ' + Number(r.errorCode) + '.';
      } else {
        patch.delivery_status = r?.delivered ? 'delivered' : 'sent';
        patch.send_error = null;
        if (typeof r?.guid === 'string' && r.guid) patch.provider_id = 'imsg:' + r.guid;
        if (typeof r?.at === 'string' && r.at) patch.sent_at = r.at;
      }

      const up = await db(`/message_log?id=eq.${id}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      if (up.ok) updated++; else rejected++;
    }

    return json({ ok: rejected === 0, updated, rejected });
  }

  if (body?.action !== 'push' || !Array.isArray(body?.messages)) {
    return json({ error: "Expected {action:'numbers'|'outbox'|'sent'} or {action:'push', messages:[...]}" }, 400);
  }

  /* One lookup for the whole batch rather than per message. The agent sends a
     few hundred on a first run, and a round trip each would turn a sync into
     a visible pause. */
  const cRes = await db(
    `/clients?org_id=eq.${orgId}&ignored=is.false&select=id,phone_key,user_id`);
  const clients = await cRes.json().catch(() => []);
  const byKey: Record<string, any[]> = {};
  if (Array.isArray(clients)) {
    for (const c of clients) {
      const k = c.phone_key || '';
      if (k.length !== 10) continue;
      (byKey[k] = byKey[k] || []).push(c);
    }
  }

  let inbound = 0, outbound = 0, linked = 0, skipped = 0, failed = 0;
  let firstError = '';

  for (const m of body.messages.slice(0, 500)) {
    const key = phoneKey(m?.phone);
    const text = typeof m?.text === 'string' ? m.text.trim() : '';
    const guid = typeof m?.guid === 'string' ? m.guid : '';
    const at = typeof m?.at === 'string' ? m.at : '';
    if (key.length !== 10 || !text || !guid || !at) { skipped++; continue; }

    const hits = byKey[key] || [];
    if (!hits.length) { skipped++; continue; }
    /* Their own client wins when a number appears on more than one row -- on
       this book 424 of 830 contacts share a number with a duplicate, and the
       agent runs on one person's machine, so their own row is the one these
       messages belong to. */
    const client = hits.find((c: any) => c.user_id === tok.user_id) || hits[0];
    const providerId = 'imsg:' + guid;

    if (m.fromMe) {
      /* A text this person sent from their own phone.

         Ghost Recall may already know about it: clicking "Open in Messages"
         logs the send optimistically, before the message exists. Inserting
         again would double every send that went out through the app -- and
         297 duplicate rows have already inflated every reply figure in this
         product once. So an existing unlinked row with the same words at
         about the same time is ADOPTED rather than duplicated. */
      const seen = await db(
        `/message_log?provider_id=eq.${encodeURIComponent(providerId)}&select=id&limit=1`);
      if (((await seen.json().catch(() => [])) || []).length) { skipped++; continue; }

      const t = Date.parse(at);
      const lo = new Date(t - 20 * 60000).toISOString();
      const hi = new Date(t + 20 * 60000).toISOString();
      const near = await db(
        `/message_log?client_id=eq.${encodeURIComponent(client.id)}&channel=eq.sms` +
        `&provider_id=is.null&sent_at=gte.${lo}&sent_at=lte.${hi}&select=id,text`);
      const candidates = (await near.json().catch(() => [])) || [];
      const norm = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const match = candidates.find((r: any) => norm(r.text) === norm(text));

      if (match) {
        await db(`/message_log?id=eq.${match.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ provider_id: providerId, delivery_status: 'delivered' }),
        });
        linked++;
      } else {
        const ins = await db('/message_log', {
          method: 'POST',
          body: JSON.stringify([{
            client_id: client.id,
            // Not a cadence touch: it was typed in Messages, so it is nobody's
            // template and must not move any template's numbers.
            stage: 'custom', variant_key: 'custom',
            text, sent_at: at, responded: false, reviewed: false,
            channel: 'sms', provider_id: providerId, delivery_status: 'delivered',
          }]),
        });
        /* The response is READ, not assumed.

           The first version counted this as a success without looking, and
           every one of these was being rejected by a check constraint that
           did not allow stage 'custom'. The agent reported "388 texts you
           sent" and wrote nothing. A silent write failure that reports
           success is worse than a loud one, because the numbers it produces
           look real. */
        if (ins.ok) {
          outbound++;
        } else {
          failed++;
          if (!firstError) firstError = (await ins.text().catch(() => '')).slice(0, 200);
        }
      }
      continue;
    }

    // A reply. Same shape the Twilio webhook writes, so the conversation view
    // and the inbox do not need to know where it came from.
    const ins = await db('/sms_events', {
      method: 'POST',
      body: JSON.stringify([{
        provider_id: providerId, kind: 'sms.inbound',
        from_phone: m.phone || '', to_phone: null, body: text,
        org_id: orgId, client_id: client.id, match_reason: null,
        payload: { source: 'imessage-agent', service: m.service || null },
        created_at: at,
      }]),
    });
    if (!ins.ok) {
      // 409 is a duplicate, which is expected on a re-run. Anything else is a
      // real failure and must be reported rather than counted as a success.
      if (ins.status === 409) { skipped++; continue; }
      failed++;
      if (!firstError) firstError = (await ins.text().catch(() => '')).slice(0, 200);
      continue;
    }
    inbound++;

    /* Mark what it answered: the most recent unanswered text before it. Same
       rule as the Twilio path, and reviewed too -- a reply the system saw
       arrive needs no human confirmation, which is the entire point. */
    const prior = await db(
      `/message_log?client_id=eq.${encodeURIComponent(client.id)}&channel=eq.sms` +
      `&responded=is.false&sent_at=lte.${encodeURIComponent(at)}` +
      `&order=sent_at.desc&limit=1&select=id`);
    const pm = ((await prior.json().catch(() => [])) || [])[0];
    if (pm) {
      await db(`/message_log?id=eq.${pm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          responded: true, responded_at: at, reviewed: true,
        }),
      });
    }
  }

  return json({ ok: failed === 0, inbound, outbound, linked, skipped, failed,
                error: firstError || undefined });
});
