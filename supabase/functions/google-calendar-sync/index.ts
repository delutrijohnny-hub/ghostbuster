// The actual calendar sync. Two callers:
//  - The "Sync now" button in the app, which invokes this with the signed-in
//    user's own JWT — syncs only that user's connected calendars.
//  - The cron schedule — three runs a day at 11:00, 16:00 and 21:00 UTC,
//    which is 7am, noon and 5pm US Eastern during EDT. The cron.schedule()
//    calls live in supabase/migrations — 20260803200000 for the first two,
//    20261002120000 for the 7am run. (This used to point at a
//    supabase/functions/README.md that has never existed.) This
//    invokes with the service_role key: no single-user JWT to resolve, so
//    it syncs every user who has at least one connected calendar. The 7am
//    run exists because the morning queue used to be built from the
//    previous day's 5pm sync, with nothing new arriving until noon — after
//    the morning calls had already been worked.
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

import { clientFromGCalEvent, collapseRecurringSeries, recurringSeriesKey,
         type CalendarFilter, type GCalEvent } from '../_shared/parse.ts';

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

/* One key for "this person, at this moment", however the time was written.

   This dedup was built two different ways and so never matched anything
   already in the database. The stored side came back from PostgREST as
   `2026-10-08T19:00:00+00:00`; the Google side was `start.dateTime` verbatim,
   `2026-10-08T14:00:00-05:00`. The same instant, two strings, no match — so
   the check only ever caught duplicates WITHIN a single run and was inert
   against every contact imported before it.

   Found by noticing one person booked twice in a team view: same email, same
   instant, two different calendar events, created on successive days.

   Normalised to an instant on both sides, so the comparison is about when the
   call is rather than how the clock was spelled. */
function emailTimeKey(email: string | null | undefined,
                      when: string | null | undefined): string | null {
  if (!email || !when) return null;
  const t = Date.parse(when);
  if (isNaN(t)) return null;
  return `${email.toLowerCase()}|${new Date(t).toISOString()}`;
}

