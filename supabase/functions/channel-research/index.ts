/* Reads a contact's YouTube channel, and caches what it read.
 *
 * 987 of the 1,058 contacts on this book have a channel link and 2 have a
 * note. For a business that sells YouTube help to realtors, what the channel
 * is doing IS the qualifying conversation -- somebody who posted weekly until
 * August and stopped has a different call from somebody shipping twice a week.
 *
 * ONLY THE OFFICIAL API, and only public data. No scraping, no HTML parsing,
 * no pretending to be a browser. Zillow was asked for and is not here for
 * exactly this reason: it has no public API for agent profiles and its terms
 * forbid scraping, so the honest answer was to say so rather than build
 * something that breaks the first time their markup changes.
 *
 * The key never reaches the browser, which is the whole reason this is a
 * function rather than a fetch from the page.
 *
 * WHAT COMES BACK IS UNTRUSTED DATA. Video titles are written by whoever owns
 * the channel. Nothing here interprets them, nothing executes them, and no
 * model sees them -- the reading is arithmetic in logic.js (channelSignals),
 * and the questions it produces each carry the number they came from. A title
 * saying "ignore previous instructions" is stored and displayed as a title.
 */
import '../_shared/logic.js';
const GB = (globalThis as any).GBLogic;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const YOUTUBE_API_KEY = Deno.env.get('YOUTUBE_API_KEY') || '';

const YT = 'https://www.googleapis.com/youtube/v3';
/* Deadlines on every outbound call, for the reason gemini-draft records: a
   fetch with no timeout hangs until the worker is reclaimed, and the button
   sits there saying nothing. */
const YT_TIMEOUT_MS = 15000;
const SUPABASE_TIMEOUT_MS = 10000;

/* How many recent uploads to read. 25 is one page, so one quota unit, and
   more than channelSignals needs for a cadence (it samples 20). */
const VIDEO_PAGE = 25;
/* A cached read older than this is refetched. A channel does not change much
   in a day, and the quota is 10,000 units against ~3 per contact. */
