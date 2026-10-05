'use strict';
/* Ghost Recall — pure business logic, no DOM/browser dependencies.
   Loaded before app.js via <script src="logic.js"> in index.html (so its
   functions are plain globals app.js can call directly), required directly
   by test.js via require('./logic.js'), and reusable as-is by a future
   Supabase Edge Function (Deno can import this file with zero shimming).
   Nothing in this file may touch `document`, `window`, `localStorage`, or
   the app's mutable STATE/UI globals — see test.js's classification check
   if you're about to add something here that needs any of those. */

/* ============================================================
   GHOST RECALL — single-file app
   Sections: 1) data model  2) date/time  3) computeDue  4) variants/bandit
   5) messaging & outcomes  6) import (.ics / bulk / manual)  7) stats/health
   8) UI render  9) events  10) digest/print  11) charts/insights  12) boot
   ============================================================ */

var STORAGE_KEY = 'mm_followup_v1';

/* ---- pipeline stages, as data ----
   Stages used to be a fixed list of seven strings, and the ~35 places that
   asked "is this one Completed?" hard-coded the name. That's what tied
   Ghost Recall to one company's sales process: an HVAC shop's equivalent of
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
/* ---- industry templates ----
   What a new company picks once, so Ghost Recall arrives configured instead of
   arriving empty. Each template is just the settings that already exist —
   terminology, pipeline, cadence — bundled into a sensible starting point.

   Deliberately NOT separate hard-coded versions of the app. A template writes
   values into the same app_settings columns an admin can edit afterwards, so
   picking "HVAC" and then renaming a stage is an ordinary edit rather than
   fighting a preset.

   Stage roles do the work: every template's pipeline maps onto open / won /
   missed / stalled / lost, which is why the same cadence engine drives all of
   them without knowing a single stage name. */
function buildIndustryTemplates(){
  function pipe(stages){
    return stages.map(function(st){ return {key: st[0], label: st[0], role: st[1]}; });
  }
  return [
    {
      key:'agency', label:'Marketing / creative agency',
      blurb:'Discovery calls booked from outreach or inbound.',
      terminology:{contact:'Client', contactPlural:'Clients', appointment:'Call', appointmentPlural:'Calls', graveyard:'Graveyard'},
      pipeline: pipe([['Booked','open'],['Confirmed','open'],['Reminded','open'],
                      ['Completed','won'],['No-show','missed'],['Rescheduled','stalled'],['Ghosted','lost']])
    },
    {
      key:'real_estate', label:'Real estate team',
      blurb:'Showings and listing appointments.',
      terminology:{contact:'Lead', contactPlural:'Leads', appointment:'Showing', appointmentPlural:'Showings', graveyard:'Cold leads'},
      pipeline: pipe([['New Lead','open'],['Contacted','open'],['Showing Scheduled','open'],
                      ['Showing Completed','won'],['No-show','missed'],['Thinking It Over','stalled'],['Lost','lost']])
    },
    {
      key:'hvac', label:'HVAC / plumbing / electrical',
      blurb:'Estimates and service calls.',
      terminology:{contact:'Customer', contactPlural:'Customers', appointment:'Estimate', appointmentPlural:'Estimates', graveyard:'Cold storage'},
      pipeline: pipe([['New Inquiry','open'],['Contacted','open'],['Estimate Scheduled','open'],
                      ['Estimate Completed','won'],['Missed Estimate','missed'],['Awaiting Decision','stalled'],['Lost','lost']])
    },
    {
      key:'roofing', label:'Roofing / exterior',
      blurb:'Inspections and quotes, often weather-driven.',
      terminology:{contact:'Homeowner', contactPlural:'Homeowners', appointment:'Inspection', appointmentPlural:'Inspections', graveyard:'Cold storage'},
      pipeline: pipe([['New Inquiry','open'],['Contacted','open'],['Inspection Scheduled','open'],
                      ['Inspection Completed','won'],['Missed Inspection','missed'],['Quote Pending','stalled'],['Lost','lost']])
    },
    {
      key:'moving', label:'Moving / logistics',
      blurb:'Walkthroughs and move quotes with hard dates.',
      terminology:{contact:'Customer', contactPlural:'Customers', appointment:'Walkthrough', appointmentPlural:'Walkthroughs', graveyard:'Cold storage'},
      pipeline: pipe([['New Inquiry','open'],['Contacted','open'],['Walkthrough Booked','open'],
                      ['Walkthrough Done','won'],['No-show','missed'],['Quote Pending','stalled'],['Lost','lost']])
    },
    {
      key:'recruiting', label:'Recruiting / staffing',
      blurb:'Candidate screens and interviews.',
      terminology:{contact:'Candidate', contactPlural:'Candidates', appointment:'Interview', appointmentPlural:'Interviews', graveyard:'Archive'},
      pipeline: pipe([['Sourced','open'],['Contacted','open'],['Screen Scheduled','open'],
                      ['Screen Completed','won'],['No-show','missed'],['Awaiting Decision','stalled'],['Passed','lost']])
    },
    {
      key:'saas', label:'SaaS / software sales',
      blurb:'Demos and trials.',
      terminology:{contact:'Prospect', contactPlural:'Prospects', appointment:'Demo', appointmentPlural:'Demos', graveyard:'Closed lost'},
      pipeline: pipe([['New Lead','open'],['Contacted','open'],['Demo Scheduled','open'],
                      ['Demo Completed','won'],['No-show','missed'],['Evaluating','stalled'],['Closed Lost','lost']])
    },
    {
      key:'fitness', label:'Gym / fitness studio',
      blurb:'Intro sessions and tours.',
      terminology:{contact:'Member', contactPlural:'Members', appointment:'Session', appointmentPlural:'Sessions', graveyard:'Lapsed'},
      pipeline: pipe([['New Lead','open'],['Contacted','open'],['Intro Booked','open'],
                      ['Intro Attended','won'],['No-show','missed'],['Deciding','stalled'],['Not Joining','lost']])
    },
    {
      key:'b2b', label:'General B2B sales',
      blurb:'Discovery calls and proposals.',
      terminology:{contact:'Opportunity', contactPlural:'Opportunities', appointment:'Meeting', appointmentPlural:'Meetings', graveyard:'Closed lost'},
      pipeline: pipe([['New Lead','open'],['Contacted','open'],['Meeting Scheduled','open'],
                      ['Meeting Held','won'],['No-show','missed'],['Proposal Pending','stalled'],['Closed Lost','lost']])
    },
    {
      key:'custom', label:'Something else',
      blurb:'Start from the basics and rename everything yourself.',
      terminology: null,   // null means "keep the defaults and let them edit"
      pipeline: null
    }
  ];
}

function industryTemplate(key){
  var all = buildIndustryTemplates();
  for(var i = 0; i < all.length; i++){ if(all[i].key === key) return all[i]; }
  return null;
}


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

/* The account's booking link, held the way the pipeline and vocabulary are.

   Module-level rather than passed through renderTemplate, because that
   function is called from a dozen places and threading an argument through
   all of them to reach one placeholder is how call sites drift apart. It is
   set once on load, next to setPipeline and setSequence, which is the pattern
   this file already uses for per-account configuration. */
var ACTIVE_BOOKING_LINK = '';
function setBookingLink(link){ ACTIVE_BOOKING_LINK = (typeof link === 'string' ? link.trim() : ''); }
function getBookingLink(){ return ACTIVE_BOOKING_LINK; }

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
  // Rebuilt in place so anything holding a reference sees the change.
  VALID_STATUSES.length = 0;
  ACTIVE_PIPELINE.forEach(function(st){ VALID_STATUSES.push(st.key); });
}
function getPipeline(){ return ACTIVE_PIPELINE; }

// Unknown stages read as 'open' rather than throwing: a contact sitting on a
// stage an admin just deleted should keep getting followed up, not fall out of
// the system silently.
// Where a brand-new contact starts: the first open stage of whatever pipeline
// is configured, not the agency default's 'Booked'.
function defaultOpenStage(){
  for(var i = 0; i < ACTIVE_PIPELINE.length; i++){
    if((ACTIVE_PIPELINE[i].role || 'open') === 'open') return ACTIVE_PIPELINE[i].key;
  }
  return ACTIVE_PIPELINE.length ? ACTIVE_PIPELINE[0].key : 'Booked';
}

function pipelineHasStages(keys){
  for(var i = 0; i < keys.length; i++){
    var found = false;
    for(var j = 0; j < ACTIVE_PIPELINE.length; j++){
      if(ACTIVE_PIPELINE[j].key === keys[i]){ found = true; break; }
    }
    if(!found) return false;
  }
  return true;
}

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

// Kept in step with the active pipeline: the clients table builds its status
// filters from this, and a filter list showing another business's stages is
// both useless and confusing.
var VALID_STATUSES = buildDefaultPipeline().map(function(st){ return st.key; });

var STOP_1TO4 = {Completed:true,'No-show':true,Ghosted:true};

// How often a stalled no-show/reschedule nudge re-fires while nothing has
// changed — a reply that never turns into an actual date doesn't stop it.
var FOLLOWUP_REFIRE_DAYS = 4;

// Window for the T-1h reminder, in minutes before the call.
var HOURBEFORE_LEAD_MIN = 75;
var HOURBEFORE_FLOOR_MIN = 10;

/* ---- pause on reply ----
   Once someone writes back, they are in a conversation with a person, and
   firing the next scheduled template at them is the single most visible way a
   follow-up system annoys the people it exists to win over.

   So a logged reply pauses the automated cadence for a few days. It does not
   pause everything: a reply should never cancel a reminder for an appointment
   that is hours away. Those two stages are about a specific scheduled event
   rather than about nudging a quiet lead, and suppressing them would lose a
   call to a missing link.

   The pause expires rather than latching. Someone who replied and then went
   quiet again does need chasing, and a permanent pause would quietly turn
   every good conversation into a forgotten lead — the exact failure
   Ghost Recall exists to prevent. While paused the contact is not forgotten
   either: replying raises their Ghost Score, so they surface in Ghost Recall
   Today for a human to answer rather than for a template to fire. */
// Long-term nurture cadence. A month is deliberate: frequent enough that a
// lead who comes back around is caught within weeks, rare enough that it never
// reads as pestering.
var REVIVAL_EVERY_DAYS = 30;

/* How many long-term nudges surface in one day.

   Without a cap the first run dumps the entire backlog at once — on the live
   book that was 54 revival texts in a single morning, most to contacts who
   were never messaged at all. That is not nurture arriving, that is a mail
   merge, and it is the fastest way to get a number marked as spam.

   Five a day drains a 54-person backlog in under a fortnight while keeping
   any single day's list workable. The oldest silences go first, so the people
   closest to being lost are reached soonest. */
var REVIVAL_DAILY_CAP = 5;

var REPLY_PAUSE_DAYS = 3;
var PAUSE_EXEMPT_STAGES = {dayof: true, hourbefore: true};
// When more than one of these is due, the nearest-term one wins: 45 minutes
// out, the short link-first reminder beats the morning-of text.
var STAGE_PRIORITY = ['hourbefore', 'dayof'];

// When the automated cadence may resume, or null if nothing has been replied
// to. respondedAt is when the reply was LOGGED; for the replies recovered from
// Messages it is absent entirely, so those fall back to the send time and
// simply produce no pause rather than a fictional one.
function replyPauseUntil(client){
  var latest = null;
  (client.messageLog || []).forEach(function(m){
    if(!m.responded) return;
    var t = Date.parse(m.respondedAt || m.sentAt);
    if(!isNaN(t) && (latest === null || t > latest)) latest = t;
  });
  return latest === null ? null : latest + REPLY_PAUSE_DAYS * 86400000;
}


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

/* Why some ids carry -v2.

   The pooled learning table is keyed (stage, variant_key) GLOBALLY, across
   every account. When these starter texts were rewritten to stop assuming one
   industry, 18 of them changed wording while keeping their id — so an account
   seeded today and an account seeded last month would both report into
   (welcome, w1) while sending materially different messages, and the bandit
   would rank copy using numbers earned by copy that no longer exists.

   New wording is a new variant. The rewritten ones get new keys, so the old
   accounts keep contributing to the old rows and new accounts start their own.
   The ten that kept their exact text keep their keys, because for those the
   history is genuinely about the same message.

   Only pooled learning is affected either way: an account's own variant_stats
   are per-account rows, and existing accounts are never reseeded. */
function buildDefaultVariants(){
  return {
    welcome: [
      {id:'w1-v2', builtin:true, text:"Hey {name}, {sender} here. You're locked in for {date} at {time}. I'll come prepared with specifics for your situation rather than a general overview. Go ahead and block the time."},
      {id:'w2-v2', builtin:true, text:"Hi {name}, {sender} here. We're set for {date} at {time}. If there's something in particular you want covered, reply and I'll make sure we get to it."},
      {id:'w3', builtin:true, needsChannel:true, text:"Hey {name}, {sender} here. Got {channel} open and locked you in for {date} at {time}. Want to focus on the biggest leverage points for local search and discovery. Talk soon."}
    ],
    monday: [
      {id:'m1-v2', builtin:true, text:"Hey {name}, quick heads up that we're on for this {weekday} at {time}. Nothing needed from you beforehand — just keep it on the calendar."},
      {id:'m2-v2', builtin:true, text:"Hi {name}, hope the week's off to a good start. We're on for {weekday} at {time}. Say the word if the time stopped working and I'll move it."}
    ],
    midcheckin: [
      {id:'c1-v2', builtin:true, text:"Hey {name}, checking in ahead of {date}. Still a good time on your end?"},
      {id:'c2-v2', builtin:true, text:"Hi {name}, touching base before {date}. Let me know if anything shifted on your schedule and we'll find another slot."},
      {id:'c3', builtin:true, needsChannel:true, text:"Hey {name}, reviewing our plan for {channel} before {date}. Want to zone in on your local video packaging and CTR. Still all set?"},
      {id:'c4', builtin:true, text:"Hey {name}, quick schedule check for {date}. Drop a 👍 if that time still works and I'll see you then."}
    ],
    dayof: [
      {id:'d1-v2', builtin:true, text:"Hey {name}, hopping on at {time}. Here's the link: {link}"},
      {id:'d2-v2', builtin:true, text:"Hi {name}, ready for our call at {time}. Jump in here: {link}"},
      {id:'d3-v2', builtin:true, text:"Hey {name}, talk at {time}. Room link is here: {link}"},
      {id:'d4-v2', builtin:true, text:"Hi {name}, see you at {time}. Join here: {link}"}
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
      {id:'r1-v2', builtin:true, text:"Hey {name}, know your schedule gets crazy. Still want to get this on the calendar? Let me know if I should drop a couple of new times."},
      {id:'r2-v2', builtin:true, text:"Hi {name}, caught you at a busy stretch. If you still want to move ahead, send over a couple of open windows and I'll get us set."}
    ],
    noshow: [
      {id:'n1', builtin:true, text:"Hey {name}, missed you on {date}. No stress, it happens. What does later this week look like on your end?"},
      {id:'n2-v2', builtin:true, text:"Hi {name}, bummer we missed each other on {date}. Still happy to get you sorted — shoot me a time that works better and we can reset."},
      {id:'n3', builtin:true, needsChannel:true, text:"Hey {name}, missed you for our {date} spot, all good. Still want to dig into the growth side for {channel}. Let me know if you want to grab another time this week."}
    ],
    /* The slow lane. Sent roughly monthly, indefinitely, to anyone who never
       closed and never said no. Written to survive a long silence: it does not
       pretend to continue a conversation, it does not guilt anyone for going
       quiet, and it makes leaving easy — a nurture text that is hard to say no
       to stops being nurture and becomes harassment. */
    revival: [
      {id:'v1-v2', builtin:true, text:"Hey {name}, {sender} here. Been a while. If this is still on the list, happy to pick it back up. If not, no hard feelings and I'll leave you be."},
      {id:'v2', builtin:true, text:"Hi {name}, checking in after a while. Things change, so figured I'd ask: is this still something you're thinking about? A yes or a no both work."},
      {id:'v3', builtin:true, text:"Hey {name}, circling back one more time. If the timing is better now I can send over a couple of slots. If it's not, just say and I'll stop bugging you."}
    ],
    // Fires instead of "welcome" when a new booking is matched (by phone +
    // email) to a contact who already exists in the system but never actually
    // had a call with John (ghosted / no-showed / rescheduled and vanished) —
    // someone coming back around, not a stranger, so the tone skips the
    // introduction but still reads as a first real connection.
    rebooked: [
      {id:'rb1-v2', builtin:true, text:"Hey {name}, {sender} here. Glad we got this back on the calendar for {date} at {time}. Same plan as before — I'll come ready with specifics."},
      {id:'rb2-v2', builtin:true, text:"Hi {name}, saw the new time come through for {date} at {time}. Glad we're making it happen."}
    ],
    // Fires instead of "rebooked" when the prior contact's last known status
    // was Completed — they already had a real call with John, this is a
    // genuine second call, and the copy should read that way (not like
    // they're a stranger or a no-show finally showing up).
    followup: [
      {id:'f1-v2', builtin:true, text:"Hey {name}, good to pick this back up on {date} at {time}. I'll carry on from where we finished rather than starting over."},
      {id:'f2-v2', builtin:true, text:"Hi {name}, {sender} here. Glad we're back on the calendar for {date} at {time}. Let's pick up where we left off."}
    ]
  };
}


/* Pick the email version of a stage's message. Falls back to the built-in set
   when an account has not customised that stage, and returns null only when
   the stage has no email form at all — the caller then knows to offer a blank
   composer rather than silently sending nothing. */