async function syncOneCalendar(
  userId: string,
  conn: { calendar_id: string; refresh_token: string; sync_token: string | null },
  byEventId: Map<string, any>,
  byEmailTime: Map<string, any>,
  calendarFilter?: CalendarFilter,
  openStage = 'Booked',
) {
  const { access_token, expires_in } = await refreshAccessToken(conn.refresh_token);
  await db(`/google_oauth_tokens?user_id=eq.${userId}&calendar_id=eq.${encodeURIComponent(conn.calendar_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token, token_expiry: new Date(Date.now() + expires_in * 1000).toISOString() }),
  });

  const { events, nextSyncToken } = await fetchAllEvents(access_token, conn.sync_token);

  let added = 0, updated = 0, rescheduled = 0, skippedDuplicate = 0;
  // Counted so the app can tell "your filter excluded everything" apart from
  // "there was nothing on the calendar". Both used to surface as
  // "Synced: 0 new, 0 updated", which is how somebody sits in front of an
  // empty app for a week with no idea why.
  let scanned = 0, filteredOut = 0, collapsedRecurring = 0;

  /* A recurring series is one meeting, however many occurrences Google
     expands it into. Collapsing the batch handles a full scan, which arrives
     holding every occurrence at once. It is not enough on its own: an
     incremental sync delivers occurrences a few at a time, so the same series
     would still pile up across runs. Hence the second guard below, against
     the series already stored. */
  const keptEvents = collapseRecurringSeries(events, Date.now());
  collapsedRecurring = events.length - keptEvents.length;

  // Series already represented by a stored row, so a later run adds no more.
  const storedSeries = new Set<string>();
  for (const key of byEventId.keys()) {
    const series = recurringSeriesKey({ id: key } as GCalEvent);
    if (series) storedSeries.add(series);
  }

  for (const ev of keptEvents) {
    if (ev.status === 'cancelled') continue;
    scanned++;
    // conn.calendar_id is the address of the calendar being synced, i.e. the
    // account owner — which is how a colleague is told apart from a customer
    // when the organizer is on a personal inbox.
    const parsed = clientFromGCalEvent(ev, calendarFilter, conn.calendar_id);
    if (!parsed) { filteredOut++; continue; }

    const existingByEvent = byEventId.get(parsed.googleEventId);
    if (existingByEvent) {
      const patch: Record<string, unknown> = {
        name: parsed.name || existingByEvent.name,
        phone: parsed.phone || existingByEvent.phone,
        email: parsed.email || existingByEvent.email,
        youtube_link: parsed.youtubeLink || existingByEvent.youtube_link,
        meet_link: parsed.meetLink || existingByEvent.meet_link,
        organizer_email: parsed.organizerEmail,
        // Renaming an event in the calendar is a real edit, so the title
        // follows it. Falls back rather than nulling: a sync that somehow
        // reads an empty summary must not erase a title already recorded.
        event_title: parsed.eventTitle || existingByEvent.event_title || null,
        // Never overwrite an existing zone on re-sync: it may have been
        // corrected by hand in the client modal, and the app self-heals a
        // stale one from the area code on load anyway.
        timezone: existingByEvent.timezone || parsed.timezone,
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

    /* One row per series. Past this point we are about to create a contact,
       and a different occurrence of a series we already hold is not a new
       booking. The existing row stays on the occurrence it was created for
       rather than advancing — a standing meeting showing a slightly stale
       date is a far better outcome than a hundred of them. A real rebooking
       is a separate event with its own series key, so repeat business is
       untouched. */
    const series = recurringSeriesKey(ev);
    if (series && storedSeries.has(series)) { collapsedRecurring++; continue; }

    // Same person, same call time, already imported — don't create a second
    // row for it, whether it came from another calendar this run or from a
    // sync days ago.
    const etKey = emailTimeKey(parsed.email, parsed.callDateTime);
    if (etKey && byEmailTime.has(etKey)) {
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
        event_title: parsed.eventTitle || null,
        name: parsed.name, phone: parsed.phone, email: parsed.email,
        youtube_link: parsed.youtubeLink, meet_link: parsed.meetLink,
        call_date_time: parsed.callDateTime, booked_date: parsed.bookedDate,
        timezone: parsed.timezone, status: openStage,
        manually_added: false, snoozed_until: {},
      }),
    });
    if (!insertRes.ok) throw new Error('Insert client failed: ' + (await insertRes.text()));
    const [inserted] = await insertRes.json();
    byEventId.set(parsed.googleEventId, inserted);
    if (etKey) byEmailTime.set(etKey, inserted);
    if (series) storedSeries.add(series);
    added++;
  }

  await db(`/google_oauth_tokens?user_id=eq.${userId}&calendar_id=eq.${encodeURIComponent(conn.calendar_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sync_token: nextSyncToken, last_sync: new Date().toISOString() }),
  });

  return { added, updated, rescheduled, skippedDuplicate, scanned, filteredOut, collapsedRecurring };
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
    existing
      .map((c: any) => [emailTimeKey(c.email, c.call_date_time), c])
      .filter((pair: any) => pair[0] !== null)
  );

  // Which events count as bookings is per-organization. Loaded once per user
  // rather than per calendar, and left undefined when unset so parse.ts
  // applies its general default. It used to say "falls back to the legacy
  // rule" — one customer's event titles — which is what made three new
  // accounts in a row import nothing at all.
  let calendarFilter: CalendarFilter | undefined;
  /* Where a newly imported booking lands in THIS account's pipeline.

     It was the literal string 'Booked'. That is the default template's first
     stage and nobody else's: a recruiting account's pipeline runs Sourced ->
     Contacted -> Screen Scheduled, so every candidate the sync created arrived
     on a stage that account does not have. Harmless by luck — an unrecognised
     stage reads as 'open', so they still got followed up — but the contact
     showed a stage name absent from their own settings, which is the industry
     templates not actually working for the people they were built for.

     First stage carrying the 'open' role, which is the same rule the rest of
     the engine uses. Falls back to 'Booked' when there is no pipeline set,
     because that IS the default template's open stage. */
  let openStage = 'Booked';
  try {
    const sres = await db(`/app_settings?user_id=eq.${userId}&select=calendar_filter,pipeline`);
    const srow = (await sres.json())?.[0];
    if (srow?.calendar_filter) calendarFilter = srow.calendar_filter as CalendarFilter;
    const stages = Array.isArray(srow?.pipeline) ? srow.pipeline : [];
    const firstOpen = stages.find((st: any) => st && (st.role || 'open') === 'open' && st.key);
    if (firstOpen) openStage = String(firstOpen.key);
  } catch (_e) { /* use the general default rather than failing the sync */ }

  const perCalendar = [];
  for (const conn of connections) {
    try {
      const result = await syncOneCalendar(userId, conn, byEventId, byEmailTime, calendarFilter, openStage);
      perCalendar.push({ calendar: conn.calendar_id, ...result });
    } catch (e) {
      perCalendar.push({ calendar: conn.calendar_id, error: String(e) });
    }
  }
  return { userId, calendars: perCalendar };
}

// Called from the browser (the "Sync now" menu button) via supabase-js,
// which is a cross-origin fetch — the browser sends a CORS preflight
// OPTIONS request first. Without an explicit OPTIONS short-circuit here,
// that preflight fell through into the real sync logic below (bodyUserId
// null, no Authorization header on a preflight, so it resolved to "sync
// everyone") — meaning every browser-side sync attempt silently ran the
// full sync twice, once for the preflight and once for the real POST, and
// the missing CORS headers meant the browser blocked the real request's
// response from ever reaching the caller anyway.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
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
    return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  } catch (e) {
    console.error('Sync failed', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
});
