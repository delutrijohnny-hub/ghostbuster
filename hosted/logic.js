'use strict';
/* GhostBuster — pure business logic, no DOM/browser dependencies.
   Loaded before app.js via <script src="logic.js"> in index.html (so its
   functions are plain globals app.js can call directly), required directly
   by test.js via require('./logic.js'), and reusable as-is by a future
   Supabase Edge Function (Deno can import this file with zero shimming).
   Nothing in this file may touch `document`, `window`, `localStorage`, or
   the app's mutable STATE/UI globals — see test.js's classification check
   if you're about to add something here that needs any of those. */

/* ============================================================
   THE GHOSTBUSTER — single-file app
   Sections: 1) data model  2) date/time  3) computeDue  4) variants/bandit
   5) messaging & outcomes  6) import (.ics / bulk / manual)  7) stats/health
   8) UI render  9) events  10) digest/print  11) charts/insights  12) boot
   ============================================================ */

var STORAGE_KEY = 'mm_followup_v1';

/* ---- pipeline stages, as data ----
   Stages used to be a fixed list of seven strings, and the ~35 places that
   asked "is this one Completed?" hard-coded the name. That's what tied
   GhostBuster to one company's sales process: an HVAC shop's equivalent of
   Completed is "Job Booked", a recruiter's is "Placed".

   The fix isn't renaming — it's that almost none of those checks actually
   cared about the NAME. They cared about the MEANING: did the appointment
   happen, was it missed, has this gone quiet. So a stage declares a role, and
   the logic asks about roles:

     open     the follow-up cadence runs
     won      it happened; cadence stops
     missed   they didn't show; cadence stops, the rescue sequence takes over
     stalled  in limbo with no new date; recovery nudges re-fire
     lost     written off; cadence stops, recovery nudges still re-fire

   The defaults below reproduce today's behaviour exactly — 'won'/'missed'/
   'lost' are precisely the old STOP_1TO4 set, and 'stalled'/'lost' are
   precisely the old Ghosted/Rescheduled recovery pair. A business can now
   define its own stages with its own names and get the same engine. */
function buildDefaultPipeline(){
  return [
    {key:'Booked',      label:'Booked',      role:'open'},
    {key:'Confirmed',   label:'Confirmed',   role:'open'},
    {key:'Reminded',    label:'Reminded',    role:'open'},
    {key:'Completed',   label:'Completed',   role:'won'},
    {key:'No-show',     label:'No-show',     role:'missed'},
    {key:'Rescheduled', label:'Rescheduled', role:'stalled'},
    {key:'Ghosted',     label:'Ghosted',     role:'lost'}
  ];
}

// computeDue(client, now) and friends don't take state, and threading it
// through every call site (and every test) to read one config would be a large
// diff for no behavioural gain. The active pipeline is held here instead and
// set once at load, alongside the existing module-level caches. Anything that
// hasn't called setPipeline() gets the defaults, so logic.js stays usable
// standalone — which the tests and the Edge Functions both rely on.
/* ---- terminology ----
   The same problem as stages, one layer up: "Client" is agency vocabulary. A
   recruiter has Candidates, an HVAC shop has Customers, a real estate team has
   Leads. Nothing in the engine depends on the word, so it is data too.

   Only nouns the UI actually says are listed. Resisting the urge to make every
   string configurable is the point: a fully translatable UI is a different and
   much larger project, and a half-done one reads worse than a consistent
   default. */
function buildDefaultTerminology(){
  return {
    contact:        'Client',
    contactPlural:  'Clients',
    appointment:    'Call',
    appointmentPlural: 'Calls',
    graveyard:      'Graveyard'
  };
}

var ACTIVE_TERMS = buildDefaultTerminology();

function setTerminology(terms){
  var base = buildDefaultTerminology();
  if(terms && typeof terms === 'object'){
    Object.keys(base).forEach(function(k){
      if(typeof terms[k] === 'string' && terms[k].trim()) base[k] = terms[k].trim();
    });
  }
  ACTIVE_TERMS = base;
}
function getTerminology(){ return ACTIVE_TERMS; }

// term('contact') -> 'Client'. Unknown keys return the key itself rather than
// undefined, so a typo shows up as visible text instead of silently rendering
// "undefined" into the interface.
function term(key){
  return Object.prototype.hasOwnProperty.call(ACTIVE_TERMS, key) ? ACTIVE_TERMS[key] : key;
}
// Title-case is wrong mid-sentence ("no Clients need attention"); this is the
// lowercase form for that position.
function termLower(key){ return String(term(key)).toLowerCase(); }


var ACTIVE_PIPELINE = buildDefaultPipeline();

function setPipeline(stages){
  ACTIVE_PIPELINE = (Array.isArray(stages) && stages.length) ? stages.filter(function(st){
    return st && typeof st.key === 'string' && st.key;
  }) : buildDefaultPipeline();
  if(!ACTIVE_PIPELINE.length) ACTIVE_PIPELINE = buildDefaultPipeline();
}
function getPipeline(){ return ACTIVE_PIPELINE; }

// Unknown stages read as 'open' rather than throwing: a contact sitting on a
// stage an admin just deleted should keep getting followed up, not fall out of
// the system silently.
function stageRole(status){
  for(var i=0;i<ACTIVE_PIPELINE.length;i++){
    if(ACTIVE_PIPELINE[i].key === status) return ACTIVE_PIPELINE[i].role || 'open';
  }
  return 'open';
}
function stageLabel(status){
  for(var i=0;i<ACTIVE_PIPELINE.length;i++){
    if(ACTIVE_PIPELINE[i].key === status) return ACTIVE_PIPELINE[i].label || status;
  }
  return status;
}
function isWon(status){ return stageRole(status) === 'won'; }
function isMissed(status){ return stageRole(status) === 'missed'; }
function isStalledStage(status){ var r = stageRole(status); return r === 'stalled' || r === 'lost'; }
function isOpenStage(status){ return stageRole(status) === 'open'; }
// won / missed / lost end the 1-to-4 cadence; the rescue and recovery
// sequences are separate and keep running where their own roles apply.
function stopsCadence(status){ var r = stageRole(status); return r === 'won' || r === 'missed' || r === 'lost'; }

var VALID_STATUSES = buildDefaultPipeline().map(function(st){ return st.key; });

var STOP_1TO4 = {Completed:true,'No-show':true,Ghosted:true};

// How often a stalled no-show/reschedule nudge re-fires while nothing has
// changed — a reply that never turns into an actual date doesn't stop it.
var FOLLOWUP_REFIRE_DAYS = 4;

// Window for the T-1h reminder, in minutes before the call.
var HOURBEFORE_LEAD_MIN = 75;
var HOURBEFORE_FLOOR_MIN = 10;


/* ---------- small utils ---------- */
function uid(){ return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

// message_log.id is a uuid column, so message rows need real uuids — uid()'s
// 'c<base36>' shape is for clients.id, which is text. Generating the id on the
// client (rather than letting Postgres default it) is what gives a message
// stable identity the moment it exists, which is what lets saveState write
// incrementally instead of deleting and reinserting the whole log.
function uuid(){
  if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(ch){
    var r = Math.random() * 16 | 0;
    return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}


/* ---- event timeline ----
   Append-only facts about a contact, drained to the events table by
   saveState. Kept as a pending queue rather than loaded into state so memory
   stays flat as history grows — the timeline UI will query it on demand.
   recordEvent never throws: a failure to log history must never take down the
   mutation that was actually being performed. */
function recordEvent(state, clientId, kind, data){
  try{
    if(!state) return;
    if(!Array.isArray(state.pendingEvents)) state.pendingEvents = [];
    state.pendingEvents.push({
      id: uuid(), clientId: clientId || null, kind: kind,
      at: nowISO(), data: data || {}
    });
  }catch(e){ /* history is best-effort; the mutation is not */ }
}

function nowISO(){ return new Date().toISOString(); }

function safeDate(iso){ if(!iso) return null; var d = new Date(iso); return isNaN(d.getTime()) ? null : d; }

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }

function normalizedPhone(phone){ return String(phone||'').replace(/\D/g,''); }

// Same person booking again, not a stranger — phone AND email must both
// match and both be present, so an empty-vs-empty pair never counts.
// Phone number alone is the reliable identity signal here — it's literally
// what determines who the text goes to, and real people frequently rebook
// under a different email (personal vs. work, a typo the first time, etc).
// Requiring both to match let real rebookings (same phone, different email)
// slip through undetected. Only fall back to email when a phone is missing.
function sameContact(a, b){
  var pa = normalizedPhone(a.phone), pb = normalizedPhone(b.phone);
  if(pa && pb) return pa === pb;
  var ea = String(a.email||'').trim().toLowerCase(), eb = String(b.email||'').trim().toLowerCase();
  return !!ea && ea === eb;
}


/* ============================================================
   1) DATA MODEL, DEFAULTS, MIGRATION
   Each builder returns brand-new object literals every call —
   never a shared "defaults" object — so nothing here can be
   mutated by a later merge (see spec trap #2).
   ============================================================ */

function buildDefaultVariants(){
  return {
    welcome: [
      {id:'w1', builtin:true, text:"Hey {name}, {sender} here. Got you locked in for {date} at {time}. Going to break down the exact video formats pulling local inbound clients right now. Go ahead and block the calendar."},
      {id:'w2', builtin:true, text:"Hi {name}, {sender} with MarketMakerMGMT. We're set for {date} at {time}. We'll map out how to turn regular video uploads into predictable inbound business. Save the time on your end."},
      {id:'w3', builtin:true, needsChannel:true, text:"Hey {name}, {sender} here. Got {channel} open and locked you in for {date} at {time}. Want to focus on the biggest leverage points for local search and discovery. Talk soon."}
    ],
    monday: [
      {id:'m1', builtin:true, text:"Hey {name}, quick heads up that we're on for this {weekday} at {time}. Going over channel architecture and what actually converts local viewers. Keep it on the calendar."},
      {id:'m2', builtin:true, text:"Hey {name}, we're on for {weekday} at {time}. I'll have a couple of examples from your market pulled up to walk through. Anything specific you want me to look at before then?"}
    ],
    midcheckin: [
      {id:'c1', builtin:true, text:"Hey {name}, checking in ahead of our call on {date}. Going to focus on the main distribution mistakes keeping real estate videos under 100 views. Still good on your end?"},
      {id:'c2', builtin:true, text:"Hi {name}, touching base before {date}. Ready to map out your content roadmap and posting rhythm. Let me know if anything shifted on your schedule."},
      {id:'c3', builtin:true, needsChannel:true, text:"Hey {name}, reviewing our plan for {channel} before {date}. Want to zone in on your local video packaging and CTR. Still all set?"},
      {id:'c4', builtin:true, text:"Hey {name}, quick schedule check for {date}. Drop a 👍 if that time still works and I'll see you then."}
    ],
    dayof: [
      {id:'d1', builtin:true, text:"Hey {name}, hopping on at {time} to dial in your channel roadmap. Here's the link: {link}"},
      {id:'d2', builtin:true, text:"Hi {name}, ready for our call at {time}. Got the strategy framework queued up. Jump in here: {link}"},
      {id:'d3', builtin:true, text:"Hey {name}, talk at {time}. Going to walk through the exact content hooks that drive local watch time. Room link is here: {link}"},
      {id:'d4', builtin:true, text:"Hi {name}, see you at {time}. Ready to break down your channel growth structure. Join here: {link}"}
    ],
    // Fires ~1 hour out, after "dayof" has already gone in the morning. The
    // no-show data says most misses aren't people changing their mind, they're
    // people whose day ran them over — so this one stays short, leads with the
    // link, and asks for nothing but a thumbs up.
    hourbefore: [
      {id:'h1', builtin:true, text:"Hey {name}, we're on in about an hour at {time}. Here's the link so it's handy: {link}"},
      {id:'h2', builtin:true, text:"{name}, coming up on {time}. Link's right here when you're ready: {link}"},
      {id:'h3', builtin:true, text:"Hey {name}, about an hour out from our {time}. Drop a 👍 if you're still good and I'll see you there. {link}"}
    ],
    recovery: [
      {id:'r1', builtin:true, text:"Hey {name}, know your schedule gets crazy. Still want to map out that channel growth blueprint? Let me know if I should drop a couple new times."},
      {id:'r2', builtin:true, text:"Hi {name}, caught you at a busy stretch. If you still want to get your YouTube content dialed in, send over a couple open windows and I'll get us set."}
    ],
    noshow: [
      {id:'n1', builtin:true, text:"Hey {name}, missed you on {date}. No stress, it happens. What does later this week look like on your end?"},
      {id:'n2', builtin:true, text:"Hi {name}, bummer we missed each other on {date}. Still want to walk you through what's driving local YouTube conversion right now. Shoot me a time that works better and we can reset."},
      {id:'n3', builtin:true, needsChannel:true, text:"Hey {name}, missed you for our {date} spot, all good. Still want to dig into the growth side for {channel}. Let me know if you want to grab another time this week."}
    ],
    // Fires instead of "welcome" when a new booking is matched (by phone +
    // email) to a contact who already exists in the system but never actually
    // had a call with John (ghosted / no-showed / rescheduled and vanished) —
    // someone coming back around, not a stranger, so the tone skips the
    // introduction but still reads as a first real connection.
    rebooked: [
      {id:'rb1', builtin:true, text:"Hey {name}, {sender} here. Glad we got this back on the calendar for {date} at {time}. Ready to dive into the YouTube roadmap for your market."},
      {id:'rb2', builtin:true, text:"Hi {name}, saw the new time come through for {date} at {time}. Glad we're making it happen, ready to get your channel dialed in."}
    ],
    // Fires instead of "rebooked" when the prior contact's last known status
    // was Completed — they already had a real call with John, this is a
    // genuine second call, and the copy should read that way (not like
    // they're a stranger or a no-show finally showing up).
    followup: [
      {id:'f1', builtin:true, text:"Hey {name}, good to pick this back up on {date} at {time}. We'll jump right into the next phase of your video production and channel rollout."},
      {id:'f2', builtin:true, text:"Hi {name}, {sender} here. Glad we're back on the calendar for {date} at {time}. Let's pick up where we left off and map out the rest of your channel strategy."}
    ]
  };
}


function buildDefaultState(){
  var variants = buildDefaultVariants();
  var variantStats = {};
  Object.keys(variants).forEach(function(stage){
    variantStats[stage] = {};
    variants[stage].forEach(function(v){ variantStats[stage][v.id] = {sends:0, responses:0}; });
  });
  return {
    clients: {},
    variants: variants,
    variantStats: variantStats,
    todos: [],
    epsilon: 0.2,
    lastSync: null
  };
}


function sanitizeClient(raw, fallbackId){
  if(!raw || typeof raw !== 'object') return null;
  var id = (typeof raw.id === 'string' && raw.id) ? raw.id : fallbackId;
  var messageLog = Array.isArray(raw.messageLog) ? raw.messageLog.filter(function(m){ return m && typeof m === 'object'; }).map(function(m){
    return {
      id: (typeof m.id === 'string' && m.id) ? m.id : uuid(),
      stage: typeof m.stage === 'string' ? m.stage : 'welcome',
      variantId: typeof m.variantId === 'string' ? m.variantId : '',
      text: typeof m.text === 'string' ? m.text : '',
      sentAt: (typeof m.sentAt === 'string' && !isNaN(Date.parse(m.sentAt))) ? m.sentAt : nowISO(),
      responded: !!m.responded,
      respondedAt: typeof m.respondedAt === 'string' ? m.respondedAt : null,
      // Data predating the reviewed flag: a logged reply is self-evidently a
      // reviewed message. A responded:false with no flag is genuinely unknown
      // — nobody ever answered the question — so it stays unreviewed and gets
      // surfaced for review rather than silently counting as a rejection.
      reviewed: (typeof m.reviewed === 'boolean') ? m.reviewed : !!m.responded
    };
  }) : [];
  return {
    id: id,
    googleEventId: typeof raw.googleEventId === 'string' ? raw.googleEventId : null,
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'Unknown',
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    youtubeLink: typeof raw.youtubeLink === 'string' ? raw.youtubeLink : '',
    meetLink: typeof raw.meetLink === 'string' ? raw.meetLink : '',
    callDateTime: (typeof raw.callDateTime === 'string' && !isNaN(Date.parse(raw.callDateTime))) ? raw.callDateTime : null,
    bookedDate: (typeof raw.bookedDate === 'string' && !isNaN(Date.parse(raw.bookedDate))) ? raw.bookedDate : nowISO(),
    timezone: resolveClientTimezone(raw),
    timezoneConfirmed: raw.timezoneConfirmed === true,
    status: VALID_STATUSES.indexOf(raw.status) !== -1 ? raw.status : 'Booked',
    messageLog: messageLog,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    recap: typeof raw.recap === 'string' ? raw.recap : '',
    closeOutcome: (raw.closeOutcome === 'Closed' || raw.closeOutcome === 'Not closed') ? raw.closeOutcome : undefined,
    reschedules: Array.isArray(raw.reschedules) ? raw.reschedules.filter(function(r){ return typeof r === 'string'; }) : [],
    rescheduleCount: Number.isFinite(raw.rescheduleCount) ? raw.rescheduleCount : (Array.isArray(raw.reschedules) ? raw.reschedules.length : 0),
    stalledSince: typeof raw.stalledSince === 'string' ? raw.stalledSince : null,
    ignored: !!raw.ignored,
    manuallyAdded: !!raw.manuallyAdded,
    snoozedUntil: sanitizeSnoozedUntil(raw.snoozedUntil),
    rebooked: !!raw.rebooked,
    hadPriorCall: !!raw.hadPriorCall
  };
}

function sanitizeSnoozedUntil(raw){
  var out = {};
  if(raw && typeof raw === 'object'){
    Object.keys(raw).forEach(function(stage){
      if(typeof raw[stage] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw[stage])) out[stage] = raw[stage];
    });
  }
  return out;
}


