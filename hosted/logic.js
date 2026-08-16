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

var VALID_STATUSES = ['Booked','Confirmed','Reminded','Completed','No-show','Rescheduled','Ghosted'];

var STOP_1TO4 = {Completed:true,'No-show':true,Ghosted:true};

// How often a stalled no-show/reschedule nudge re-fires while nothing has
// changed — a reply that never turns into an actual date doesn't stop it.
var FOLLOWUP_REFIRE_DAYS = 4;


/* ---------- small utils ---------- */
function uid(){ return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

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
      {id:'w1', builtin:true, text:"Hey {name}! John here — excited to have you locked in for {date} at {time}. We'll go over how realtors are using YouTube to bring in more buyer and seller leads, and what that could look like for you. Go ahead and block off the time!"},
      {id:'w2', builtin:true, text:"Hi {name}, John here with MarketMakerMGMT. Really looking forward to our call on {date} at {time} — we'll talk through turning your channel into a real lead source for your business. Save the spot on your calendar!"},
      {id:'w3', builtin:true, needsChannel:true, text:"Hey {name}! John here — just took a look at {channel} and I'm excited for our call on {date} at {time}. Got a few specific ideas for turning it into a lead source for your business. Talk soon!"}
    ],
    monday: [
      {id:'m1', builtin:true, text:"Hey {name}, quick heads up — our call is this {weekday} at {time}. Excited to show you what's possible for your channel. Keep it on your calendar!"},
      {id:'m2', builtin:true, text:"Hi {name}, John here. Just a reminder our call is set for {weekday} at {time} this week — we'll talk real strategy for your YouTube channel. Talk soon!"}
    ],
    midcheckin: [
      {id:'c1', builtin:true, text:"Hey {name}, excited for our call on {date}! Still good on your end? Got some ideas specific to your business I think you'll like."},
      {id:'c2', builtin:true, text:"Hi {name}, just checking in ahead of our {date} call — still looking forward to it. Let me know if anything's changed on your end!"},
      {id:'c3', builtin:true, needsChannel:true, text:"Hey {name}, been thinking about {channel} ahead of our {date} call — got a couple ideas I think could really help. Still good on your end?"},
      {id:'c4', builtin:true, text:"Hey {name}, quick confirm — you're still good for {date}? Reply with a 👍 and I'll see you then!"}
    ],
    dayof: [
      {id:'d1', builtin:true, text:"Hey {name}, today's the day! Our call is at {time} — talk soon. Here's the link: {link}"},
      {id:'d2', builtin:true, text:"Hi {name}, see you at {time} today! Here's the link: {link}"},
      {id:'d3', builtin:true, text:"Hey {name}, today's the day! Excited to dig into your channel at {time} — here's the link: {link}"},
      {id:'d4', builtin:true, text:"Hi {name}, see you at {time} today — got some good stuff to walk you through! Here's the link: {link}"}
    ],
    recovery: [
      {id:'r1', builtin:true, text:"Hey {name}, haven't heard back in a bit — no worries at all, things get busy! Want me to send over a couple new times so we can grab 15 minutes?"},
      {id:'r2', builtin:true, text:"Hi {name}, just checking in — looks like we lost track of a time for our call. No stress, just let me know what works and I'll get us back on the calendar."}
    ],
    noshow: [
      {id:'n1', builtin:true, text:"Hey {name}, John here — looks like we missed each other for our {date} call. No worries at all, it happens! Want me to send over a couple new times?"},
      {id:'n2', builtin:true, text:"Hi {name}, sorry we didn't connect on {date}. I'd still love to show you what's working for realtors on YouTube right now — just let me know a day that works and I'll get us back on the books."},
      {id:'n3', builtin:true, needsChannel:true, text:"Hey {name}, we missed each other on {date} — no worries. Still got a few ideas for {channel} I think you'll want to hear. Want me to send over some new times?"}
    ],
    // Fires instead of "welcome" when a new booking is matched (by phone +
    // email) to a contact who already exists in the system but never actually
    // had a call with John (ghosted / no-showed / rescheduled and vanished) —
    // someone coming back around, not a stranger, so the tone skips the
    // introduction but still reads as a first real connection.
    rebooked: [
      {id:'rb1', builtin:true, text:"Hey {name}, John here — glad we're finally locked in for {date} at {time}! Looking forward to connecting and going over the YouTube plan for your business."},
      {id:'rb2', builtin:true, text:"Hi {name}, saw we've got a new time set for {date} at {time} — excited to finally get on the phone and talk strategy."}
    ],
    // Fires instead of "rebooked" when the prior contact's last known status
    // was Completed — they already had a real call with John, this is a
    // genuine second call, and the copy should read that way (not like
    // they're a stranger or a no-show finally showing up).
    followup: [
      {id:'f1', builtin:true, text:"Hey {name}, glad we're picking this back up — got you down for {date} at {time}. Looking forward to continuing where we left off!"},
      {id:'f2', builtin:true, text:"Hi {name}, John here — excited we're back on for {date} at {time}. Let's keep building on what we talked about last time!"}
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
      stage: typeof m.stage === 'string' ? m.stage : 'welcome',
      variantId: typeof m.variantId === 'string' ? m.variantId : '',
      text: typeof m.text === 'string' ? m.text : '',
      sentAt: (typeof m.sentAt === 'string' && !isNaN(Date.parse(m.sentAt))) ? m.sentAt : nowISO(),
      responded: !!m.responded,
      respondedAt: typeof m.respondedAt === 'string' ? m.respondedAt : null
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
    timezone: (typeof raw.timezone === 'string' && raw.timezone) ? raw.timezone : 'America/New_York',
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
  var stopCadence = !!STOP_1TO4[client.status];

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
    }
  }

  // "Rescheduled" (or Ghosted) with no new date locked in yet — including
  // someone who replied wanting to reschedule but never actually gave a day —
  // gets a gentle nudge every REFIRE_DAYS, not just once. It keeps firing for
  // as long as they sit in this status; the only things that stop it are an
  // actual rebooking (status changes) or John manually re-logging an outcome.
  if((client.status === 'Ghosted' || client.status === 'Rescheduled') && client.stalledSince){
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
  if(client.status === 'No-show' && callDate){
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


function renderTemplate(template, client){
  var callDate = safeDate(client.callDateTime);
  var tz = client.timezone || 'America/New_York';
  var vals = {
    name: firstName(client.name),
    date: callDate ? fmtDate(callDate, tz) : '',
    time: callDate ? fmtTime(callDate, tz) : '',
    weekday: callDate ? weekdayName(callDate, tz) : '',
    link: client.meetLink || 'the link in your calendar invite',
    channel: extractChannelHandle(client.youtubeLink) || ''
  };
  return String(template).replace(/\{(\w+)\}/g, function(m, key){ return (key in vals) ? vals[key] : m; });
}


function getCardText(state, client, stage){
  var key = client.id + '|' + stage;
  if(Object.prototype.hasOwnProperty.call(editedTextCache, key)) return editedTextCache[key];
  var variant = pickVariant(state, stage, client);
  return renderTemplate(variant.text, client);
}

function getOriginalText(state, client, stage){
  var variant = pickVariant(state, stage, client);
  return renderTemplate(variant.text, client);
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
  var wasCustomized = text !== renderTemplate(variant.text, client);
  var loggedVariantId = wasCustomized ? 'custom' : variant.id;
  client.messageLog.push({
    stage: stage,
    variantId: loggedVariantId,
    text: text,
    sentAt: nowISO(),
    responded: false,
    respondedAt: null
  });
  if(!wasCustomized){
    if(!state.variantStats[stage]) state.variantStats[stage] = {};
    if(!state.variantStats[stage][variant.id]) state.variantStats[stage][variant.id] = {sends:0,responses:0};
    state.variantStats[stage][variant.id].sends++;
  }

  if(!STOP_1TO4[client.status]){
    if((stage === 'monday' || stage === 'midcheckin') && client.status === 'Booked'){
      client.status = 'Confirmed';
    } else if(stage === 'dayof' && (client.status === 'Booked' || client.status === 'Confirmed')){
      client.status = 'Reminded';
    }
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
  saveState(state);
}


function toggleReplied(state, clientId, msgIndex){
  var client = state.clients[clientId];
  if(!client || !client.messageLog[msgIndex]) return;
  var m = client.messageLog[msgIndex];
  m.responded = !m.responded;
  m.respondedAt = m.responded ? nowISO() : null;
  var stats = state.variantStats[m.stage] && state.variantStats[m.stage][m.variantId];
  if(stats){ stats.responses = Math.max(0, stats.responses + (m.responded ? 1 : -1)); }
  saveState(state);
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
  client.status = newStatus;
  saveState(state);
}


var AREA_CODE_TZ = (function(){
  var m = {};
  function add(codes, zone){ codes.forEach(function(c){ m[c]=zone; }); }
  add(['203','475','860','959','302','202','305','321','352','386','407','561','689','754','772','786','813','863','904','941','954',
       '229','404','470','478','678','706','762','770','912','219','260','317','463','574','765','812','930',
       '502','606','859','207','240','301','410','443','667','339','351','413','508','617','774','781','857','978',
       '231','248','269','313','517','586','616','679','734','810','906','603','201','551','609','732','848','856','862','908','973',
       '212','315','332','347','516','518','585','607','631','646','680','716','718','838','845','914','917','929','934',
       '252','336','704','743','828','910','919','980','984','216','220','234','283','330','380','419','440','513','567','614','740','937',
       '215','223','267','272','412','484','570','610','717','724','814','878','401','803','839','843','854','864',
       '423','865','802','276','434','540','571','703','757','804','826','948','304','681'], 'America/New_York');
  add(['205','251','256','334','938','479','501','870','850','217','224','309','312','331','618','630','708','773','779','815','847','872',
       '319','515','563','641','712','316','620','785','913','270','364','225','318','337','504','985',
       '218','320','507','612','651','763','952','228','601','662','769','314','417','573','636','660','816','975',
       '402','531','308','701','405','539','572','580','918','605','615','629','731','901','931',
       '214','254','281','325','346','361','409','430','432','469','512','682','713','737','806','817','830','832','903','936','940','956','972','979',
       '262','414','534','608','715','920'], 'America/Chicago');
  add(['303','719','720','970','406','505','575','385','435','801','307','208','986'], 'America/Denver');
  add(['480','520','602','623','928'], 'America/Phoenix');
  add(['209','213','279','310','323','341','408','415','424','442','510','530','559','562','619','626','628','650','657','661','669',
       '707','714','747','760','805','818','820','831','840','858','909','916','925','949','951','915',
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


var PHONE_RE = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

var EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;


function extractPhone(text){ var m = String(text||'').match(PHONE_RE); return m ? m[0].trim() : ''; }

function extractYoutube(text){ var m = String(text||'').match(/https?:\/\/(www\.)?youtube\.com\/[^\s)"'<]+/i); return m ? m[0] : ''; }

function extractMeetLink(text){ var m = String(text||'').match(/https?:\/\/(meet\.google\.com|[\w.-]*zoom\.us)[^\s)"'<]*/i); return m ? m[0] : ''; }

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
    events.push({
      summary: summary, description: description,
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
    meetLink: extractMeetLink(ev.description),
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
        recordReschedule(existing, new Date());
        existing.callDateTime = p.callDateTime;
        existing.status = 'Confirmed';
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
        hadPriorCall = other.status === 'Completed';
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
  saveState(state);
  return id;
}


function deleteClient(state, clientId){
  delete state.clients[clientId];
  saveState(state);
}


/* ============================================================
   7) STATS & DATA HEALTH
   ============================================================ */

function computeStats(state, range, now){
  now = now || new Date();
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var inCallWindow = clients.filter(function(c){ return c.callDateTime && inRange(c.callDateTime, range, now); });
  var completed = inCallWindow.filter(function(c){ return c.status==='Completed'; }).length;
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
function statusLabel(status){ return (status==='Ghosted' || status==='No-show') ? ('👻 ' + status) : status; }


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
    return STOP_1TO4[c.status] && c.messageLog.length === 0;
  });
  if(neverTexted.length) alerts.push({type:'never-texted', clients:neverTexted});

  // Catches the same gap BEFORE it happens instead of after: a call inside
  // the next 48 hours where no welcome/rebooked/followup ever went out. Once
  // the call passes and status flips to a stop-cadence value, this same
  // client falls into "never-texted" above — this is the early-warning
  // version, while there's still time to actually send something.
  var imminentUntexted = clients.filter(function(c){
    if(STOP_1TO4[c.status]) return false;
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
  var completedNotClosed = client.status === 'Completed' && client.closeOutcome !== 'Closed';
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
  var missed = clients.filter(function(c){ return c.status === 'No-show' || hasSentStage(c,'noshow'); });
  var rescued = clients.filter(function(c){ return hasSentStage(c,'noshow'); });
  var replied = rescued.filter(function(c){ return c.messageLog.some(function(m){ return m.stage==='noshow' && m.responded; }); });
  var rebooked = rescued.filter(function(c){ return c.status==='Confirmed' || c.status==='Completed' || c.status==='Reminded'; });
  return {missed: missed.length, rescued: rescued.length, replied: replied.length, rebooked: rebooked.length};
}


function computeInsights(state){
  var clients = Object.keys(state.clients).map(function(k){ return state.clients[k]; }).filter(function(c){ return !c.ignored; });
  var resolved = clients.filter(function(c){ return c.status==='Completed' || c.status==='No-show'; });
  if(resolved.length < 4) return null;
  var insights = [];
  function rateOf(arr){ var n=arr.filter(function(c){return c.status==='Completed';}).length; return arr.length ? n/arr.length : null; }

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
    if(c.status === 'Completed' && !c.closeOutcome) items.push({type:'no-close', client:c});
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
  OUTCOME_TO_STATUS: OUTCOME_TO_STATUS, setOutcome: setOutcome,
  AREA_CODE_TZ: AREA_CODE_TZ, areaCodeFromPhone: areaCodeFromPhone, timezoneForClient: timezoneForClient,
  PHONE_RE: PHONE_RE, EMAIL_RE: EMAIL_RE, extractPhone: extractPhone, extractYoutube: extractYoutube,
  extractMeetLink: extractMeetLink, pad2: pad2,
  stripHtml: stripHtml, parseICS: parseICS, isStrategySessionEvent: isStrategySessionEvent,
  parseICSDate: parseICSDate, extractAttendeeEmails: extractAttendeeEmails, clientFromICSEvent: clientFromICSEvent,
  MONTHS: MONTHS, parseHeuristicDate: parseHeuristicDate, parseBulkBlock: parseBulkBlock, parseBulkPaste: parseBulkPaste,
  commitImportedClients: commitImportedClients, addManualClient: addManualClient, deleteClient: deleteClient,
  computeStats: computeStats, pct: pct, statusLabel: statusLabel,
  computeHealthAlerts: computeHealthAlerts, getTextTodayList: getTextTodayList, byCallDate: byCallDate,
  sameContact: sameContact, normalizedPhone: normalizedPhone, isDeadClient: isDeadClient, computeDeadClients: computeDeadClients,
  getRecentSends: getRecentSends,
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
