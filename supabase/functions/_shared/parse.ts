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
  summary?: string;
  description?: string;
  created?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; self?: boolean }[];
  organizer?: { email?: string };
  // Where Google actually puts the Meet room.
  hangoutLink?: string;
  location?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
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