/* When does this stage's email actually go out, in plain words.

   The editor is useless without it. "midcheckin" tells you nothing about
   whether you are writing a first hello or a last nudge, and a template
   written for the wrong moment reads worse than no template at all. Derived
   from the live sequence, so a business that moves a touch sees the label move
   with it rather than a description that quietly stops being true. */
function stageTiming(stage){
  var steps = getSequence();
  for(var i = 0; i < steps.length; i++){
    if(steps[i].stage === stage) return describeTrigger(steps[i].trigger);
  }
  // welcome wears three faces depending on who the contact is.
  if(stage === 'rebooked') return 'as soon as a past contact books again';
  if(stage === 'followup') return 'as soon as someone who already had a call books another';
  return 'when this touch comes due';
}

// Ordered the way the cadence runs, so the editor reads as a sequence rather
// than an alphabetical list of jargon.
function emailEditableStages(){
  var out = [];
  getSequence().forEach(function(step){ if(out.indexOf(step.stage) === -1) out.push(step.stage); });
  ['rebooked','followup'].forEach(function(st){ if(out.indexOf(st) === -1) out.push(st); });
  return out;
}


function emailVariantsFor(state, stage){
  var custom = state && state.emailVariants && state.emailVariants[stage];
  if(custom && custom.length) return custom;
  return buildDefaultEmailVariants()[stage] || null;
}

/* An email the business wrote itself, or nothing.

   Used by the unattended sender. The built-in templates are a starting point
   for the editor, not something to mail on somebody's behalf while they are
   not watching — a business should never discover that software has been
   sending its own words to its customers. Manual sending still offers the
   defaults, because there a person reads the draft before it goes.  */
function getAuthoredEmailDraft(state, client, stage, senderName){
  var list = (state && state.emailVariants && state.emailVariants[stage]) || [];
  var authored = list.filter(function(v){ return !v.builtin && (v.text || '').trim(); });
  if(!authored.length) return null;
  var v = authored[0];
  return {
    variantId: v.id,
    subject: renderTemplate(v.subject || '', client, senderName),
    text: renderTemplate(v.text || '', client, senderName)
  };
}

function getEmailDraft(state, client, stage, senderName){
  var list = emailVariantsFor(state, stage);
  if(!list || !list.length) return null;
  // Same bandit as SMS would be premature: there are no email sends to learn
  // from yet, and rotating copy nobody has measured just adds variance. First
  // variant until there is data, which is also how the SMS side started.
  var v = list[0];
  return {
    variantId: v.id,
    subject: renderTemplate(v.subject || '', client, senderName),
    text: renderTemplate(v.text || '', client, senderName)
  };
}


/* ---- email variants ----
   The same five touches, written for a different medium. A text is read on a
   lock screen in three seconds; an email is read in an inbox next to forty
   others, so it needs a subject line that survives a scan and a body that can
   afford a sentence of context.

   Kept deliberately short anyway. The failure mode for sales email is not
   being too brief, it is reading like a template — and the longer it gets the
   more obviously templated it looks.

   Same placeholders as the SMS variants, so renderTemplate needs no changes
   and a business editing one channel is not learning a second syntax. */
function buildDefaultEmailVariants(){
  /* Starting points, not sending copy.

     Drawn from MarketMakerMGMT's own sales document rather than invented:
     the reminder phrasing ("Here's the meeting link for our call today"), the
     positioning line ("not just for views, but as a tool for lead generation")
     and the subject-line register are theirs. Writing these fresh would have
     produced something that reads like software, and an email that reads like
     software is the one nobody answers.

     These are never sent automatically — the unattended sender skips any touch
     the business has not written itself. They exist so the editor opens with
     something to react to instead of a blank box, which is a much easier way
     to write. */
  return {
    welcome: [
      {id:'ew1', builtin:true, channel:'email',
       subject:'Confirmed: {date} at {time}',
       text:"Hi {name},\n\n{sender} here. You're locked in for {date} at {time}.\n\nWe help realtors and brands use YouTube not just for views, but as a tool for lead generation — so I'll come with specifics for your market rather than a generic pitch.\n\nIf there's one thing in particular you want covered, reply and I'll make sure we get to it.\n\n{sender}"},
      {id:'ew2', builtin:true, channel:'email',
       subject:'{date} at {time} — one question first',
       text:"Hi {name},\n\nGood to have you booked for {date} at {time}.\n\nSo the time is actually useful: what's the one thing you'd most want fixed about your channel right now? Even a sentence helps me prepare.\n\n{sender}"}
    ],
    monday: [
      {id:'em1', builtin:true, channel:'email',
       subject:'This {weekday} at {time}',
       text:"Hi {name},\n\nI hope you had a great start to the week. Quick note that we're on for {weekday} at {time}.\n\nNothing needed from you beforehand. If the time has stopped working, just say and I'll move it.\n\n{sender}"}
    ],
    midcheckin: [
      {id:'ec1', builtin:true, channel:'email',
       subject:'Still good for {date}?',
       text:"Hi {name},\n\nI hope your week is going well. Checking in ahead of {date} — still a good time on your end?\n\nIf something has shifted, no problem at all. Reply and we'll find another slot.\n\n{sender}"}
    ],
    dayof: [
      {id:'ed1', builtin:true, channel:'email',
       subject:'Today at {time}',
       text:"Hi {name},\n\nHere's the meeting link for our call today at {time}:\n\n{link}\n\nSee you shortly,\n{sender}"}
    ],
    hourbefore: [
      {id:'eh1', builtin:true, channel:'email',
       subject:'Starting soon — {time}',
       text:"Hi {name},\n\nWe're on in about an hour, at {time}. Link's here:\n\n{link}\n\n{sender}"}
    ],
    recovery: [
      {id:'er1', builtin:true, channel:'email',
       subject:'YouTube strategy ideas (spoke earlier)',
       text:"Hi {name},\n\nI know how weeks get. Is getting your channel working still something you want to look at?\n\nIf yes, send me a couple of times that work and I'll get us booked. If the timing has passed, tell me that too — I'd rather know than keep chasing.\n\n{sender}"}
    ],
    noshow: [
      {id:'en1', builtin:true, channel:'email',
       subject:'Missed you on {date}',
       text:"Hi {name},\n\nLooks like {date} got away from us. Happens.\n\nWhat does later this week look like for you?\n\n{sender}"}
    ],
    revival: [
      {id:'ev1', builtin:true, channel:'email',
       subject:'Still on your list?',
       text:"Hi {name},\n\nIt's been a while, so rather than guess I'll just ask: is YouTube still something you're planning to take seriously this year?\n\nIf yes, send me a couple of times and I'll get us booked. If not, tell me and I'll stop landing in your inbox — either answer is genuinely fine.\n\n{sender}"}
    ],
    rebooked: [
      {id:'erb1', builtin:true, channel:'email',
       subject:'Back on for {date} at {time}',
       text:"Hi {name},\n\nGlad we got this back on the calendar — {date} at {time}.\n\nSame plan as before: I'll come ready with specifics for your channel rather than a general overview.\n\n{sender}"}
    ],
    followup: [
      {id:'ef1', builtin:true, channel:'email',
       subject:'Picking up where we left off — {date}',
       text:"Hi {name},\n\nGood to have another one booked for {date} at {time}.\n\nI'll pick up from where we finished last time rather than starting over.\n\n{sender}"}
    ]
  };
}


/* ---- the email library ----

   Email is not the five-touch cadence in a different font.

   A text is a nudge: three seconds on a lock screen, timed to a call, one of
   five. Stage-keying it is exactly right. An email is a document — the pricing
   breakdown, the case study, the post-call recap, the onboarding walkthrough.
   It carries ten times the information, and it goes out when the conversation
   asks for it, not when a clock says touch three is due.

   Keying those to five stages did two bad things: the long ones had nowhere to
   live, and a good email could only be reached by whichever contact happened
   to be sitting at the matching stage. The library fixes both. It is flat and
   hand-ordered, each entry says in plain words when to send it, and any entry
   can be opened for any contact at any moment.

   What it deliberately is NOT: automated. Nothing here sends itself. These are
   documents a person picks, reads and sends — which is also why they can be as
   long as they need to be. */

/* A touch stage in English.

   stageLabel answers for PIPELINE stages (Booked, Completed) and returns the
   raw key for anything else, which is how a seeded library ended up titled
   "midcheckin email". These are the cadence's touches, a different vocabulary
   with a different audience: the person reading a library index. */