// Defensive, additive migration. Never throws. Never reuses a shared
// "defaults" object across merges (trap #2) and always re-populates any
// stage/field a backup predates (trap #7), e.g. an old backup with no
// `noshow` stage at all still gets the built-ins for it (trap #3).
function migrateState(raw){
  var state = buildDefaultState();
  if(!raw || typeof raw !== 'object') return state;

  state.epsilon = (typeof raw.epsilon === 'number' && raw.epsilon >= 0 && raw.epsilon <= 1) ? raw.epsilon : state.epsilon;
  state.lastSync = typeof raw.lastSync === 'string' ? raw.lastSync : null;
  state.todos = Array.isArray(raw.todos) ? raw.todos.filter(function(t){ return t && typeof t === 'object' && typeof t.text === 'string'; }).map(function(t){
    return {id: t.id || uid(), text: t.text, done: !!t.done, createdAt: t.createdAt || nowISO(), doneAt: t.doneAt || null};
  }) : [];

  var builtinIds = {};
  Object.keys(state.variants).forEach(function(stage){
    builtinIds[stage] = {};
    state.variants[stage].forEach(function(v){ builtinIds[stage][v.id] = true; });
  });
  if(raw.variants && typeof raw.variants === 'object'){
    Object.keys(state.variants).forEach(function(stage){
      var rawArr = Array.isArray(raw.variants[stage]) ? raw.variants[stage] : [];
      rawArr.forEach(function(v){
        if(v && typeof v === 'object' && typeof v.id === 'string' && typeof v.text === 'string' && !builtinIds[stage][v.id]){
          state.variants[stage].push({id:v.id, text:v.text, needsChannel: !!v.needsChannel, builtin:false});
        }
      });
    });
  }

  Object.keys(state.variants).forEach(function(stage){
    state.variants[stage].forEach(function(v){
      if(!state.variantStats[stage][v.id]) state.variantStats[stage][v.id] = {sends:0, responses:0};
    });
    var rawStats = raw.variantStats && raw.variantStats[stage];
    if(rawStats && typeof rawStats === 'object'){
      Object.keys(rawStats).forEach(function(vid){
        if(state.variantStats[stage][vid] && rawStats[vid] && typeof rawStats[vid] === 'object'){
          var s = rawStats[vid];
          state.variantStats[stage][vid] = {sends: Number(s.sends) || 0, responses: Number(s.responses) || 0};
        }
      });
    }
  });

  var rawClients = (raw.clients && typeof raw.clients === 'object') ? raw.clients : {};
  Object.keys(rawClients).forEach(function(cid){
    var c = sanitizeClient(rawClients[cid], cid);
    if(c) state.clients[c.id] = c;
  });

  return state;
}

// The mutators below (markSent, snoozeTouch, toggleReplied, setOutcome,
// deleteClient, addManualClient) each end in a call to saveState(state) —
// that's the intentional seam where persistence hooks in. The real,
// localStorage-backed saveState lives in app.js and overrides this stub
// wherever both files share a scope (the browser's two <script> tags, or
// test.js's GBFull harness). This no-op lets the mutators run standalone
// here — via plain require('./logic.js'), or from a future Deno Edge
// Function — without needing a DOM/localStorage at all.
function saveState(state){}

/* ============================================================
   2) DATE / TIME HELPERS
   ============================================================ */

function tzDateKey(date, tz){
  try{
    return new Intl.DateTimeFormat('en-CA', {timeZone: tz || 'UTC', year:'numeric', month:'2-digit', day:'2-digit'}).format(date);
  }catch(e){
    return date.toISOString().slice(0,10);
  }
}

function keyToUTCms(key){ var p = key.split('-').map(Number); return Date.UTC(p[0], p[1]-1, p[2]); }

function keyPlusDays(key, n){ return new Date(keyToUTCms(key) + n*86400000).toISOString().slice(0,10); }

function mondayOfWeekKey(key){
  var ms = keyToUTCms(key);
  var dow = new Date(ms).getUTCDay();
  var diff = (dow === 0 ? -6 : 1 - dow);
  return new Date(ms + diff*86400000).toISOString().slice(0,10);
}

function fmtDate(date, tz){ try{ return new Intl.DateTimeFormat('en-US',{timeZone:tz||'UTC',month:'short',day:'numeric'}).format(date); }catch(e){ return date.toDateString(); } }

function fmtTime(date, tz){ try{ return new Intl.DateTimeFormat('en-US',{timeZone:tz||'UTC',hour:'numeric',minute:'2-digit'}).format(date); }catch(e){ return date.toTimeString().slice(0,5); } }

function weekdayName(date, tz){ try{ return new Intl.DateTimeFormat('en-US',{timeZone:tz||'UTC',weekday:'long'}).format(date); }catch(e){ return ''; } }

function localHourInTZ(date, tz){
  try{
    var s = new Intl.DateTimeFormat('en-US',{timeZone:tz||'UTC',hour:'numeric',hour12:false}).format(date);
    return parseInt(s,10) % 24;
  }catch(e){ return date.getHours(); }
}


// Wall-clock <-> UTC conversion for an arbitrary IANA zone, so the client
// detail modal shows/saves the same moment the rest of the UI shows for
// that client, instead of silently using the viewer's own browser timezone.
function tzOffsetMinutes(utcMs, tz){
  try{
    var parts = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle:'h23', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(utcMs));
    var map = {};
    parts.forEach(function(p){ map[p.type] = p.value; });
    var asUTC = Date.UTC(+map.year, +map.month-1, +map.day, +map.hour, +map.minute, +map.second);
    return (asUTC - utcMs) / 60000;
  }catch(e){ return 0; }
}

