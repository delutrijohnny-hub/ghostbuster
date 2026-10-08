// Ported from logic.js's stripHtml/extractPhone/extractYoutube/extractMeetLink
// and clientFromICSEvent — kept in sync by hand since Deno Edge Functions
// can't easily import a browser-style global-scope script. If those change
// in logic.js, mirror the change here too.
//
// Calendar API events are already plain fields, so no VEVENT unfolding is
// needed here. What this file used to assume — that event.start.timeZone is
// "the authoritative timezone straight from Google" — was wrong: that field is
// the ORGANISER's calendar zone, not the client's. Every synced client
// therefore inherited our own zone (or Asia/Kolkata, from events a teammate
// abroad created) and their texts quoted the call in the wrong time. The area
// code is the better signal and is what the rest of the app already uses.

const PHONE_RE = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Mirrors AREA_CODE_TZ in logic.js. If you change one, change the other.
const AREA_CODE_TZ: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  const add = (codes: string[], zone: string) => codes.forEach((c) => (m[c] = zone));
  add(['203','475','860','959','302','202','305','321','352','386','407','561','689','754','772','786','813','863','904','941','954',
       '229','404','470','478','678','706','762','770','912','260','317','463','574','765','812','930',
       '502','606','859','207','240','301','410','443','667','339','351','413','508','617','774','781','857','978',
       '231','248','269','313','517','586','616','679','734','810','906','603','201','551','609','732','848','856','862','908','973',
       '212','315','332','347','516','518','585','607','631','646','680','716','718','838','845','914','917','929','934',
       '252','336','704','743','828','910','919','980','984','216','220','234','283','330','380','419','440','513','567','614','740','937',
       '239','727','947','656',
       '215','223','267','272','412','484','570','610','717','724','814','878','401','803','839','843','854','864',
       '423','865','802','276','434','540','571','703','757','804','826','948','304','681'], 'America/New_York');
  add(['219','205','251','256','334','938','479','501','870','850','217','224','309','312','331','618','630','708','773','779','815','847','872',
       '319','515','563','641','712','316','620','785','913','270','364','225','318','337','504','985',
       '218','320','507','612','651','763','952','228','601','662','769','314','417','573','636','660','816','975',
       '402','531','308','701','405','539','572','580','918','605','615','629','731','901','931',
       '214','254','281','325','346','361','409','430','432','469','512','682','713','737','806','817','830','832','903','936','940','956','972','979',
       '262','414','534','608','715','920'], 'America/Chicago');
  add(['915','303','719','720','970','406','505','575','385','435','801','307','208','986'], 'America/Denver');
  add(['480','520','602','623','928'], 'America/Phoenix');
  add(['907'], 'America/Anchorage');
  add(['808'], 'Pacific/Honolulu');
  add(['209','213','279','310','323','341','408','415','424','442','510','530','559','562','619','626','628','650','657','661','669',
       '707','714','747','760','805','818','820','831','840','858','909','916','925','949','951',
       '702','725','775','458','503','541','971','206','253','360','425','509','564'], 'America/Los_Angeles');
  return m;
})();

export function timezoneForPhone(phone: string): string | null {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length < 10) return null;
  return AREA_CODE_TZ[digits.slice(0, 3)] || null;
}