var TOUCH_LABELS = {
  welcome: 'Welcome', monday: 'Start of week', midcheckin: 'Mid-point check-in',
  dayof: 'Day of the call', hourbefore: 'An hour before', recovery: 'Recovery',
  noshow: 'After a no-show', revival: 'Long-term revival',
  rebooked: 'Rebooked', followup: 'Follow-up call'
};
function touchLabel(stage){
  if(TOUCH_LABELS[stage]) return TOUCH_LABELS[stage];
  // An admin's own stage key, made presentable rather than printed raw.
  var s = String(stage || '').replace(/[_-]+/g, ' ').trim();
  if(!s) return 'Untitled';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A library entry. Loose on input because these rows are hand-written and a
// missing subject or an untitled draft should survive a round trip, not vanish.
function sanitizeEmailDoc(raw, fallbackId){
  if(!raw || typeof raw !== 'object') return null;
  var title = (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim() : '';
  var subject = typeof raw.subject === 'string' ? raw.subject : '';
  var body = typeof raw.body === 'string' ? raw.body : '';
  // An entry with nothing in it at all is a discarded draft, not data.
  if(!title && !subject && !body.trim()) return null;
  return {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id : (fallbackId || uuid()),
    title: title || 'Untitled email',
    // Free text on purpose. "after they ask what it costs" is a real answer
    // and is not one of five stages — that constraint is the thing being
    // removed here.
    whenToSend: typeof raw.whenToSend === 'string' ? raw.whenToSend.trim() : '',
    subject: subject,
    body: body,
    /* Optionally pinned to one of the five touches.

       Sending a text is one tap: the message is already written, you press
       send. Email cost two extra clicks, because every send went through a
       picker. The picker exists because a library is a real choice — but in
       practice the same email goes out for the same touch nearly every time,
       and making someone re-make a decision they have already made is exactly
       the friction that stops a channel being used.

       Pin one here and the Email button on that touch opens it directly.
       Leave it empty and the picker still appears, which is what you want for
       a pricing breakdown that goes out whenever it is asked for. */
    touch: (typeof raw.touch === 'string' && raw.touch) ? raw.touch : '',
    sortOrder: Number.isFinite(raw.sortOrder) ? raw.sortOrder : 0,
    archived: !!raw.archived,
    updatedAt: (typeof raw.updatedAt === 'string' && !isNaN(Date.parse(raw.updatedAt))) ? raw.updatedAt : nowISO()
  };
}

/* The library in the order the business put it in.

   sortOrder first, then title, so two entries that were never reordered still
   come out in a stable order rather than whatever the database felt like. */
function emailLibrary(state, opts){
  var includeArchived = !!(opts && opts.includeArchived);
  var raw = (state && state.emailLibrary) || [];
  var docs = [];
  for(var i = 0; i < raw.length; i++){
    var d = sanitizeEmailDoc(raw[i]);
    if(d && (includeArchived || !d.archived)) docs.push(d);
  }
  docs.sort(function(a, b){
    if(a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.title.localeCompare(b.title);
  });
  return docs;
}

/* Turn the old stage-keyed emails into library entries.

   Run once, when an account has emails written against stages but no library
   yet. Without this, moving email off the cadence would look to the business
   exactly like their email copy being deleted — which is the single worst
   thing a migration can do, and the reason the `variants` rows are left in
   place rather than dropped.

   Only what the business actually wrote. Seeding the built-in starting points
   into the library would fill it with software's words on day one and bury the
   two emails they cared about. */
function seedEmailLibrary(emailVariants){
  var out = [];
  var order = emailEditableStages();
  var seen = {};
  function take(stage){
    if(seen[stage]) return;
    seen[stage] = true;
    var list = (emailVariants && emailVariants[stage]) || [];
    for(var i = 0; i < list.length; i++){
      var v = list[i];
      if(v.builtin) continue;
      if(!(v.text || '').trim() && !(v.subject || '').trim()) continue;
      out.push(sanitizeEmailDoc({
        id: v.id,
        title: touchLabel(stage) + ' email',
        // The stage's timing, preserved as the label — so an email written for
        // a specific moment does not lose the only note saying which moment.
        whenToSend: stageTiming(stage),
        subject: v.subject || '',
        body: v.text || '',
        sortOrder: out.length * 10
      }));
    }
  }
  order.forEach(take);
  Object.keys(emailVariants || {}).forEach(take);
  return out.filter(Boolean);
}

/* Starter emails, for a library that has nothing in it.

   seedEmailLibrary only carries across emails somebody already wrote against
   the old touches. A business signing up today has written none, so it opens
   the Emails tab, finds it completely empty, and has to work out both what
   belongs there and how to write it before the tab does anything at all. That
   is the single worst moment in the app for somebody new.

   These are deliberately DRAFTS, not finished copy. Every one has a
   [BRACKETED] gap that only the business can fill, and the preview already
   highlights those as "Still unfilled", so nobody can send one untouched
   without being told first.

   The brackets are UPPERCASE on purpose. The preview's leftover check is
   /\{\w+\}|\[[A-Z][^\]]*\]/ - it only catches a capitalised placeholder, so
   lowercase gaps would have rendered looking finished and the whole guarantee
   above would have been worthless. Caught by a test that ran the real check
   rather than restating the rule.

   They also have to survive a contact with NO call booked, which is a real
   case: an introduction email often goes out before any date is set. {date}
   renders as nothing at all there, so "Ahead of {date}" collapsed to an empty
   subject line, and {when} falls back to "soon", which turned "we had {when}
   in the diary" into "we had soon in the diary". The copy below therefore
   uses {when} only where "soon" also reads correctly, and keeps every subject
   line free of dates. They are written for any business that books
   appointments - no industry, no company name, no pricing.

   Nothing here can go out on its own. None is pinned to a touch, so none is
   attached to the one-click send on a Today card until the business picks it,
   and the unattended sender reads the variants table rather than the library,
   so these words can never be mailed without a person pressing send. */
function starterEmailLibrary(){
  var starters = [
    {
      title: 'Before the call',
      whenToSend: 'the day before, once the time is set',
      subject: 'Ahead of our call',
      body: 'Hi {name},\n\n' +
        'Looking forward to speaking {when}. So you know what to expect, we will cover:\n\n' +
        '- [THE FIRST THING YOU ALWAYS COVER]\n' +
        '- [THE SECOND THING]\n' +
        '- what it would look like for you specifically\n\n' +
        'Nothing to prepare. If anything has changed, just reply and we will move it.\n\n' +
        '{sender}'
    },
    {
      title: 'Recap after the call',
      whenToSend: 'same day, while it is still fresh',
      subject: 'Recap of our call',
      body: 'Hi {name},\n\n' +
        'Good speaking with you. The short version of what we covered:\n\n' +
        '{recap}\n\n' +
        'The next step is [WHAT HAPPENS NEXT], and I will [WHAT YOU WILL DO] by ' +
        '[WHEN YOU WILL DO IT].\n\n' +
        'Anything I have missed, tell me and I will correct it.\n\n' +
        '{sender}'
    },
    {
      title: 'What it costs',
      whenToSend: 'when they ask about price',
      subject: 'The numbers, in writing',
      body: 'Hi {name},\n\n' +
        'Putting this in writing so you can look at it properly rather than ' +
        'remember it from a call.\n\n' +
        '[OPTION ONE] - [PRICE]. [WHO THIS IS RIGHT FOR.]\n' +
        '[OPTION TWO] - [PRICE]. [WHO THIS IS RIGHT FOR.]\n\n' +
        'What is included either way: [THE THINGS THAT DO NOT CHANGE].\n\n' +
        'Happy to go through any of it. If you want to get started, here is the ' +
        'link: [YOUR PAYMENT OR BOOKING LINK]\n\n' +
        '{sender}'
    },
    {
      title: 'They did not show',
      whenToSend: 'an hour or two after a missed appointment',
      subject: 'Sorry we missed each other',
      body: 'Hi {name},\n\n' +
        'We had time set aside and I did not manage to reach you - no problem ' +
        'at all, these things happen.\n\n' +
        'If you still want to look at [THE THING THEY CAME FOR], pick any time ' +
        'that suits: {bookinglink}\n\n' +
        'And if the timing is wrong at the moment, say so and I will stop ' +
        'chasing you.\n\n' +
        '{sender}'
    },
    {
      title: 'Checking back in later',
      whenToSend: 'weeks or months after it went quiet',
      subject: 'Still thinking about [THE THING]?',
      body: 'Hi {name},\n\n' +
        'It has been a while since we spoke about [WHAT THEY WERE CONSIDERING]. ' +
        'Not chasing - just [A REASON THIS IS WORTH A SECOND LOOK NOW].\n\n' +
        'If it is still on your list, here is a time: {bookinglink}\n\n' +
        'If it is not, reply "not now" and I will leave you be.\n\n' +
        '{sender}'
    }
  ];
  return starters.map(function(d, i){
    return sanitizeEmailDoc({
      id: 'starter-' + (i + 1),
      title: d.title,
      whenToSend: d.whenToSend,
      subject: d.subject,
      body: d.body,
      sortOrder: i * 10
    });
  }).filter(Boolean);
}

/* The email pinned to a touch, if there is one.

   First match in library order, so if two are pinned to the same touch the
   one the business put first wins — a stable answer rather than whichever
   the database returned. */
function emailForTouch(state, stage){
  if(!stage) return null;
  var docs = emailLibrary(state);
  for(var i = 0; i < docs.length; i++){
    if(docs[i].touch === stage) return docs[i];
  }
  return null;
}

/* One library entry, filled in for a contact.

   Same renderTemplate and the same placeholders as everything else, so nobody
   learns a second syntax and an email moved into the library keeps working.
   Returns null for a missing entry rather than an empty draft, so the caller
   can say "that email is gone" instead of opening a blank compose window. */
function renderEmailDoc(state, docId, client, senderName){
  var docs = emailLibrary(state, {includeArchived: true});
  var doc = null;
  for(var i = 0; i < docs.length; i++){ if(docs[i].id === docId){ doc = docs[i]; break; } }
  if(!doc) return null;
  return {
    id: doc.id,
    title: doc.title,
    whenToSend: doc.whenToSend,
    subject: renderTemplate(doc.subject || '', client, senderName),
    text: renderTemplate(doc.body || '', client, senderName)
  };
}

/* The whole library as one plain-text document.

   Copy a business wrote should never be trapped in someone else's web app.
   This is the answer to "what if I stop paying for this" and to the much more
   common "I want to send these to the new hire" — and writing it costs almost
   nothing, which is the whole argument for having it.

   Plain text rather than JSON or CSV: a person opens this, and the placeholders
   have to stay visible and legible for it to be worth anything. Unrendered on
   purpose — this is the template set, not one contact's mail. */
function exportEmailLibrary(state, opts){
  var docs = emailLibrary(state, opts);
  var who = (opts && opts.businessName) || '';
  var lines = [];
  lines.push(who ? (who + ' — email library') : 'Email library');
  lines.push('Exported ' + (new Date()).toISOString().slice(0, 10) + ' from Ghost Recall');
  lines.push(docs.length === 1 ? '1 email' : (docs.length + ' emails'));
  lines.push('');
  lines.push('Placeholders are left as written: {name} {date} {time} {weekday} {link} {sender}');
  lines.push('');
  docs.forEach(function(d, i){
    lines.push('════════════════════════════════════════════════════');
    lines.push((i + 1) + '. ' + d.title);
    lines.push('════════════════════════════════════════════════════');
    lines.push('WHEN TO SEND:  ' + (d.whenToSend || '(not noted)'));
    lines.push('SUBJECT:       ' + (d.subject || '(none)'));
    lines.push('');
    lines.push(d.body || '(empty)');
    lines.push('');
  });
  if(!docs.length) lines.push('(The library is empty — nothing to export yet.)');
  return lines.join('\n');
}

// One entry on its own, for handing a single email to someone.
function exportEmailDoc(doc){
  if(!doc) return '';
  return [
    doc.title || 'Untitled email',
    'When to send: ' + (doc.whenToSend || '(not noted)'),
    'Subject: ' + (doc.subject || '(none)'),
    '',
    doc.body || ''
  ].join('\n');
}

/* A filename someone can find again in their Downloads folder.

   "export.txt" is where a file goes to be lost. Dated and named after the
   business, and stripped of anything a filesystem will argue about. */
function exportFilename(base, when){
  var d = when ? new Date(when) : new Date();
  var stamp = isNaN(d.getTime()) ? 'undated' : d.toISOString().slice(0, 10);
  var safe = String(base || 'ghost recall')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'ghost recall';
  return safe + '-' + stamp + '.txt';
}


/* Is the calendar still actually syncing?

   Nobody should learn their calendar connection died by noticing, weeks
   later, that no new bookings arrived. That is what happened to three people
   in a row, and "press Sync and read the message" only helps someone who
   already suspects something is wrong.

   The reason this matters more than it should: while the Google consent
   screen is in Testing mode, Google expires every refresh token after 7 days.
   So a working account silently stops syncing roughly weekly, through no
   fault of anyone using it. Pushing the consent screen to production is the
   real fix and it is not a code change — but until it happens, and for the
   ordinary revoked-access case afterwards, this is what turns a silent
   outage into a sentence on screen.

   The cron runs twice a day, so a gap beyond STALE_AFTER_HOURS means a sync
   has failed rather than merely not been due. */
var STALE_AFTER_HOURS = 36;
// A connection made moments ago has not synced yet, and that is not a fault.
var GRACE_AFTER_CONNECT_HOURS = 2;

function calendarHealth(connections, now){
  var at = now ? now.getTime() : Date.now();
  var conns = Array.isArray(connections) ? connections : [];
  if(!conns.length) return {state: 'none', stale: [], hoursSince: null};

  var stale = [];
  var freshest = null;

  for(var i = 0; i < conns.length; i++){
    var c = conns[i] || {};
    var last = c.lastSync ? Date.parse(c.lastSync) : NaN;
    var connected = c.connectedAt ? Date.parse(c.connectedAt) : NaN;

    if(isNaN(last)){
      // Never synced. Only a problem once it has had time to happen.
      if(!isNaN(connected) && (at - connected) > GRACE_AFTER_CONNECT_HOURS * 3600000){
        stale.push({calendar: c.calendarId || '', hours: null});
      }
      continue;
    }
    if(freshest === null || last > freshest) freshest = last;
    var hours = (at - last) / 3600000;
    if(hours > STALE_AFTER_HOURS) stale.push({calendar: c.calendarId || '', hours: hours});
  }

  return {
    state: stale.length ? (stale.length === conns.length ? 'stale' : 'partial') : 'ok',
    stale: stale,
    hoursSince: freshest === null ? null : (at - freshest) / 3600000
  };
}

/* What to tell someone about it, in their words rather than ours.

   Deliberately does NOT say "token expired": that is true, unhelpful, and
   nobody outside this codebase knows what it means. It says what stopped and
   what to press. */
function describeCalendarHealth(health){
  if(!health || health.state === 'ok' || health.state === 'none') return null;

  var never = health.stale.some(function(s){ return s.hours === null; });
  if(never && health.state === 'stale'){
    return {
      severity: 'warn',
      text: 'Your calendar is connected but has never finished a sync, so no ' +
            termLower('appointmentPlural') + ' have come in yet.',
      action: 'Sync now'
    };
  }

  var days = Math.floor((health.hoursSince || 0) / 24);
  var ago = health.hoursSince === null ? ''
    : (days >= 1 ? (days === 1 ? ' since yesterday' : ' for ' + days + ' days') : ' today');

  if(health.state === 'partial'){
    return {
      severity: 'warn',
      text: 'One of your calendars has stopped syncing. New ' +
            termLower('contactPlural') + ' from it will not appear until it is reconnected.',
      action: 'Sync now'
    };
  }

  return {
    severity: 'error',
    text: 'Your calendar has not synced' + ago + ', so new ' +
          termLower('appointmentPlural') + ' are not reaching Ghost Recall. ' +
          'Google disconnects calendars periodically — reconnecting takes a few seconds.',
    action: 'Reconnect calendar'
  };
}


/* Draft a follow-up from what was actually said on the call.

   The existing AI drafting rewrites one cadence touch in the business's
   voice. This is a different job: the input is a page of notes from a call
   that just happened, and the output has to be specific to that conversation
   — the thing a generic template can never be.

   Built here rather than in the render layer so it can be tested. The voice
   examples are the business's OWN messages, which is what stops the model
   writing like software: for email that is the library, for text the
   variants. Without them the model reverts to the register of every sales
   email ever written, which is the one thing nobody answers.

   Explicitly forbidden from inventing: notes are shorthand, and a model
   filling gaps in shorthand produces confident sentences about things that
   were never said — which the customer then reads and corrects, or worse,
   believes. */
function buildNotesPrompt(opts){
  opts = opts || {};
  var client = opts.client || {};
  var notes = String(opts.notes || '').trim();
  var channel = opts.channel === 'sms' ? 'sms' : 'email';
  var sender = opts.senderName || 'the sender';
  var examples = (opts.examples || []).filter(function(t){ return (t || '').trim(); }).slice(0, 3);

  var lines = [];
  lines.push(channel === 'sms'
    ? 'Draft ONE short follow-up text message for ' + sender + ' to send to ' +
      firstName(client.name || 'them') + ' after a call that has just happened.'
    : 'Draft ONE follow-up email for ' + sender + ' to send to ' +
      firstName(client.name || 'them') + ' after a call that has just happened.');

  lines.push('These are ' + sender + "'s notes from that call. Everything in the message must come from them:");
  lines.push(notes);

  if(examples.length){
    lines.push("Match " + sender + "'s voice, shown in messages they actually send:");
    lines.push(examples.map(function(t){ return '- "' + t.replace(/\s+/g, ' ').slice(0, 400) + '"'; }).join('\n'));
  }

  lines.push(channel === 'sms'
    ? 'Short enough to read on a lock screen. Casual and warm, the way a person texts. No subject line, no greeting block, no sign-off beyond a name if the examples use one.'
    : 'Open with one line that shows you were listening, then the substance, then a clear next step. No corporate phrasing. Start with a subject line on its own first line, prefixed exactly "Subject: ", then a blank line, then the email.');

  lines.push('Use only what is in the notes. Do not invent details, numbers, promises, dates or names that are not there — if the notes are thin, write a shorter message rather than filling the gap.');
  lines.push('Output only the message itself. No preamble, no explanation, no quotes around it.');

  return lines.join('\n\n');
}

/* Split "Subject: ...\n\nbody" into its two halves.

   The model is asked for that shape, and mostly obliges. When it does not,
   the whole thing becomes the body rather than the first line being silently
   promoted into a subject line — a paragraph in the subject field is a far
   more visible failure than a missing one. */
function splitDraftedEmail(text){
  var raw = String(text || '').trim();
  var m = raw.match(/^subject:\s*(.+?)\s*\n([\s\S]*)$/i);
  if(!m) return {subject: '', text: raw};
  return {subject: m[1].trim(), text: m[2].trim()};
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
      reviewed: (typeof m.reviewed === 'boolean') ? m.reviewed : !!m.responded,
      /* Channel and provider id survive sanitising.

         They did not, and the consequences spread further than they look. An
         email came out the other side indistinguishable from a text, so the
         reply rate counted it in a denominator it could never join -- on a
         book where 3 of 10 texts were answered, one library email each took
         the rate from 30% to 15%, with nobody replying any less. The
         manual-versus-observed labelling could never report "confirmed",
         because the provider id it reads was already gone. And any path that
         sanitised before saving would have written every email back as a
         text, which is the version of this bug that destroys records rather
         than just miscounting them.

         Defaulting channel to 'sms' is right for history: every message
         predating the email channel was a text. */
      channel: (m.channel === 'email' || m.channel === 'sms') ? m.channel : 'sms',
      providerId: typeof m.providerId === 'string' ? m.providerId : null
    };
  }) : [];
  return {
    id: id,
    googleEventId: typeof raw.googleEventId === 'string' ? raw.googleEventId : null,
    organizerEmail: typeof raw.organizerEmail === 'string' ? raw.organizerEmail : null,
    emailStatus: typeof raw.emailStatus === 'string' ? raw.emailStatus : 'ok',
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'Unknown',
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    youtubeLink: typeof raw.youtubeLink === 'string' ? raw.youtubeLink : '',
    meetLink: typeof raw.meetLink === 'string' ? raw.meetLink : '',
    callDateTime: (typeof raw.callDateTime === 'string' && !isNaN(Date.parse(raw.callDateTime))) ? raw.callDateTime : null,
    bookedDate: (typeof raw.bookedDate === 'string' && !isNaN(Date.parse(raw.bookedDate))) ? raw.bookedDate : nowISO(),
    timezone: resolveClientTimezone(raw),
    timezoneConfirmed: raw.timezoneConfirmed === true,
    /* A status is preserved as-is whenever it is a real string.

       This used to check against VALID_STATUSES — which is derived from the
       DEFAULT pipeline — and rewrite anything else to 'Booked'. On a custom
       pipeline that silently reset every contact's outcome on every load: an
       HVAC company's whole book would come back as Booked each time the app
       opened, destroying real data on read.

       Validating against the ACTIVE pipeline would be better but still wrong,
       because it would discard a contact's stage the moment an admin renamed
       it. Unknown stages already behave sanely — stageRole treats them as
       'open', so the contact keeps getting followed up — which is a far better
       failure than losing the value. */
    status: (typeof raw.status === 'string' && raw.status) ? raw.status : defaultOpenStage(),
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
    skippedStages: sanitizeSkipped(raw.skippedStages),
    rebooked: !!raw.rebooked,
    hadPriorCall: !!raw.hadPriorCall
  };
}