function formatDatetimeLocalInTZ(date, tz){
  try{
    var parts = new Intl.DateTimeFormat('en-US', {timeZone: tz||'UTC', hourCycle:'h23', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(date);
    var map = {};
    parts.forEach(function(p){ map[p.type] = p.value; });
    return map.year+'-'+map.month+'-'+map.day+'T'+map.hour+':'+map.minute;
  }catch(e){ return date.toISOString().slice(0,16); }
}

function parseDatetimeLocalInTZ(str, tz){
  var m = String(str||'').match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if(!m) return null;
  var y=+m[1], mo=+m[2]-1, d=+m[3], h=+m[4], mi=+m[5];
  var guess = Date.UTC(y, mo, d, h, mi);
  var offset1 = tzOffsetMinutes(guess, tz);
  var utc = guess - offset1*60000;
  var offset2 = tzOffsetMinutes(utc, tz);
  if(offset2 !== offset1){ utc = guess - offset2*60000; }
  return new Date(utc).toISOString();
}


function startOfLocalDay(d){ var x = new Date(d.getTime()); x.setHours(0,0,0,0); return x; }

function startOfLocalWeek(d){ var x = startOfLocalDay(d); var dow = x.getDay(); var diff = (dow===0?-6:1-dow); x.setDate(x.getDate()+diff); return x; }

function inRange(dateVal, range, now){
  var d = dateVal instanceof Date ? dateVal : safeDate(dateVal);
  if(!d) return false;
  if(range === 'all') return true;
  if(range === 'today') return startOfLocalDay(d).getTime() === startOfLocalDay(now).getTime();
  if(range === 'week') return startOfLocalWeek(d).getTime() === startOfLocalWeek(now).getTime();
  return true;
}


/* ============================================================
   3) computeDue — the core cadence engine.
   Everything in the UI is driven off this one function.
   ============================================================ */

function hasSentStage(client, stage){ return client.messageLog.some(function(m){ return m.stage === stage; }); }

function lastSentAtMs(client, stage){
  var latest = null;
  client.messageLog.forEach(function(m){
    if(m.stage === stage){ var t = Date.parse(m.sentAt); if(!isNaN(t) && (latest===null || t>latest)) latest = t; }
  });
  return latest;
}


function computeDue(client, now){
  now = now || new Date();
  if(!client || client.ignored) return [];
  var due = [];
  var tz = client.timezone || 'America/New_York';
  var todayKey = tzDateKey(now, tz);
  var callDate = safeDate(client.callDateTime);
  var stopCadence = stopsCadence(client.status);

  if(!stopCadence){
    if(client.rebooked){
      var rebookStage = client.hadPriorCall ? 'followup' : 'rebooked';
      if(!hasSentStage(client, rebookStage)) due.push(rebookStage);
    } else if(!hasSentStage(client, 'welcome')) due.push('welcome');

    if(callDate){
      var callKey = tzDateKey(callDate, tz);
      var mondayKey = mondayOfWeekKey(callKey);
      if(mondayKey < callKey && todayKey >= mondayKey && todayKey < callKey && !hasSentStage(client,'monday')){
        due.push('monday');
      }
      var bookedDate = safeDate(client.bookedDate);
      if(bookedDate){
        var midMs = (bookedDate.getTime() + callDate.getTime()) / 2;
        var midKey = tzDateKey(new Date(midMs), tz);
        var dayBeforeCallKey = keyPlusDays(callKey, -1);
        if(todayKey >= midKey && todayKey <= dayBeforeCallKey && !hasSentStage(client,'midcheckin')){
          due.push('midcheckin');
        }
      }
      if(todayKey === callKey && !hasSentStage(client,'dayof')){
        due.push('dayof');
      }
      // The T-1h nudge. "dayof" is date-granular, so it typically goes out
      // whenever the morning list gets worked — hours before the call, which
      // is exactly when a reminder is easiest to forget again. This one is
      // clock-granular and only surfaces inside a narrow window right before
      // the call, so it lands while they still have time to walk to a desk.
      // Floor of 10 minutes: past that it's too late to be useful and the On
      // Deck panel's own nudge takes over.
      var minsOut = (callDate.getTime() - now.getTime()) / 60000;
      if(minsOut <= HOURBEFORE_LEAD_MIN && minsOut >= HOURBEFORE_FLOOR_MIN && !hasSentStage(client,'hourbefore')){
        due.push('hourbefore');
      }
    }
  }

  // "Rescheduled" (or Ghosted) with no new date locked in yet — including
  // someone who replied wanting to reschedule but never actually gave a day —
  // gets a gentle nudge every REFIRE_DAYS, not just once. It keeps firing for
  // as long as they sit in this status; the only things that stop it are an
  // actual rebooking (status changes) or John manually re-logging an outcome.
  if(isStalledStage(client.status) && client.stalledSince){
    var stalledMs = Date.parse(client.stalledSince);
    if(!isNaN(stalledMs)){
      var daysSinceStall = (now.getTime() - stalledMs) / 86400000;
      if(daysSinceStall >= 2){
        var lastRecovery = lastSentAtMs(client, 'recovery');
        var recoveryDueAgain = lastRecovery === null || (now.getTime() - lastRecovery) / 86400000 >= FOLLOWUP_REFIRE_DAYS;
        if(recoveryDueAgain) due.push('recovery');
      }
    }
  }

  // Same story for a straight no-show: one rescue text used to be it. Now it
  // re-fires every REFIRE_DAYS through the 14-day window — covers exactly the
  // "said they wanted to reschedule but never gave me a day" case, since a
  // reply alone doesn't change their status or stop the nudges.
  if(isMissed(client.status) && callDate){
    var daysSinceCall = (now.getTime() - callDate.getTime()) / 86400000;
    if(daysSinceCall >= 0 && daysSinceCall <= 14){
      var lastRescue = lastSentAtMs(client, 'noshow');
      var rescueDueAgain = lastRescue === null || (now.getTime() - lastRescue) / 86400000 >= FOLLOWUP_REFIRE_DAYS;
      if(rescueDueAgain) due.push('noshow');
    }
  }

  // "Not today" is an explicit, one-day-only deferral, not a way to bury a
  // touch — it self-expires the moment the snoozed-until date is reached.
  var snoozed = client.snoozedUntil || {};
  due = due.filter(function(stage){ return !(snoozed[stage] && todayKey < snoozed[stage]); });

  return due;
}


/* ============================================================
   4) VARIANT SELECTION — epsilon-greedy bandit
   ============================================================ */

var stickyVariantCache = {};   // 'clientId|stage' -> variantId — a pick must not re-roll on re-render

var editedTextCache = {};      // 'clientId|stage' -> user-edited text (source of truth once present)


function extractChannelHandle(youtubeLink){
  if(!youtubeLink) return null;
  var m = String(youtubeLink).match(/youtube\.com\/@([A-Za-z0-9_.-]+)/i);
  return m ? ('@' + m[1]) : null;
}


function eligibleVariants(state, stage, client){
  var list = (state.variants && Array.isArray(state.variants[stage]) && state.variants[stage].length) ? state.variants[stage] : buildDefaultVariants()[stage];
  var hasChannel = !!extractChannelHandle(client.youtubeLink);
  var filtered = list.filter(function(v){ return !(v.needsChannel && !hasChannel); });
  return filtered.length ? filtered : list;
}


function pickVariant(state, stage, client, opts){
  opts = opts || {};
  var key = client.id + '|' + stage;
  var eligible = eligibleVariants(state, stage, client);
  if(!eligible.length){
    return {id:'fallback', text:'Hi {name}, just checking in!', builtin:true};
  }
  if(!opts.forceReroll && stickyVariantCache[key]){
    var existing = eligible.filter(function(v){ return v.id === stickyVariantCache[key]; })[0];
    if(existing) return existing;
  }
  var stats = (state.variantStats && state.variantStats[stage]) || {};
  var hasAnyData = eligible.some(function(v){ return stats[v.id] && stats[v.id].sends > 0; });
  var chosen;
  var epsilon = (typeof state.epsilon === 'number') ? state.epsilon : 0.2;
  if(!hasAnyData || Math.random() < epsilon){
    chosen = eligible[Math.floor(Math.random() * eligible.length)];
  } else {
    chosen = eligible.reduce(function(best, v){
      var vs = stats[v.id] || {sends:0,responses:0};
      var bs = stats[best.id] || {sends:0,responses:0};
      var vRate = (vs.responses + 1) / (vs.sends + 2);
      var bRate = (bs.responses + 1) / (bs.sends + 2);
      return vRate > bRate ? v : best;
    }, eligible[0]);
  }
  stickyVariantCache[key] = chosen.id;
  return chosen;
}


function firstName(name){
  if(!name) return 'there';
  var parts = String(name).trim().split(/\s+/);
  return parts[0];
}


function renderTemplate(template, client, senderName){
  var callDate = safeDate(client.callDateTime);
  var tz = client.timezone || 'America/New_York';
  var vals = {
    name: firstName(client.name),
    sender: senderName || 'Johnny',
    date: callDate ? fmtDate(callDate, tz) : '',
    // Zone spelled out, so "11:00 AM PDT" can't be read as 11am wherever the
    // reader happens to be.
    time: callDate ? (fmtTime(callDate, tz) + ' ' + tzLabel(tz, callDate)).trim() : '',
    weekday: callDate ? weekdayName(callDate, tz) : '',
    // Never point a client at their calendar — the invite's Meet link is
    // pulled through by the sync now. If one is genuinely missing this reads
    // as an obvious placeholder rather than quietly shipping vague wording.
    link: client.meetLink || '(no link on file — paste one before sending)',
    channel: extractChannelHandle(client.youtubeLink) || ''
  };
  return String(template).replace(/\{(\w+)\}/g, function(m, key){ return (key in vals) ? vals[key] : m; });
}


function getCardText(state, client, stage){
  var key = client.id + '|' + stage;
  if(Object.prototype.hasOwnProperty.call(editedTextCache, key)) return editedTextCache[key];
  var variant = pickVariant(state, stage, client);
  return renderTemplate(variant.text, client, state.senderName);
}

function getOriginalText(state, client, stage){
  var variant = pickVariant(state, stage, client);
  return renderTemplate(variant.text, client, state.senderName);
}


/* ============================================================
   5) MESSAGING & OUTCOME ACTIONS
   ============================================================ */

function markSent(state, clientId, stage, text){
  var client = state.clients[clientId];
  if(!client) return;
  var variant = pickVariant(state, stage, client);
  // If the text sent doesn't match what that variant actually renders to,
  // the sender customized it by hand (or it's AI-generated from notes) — log
  // it as 'custom' rather than crediting/debiting the underlying template's
  // bandit stats with a send that isn't really that template's copy.
  var wasCustomized = text !== renderTemplate(variant.text, client, state.senderName);
  var loggedVariantId = wasCustomized ? 'custom' : variant.id;
  client.messageLog.push({
    id: uuid(),
    stage: stage,
    variantId: loggedVariantId,
    text: text,
    sentAt: nowISO(),
    responded: false,
    respondedAt: null,
    reviewed: false
  });
  // Deliberately NO stats.sends++ here. A send only enters the bandit's
  // denominator once someone has actually looked at whether it got a reply
  // (see reviewMessage). Counting at send time conflated "they didn't reply"
  // with "nobody checked yet" — both were responded:false — so every
  // unreviewed message scored as a rejection and pickVariant's
  // (responses+1)/(sends+2) drifted toward whichever template had been used
  // least. An unreviewed send is now simply absent from the math instead of
  // being counted as a failure.

  var statusBefore = client.status;
  if(!stopsCadence(client.status)){
    if((stage === 'monday' || stage === 'midcheckin') && client.status === 'Booked'){
      client.status = 'Confirmed';
    } else if((stage === 'dayof' || stage === 'hourbefore') && (client.status === 'Booked' || client.status === 'Confirmed')){
      client.status = 'Reminded';
    }
  }
  recordEvent(state, clientId, 'message.sent', {
    stage: stage, variantId: loggedVariantId, customized: wasCustomized, channel: 'sms'
  });
  if(client.status !== statusBefore){
    recordEvent(state, clientId, 'stage.changed', {from: statusBefore, to: client.status, cause: 'message.sent:' + stage});
  }

  delete editedTextCache[clientId + '|' + stage];
  delete stickyVariantCache[clientId + '|' + stage];
  if(client.snoozedUntil) delete client.snoozedUntil[stage];
  saveState(state);
}


// Defers a due touch to tomorrow, in the *client's* own timezone (same zone
// computeDue itself reasons in) — "not today" means not today for them.
function snoozeTouch(state, clientId, stage, now){
  var client = state.clients[clientId];
  if(!client) return;
  now = now || new Date();
  var tz = client.timezone || 'America/New_York';
  var tomorrowKey = keyPlusDays(tzDateKey(now, tz), 1);
  if(!client.snoozedUntil) client.snoozedUntil = {};
  client.snoozedUntil[stage] = tomorrowKey;
  recordEvent(state, clientId, 'followup.snoozed', {stage: stage, until: tomorrowKey});
  saveState(state);
}


// The single seam for "did this message get a reply?". Recording either
// answer — yes or no — is what puts the send into the bandit's denominator;
// a message nobody has answered for stays out of the math entirely.
// Re-answering later just moves the response count, never the send count.
function reviewMessage(state, clientId, msgIndex, didReply){
  var client = state.clients[clientId];
  if(!client || !client.messageLog[msgIndex]) return;
  var m = client.messageLog[msgIndex];
  didReply = !!didReply;

  // 'custom' and AI-drafted text aren't any template's copy, so they carry no
  // template stats — but they still get marked reviewed so they stop nagging.
  var tracked = m.variantId && m.variantId !== 'custom';
  var stats = null;
  if(tracked){
    if(!state.variantStats[m.stage]) state.variantStats[m.stage] = {};
    if(!state.variantStats[m.stage][m.variantId]) state.variantStats[m.stage][m.variantId] = {sends:0, responses:0};
    stats = state.variantStats[m.stage][m.variantId];
  }

  if(!m.reviewed){
    m.reviewed = true;
    if(stats){
      stats.sends++;
      if(didReply) stats.responses++;
    }
  } else if(stats && didReply !== m.responded){
    stats.responses = Math.max(0, stats.responses + (didReply ? 1 : -1));
  }

  m.responded = didReply;
  m.respondedAt = didReply ? nowISO() : null;
  recordEvent(state, clientId, didReply ? 'message.replied' : 'message.no_reply', {
    stage: m.stage, variantId: m.variantId
  });
  saveState(state);
}


// Back-compat wrapper for the existing checkbox UI: ticking it means "yes,
// they replied", unticking means "no, they didn't" — both are answers, so
// either way the message counts as reviewed from then on.
function toggleReplied(state, clientId, msgIndex){
  var client = state.clients[clientId];
  if(!client || !client.messageLog[msgIndex]) return;
  reviewMessage(state, clientId, msgIndex, !client.messageLog[msgIndex].responded);
}


/* ---- variant performance beyond reply rate ----
   Reply rate answers "did this message get a response". The question that
   actually matters is "did it produce an appointment, and a deal".

   Attribution is last-touch: the outcome is credited to the last message sent
   before the appointment. That is a choice with a known bias, and the bias is
   large enough that it dictates the shape of this whole function.

   Across stages, last-touch is close to meaningless here. A 'dayof' message
   goes out on the morning of the call, so it is ALWAYS the last touch for
   anyone who showed up — it inherits the credit for every show regardless of
   what it said. Ranking d2 against m1 would be measuring when a stage fires,
   not how well its copy works.

   So comparisons are only ever made WITHIN a stage, where every variant went
   out at the same point in the cadence to a comparable audience and the copy
   is the only thing that differs. That is the same reasoning that made the
   monday m1-vs-m2 result trustworthy while the cross-stage 'dayof wins'
   reading was not.

   Small samples are reported as small rather than rounded into a percentage
   that looks authoritative. A variant with 3 credited appointments has no
   rate worth printing, and printing one anyway is how a bandit ends up
   chasing noise. */
var VARIANT_MIN_SAMPLE = 10;

function computeVariantPerformance(state, now){
  now = now || new Date();
  var byStage = {};

  function bucket(stage, variantId){
    if(!byStage[stage]) byStage[stage] = {};
    if(!byStage[stage][variantId]){
      byStage[stage][variantId] = {
        variantId: variantId, stage: stage,
        sends: 0, replies: 0,        // from the message log (reviewed only)
        credited: 0, appointments: 0, closes: 0
      };
    }
    return byStage[stage][variantId];
  }

  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;

    var log = (c.messageLog || []).slice().sort(function(a, b){
      return Date.parse(a.sentAt) - Date.parse(b.sentAt);
    });

    log.forEach(function(m){
      if(!m.variantId || m.variantId === 'custom') return;
      // Unreviewed sends stay out of the denominator, exactly as they do for
      // the bandit: nobody checked, so they are not evidence either way.
      if(!m.reviewed) return;
      var b = bucket(m.stage, m.variantId);
      b.sends++;
      if(m.responded) b.replies++;
    });

    // Credit the appointment outcome to the last touch before the call.
    var call = safeDate(c.callDateTime);
    if(!call) return;
    var before = log.filter(function(m){
      var t = Date.parse(m.sentAt);
      return !isNaN(t) && t < call.getTime() && m.variantId && m.variantId !== 'custom';
    });
    if(!before.length) return;
    var last = before[before.length - 1];
    var lb = bucket(last.stage, last.variantId);
    lb.credited++;
    if(isWon(c.status)) lb.appointments++;
    if(c.closeOutcome === 'Closed') lb.closes++;
  });

  // Shape into per-stage tables, ranked, with honesty about sample size.
  var out = [];
  Object.keys(byStage).forEach(function(stage){
    var rows = Object.keys(byStage[stage]).map(function(vid){
      var r = byStage[stage][vid];
      r.replyRate = r.sends ? r.replies / r.sends : null;
      r.showRate = r.credited ? r.appointments / r.credited : null;
      r.closeRate = r.credited ? r.closes / r.credited : null;
      r.enoughData = r.credited >= VARIANT_MIN_SAMPLE;
      return r;
    });
    rows.sort(function(a, b){
      // Rank on what matters most that the data can actually support:
      // appointments where the sample allows, reply rate otherwise.
      var aKey = a.enoughData ? a.showRate : -1;
      var bKey = b.enoughData ? b.showRate : -1;
      if(aKey !== bKey) return bKey - aKey;
      return (b.replyRate || 0) - (a.replyRate || 0);
    });
    var rated = rows.filter(function(r){ return r.enoughData; });
    out.push({
      stage: stage,
      rows: rows,
      // A leader is only claimed when at least two variants cleared the
      // sample floor. One variant with data is not a comparison.
      leader: rated.length >= 2 ? rated[0] : null,
      comparable: rated.length >= 2
    });
  });
  out.sort(function(a, b){ return a.stage.localeCompare(b.stage); });
  return out;
}


