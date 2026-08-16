// The actual calendar sync. Two callers:
//  - The "Sync now" button in the app, which invokes this with the signed-in
//    user's own JWT — syncs only that user's connected calendars.
//  - The twice-daily cron schedule (see supabase/functions/README.md for the
//    cron.schedule() call), which invokes this with the service_role key —
//    no single-user JWT to resolve, so it syncs every user who has at least
//    one connected calendar.
//
// For each connected calendar (processed in priority order, lowest first —
// see the plan's note on john@marketmakermgmt.com taking priority over the
// personal Gmail when the same booking shows up on both): refresh the
// access token, pull events via the incremental syncToken when we have one
// (falling back to a bounded full-range scan on first sync or a 410 Gone),
// parse strategy-session bookings out of them, and upsert/reschedule-detect
// against Postgres — the same idempotent-on-google_event_id behavior
// commitImportedClients() already gives the .ics import path, just written
// against the DB instead of an in-memory object.

import { clientFromGCalEvent, type GCalEvent } from '../_shared/parse.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')!;

// Full-range scan window (first sync, or after a 410 Gone invalidates the
// syncToken): recent enough to catch a just-missed no-show follow-up, wide
// enough ahead to catch everything already booked.
const FULL_SCAN_PAST_DAYS = 7;
const FULL_SCAN_FUTURE_DAYS = 180;

function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function resolveTargetUserIds(req: Request, bodyUserId: string | null): Promise<string[]> {
  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');

  if (callerToken && callerToken !== SERVICE_ROLE_KEY) {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      if (user?.id) return [user.id];
    }
    // Token present but didn't resolve to a real user — don't silently fall
    // through to "sync everyone" for an unrecognized caller.
    throw new Error('Could not resolve caller identity from Authorization header');
  }

  // service_role caller: syncs everyone (cron), unless a specific userId was
  // passed in the body (the post-connect trigger in google-calendar-callback
  // uses this so a fresh connection doesn't force a full re-sync of every
  // other connected user).
  if (bodyUserId) return [bodyUserId];

  const res = await db('/google_oauth_tokens?select=user_id');
  if (!res.ok) throw new Error('Failed to list connected users: ' + (await res.text()));
  const rows: { user_id: string }[] = await res.json();
  return [...new Set(rows.map((r) => r.user_id))];
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Token refresh failed: ' + JSON.stringify(json));
  return json as { access_token: string; expires_in: number };
}

async function fetchAllEvents(accessToken: string, syncToken: string | null) {
  const events: GCalEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let needsFullResync = false;

  do {
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    if (syncToken && !needsFullResync) {
      params.set('syncToken', syncToken);
    } else {
      const now = Date.now();
      params.set('timeMin', new Date(now - FULL_SCAN_PAST_DAYS * 86400000).toISOString());
      params.set('timeMax', new Date(now + FULL_SCAN_FUTURE_DAYS * 86400000).toISOString());
      params.set('orderBy', 'startTime');
    }

    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 410 && syncToken && !needsFullResync) {
      // Sync token expired/invalidated — restart as a bounded full scan.
      needsFullResync = true;
      pageToken = undefined;
      events.length = 0;
      continue;
    }
    const json = await res.json();
    if (!res.ok) throw new Error('Calendar API error: ' + JSON.stringify(json));

    events.push(...(json.items || []));
    pageToken = json.nextPageToken;
    if (json.nextSyncToken) nextSyncToken = json.nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken };
}