export function stripHtml(text: string | null | undefined): string {
  return String(text || '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
export function extractPhone(text: string | null | undefined): string {
  const m = String(text || '').match(PHONE_RE);
  return m ? m[0].trim() : '';
}
export function extractYoutube(text: string | null | undefined): string {
  const m = String(text || '').match(/https?:\/\/(www\.)?youtube\.com\/[^\s)"'<]+/i);
  return m ? m[0] : '';
}
export function extractMeetLink(text: string | null | undefined): string {
  const m = String(text || '').match(/https?:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com)[^\s)"'<]*/i);
  return m ? m[0] : '';
}

export interface GCalEvent {
  id: string;
  // Present on every occurrence Google expands out of a recurring series.
  recurringEventId?: string;
  summary?: string;
  description?: string;
  created?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; self?: boolean; displayName?: string }[];
  organizer?: { email?: string };
  // Where Google actually puts the Meet room.
  hangoutLink?: string;
  location?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

export interface ParsedClient {
  googleEventId: string;
  organizerEmail: string | null;
  /* The event's title, kept as it was written.

     The name in the parentheses was being extracted and the rest thrown away,
     so nothing in the product has ever known whether a booking was a "Second
     Call | Strategy Session" or a "Discovery". That makes two questions
     unanswerable rather than merely under-powered: what kind of appointment
     a call actually is, and whether show-up rates move with how the booking
     tool names things. */
  eventTitle: string;
  name: string;
  phone: string;
  email: string;
  youtubeLink: string;
  meetLink: string;
  callDateTime: string | null;
  timezone: string;
  bookedDate: string;
}

export type CalendarFilter = {
  mode?: 'attendees' | 'keywords' | 'all';
  include?: string[];
  matchDescription?: string[];
  exclude?: string[];
};

/* What an account with no configuration gets.

   This is the single most expensive line in the codebase's history so far.
   It used to be LEGACY_FILTER — MarketMaker's own event titles — so every
   person who signed up had their calendar filtered for the phrase "strategy
   session" and imported nothing at all. Three people hit it in a row
   (niklaus, ronin, ethan), each looked like a separate mystery, and each one
   was diagnosed from scratch while they sat in front of an empty app.

   An unconfigured account must mean "use the sensible default", never "use
   the first customer's settings". Outside-guest detection needs no setup to
   be right: an internal standup has no guest from outside your own domain, a
   booked appointment does. */
export const DEFAULT_FILTER: CalendarFilter = {
  mode: 'attendees',
  exclude: [],
};

// MarketMaker's original rule. Still exported because accounts that predate
// the filter were explicitly backfilled with it, and isStrategySessionEvent
// below is the .ics import path that genuinely means this rule — but it is no
// longer what "unconfigured" falls back to.
export const LEGACY_FILTER: CalendarFilter = {
  mode: 'keywords',
  include: ['strategy session'],
  matchDescription: ['booked by'],
  exclude: ['weekly team meeting'],
};

function domainOf(email?: string): string {
  const at = (email || '').lastIndexOf('@');
  return at === -1 ? '' : (email || '').slice(at + 1).toLowerCase();
}

/* Mirrors SHARED_MAIL_DOMAINS in logic.js — see the long comment there.

   Both rules below ask "is this guest one of my colleagues?" by comparing
   their domain to the organizer's. Right for a business with its own domain,
   catastrophically wrong for a solo operator on a personal Gmail: their client
   is also on gmail.com, so the client reads as a colleague, the booking reads
   as an internal meeting, and nothing imports at all — the LEGACY filter
   disaster a second time, landing on exactly the people the general default
   exists to serve. */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'cox.net', 'charter.net', 'earthlink.net', 'optonline.net', 'frontier.com',
]);

export function isSharedMailDomain(domain?: string): boolean {
  return SHARED_MAIL_DOMAINS.has(String(domain || '').toLowerCase());
}

// The organizer's domain, but only when it actually identifies a company.
function internalDomain(email?: string): string {
  const d = domainOf(email);
  return !d || isSharedMailDomain(d) ? '' : d;
}

/* Does this calendar event represent someone worth following up with?

   'attendees' is the default for anyone new because it needs no setup to be
   right: an internal standup has no guest from outside your own domain, a
   booked appointment does. Title matching only works for businesses whose
   booking tool names events predictably, which is a thing you have to know
   about yourself before you can configure it. */
export function matchesCalendarFilter(
  ev: GCalEvent,
  filter?: CalendarFilter,
  ownerEmail?: string,
): boolean {
  const f = filter && filter.mode ? filter : DEFAULT_FILTER;
  const title = (ev.summary || '').toLowerCase();
  const desc = (ev.description || '').toLowerCase();

  // Exclusions win in every mode: a recurring internal meeting sitting on a
  // booking calendar is the one thing nobody wants turned into a contact.
  for (const term of f.exclude || []) {
    if (term && title.indexOf(term.toLowerCase()) !== -1) return false;
  }

  if (f.mode === 'all') return true;

  if (f.mode === 'attendees') {
    /* An outside guest is the signal, and "outside" has two reference points.

       The organizer's domain was the only one used, and internalDomain
       returns '' for a personal inbox — so an internal meeting organised from
       somebody's Gmail had no internal domain, every colleague on it counted
       as an outside guest, and the meeting imported as a booking. That is how
       one standing meeting became a daily stream of contacts in three
       people's lists.

       The calendar owner's domain closes it: this is their calendar, so their
       colleagues are internal to them regardless of who organised. An owner on
       a personal inbox is unchanged — they have no colleagues to exclude. */
    const organizer = internalDomain((ev as any).organizer?.email);
    const owner = internalDomain(ownerEmail);
    const guests = ((ev as any).attendees || []) as Array<{ email?: string; self?: boolean; resource?: boolean }>;
    for (const g of guests) {
      if (g.self || g.resource) continue;          // you, and meeting rooms
      const d = domainOf(g.email);
      if (!d) continue;
      if (organizer && d === organizer) continue;  // the organizer's colleague
      if (owner && d === owner) continue;          // your colleague
      return true;
    }
    return false;
  }

  for (const term of f.include || []) {
    if (term && title.indexOf(term.toLowerCase()) !== -1) return true;
  }
  for (const term of f.matchDescription || []) {
    if (term && desc.indexOf(term.toLowerCase()) !== -1) return true;
  }
  return false;
}

// Kept so existing callers and tests keep working; new code should pass an
// explicit filter through matchesCalendarFilter.
export function isStrategySessionEvent(ev: GCalEvent): boolean {
  return matchesCalendarFilter(ev, LEGACY_FILTER);
}

/* Mirrors collapseRecurringSeries in logic.js — see the long comment there.

   A recurring series is one meeting, not one meeting per occurrence. Google is
   asked for singleEvents, which expands a series into an event per occurrence,
   and the per-event filter is right to keep them: a standing call with an
   outside guest genuinely looks like a booking. The gap was that nothing
   worked at the level of the set, so one standing meeting on a live account
   became 133 upcoming contacts out to the following March, each with its own
   follow-up cadence, burying the eight real bookings beside them. */
export function recurringSeriesKey(ev: GCalEvent | null | undefined): string | null {
  if (!ev) return null;
  if (typeof ev.recurringEventId === 'string' && ev.recurringEventId) return ev.recurringEventId;
  // Google's occurrence id shape, "<seriesId>_20261005T150000Z". Needed for
  // rows read back from storage, which kept the event id but not the series id.
  const m = String(ev.id || '').match(/^(.+)_\d{8}T\d{6}Z$/);
  return m ? m[1] : null;
}

function occurrenceStartMs(ev: GCalEvent): number | null {
  const dt = ev && ev.start && (ev.start.dateTime || ev.start.date);
  const t = dt ? new Date(dt).getTime() : NaN;
  return isNaN(t) ? null : t;
}

// Is `a` the better occurrence of a series to keep than `b`?
function preferOccurrence(a: GCalEvent, b: GCalEvent, nowMs: number): boolean {
  const ta = occurrenceStartMs(a), tb = occurrenceStartMs(b);
  if (ta === null) return false;
  if (tb === null) return true;
  const aUpcoming = ta >= nowMs, bUpcoming = tb >= nowMs;
  if (aUpcoming && bUpcoming) return ta < tb;   // the one you'll sit on next
  if (aUpcoming !== bUpcoming) return aUpcoming;
  return ta > tb;                               // all in the past: most recent
}

export function collapseRecurringSeries(events: GCalEvent[], now?: string | number | Date): GCalEvent[] {
  const list = events || [];
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const best: Record<string, GCalEvent> = Object.create(null);

  for (const ev of list) {
    const key = recurringSeriesKey(ev);
    if (!key) continue;
    if (!best[key] || preferOccurrence(ev, best[key], nowMs)) best[key] = ev;
  }

  const out: GCalEvent[] = [];
  for (const ev of list) {
    const key = recurringSeriesKey(ev);
    if (!key || best[key] === ev) out.push(ev);
  }
  return out;
}

// Mirrors extractAttendeeEmails(...).filter(excludes @marketmakermgmt.com)
// from clientFromICSEvent, but reads the structured attendees array instead
// of scraping ATTENDEE lines out of raw ICS text.
export function clientFromGCalEvent(
  ev: GCalEvent,
  filter?: CalendarFilter,
  ownerEmail?: string,
): ParsedClient | null {
  if (!matchesCalendarFilter(ev, filter, ownerEmail)) return null;
  const dt = ev.start?.dateTime || null;
  if (!dt) return null; // all-day events are never a call booking

  const summary = stripHtml(ev.summary || '');
  const description = stripHtml(ev.description || '');

  const nameMatch = summary.match(/\(([^)]+)\)/);
  const phone = extractPhone(description) || extractPhone(summary);
  /* The contact's email is the guest from OUTSIDE the organizer's domain.

     This used to strip a hard-coded `@marketmakermgmt.com`, which is the same
     mistake as the calendar filter and fails in both directions. For any
     other business the strip never matches, so the first attendee wins and a
     colleague's address gets saved as the customer's — then the follow-up
     email goes to the colleague. And a MarketMaker teammate on someone
     else's booking would be silently dropped.

     Whose domain is "internal" is knowable per event: the organizer's. That
     is the same rule attendees mode already uses to decide what counts as a
     booking, so the two now agree. */
  const organizerSelf = (ev.organizer?.email || '').toLowerCase();
  const organizerDomain = internalDomain(ev.organizer?.email);
  /* The calendar owner's own domain counts as internal too.

     The organizer's domain alone is not enough, and the gap is not
     hypothetical: an internal recurring meeting organised from somebody's
     personal Gmail has no internal domain at all, so `!organizerDomain` was
     true and EVERY named guest passed — including colleagues. One such
     meeting put `vionna@marketmakermgmt.com` into three people's lists as a
     client, new occurrences arriving daily, and for a new joiner it was his
     entire pipeline on day one.

     Who is a colleague is knowable from the account doing the syncing: this
     is their calendar, so their domain is internal to them whatever the
     organizer is on. A personal-inbox owner still gets nothing extra excluded
     here, which is correct — they have no colleagues to confuse. */
  const ownerDomain = internalDomain(ownerEmail);
  const ownerSelf = (ownerEmail || '').toLowerCase();
  const emails = (ev.attendees || [])
    .filter((a) => !(a as { self?: boolean }).self && !(a as { resource?: boolean }).resource)
    .map((a) => (a.email || '').toLowerCase())
    // The organizer is never the customer, whatever their domain. On a
    // personal inbox the domain comparison does nothing, which would leave the
    // organizer first in the list and save their address as the client's.
    .filter((e) => e && e !== organizerSelf && e !== ownerSelf)
    .filter((e) => !organizerDomain || domainOf(e) !== organizerDomain)
    .filter((e) => !ownerDomain || domainOf(e) !== ownerDomain);

  /* Who this is, in order of how much the source actually knows.

       1. The name in the title's parentheses. Booking tools write
          "Third Call | Youtube Strategy Session (Nathaly Pintor)", and when
          it is there it is exactly right.
       2. "booked by:" in the description, for the forms that use it.
       3. The guest's own displayName from Google.

     The third was missing and Google had it all along. Without it anything
     whose title is not written by a booking tool imports as "Unknown" — and
     a real account showed six of thirteen that way: every "Interview with
     Josh" and "Second Meeting ... Colin and Erica" on the calendar of
     somebody who books meetings by hand rather than through a funnel.
     "Unknown" is not a cosmetic problem: firstName() turns it into "there",
     so every one of those gets "Hey there," while the person's actual name
     sat in the event the whole time.

     Taken from the attendee we settled on as the contact, not the first in
     the list, so it cannot disagree with the address the message goes to. */
  let name = nameMatch ? nameMatch[1].trim() : '';
  if (!name) {
    const bm = description.match(/booked by[:\s]+([^\n]+)/i);
    name = bm ? bm[1].trim() : '';
  }
  if (!name && emails[0]) {
    const guest = (ev.attendees || []).find(
      (a) => (a.email || '').toLowerCase() === emails[0],
    );
    name = (guest?.displayName || '').trim();
  }
  if (!name) name = 'Unknown';

  return {
    googleEventId: ev.id,
    organizerEmail: ev.organizer?.email || null,
    eventTitle: summary,
    name,
    phone,
    email: emails[0] || '',
    youtubeLink: extractYoutube(description),
    // Google only puts the Meet room in conferenceData/hangoutLink/location.
    // These booking-form descriptions are custom text that never contains it,
    // so scraping the description alone left meetLink empty on every client
    // and the day-of text fell back to "the link in your calendar invite".
    meetLink: meetLinkFromGCalEvent(ev, description),
    callDateTime: dt,
    // ev.start.timeZone is the ORGANISER's calendar zone — ours, or
    // Asia/Kolkata for events a teammate abroad created. It is not the
    // client's. The app treats the phone's area code as the source of truth
    // and lets it be corrected by hand, so derive it the same way here and
    // only keep the event's zone when there's no usable area code.
    timezone: timezoneForPhone(phone) || ev.start?.timeZone || 'America/New_York',
    bookedDate: ev.created || new Date().toISOString(),
  };
}

function meetLinkFromGCalEvent(ev: GCalEvent, description: string): string {
  const entry = (ev as any).conferenceData?.entryPoints?.find(
    (p: any) => p?.entryPointType === 'video' && p?.uri
  );
  return (
    extractMeetLink((ev as any).hangoutLink || '') ||
    extractMeetLink(entry?.uri || '') ||
    extractMeetLink((ev as any).location || '') ||
    extractMeetLink(description) ||
    ''
  );
}