/* ---- contact timeline ----
   One chronological story per contact, assembled from two sources.

   The events table only started recording today, so a timeline reading events
   alone would be empty for every contact that already exists — 143 of them
   here, with months of history. Most of that history is already stored, just
   not as events: message_log has every send and every logged reply,
   clients.reschedules has the moves, bookedDate and callDateTime bracket the
   appointment. So the timeline DERIVES the past from those records and MERGES
   the events recorded from now on.

   The derived entries are reconstructions, not recordings — a reply logged
   long after it arrived carries the logging time, not the reply time, and a
   status change that happened before the events table existed has no timestamp
   at all and simply cannot appear. Marking each entry's source keeps that
   honest rather than implying a precision the data does not have.
   ============================================================ */

function timelineEntry(at, kind, label, detail, source){
  var t = Date.parse(at);
  return {at: at, ms: isNaN(t) ? 0 : t, kind: kind, label: label, detail: detail || '', source: source};
}

// EVENT_LABELS keeps the phrasing in one place so the timeline and any future
// activity feed can't drift apart.
var EVENT_LABELS = {
  'contact.created':        'Added to GhostBuster',
  'contact.deleted':        'Deleted',
  'appointment.scheduled':  'Appointment scheduled',
  'appointment.rescheduled':'Appointment rescheduled',
  'appointment.booked':     'Appointment booked',
  'message.sent':           'Message sent',
  'message.replied':        'Reply received',
  'message.no_reply':       'Marked no reply',
  'stage.changed':          'Stage changed',
  'outcome.logged':         'Outcome logged',
  'interaction.outcome':    'Outcome recorded',
  'followup.snoozed':       'Follow-up snoozed'
};

function buildTimeline(client, events, now){
  now = now || new Date();
  var out = [];
  if(!client) return out;

  // --- derived from stored records (the past) ---
  if(client.bookedDate){
    out.push(timelineEntry(client.bookedDate, 'contact.created', 'Added to GhostBuster',
      client.manuallyAdded ? 'Added by hand' : 'From the calendar', 'derived'));
  }
  (client.messageLog || []).forEach(function(m){
    out.push(timelineEntry(m.sentAt, 'message.sent', 'Message sent',
      m.stage + (m.variantId ? ' · ' + m.variantId : ''), 'derived'));
    // respondedAt is when the reply was LOGGED, which can be much later than
    // when it arrived. Fall back to the send time rather than inventing one.
    if(m.responded){
      out.push(timelineEntry(m.respondedAt || m.sentAt, 'message.replied', 'Reply received',
        m.respondedAt ? '' : 'time approximate', 'derived'));
    }
  });
  (client.reschedules || []).forEach(function(r){
    out.push(timelineEntry(r, 'appointment.rescheduled', 'Appointment rescheduled', '', 'derived'));
  });
  if(client.callDateTime){
    var cd = safeDate(client.callDateTime);
    var future = cd && cd.getTime() > now.getTime();
    out.push(timelineEntry(client.callDateTime, 'appointment.scheduled',
      future ? 'Appointment scheduled' : 'Appointment time', '', 'derived'));
  }

  // --- recorded events (from today onward) ---
  (events || []).forEach(function(e){
    var d = e.data || {};
    var detail = '';
    if(e.kind === 'stage.changed') detail = (d.from || '?') + ' → ' + (d.to || '?');
    else if(e.kind === 'interaction.outcome') detail = String(d.outcome || '').replace(/_/g, ' ');
    else if(e.kind === 'message.sent') detail = (d.stage || '') + (d.variantId ? ' · ' + d.variantId : '');
    else if(e.kind === 'outcome.logged') detail = d.outcome || '';
    out.push(timelineEntry(e.at, e.kind, EVENT_LABELS[e.kind] || e.kind, detail, 'event'));
  });

  // A derived send and a recorded send for the same message are the same fact
  // seen twice. Recorded wins — it carries channel and variant context the
  // reconstruction cannot.
  var seen = {};
  var deduped = [];
  out.sort(function(a, b){
    if(a.ms !== b.ms) return a.ms - b.ms;
    return a.source === 'event' ? -1 : 1;
  });
  out.forEach(function(e){
    var key = e.kind + '|' + Math.floor(e.ms / 60000);   // same kind within the same minute
    if(seen[key]) return;
    seen[key] = true;
    deduped.push(e);
  });
  return deduped;
}


/* ---- one interaction lifecycle ----
   "Message sent" and "did they write back?" were two workflows asking about
   one thing. They are states of a single interaction:

     created -> sent -> waiting -> replied | no_reply -> outcome -> next action

   The important consequence is WHEN to ask. The old review queue surfaced a
   message two hours after sending, which is too soon to know anything — a
   question nobody can answer yet trains people to answer it carelessly, and a
   careless answer is worse for the bandit than no answer. A message now sits
   in 'waiting' until the reply window elapses, and only then becomes something
   the salesperson is asked about.

   Nothing here changes what is stored: reviewed/responded/respondedAt are the
   same fields the analytics, the bandit and the Ghost Score already read. This
   is a derived view over them, not a new source of truth. */
var REPLY_WAIT_HOURS = 24;

function messageState(m, now){
  if(!m) return null;
  if(m.reviewed) return m.responded ? 'replied' : 'no_reply';
  var sent = Date.parse(m.sentAt);
  if(isNaN(sent)) return 'waiting';
  var hours = ((now || new Date()).getTime() - sent) / 3600000;
  return hours < REPLY_WAIT_HOURS ? 'waiting' : 'needs_outcome';
}

// The contact's current position in that lifecycle, which is what both the
// daily queue and the card render from — so they cannot disagree.
function lastInteraction(client, now){
  now = now || new Date();
  var idx = lastMessageIndex(client);
  if(idx === -1) return {message: null, idx: -1, state: 'none', hoursAgo: null};
  var m = client.messageLog[idx];
  var sent = Date.parse(m.sentAt);
  return {
    message: m, idx: idx, state: messageState(m, now),
    hoursAgo: isNaN(sent) ? null : (now.getTime() - sent) / 3600000
  };
}

// Human phrasing for the lifecycle, used in both the queue and the timeline so
// the vocabulary stays consistent across surfaces.
function interactionLabel(inter){
  if(!inter || inter.state === 'none') return 'No messages yet';
  var h = inter.hoursAgo;
  var when = (h === null) ? '' :
    h < 1 ? 'just now' :
    h < 24 ? Math.round(h) + 'h ago' :
    Math.round(h / 24) + 'd ago';
  switch(inter.state){
    case 'waiting':       return 'Waiting for reply · sent ' + when;
    case 'needs_outcome': return 'No response yet · sent ' + when;
    case 'replied':       return 'Replied';
    case 'no_reply':      return 'No reply · sent ' + when;
  }
  return when;
}

/* The single manual control that replaces five separate reply checkboxes.
   Every option resolves the interaction; the ones that mean something further
   also move the pipeline, using ROLES so a custom pipeline works.

   Deliberately built on the existing seams — reviewMessage for the reply fact,
   setOutcome for the stage change — rather than a parallel outcome system that
   the analytics would then have to learn about separately. */
var INTERACTION_OUTCOMES = [
  {key:'no_reply',       label:'No reply',       replied:false},
  {key:'replied',        label:'They replied',   replied:true},
  {key:'booked',         label:'Booked',         replied:true},
  {key:'not_interested', label:'Not interested', replied:true},
  {key:'call_back',      label:'Call back later',replied:true},
  {key:'wrong_contact',  label:'Wrong contact',  replied:false}
];

// First stage carrying a given role, so outcomes work under any pipeline.
function stageWithRole(role){
  for(var i=0;i<ACTIVE_PIPELINE.length;i++){
    if(ACTIVE_PIPELINE[i].role === role) return ACTIVE_PIPELINE[i].key;
  }
  return null;
}

function recordInteractionOutcome(state, clientId, outcomeKey, extra){
  var client = state.clients[clientId];
  if(!client) return;
  extra = extra || {};
  var def = null;
  INTERACTION_OUTCOMES.forEach(function(o){ if(o.key === outcomeKey) def = o; });
  if(!def) return;

  var inter = lastInteraction(client, new Date());
  if(inter.idx !== -1){
    // Resolves the bandit's question as a side effect of the salesperson
    // telling us what happened — they never answer it as a separate chore.
    reviewMessage(state, clientId, inter.idx, def.replied);
  }

  if(extra.note){
    client.notes = (client.notes ? client.notes + '\n' : '') +
      '[' + new Date().toLocaleDateString() + '] ' + extra.note;
  }

  if(outcomeKey === 'booked'){
    if(extra.callDateTime){
      client.callDateTime = extra.callDateTime;
      var open = stageWithRole('open');
      if(open) client.status = open;
      client.stalledSince = null;
    }
    recordEvent(state, clientId, 'appointment.booked', {at: extra.callDateTime || null, source: 'outcome'});
  } else if(outcomeKey === 'not_interested'){
    var lost = stageWithRole('lost');
    if(lost) client.status = lost;
    client.stalledSince = nowISO();
  } else if(outcomeKey === 'call_back'){
    // A deferral, not a dead end: snooze the cadence rather than change stage.
    if(extra.until){
      if(!client.snoozedUntil) client.snoozedUntil = {};
      Object.keys(buildDefaultVariants()).forEach(function(stage){ client.snoozedUntil[stage] = extra.until; });
    }
  } else if(outcomeKey === 'wrong_contact'){
    client.ignored = true;
  }

  recordEvent(state, clientId, 'interaction.outcome', {
    outcome: outcomeKey,
    replied: def.replied,
    stage: inter.message ? inter.message.stage : null,
    variantId: inter.message ? inter.message.variantId : null,
    pipelineStage: client.status,
    // Time-to-response is only meaningful when there was a response.
    hoursToResponse: (def.replied && inter.hoursAgo !== null) ? Math.round(inter.hoursAgo * 10) / 10 : null,
    hasNote: !!extra.note
  });
  saveState(state);
}


// Everything sent long enough ago that a reply would have landed by now, and
// that nobody has answered the reply question for yet. This is the queue that
// feeds the bandit — an empty one means the stats are trustworthy.
//
// The floor is REPLY_WAIT_HOURS rather than a couple of hours: asking two
// hours after a send is asking a question nobody can answer, which teaches
// people to answer carelessly. Until then the interaction is simply 'waiting'.
//
// The 3-day ceiling is doing real work. It keeps the queue to something
// finishable in one sitting (a 14-day window opened at 129 rows, which is a
// wall people learn to scroll past), and it keeps the answers honest — nobody
// reliably remembers whether a particular text got a reply a fortnight ago,
// and a guessed answer is worse for the bandit than no answer at all. Sends
// that age out are simply never counted, which is the safe direction.
function getAwaitingReview(state, now, minAgeHours, maxAgeDays){
  now = now || new Date();
  minAgeHours = (typeof minAgeHours === 'number') ? minAgeHours : REPLY_WAIT_HOURS;
  maxAgeDays = (typeof maxAgeDays === 'number') ? maxAgeDays : 3;
  var newest = now.getTime() - minAgeHours * 3600000;
  var oldest = now.getTime() - maxAgeDays * 86400000;
  var out = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    c.messageLog.forEach(function(m, idx){
      if(m.reviewed) return;
      var t = Date.parse(m.sentAt);
      if(isNaN(t) || t > newest || t < oldest) return;
      out.push({client: c, idx: idx, message: m});
    });
  });
  out.sort(function(a,b){ return Date.parse(a.message.sentAt) - Date.parse(b.message.sentAt); });
  return out;
}


// dedupes a reschedule recorded twice within ~90s (e.g. a manual tap
// followed moments later by an .ics re-import confirming the same change)
function recordReschedule(client, when){
  var whenMs = when.getTime();
  var lastMs = client.reschedules.length ? Date.parse(client.reschedules[client.reschedules.length-1]) : null;
  if(lastMs !== null && Math.abs(whenMs - lastMs) < 90000) return;
  client.reschedules.push(when.toISOString());
  client.rescheduleCount = client.reschedules.length;
}


var OUTCOME_TO_STATUS = {Booked:'Booked', Confirmed:'Confirmed', Showed:'Completed', Rescheduled:'Rescheduled', 'No-show':'No-show', Ghosted:'Ghosted'};


function setOutcome(state, clientId, buttonLabel, when){
  var client = state.clients[clientId];
  if(!client) return;
  var newStatus = OUTCOME_TO_STATUS[buttonLabel] || buttonLabel;
  when = when || new Date();
  if(newStatus === 'Rescheduled'){
    recordReschedule(client, when);
    if(client.status !== 'Rescheduled') client.stalledSince = when.toISOString();
  } else if(newStatus === 'Ghosted'){
    if(client.status !== 'Ghosted') client.stalledSince = when.toISOString();
  } else {
    client.stalledSince = null;
  }
  var outcomeStatusBefore = client.status;
  client.status = newStatus;
  // The outcome IS the event here — a no-show, a close, a reschedule are the
  // facts every conversion and sales-cycle metric will later be derived from.
  recordEvent(state, clientId, 'outcome.logged', {
    outcome: buttonLabel, from: outcomeStatusBefore, to: newStatus, at: when.toISOString()
  });
  if(outcomeStatusBefore !== newStatus){
    recordEvent(state, clientId, 'stage.changed', {from: outcomeStatusBefore, to: newStatus, cause: 'outcome:' + buttonLabel});
  }
  saveState(state);
}


