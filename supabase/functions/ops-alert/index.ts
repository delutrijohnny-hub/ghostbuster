// Tells the operator a customer is broken, before the customer does.
//
// Every sync failure so far was found because somebody eventually
// complained: a revoked Google grant, an expired refresh token, a calendar
// filter matching nothing. The product knew at the time and the knowledge
// died with the HTTP response. Across one team that is survivable; across
// fifty customers it is the whole support model.
//
// Deliberately quiet. It sends only when something is wrong, and says
// nothing at all when everything is healthy -- a daily "all fine" is noise,
// and noise is how people learn to ignore an alert that later matters.
//
// Runs on pg_cron. Reads ops_sync_health(), which is service-role only
// because it looks across every customer -- exactly what RLS exists to stop
// a signed-in user doing.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
// Who to tell, and who it comes from. Both settings rather than constants:
// the operator's address is not something to bake into source.
const OPS_ALERT_EMAIL = Deno.env.get('OPS_ALERT_EMAIL');
const OPS_ALERT_FROM = Deno.env.get('OPS_ALERT_FROM');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function rpc(name: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) throw new Error(`${name} failed: ${await res.text()}`);
  return await res.json();
}

type Row = {
  email: string;
  calendar_id: string;
  last_sync: string | null;
  hours_since_sync: number | null;
  consecutive_failures: number;
  last_error: string | null;
  last_error_at: string | null;
};

/* One line per broken connection, with the thing you would need to act on.
   Written to be read on a phone: who, how long, and why -- in that order,
   because "who" decides whether it matters and "why" decides what to do. */
function describe(rows: Row[]): string {
  const lines = rows.map((r) => {
    const who = `${r.email} (${r.calendar_id})`;
    const stale = r.last_sync === null
      ? 'has never synced'
      : `last synced ${r.hours_since_sync}h ago`;
    const fails = r.consecutive_failures > 0
      ? `, ${r.consecutive_failures} failed run${r.consecutive_failures === 1 ? '' : 's'}`
      : '';
    const why = r.last_error ? `\n    ${r.last_error}` : '';
    return `  - ${who}: ${stale}${fails}${why}`;
  });
  return [
    `${rows.length} calendar connection${rows.length === 1 ? ' is' : 's are'} not syncing.`,
    '',
    ...lines,
    '',
    'A connection stops syncing when the Google grant is revoked, the refresh',
    'token expires, or Google rejects the request. The customer sees an empty',
    'app and usually does not know why.',
  ].join('\n');
}

/* Write down what this run did, whatever it did.

   The reason this exists: the Resend key was invalid, so a live run returned
   502 with "API key is invalid" and nothing anywhere kept that. The cron
   fires and discards the response, so the alerter would have looked armed
   and stayed silent through a real outage.

   You cannot alert about a broken alerter down the channel that is broken.
   What you can do is leave a record, so "is the watchdog alive?" has an
   answer that does not depend on somebody having watched at the time.

   Failing to record must never fail the run -- if this throws, the alert
   itself has still been attempted, and that matters more. */
async function recordRun(row: { broken: number; armed: boolean; sent: boolean; error?: string }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ops_alert_runs`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        broken: row.broken, armed: row.armed, sent: row.sent,
        error: row.error ? String(row.error).slice(0, 400) : null,
      }),
    });
  } catch (_ignored) { /* see above */ }
}

Deno.serve(async (req) => {
  try {
    /* Authorised on the service-role key, like the calendar sync's cron, and
       BEFORE anything is read.

       My first version authorised only the live send and let a dry run
       through on the public anon key -- which meant anybody holding that key
       could list every customer whose sync was broken, with their email
       address and the error text. A reporting endpoint is still a data
       endpoint. The dryRun flag decides whether an email goes out, never who
       is allowed to ask. */
    const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (auth !== SERVICE_ROLE_KEY) {
      return json({ error: 'Not authorised.' }, 403);
    }

    let payload: Record<string, unknown> = {};
    try { payload = await req.clone().json(); } catch { /* no body is fine */ }
    // Reports what it WOULD send and mails nobody, so the message can be
    // checked without putting one in the operator's inbox.
    const dryRun = payload.dryRun === true;

    /* Whether this thing could actually deliver, reported on every run.

       Names and booleans only -- never the values. The healthy path returns
       before any send, so without this there is no way to find out that the
       alerting is misconfigured except by waiting for a real outage and
       watching it stay silent. The whole point of an alert is that you are
       not checking, so it has to be able to answer "are you armed?". */
    const configured = {
      RESEND_API_KEY: !!RESEND_API_KEY,
      OPS_ALERT_EMAIL: !!OPS_ALERT_EMAIL,
      OPS_ALERT_FROM: !!OPS_ALERT_FROM,
    };
    const armed = configured.RESEND_API_KEY && configured.OPS_ALERT_EMAIL && configured.OPS_ALERT_FROM;

    const rows = (await rpc('ops_sync_health')) as Row[];
    if (!Array.isArray(rows) || rows.length === 0) {
      // The healthy path, and the common one. Say nothing to the operator's
      // inbox; say plenty to whoever asked.
      await recordRun({ broken: 0, armed, sent: false });
      return json({ ok: true, broken: 0, sent: false, armed, configured,
                    note: 'Everything is syncing.' });
    }

    const text = describe(rows);
    if (dryRun) return json({ ok: true, broken: rows.length, sent: false, dryRun: true, armed, configured, text });

    if (!armed) {
      /* Reported rather than thrown. An alerting system that fails silently
         because it was half-configured is worse than none: it produces the
         feeling of being watched over without the fact of it. */
      await recordRun({ broken: rows.length, armed, sent: false,
                        error: 'not configured: missing ' +
                          Object.keys(configured).filter((k) => !configured[k as keyof typeof configured]).join(', ') });
      return json({
        ok: false, broken: rows.length, sent: false, code: 'not_configured',
        missing: Object.keys(configured).filter((k) => !configured[k as keyof typeof configured]),
        text,
      }, 503);
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: OPS_ALERT_FROM,
        to: [OPS_ALERT_EMAIL],
        subject: `Ghost Recall: ${rows.length} calendar connection${rows.length === 1 ? '' : 's'} not syncing`,
        text,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = body?.message || `provider returned ${res.status}`;
      await recordRun({ broken: rows.length, armed, sent: false, error: why });
      return json({ ok: false, broken: rows.length, sent: false, error: why }, 502);
    }
    await recordRun({ broken: rows.length, armed, sent: true });
    return json({ ok: true, broken: rows.length, sent: true, id: body?.id });
  } catch (e) {
    console.error('ops-alert failed', e);
    // Even a crash leaves a trace, or a run that died early is
    // indistinguishable from one that never happened.
    await recordRun({ broken: -1, armed: false, sent: false, error: String(e) });
    return json({ error: String(e) }, 500);
  }
});