// Same defensive shape as snoozedUntil: anything that is not a stage mapped to
// a timestamp is dropped rather than trusted.
function sanitizeSkipped(raw){
  var out = {};
  if(raw && typeof raw === 'object'){
    Object.keys(raw).forEach(function(stage){
      if(typeof raw[stage] === 'string' && raw[stage]) out[stage] = raw[stage];
    });
  }
  return out;
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

// When the current appointment was last moved, or null if it never has been.
// recordReschedule stamps these at the moment the change is seen, so the most
// recent one marks the start of "this appointment" as distinct from the one
// that was booked before it.
function appointmentSetAt(client){
  var rs = client.reschedules || [];
  if(!rs.length) return null;
  var last = Date.parse(rs[rs.length - 1]);
  return isNaN(last) ? null : last;
}

/* Has this stage been sent FOR THE CURRENT APPOINTMENT?

   hasSentStage asks whether a stage was ever sent, which silently breaks the
   moment a call moves. A day-of text goes out, the client reschedules three
   weeks later, and the new date never gets one — the stage is marked sent
   forever. On the live book that had stranded 11 upcoming clients, including
   one whose day-of text was sent on 19 August for a call on 24 September.

   Appointment-anchored touches therefore only count sends made since the
   appointment was last moved. Touches anchored to the contact rather than the
   appointment — the welcome — deliberately keep using hasSentStage: somebody
   rescheduling does not make them a stranger again. */
function hasSentStageThisAppointment(client, stage){
  var since = appointmentSetAt(client);
  if(since === null) return hasSentStage(client, stage);
  return client.messageLog.some(function(m){
    if(m.stage !== stage) return false;
    var t = Date.parse(m.sentAt);
    return !isNaN(t) && t >= since;
  });
}

// A null stage means "the last time anything was sent", which is what a
// long-term nudge measures: silence, not distance from one particular touch.
function lastSentAtMs(client, stage){
  var latest = null;
  client.messageLog.forEach(function(m){
    if(stage === null || m.stage === stage){
      var t = Date.parse(m.sentAt);
      if(!isNaN(t) && (latest===null || t>latest)) latest = t;
    }
  });
  return latest;
}


/* ---- the cadence, as data ----
   computeDue was eight hard-coded rules. A business could rename its stages
   but not change WHEN Ghost Recall follows up, which was the last assumption
   welding the engine to one company's process: an HVAC shop chasing an
   estimate does not want a "Monday of the call week" text, and a recruiter
   might want four touches in the first week rather than one.

   A sequence is a list of steps, each naming a stage and a trigger. Triggers
   are a small closed set rather than free-form expressions — enough to
   express every existing rule and the obvious variations, without becoming a
   scripting language nobody can safely edit through a settings form:

     on_create                      once, when the contact appears
     weekday_of_appointment_week    e.g. the Monday before the call
     midpoint_booked_to_appointment halfway between booking and the call
     day_of_appointment             on the day itself
     minutes_before_appointment     a narrow clock-granular window
     repeat_while_role              re-fires every N days while a role holds

   buildDefaultSequence reproduces today's cadence exactly. That is the whole
   safety argument for this refactor: the existing computeDue tests are
   extensive and were written against the hard-coded rules, so if they all
   still pass, the data-driven evaluator agrees with the code it replaced. */
function buildDefaultSequence(){
  return [
    {key:'welcome',    stage:'welcome',    trigger:{type:'on_create'}},
    {key:'monday',     stage:'monday',     trigger:{type:'weekday_of_appointment_week'}},
    {key:'midcheckin', stage:'midcheckin', trigger:{type:'midpoint_booked_to_appointment'}},
    {key:'dayof',      stage:'dayof',      trigger:{type:'day_of_appointment'}},
    {key:'hourbefore', stage:'hourbefore', trigger:{type:'minutes_before_appointment',
                                                   leadMin: HOURBEFORE_LEAD_MIN, floorMin: HOURBEFORE_FLOOR_MIN}},
    {key:'recovery',   stage:'recovery',   trigger:{type:'repeat_while_role', roles:['stalled','lost'],
                                                   anchor:'stalled', afterDays:2, everyDays: FOLLOWUP_REFIRE_DAYS}},
    {key:'noshow',     stage:'noshow',     trigger:{type:'repeat_while_role', roles:['missed'],
                                                   anchor:'appointment', afterDays:0,
                                                   everyDays: FOLLOWUP_REFIRE_DAYS, windowDays:14}},
    /* Long-term nurture, and the point of the whole product: a lead that went
       quiet is not a lead that said no. The intensive sequences above run out
       after a fortnight and used to leave contacts in the Graveyard, never
       contacted again — 67 people on the live book. This keeps going roughly
       monthly, indefinitely, for anyone who never closed and never refused.
       Slow enough not to be a nuisance, permanent enough that nobody is
       forgotten. */
    {key:'revival',    stage:'revival',    trigger:{type:'repeat_while_role',
                                                   roles:['stalled','lost','missed','won'],
                                                   unlessClosed: true, anchor:'lastContact',
                                                   afterDays: REVIVAL_EVERY_DAYS,
                                                   everyDays: REVIVAL_EVERY_DAYS}}
  ];
}

// Plain-English rendering of a trigger, so a settings form can show a cadence
// without anyone learning the trigger vocabulary.
function describeTrigger(trigger){
  var t = trigger || {};
  switch(t.type){
    case 'on_create': return 'as soon as they come in';
    case 'weekday_of_appointment_week': return 'earlier in the week of the appointment';
    case 'midpoint_booked_to_appointment': return 'halfway between booking and the appointment';
    case 'day_of_appointment': return 'on the day of the appointment';
    case 'minutes_before_appointment':
      return 'about ' + (t.leadMin || 60) + ' minutes before the appointment';
    case 'days_before_appointment':
      return (t.days || 1) + ' day' + ((t.days || 1) === 1 ? '' : 's') + ' before the appointment';
    case 'days_after_create':
      return (t.days || 0) + ' day' + ((t.days || 0) === 1 ? '' : 's') + ' after they come in';
    case 'repeat_while_role':
      return 'every ' + (t.everyDays || 1) + ' days while ' + (t.roles || []).join(' or ') +
        (typeof t.windowDays === 'number' ? ', for up to ' + t.windowDays + ' days' : '');
  }
  return 'custom trigger';
}

var ACTIVE_SEQUENCE = buildDefaultSequence();

function setSequence(steps){
  ACTIVE_SEQUENCE = (Array.isArray(steps) && steps.length)
    ? steps.filter(function(st){ return st && st.stage && st.trigger && st.trigger.type; })
    : buildDefaultSequence();
  if(!ACTIVE_SEQUENCE.length) ACTIVE_SEQUENCE = buildDefaultSequence();
}
function getSequence(){ return ACTIVE_SEQUENCE; }

// True when this step is due right now. Pure: no state, no side effects, so
// each trigger type can be reasoned about and tested on its own.
function stepIsDue(step, client, now, ctx){
  var t = step.trigger || {};
  var stage = step.stage;

  // repeat_while_role steps run on their own schedule and are the only ones
  // that fire after a contact's cadence has otherwise stopped — a no-show
  // rescue exists precisely because the appointment cadence ended.
  if(t.type === 'repeat_while_role'){
    var roles = t.roles || [];
    if(roles.indexOf(stageRole(client.status)) === -1) return false;
    // A closed deal is the one outcome that ends the relationship on purpose.
    // Nurturing someone who already bought is the fastest way to make a
    // nurture sequence feel like spam.
    if(t.unlessClosed && client.closeOutcome === 'Closed') return false;
    var anchorMs;
    if(t.anchor === 'stalled'){
      anchorMs = client.stalledSince ? Date.parse(client.stalledSince) : NaN;
    } else if(t.anchor === 'lastContact'){
      // Anchored to the last time anything was sent, whatever the stage, so a
      // long-term nudge measures silence rather than distance from one event.
      // Falls back to the appointment for a contact never messaged at all.
      var lastAny = null;
      (client.messageLog || []).forEach(function(m){
        var mt = Date.parse(m.sentAt);
        if(!isNaN(mt) && (lastAny === null || mt > lastAny)) lastAny = mt;
      });
      anchorMs = lastAny !== null ? lastAny : (ctx.callDate ? ctx.callDate.getTime() : NaN);
    } else {
      anchorMs = ctx.callDate ? ctx.callDate.getTime() : NaN;
    }
    if(isNaN(anchorMs)) return false;
    var daysSince = (now.getTime() - anchorMs) / 86400000;
    if(daysSince < (t.afterDays || 0)) return false;
    if(typeof t.windowDays === 'number' && daysSince > t.windowDays) return false;
    var lastSent = lastSentAtMs(client, stage);
    return lastSent === null || (now.getTime() - lastSent) / 86400000 >= (t.everyDays || 1);
  }

  // Everything below is a once-only touch on the way to an appointment, so it
  // stops as soon as the appointment is resolved and never repeats.
  if(ctx.stopCadence) return false;

  /* The run-up is over once the appointment has happened.

     Every other trigger bound itself to a future date as a side effect of how
     it was written — weekday_of_appointment_week requires today < callKey,
     day_of_appointment requires today === callKey — but 'on_create' returned
     true unconditionally. So a contact whose call was weeks ago and whose
     outcome was never logged kept a welcome text queued indefinitely,
     promising to meet them on a date that had already passed. Johnny saw
     exactly that.

     stopCadence does not cover it: that only fires once someone records an
     outcome, and the whole problem is contacts nobody has recorded one for.
     They belong in End of day as overdue and unlogged, not in the morning
     send list.

     Contact-anchored triggers are deliberately exempt. days_after_create is
     about how long someone has been in the system, not about a meeting, and a
     contact with no appointment at all still needs welcoming. */
  var RUNUP_TRIGGERS = {
    on_create: true, weekday_of_appointment_week: true,
    midpoint_booked_to_appointment: true, day_of_appointment: true,
    minutes_before_appointment: true, days_before_appointment: true
  };
  if(RUNUP_TRIGGERS[t.type] && ctx.callDate && ctx.callDate.getTime() <= now.getTime()) return false;
  // 'on_create' is anchored to the contact, not the appointment: rescheduling
  // does not make someone a stranger who needs welcoming again.
  var alreadySent = (t.type === 'on_create')
    ? hasSentStage(client, stage)
    : hasSentStageThisAppointment(client, stage);
  if(alreadySent) return false;

  switch(t.type){
    case 'on_create':
      return true;

    case 'weekday_of_appointment_week': {
      if(!ctx.callKey) return false;
      var weekStart = mondayOfWeekKey(ctx.callKey);
      // Only meaningful when the call is later in its own week; a Monday call
      // has no "Monday before it".
      return weekStart < ctx.callKey && ctx.todayKey >= weekStart && ctx.todayKey < ctx.callKey;
    }

    case 'midpoint_booked_to_appointment': {
      if(!ctx.callKey || !ctx.bookedDate) return false;
      var midMs = (ctx.bookedDate.getTime() + ctx.callDate.getTime()) / 2;
      var midKey = tzDateKey(new Date(midMs), ctx.tz);
      return ctx.todayKey >= midKey && ctx.todayKey <= keyPlusDays(ctx.callKey, -1);
    }

    case 'day_of_appointment':
      return !!ctx.callKey && ctx.todayKey === ctx.callKey;

    case 'minutes_before_appointment': {
      if(!ctx.callDate) return false;
      var mins = (ctx.callDate.getTime() - now.getTime()) / 60000;
      return mins <= (t.leadMin || 60) && mins >= (t.floorMin || 0);
    }

    case 'days_before_appointment': {
      if(!ctx.callKey) return false;
      return ctx.todayKey === keyPlusDays(ctx.callKey, -(t.days || 1));
    }

    case 'days_after_create': {
      if(!ctx.bookedDate) return false;
      var since = (now.getTime() - ctx.bookedDate.getTime()) / 86400000;
      return since >= (t.days || 0);
    }
  }
  // An unrecognised trigger never fires. Silently doing nothing is the safe
  // failure here: guessing would send real texts on a schedule nobody chose.
  return false;
}


function computeDue(client, now){
  now = now || new Date();
  if(!client || client.ignored) return [];
  var due = [];
  var tz = client.timezone || 'America/New_York';
  var callDate = safeDate(client.callDateTime);
  var ctx = {
    tz: tz,
    todayKey: tzDateKey(now, tz),
    callDate: callDate,
    callKey: callDate ? tzDateKey(callDate, tz) : null,
    bookedDate: safeDate(client.bookedDate),
    stopCadence: stopsCadence(client.status)
  };

  ACTIVE_SEQUENCE.forEach(function(step){
    // The first touch has three faces depending on who this is: a stranger
    // (welcome), someone who booked before and never showed (rebooked), or
    // someone who already had a real call and is back for another (followup).
    // The choice is about the contact's history rather than about timing, so
    // it stays here rather than becoming three near-identical sequence steps
    // a business would have to keep in sync.
    var stage = step.stage;
    if(step.trigger.type === 'on_create' && stage === 'welcome' && client.rebooked){
      stage = client.hadPriorCall ? 'followup' : 'rebooked';
    }
    var effective = (stage === step.stage) ? step : {key: step.key, stage: stage, trigger: step.trigger};
    if(stepIsDue(effective, client, now, ctx)) due.push(stage);
  });

  // "Not today" is an explicit, one-day-only deferral, not a way to bury a
  // touch — it self-expires the moment the snoozed-until date is reached.
  var snoozed = client.snoozedUntil || {};
  due = due.filter(function(stage){ return !(snoozed[stage] && ctx.todayKey < snoozed[stage]); });

  // Deliberately skipped for this contact, for good. Unlike a snooze this
  // never expires: it is an answer, not a deferral.
  var skipped = client.skippedStages || {};
  due = due.filter(function(stage){ return !skipped[stage]; });

  // They wrote back: hold the automated nudges, keep the appointment-critical
  // reminders. See replyPauseUntil.
  var pauseUntil = replyPauseUntil(client);
  if(pauseUntil !== null && now.getTime() < pauseUntil){
    due = due.filter(function(stage){ return !!PAUSE_EXEMPT_STAGES[stage]; });
  }

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
    /* Never another real person's name.

       This fell back to 'Johnny'. On any other account that means a text
       going to a stranger's customer signed with the name of a person at a
       different company — confidently, invisibly, and unfixably once sent.
       An obvious placeholder is embarrassing for one message; the wrong real
       name is a different category of wrong.

       data.js derives this from the account's own email, so the fallback is a
       last resort rather than a normal path. */
    sender: senderName || 'your name',
    /* Empty when there is no appointment, and tidyTemplate then removes the
       preposition that was leading up to it.

       These must NOT invent a day. A welcome touch fires for a contact with
       no call date at all — a manually added lead, say — so substituting
       "soon" would turn "You're locked in for {date}" into "You're locked in
       soon", telling someone they have an appointment they have never booked.
       Saying nothing is recoverable; asserting a booking that does not exist
       is not.

       {when} below is the opt-in version for copy that genuinely wants it. */
    date: callDate ? fmtDate(callDate, tz) : '',
    // Zone spelled out, so "11:00 AM PDT" can't be read as 11am wherever the
    // reader happens to be.
    time: callDate ? (fmtTime(callDate, tz) + ' ' + tzLabel(tz, callDate)).trim() : '',
    weekday: callDate ? weekdayName(callDate, tz) : '',
    // Never point a client at their calendar — the invite's Meet link is
    // pulled through by the sync now. If one is genuinely missing this reads
    // as an obvious placeholder rather than quietly shipping vague wording.
    /* "on Monday", "on Oct 15", or "soon" when nothing is booked.

       The placeholder for copy that has to read naturally either way — an
       email sent before a time is agreed, which is a normal thing to send.
       It carries its own preposition so the sentence works in all three
       cases: "Looking forward to our call {when}."

       A day name inside the coming week, a date beyond it, because "on
       Tuesday" is ambiguous once it could mean one of several Tuesdays. */
    when: (function(){
      if(!callDate) return 'soon';
      var days = (callDate.getTime() - Date.now()) / 86400000;
      return (days >= 0 && days < 7)
        ? 'on ' + weekdayName(callDate, tz)
        : 'on ' + fmtDate(callDate, tz);
    })(),
    link: client.meetLink || '(no link on file — paste one before sending)',
    /* What was actually said on the call, and what you know about them.

       There is already a "Call recap" field on every contact, and the AI
       drafting has always used it — but templates could not, so a post-call
       recap email could only ever be generic. An email that says "here is
       what we discussed" and then describes nothing in particular is worse
       than not sending one.

       The fallback is a visible marker rather than silence, following {link}:
       these drafts open in Gmail and are read before they are sent, so an
       obvious gap gets filled, whereas an empty space gets missed. */
    /* The link people book through, held once and reused.

       It was being pasted into each email body by hand, which means a
       changed link has to be found in nine places and will be missed in at
       least one. Held on the account, every message that uses it updates at
       once.

       The fallback is a visible marker rather than silence, following {link}:
       a message inviting someone to book, with nothing to book through, is
       worse than one that obviously is not finished. */
    bookinglink: ACTIVE_BOOKING_LINK || '(set your booking link in Settings)',
    recap: client.recap || '(paste your call notes here before sending)',
    notes: client.notes || '',
    channel: extractChannelHandle(client.youtubeLink) || ''
  };
  /* Substitute, and when a value is empty take its preposition with it.

     Doing this at substitution time rather than afterwards is the whole
     trick. Afterwards, "hopping on at ." and "locked in for ." look the same
     — a preposition before a full stop — but "hopping on." is correct English
     and "locked in for." is not. Here the structure is still visible: the
     "at " belonged to {time}, the "for " belonged to {date}, and the "on" in
     "hopping on" belonged to nothing and is left alone.

     An earlier version stripped prepositions from the finished string and
     turned "You're locked in for Oct 4" into "You're locked." */
  var out = String(template).replace(
    /* The \b is load-bearing. Without it "chat {date}" matched the "at"
       inside "ch|at", so an empty date turned "Excited to chat {date}" into
       "Excited to ch" — and that went out to a real inbox. Any word ending in
       at, on, for, in or by was exposed: "great format {date}" became "great
       form." A word boundary is the difference between removing a preposition
       and amputating the end of a word. */
    /([ \t]*)(\b(?:ahead of|prior to|in advance of|at|on|for|in|by)[ \t]+)?((?:this|next)[ \t]+)?\{(\w+)\}/gi,
    function(m, space, prep, demo, key){
      if(!(key in vals)) return m;
      var val = vals[key];
      if(val !== '') return space + (prep || '') + (demo || '') + val;
      return '';   // the placeholder, its preposition and the space before it
    });
  return tidyTemplate(out);
}

/* Repair the sentence after a placeholder came back empty or vague.

   Filling a template is not just substitution: the words AROUND a placeholder
   assume it will have content. "on {weekday}" assumes a day; "at {time}"
   assumes a time. When there is no appointment yet, those leave behind a
   dangling preposition and a space before the full stop — which is how a
   client receives "see you at ." and concludes the sender is careless.

   Deliberately small. It fixes the three shapes the built-in and library
   copy actually produces, rather than attempting to parse English:
     "on soon"  -> "soon"      (a day that is not set yet)
     "for soon" -> "soon"
     "at ."     -> "."         (a time that does not exist)
   plus the double spaces and floating punctuation those leave behind. */