var AREA_CODE_TZ = (function(){
  var m = {};
  function add(codes, zone){ codes.forEach(function(c){ m[c]=zone; }); }
  add(['203','475','860','959','302','202','305','321','352','386','407','561','689','754','772','786','813','863','904','941','954',
       '229','404','470','478','678','706','762','770','912','260','317','463','574','765','812','930',
       '502','606','859','207','240','301','410','443','667','339','351','413','508','617','774','781','857','978',
       '231','248','269','313','517','586','616','679','734','810','906','603','201','551','609','732','848','856','862','908','973',
       '212','315','332','347','516','518','585','607','631','646','680','716','718','838','845','914','917','929','934',
       '252','336','704','743','828','910','919','980','984','216','220','234','283','330','380','419','440','513','567','614','740','937',
       '239','727','947','656',
       '215','223','267','272','412','484','570','610','717','724','814','878','401','803','839','843','854','864',
       '423','865','802','276','434','540','571','703','757','804','826','948','304','681'], 'America/New_York');
  // 219 is Gary, Indiana — the north-west corner of the state runs on Chicago
  // time, not Eastern like the rest of it.
  add(['219','205','251','256','334','938','479','501','870','850','217','224','309','312','331','618','630','708','773','779','815','847','872',
       '319','515','563','641','712','316','620','785','913','270','364','225','318','337','504','985',
       '218','320','507','612','651','763','952','228','601','662','769','314','417','573','636','660','816','975',
       '402','531','308','701','405','539','572','580','918','605','615','629','731','901','931',
       '214','254','281','325','346','361','409','430','432','469','512','682','713','737','806','817','830','832','903','936','940','956','972','979',
       '262','414','534','608','715','920'], 'America/Chicago');
  // 915 is El Paso — geographically Texas, but on Mountain time, and it was
  // sitting in the Pacific block an hour out.
  add(['915','303','719','720','970','406','505','575','385','435','801','307','208','986'], 'America/Denver');
  add(['480','520','602','623','928'], 'America/Phoenix');
  add(['907'], 'America/Anchorage');
  add(['808'], 'Pacific/Honolulu');
  add(['209','213','279','310','323','341','408','415','424','442','510','530','559','562','619','626','628','650','657','661','669',
       '707','714','747','760','805','818','820','831','840','858','909','916','925','949','951',
       '702','725','775','458','503','541','971','206','253','360','425','509','564'], 'America/Los_Angeles');
  return m;
})();


function areaCodeFromPhone(phone){
  var digits = String(phone || '').replace(/\D/g,'');
  if(digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return digits.length >= 10 ? digits.slice(0,3) : null;
}

function timezoneForClient(phone, fallback){
  var ac = areaCodeFromPhone(phone);
  return (ac && AREA_CODE_TZ[ac]) ? AREA_CODE_TZ[ac] : (fallback || 'America/New_York');
}

// The hosted calendar sync stores ev.start.timeZone as the client's timezone,
// but that is the *organiser's* calendar zone — i.e. ours, or Asia/Kolkata for
// events a teammate abroad created. Texts then quote the call time in that
// zone, so a California client booked at 2pm Eastern is told "2:00 PM".
//
// This app's design already treats the phone's area code as the source of
// truth ("guessed from the phone's area code; correct it if you know better"),
// so the area code wins here and the stored value is only trusted when someone
// has actually confirmed it by hand in the client modal.
function resolveClientTimezone(raw){
  var stored = (typeof raw.timezone === 'string' && raw.timezone) ? raw.timezone : null;
  if(raw.timezoneConfirmed === true && stored) return stored;
  var fromPhone = raw.phone ? AREA_CODE_TZ[areaCodeFromPhone(raw.phone)] : null;
  return fromPhone || stored || 'America/New_York';
}

// DST-correct short label ("PDT" in summer, "PST" in winter) straight from
// Intl, so a quoted time can never be read in the wrong zone.
function tzLabel(tz, date){
  try{
    var parts = new Intl.DateTimeFormat('en-US',{timeZone:tz||'UTC',timeZoneName:'short'}).formatToParts(date||new Date());
    for(var i=0;i<parts.length;i++){ if(parts[i].type==='timeZoneName') return parts[i].value; }
  }catch(e){}
  return '';
}


var PHONE_RE = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

var EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;


function extractPhone(text){ var m = String(text||'').match(PHONE_RE); return m ? m[0].trim() : ''; }

function extractYoutube(text){ var m = String(text||'').match(/https?:\/\/(www\.)?youtube\.com\/[^\s)"'<]+/i); return m ? m[0] : ''; }

function extractMeetLink(text){ var m = String(text||'').match(/https?:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com)[^\s)"'<]*/i); return m ? m[0] : ''; }

// Every place a conferencing link can hide on an event, in order of how
// authoritative it is. X-GOOGLE-CONFERENCE and LOCATION carry the real Meet
// room; the description is the last resort because on these booking-form
// invites it holds the client's details, not the link.
function meetLinkFromEvent(ev){
  return extractMeetLink(ev.conference)
      || extractMeetLink(ev.location)
      || extractMeetLink(ev.description)
      || '';
}

function pad2(n){ return (n<10?'0':'') + n; }


// Google Calendar descriptions carry literal HTML (<b>, <br>, and <a href="...">
// links — sometimes wrapped in a google.com/url?q= redirect around the real
// URL). Stripping tags leaves only the human-visible text, which sidesteps the
// redirect wrapper entirely and makes the phone/name/link regexes reliable.
function stripHtml(text){
  return String(text||'')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;/g,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
}


/* --- .ics --- */
function parseICS(text){
  var events = [];
  var blocks = String(text||'').split('BEGIN:VEVENT').slice(1).map(function(b){ return b.split('END:VEVENT')[0]; });
  blocks.forEach(function(block){
    var unfolded = block.replace(/\r\n[ \t]/g,'').replace(/\n[ \t]/g,'');
    function get(prop){
      var re = new RegExp('^' + prop + '(;[^:\\n]*)?:(.*)$', 'im');
      var m = unfolded.match(re);
      return m ? {params: m[1]||'', value: m[2].trim()} : {params:'', value:''};
    }
    var summary = stripHtml(get('SUMMARY').value.replace(/\\,/g,',').replace(/\\n/gi,' '));
    var description = stripHtml(get('DESCRIPTION').value.replace(/\\n/gi,'\n').replace(/\\,/g,','));
    var attendeeLines = unfolded.match(/^ATTENDEE.*$/gim) || [];
    var dtstart = get('DTSTART');
    var tzidMatch = dtstart.params.match(/TZID=([^;:]+)/i);
    // Google puts the Meet link in X-GOOGLE-CONFERENCE and LOCATION, not in
    // the description — and these booking-form descriptions are custom text
    // that never contains it. Reading only the description is why every
    // day-of text fell back to "the link in your calendar invite".
    var location = stripHtml(get('LOCATION').value.replace(/\\,/g,',').replace(/\\n/gi,' '));
    var conference = get('X-GOOGLE-CONFERENCE').value.replace(/\\,/g,',').trim();
    events.push({
      summary: summary, description: description,
      location: location, conference: conference,
      dtstartRaw: dtstart.value, dtstartTzid: tzidMatch ? tzidMatch[1] : null,
      uid: get('UID').value, created: get('CREATED').value, attendeeLines: attendeeLines
    });
  });
  return events;
}

function isStrategySessionEvent(ev){
  var s = (ev.summary || '').toLowerCase();
  if(s.indexOf('weekly team meeting') !== -1) return false;
  if(s.indexOf('strategy session') !== -1) return true;
  if(/booked by/i.test(ev.description || '')) return true;
  return false;
}

// `tzid` covers Google's zone-qualified DTSTART (e.g. DTSTART;TZID=America/New_York:...),
// which has no trailing Z and must not be read as the viewer's own browser timezone.
function parseICSDate(raw, tzid){
  if(!raw) return null;
  var m = String(raw).match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
  if(!m) return null;
  var y=+m[1], mo=+m[2], d=+m[3], h=+m[4], mi=+m[5], se=+m[6];
  if(m[7]) return new Date(Date.UTC(y,mo-1,d,h,mi,se)).toISOString();
  if(tzid) return parseDatetimeLocalInTZ(y+'-'+pad2(mo)+'-'+pad2(d)+'T'+pad2(h)+':'+pad2(mi), tzid);
  return new Date(y,mo-1,d,h,mi,se).toISOString();
}

function extractAttendeeEmails(lines){
  var out = [];
  (lines||[]).forEach(function(line){ var m = line.match(EMAIL_RE); if(m) out.push.apply(out, m); });
  return out;
}

function clientFromICSEvent(ev){
  if(!isStrategySessionEvent(ev)) return null;
  var dtISO = parseICSDate(ev.dtstartRaw, ev.dtstartTzid);
  if(!dtISO) return null;
  var nameMatch = (ev.summary||'').match(/\(([^)]+)\)/);

  var name = nameMatch ? nameMatch[1].trim() : null;
  if(!name){
    var bm = (ev.description||'').match(/booked by[:\s]+([^\n]+)/i);
    name = bm ? bm[1].trim() : 'Unknown';
  }
  var phone = extractPhone(ev.description) || extractPhone(ev.summary);
  // The booking-form description always states the client's own email right
  // after their name ("Booked by\n{name}\n{email}\n{phone}") — that's a far
  // more reliable source than the calendar invite's attendee list, which can
  // include internal teammates cc'd on the call using a personal (non-
  // @marketmakermgmt.com) address that the exclusion filter can't catch.
  // Only fall back to scraping attendees if the description doesn't have one.
  var descEmailMatch = (ev.description||'').match(EMAIL_RE);
  var email = descEmailMatch ? descEmailMatch[0].toLowerCase() : '';
  if(!email){
    var emails = extractAttendeeEmails(ev.attendeeLines).filter(function(e){ return !/@marketmakermgmt\.com$/i.test(e); });
    email = emails[0] || '';
  }
  var bookedDate = ev.created ? (parseICSDate(ev.created) || nowISO()) : nowISO();
  return {
    googleEventId: ev.uid || null,
    name: name, phone: phone, email: email,
    youtubeLink: extractYoutube(ev.description),
    meetLink: meetLinkFromEvent(ev),
    callDateTime: dtISO,
    bookedDate: bookedDate
  };
}


/* --- bulk paste --- */
var MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

function parseHeuristicDate(text){
  var s = String(text||'');
  var m;
  // 2026-08-03 14:00
  m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if(m){ return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]).toISOString(); }
  // 8/3/26 2pm  or 8/3/2026 2:00 PM
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})[,\s]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if(m){
    var yy = +m[3]; if(yy < 100) yy += 2000;
    var hh = +m[4] % 12; if(/pm/i.test(m[6])) hh += 12;
    return new Date(yy, +m[1]-1, +m[2], hh, m[5]?+m[5]:0).toISOString();
  }
  // Aug 3 2:00 PM  (year optional -> assume current year)
  m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?[,\s]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if(m){
    var mon = MONTHS[m[1].toLowerCase().slice(0,3)];
    var yr = m[3] ? +m[3] : new Date().getFullYear();
    var h2 = +m[4] % 12; if(/pm/i.test(m[6])) h2 += 12;
    return new Date(yr, mon, +m[2], h2, m[5]?+m[5]:0).toISOString();
  }
  return null;
}

