// Sends the follow-up emails that are due, without anyone opening the app.
//
// The cadence lives in logic.js and is SHARED here rather than reimplemented.
// parse.ts already shows the cost of a hand-maintained copy — its area-code
// table is a second source of truth. A third copy of computeDue would be far
// worse, because this one decides what gets sent to real people unattended.
//
// Dry run is the default. Every invocation reports exactly what it WOULD send
// unless explicitly told to send, so the whole path can be verified against
// real data without a single email leaving the building.
//
// Guardrails, in the order they apply:
//   - the org has switched on both email_enabled and auto_send_email
//   - the contact has an email address
//   - a touch is genuinely due (same computeDue the app uses)
//   - that touch has an email version
//   - nothing already sent to this person today
//   - it is a civil hour where THEY are
//   - a per-run cap, so a misconfiguration cannot empty an entire book

// A STATIC import, deliberately. createRequire looked equivalent and was not:
// the deploy bundler cannot trace a dynamic call, so it shipped this function
// without logic.js and every invocation died with WORKER_ERROR. logic.js
// assigns its exports to globalThis precisely so it can be imported this way.
import '../_shared/logic.js';
// deno-lint-ignore no-explicit-any
const GB = (globalThis as any).GBLogic;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const CRON_SECRET = Deno.env.get('CRON_SECRET');

// Sending at 3am reads as a machine even when the copy is good.
const SEND_FROM_HOUR = 8;
const SEND_TO_HOUR = 19;
const MAX_PER_RUN_PER_ORG = 25;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
}

function hourIn(tz: string, at: Date): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/New_York', hour: 'numeric', hour12: false,
    }).format(at));
  } catch { return 12; }   // an unknown zone should not block a send
}

async function sendViaResend(args: { from: string; to: string; subject: string; text: string; replyTo?: string }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: args.from, to: [args.to], subject: args.subject, text: args.text,
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false as const, error: body?.message || `provider returned ${res.status}` };
  return { ok: true as const, id: body?.id as string | undefined };
}