const FRESH_HOURS = 24;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function yt(path: string, params: Record<string, string>) {
  const q = new URLSearchParams({ ...params, key: YOUTUBE_API_KEY });
  const res = await fetch(`${YT}/${path}?${q}`, {
    signal: AbortSignal.timeout(YT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    /* The quota message is worth passing through: it is the one failure here
       that is neither the rep's fault nor transient, and "try again" would be
       wrong advice for it. */
    const quota = /quota/i.test(detail);
    throw Object.assign(new Error(quota ? 'quota' : `youtube ${res.status}`), {
      status: res.status, quota,
    });
  }
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerToken}` },
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  }).catch(() => null);
  /* A check that could not be made is not a caller who failed it. Refuses
     either way, but does not send somebody off to re-authenticate because
     the auth service was slow. */
  if (!userRes) {
    return json({ error: 'Could not check who you are just now. Try again.' }, 503);
  }
  const who = userRes.ok ? await userRes.json().catch(() => null) : null;
  const userId = who?.id;
  if (!userId) return json({ error: 'Not signed in' }, 401);

  if (!YOUTUBE_API_KEY) {
    /* Named precisely, because this is an operator's job and nobody else can
       do anything about it. Degrading silently to "no research available"
       would send a rep hunting for a broken link that is fine. */
    return json({
      error: 'No YouTube key is configured for this project, so channels cannot be read. '
           + 'The brief still works from your own records.',
      code: 'no_key',
    }, 503);
  }

  const body = await req.json().catch(() => null);
  const clientId = String(body?.clientId || '');
  const refresh = body?.refresh === true;
  if (!clientId) return json({ error: 'Which contact?' }, 400);

  /* Read as the CALLER, so RLS decides whether they may see this contact at
     all. The function holds no service-role key; a contact somebody is not
     allowed to open cannot be researched by asking this instead. */
  const asCaller = (path: string, init: RequestInit = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${callerToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });

  const cRes = await asCaller(
    `clients?id=eq.${encodeURIComponent(clientId)}&select=id,name,youtube_link,org_id`
  ).catch(() => null);
  const client = cRes && cRes.ok ? (await cRes.json().catch(() => []))?.[0] : null;
  /* 404 rather than 403: RLS already hid it, and telling somebody a contact
     exists but is not theirs is itself a disclosure. */
  if (!client) return json({ error: 'That contact is not available to you.' }, 404);

  // ---- the cache -----------------------------------------------------------
  const cacheRes = await asCaller(
    `client_research?client_id=eq.${encodeURIComponent(clientId)}&source=eq.youtube` +
    `&select=payload,error,fetched_at`
  ).catch(() => null);
  const cached = cacheRes && cacheRes.ok
    ? (await cacheRes.json().catch(() => []))?.[0] : null;

  if (cached && !refresh) {
    const age = (Date.now() - Date.parse(cached.fetched_at)) / 3600000;
    if (isFinite(age) && age < FRESH_HOURS) {
      return json({
        ok: !cached.error, cached: true, fetchedAt: cached.fetched_at,
        error: cached.error || null, channel: cached.payload || null,
      });
    }
  }

  // ---- resolve the channel -------------------------------------------------
  const ref = GB.youtubeChannelRef(client.youtube_link);
  async function remember(payload: unknown, error: string | null) {
    /* Upsert on (client_id, source): a refresh replaces rather than stacks.
       The history of somebody's subscriber count is not something this
       product has a use for. */
    await asCaller('client_research?on_conflict=client_id,source', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        client_id: clientId, source: 'youtube', org_id: client.org_id,
        user_id: userId, payload, error, fetched_at: new Date().toISOString(),
      }),
    }).catch(() => null);
  }

  if (!ref) {
    const why = client.youtube_link
      ? 'That YouTube link does not point at a channel, so there is nothing to read. '
        + 'Seven links on this book are search-result pages; fix the link on the contact.'
      : 'No YouTube channel is on file for this contact.';
    await remember(null, why);
    return json({ ok: false, error: why, code: 'no_channel' });
  }
  if (ref.kind === 'legacy') {
    /* /c/ and /user/ custom URLs have no direct lookup; finding them costs a
       search call at 100 units against 3 for everything else. Not worth it
       for a handful of rows, and guessing is worse than saying so. */
    const why = 'That is an old-style YouTube URL, which cannot be looked up directly. '
              + 'Open the channel and copy its @handle onto the contact.';
    await remember(null, why);
    return json({ ok: false, error: why, code: 'legacy_url' });
  }

  try {
    const lookup = ref.kind === 'handle'
      ? { forHandle: ref.value } : { id: ref.value };
    const chRes = await yt('channels', {
      part: 'snippet,statistics,contentDetails', ...lookup,
    });
    const ch = chRes?.items?.[0];
    if (!ch) {
      const why = 'That channel could not be found. It may have been renamed or removed.';
      await remember(null, why);
      return json({ ok: false, error: why, code: 'not_found' });
    }

    const uploads = ch.contentDetails?.relatedPlaylists?.uploads || '';
    let videos: unknown[] = [];
    if (uploads) {
      const pl = await yt('playlistItems', {
        part: 'snippet,contentDetails', playlistId: uploads,
        maxResults: String(VIDEO_PAGE),
      });
      const ids = (pl?.items || [])
        .map((i: any) => i?.contentDetails?.videoId).filter(Boolean);
      /* Views and duration need a second call; the playlist does not carry
         them. One request for all 25, so one quota unit. */
      const stats: Record<string, any> = {};
      if (ids.length) {
        const vs = await yt('videos', {
          part: 'statistics,contentDetails', id: ids.join(','),
        });
        (vs?.items || []).forEach((v: any) => { stats[v.id] = v; });
      }
      videos = (pl?.items || []).map((i: any) => {
        const id = i?.contentDetails?.videoId;
        const st = id ? stats[id] : null;
        return {
          id,
          title: i?.snippet?.title || '',
          publishedAt: i?.contentDetails?.videoPublishedAt || i?.snippet?.publishedAt || null,
          views: st?.statistics?.viewCount != null ? Number(st.statistics.viewCount) : null,
          duration: st?.contentDetails?.duration || null,
        };
      }).filter((v: any) => v.id && v.publishedAt);
    }

    const payload = {
      source: 'youtube',
      channelId: ch.id || '',
      handle: ch.snippet?.customUrl || (ref.kind === 'handle' ? ref.value : ''),
      title: ch.snippet?.title || '',
      url: ref.url,
      /* hiddenSubscriberCount is YouTube's own flag. The count it does give
         is rounded to three significant figures, which channelSignals says
         out loud rather than printing as though it were exact. */
      subscribers: ch.statistics?.hiddenSubscriberCount
        ? null
        : (ch.statistics?.subscriberCount != null ? Number(ch.statistics.subscriberCount) : null),
      subscribersHidden: !!ch.statistics?.hiddenSubscriberCount,
      totalViews: ch.statistics?.viewCount != null ? Number(ch.statistics.viewCount) : null,
      videoCount: ch.statistics?.videoCount != null ? Number(ch.statistics.videoCount) : null,
      videos,
      fetchedAt: new Date().toISOString(),
    };

    await remember(payload, null);
    return json({ ok: true, cached: false, channel: payload, fetchedAt: payload.fetchedAt });
  } catch (e) {
    const quota = (e as any)?.quota === true;
    const why = quota
      ? 'The YouTube daily quota is spent. Channels will read again tomorrow; '
        + 'the brief still works from your own records.'
      : 'Could not read that channel just now.';
    /* A quota failure is NOT cached: it is about today, not about this
       channel, and remembering it would keep the contact blank until somebody
       forced a refresh. */
    if (!quota) await remember(null, why);
    return json({ ok: false, error: why, code: quota ? 'quota' : 'fetch_failed' },
                 quota ? 429 : 502);
  }
});