function parseBulkBlock(block){
  var text = block.trim();
  if(!text) return null;
  var lines = text.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
  var dateISO = parseHeuristicDate(text);
  var phone = extractPhone(text);
  var emailMatch = text.match(EMAIL_RE);
  var email = emailMatch ? emailMatch[0] : '';
  var youtubeLink = extractYoutube(text);
  var name = null;
  for(var i=0;i<lines.length;i++){
    var l = lines[i];
    if(EMAIL_RE.test(l)) continue;
    if(PHONE_RE.test(l)) continue;
    if(/booked by[:\s]+/i.test(l)){ name = l.replace(/.*booked by[:\s]+/i,'').trim(); break; }
    EMAIL_RE.lastIndex = 0;
    if(!/https?:\/\//i.test(l) && l.length < 60){ name = l.replace(/[-:].*$/,'').trim(); break; }
  }
  return {name: name || 'Unknown', phone: phone, email: email, youtubeLink: youtubeLink, callDateTime: dateISO, bookedDate: nowISO()};
}

function parseBulkPaste(raw){
  var text = String(raw||'').replace(/\r\n/g,'\n');
  var blocks = text.split(/\n\s*\n/).filter(function(b){ return b.trim(); });
  if(blocks.length <= 1){ blocks = text.split('\n').filter(function(b){ return b.trim(); }); }
  return blocks.map(parseBulkBlock).filter(Boolean);
}


/* --- commit (idempotent on googleEventId / UID) --- */
function commitImportedClients(state, parsedList){
  var added=0, updated=0, rescheduled=0;
  parsedList.forEach(function(p){
    var existing = null;
    if(p.googleEventId){
      var ids = Object.keys(state.clients);
      for(var i=0;i<ids.length;i++){ if(state.clients[ids[i]].googleEventId === p.googleEventId){ existing = state.clients[ids[i]]; break; } }
    }
    if(existing){
      var oldT = safeDate(existing.callDateTime);
      var newT = safeDate(p.callDateTime);
      if(oldT && newT && oldT.getTime() !== newT.getTime()){
        var fromWhen = existing.callDateTime;
        recordReschedule(existing, new Date());
        existing.callDateTime = p.callDateTime;
        existing.status = 'Confirmed';
        recordEvent(state, existing.id, 'appointment.rescheduled', {from: fromWhen, to: p.callDateTime, source: 'calendar'});
        rescheduled++;
      }
      existing.name = p.name || existing.name;
      existing.phone = p.phone || existing.phone;
      existing.email = p.email || existing.email;
      existing.youtubeLink = p.youtubeLink || existing.youtubeLink;
      existing.meetLink = p.meetLink || existing.meetLink;
      existing.timezone = timezoneForClient(existing.phone, existing.timezone);
      updated++;
    } else {
      var id = uid();
      // A new event, but is it a stranger or someone already in the system
      // coming back around under a fresh booking (their own event id, not a
      // reschedule of the old one)? Same phone + email, a different call
      // time, is enough to call it a rebooking rather than a first hello.
      // Further split by whether a prior call actually happened: someone who
      // ghosted/no-showed/rescheduled and is finally back on the books reads
      // very differently from someone who already talked to John once and is
      // coming back for a real second call — see "followup" vs "rebooked".
      var isRebooking = false, hadPriorCall = false;
      Object.keys(state.clients).some(function(cid){
        var other = state.clients[cid];
        if(!sameContact(other, p)) return false;
        var ot = safeDate(other.callDateTime), nt = safeDate(p.callDateTime);
        if(ot && nt && ot.getTime() === nt.getTime()) return false;
        isRebooking = true;
        hadPriorCall = isWon(other.status);
        return true;
      });
      state.clients[id] = {
        id: id, googleEventId: p.googleEventId || null,
        name: p.name, phone: p.phone || '', email: p.email || '',
        youtubeLink: p.youtubeLink || '', meetLink: p.meetLink || '',
        callDateTime: p.callDateTime || null, bookedDate: p.bookedDate || nowISO(),
        timezone: timezoneForClient(p.phone, 'America/New_York'),
        status: 'Booked', messageLog: [], notes:'', recap:'',
        closeOutcome: undefined, reschedules:[], rescheduleCount:0,
        stalledSince: null, ignored:false, manuallyAdded: !p.googleEventId, snoozedUntil:{},
        rebooked: isRebooking, hadPriorCall: hadPriorCall
      };
      recordEvent(state, id, 'contact.created', {
        source: p.googleEventId ? 'calendar' : 'import',
        rebooked: isRebooking, hadPriorCall: hadPriorCall
      });
      if(p.callDateTime) recordEvent(state, id, 'appointment.scheduled', {at: p.callDateTime, source: 'calendar'});
      added++;
    }
  });
  saveState(state);
  return {added:added, updated:updated, rescheduled:rescheduled};
}


function addManualClient(state, fields){
  var id = uid();
  state.clients[id] = {
    id:id, googleEventId:null,
    name: fields.name || 'Unknown', phone: fields.phone || '', email: fields.email || '',
    youtubeLink: fields.youtubeLink || '', meetLink: fields.meetLink || '',
    callDateTime: fields.callDateTime || null, bookedDate: fields.bookedDate || nowISO(),
    timezone: fields.timezone || timezoneForClient(fields.phone, 'America/New_York'),
    status: 'Booked', messageLog: [], notes: fields.notes || '', recap:'',
    closeOutcome: undefined, reschedules:[], rescheduleCount:0,
    stalledSince: null, ignored:false, manuallyAdded:true, snoozedUntil:{}
  };
  recordEvent(state, id, 'contact.created', {source: 'manual'});
  if(state.clients[id].callDateTime) recordEvent(state, id, 'appointment.scheduled', {at: state.clients[id].callDateTime, source: 'manual'});
  saveState(state);
  return id;
}


function deleteClient(state, clientId){
  // Recorded before the delete so the client_id still resolves; the events row
  // is then removed by the clients FK cascade, which is the intended behaviour
  // — a deleted contact should not leave orphaned history behind.
  recordEvent(state, clientId, 'contact.deleted', {});
  delete state.clients[clientId];
  saveState(state);
}


/* ============================================================
   6.5) GHOST SCORE — who deserves attention today

   A transparent 0-100 rules engine, deliberately not a model. There is
   nowhere near enough labelled outcome data here to learn conversion from
   (489 reviewed sends, and stage history only began being recorded today),
   and a number nobody can explain is worse than no number: a rep who can't
   see why a lead is ranked high won't trust the list, and an unfollowed list
   is worth nothing.

   So every score is the sum of named contributions. computeGhostScore returns
   those contributions alongside the total, and the UI can show exactly the
   arithmetic that produced it. Weights live in one object so they can be tuned
   per business later, and so a learned model can eventually replace the
   weights — or the whole function — without anything else changing shape.

   Everything here asks stage ROLES, never stage names, so a custom pipeline
   scores correctly without this code knowing any of its stages.
   ============================================================ */

function buildDefaultScoreWeights(){
  return {
    // Calibrated against the real book rather than picked by eye. The first
    // pass topped out at 72, leaving 'high' and 'immediate' permanently empty
    // — bands that can never occur are worse than no bands, because they imply
    // a severity the system will never report.
    //
    // The fix was not simply inflating everything until something crossed 91;
    // that makes the number meaningless. It was deciding what 'immediate'
    // should actually mean, and setting weights so that pattern reaches it: an
    // appointment imminent AND something wrong — a month of silence, or a
    // follow-up owed. A lone upcoming appointment with nothing wrong lands
    // around 50, which is right: it is on the calendar and handled.
    //
    // These numbers are tuned to one book of ~140 contacts and should be
    // revisited once other businesses are on the system; that is why they live
    // in one object rather than scattered through the rules.
    base:               12,   // everyone starts here; the signals move you
    appointmentSoon:    38,   // a call in the next 48h is the most actionable thing there is
    followupDue:        25,   // the cadence says today, and today hasn't happened yet
    missedRecently:     26,   // no-show inside the rescue window
    hasRepliedBefore:   18,   // engagement is the strongest predictor we actually have
    stalled:            16,   // in limbo with no new date
    needsClosing:       18,   // the appointment happened and no outcome was ever logged
    silenceMax:         22,   // ramps with days since last contact, capped
    silenceRampDays:    14,   // days to reach the full silence bonus
    unansweredEach:     -5,   // each unanswered attempt past the second
    unansweredFloor:    -20,  // but never more than this in total
    staleNeverReplied:  -14,  // old and has never once responded
    staleAfterDays:     45,
    closed:             -45   // an outcome is on file; stop surfacing it
  };
}

function ghostScoreBand(score){
  if(score >= 91) return 'immediate';
  if(score >= 76) return 'high';
  if(score >= 51) return 'soon';
  if(score >= 26) return 'nurture';
  return 'low';
}

function daysBetween(aMs, bMs){ return (aMs - bMs) / 86400000; }

// Returns {score, band, reasons:[{label, points}]} where the reasons sum to
// the score before clamping — the explanation IS the calculation, not a
// narrative written next to it.
function computeGhostScore(client, now, weights, state){
  now = now || new Date();
  var w = weights || buildDefaultScoreWeights();
  var reasons = [];
  function add(label, points){ if(points) reasons.push({label: label, points: Math.round(points)}); }

  add('Baseline', w.base);

  var nowMs = now.getTime();
  var log = client.messageLog || [];
  var lastSent = null, everReplied = false, unanswered = 0;
  log.forEach(function(m){
    var t = Date.parse(m.sentAt);
    if(!isNaN(t) && (lastSent === null || t > lastSent)) lastSent = t;
    if(m.responded) everReplied = true;
  });
  // Unanswered run = consecutive reviewed-and-unreplied sends at the end of the
  // log. Unreviewed sends are skipped: nobody checked, so they are not evidence
  // of silence — the same distinction the bandit denominator turns on.
  for(var i = log.length - 1; i >= 0; i--){
    if(!log[i].reviewed) continue;
    if(log[i].responded) break;
    unanswered++;
  }

  var callMs = null;
  var cd = safeDate(client.callDateTime);
  if(cd) callMs = cd.getTime();

  if(callMs !== null && callMs > nowMs && daysBetween(callMs, nowMs) <= 2 && !stopsCadence(client.status)){
    add('Appointment in the next 48h', w.appointmentSoon);
  }

  var due = computeDue(client, now);
  if(due.length) add('Follow-up due (' + due.join(', ') + ')', w.followupDue);

  if(isMissed(client.status) && callMs !== null){
    var sinceCall = daysBetween(nowMs, callMs);
    if(sinceCall >= 0 && sinceCall <= 14) add('Missed appointment, rescue window open', w.missedRecently);
  }

  if(isStalledStage(client.status) && client.stalledSince) add('Stalled with no new date', w.stalled);

  if(everReplied) add('Has replied before', w.hasRepliedBefore);

  if(isWon(client.status) && !client.closeOutcome) add('Appointment happened, no outcome logged', w.needsClosing);

  if(lastSent !== null){
    var quiet = daysBetween(nowMs, lastSent);
    if(quiet > 0){
      var ramp = Math.min(quiet / w.silenceRampDays, 1) * w.silenceMax;
      if(ramp >= 1) add('No contact for ' + Math.floor(quiet) + ' days', ramp);
    }
  }

  if(unanswered > 2){
    add(unanswered + ' unanswered attempts', Math.max((unanswered - 2) * w.unansweredEach, w.unansweredFloor));
  }

  var booked = safeDate(client.bookedDate);
  if(booked && !everReplied && daysBetween(nowMs, booked.getTime()) > w.staleAfterDays){
    add('Old lead that has never responded', w.staleNeverReplied);
  }

  if(client.closeOutcome) add('Outcome already recorded', w.closed);

  var raw = reasons.reduce(function(acc, r){ return acc + r.points; }, 0);
  var score = clamp(Math.round(raw), 0, 100);
  return {score: score, band: ghostScoreBand(score), reasons: reasons, raw: raw};
}

// Everyone worth looking at today, hottest first. Archived contacts and the
// Graveyard are excluded — this list is meant to be worked top to bottom, so
// anything on it has to be actionable.
function rankByGhostScore(state, now, opts){
  now = now || new Date();
  opts = opts || {};
  var min = (typeof opts.min === 'number') ? opts.min : 26;
  var w = state.scoreWeights || buildDefaultScoreWeights();
  var out = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    var g = computeGhostScore(c, now, w, state);
    if(g.score < min) return;
    out.push({client: c, score: g.score, band: g.band, reasons: g.reasons});
  });
  out.sort(function(a, b){
    if(b.score !== a.score) return b.score - a.score;
    return String(a.client.name || '').localeCompare(String(b.client.name || ''));
  });
  return out;
}


/* ============================================================
   7) STATS & DATA HEALTH
   ============================================================ */

function computeStats(state, range, now){
  now = now || new Date();
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var inCallWindow = clients.filter(function(c){ return c.callDateTime && inRange(c.callDateTime, range, now); });
  var completed = inCallWindow.filter(function(c){ return isWon(c.status); }).length;
  var noshow = inCallWindow.filter(function(c){ return c.status==='No-show'; }).length;
  var showUpRate = (completed+noshow) > 0 ? completed/(completed+noshow) : null;
  var closed = inCallWindow.filter(function(c){ return c.closeOutcome==='Closed'; }).length;
  var notClosed = inCallWindow.filter(function(c){ return c.closeOutcome==='Not closed'; }).length;
  var closeRate = (closed+notClosed) > 0 ? closed/(closed+notClosed) : null;
  var rescheduledAtLeastOnce = inCallWindow.filter(function(c){ return c.rescheduleCount > 0; }).length;
  var rescheduleRate = inCallWindow.length > 0 ? rescheduledAtLeastOnce/inCallWindow.length : null;
  var sends=0, responses=0;
  clients.forEach(function(c){ c.messageLog.forEach(function(m){ if(inRange(m.sentAt, range, now)){ sends++; if(m.responded) responses++; } }); });
  var responseRate = sends > 0 ? responses/sends : null;
  return {showUpRate:showUpRate, closeRate:closeRate, rescheduleRate:rescheduleRate, callsTracked:inCallWindow.length, responseRate:responseRate};
}

function pct(v){ return v===null || v===undefined || isNaN(v) ? '—' : Math.round(v*100) + '%'; }

// The whole point of the tool: a ghost, when it appears in your client list, gets called out.
function statusLabel(status){
  var r = stageRole(status);
  return (r === 'lost' || r === 'missed') ? ('👻 ' + stageLabel(status)) : stageLabel(status);
}


function computeHealthAlerts(state){
  var alerts = [];
  var now = new Date();
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var noPhone = clients.filter(function(c){ var d = safeDate(c.callDateTime); return d && d.getTime() >= now.getTime() - 86400000 && !c.phone; });
  if(noPhone.length) alerts.push({type:'no-phone', clients:noPhone});
  var groups = {};
  clients.forEach(function(c){
    var key = (c.name||'').trim().toLowerCase() + '|' + (c.phone||'').replace(/\D/g,'');
    if(!(c.name||'').trim()) return;
    if(!groups[key]) groups[key] = [];
    groups[key].push(c);
  });
  // A real "duplicate booking" is two entries for the same person within a
  // few hours of each other — an accidental double-submit of the same slot.
  // Two entries for the same person on genuinely different dates is a
  // legitimate rebooking, already handled by its own rebooked/followup
  // messaging — flagging that here too would just be permanent noise on
  // exactly the pattern the app is now designed to expect.
  var DUPLICATE_WINDOW_MS = 3 * 3600000;
  var dupGroups = Object.keys(groups).map(function(k){ return groups[k]; }).filter(function(g){
    if(g.length < 2) return false;
    for(var i=0;i<g.length;i++){
      for(var j=i+1;j<g.length;j++){
        var ti = safeDate(g[i].callDateTime), tj = safeDate(g[j].callDateTime);
        if(ti && tj && Math.abs(ti.getTime() - tj.getTime()) < DUPLICATE_WINDOW_MS) return true;
        if(!ti && !tj) return true;
      }
    }
    return false;
  });
  if(dupGroups.length) alerts.push({type:'duplicate', groups:dupGroups});

  // Once status flips to a stop-cadence status (Completed/No-show/Ghosted),
  // computeDue permanently stops surfacing welcome/monday/midcheckin/dayof for
  // that client — correct once they've actually been texted, but if that
  // status landed *before* a single text ever went out, they're silently
  // dropped forever with no further prompt to catch it.
  var neverTexted = clients.filter(function(c){
    return stopsCadence(c.status) && c.messageLog.length === 0;
  });
  if(neverTexted.length) alerts.push({type:'never-texted', clients:neverTexted});

  // Catches the same gap BEFORE it happens instead of after: a call inside
  // the next 48 hours where no welcome/rebooked/followup ever went out. Once
  // the call passes and status flips to a stop-cadence value, this same
  // client falls into "never-texted" above — this is the early-warning
  // version, while there's still time to actually send something.
  var imminentUntexted = clients.filter(function(c){
    if(stopsCadence(c.status)) return false;
    var d = safeDate(c.callDateTime);
    if(!d) return false;
    var hoursUntil = (d.getTime() - now.getTime()) / 3600000;
    if(hoursUntil < 0 || hoursUntil > 48) return false;
    var firstStage = c.rebooked ? (c.hadPriorCall ? 'followup' : 'rebooked') : 'welcome';
    return !hasSentStage(c, firstStage);
  });
  if(imminentUntexted.length) alerts.push({type:'imminent-untexted', clients:imminentUntexted});

  return alerts;
}