function tidyTemplate(text){
  /* Whatever punctuation an emptied placeholder left behind.

     Deliberately tiny now that renderTemplate removes the preposition at
     substitution time: this only has to clean up doubled spaces and a comma
     or full stop left floating after the words in front of it disappeared.
     It no longer touches prepositions, because at this point there is no way
     to tell a dangling one from a correct one. */
  return String(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .replace(/([.,!?;:])\1+/g, '$1')
    .replace(/[ \t]+$/gm, '');
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
  /* Advancing Booked -> Confirmed -> Reminded as reminders go out.

     Deliberately guarded rather than generalised. "The next open stage" sounds
     like the right abstraction until you try it on a real pipeline: sending an
     HVAC customer a day-of text does not mean their estimate is now scheduled.
     So this only fires when those exact stages are in the active pipeline —
     correct for the default, and does nothing rather than something wrong for
     a custom one. */
  if(!stopsCadence(client.status) && pipelineHasStages(['Booked','Confirmed','Reminded'])){
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


/* Drops a touch for this contact permanently.

   "Not today" is for a text that is merely badly timed. This is for one that
   is not needed at all — a mid-point check-in for someone you spoke to
   yesterday, a Monday nudge for a call you have already confirmed by phone.
   Snoozing those meant dismissing them again every morning and never seeing
   the day's list reach zero.

   Nothing is written to the message log and no variant is credited, because
   nothing was sent. The event is recorded so a skipped touch is auditable
   rather than a silent gap in the cadence. */
function skipTouch(state, clientId, stage){
  var client = state.clients[clientId];
  if(!client) return;
  if(!client.skippedStages) client.skippedStages = {};
  client.skippedStages[stage] = nowISO();
  recordEvent(state, clientId, 'touch.skipped', {stage: stage});
  saveState(state);
}

function unskipTouch(state, clientId, stage){
  var client = state.clients[clientId];
  if(!client || !client.skippedStages) return;
  delete client.skippedStages[stage];
  recordEvent(state, clientId, 'touch.unskipped', {stage: stage});
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

  /* Library emails are not an experiment, so they are not measured as one.

     A library email logs with stage 'email' and its own document id. Left
     alone, this panel — "What actually produces appointments", which compares
     TEXT VARIANTS within a touch — grew an "email" section whose rows were
     labelled with raw uuids, because the row label is the variant key and a
     library document's key is a uuid.

     It is also the wrong question. The five touches have two or three
     alternative wordings each, chosen by a bandit, and comparing them is the
     entire point. Library emails are distinct documents a person picks
     deliberately; "which of these wins" is not a comparison anyone asked for,
     and the id is not a name.

     If per-email reply rates are ever wanted, they belong in the Emails tab
     labelled with each email's title, not here. */
  function isLibraryEmail(stage){ return stage === 'email'; }

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
      if(isLibraryEmail(m.stage)) return;
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
      // Library emails are excluded here too, and this is the half that
      // actually corrupts numbers: credit goes to the LAST message before the
      // appointment, so a library email sent the morning of the call would
      // take the credit away from the day-of text that earned it. The panel
      // measures touches, so only touches can be credited.
      return !isNaN(t) && t < call.getTime() && m.variantId && m.variantId !== 'custom'
        && !isLibraryEmail(m.stage);
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


/* Which Google account client mail should go from.

   Not "whichever Gmail the browser happens to have open". These accounts are
   signed into several at once — a personal address and a work one — and a
   client email leaving from the personal one is a small, avoidable
   embarrassment.

   The connected calendar is the answer, and it is already the identity used to
   decide whose lead a booking is. It is the work account by definition: it is
   the mailbox the bookings arrive in. An explicit setting still wins where one
   exists, for anyone whose sending address differs from their calendar.

   Returns null rather than guessing when neither is known, so the caller can
   say so instead of quietly opening the wrong mailbox. */
function businessEmailAccount(state){
  if(!state) return null;
  var explicit = (state.emailFromAddress || '').trim();
  if(explicit) return explicit;
  var cals = state.myCalendars || [];
  for(var i = 0; i < cals.length; i++){
    var c = String(cals[i] || '').trim();
    // Calendar ids are usually the owner's address, but not always — a shared
    // calendar can be a long opaque id ending in @group.calendar.google.com,
    // which is not a mailbox anyone can send from.
    if(c.indexOf('@') !== -1 && c.indexOf('@group.calendar.google.com') === -1) return c;
  }
  return null;
}


/* A Gmail compose link, pre-filled and pointed at the right account.

   This is how email gets used today. The provider route (send-email) needs an
   account, a verified domain and DNS records; this needs nothing, works now,
   and has a property the provider route does not: the message genuinely comes
   from the salesperson's own mailbox, so it lands in their Sent folder and the
   reply arrives where they already look.

   authuser is the account to compose as. Gmail accepts an address there and
   switches to that account, which matters for anyone signed into several —
   sending a client email from a personal account by accident is exactly the
   kind of small embarrassment software should prevent.

   The trade is that Ghost Recall cannot see the reply, so for this route the
   reply still has to be logged by hand. Worth it: a channel that works today
   beats one that works after a DNS change. */
function gmailComposeUrl(toAddress, subject, body, fromAccount){
  var params = [
    'view=cm', 'fs=1',
    'to=' + encodeURIComponent(toAddress || ''),
    'su=' + encodeURIComponent(subject || ''),
    'body=' + encodeURIComponent(body || '')
  ];
  // Only pins the account when one is configured; a bad authuser value sends
  // people to an account chooser, which is worse than letting Gmail default.
  if(fromAccount) params.unshift('authuser=' + encodeURIComponent(fromAccount));
  return 'https://mail.google.com/mail/?' + params.join('&');
}


/* Can this contact still be emailed?

   A bounce is not a delivery problem to retry, it is an address to stop using.
   Continuing to send to a dead mailbox is how a sending domain's reputation is
   destroyed, and that failure is not contained: once the domain is distrusted,
   mail to every other contact starts landing in spam too.

   A complaint is stronger still — somebody pressed "this is junk". Mailing
   them again is both pointless and the fastest route to being blocked
   outright. */
function canEmail(client){
  if(!client || !client.email) return false;
  return (client.emailStatus || 'ok') === 'ok';
}


/* Whose lead is this?

   A team shares calendars. When a colleague books a discovery call and puts it
   on your calendar too, the sync creates a contact in YOUR book — and the
   follow-up sequence then offers to text someone about a call they booked with
   somebody else. On the live book that was roughly 30 contacts organized by
   nine different teammates, five of whom were about to receive a revival text.

   The identity that matters is the CONNECTED CALENDAR, not the login. Johnny
   signs in as a personal Gmail address while his events are organized by his
   work address, so comparing against the login would have misfiled all 74 of
   his own contacts as somebody else's.

   Only a positively different organizer counts as someone else's. Contacts
   with no organizer recorded — 55 of them, mostly from earlier imports — are
   left alone rather than guessed at, because being wrong here means either
   texting another rep's client or silently dropping your own. */
function isOthersLead(client, myCalendars){
  var organizer = (client.organizerEmail || '').toLowerCase().trim();
  if(!organizer) return false;
  var mine = (myCalendars || []).map(function(c){ return String(c || '').toLowerCase().trim(); });
  if(!mine.length) return false;   // nothing to compare against yet
  return mine.indexOf(organizer) === -1;
}


/* ---- the recommended next action ----
   Ghost Score answers who. The cadence answers when. This answers HOW: call,
   text, or leave them alone — one obvious next move per contact rather than a
   row of equally-weighted buttons.

   Rules, not a model, for the same reason the Ghost Score is: a recommendation
   nobody can interrogate gets ignored, and there is nowhere near enough
   outcome data here to learn channel choice from.

   The one empirical input is the channel-switch threshold. Measured on this
   book, reply rate runs ~22% for the first couple of texts and roughly halves
   to ~12% after that — real, but noisy enough (one bucket bounces back to 21%
   on n=28) that it supports "texting is working less well by now", not a
   precise cutoff. UNANSWERED_SWITCH_AT is therefore a deliberate heuristic and
   is named so it can be moved when better data exists. */
var UNANSWERED_SWITCH_AT = 3;

function consecutiveUnanswered(client){
  var log = client.messageLog || [];
  var run = 0;
  for(var i = log.length - 1; i >= 0; i--){
    if(!log[i].reviewed) continue;    // unchecked is not evidence of silence
    if(log[i].responded) break;
    run++;
  }
  return run;
}

// {action, label, why, stage} — stage is set only when the action is to send a
// specific cadence message, so the caller knows which template to render.
function recommendNextAction(client, now){
  now = now || new Date();
  if(!client || client.ignored) return {action:'none', label:'Archived', why:'', stage:null};

  var inter = lastInteraction(client, now);
  var due = computeDue(client, now);
  var hasPhone = !!String(client.phone || '').replace(/\D/g, '');
  var callDate = safeDate(client.callDateTime);
  var minsToCall = callDate ? (callDate.getTime() - now.getTime()) / 60000 : null;

  // They wrote back and the cadence is held: a person owes them a person.
  if(inter.state === 'replied' && inter.pausedUntil && inter.pausedUntil > now.getTime()){
    return {action:'reply', label:'Reply to them', stage:null,
      why:'They wrote back. Automated follow-ups are paused until you answer.'};
  }

  // Minutes from the call and nothing has confirmed them — a call beats a text
  // when there is no time left for a text to be read.
  if(minsToCall !== null && minsToCall > 0 && minsToCall <= 15 && !stopsCadence(client.status) && hasPhone){
    return {action:'call', label:'Call now', stage:null,
      why:'Starting in ' + Math.round(minsToCall) + ' minutes and not confirmed.'};
  }

  if(due.length){
    // Several touches can be due at once. The appointment-critical ones win:
    // a stale welcome is not more urgent than the meeting link for a call
    // starting in an hour, and taking due[0] made that choice by accident.
    var stage = null;
    for(var p = 0; p < STAGE_PRIORITY.length && !stage; p++){
      if(due.indexOf(STAGE_PRIORITY[p]) !== -1) stage = STAGE_PRIORITY[p];
    }
    if(!stage) stage = due[0];
    var unanswered = consecutiveUnanswered(client);
    // Texting has stopped working for this person. Switching channel is the
    // standard play, and the cadence message stays available underneath.
    if(unanswered >= UNANSWERED_SWITCH_AT && hasPhone && !PAUSE_EXEMPT_STAGES[stage]){
      return {action:'call', label:'Call instead', stage:stage,
        why:unanswered + ' texts with no answer. Reply rate roughly halves past this point.'};
    }
    return {action:'text', label:'Send the ' + stage + ' text', stage:stage,
      why:'This touch is due today.'};
  }

  if(inter.state === 'waiting'){
    return {action:'wait', label:'Waiting for reply', stage:null,
      why:'Sent ' + Math.round(inter.hoursAgo) + 'h ago. Give it until tomorrow.'};
  }

  if(inter.state === 'needs_outcome'){
    return {action:'outcome', label:'What happened?', stage:null,
      why:'No answer yet. Logging it keeps the message stats honest.'};
  }

  if(!hasPhone){
    return {action:'none', label:'No phone number', stage:null,
      why:'Nothing can be sent until a number is on file.'};
  }

  // The score and the cadence can disagree, and when they do the score is
  // usually right. Kevin scores 90 — a call in 48 hours after a month of
  // silence — while the cadence has nothing left to fire because every
  // scheduled touch already went out. Answering "nothing due" there is worse
  // than useless: the queue has just explained at length why this person needs
  // attention, and then offers no way to give it. So a contact the score ranks
  // as worth chasing, with no template left to send, gets the honest
  // recommendation — pick up the phone — carrying the score's own reasoning.
  var g = computeGhostScore(client, now);
  if(g.score >= 51){
    var top = g.reasons.filter(function(r){ return r.points > 0 && r.label !== 'Baseline'; })
      .sort(function(a, b){ return b.points - a.points; })[0];
    return {action:'call', label:'Reach out', stage:null,
      why:(top ? top.label + '. ' : '') + 'No scheduled touch left — this one needs a person.'};
  }

  return {action:'none', label:'Nothing due', stage:null, why:''};
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

function timelineEntry(at, kind, label, detail, source, by){
  var t = Date.parse(at);
  return {at: at, ms: isNaN(t) ? 0 : t, kind: kind, label: label,
          detail: detail || '', source: source, by: by || null};
}

/* Did a person record this, or did Ghost Recall see it?

   A text is handed to the phone and marked sent optimistically. An email
   opens in Gmail and is marked the moment the button is clicked. Neither is
   confirmed -- Ghost Recall cannot see whether Send was ever pressed. Only a
   send that went out through an email provider has a provider id, and only
   those are observed rather than asserted.

   Saying so matters more than it looks: an unqualified "sent" claims a
   certainty that does not exist, and the first time someone discovers a
   message they never actually sent is recorded as sent, they stop trusting
   the whole log. */
function messageSource(m){
  return m && m.providerId ? 'automatic' : 'you';
}

/* A reply is observed only where something could have observed it.

   Ghost Recall never sees SMS -- those go through the salesperson's own phone
   -- so an SMS reply is always a human ticking a box. An email reply can be
   seen by the inbound webhook, but only for a message the provider sent and
   can therefore match. Everything else is someone's word for it, and should
   read that way. */
function replySource(m){
  return (m && m.channel === 'email' && m.providerId) ? 'automatic' : 'you';
}

// EVENT_LABELS keeps the phrasing in one place so the timeline and any future
// activity feed can't drift apart.
var EVENT_LABELS = {
  'contact.created':        'Added to Ghost Recall',
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
    out.push(timelineEntry(client.bookedDate, 'contact.created', 'Added to Ghost Recall',
      client.manuallyAdded ? 'Added by hand' : 'From the calendar', 'derived'));
  }
  (client.messageLog || []).forEach(function(m){
    /* Who recorded this, not just that it happened.

       The timeline had a source of 'derived' vs recorded, which is about
       where the entry was reconstructed from -- a different question from
       the one that matters when you are reading history: did a person say
       this happened, or did Ghost Recall see it happen?

       Today the honest answer is almost always a person. A text is handed to
       your phone and marked sent optimistically; an email opens in Gmail and
       is marked the moment the button is clicked. Only a send that went
       through an email provider carries a provider_id, and only those can be
       confirmed. Showing "sent" with no qualifier implies a confirmation
       Ghost Recall does not have. */
    out.push(timelineEntry(m.sentAt, 'message.sent', 'Message sent',
      m.stage + (m.variantId ? ' \u00b7 ' + m.variantId : ''), 'derived', messageSource(m)));
    // respondedAt is when the reply was LOGGED, which can be much later than
    // when it arrived. Fall back to the send time rather than inventing one.
    if(m.responded){
      out.push(timelineEntry(m.respondedAt || m.sentAt, 'message.replied', 'Reply received',
        m.respondedAt ? '' : 'time approximate', 'derived', replySource(m)));
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
    hoursAgo: isNaN(sent) ? null : (now.getTime() - sent) / 3600000,
    pausedUntil: replyPauseUntil(client)
  };
}

// Human phrasing for the lifecycle, used in both the queue and the timeline so
// the vocabulary stays consistent across surfaces.
/* Why this person is on today's list, in a sentence.

   The card showed a name, a progress chip and a timezone. It never said what
   had happened or why this was due now, so the only way to judge whether a
   message was the right thing to send was to open the contact and read the
   history. On a list of fourteen that is fourteen detours.

   Two clauses, because there are two questions: what happened last, and what
   is owed now. "No reply in 4 days - mid-point check-in due today."

   Built from real records only. Nothing here is inferred or scored; it is a
   restatement of what the log already says, which is the only kind of
   explanation worth putting in front of someone who can check it. */
function explainDue(client, stage, now){
  now = now || new Date();
  var inter = lastInteraction(client, now);
  var what = [];

  // What happened last.
  if(!inter || inter.state === 'none'){
    var booked = safeDate(client.bookedDate);
    var days = booked ? Math.floor((now.getTime() - booked.getTime()) / 86400000) : null;
    what.push(days === null ? 'Nothing sent yet'
      : days < 1 ? 'Came in today, nothing sent yet'
      : 'Nothing sent yet, booked ' + days + (days === 1 ? ' day ago' : ' days ago'));
  } else if(inter.state === 'replied'){
    what.push('They replied' + (inter.hoursAgo !== null && inter.hoursAgo >= 24
      ? ' ' + Math.round(inter.hoursAgo / 24) + 'd ago' : ''));
  } else {
    var h = inter.hoursAgo;
    what.push(h === null ? 'Already contacted'
      : h < 24 ? 'No reply yet, sent ' + Math.max(1, Math.round(h)) + 'h ago'
      : 'No reply in ' + Math.round(h / 24) + (Math.round(h / 24) === 1 ? ' day' : ' days'));
  }

  // Why this particular touch is owed now.
  var call = safeDate(client.callDateTime);
  var hrsToCall = call ? (call.getTime() - now.getTime()) / 3600000 : null;
  if(stage === 'hourbefore' && hrsToCall !== null){
    what.push('call in under an hour');
  } else if(stage === 'dayof'){
    what.push('call is today');
  } else if(stage === 'noshow'){
    what.push('they missed the call');
  } else if(stage === 'recovery'){
    what.push('gone quiet, worth another try');
  } else if(stage === 'revival'){
    what.push('long-term check-in, roughly monthly');
  } else if(hrsToCall !== null && hrsToCall > 0){
    var d = Math.round(hrsToCall / 24);
    what.push(touchLabel(stage).toLowerCase() + ' due, call in ' + (d < 1 ? 'under a day' : d + (d === 1 ? ' day' : ' days')));
  } else {
    what.push(touchLabel(stage).toLowerCase() + ' due today');
  }

  return what.join(' \u2014 ');
}

function interactionLabel(inter){
  if(!inter || inter.state === 'none') return 'No messages yet';
  // A replied-to contact whose cadence is held should say so: "Replied" alone
  // reads as handled, when in fact it is waiting on a human.
  if(inter.state === 'replied' && inter.pausedUntil && inter.pausedUntil > Date.now()){
    var days = Math.max(1, Math.ceil((inter.pausedUntil - Date.now()) / 86400000));
    return 'They replied — your turn (auto follow-ups held ' + days + 'd)';
  }
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
  // Roles, not names. stalledSince is the anchor the recovery sequence counts
  // from, so a pipeline whose stalled stage is called "Awaiting Decision"
  // would never have it set and would silently get no recovery nudges at all.
  var newRole = stageRole(newStatus);
  var wasRole = stageRole(client.status);
  if(newRole === 'stalled'){
    recordReschedule(client, when);
    if(wasRole !== 'stalled') client.stalledSince = when.toISOString();
  } else if(newRole === 'lost'){
    if(wasRole !== 'lost') client.stalledSince = when.toISOString();
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
      uid: get('UID').value, created: get('CREATED').value, attendeeLines: attendeeLines,
      // ORGANIZER tells us whose domain is internal for THIS event, which is
      // what picks the customer out of the attendee list. Without it the
      // fallback had to name one company's domain in code.
      // The value is a mailto: URI ("ORGANIZER;CN=Jo:mailto:jo@acme.com").
      organizerEmail: (get('ORGANIZER').value.replace(/^mailto:/i, '').trim() || null)
    });
  });
  return events;
}

/* Which calendar events represent someone worth following up with.

   Mirrors matchesCalendarFilter in supabase/functions/_shared/parse.ts — the
   Edge Function applies this to Google Calendar, this copy applies it to .ics
   imports, and they must agree or the same calendar produces different
   contacts depending on how it arrived.

   'attendees' is the default for anyone new because it needs no setup to be
   right: an internal standup has no guest from outside your own domain, a
   booked appointment does. Title matching only works for a business whose
   booking tool names events predictably, which is something you have to know
   about yourself before you can configure it. */
/* What an account with no configuration gets.

   The most expensive line in this codebase's history. It used to be
   LEGACY_CALENDAR_FILTER — MarketMaker's own event titles — so every person
   who signed up had their calendar filtered for the phrase "strategy session"
   and imported nothing. Three people hit it one after another, each looked
   like a separate mystery, and the app reported "Synced: 0 new, 0 updated"
   every time.

   Unconfigured must mean "the sensible default", never "the first customer's
   settings". */
var DEFAULT_CALENDAR_FILTER = {
  mode: 'attendees',
  exclude: []
};

// MarketMaker's original rule. Accounts predating the filter were explicitly
// backfilled with it and keep it; isStrategySessionEvent means it on purpose.
// It is no longer what "unconfigured" falls back to.
var LEGACY_CALENDAR_FILTER = {
  mode: 'keywords',
  include: ['strategy session'],
  matchDescription: ['booked by'],
  exclude: ['weekly team meeting']
};

function emailDomain(email){
  var at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).toLowerCase();
}

/* Domains that mean "a person", never "a company".

   Both rules below ask "is this guest one of my colleagues?" and answer it by
   comparing their domain to the organizer's. That is right for a business with
   its own domain and catastrophically wrong for a solo operator on a personal
   Gmail: their client is also on gmail.com, so the client reads as a colleague
   and the booking reads as an internal meeting. Nothing imports at all.

   That is the LEGACY filter disaster a second time — an empty app with no
   explanation — and it would land on exactly the people the general default
   exists to serve, since a realtor working alone books out of a personal
   inbox. A shared mail host tells you nothing about who is internal, so it is
   never treated as a company domain. */
var SHARED_MAIL_DOMAINS = {
  'gmail.com':1, 'googlemail.com':1, 'yahoo.com':1, 'ymail.com':1, 'rocketmail.com':1,
  'hotmail.com':1, 'outlook.com':1, 'live.com':1, 'msn.com':1, 'aol.com':1,
  'icloud.com':1, 'me.com':1, 'mac.com':1, 'proton.me':1, 'protonmail.com':1,
  'gmx.com':1, 'gmx.net':1, 'mail.com':1, 'zoho.com':1, 'yandex.com':1,
  'comcast.net':1, 'verizon.net':1, 'att.net':1, 'sbcglobal.net':1, 'bellsouth.net':1,
  'cox.net':1, 'charter.net':1, 'earthlink.net':1, 'optonline.net':1, 'frontier.com':1
};

function isSharedMailDomain(domain){
  return !!SHARED_MAIL_DOMAINS[String(domain || '').toLowerCase()];
}

// The organizer's domain, but only when it actually identifies a company.
function internalDomain(email){
  var d = emailDomain(email);
  return (!d || isSharedMailDomain(d)) ? '' : d;
}

function matchesCalendarFilter(ev, filter){
  var f = (filter && filter.mode) ? filter : DEFAULT_CALENDAR_FILTER;
  var title = (ev.summary || '').toLowerCase();
  var desc = (ev.description || '').toLowerCase();
  var i;

  // Exclusions win in every mode: a recurring internal meeting on a booking
  // calendar is the one thing nobody wants turned into a contact.
  var excl = f.exclude || [];
  for(i = 0; i < excl.length; i++){
    if(excl[i] && title.indexOf(String(excl[i]).toLowerCase()) !== -1) return false;
  }

  if(f.mode === 'all') return true;

  if(f.mode === 'attendees'){
    // internalDomain, not emailDomain: a personal-inbox organizer has no
    // colleagues to exclude, so every named guest is an outside guest.
    var organizer = internalDomain(ev.organizer && ev.organizer.email);
    var guests = ev.attendees || [];
    for(i = 0; i < guests.length; i++){
      var g = guests[i];
      if(!g || g.self || g.resource) continue;      // you, and meeting rooms
      var d = emailDomain(g.email);
      if(!d) continue;
      if(!organizer || d !== organizer) return true;
    }
    return false;
  }

  var inc = f.include || [];
  for(i = 0; i < inc.length; i++){
    if(inc[i] && title.indexOf(String(inc[i]).toLowerCase()) !== -1) return true;
  }
  var descTerms = f.matchDescription || [];
  for(i = 0; i < descTerms.length; i++){
    if(descTerms[i] && desc.indexOf(String(descTerms[i]).toLowerCase()) !== -1) return true;
  }
  return false;
}

// Kept for existing callers; new code should pass a filter explicitly.
function isStrategySessionEvent(ev){
  return matchesCalendarFilter(ev, LEGACY_CALENDAR_FILTER);
}

/* A recurring series is one meeting, not one meeting per occurrence.

   Google is asked for singleEvents, which expands a series into one event per
   occurrence. The per-event filter is right to keep them — a standing call
   with an outside guest really does look like a booking — but importing every
   occurrence turns one meeting into hundreds of contacts, each carrying its
   own follow-up cadence. One account had a single standing meeting become 133
   upcoming "clients" running out to the following March, which buried the
   eight real bookings sitting alongside them.

   Collapsing to the next upcoming occurrence keeps a genuine recurring client
   visible without the flood. Two things deliberately pass through untouched:
   ordinary one-off bookings, which have no series key at all, and the same
   person booking a second call weeks later — those are separate events, not
   one series, and that second booking is real. */
function recurringSeriesKey(ev){
  if(!ev) return null;
  if(typeof ev.recurringEventId === 'string' && ev.recurringEventId) return ev.recurringEventId;
  // Google's own occurrence id shape, "<seriesId>_20260302T150000Z". Needed for
  // rows read back from storage, which kept the event id but not the series id.
  var m = String(ev.id || '').match(/^(.+)_\d{8}T\d{6}Z$/);
  return m ? m[1] : null;
}

function occurrenceStartMs(ev){
  var dt = ev && ev.start && (ev.start.dateTime || ev.start.date);
  var t = dt ? new Date(dt).getTime() : NaN;
  return isNaN(t) ? null : t;
}

// Is `a` the better occurrence of a series to keep than `b`?
function preferOccurrence(a, b, nowMs){
  var ta = occurrenceStartMs(a), tb = occurrenceStartMs(b);
  if(ta === null) return false;
  if(tb === null) return true;
  var aUpcoming = ta >= nowMs, bUpcoming = tb >= nowMs;
  if(aUpcoming && bUpcoming) return ta < tb;   // the one you'll sit on next
  if(aUpcoming !== bUpcoming) return aUpcoming;
  return ta > tb;                              // all in the past: most recent
}

function collapseRecurringSeries(events, now){
  var list = events || [];
  var nowMs = now ? new Date(now).getTime() : Date.now();
  var best = Object.create(null);
  var i, ev, key;

  for(i = 0; i < list.length; i++){
    ev = list[i];
    key = recurringSeriesKey(ev);
    if(!key) continue;
    if(!best[key] || preferOccurrence(ev, best[key], nowMs)) best[key] = ev;
  }

  var out = [];
  for(i = 0; i < list.length; i++){
    ev = list[i];
    key = recurringSeriesKey(ev);
    if(!key || best[key] === ev) out.push(ev);
  }
  return out;
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
  // include internal teammates cc'd on the call using a personal address,
  // which no domain rule can catch.
  // Only fall back to scraping attendees if the description doesn't have one.
  var descEmailMatch = (ev.description||'').match(EMAIL_RE);
  var email = descEmailMatch ? descEmailMatch[0].toLowerCase() : '';
  if(!email){
    /* Fall back to the attendee list, taking the guest from OUTSIDE the
       organizer's domain.

       This used to strip a hard-coded @marketmakermgmt.com, which fails both
       ways for anyone else: another business's own teammates are never
       stripped, so a colleague's address is saved as the customer's and the
       follow-up goes to the colleague. Whose domain is internal is knowable
       per event — the organizer's — and it is the same rule the calendar
       filter uses to decide what counts as a booking. */
    var organizerSelf = String(ev.organizerEmail || ev.organizer || '').toLowerCase();
    var organizerDomain = internalDomain(ev.organizerEmail || ev.organizer);
    var emails = extractAttendeeEmails(ev.attendeeLines).filter(function(e){
      // The organizer is never the customer, whatever their domain. Dropping
      // only the domain comparison was not enough: on a personal inbox it
      // leaves the organizer first in the list, so the booking imports with
      // the agent's own address as the client's.
      if(organizerSelf && e === organizerSelf) return false;
      return !organizerDomain || emailDomain(e) !== organizerDomain;
    });
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
        status: defaultOpenStage(), messageLog: [], notes:'', recap:'',
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
    status: defaultOpenStage(), messageLog: [], notes: fields.notes || '', recap:'',
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

/* The five scoring bands collapse to the four buckets a salesperson actually
   sorts leads into. 'immediate' and 'high' are the same instruction — chase
   this now — and splitting them buys nothing at the filter level, where the
   question is which pile to work rather than exactly how warm one lead is.
   The precise band still colours the badge and drives the ranked queue. */
var SCORE_GROUPS = [
  {key:'hot',     label:'Hot',     bands:['immediate','high']},
  {key:'good',    label:'Good',    bands:['soon']},
  {key:'nurture', label:'Nurture', bands:['nurture']},
  {key:'dead',    label:'Dead',    bands:['low']}
];

function scoreGroupOf(band){
  for(var i = 0; i < SCORE_GROUPS.length; i++){
    if(SCORE_GROUPS[i].bands.indexOf(band) !== -1) return SCORE_GROUPS[i].key;
  }
  return 'dead';
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
/* The whole working, in words, for a tooltip.

   The row shows what lifted someone up, which is what you act on. It does not
   show what held them down, and leaving that out means the number cannot be
   reconciled with the reasons beside it -- a score of 41 next to two positive
   reasons adding to 60 reads as broken arithmetic.

   And it says what the number IS. "72 - hot" does not tell anyone whether
   that is a probability, a percentage or a rank. It is none of those: it is a
   priority ordering built by adding up rules you can read and change, and
   calling it anything more certain would be dressing a heuristic as a
   prediction. */
function describeScore(g){
  if(!g) return '';
  var lines = ['Ghost Score ' + g.score + ' (' + g.band + ')'];
  lines.push('A priority ordering from your own records, not a prediction.');
  var ups = [], downs = [];
  (g.reasons || []).forEach(function(r){
    if(r.label === 'Baseline') return;
    (r.points > 0 ? ups : downs).push(r.label + ' ' + (r.points > 0 ? '+' : '') + r.points);
  });
  if(ups.length) lines.push('Raised by: ' + ups.join(', '));
  if(downs.length) lines.push('Lowered by: ' + downs.join(', '));
  if(!ups.length && !downs.length) lines.push('Nothing has moved it from the baseline yet.');
  return lines.join('\n');
}

function rankByGhostScore(state, now, opts){
  now = now || new Date();
  opts = opts || {};
  var min = (typeof opts.min === 'number') ? opts.min : 26;
  var w = state.scoreWeights || buildDefaultScoreWeights();
  var out = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    if(isOthersLead(c, state.myCalendars)) return;
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
  // Asks the role, not the literal name: a custom pipeline's "Missed Estimate"
  // is a no-show and has to count as one, or that business sees a show rate
  // computed over half its calls.
  var noshow = inCallWindow.filter(function(c){ return isMissed(c.status); }).length;
  var showUpRate = (completed+noshow) > 0 ? completed/(completed+noshow) : null;
  // Calls that have happened but whose outcome nobody recorded. They are
  // correctly excluded from the rate above — unknown is not the same as a
  // no-show — but excluding them silently lets a number describe 86 calls
  // while looking like it describes 110. Reported so the UI can say how much
  // of the picture is missing.
  // Same rule as getUnloggedCalls, which drives the prompt this number links
  // to: only a contact still on an OPEN stage is owed an answer. Stalled and
  // lost are answers — they say the appointment is not happening. Counting
  // them here while the list excluded them meant the stat and the list it
  // pointed at disagreed.
  var unlogged = inCallWindow.filter(function(c){
    var d = safeDate(c.callDateTime);
    return d && d.getTime() < now.getTime() && stageRole(c.status) === 'open';
  }).length;
  var closed = inCallWindow.filter(function(c){ return c.closeOutcome==='Closed'; }).length;
  var notClosed = inCallWindow.filter(function(c){ return c.closeOutcome==='Not closed'; }).length;
  var closeRate = (closed+notClosed) > 0 ? closed/(closed+notClosed) : null;
  var rescheduledAtLeastOnce = inCallWindow.filter(function(c){ return c.rescheduleCount > 0; }).length;
  var rescheduleRate = inCallWindow.length > 0 ? rescheduledAtLeastOnce/inCallWindow.length : null;
  /* Reply rate is a TEXT rate, and mixing channels destroyed it.

     Every message in range used to count. The moment library emails started
     being logged, each one joined the denominator while essentially never
     joining the numerator -- an email sent through Gmail has nothing watching
     for its reply, so it can only ever be marked by hand and almost never is.
     On a book where 3 of 10 texts got answered, sending each contact one
     email took the reply rate from 30% to 15%. Nobody replied less. The
     number simply stopped meaning anything, in the direction that looks like
     the product is failing.

     So the rate is computed over the channel that actually has reply data,
     which is also the channel it has always described -- every historical
     number was SMS. Emails are reported separately as a count, because a
     count is honest and a rate would not be. */
  var sends=0, responses=0, emailsSent=0, emailReplies=0;
  clients.forEach(function(c){ c.messageLog.forEach(function(m){
    if(!inRange(m.sentAt, range, now)) return;
    if((m.channel || 'sms') === 'email'){
      emailsSent++;
      if(m.responded) emailReplies++;
      return;
    }
    sends++;
    if(m.responded) responses++;
  }); });
  var responseRate = sends > 0 ? responses/sends : null;
  return {showUpRate:showUpRate, closeRate:closeRate, rescheduleRate:rescheduleRate,
          callsTracked:inCallWindow.length, responseRate:responseRate, unloggedCalls:unlogged,
          // Named so nothing can quietly fold them back into the rate above.
          textsSent:sends, textReplies:responses, emailsSent:emailsSent, emailReplies:emailReplies};
}

function pct(v){ return v===null || v===undefined || isNaN(v) ? '—' : Math.round(v*100) + '%'; }

// The whole point of the tool: a ghost, when it appears in your client list, gets called out.
function statusLabel(status){
  var r = stageRole(status);
  return (r === 'lost' || r === 'missed') ? ('👻 ' + stageLabel(status)) : stageLabel(status);
}


/* What setup actually produced, in a sentence.

   The brief's third onboarding step is "review the first follow-ups due", and
   it was the missing one: you pressed Finish and landed in the app with no
   statement of what had happened. That matters most in the case where nothing
   happened -- a calendar connected but nothing imported looks identical to a
   calendar that was never connected, and the person has no way to tell which
   problem they have.

   So it reports the three facts that distinguish those states: whether a
   calendar is attached, how many contacts came in, and how many are owed a
   message today. */
/* ---- how appointments get into Ghost Recall ----

   Four genuinely different levels of connection, which the interface had
   collapsed into one question ("connect your calendar?"). They differ in what
   Ghost Recall can actually DO, and saying so is the difference between a
   person understanding why bookings are not appearing and assuming the
   product is broken:

     sync     read appointments from a connected calendar
     booking  detect bookings, cancellations and reschedules from a
              scheduling service -- strictly more than sync, because a
              cancellation is an event rather than an absence
     link     hold a booking link and put it in messages; Ghost Recall cannot
              see what gets booked
     manual   the person records the appointment and the outcome

   `available` is the load-bearing field, and it is deliberately not
   aspirational. A provider is listed so the option is known to exist, and
   marked unavailable until its connection and sync genuinely work. Showing
   Outlook as a choice that silently does nothing is worse than not showing it
   at all: it converts a missing feature into a broken one, and the person
   spends their afternoon wondering what they did wrong.

   `needs` is what it would actually take, so the answer to "why not?" is a
   list rather than a shrug. */
var SCHEDULING_PROVIDERS = [
  {
    key: 'google', label: 'Google Calendar', level: 'sync', available: true,
    blurb: 'Reads your calendar and turns bookings into contacts automatically.',
    caveat: 'Sees appointments, not cancellations from a booking tool.',
    needs: null
  },
  {
    key: 'outlook', label: 'Microsoft Outlook / 365', level: 'sync', available: false,
    blurb: 'The same calendar sync, for a Microsoft account.',
    caveat: null,
    needs: 'An Azure app registration with Microsoft Graph Calendars.Read, a client ID and secret, and admin consent on the tenant. None of that exists yet, so it is listed rather than offered.'
  },
  {
    key: 'calendly', label: 'Calendly', level: 'booking', available: false,
    blurb: 'Would see bookings, cancellations and reschedules as they happen.',
    caveat: null,
    needs: 'A Calendly developer account and OAuth app, plus webhook subscriptions - which Calendly limits to its paid tiers. Nothing is wired yet.'
  },
  {
    key: 'link', label: 'A booking link', level: 'link', available: true,
    blurb: 'Paste the link people book through. It goes into your messages with {bookinglink}.',
    caveat: 'A saved link is not a connection. Ghost Recall cannot see what gets booked through it, so those appointments still have to arrive by calendar sync or by hand.',
    needs: null
  },
  {
    key: 'manual', label: 'Add them yourself', level: 'manual', available: true,
    blurb: 'Enter appointments by hand and record how they went.',
    caveat: null,
    needs: null
  }
];

// Plain words for what a level can do, used wherever a provider is shown so
// the same promise is never described two different ways.
var SCHEDULING_LEVELS = {
  sync:    'Reads your calendar',
  booking: 'Sees bookings and cancellations',
  link:    'Link only - no detection',
  manual:  'You record it'
};

/* What this account actually has, as opposed to what it could have.

   Deliberately conservative: a connected calendar is the only thing that
   counts as connected, because it is the only one that is. A saved booking
   link is reported separately and never as a connection -- the brief's rule,
   and the honest one, since a link cannot tell you anything came back. */
function schedulingStatus(state){
  state = state || {};
  var calendars = (state.myCalendars || []).filter(Boolean);
  var link = (state.bookingLink || '').trim();
  return {
    calendarConnected: calendars.length > 0,
    calendars: calendars,
    bookingLink: link,
    hasBookingLink: !!link,
    // Nothing here can see a cancellation yet. Said plainly so no part of the
    // interface implies otherwise.
    detectsCancellations: false
  };
}

/* ============================================================
   TEAM VIEW — what a manager needs to know about the people
   ============================================================

   Pure, and deliberately separated from how the rows are fetched: the access
   question (whose data a manager may read) is a security decision made in the
   database, not here. This takes whatever per-person rows it is handed and
   decides what they MEAN.

   What the live book said when this was written, and what shaped it: eight
   accounts were syncing perfectly and six had never sent a single text, four
   of those with appointments already in the queue. "Everyone is running
   clean" was true of the plumbing and false of the work. So the first thing
   this sorts on is whether somebody is actually working their list, not
   whether their calendar is green. */

var TEAM_IDLE_DAYS = 7;          // no send in this long, having sent before
var TEAM_BACKLOG_UPCOMING = 5;   // enough booked work that silence is notable

/* Reply rate is NOT computed per person, and that is the point.

   The number is only knowable for an account whose replies are actually
   reconciled - on this book that is one person, from their own Mac Messages
   database. Everybody else shows zero replies because nobody ever looked, not
   because nobody ever answered. Rendering that as "0%" would tell a manager
   that someone's messages do not work, which is a claim the data cannot
   support and the worst kind of wrong number: confident, specific, and
   actionable in the wrong direction.

   So a member reports a reply rate only when its source says replies are
   measured for them, and otherwise reports null, which the UI shows as "not
   measured" rather than a zero. */
function teamReplyRate(m){
  if(!m || !m.repliesMeasured) return null;
  var sent = Number(m.sentEver) || 0;
  if(!sent) return null;
  return Math.round(100 * (Number(m.replies) || 0) / sent);
}

function teamMemberState(m, now){
  var at = now ? now.getTime() : Date.now();
  var contacts = Number(m.contacts) || 0;
  var upcoming = Number(m.upcoming) || 0;
  var sentEver = Number(m.sentEver) || 0;
  var sent7d = Number(m.sent7d) || 0;

  var cal = 'ok';
  if(!m.connectedCalendars) cal = 'none';
  else {
    var last = m.lastSync ? Date.parse(m.lastSync) : NaN;
    if(isNaN(last)) cal = 'never';
    else if((at - last) / 3600000 > STALE_AFTER_HOURS) cal = 'stale';
  }

  /* Ordered by how much it costs the business, not by severity of the
     plumbing. Someone sitting on booked appointments having never sent
     anything is losing deals right now; a disconnected calendar on an empty
     account is not. */
  var state, why;
  if(cal === 'none' && !contacts){
    state = 'not set up';
    why = 'No calendar connected, so nothing can reach them.';
  } else if(cal === 'none' || cal === 'never'){
    state = 'needs calendar';
    why = 'Their calendar is not connected, so new bookings never arrive.';
  } else if(cal === 'stale'){
    state = 'sync broken';
    why = 'Their calendar stopped syncing, so new bookings are not arriving.';
  } else if(!sentEver && upcoming >= TEAM_BACKLOG_UPCOMING){
    state = 'never started';
    why = upcoming + ' booked and not one message sent.';
  } else if(!sentEver){
    state = 'never started';
    why = 'No messages sent yet.';
  } else if(!sent7d && upcoming >= TEAM_BACKLOG_UPCOMING){
    state = 'gone quiet';
    why = 'Nothing sent in ' + TEAM_IDLE_DAYS + ' days, with ' + upcoming + ' booked.';
  } else if(!sent7d){
    state = 'gone quiet';
    why = 'Nothing sent in the last ' + TEAM_IDLE_DAYS + ' days.';
  } else {
    state = 'working';
    why = sent7d + ' sent in the last ' + TEAM_IDLE_DAYS + ' days.';
  }

  /* The appointments behind the number.

     "Ethan has 11 booked and sent nothing" is a statistic. "Ethan has Dana on
     Thursday and nobody has spoken to her" is something you act on, so the
     list travels with the row and the untouched count is pulled out, because
     that is the subset worth a conversation. */
  var queue = (m.upcomingList || []).map(function(x){
    return {
      clientId: x.clientId || null,
      name: x.name || 'Unknown',
      when: x.when || null,
      status: x.status || 'Booked',
      sent: Number(x.sent) || 0,
      untouched: (Number(x.sent) || 0) === 0
    };
  });
  var untouched = queue.filter(function(x){ return x.untouched; }).length;

  return {
    id: m.id || null,
    name: m.name || m.email || 'Unknown',
    contacts: contacts,
    upcoming: upcoming,
    queue: queue,
    untouched: untouched,
    sent7d: sent7d,
    sentEver: sentEver,
    completed: Number(m.completed) || 0,
    noshows: Number(m.noshows) || 0,
    rescheduled: Number(m.rescheduled) || 0,
    calendar: cal,
    state: state,
    why: why,
    replyRate: teamReplyRate(m),
    needsAttention: state !== 'working'
  };
}

var TEAM_STATE_ORDER = ['never started', 'sync broken', 'gone quiet',
                        'needs calendar', 'not set up', 'working'];

function teamOverview(rows, now){
  var members = (rows || []).map(function(m){ return teamMemberState(m, now); });

  members.sort(function(a, b){
    var ra = TEAM_STATE_ORDER.indexOf(a.state), rb = TEAM_STATE_ORDER.indexOf(b.state);
    if(ra !== rb) return ra - rb;
    // Within a state, whoever has the most booked work is the most expensive.
    if(b.upcoming !== a.upcoming) return b.upcoming - a.upcoming;
    return String(a.name).localeCompare(String(b.name));
  });

  var working = members.filter(function(m){ return m.state === 'working'; });
  var idle = members.filter(function(m){ return m.needsAttention; });
  var strandedWork = idle.reduce(function(n, m){ return n + m.upcoming; }, 0);

  return {
    members: members,
    total: members.length,
    working: working.length,
    needsAttention: idle.length,
    // The headline number: booked appointments belonging to somebody who is
    // not currently following anyone up.
    strandedUpcoming: strandedWork,
    sent7d: members.reduce(function(n, m){ return n + m.sent7d; }, 0),
    replyRateMeasuredFor: members.filter(function(m){ return m.replyRate !== null; }).length
  };
}

/* ============================================================
   OWNER VIEW — every account on Ghost Recall, for support
   ============================================================

   Separate from the team view on purpose, and deliberately narrower.

   The team view is a sales manager looking at his own staff: same company,
   same customers, full detail is appropriate. This one is the owner of the
   product looking at OTHER businesses, and the day outside customers sign up
   it stops being an internal screen. So it answers "what is broken for them
   and what do I tell them" out of account-level facts, and never reaches a
   contact's name, number or messages. Reading a customer's actual book to
   debug something should be a deliberate, consented act, not a tab that is
   always on.

   It is also the honest version of what support needs. Every problem found by
   hand on this book so far - a filter importing nothing, a revoked calendar
   token, somebody who signed up and never came back - is visible from these
   fields alone. */

function accountDiagnosis(a, now){
  var at = now ? now.getTime() : Date.now();
  var days = function(iso){
    var t = iso ? Date.parse(iso) : NaN;
    return isNaN(t) ? null : Math.floor((at - t) / 86400000);
  };
  var contacts = Number(a.contacts) || 0;
  var sentEver = Number(a.sentEver) || 0;
  var sinceSignIn = days(a.lastSignIn);
  var syncDays = days(a.lastSync);
  var cals = Number(a.connectedCalendars) || 0;

  /* Ordered by what is actually blocking them, most upstream first: you
     cannot work a list you never received, and you cannot receive bookings
     from a calendar that is not connected. */
  var problem = null, fix = null;

  if(!cals){
    problem = 'No calendar connected';
    fix = sinceSignIn === null || sinceSignIn > 2
      ? 'Signed up but never finished setup. Needs walking through connecting a calendar.'
      : 'Still setting up - give it a day before chasing.';
  } else if(a.lastSync === null || a.lastSync === undefined){
    problem = 'Calendar connected but never synced';
    fix = 'First sync has not run or is failing. Check the connection was completed.';
  } else if(syncDays !== null && syncDays >= 2){
    problem = 'Sync stopped ' + syncDays + ' days ago';
    fix = 'Google has almost certainly revoked the token. They need to press Reconnect; nobody can do it for them.';
  } else if(!contacts){
    problem = 'Syncing, but importing nothing';
    fix = 'Their calendar filter is excluding everything. Check it is not still set to someone else\'s event titles.';
  } else if(!sentEver){
    problem = 'Never sent a message';
    fix = contacts + ' contacts loaded and nothing sent. This is an onboarding problem, not a technical one.';
  } else if(a.idleDays !== undefined && a.idleDays !== null && a.idleDays >= TEAM_IDLE_DAYS){
    problem = 'Stopped using it ' + a.idleDays + ' days ago';
    fix = 'Was working it and stopped. Worth asking what changed.';
  }

  return {
    name: a.name || a.email || 'Unknown',
    signedUpDays: days(a.signedUp),
    lastSignInDays: sinceSignIn,
    contacts: contacts,
    upcoming: Number(a.upcoming) || 0,
    sentEver: sentEver,
    calendars: cals,
    syncDays: syncDays,
    healthy: problem === null,
    problem: problem,
    fix: fix
  };
}

function platformOverview(rows, now){
  var accounts = (rows || []).map(function(a){ return accountDiagnosis(a, now); });

  // Broken first, then not-started, then healthy - and within each, the
  // account with the most booked work riding on it.
  accounts.sort(function(a, b){
    if(a.healthy !== b.healthy) return a.healthy ? 1 : -1;
    if(b.upcoming !== a.upcoming) return b.upcoming - a.upcoming;
    return String(a.name).localeCompare(String(b.name));
  });

  var broken = accounts.filter(function(a){ return !a.healthy; });
  return {
    accounts: accounts,
    total: accounts.length,
    healthy: accounts.length - broken.length,
    needHelp: broken.length,
    // Everyone who has an account but has never sent anything: the number
    // that says whether the product is being adopted or merely installed.
    neverUsed: accounts.filter(function(a){ return !a.sentEver; }).length,
    strandedUpcoming: broken.reduce(function(n, a){ return n + a.upcoming; }, 0)
  };
}

function describeSetup(state, now){
  now = now || new Date();
  var connected = ((state && state.calendarConnections) || []).length > 0
    || ((state && state.myCalendars) || []).length > 0;
  var contacts = Object.keys((state && state.clients) || {}).length;
  var due = 0;
  try { due = getTextTodayList(state, now, '').length; } catch(e) { due = 0; }

  var headline, detail;
  if(!connected && !contacts){
    headline = 'Nothing to follow up on yet';
    detail = 'Connect a calendar, or add someone by hand, and they will appear here.';
  } else if(connected && !contacts){
    // The state that most needs explaining, and the one that looked like
    // silence: three people sat in it for days this week.
    headline = 'Calendar connected, nothing imported yet';
    detail = 'The first sync runs shortly. If it stays empty, check which events count as bookings in Settings.';
  } else if(!due){
    headline = contacts + (contacts === 1 ? ' contact' : ' contacts') + ' ready';
    detail = 'Nothing is due today. New bookings will appear here as they come in.';
  } else {
    headline = due + (due === 1 ? ' follow-up' : ' follow-ups') + ' due today';
    detail = 'Out of ' + contacts + (contacts === 1 ? ' contact' : ' contacts') + '. Work down the list and you are done.';
  }
  return {connected: connected, contacts: contacts, due: due, headline: headline, detail: detail};
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


// Which roles can go cold. Named stages would mean a custom pipeline's
// contacts never reach the Graveyard — and since the Graveyard is now what
// feeds the monthly revival touch, they would never be nurtured either.
var DEAD_ELIGIBLE_ROLES = {missed: true, lost: true, stalled: true};

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
  if(!DEAD_ELIGIBLE_ROLES[stageRole(client.status)] && !completedNotClosed) return false;

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

/* ---- where are they in the 5-touch run-up? ----
   The pre-call sequence is a countdown to one appointment: welcome, the
   week-of nudge, the mid-point check-in, the morning-of text and the hour
   before. Five touches, and knowing which one someone is on is the difference
   between a list of tasks and a sense of where each relationship stands.

   Derived from the active sequence rather than a fixed list of five, so a
   business that removes the Monday text sees "3 of 4" instead of a number
   that silently lies. The rescue sequences are excluded: they are not part of
   the run-up, they are what happens after it fails.

   Counted against the CURRENT appointment, so a call that moves resets the
   progress — the same reason hasSentStageThisAppointment exists. */
function cadenceTouches(){
  return ACTIVE_SEQUENCE.filter(function(step){
    return step.trigger && step.trigger.type !== 'repeat_while_role';
  }).map(function(step){ return step.stage; });
}

function cadenceProgress(client, now){
  now = now || new Date();
  var touches = cadenceTouches();
  var done = [];
  var pending = [];
  touches.forEach(function(stage){
    // welcome/rebooked/followup are one touch wearing three faces; any of them
    // counts as the introduction having happened.
    var sent = (stage === 'welcome')
      ? (hasSentStageThisAppointment(client, 'welcome') ||
         hasSentStage(client, 'rebooked') || hasSentStage(client, 'followup'))
      : hasSentStageThisAppointment(client, stage);
    (sent ? done : pending).push(stage);
  });
  var due = computeDue(client, now);
  var nextStage = null;
  for(var i = 0; i < touches.length && !nextStage; i++){
    if(pending.indexOf(touches[i]) !== -1) nextStage = touches[i];
  }
  return {
    done: done.length,
    total: touches.length,
    sentStages: done,
    nextStage: nextStage,
    // Is that next touch actually due now, or just not yet reached?
    nextIsDue: nextStage !== null && due.indexOf(nextStage) !== -1,
    complete: done.length === touches.length,
    label: done.length + ' of ' + touches.length
  };
}


/* Which single touch to send when several are due.

   Time-critical first: a meeting link beats an introduction. Then the rescue
   sequences, which only fire once a call has already been missed. Then the
   relationship touches in the order a person would actually send them — you
   introduce yourself before you check in on someone. */
var TOUCH_PICK_ORDER = ['hourbefore', 'dayof', 'noshow', 'recovery',
                        'welcome', 'rebooked', 'followup', 'monday', 'midcheckin'];

/* Has a cadence text already gone to this person today, where they are?

   Their timezone, not ours: "today" for someone in Hawaii is not today here,
   and the whole point is how many messages THEY received.

   Only sms. An email from the library is a different channel landing in a
   different place, and the two together is a normal follow-up, not a pile-on. */
function sentCadenceTouchToday(client, now){
  var log = client.messageLog || [];
  var tz = client.timezone || 'America/New_York';
  var todayKey = tzDateKey(now, tz);
  for(var i = 0; i < log.length; i++){
    var m = log[i];
    if((m.channel || 'sms') !== 'sms') continue;
    if(m.stage === 'email') continue;
    var t = safeDate(m.sentAt);
    if(t && tzDateKey(t, tz) === todayKey) return true;
  }
  return false;
}

function pickTodaysTouch(due){
  for(var i = 0; i < TOUCH_PICK_ORDER.length; i++){
    if(due.indexOf(TOUCH_PICK_ORDER[i]) !== -1) return TOUCH_PICK_ORDER[i];
  }
  // A stage from a custom sequence that isn't in the list still needs sending.
  return due[0];
}

// Collapses items belonging to the same human. Phone is the identity where
// there is one — names are typed inconsistently ("Karen  Villegas") in a way
// phone numbers are not.
function dedupeByPerson(items){
  var seen = {};
  var out = [];
  items.forEach(function(it){
    var phone = normalizedPhone(it.client.phone);
    var key = phone ? ('p:' + phone) : ('n:' + String(it.client.name || '').toLowerCase().replace(/\s+/g, ' ').trim());
    var prev = seen[key];
    if(prev === undefined){
      seen[key] = out.length;
      out.push(it);
      return;
    }
    var rankOf = function(x){
      var i = TOUCH_PICK_ORDER.indexOf(x.stage);
      return i === -1 ? TOUCH_PICK_ORDER.length : i;
    };
    if(rankOf(it) < rankOf(out[prev])) out[prev] = it;
  });
  return out;
}


function getTextTodayList(state, now, searchQuery){
  now = now || new Date();
  var q = (searchQuery||'').trim().toLowerCase();
  var allClients = Object.keys(state.clients).map(function(k){ return state.clients[k]; });
  var items = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    if(q && c.name.toLowerCase().indexOf(q) === -1) return;
    // A colleague's booking that happens to sit on your calendar is not yours
    // to follow up. They stay visible in All clients, marked, but never queued.
    if(isOthersLead(c, state.myCalendars)) return;
    var due = computeDue(c, now);
    /* The Graveyard used to be a dead end: once a contact went cold they were
       dropped from this list for good, on the reasoning that they had already
       had their last chase. That quietly contradicted the entire premise —
       never let a lead slip — and on the live book it had silenced 67 people.

       A cold contact now keeps exactly one thing: the monthly revival touch.
       The intensive sequences stay off, so nobody in the Graveyard gets chased
       weekly, but nobody is forgotten either. */
    if(isDeadClient(c, allClients, now)){
      due = due.filter(function(stage){ return stage === 'revival'; });
    }
    if(!due.length) return;
    // One message per person per day. Several touches can come due at once —
    // most often welcome, monday and midcheckin together after a booking is
    // backfilled or a call moves — and queuing them all meant the same person
    // appeared three times and would have been texted three times in an
    // afternoon. Whatever isn't picked today stays due tomorrow, so the
    // cadence still delivers every touch, just spread out the way a person
    // would send them.
    /* One relationship text per person per day, enforced on SENDS as well as
       on the queue.

       pickTodaysTouch already shows a single row per person when several
       touches come due at once. It did not stop the NEXT one appearing the
       moment the first was sent — so sending Caitlin her welcome text put her
       straight back in the list with a midpoint text, and anyone working the
       queue top to bottom would text the same person twice in an afternoon.
       The comment above has always claimed whatever is not picked "stays due
       tomorrow"; this is what makes that true.

       Time-critical touches are exempt. If the day-of link becomes due an
       hour after a welcome went out, it still goes out: missing a meeting
       link to avoid a second message is a far worse trade.

       Emails do not count. Sending the pre-call email and then the text is a
       normal thing to do, and the two are different channels arriving in
       different places. */
    var alreadyTexted = sentCadenceTouchToday(c, now);
    if(alreadyTexted){
      due = due.filter(function(stage){ return STAGE_PRIORITY.indexOf(stage) !== -1; });
      if(!due.length) return;
    }
    items.push({client: c, stage: pickTodaysTouch(due)});
  });

  /* Trickle the long-term nudges. Everything else in this list is time-bound
     — a call is today, a rescue window is closing — but revival has no
     deadline, so it is the one thing that can safely wait a day. Longest
     silence first: the people closest to being lost for good are reached
     first. */
  var revivals = items.filter(function(it){ return it.stage === 'revival'; });
  if(revivals.length > REVIVAL_DAILY_CAP){
    revivals.sort(function(a, b){
      var la = lastSentAtMs(a.client, null), lb = lastSentAtMs(b.client, null);
      var aMs = la === null ? 0 : la, bMs = lb === null ? 0 : lb;
      return aMs - bMs;
    });
    var keep = {};
    revivals.slice(0, REVIVAL_DAILY_CAP).forEach(function(it){ keep[it.client.id] = true; });
    items = items.filter(function(it){ return it.stage !== 'revival' || keep[it.client.id]; });
  }

  // And one card per PERSON, not per client record. A contact who ghosted and
  // rebooked legitimately has two client rows — that is how rebooked/followup
  // know who they are — but they are still one human with one phone, and
  // seeing them twice in the morning list is the same sloppiness by another
  // route. Keep whichever row's touch ranks highest.
  items = dedupeByPerson(items);
  items.sort(byTouchOrder);
  return items;
}


/* The order the morning list reads in.

   It used to have three buckets: first-time welcomes, no-shows, and
   everything else. That last one held day-of, hour-before, midpoint, Monday,
   recovery and revival together, sorted by call date — so a recovery nudge to
   someone who went cold in August sat between two day-of reminders, and the
   list looked like people thrown at a page in no order.

   Grouped by what the message IS, because that is how they get sent: you
   write four introductions in the same frame of mind, not one introduction,
   one reminder, one apology, one introduction.

   Reading down the list is the arc of a booking — say hello, remind them as
   the call approaches, rescue the ones who missed, then chase the cold ones
   last. Time-critical calls are not at risk from this: imminent ones have
   their own On deck panel with a live countdown. */
var TOUCH_LIST_ORDER = [
  // A first hello, and the two kinds of "we're back on".
  'welcome', 'rebooked', 'followup',
  // Reminders, in the order the cadence walks toward the call.
  'monday', 'midcheckin', 'dayof', 'hourbefore',
  // They missed it — the rescue window is short, so before the cold chasing.
  'noshow',
  // Chasing. Last, deliberately: these are the least time-bound and the most
  // draining to write, and they should not be the first thing seen.
  'recovery', 'revival'
];

function touchListRank(stage){
  var i = TOUCH_LIST_ORDER.indexOf(stage);
  // A stage from a custom sequence still has to land somewhere sensible:
  // after the known reminders, before the cold chasing.
  return i === -1 ? TOUCH_LIST_ORDER.indexOf('noshow') : i;
}

function byTouchOrder(a, b){
  var r = touchListRank(a.stage) - touchListRank(b.stage);
  if(r !== 0) return r;
  // Within a group, soonest call first — so the day-of block reads in the
  // order the calls actually happen.
  var da = safeDate(a.client.callDateTime), db = safeDate(b.client.callDateTime);
  return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
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
   Ghost Recall's own client data (not a live external embed: a
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

/* Past calls nobody has recorded an outcome for.

   This is the backlog that quietly distorts everything: it makes the show
   rate describe fewer calls than it appears to, leaves contacts in a limbo
   state the cadence has to special-case, and was the reason welcome texts
   were being queued for dates that had already gone.

   It only ever grew because the question was asked somewhere you had to
   choose to go. Exposed here so it can be asked on the screen you already
   open. */
/* Resolve a batch of old, unanswered calls in one go.

   Anything past a month is beyond honest recall — you will not remember
   whether a particular call in July happened. Answering those one at a time is
   guesswork dressed up as diligence, so this offers the three answers that are
   actually defensible at that distance:

     showed / missed  a judgement applied deliberately across the batch
     archive          "I do not know", which is the honest answer for most of
                      them and the only one that asserts nothing

   Archiving is not the same as a no-show. An unanswered call is already left
   out of the show rate — unknown, not a failure — so archiving keeps the
   number honest while clearing the list. Marking them missed would bias the
   rate down on a guess; marking them showed would bias it up. Which is why
   this asks rather than picking. */
function resolveStaleCalls(state, mode, olderThanDays, now){
  now = now || new Date();
  olderThanDays = (typeof olderThanDays === 'number') ? olderThanDays : 30;
  var targets = getUnloggedCalls(state, now).filter(function(it){
    return it.daysAgo >= olderThanDays;
  });
  targets.forEach(function(it){
    if(mode === 'archive'){
      it.client.ignored = true;
      recordEvent(state, it.client.id, 'contact.archived',
        {reason: 'stale unlogged call', daysAgo: it.daysAgo});
    } else {
      // Routed through setOutcome so it lands exactly as a manual answer
      // would, including the stage change and the event.
      setOutcome(state, it.client.id, mode === 'showed' ? 'Showed' : 'No-show', now);
    }
  });
  saveState(state);
  return {mode: mode, count: targets.length, olderThanDays: olderThanDays};
}


function getUnloggedCalls(state, now){
  now = now || new Date();
  var out = [];
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored) return;
    var d = safeDate(c.callDateTime);
    if(!d || d.getTime() >= now.getTime()) return;
    // An outcome means won or missed. Stalled and lost are answers too — they
    // say the appointment is not happening — so they are not owed one.
    var role = stageRole(c.status);
    if(role !== 'open') return;
    out.push({client: c, daysAgo: Math.floor((now.getTime() - d.getTime()) / 86400000)});
  });
  // Oldest first: the ones most likely to be forgotten, and the ones doing the
  // most damage to the numbers.
  out.sort(function(a, b){ return b.daysAgo - a.daysAgo; });
  return out;
}


/* Closing the books on today.

   This used to include every text still due, which is the Today tab's entire
   job and is already shown there as a progress bar with a copy-all button. It
   made the count large — 40 on the live book — and roughly a third of that was
   work the person had just been looking at.

   Worse, it meant the count could never reach zero while a single text was
   unsent, so the screen never felt finishable and the "Busted!" empty state
   was effectively unreachable. A list you cannot clear stops being a list you
   open.

   What is left is only what end of day is actually for: the questions that
   can ONLY be answered once the day is over, and that nothing else in the app
   asks. Did today's calls happen. Did the old ones. Did the won ones close.
   That is a handful, and a handful gets cleared. */
function computeEndOfDayItems(state){
  var now = new Date();
  var items = [];
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
  // Same role-not-name rule the live stats already follow; without it a custom
  // pipeline's weekly digest reports zeros for a week that went fine.
  var showed = inWeek.filter(function(c){ return isWon(c.status); });
  var noshow = inWeek.filter(function(c){ return isMissed(c.status); });
  var ghosted = inWeek.filter(function(c){ return stageRole(c.status) === 'lost'; });
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
  lines.push('Ghost Recall Weekly Digest — week of ' + fmtDate(startOfLocalWeek(now),'UTC'));
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
  pipelineHasStages: pipelineHasStages, DEAD_ELIGIBLE_ROLES: DEAD_ELIGIBLE_ROLES,
  defaultOpenStage: defaultOpenStage,
  buildIndustryTemplates: buildIndustryTemplates, industryTemplate: industryTemplate,
  buildDefaultTerminology: buildDefaultTerminology, setTerminology: setTerminology,
  getTerminology: getTerminology, term: term, termLower: termLower,
  stageRole: stageRole, stageLabel: stageLabel, isWon: isWon, isMissed: isMissed,
  isStalledStage: isStalledStage, isOpenStage: isOpenStage, isResolvedStage: isResolvedStage,
  stopsCadence: stopsCadence,
  uid: uid, nowISO: nowISO, safeDate: safeDate, escapeHtml: escapeHtml, clamp: clamp,
  buildDefaultVariants: buildDefaultVariants, buildDefaultEmailVariants: buildDefaultEmailVariants,
  emailVariantsFor: emailVariantsFor, getEmailDraft: getEmailDraft,
  getAuthoredEmailDraft: getAuthoredEmailDraft, stageTiming: stageTiming, emailEditableStages: emailEditableStages,
  calendarHealth: calendarHealth, describeCalendarHealth: describeCalendarHealth,
  STALE_AFTER_HOURS: STALE_AFTER_HOURS,
  TOUCH_LIST_ORDER: TOUCH_LIST_ORDER, touchListRank: touchListRank, byTouchOrder: byTouchOrder,
  tidyTemplate: tidyTemplate,
  buildNotesPrompt: buildNotesPrompt, splitDraftedEmail: splitDraftedEmail,
  touchLabel: touchLabel,
  sanitizeEmailDoc: sanitizeEmailDoc, emailLibrary: emailLibrary, seedEmailLibrary: seedEmailLibrary,
  starterEmailLibrary: starterEmailLibrary,
  emailForTouch: emailForTouch,   renderEmailDoc: renderEmailDoc, exportEmailLibrary: exportEmailLibrary, exportEmailDoc: exportEmailDoc,
  exportFilename: exportFilename,
  buildDefaultState: buildDefaultState,
  sanitizeClient: sanitizeClient, sanitizeSnoozedUntil: sanitizeSnoozedUntil, migrateState: migrateState,
  tzDateKey: tzDateKey, keyToUTCms: keyToUTCms, keyPlusDays: keyPlusDays, mondayOfWeekKey: mondayOfWeekKey,
  fmtDate: fmtDate, fmtTime: fmtTime, weekdayName: weekdayName, localHourInTZ: localHourInTZ,
  tzOffsetMinutes: tzOffsetMinutes, formatDatetimeLocalInTZ: formatDatetimeLocalInTZ,
  parseDatetimeLocalInTZ: parseDatetimeLocalInTZ, startOfLocalDay: startOfLocalDay,
  startOfLocalWeek: startOfLocalWeek, inRange: inRange,
  hasSentStage: hasSentStage, hasSentStageThisAppointment: hasSentStageThisAppointment,
  appointmentSetAt: appointmentSetAt, lastSentAtMs: lastSentAtMs, computeDue: computeDue,
  REVIVAL_EVERY_DAYS: REVIVAL_EVERY_DAYS, REVIVAL_DAILY_CAP: REVIVAL_DAILY_CAP, REPLY_PAUSE_DAYS: REPLY_PAUSE_DAYS, PAUSE_EXEMPT_STAGES: PAUSE_EXEMPT_STAGES, STAGE_PRIORITY: STAGE_PRIORITY, replyPauseUntil: replyPauseUntil,
  buildDefaultSequence: buildDefaultSequence, setSequence: setSequence, getSequence: getSequence, stepIsDue: stepIsDue,
  describeTrigger: describeTrigger,
  extractChannelHandle: extractChannelHandle, eligibleVariants: eligibleVariants, pickVariant: pickVariant,
  firstName: firstName, renderTemplate: renderTemplate, getCardText: getCardText, getOriginalText: getOriginalText,
  markSent: markSent, snoozeTouch: snoozeTouch, skipTouch: skipTouch, unskipTouch: unskipTouch,
  sanitizeSkipped: sanitizeSkipped, toggleReplied: toggleReplied, recordReschedule: recordReschedule,
  uuid: uuid, recordEvent: recordEvent,
  reviewMessage: reviewMessage, getAwaitingReview: getAwaitingReview,
  recommendNextAction: recommendNextAction, consecutiveUnanswered: consecutiveUnanswered,
  UNANSWERED_SWITCH_AT: UNANSWERED_SWITCH_AT,
  computeVariantPerformance: computeVariantPerformance, VARIANT_MIN_SAMPLE: VARIANT_MIN_SAMPLE,
  buildTimeline: buildTimeline, EVENT_LABELS: EVENT_LABELS,
  REPLY_WAIT_HOURS: REPLY_WAIT_HOURS, messageState: messageState, lastInteraction: lastInteraction,
  messageSource: messageSource, replySource: replySource,
  explainDue: explainDue,   interactionLabel: interactionLabel, INTERACTION_OUTCOMES: INTERACTION_OUTCOMES,
  stageWithRole: stageWithRole, recordInteractionOutcome: recordInteractionOutcome,
  HOURBEFORE_LEAD_MIN: HOURBEFORE_LEAD_MIN, HOURBEFORE_FLOOR_MIN: HOURBEFORE_FLOOR_MIN,
  OUTCOME_TO_STATUS: OUTCOME_TO_STATUS, setOutcome: setOutcome,
  AREA_CODE_TZ: AREA_CODE_TZ, areaCodeFromPhone: areaCodeFromPhone, timezoneForClient: timezoneForClient,
  resolveClientTimezone: resolveClientTimezone, tzLabel: tzLabel, meetLinkFromEvent: meetLinkFromEvent,
  PHONE_RE: PHONE_RE, EMAIL_RE: EMAIL_RE, extractPhone: extractPhone, extractYoutube: extractYoutube,
  extractMeetLink: extractMeetLink, pad2: pad2,
  stripHtml: stripHtml, parseICS: parseICS, isStrategySessionEvent: isStrategySessionEvent,
  teamOverview: teamOverview, teamMemberState: teamMemberState, teamReplyRate: teamReplyRate,
  platformOverview: platformOverview, accountDiagnosis: accountDiagnosis,
  TEAM_IDLE_DAYS: TEAM_IDLE_DAYS, TEAM_STATE_ORDER: TEAM_STATE_ORDER,
  matchesCalendarFilter: matchesCalendarFilter,
  isSharedMailDomain: isSharedMailDomain, internalDomain: internalDomain,
  recurringSeriesKey: recurringSeriesKey, collapseRecurringSeries: collapseRecurringSeries,
  DEFAULT_CALENDAR_FILTER: DEFAULT_CALENDAR_FILTER, LEGACY_CALENDAR_FILTER: LEGACY_CALENDAR_FILTER,
  parseICSDate: parseICSDate, extractAttendeeEmails: extractAttendeeEmails, clientFromICSEvent: clientFromICSEvent,
  MONTHS: MONTHS, parseHeuristicDate: parseHeuristicDate, parseBulkBlock: parseBulkBlock, parseBulkPaste: parseBulkPaste,
  commitImportedClients: commitImportedClients, addManualClient: addManualClient, deleteClient: deleteClient,
  buildDefaultScoreWeights: buildDefaultScoreWeights, ghostScoreBand: ghostScoreBand,
  SCORE_GROUPS: SCORE_GROUPS, scoreGroupOf: scoreGroupOf,
  computeGhostScore: computeGhostScore, describeScore: describeScore, rankByGhostScore: rankByGhostScore,
  sentCadenceTouchToday: sentCadenceTouchToday,   pickTodaysTouch: pickTodaysTouch, dedupeByPerson: dedupeByPerson, TOUCH_PICK_ORDER: TOUCH_PICK_ORDER,
  cadenceTouches: cadenceTouches, cadenceProgress: cadenceProgress,
  computeStats: computeStats, pct: pct, statusLabel: statusLabel,
  setBookingLink: setBookingLink, getBookingLink: getBookingLink,
    SCHEDULING_PROVIDERS: SCHEDULING_PROVIDERS, SCHEDULING_LEVELS: SCHEDULING_LEVELS,
  schedulingStatus: schedulingStatus,   describeSetup: describeSetup,   computeHealthAlerts: computeHealthAlerts, getTextTodayList: getTextTodayList, byCallDate: byCallDate,
  getUnloggedCalls: getUnloggedCalls, resolveStaleCalls: resolveStaleCalls,
  sameContact: sameContact, normalizedPhone: normalizedPhone, isDeadClient: isDeadClient, computeDeadClients: computeDeadClients,
  isOthersLead: isOthersLead, canEmail: canEmail, gmailComposeUrl: gmailComposeUrl,
  businessEmailAccount: businessEmailAccount,
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
// Deno reads a .js file as an ES module, where top-level declarations are
// module-scoped and neither `module` nor `window` exists. Assigning to
// globalThis is what lets an Edge Function `import` this file for its side
// effect and then pick the exports up — which in turn lets the import be
// STATIC, so the deploy bundler actually uploads this file. A dynamic
// createRequire looked equivalent and silently shipped a function whose
// dependency was missing.
if(typeof globalThis !== 'undefined'){ globalThis.GBLogic = __LOGIC_EXPORTS__; }