async function syncOneCalendar(
  userId: string,
  conn: { calendar_id: string; refresh_token: string; sync_token: string | null },
  byEventId: Map<string, any>,
  byEmailTime: Map<string, any>
) {
  const { access_token, expires_in } = await refreshAccessToken(conn.refresh_token);
  await db(`/google_oauth_tokens?user_id=eq.${userId}&calendar_id=eq.${encodeURIComponent(conn.calendar_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token, token_expiry: new Date(Date.now() + expires_in * 1000).toISOString() }),
  });

  const { events, nextSyncToken } = await fetchAllEvents(access_token, conn.sync_token);

  let added = 0, updated = 0, rescheduled = 0, skippedDuplicate = 0;
  for (const ev of events) {
    if (ev.status === 'cancelled') continue;
    const parsed = clientFromGCalEvent(ev);
    if (!parsed) continue;

    const existingByEvent = byEventId.get(parsed.googleEventId);
    if (existingByEvent) {
      const patch: Record<string, unknown> = {
        name: parsed.name || existingByEvent.name,
        phone: parsed.phone || existingByEvent.phone,
        email: parsed.email || existingByEvent.email,
        youtube_link: parsed.youtubeLink || existingByEvent.youtube_link,
        meet_link: parsed.meetLink || existingByEvent.meet_link,
        organizer_email: parsed.organizerEmail,
        timezone: parsed.timezone,
        updated_at: new Date().toISOString(),
      };
      const oldTime = existingByEvent.call_date_time ? new Date(existingByEvent.call_date_time).getTime() : null;
      const newTime = parsed.callDateTime ? new Date(parsed.callDateTime).getTime() : null;
      if (oldTime && newTime && oldTime !== newTime) {
        const lastReschedule = (existingByEvent.reschedules || []).slice(-1)[0];
        const dupWindowMs = 90000;
        const isDup = lastReschedule && Math.abs(Date.now() - new Date(lastReschedule).getTime()) < dupWindowMs;
        if (!isDup) {
          patch.reschedules = [...(existingByEvent.reschedules || []), new Date().toISOString()];
          patch.reschedule_count = patch.reschedules.length;
          patch.stalled_since = existingByEvent.status !== 'Rescheduled' ? new Date().toISOString() : existingByEvent.stalled_since;
        }
        patch.call_date_time = parsed.callDateTime;
        patch.status = 'Confirmed';
        rescheduled++;
      }
      await db(`/clients?id=eq.${existingByEvent.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      updated++;
      continue;
    }

    // Cross-calendar dedup: same person, same call time, already imported
    // from a higher-priority calendar this run — don't create a duplicate.
    const emailTimeKey = parsed.email ? `${parsed.email.toLowerCase()}|${parsed.callDateTime}` : null;
    if (emailTimeKey && byEmailTime.has(emailTimeKey)) {
      skippedDuplicate++;
      continue;
    }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const insertRes = await db('/clients', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id,
        user_id: userId,
        google_event_id: parsed.googleEventId,
        organizer_email: parsed.organizerEmail,
        name: parsed.name, phone: parsed.phone, email: parsed.email,
        youtube_link: parsed.youtubeLink, meet_link: parsed.meetLink,
        call_date_time: parsed.callDateTime, booked_date: parsed.bookedDate,
        timezone: parsed.timezone, status: 'Booked',
        manually_added: false, snoozed_until: {},
      }),
    });
    if (!insertRes.ok) throw new Error('Insert client failed: ' + (await insertRes.text()));
    const [inserted] = await insertRes.json();
    byEventId.set(parsed.googleEventId, inserted);
    if (emailTimeKey) byEmailTime.set(emailTimeKey, inserted);
    added++;
  }

  await db(`/google_oauth_tokens?user_id=eq.${userId}&calendar_id=eq.${encodeURIComponent(conn.calendar_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sync_token: nextSyncToken, last_sync: new Date().toISOString() }),
  });

  return { added, updated, rescheduled, skippedDuplicate };
}

async function syncUserCalendars(userId: string) {
  const connRes = await db(`/google_oauth_tokens?user_id=eq.${userId}&order=priority.asc`);
  if (!connRes.ok) throw new Error('Failed to load connections: ' + (await connRes.text()));
  const connections = await connRes.json();

  const existingRes = await db(`/clients?user_id=eq.${userId}&select=*`);
  if (!existingRes.ok) throw new Error('Failed to load existing clients: ' + (await existingRes.text()));
  const existing = await existingRes.json();
  const byEventId = new Map(existing.filter((c: any) => c.google_event_id).map((c: any) => [c.google_event_id, c]));
  const byEmailTime = new Map(
    existing.filter((c: any) => c.email).map((c: any) => [`${c.email.toLowerCase()}|${c.call_date_time}`, c])
  );

  const perCalendar = [];
  for (const conn of connections) {
    try {
      const result = await syncOneCalendar(userId, conn, byEventId, byEmailTime);
      perCalendar.push({ calendar: conn.calendar_id, ...result });
    } catch (e) {
      perCalendar.push({ calendar: conn.calendar_id, error: String(e) });
    }
  }
  return { userId, calendars: perCalendar };
}

Deno.serve(async (req) => {
  try {
    let bodyUserId: string | null = null;
    try {
      const body = await req.clone().json();
      bodyUserId = typeof body?.userId === 'string' ? body.userId : null;
    } catch {
      // no/invalid JSON body — fine, means "sync everyone" for a service_role caller
    }
    const targetUserIds = await resolveTargetUserIds(req, bodyUserId);
    const results = [];
    for (const userId of targetUserIds) results.push(await syncUserCalendars(userId));
    return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Sync failed', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