var DEAD_ELIGIBLE_STATUSES = {'No-show':true, Ghosted:true, Rescheduled:true};

// A client goes to the Dead tab when the "keep them interested" follow-up
// (recovery/noshow/rebooked/followup — or, if none was ever sent, the call
// date itself) is 14+ days in the past AND nobody has rebooked them since.
// Purely computed, never written back to client.status — reactivating them
// (a new booking comes in and matches by phone+email) just makes them fall
// back out of this list on the next render, no manual "undo" needed.
//
// Completed-but-not-closed clients are eligible too: they had a real call,
// it didn't close, and if two weeks pass with no follow-up call on the
// books, that's the same "gone cold" signal as a ghost who never rebooked —
// closed clients are never eligible, obviously.
function isDeadClient(client, allClients, now, deadAfterDays){
  deadAfterDays = deadAfterDays == null ? 14 : deadAfterDays;
  if(client.ignored) return false;
  var completedNotClosed = isWon(client.status) && client.closeOutcome !== 'Closed';
  if(!DEAD_ELIGIBLE_STATUSES[client.status] && !completedNotClosed) return false;

  var rebookedSince = allClients.some(function(other){
    if(other.id === client.id) return false;
    if(!sameContact(other, client)) return false;
    var ot = safeDate(other.callDateTime), ct = safeDate(client.callDateTime);
    return ot && (!ct || ot.getTime() > ct.getTime());
  });
  if(rebookedSince) return false;

  var followUpMs = null;
  ['recovery','noshow','rebooked','followup'].forEach(function(stage){
    var t = lastSentAtMs(client, stage);
    if(t !== null && (followUpMs === null || t > followUpMs)) followUpMs = t;
  });
  var referenceMs = followUpMs !== null ? followUpMs : (safeDate(client.callDateTime) ? safeDate(client.callDateTime).getTime() : null);
  if(referenceMs === null) return false;

  var daysSince = (now.getTime() - referenceMs) / 86400000;
  return daysSince >= deadAfterDays;
}

function computeDeadClients(state, now, deadAfterDays){
  now = now || new Date();
  var all = Object.keys(state.clients).map(function(k){ return state.clients[k]; });
  return all.filter(function(c){ return isDeadClient(c, all, now, deadAfterDays); });
}


/* ============================================================
   8) CALLS BOARD DATA — "text today" must never be filtered by
   the calendar Today/Week/All toggle (spec trap #1).
   ============================================================ */

function getTextTodayList(state, now, searchQuery){
  now = now || new Date();
  var q = (searchQuery||'').trim().toLowerCase();
  var allClients = Object.keys(state.clients).map(function(k){ return state.clients[k]; });
  var items = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    if(q && c.name.toLowerCase().indexOf(q) === -1) return;
    // A client who's gone cold long enough to show up in the Dead list has,
    // by definition, already gotten their last recovery/noshow/rebooked
    // touch — queuing them here too would mean chasing leads forever even
    // after they've been written off. New activity (a rebooking) clears
    // isDeadClient's condition on its own, so this stays self-correcting.
    if(isDeadClient(c, allClients, now)) return;
    var due = computeDue(c, now);
    due.forEach(function(stage){ items.push({client:c, stage:stage}); });
  });
  items.sort(function(a,b){
    function rank(it){
      if(it.stage === 'welcome' && !hasSentStage(it.client,'welcome')) return 0;
      if(it.stage === 'rebooked' && !hasSentStage(it.client,'rebooked')) return 0;
      if(it.stage === 'followup' && !hasSentStage(it.client,'followup')) return 0;
      if(it.stage === 'noshow') return 1;
      return 2;
    }
    var r = rank(a) - rank(b);
    if(r !== 0) return r;
    var da = safeDate(a.client.callDateTime), db = safeDate(b.client.callDateTime);
    return (da?da.getTime():Infinity) - (db?db.getTime():Infinity);
  });
  return items;
}


function byCallDate(a,b){ var da=safeDate(a.callDateTime), db=safeDate(b.callDateTime); return (da?da.getTime():0)-(db?db.getTime():0); }


// Recently-sent messages, newest first, so "did they reply?" can be reviewed
// in one place at the top of the Calls tab — the per-card quick-reply toggle
// only appears once a client has a *second* touch due, so a first-touch-only
// client (the common case right after a booking) never surfaces it there.
function getRecentSends(state, now, days){
  now = now || new Date();
  days = days || 3;
  var cutoff = now.getTime() - days * 86400000;
  var out = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    c.messageLog.forEach(function(m, idx){
      var t = Date.parse(m.sentAt);
      if(!isNaN(t) && t >= cutoff && t <= now.getTime()){
        out.push({client:c, idx:idx, message:m});
      }
    });
  });
  out.sort(function(a,b){ return Date.parse(b.message.sentAt) - Date.parse(a.message.sentAt); });
  return out;
}


/* ============================================================
   8.5) ON DECK — the call happening right now
   ============================================================ */
// The half hour either side of a call is where show-up rate is actually won
// or lost, and it's the one stretch the board can't help with: by then every
// text has been sent and the card just sits there. This picks out the live
// call — or the next one up today — so the UI can pin it to the top with
// everything needed to save it in one tap.
var ONDECK_SOON_MIN = 20;         // inside this many minutes counts as "starting soon"
var ONDECK_LATE_GRACE_MIN = 4;    // this far past the start and they're officially late
var ONDECK_LATE_WINDOW_MIN = 45;  // past this the call stops being live; end-of-day owns it
// "Resolved" here means anything that isn't still open — won, missed, lost or
// stalled. Asking the role rather than naming four stages means a custom
// pipeline gets this right without On Deck knowing any of its stage names.
function isResolvedStage(status){ return !isOpenStage(status); }

function minsUntil(iso, now){
  var d = safeDate(iso);
  if(!d) return null;
  return Math.round((d.getTime() - (now || new Date()).getTime()) / 60000);
}

function countdownLabel(mins){
  if(mins === null) return '';
  if(mins === 0) return 'starting now';
  var a = Math.abs(mins), h = Math.floor(a/60), m = a % 60;
  var span = a < 60 ? (a + ' min') : (h + 'h' + (m ? ' ' + m + 'm' : ''));
  return mins > 0 ? ('in ' + span) : ('started ' + span + ' ago');
}

function telHref(phone){
  var digits = String(phone || '').replace(/\D/g, '');
  if(!digits) return null;
  if(digits.length === 10) digits = '1' + digits;
  return 'tel:+' + digits;
}

// Deliberately kept out of the cadence and the variant testing: this is a
// live "I'm here" nudge fired in the moment, not a tracked touch, so it never
// lands in the message log and never skews a variant's reply rate.
// Never promise a link that isn't on file — same trap the day-of template
// fallback used to fall into by pointing people at a calendar invite that
// may not have one either.
function onDeckNudgeText(client, kind, senderName){
  var first = firstName(client.name);
  var link = client.meetLink || '';
  if(kind === 'late'){
    return link
      ? ('Hi ' + first + ", I'm on the call now whenever you're ready, no rush at all. " + link)
      : ('Hi ' + first + ", I'm here and ready whenever you are, no rush at all.");
  }
  return link
    ? ('Hi ' + first + ", we're up in a few minutes. Here's the link: " + link + ' See you shortly.')
    : ('Hi ' + first + ", we're up in a few minutes. See you shortly.");
}

// Everything the On deck panel needs, resolved in one pass so the render
// layer stays dumb. "Today" is deliberately the user's own local day, not the
// client's — this is the board John works from, and a call at 11pm his time
// isn't today's problem just because it's tomorrow where the client is.
function getOnDeck(state, now){
  now = now || new Date();
  var all = Object.keys(state.clients).map(function(k){ return state.clients[k]; })
    .filter(function(c){ return !c.ignored; });

  var todays = all.filter(function(c){
    var d = safeDate(c.callDateTime);
    return d && isSameLocalDay(d, now);
  }).sort(byCallDate);

  var unlogged = todays.filter(function(c){ return !isResolvedStage(c.status); });

  // The live one: the next call of the day still needing an outcome that
  // hasn't gone cold yet. A call 2 hours past its start is no longer
  // something to jump on, it's something to log.
  var coldCutoff = now.getTime() - ONDECK_LATE_WINDOW_MIN * 60000;
  var focus = unlogged.filter(function(c){
    return safeDate(c.callDateTime).getTime() >= coldCutoff;
  })[0] || null;

  var later = focus ? unlogged.filter(function(c){
    return c !== focus && safeDate(c.callDateTime).getTime() > now.getTime();
  }) : [];

  // Nothing live today — what's the next thing on the books at all?
  var next = null;
  if(!focus){
    next = all.filter(function(c){
      var d = safeDate(c.callDateTime);
      return d && d.getTime() > now.getTime() && !isResolvedStage(c.status);
    }).sort(byCallDate)[0] || null;
  }

  var mins = focus ? minsUntil(focus.callDateTime, now) : null;
  return {
    focus: focus,
    mins: mins,
    late:    focus ? (mins <= -ONDECK_LATE_GRACE_MIN) : false,
    soon:    focus ? (mins > -ONDECK_LATE_GRACE_MIN && mins <= ONDECK_SOON_MIN) : false,
    started: focus ? (mins <= 0) : false,
    todays: todays,
    unlogged: unlogged,
    later: later,
    next: next,
    loggedCount: todays.length - unlogged.length
  };
}


// Delta vs. the prior equivalent period ("today" -> yesterday, "week" -> the
// week before). "All-time" has no prior period to compare against, so no
// trend is shown there — reusing computeStats with a shifted `now` avoids
// duplicating any of its window logic.
function trendHtml(currentVal, prevVal, opts){
  opts = opts || {};
  if(currentVal===null || currentVal===undefined || prevVal===null || prevVal===undefined) return '';
  var delta = opts.isCount ? (currentVal - prevVal) : (Math.round(currentVal*100) - Math.round(prevVal*100));
  if(delta === 0) return '<span class="trend flat">flat</span>';
  var improved = opts.lowerIsBetter ? delta < 0 : delta > 0;
  var arrow = delta > 0 ? '▲' : '▼';
  var cls = opts.neutral ? 'neutral' : (improved ? 'up' : 'down');
  var label = opts.isCount ? String(Math.abs(delta)) : (Math.abs(delta) + '%');
  return '<span class="trend '+cls+'">'+arrow+label+'</span>';
}


/* ---- touch card ---- */
function tzChipInfo(client, now){
  var tz = client.timezone || 'America/New_York';
  var hour = localHourInTZ(now, tz);
  var warn = hour < 8 || hour >= 21;
  var timeLabel = fmtTime(now, tz);
  return {timeLabel:timeLabel, warn:warn};
}


// Index of the most recently sent message, or -1 if none — used to let the
// board and the client table mark a reply in one tap, without opening the
// message log inside the client detail modal.
function lastMessageIndex(client){
  if(!client.messageLog.length) return -1;
  var bestIdx = 0, bestT = -Infinity;
  client.messageLog.forEach(function(m, i){
    var t = Date.parse(m.sentAt);
    if(!isNaN(t) && t > bestT){ bestT = t; bestIdx = i; }
  });
  return bestIdx;
}


function computeRescueScorecard(state){
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var missed = clients.filter(function(c){ return isMissed(c.status) || hasSentStage(c,'noshow'); });
  var rescued = clients.filter(function(c){ return hasSentStage(c,'noshow'); });
  var replied = rescued.filter(function(c){ return c.messageLog.some(function(m){ return m.stage==='noshow' && m.responded; }); });
  var rebooked = rescued.filter(function(c){ return isOpenStage(c.status) || isWon(c.status); });
  return {missed: missed.length, rescued: rescued.length, replied: replied.length, rebooked: rebooked.length};
}


function computeInsights(state){
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var resolved = clients.filter(function(c){ return isWon(c.status) || isMissed(c.status); });
  if(resolved.length < 4) return null;
  var insights = [];
  function rateOf(arr){ var n=arr.filter(function(c){return isWon(c.status);}).length; return arr.length ? n/arr.length : null; }

  var withLead = resolved.filter(function(c){ return c.bookedDate && c.callDateTime; }).map(function(c){
    var lead = (new Date(c.callDateTime) - new Date(c.bookedDate)) / 86400000;
    return {c:c, lead:lead};
  });
  var shortLead = withLead.filter(function(x){ return x.lead < 5; }).map(function(x){return x.c;});
  var longLead = withLead.filter(function(x){ return x.lead >= 5; }).map(function(x){return x.c;});
  if(shortLead.length && longLead.length){
    var sr = rateOf(shortLead), lr = rateOf(longLead);
    insights.push({text:(sr>lr?'Short lead time (<5 days) beats long lead time':'Long lead time beats short lead time') + ' — ' + pct(sr) + ' vs ' + pct(lr) + ' show-up.', small: shortLead.length<5||longLead.length<5});
  }

  var many = resolved.filter(function(c){ return c.messageLog.length >= 3; });
  var few = resolved.filter(function(c){ return c.messageLog.length <= 2; });
  if(many.length && few.length){
    var mr=rateOf(many), fr=rateOf(few);
    insights.push({text:(mr>fr?'3+ touches beat 2 or fewer':'2 or fewer touches beat 3+') + ' — ' + pct(mr) + ' vs ' + pct(fr) + ' show-up.', small: many.length<5||few.length<5});
  }

  var repliedC = resolved.filter(function(c){ return c.messageLog.some(function(m){return m.responded;}); });
  var noReply = resolved.filter(function(c){ return !c.messageLog.some(function(m){return m.responded;}); });
  if(repliedC.length && noReply.length){
    var rr=rateOf(repliedC), nr=rateOf(noReply);
    insights.push({text:'Clients who reply to texts show up ' + pct(rr) + ' of the time vs ' + pct(nr) + ' for those who don\'t.', small: repliedC.length<5||noReply.length<5});
  }

  var byDow = {};
  resolved.forEach(function(c){ if(!c.callDateTime) return; var d=new Date(c.callDateTime); var dow=d.getDay(); byDow[dow]=byDow[dow]||[]; byDow[dow].push(c); });
  var dowNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var dowRates = Object.keys(byDow).map(function(k){ return {day:dowNames[k], rate:rateOf(byDow[k]), n:byDow[k].length}; }).filter(function(x){return x.rate!==null;});
  if(dowRates.length >= 2){
    dowRates.sort(function(a,b){ return b.rate-a.rate; });
    var best = dowRates[0], worst = dowRates[dowRates.length-1];
    insights.push({text: best.day + ' is the strongest day (' + pct(best.rate) + ' show-up), ' + worst.day + ' the weakest (' + pct(worst.rate) + ').', small: best.n<5||worst.n<5});
  }

  return insights;
}