async function planForUser(settings: any, now: Date) {
  const userId = settings.user_id;

  const cRes = await db(`/clients?user_id=eq.${userId}&select=*,message_log(*)&limit=2000`);
  const rows = await cRes.json();
  if (!Array.isArray(rows)) return { userId, error: 'could not load contacts', planned: [] };

  // The engine's config is module-level in logic.js, so it has to be set per
  // org before computing and reset after — otherwise one business's pipeline
  // leaks into the next one in the loop.
  GB.setPipeline(settings.pipeline || null);
  GB.setSequence(settings.sequence || null);

  // The org's own email templates, keyed by stage.
  const vRes = await db(`/variants?user_id=eq.${userId}&channel=eq.email&select=stage,variant_key,subject,text,builtin`);
  const vRows = await vRes.json();
  const emailVariants: Record<string, any[]> = {};
  if (Array.isArray(vRows)) {
    for (const r of vRows) {
      (emailVariants[r.stage] = emailVariants[r.stage] || []).push({
        id: r.variant_key, subject: r.subject, text: r.text, builtin: !!r.builtin,
      });
    }
  }

  const planned: any[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] || 0) + 1; };

  for (const row of rows) {
    if (planned.length >= MAX_PER_RUN_PER_ORG) { skip('over the per-run cap'); continue; }

    const client = GB.sanitizeClient({
      id: row.id, name: row.name, phone: row.phone, email: row.email,
      youtubeLink: row.youtube_link, meetLink: row.meet_link,
      callDateTime: row.call_date_time, bookedDate: row.booked_date,
      timezone: row.timezone, status: row.status, notes: row.notes,
      closeOutcome: row.close_outcome, reschedules: row.reschedules,
      stalledSince: row.stalled_since, ignored: row.ignored,
      rebooked: row.rebooked, hadPriorCall: row.had_prior_call,
      messageLog: (row.message_log || []).map((m: any) => ({
        id: m.id, stage: m.stage, variantId: m.variant_key, text: m.text,
        sentAt: m.sent_at, responded: m.responded, respondedAt: m.responded_at,
        reviewed: m.reviewed, channel: m.channel,
      })),
    });

    if (client.ignored) { skip('archived'); continue; }
    // canEmail covers bounced and complained addresses too. Unattended sending
    // to a dead mailbox is exactly how a sending domain's reputation goes, and
    // by definition nobody is watching to notice.
    if (!GB.canEmail(client)) {
      skip(client.email ? 'address bounced or complained' : 'no email address');
      continue;
    }

    // computeDue already honours the reply pause and per-stage snoozes.
    const due = GB.computeDue(client, now);
    if (!due.length) continue;
    const stage = GB.pickTodaysTouch(due);

    // Anything sent today, by any channel or any person, means this contact
    // has already been contacted — automation must not add to that.
    const already = (client.messageLog || []).some((m: any) => {
      const t = Date.parse(m.sentAt);
      return !isNaN(t) && (now.getTime() - t) < 20 * 3600 * 1000;
    });
    if (already) { skip('already contacted today'); continue; }

    const hour = hourIn(client.timezone, now);
    if (hour < SEND_FROM_HOUR || hour >= SEND_TO_HOUR) { skip('outside their working hours'); continue; }

    // Only an email the business wrote itself. Falling back to a built-in
    // would mean software mailing its own words to someone's customers while
    // nobody is watching, which is not a thing to do on a person's behalf.
    const draft = GB.getAuthoredEmailDraft(
      { emailVariants: emailVariants }, client, stage, settings.sender_name || 'there');
    if (!draft) { skip('no email written for that touch yet'); continue; }

    planned.push({
      clientId: client.id, name: client.name, to: client.email,
      stage, variantId: draft.variantId, subject: draft.subject, text: draft.text,
    });
  }

  GB.setPipeline(null);
  GB.setSequence(null);
  return { userId, planned, skipped };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let payload: { dryRun?: boolean; userId?: string; secret?: string } = {};
  try { payload = await req.json(); } catch { /* an empty body means a dry run */ }

  // Sending is opt-in per call as well as per org: a caller has to ask for it
  // explicitly, so an accidental invocation reports instead of mailing.
  const dryRun = payload.dryRun !== false;

  // A live run is either the scheduler with the shared secret, or nothing.
  if (!dryRun && (!CRON_SECRET || payload.secret !== CRON_SECRET)) {
    return json({ error: 'A live run requires the scheduler secret.' }, 403);
  }
  if (!dryRun && !RESEND_API_KEY) {
    return json({ error: 'Email is not configured.', code: 'no_provider' }, 503);
  }

  // Email is a library now, not a cadence.
  //
  // The editor that produced these stage-keyed emails is gone: they were
  // written for five fixed touches, and email turned out to be documents sent
  // when the conversation calls for them. What is left is a trap — rows still
  // in `variants` that nothing can edit any more, which this function would
  // happily mail the day a provider key is configured. Software sending copy
  // its owner can no longer even see is not a thing to leave armed.
  //
  // Left in place rather than deleted: the scheduled job still calls it, a dry
  // run still reports what the old cadence WOULD have done, and if automatic
  // sending comes back it will be driven by the library.
  if (!dryRun) {
    return json({
      error: 'Automatic email sending is off. Email is a library you send from by hand — see the Emails tab.',
      code: 'library_not_cadence',
    }, 409);
  }

  const filter = payload.userId ? `&user_id=eq.${payload.userId}` : '';
  const sRes = await db(`/app_settings?email_enabled=eq.true&auto_send_email=eq.true${filter}&select=*`);
  const accounts = await sRes.json();
  if (!Array.isArray(accounts)) return json({ error: 'could not load settings' }, 500);
  if (!accounts.length) {
    return json({ dryRun, accounts: 0, note: 'No account has both email and automatic sending switched on.' });
  }

  const now = new Date();
  const results: any[] = [];

  for (const settings of accounts) {
    const plan = await planForUser(settings, now);
    if (dryRun) { results.push({ ...plan, wouldSend: plan.planned.length }); continue; }

    const from = settings.email_from_name
      ? `${settings.email_from_name} <${settings.email_from_address}>`
      : settings.email_from_address;
    if (!settings.email_from_address) {
      results.push({ userId: plan.userId, error: 'no sending address configured' });
      continue;
    }

    let sent = 0;
    const failures: string[] = [];
    for (const p of plan.planned) {
      const out = await sendViaResend({
        from, to: p.to, subject: p.subject, text: p.text,
        replyTo: settings.email_reply_to || undefined,
      });
      if (!out.ok) { failures.push(`${p.name}: ${out.error}`); continue; }
      // Logged the same shape a manual send produces, so the cadence advances
      // and every rate and stat counts it identically.
      await db('/message_log', {
        method: 'POST',
        body: JSON.stringify([{
          client_id: p.clientId, stage: p.stage, variant_key: p.variantId,
          text: `${p.subject}\n\n${p.text}`, sent_at: new Date().toISOString(),
          responded: false, reviewed: false, channel: 'email', provider_id: out.id || null,
        }]),
      });
      sent++;
    }
    results.push({ userId: plan.userId, sent, failures, skipped: plan.skipped });
  }

  return json({ dryRun, accounts: accounts.length, results });
});
