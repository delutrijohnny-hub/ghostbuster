// Ported from logic.js's stripHtml/extractPhone/extractYoutube/extractMeetLink
// and clientFromICSEvent — kept in sync by hand since Deno Edge Functions
// can't easily import a browser-style global-scope script. If those change
// in logic.js, mirror the change here too.
//
// Deliberately simplified vs. the .ics path per the rebuild plan: Calendar
// API events are already plain fields (no VEVENT unfolding needed), and
// event.start.timeZone is the authoritative timezone straight from Google —
// no phone-area-code guessing required here.

const PHONE_RE = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

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
  const m = String(text || '').match(/https?:\/\/(meet\.google\.com|[\w.-]*zoom\.us)[^\s)"'<]*/i);
  return m ? m[0] : '';
}

export interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  created?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; self?: boolean }[];
  organizer?: { email?: string };
}

export interface ParsedClient {
  googleEventId: string;
  organizerEmail: string | null;
  name: string;
  phone: string;
  email: string;
  youtubeLink: string;
  meetLink: string;
  callDateTime: string | null;
  timezone: string;
  bookedDate: string;
}

export function isStrategySessionEvent(ev: GCalEvent): boolean {
  const s = (ev.summary || '').toLowerCase();
  if (s.indexOf('weekly team meeting') !== -1) return false;
  if (s.indexOf('strategy session') !== -1) return true;
  if (/booked by/i.test(ev.description || '')) return true;
  return false;
}

// Mirrors extractAttendeeEmails(...).filter(excludes @marketmakermgmt.com)
// from clientFromICSEvent, but reads the structured attendees array instead
// of scraping ATTENDEE lines out of raw ICS text.
export function clientFromGCalEvent(ev: GCalEvent): ParsedClient | null {
  if (!isStrategySessionEvent(ev)) return null;
  const dt = ev.start?.dateTime || null;
  if (!dt) return null; // all-day events are never a call booking

  const summary = stripHtml(ev.summary || '');
  const description = stripHtml(ev.description || '');

  const nameMatch = summary.match(/\(([^)]+)\)/);
  let name = nameMatch ? nameMatch[1].trim() : '';
  if (!name) {
    const bm = description.match(/booked by[:\s]+([^\n]+)/i);
    name = bm ? bm[1].trim() : 'Unknown';
  }

  const phone = extractPhone(description) || extractPhone(summary);
  const emails = (ev.attendees || [])
    .map((a) => (a.email || '').toLowerCase())
    .filter((e) => e && !/@marketmakermgmt\.com$/i.test(e));

  return {
    googleEventId: ev.id,
    organizerEmail: ev.organizer?.email || null,
    name,
    phone,
    email: emails[0] || '',
    youtubeLink: extractYoutube(description),
    meetLink: extractMeetLink(description),
    callDateTime: dt,
    timezone: ev.start?.timeZone || 'America/New_York',
    bookedDate: ev.created || new Date().toISOString(),
  };
}