function isoWeekLabel(dateISO){
  var d = new Date(dateISO);
  var monday = startOfLocalWeek(d);
  return (monday.getMonth()+1) + '/' + monday.getDate();
}


/* ============================================================
   CALENDAR TAB — a real month/week grid built entirely from
   GhostBuster's own client data (not a live external embed: a
   cross-origin Google Calendar iframe can't be read by our JS at
   all, so clicking into it could never open a client's info here —
   this way every event on the grid is fully clickable).
   Bucketed by the *viewer's own local day*, same as Google Calendar
   itself shows events in the viewer's configured timezone.
   ============================================================ */

function addDays(d, n){ var x = new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }

function addMonths(d, n){ return new Date(d.getFullYear(), d.getMonth()+n, 1); }

function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }

function isSameLocalDay(a, b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

function localDayKey(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }

function startOfLocalWeekDate(d){ var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()); var dow=x.getDay(); var diff=(dow===0?-6:1-dow); x.setDate(x.getDate()+diff); return x; }


function getCallsByLocalDay(state){
  var map = {};
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored || !c.callDateTime) return;
    var d = safeDate(c.callDateTime);
    if(!d) return;
    var key = localDayKey(d);
    if(!map[key]) map[key] = [];
    map[key].push(c);
  });
  Object.keys(map).forEach(function(k){ map[k].sort(function(a,b){ return new Date(a.callDateTime)-new Date(b.callDateTime); }); });
  return map;
}


function weekRangeLabel(anchor){
  var start = startOfLocalWeekDate(anchor);
  var end = addDays(start, 6);
  var sameMonth = start.getMonth() === end.getMonth();
  var startLabel = start.toLocaleDateString('en-US', {month:'short', day:'numeric'});
  var endLabel = end.toLocaleDateString('en-US', sameMonth ? {day:'numeric'} : {month:'short', day:'numeric'});
  return startLabel + ' – ' + endLabel + ', ' + end.getFullYear();
}


/* ============================================================
   10) END OF DAY, DIGEST, PRINT SHEET
   ============================================================ */

function computeEndOfDayItems(state){
  var now = new Date();
  var items = [];
  var textToday = getTextTodayList(state, now, '');
  textToday.forEach(function(it){ items.push({type:'touch', stage:it.stage, client:it.client}); });
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored || !c.callDateTime) return;
    var d = safeDate(c.callDateTime);
    if(!d) return;
    var isToday = tzDateKey(d, c.timezone) === tzDateKey(now, c.timezone);
    var isPast = d.getTime() < now.getTime();
    var hasOutcome = ['Completed','No-show'].indexOf(c.status) !== -1;
    if(isToday && !hasOutcome) items.push({type:'today-no-outcome', client:c});
    else if(isPast && !isToday && !hasOutcome && c.status !== 'Ghosted' && c.status !== 'Rescheduled') items.push({type:'overdue-unlogged', client:c});
    if(isWon(c.status) && !c.closeOutcome) items.push({type:'no-close', client:c});
  });
  state.todos.filter(function(t){ return !t.done; }).forEach(function(t){ items.push({type:'todo', todo:t}); });
  return items;
}


function buildWeeklyDigest(state, now){
  now = now || new Date();
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var inWeek = clients.filter(function(c){ return c.callDateTime && inRange(c.callDateTime,'week',now); });
  var showed = inWeek.filter(function(c){ return c.status==='Completed'; });
  var noshow = inWeek.filter(function(c){ return c.status==='No-show'; });
  var ghosted = inWeek.filter(function(c){ return c.status==='Ghosted'; });
  var rescheduled = inWeek.filter(function(c){ return c.rescheduleCount>0; });
  var closed = inWeek.filter(function(c){ return c.closeOutcome==='Closed'; });
  var showUpRate = (showed.length+noshow.length) > 0 ? Math.round((showed.length/(showed.length+noshow.length))*100)+'%' : '—';
  var sends=0, responses=0;
  clients.forEach(function(c){ c.messageLog.forEach(function(m){ if(inRange(m.sentAt,'week',now)){ sends++; if(m.responded) responses++; } }); });
  var responseRate = sends>0 ? Math.round((responses/sends)*100)+'%' : '—';
  var rescue = computeRescueScorecard(state);
  var upcoming = clients.filter(function(c){ var d=safeDate(c.callDateTime); return d && d.getTime()>now.getTime() && ['Booked','Confirmed','Reminded'].indexOf(c.status)!==-1; }).length;

  var champLines = Object.keys(state.variants).map(function(stage){
    var stats = state.variantStats[stage] || {};
    var best=null, bestRate=-1;
    state.variants[stage].forEach(function(v){ var s=stats[v.id]||{sends:0,responses:0}; var r=(s.responses+1)/(s.sends+2); if(r>bestRate){bestRate=r;best=v.id;} });
    return '  ' + stage + ': ' + (best||'—');
  });

  var lines = [];
  lines.push('GhostBuster Weekly Digest — week of ' + fmtDate(startOfLocalWeek(now),'UTC'));
  lines.push('');
  lines.push('Calls scheduled: ' + inWeek.length);
  lines.push('Showed: ' + showed.length + '  No-showed: ' + noshow.length + '  Ghosted: ' + ghosted.length + '  Rescheduled: ' + rescheduled.length);
  lines.push('Show-up rate: ' + showUpRate);
  lines.push('Closes: ' + closed.length + (closed.length ? ' (' + closed.map(function(c){return c.name;}).join(', ') + ')' : ''));
  lines.push('Texts sent: ' + sends + '  Reply rate: ' + responseRate);
  lines.push('Best variant per stage:');
  lines.push.apply(lines, champLines);
  lines.push('No-show rescues: ' + rescue.rescued + ' sent, ' + rescue.replied + ' replied, ' + rescue.rebooked + ' back on the calendar');
  lines.push('Upcoming pipeline: ' + upcoming);
  return lines.join('\n');
}


function csvField(v){
  var s = v===null || v===undefined ? '' : String(v);
  return /[",\n]/.test(s) ? ('"' + s.replace(/"/g,'""') + '"') : s;
}

function buildClientsCsv(state){
  var headers = ['Name','Phone','Email','Call date/time','Timezone','Status','Booked date','YouTube link','Reschedule count','Close outcome','Notes'];
  var rows = [headers];
  Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; }).sort(byCallDate).forEach(function(c){
    var d = safeDate(c.callDateTime);
    rows.push([
      c.name, c.phone, c.email,
      d ? (fmtDate(d,c.timezone) + ' ' + fmtTime(d,c.timezone)) : '',
      c.timezone, c.status,
      c.bookedDate ? fmtDate(safeDate(c.bookedDate), c.timezone) : '',
      c.youtubeLink, c.rescheduleCount, c.closeOutcome || '', c.notes
    ]);
  });
  return rows.map(function(r){ return r.map(csvField).join(','); }).join('\r\n');
}

/* ---- exports: CommonJS for test.js/Node, window global for the browser ---- */
var __LOGIC_EXPORTS__ = {
  STORAGE_KEY: STORAGE_KEY, VALID_STATUSES: VALID_STATUSES, STOP_1TO4: STOP_1TO4,
  buildDefaultPipeline: buildDefaultPipeline, setPipeline: setPipeline, getPipeline: getPipeline,
  buildDefaultTerminology: buildDefaultTerminology, setTerminology: setTerminology,
  getTerminology: getTerminology, term: term, termLower: termLower,
  stageRole: stageRole, stageLabel: stageLabel, isWon: isWon, isMissed: isMissed,
  isStalledStage: isStalledStage, isOpenStage: isOpenStage, isResolvedStage: isResolvedStage,
  stopsCadence: stopsCadence,
  uid: uid, nowISO: nowISO, safeDate: safeDate, escapeHtml: escapeHtml, clamp: clamp,
  buildDefaultVariants: buildDefaultVariants, buildDefaultState: buildDefaultState,
  sanitizeClient: sanitizeClient, sanitizeSnoozedUntil: sanitizeSnoozedUntil, migrateState: migrateState,
  tzDateKey: tzDateKey, keyToUTCms: keyToUTCms, keyPlusDays: keyPlusDays, mondayOfWeekKey: mondayOfWeekKey,
  fmtDate: fmtDate, fmtTime: fmtTime, weekdayName: weekdayName, localHourInTZ: localHourInTZ,
  tzOffsetMinutes: tzOffsetMinutes, formatDatetimeLocalInTZ: formatDatetimeLocalInTZ,
  parseDatetimeLocalInTZ: parseDatetimeLocalInTZ, startOfLocalDay: startOfLocalDay,
  startOfLocalWeek: startOfLocalWeek, inRange: inRange,
  hasSentStage: hasSentStage, lastSentAtMs: lastSentAtMs, computeDue: computeDue,
  extractChannelHandle: extractChannelHandle, eligibleVariants: eligibleVariants, pickVariant: pickVariant,
  firstName: firstName, renderTemplate: renderTemplate, getCardText: getCardText, getOriginalText: getOriginalText,
  markSent: markSent, snoozeTouch: snoozeTouch, toggleReplied: toggleReplied, recordReschedule: recordReschedule,
  uuid: uuid, recordEvent: recordEvent,
  reviewMessage: reviewMessage, getAwaitingReview: getAwaitingReview,
  computeVariantPerformance: computeVariantPerformance, VARIANT_MIN_SAMPLE: VARIANT_MIN_SAMPLE,
  buildTimeline: buildTimeline, EVENT_LABELS: EVENT_LABELS,
  REPLY_WAIT_HOURS: REPLY_WAIT_HOURS, messageState: messageState, lastInteraction: lastInteraction,
  interactionLabel: interactionLabel, INTERACTION_OUTCOMES: INTERACTION_OUTCOMES,
  stageWithRole: stageWithRole, recordInteractionOutcome: recordInteractionOutcome,
  HOURBEFORE_LEAD_MIN: HOURBEFORE_LEAD_MIN, HOURBEFORE_FLOOR_MIN: HOURBEFORE_FLOOR_MIN,
  OUTCOME_TO_STATUS: OUTCOME_TO_STATUS, setOutcome: setOutcome,
  AREA_CODE_TZ: AREA_CODE_TZ, areaCodeFromPhone: areaCodeFromPhone, timezoneForClient: timezoneForClient,
  resolveClientTimezone: resolveClientTimezone, tzLabel: tzLabel, meetLinkFromEvent: meetLinkFromEvent,
  PHONE_RE: PHONE_RE, EMAIL_RE: EMAIL_RE, extractPhone: extractPhone, extractYoutube: extractYoutube,
  extractMeetLink: extractMeetLink, pad2: pad2,
  stripHtml: stripHtml, parseICS: parseICS, isStrategySessionEvent: isStrategySessionEvent,
  parseICSDate: parseICSDate, extractAttendeeEmails: extractAttendeeEmails, clientFromICSEvent: clientFromICSEvent,
  MONTHS: MONTHS, parseHeuristicDate: parseHeuristicDate, parseBulkBlock: parseBulkBlock, parseBulkPaste: parseBulkPaste,
  commitImportedClients: commitImportedClients, addManualClient: addManualClient, deleteClient: deleteClient,
  buildDefaultScoreWeights: buildDefaultScoreWeights, ghostScoreBand: ghostScoreBand,
  computeGhostScore: computeGhostScore, rankByGhostScore: rankByGhostScore,
  computeStats: computeStats, pct: pct, statusLabel: statusLabel,
  computeHealthAlerts: computeHealthAlerts, getTextTodayList: getTextTodayList, byCallDate: byCallDate,
  sameContact: sameContact, normalizedPhone: normalizedPhone, isDeadClient: isDeadClient, computeDeadClients: computeDeadClients,
  getRecentSends: getRecentSends,
  getOnDeck: getOnDeck, minsUntil: minsUntil, countdownLabel: countdownLabel,
  telHref: telHref, onDeckNudgeText: onDeckNudgeText,
  trendHtml: trendHtml, tzChipInfo: tzChipInfo, lastMessageIndex: lastMessageIndex,
  computeRescueScorecard: computeRescueScorecard, computeInsights: computeInsights, isoWeekLabel: isoWeekLabel,
  addDays: addDays, addMonths: addMonths, startOfMonth: startOfMonth, isSameLocalDay: isSameLocalDay,
  localDayKey: localDayKey, startOfLocalWeekDate: startOfLocalWeekDate, getCallsByLocalDay: getCallsByLocalDay,
  weekRangeLabel: weekRangeLabel,
  computeEndOfDayItems: computeEndOfDayItems, buildWeeklyDigest: buildWeeklyDigest,
  csvField: csvField, buildClientsCsv: buildClientsCsv,
  _resetCaches: function(){ stickyVariantCache = {}; editedTextCache = {}; }
};
if(typeof module !== 'undefined' && module.exports){ module.exports = __LOGIC_EXPORTS__; }
if(typeof window !== 'undefined'){ window.GBLogic = __LOGIC_EXPORTS__; }
