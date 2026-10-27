'use strict';
/* Ghost Recall (hosted build) — render layer, event handling, and app boot.
   Loaded after logic.js AND data.js via <script src="app.js"> in index.html.
   loadState()/saveState() are NOT defined here — data.js provides
   Supabase-backed versions under those same names (loadState now returns a
   Promise; saveState still fires-and-forgets like it always did, since every
   call site already ignores its return value). Everything else in this file
   calls the logic.js globals directly, exactly as in the local build. */


/* ============================================================
   6) IMPORT — .ics, bulk paste, manual add
   ============================================================ */

// The area-code guess is a starting point, not a fact — someone can carry a
// phone number from a city they no longer live in. There's no reliable way to
// pull a real location out of a YouTube channel from a local, backend-less
// file (that's a live network call, blocked by CORS from file://, and even
// with an API most channels never fill in a location anyway) — so instead
// every client gets an explicit, one-click-editable timezone.
var TZ_OPTIONS = [
  {value:'America/New_York', label:'Eastern — America/New_York'},
  {value:'America/Chicago', label:'Central — America/Chicago'},
  {value:'America/Denver', label:'Mountain — America/Denver'},
  {value:'America/Phoenix', label:'Arizona (no DST) — America/Phoenix'},
  {value:'America/Los_Angeles', label:'Pacific — America/Los_Angeles'}
];

function timezoneSelectHtml(id, dataAttrs, selectedTz){
  var opts = TZ_OPTIONS.map(function(o){
    return '<option value="'+o.value+'"'+(o.value===selectedTz?' selected':'')+'>'+o.label+'</option>';
  }).join('');
  return '<select id="'+id+'" '+dataAttrs+'>'+opts+'</select>';
}


/* The brandmark, inline, for headings that used to carry a ghost emoji.

   An emoji is drawn by whatever font the device has, so the same heading was
   a flat glyph on one machine and a colour cartoon on another, and neither
   was the product's own mark. This is the mark from the header, at text size
   and inheriting the text colour. */
function brandMarkHtml(size, cls){
  size = size || 18;
  return '<svg class="' + (cls || 'inline-mark') + '" width="' + size + '" height="' + size + '"' +
    ' viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill-rule="evenodd" fill="currentColor" d="M30 9c-10.5 0-18 7.4-18 18v19.3c0 2.4 2.8 3.6 4.5 2l3.3-3.1 3.4 3.1c1 1 2.6 1 3.6 0l3.4-3.1 3.4 3.1c1 1 2.6 1 3.6 0l3.3-3.1 3.2 3c1.7 1.6 4.3.3 4.3-2V27c0-10.6-7.5-18-18-18zM24 25a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM36 25a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z"/>' +
    '<path d="M53.5 15.5a12 12 0 0 1 3.2 9" fill="none" stroke="#dc2f4a" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M50 23.2a5.5 5.5 0 0 1 1.5 4.1" fill="none" stroke="#dc2f4a" stroke-width="3.6" stroke-linecap="round"/>' +
    '</svg>';
}

// A friendly big-green-ghost mascot for "nothing here" moments — distinct from
// the thumbs-up badge, which is reserved for actually clearing your queue.
function slimerSvg(size){
  size = size || 64;
  return '<svg class="slimer-mark" width="'+size+'" height="'+size+'" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs><radialGradient id="slimerGrad" cx="35%" cy="28%" r="80%">' +
      '<stop offset="0%" stop-color="var(--slime-bright)"/>' +
      '<stop offset="100%" stop-color="var(--slime-dark)"/>' +
    '</radialGradient></defs>' +
    '<path d="M50 6C27 6 12 24 12 46v34c0 3 3.4 4.4 5.6 2.2l5-5 5.5 6 5.9-6 6 6 6-6 6 6 5.9-6 5.5 6 5-5C90.6 84.4 94 83 94 80V46C94 24 79 6 50 6z" fill="url(#slimerGrad)"/>' +
    '<path d="M30 42q6-9 12 0" stroke="#123318" stroke-width="4.2" stroke-linecap="round" fill="none"/>' +
    '<path d="M58 42q6-9 12 0" stroke="#123318" stroke-width="4.2" stroke-linecap="round" fill="none"/>' +
    '<ellipse cx="50" cy="59" rx="14" ry="9" fill="#123318"/>' +
    '<ellipse cx="50" cy="65" rx="6.5" ry="5.5" fill="#e0607e"/>' +
  '</svg>';
}


/* ============================================================
   9) APP STATE + UI RENDER
   ============================================================ */

var STATE = null;

var UI = {tab:'calls', statsRange:'today', callsSearch:'', touchFilter:'', touchPick:{}, clientsSearch:'', statusFilter:null, calendarView:'month', calendarAnchor:new Date(), recentSendsOpen:true,
  // Which conversation the messaging workspace is showing. Null on a phone
  // means the list is up; on a desktop the newest thread is picked so the
  // panes are never all empty at once.
  threadCid:null,
  // What is typed in the conversation search. Held here rather than read
  // off the input so a re-render cannot silently drop it.
  msgxQuery:'',
  // Which contact+touch the composer has already been seeded with, so a
  // re-render never retypes over somebody mid-sentence.
  msgxPrefilled:null,
  // Which of the four questions the list is answering.
  // Opens on the work. 'All' is a contact list; this is a queue.
  msgxFilter:'action',
  // The conversation somebody actually chose, as opposed to one the
  // desktop layout auto-selected. Only the former counts as read.
  msgxOpened:null,
  // Where the open contact sat in the queue when it was opened.
  msgxIndex:-1,
  // The Today card list, folded away by default now the workspace exists.
  /* null means "nobody has said yet", which is not the same as false.
     Resolved from the stored preference on first use, defaulting to OPEN. */
  textTodayOpen:null,
  // Which message has its delivery detail open. One at a time.
  dlvOpen:null,
  // Which right-column sections are folded open. The two that hold
  // history start closed; the rest are not collapsible at all.
  msgxSections:{activity:false, more:false},
  // Which channel's conversation is on screen: 'sms', 'email' or 'notes'.
  msgxChannel:'sms',
  /* Unsent drafts, keyed by contact AND channel. Switching tabs or clients
     must not throw away something half-typed -- that is somebody's words,
     and losing them is worse than any amount of layout polish. */
  drafts:{}};

var lastSnapshot = null; // for toast Undo


function snapshot(){ try{ return JSON.stringify(STATE); }catch(e){ return null; } }

function restoreSnapshot(json){ if(!json) return; STATE = JSON.parse(json); saveState(STATE); renderAll(); }


function el(id){ return document.getElementById(id); }

function h(tag, attrs, children){
  var e = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function(k){
    if(k === 'class') e.className = attrs[k];
    else if(k === 'html') e.innerHTML = attrs[k];
    else if(k.indexOf('data-') === 0) e.setAttribute(k, attrs[k]);
    else e.setAttribute(k, attrs[k]);
  });
  (children||[]).forEach(function(c){ if(c) e.appendChild(typeof c==='string' ? document.createTextNode(c) : c); });
  return e;
}


// Static chrome carries data-term markers so the configured vocabulary reaches
// the shell too, not just the panels that build their text in JS. Without this
// the terminology setting is half-applied — which reads worse than not being
// configurable at all, because the interface contradicts itself.
function applyTerminology(){
  var nodes = document.querySelectorAll('[data-term]');
  for(var i = 0; i < nodes.length; i++){
    nodes[i].textContent = term(nodes[i].getAttribute('data-term'));
  }
}

/* A visible, persistent warning when work is not reaching the database.

   Deliberately not a toast: a toast disappears, and the thing it would be
   announcing is that everything done since is being lost. This stays until
   a save succeeds, and it names the last thing that failed so the problem is
   reportable rather than just alarming.

   Installed as a window property rather than a shared function name — the bug
   this exists to surface was itself caused by two files declaring the same
   top-level name. */
window.GB_ON_SAVE_HEALTH = function(health){
  var bar = el('save-health');
  if(!bar) return;
  if(health.ok){
    bar.classList.add('hidden');
    bar.textContent = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  bar.appendChild(h('strong',{},['Your changes aren’t being saved.']));
  bar.appendChild(document.createTextNode(
    ' Anything you do now will be lost when you close this tab' +
    (health.detail ? ' (' + health.detail + ')' : '') + '. '));
  bar.appendChild(h('button',{class:'btn btn-sm','data-action':'retry-save'},['Try again']));
};


var TEAM_STATE_CLASS = {
  'never started':'s-never', 'gone quiet':'s-quiet', 'sync broken':'s-sync',
  'not logging in':'s-never', 'needs calendar':'s-sync', 'not set up':'s-setup',
  'working':'s-ok'
};

// "last in 12d" next to the name answers the question the counts raise:
// is this person ignoring their list, or not getting into the app at all?
function lastSeenLabel(days){
  if(days === null || days === undefined) return '';
  if(days <= 0) return 'in today';
  if(days === 1) return 'in yesterday';
  return 'last in ' + days + 'd ago';
}

/* The team view.

   Renders nothing and hides its own tab unless STATE.team actually holds
   rows. A manager tab that appears for everybody and shows an empty table is
   worse than no tab: it reads as "your team has no activity" rather than
   "this is not for you". */
/* Which teammate's queue is expanded, by user id rather than by name.

   It was the name. Names are not identifiers: they come from sender_name,
   which anybody can set to anything, falling back to the local part of a
   calendar address, falling back to the literal string "teammate" for
   somebody who has neither. Two people called Ethan is not a hypothetical on
   this book — there are two Ethan accounts — and the moment their names
   matched, expanding one row expanded both, the bulk-cover dropdown lookup
   returned whichever sorted first, and "Move them" would have handed over the
   wrong person's appointments. */
var TEAM_OPEN = null;

// Day and time in the viewer's own zone. A manager is deciding whether to
// chase somebody today, so the weekday matters more than the date.
/* A call's time where the PERSON READING IT is sitting.

   Ghost Recall shows two different clocks on purpose. "Is this a reasonable
   hour to text them" is about the contact, and the chips that answer it say
   "their time". "When is this call" is about you, and it has to match the
   calendar you are looking at.

   The On Deck panel was answering the second question with the first clock.
   It printed a headline of 12:00 PM for a call a New York user has at 3pm,
   with "12:00 PM their time" on a chip directly underneath — the same number
   twice, one of them silently meaning something else. Reported as a bug, and
   it reads as one: the headline disagreed with Google Calendar.

   No timeZone passed, so Intl uses the browser's. fmtTime defaults to UTC
   when given nothing, which is why this cannot just call it. */
function fmtTimeHere(d){
  if(!d || isNaN(d.getTime())) return '';
  try{
    return new Intl.DateTimeFormat('en-US',{hour:'numeric', minute:'2-digit'}).format(d);
  }catch(e){ return d.toTimeString().slice(0,5); }
}
function fmtDateHere(d){
  if(!d || isNaN(d.getTime())) return '';
  try{
    return new Intl.DateTimeFormat('en-US',{month:'short', day:'numeric'}).format(d);
  }catch(e){ return d.toDateString(); }
}

function fmtDayTime(iso){
  var d = iso ? new Date(iso) : null;
  if(!d || isNaN(d.getTime())) return 'no date';
  try{
    return new Intl.DateTimeFormat('en-US',
      {weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}).format(d);
  }catch(e){ return d.toDateString(); }
}

/* Moving an appointment to a different owner.

   Lives here rather than in the click dispatcher because a <select> fires
   'change', not 'click' — the first version of this was a switch case that
   could never have run. */
function assignFromPicker(target){
  var moveId = target.getAttribute('data-cid');
  var moveFrom = target.getAttribute('data-from');
  var moveTo = target.value;
  if(!moveId || !moveTo) return;
  var toLabel = target.options && target.options[target.selectedIndex]
    ? target.options[target.selectedIndex].text : 'them';
  target.disabled = true;
  // Names, so the contact's timeline reads "Ronin -> Ethan (by Johnny)"
  // rather than three uuids nobody can place.
  reassignClient(moveId, moveTo, {
    fromUserId: (STATE.team || []).filter(function(x){ return x.name === moveFrom; })
                  .map(function(x){ return x.userId; })[0] || null,
    fromName: moveFrom, toName: toLabel, byName: STATE.senderName || null
  }).then(function(r){
    if(!r.ok){
      showToast('Could not move it: ' + (r.error || 'refused'));
      target.disabled = false;
      renderTeamTab();   // put the picker back on the real owner
      return;
    }
    showToast('Moved from ' + moveFrom + ' to ' + toLabel + '.');
    /* A full reload rather than patching two lists in memory: the contact has
       to leave one person's row and appear in another's, and the cadence has
       to recompute against the new owner. */
    init();
  });
}

/* The owner picker on a queue row. Current owner preselected, so leaving it
   alone is always the no-op and only a deliberate change moves anything. */
function assignPicker(q, member, members){
  var sel = h('select',{class:'tq-assign','data-action':'team-assign',
                        'data-cid':q.clientId,'data-from':member.name,
                        title: q.untouched
                          ? 'Move this appointment to someone else'
                          : 'Already ' + q.sent + ' message(s) sent — moving it takes over mid-conversation'},[]);
  members.forEach(function(x){
    if(!x.userId) return;
    var label = (x.userId === STATE.userId) ? 'me' : x.name;
    var o = h('option',{value:x.userId}, [label]);
    if(x.userId === member.userId) o.selected = true;
    sel.appendChild(o);
  });
  if(!q.untouched) sel.className += ' has-history';
  return sel;
}

/* An invite waiting for you, shown above everything regardless of tab.
   Accepting moves your contacts into their organisation, so the banner says
   that in words rather than hiding it behind a friendly verb. */
function renderPendingInvites(){
  var box = el('pending-invites');
  if(!box) return;
  var invites = (STATE && STATE.pendingInvites) || [];
  box.innerHTML = '';
  if(!invites.length){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  invites.forEach(function(inv){
    box.appendChild(h('div',{class:'invite-row'},[
      h('div',{},[
        h('strong',{},[inv.orgName]),
        ' invited you to join their team',
        inv.role === 'admin' ? ' as a manager' : '',
        h('div',{class:'invite-note'},[
          'Your ' + termLower('contactPlural') + ', messages and settings move into their ' +
          'account, and a manager there will be able to see them.'
        ])
      ]),
      h('div',{class:'invite-acts'},[
        h('button',{class:'btn btn-green btn-sm','data-action':'invite-accept','data-id':inv.id},
          ['Join ' + inv.orgName])
      ])
    ]));
  });
}

/* Adding somebody to the team.

   Shared by two callers on purpose. It sits at the bottom of a populated team
   view, because building the team is a once-in-a-while act and working it is
   daily — but it is also the WHOLE of the tab for an account that is still one
   person, since that account is where every new customer starts. */
function invitePanel(){
  var add = h('div',{class:'team-invite'},[]);
  add.appendChild(h('div',{class:'team-notstarted-head'},['Add someone']));
  add.appendChild(h('div',{class:'invite-form'},[
    h('input',{type:'email', id:'invite-email', placeholder:'their work email', class:'lib-input'}),
    h('button',{class:'btn btn-sm btn-green','data-action':'invite-send'},['Invite'])
  ]));
  add.appendChild(h('div',{class:'invite-note'},[
    'They sign in with Google and accept the invite themselves. Nothing of ' +
    'theirs moves across until they do, and you will not see anything of ' +
    'theirs before then.'
  ]));
  (STATE.sentInvites || []).forEach(function(inv){
    add.appendChild(h('div',{class:'invite-pending'},[
      inv.email + ' \u2014 invited, not accepted yet'
    ]));
  });
  return add;
}

/* Appointing another manager, on the row of the person being appointed.

   Only shown to someone who can already manage, and never on their own row:
   set_member_role refuses a self-change, because that refusal is the whole
   reason an organisation cannot be left with no manager at all. Offering a
   button that always fails would be worse than offering none, so the row the
   manager is standing on simply says so.

   A manager badge still shows for everyone, including yourself, because "who
   else can see all this" is a reasonable thing to be able to check. */
/* Eight weeks of activity, as bars.

   The row above says how somebody is doing now. This says whether that is
   new. A manager's real question after having a word is "did that change
   anything", and neither a snapshot nor a 7-day arrow can answer it — a
   single burst ageing out of a rolling window looks exactly like somebody
   stopping. On this book the bars show Ethan and Ronin going from nothing to
   eighteen and twenty-two in the week of 28 September, which is the whole
   story in one glance.

   The live week is drawn hatched and labelled "so far". Today is two and a
   half days into it, so that bar is short by construction and an unmarked one
   reads as a collapse every time somebody looks before Friday.

   Counts, not rates. A weekly show-up rate on three to sixteen decided calls
   swings fifteen points on noise; how many messages somebody sent is simply
   true. */
/* Whether following up beforehand actually changes attendance, for this
   person, on their own calls.

   The question this product was pointed at from the start, refused three
   times for want of data, and answerable now for anybody with both halves.
   The first honest answer it produces is that there is no measurable
   difference — 45% against 43% across sixty-odd calls each side — which is
   worth far more on this screen than a number that merely looks like
   progress. A manager who assumes follow-up drives attendance will push for
   more of it and read noise as proof.

   Says "no measurable difference" rather than "it does not work", because
   whether somebody texts before a call is not random: you chase the ones you
   are worried about, so the touched group is pre-selected for doubt. That can
   hide a real effect, and the panel should not pretend otherwise. */
/* When this person's calls actually get attended.

   The only dimension tried on this book that showed a real pattern AND
   survived being split into two independent halves — one person at 33% midday
   against 62% in the afternoon, reproduced in both periods. Five things had
   been tested by then and testing enough of them guarantees one looks
   significant, so replication is what earned this a place rather than a
   p-value.

   The bands are listed, never ranked. Picking the best and worst of four and
   quoting the gap overstates by construction: some spread is certain even in
   noise, and a manager reading "your 11am slot is your worst" will move
   bookings on the strength of it. Numbers and counts, and let them look. */
function attendancePanel(m){
  var bands = attendanceByHour(m);
  var wrap = h('div',{class:'te-wrap'},[]);
  if(!bands.length) return wrap;        // nothing honest to say yet
  wrap.appendChild(h('div',{class:'act-head'},['Attendance by time of day']));
  var row = h('div',{class:'te-cmp'},[]);
  bands.forEach(function(b){
    row.appendChild(h('div',{},[
      h('b',{},[b.pct + '%']), b.label, h('i',{},[b.decided + ' calls'])
    ]));
  });
  wrap.appendChild(row);
  wrap.appendChild(h('div',{class:'act-foot'},[
    'Their local time, worked out from the phone number, so treat it as '
    + 'roughly right. Bands with fewer than ' + ATTENDANCE_MIN
    + ' decided calls are left out rather than shown as a percentage.'
  ]));
  return wrap;
}

function touchEffectPanel(m){
  var e = touchEffect(m);
  var wrap = h('div',{class:'te-wrap'},[]);
  wrap.appendChild(h('div',{class:'act-head'},['Does following up first change anything?']));
  if(!e.measurable){
    wrap.appendChild(h('div',{class:'act-foot'},[
      e.shortSide === 'touched'
        ? 'Only ' + e.withCalls + ' decided ' + (e.withCalls === 1 ? 'call' : 'calls') +
          ' had a message sent beforehand, against ' + e.withoutCalls +
          ' with none. Not enough on the followed-up side to compare yet.'
        : 'Only ' + e.withoutCalls + ' decided ' + (e.withoutCalls === 1 ? 'call' : 'calls') +
          ' had nothing sent beforehand, against ' + e.withCalls +
          ' that did. Nothing to compare against yet.'
    ]));
    return wrap;
  }
  var same = Math.abs(e.diff) < 5;
  wrap.appendChild(h('div',{class:'te-cmp'},[
    h('div',{},[h('b',{},[e.withPct + '%']), 'followed up first',
                h('i',{},[e.withCalls + ' calls'])]),
    h('div',{},[h('b',{},[e.withoutPct + '%']), 'nothing sent',
                h('i',{},[e.withoutCalls + ' calls'])])
  ]));
  wrap.appendChild(h('div',{class:'act-foot'},[
    same
      ? 'No measurable difference. Following up before the call is not what '
        + 'moves attendance here \u2014 worth knowing before pushing for more of it.'
      : (e.diff > 0
          ? e.diff + ' points better when something was sent first.'
          : Math.abs(e.diff) + ' points worse when something was sent first \u2014 '
            + 'most likely because the ones chased are the ones already in doubt.')
  ]));
  return wrap;
}

/* How many of the team are sending at all, week by week.

   The lead line compares this week with last, which on a small team is mostly
   whoever had a busy Tuesday: this book swung 202 messages to 49 with nothing
   about the team having changed. The count of people sending did change, from
   one for eight straight weeks to three to four, and nothing on the screen
   said so.

   People first, messages second and smaller. A manager moving a team from one
   sender to four is doing the thing that matters; total volume is the number
   that will flatter or alarm them for no reason. */
function teamActivityStrip(rows){
  var weeks = teamWeeklyActivity(rows);
  var wrap = h('div',{class:'tw-strip'},[]);
  if(weeks.length < 2) return wrap;
  var peak = weeks.reduce(function(n, w){ return Math.max(n, w.senders); }, 0);
  if(!peak) return wrap;                 // nobody has sent anything, ever
  var bars = h('div',{class:'tw-bars'},[]);
  weeks.forEach(function(w){
    var when = new Date(w.weekStart);
    var label = isNaN(when.getTime()) ? '' :
      when.toLocaleDateString(undefined,{month:'short', day:'numeric', timeZone:'UTC'});
    bars.appendChild(h('div',{class:'tw-bar' + (w.partial ? ' is-partial' : ''),
      title: w.senders + (w.senders === 1 ? ' person sent' : ' people sent') + ' \u2014 ' +
             w.messages + (w.messages === 1 ? ' message' : ' messages') +
             ' in the week of ' + label + (w.partial ? ' (this week, still running)' : '')},[
      h('i',{style:'height:' + Math.max(Math.round((w.senders / peak) * 100), w.senders ? 8 : 3) + '%'},[])
    ]));
  });
  var last = weeks[weeks.length - 1];
  wrap.appendChild(h('div',{class:'tw-head'},[
    h('b',{},[String(last.senders)]),
    (last.senders === 1 ? ' person has sent something this week' : ' people have sent something this week'),
    h('span',{},[' \u00b7 ' + last.messages + (last.messages === 1 ? ' message' : ' messages')])
  ]));
  wrap.appendChild(bars);
  wrap.appendChild(h('div',{class:'tw-foot'},[
    'People sending, last 8 weeks. The last bar is this week so far.'
  ]));
  return wrap;
}

function activityBars(m){
  var weeks = m.weeks || [];
  var wrap = h('div',{class:'act-wrap'},[]);
  if(!weeks.length) return wrap;
  var peak = weeks.reduce(function(n, w){ return Math.max(n, w.count); }, 0);
  wrap.appendChild(h('div',{class:'act-head'},['Messages sent, last 8 weeks']));
  var row = h('div',{class:'act-bars'},[]);
  weeks.forEach(function(w){
    var when = new Date(w.weekStart);
    var label = when.toLocaleDateString(undefined,{month:'short', day:'numeric', timeZone:'UTC'});
    // A zero week still gets a visible baseline: an absent bar and a bar of
    // height zero mean the same thing and should look the same.
    var pct = peak ? Math.round((w.count / peak) * 100) : 0;
    var bar = h('div',{class:'act-bar' + (w.partial ? ' is-partial' : ''),
      title: w.count + (w.count === 1 ? ' message' : ' messages') +
             ' in the week of ' + label + (w.partial ? ' (this week, still running)' : '')},[
      h('i',{style:'height:' + Math.max(pct, w.count ? 6 : 2) + '%'},[])
    ]);
    row.appendChild(bar);
  });
  wrap.appendChild(row);
  var last = weeks[weeks.length - 1];
  wrap.appendChild(h('div',{class:'act-foot'},[
    'Last bar is this week so far \u2014 ' + last.count +
    (last.count === 1 ? ' message' : ' messages') + ' to date.'
  ]));
  return wrap;
}

function roleControl(m){
  var wrap = h('div',{class:'team-role'},[]);
  if(m.isManager){
    wrap.appendChild(h('span',{class:'role-badge', title:'Can see the whole team'},['manager']));
  }
  if(!STATE.canInvite) return wrap;
  if(m.userId === STATE.userId){
    // Not a button. See above: it could only ever be refused.
    wrap.appendChild(h('span',{class:'role-self', title:
      'Nobody can change their own role \u2014 it is what stops a team being '
      + 'left with no manager. Another manager can change yours.'},['you']));
    return wrap;
  }
  wrap.appendChild(h('button',{
    class:'btn btn-sm btn-ghost role-btn',
    'data-action':'set-role', 'data-uid':m.userId,
    'data-role': m.isManager ? 'member' : 'admin',
    title: m.isManager
      ? 'Stand ' + m.name + ' down to an ordinary member'
      : m.name + ' will see everyone\u2019s numbers and be able to invite people'},
    [m.isManager ? 'Remove manager' : 'Make manager']));
  return wrap;
}

function renderTeamTab(){
  var box = el('team-view');
  var btn = el('tab-btn-team');
  if(!box) return;

  var rows = STATE && STATE.team;
  if(!rows || !rows.length){
    box.innerHTML = '';
    /* One person is not a team, so there is nothing to report — but it is
       exactly where a new customer sits, and hiding the tab here is what
       previously left them with no way to add their first colleague. So the
       tab stays if they could invite, carrying only the invite box. */
    if(!STATE || !STATE.canInvite){
      if(btn) btn.classList.add('hidden');
      return;
    }
    if(btn) btn.classList.remove('hidden');
    box.appendChild(h('div',{class:'invite-note'},[
      'It is just you in ' + (STATE.orgName || 'this account') + ' so far. Add ' +
      'somebody and this tab starts showing who is working their list, who has ' +
      'gone quiet, and where calls are being booked but not followed up.'
    ]));
    box.appendChild(invitePanel());
    return;
  }
  if(btn) btn.classList.remove('hidden');

  var o = teamOverview(rows, new Date());
  /* A count on the tab itself, because none of this reaches a manager who does
     not click through.

     Everything else built for this screen assumes somebody is already looking
     at it. The one fact that cannot wait for that is a call happening TODAY
     with nothing sent — by the time it is noticed tomorrow it is a no-show.
     Seventeen of those were sitting on this book while the manager's own
     morning list showed two.

     Deliberately the same number the tab's urgent line shows. A badge that
     disagreed with the screen it points at would read as a bug. */
  if(btn){
    var badge = btn.querySelector('.tab-badge');
    if(o.todayUntouched){
      if(!badge){
        badge = h('span',{class:'tab-badge'},[]);
        btn.appendChild(badge);
      }
      badge.textContent = String(o.todayUntouched);
      badge.setAttribute('title', o.todayUntouched +
        (o.todayUntouched === 1 ? ' call happening today that' : ' calls happening today that') +
        ' nobody has messaged');
    } else if(badge){
      badge.remove();
    }
  }
  /* The team's own word for a booking, or a neutral one where they differ.
     termLower() would give the SIGNED-IN manager's word and apply it to
     everybody — which is wrong the moment the team spans templates. */
  var tw = teamAppointmentWords(rows);
  box.innerHTML = '';

  box.appendChild(h('div',{class:'team-head'},[ h('h3',{},['Your team']) ]));
  box.appendChild(teamActivityStrip(rows));

  /* The lead line is the one sentence a manager wants: how much booked work
     belongs to somebody who is not following anyone up. Phrased as the cost,
     not as a count of people, because people are not the problem - unworked
     appointments are. */
  /* Week on week, in plain numbers. A manager's real question after having a
     conversation is "did that change anything", and a snapshot cannot answer
     it. Stated as counts rather than a percentage: going from one message to
     three is not a 200% improvement, it is two more messages. */
  var dir = '';
  if(o.sent7d || o.sentPrev7d){
    var delta = o.sent7d - o.sentPrev7d;
    dir = delta === 0 ? ' Same as the week before.'
        : delta > 0 ? ' Up ' + delta + ' on the week before.'
        : ' Down ' + Math.abs(delta) + ' on the week before.';
  }

  /* Today's gap goes first, above everything else on the screen. A call this
     afternoon nobody has texted cannot wait until tomorrow, because tomorrow
     it is a no-show — and it is true even of people working their lists well,
     so it must not hide behind the "needs attention" split below. */
  if(o.todayUntouched){
    box.appendChild(h('div',{class:'team-urgent'},[
      h('strong',{},[String(o.todayUntouched)]),
      o.todayUntouched === 1
        ? ' call happening today that nobody has messaged.'
        : ' calls happening today that nobody has messaged.'
    ]));
  }

  /* What the team's results can and cannot tell you.

     Every performance figure divides by calls whose outcome was recorded, so
     this says up front how much of the history is actually known. On this
     book that ranges from 99% to zero, and printing a completion rate for
     somebody who has logged nothing would be a confident, specific, false
     claim about their work. */
  if(o.unlogged){
    /* Two different facts, and they were being welded into one sentence that
       contradicted itself. With five calls unlogged but everybody still
       measurable it read "so show-up rates are only measurable for 3 of 3" —
       "only" promising something withheld, "3 of 3" saying nothing was.

       The backlog is always worth stating. The consequence is only worth
       stating when there IS one. */
    var coverage = o.unlogged + ' finished ' +
      (o.unlogged === 1 ? 'call has' : 'calls have') + ' no outcome recorded';
    coverage += (o.showUpMeasurable < o.total)
      ? ', so show-up rates are measurable for only ' + o.showUpMeasurable +
        ' of ' + o.total + '.'
      : '. Every show-up rate below is still measurable.';
    box.appendChild(h('p',{class:'team-lead team-coverage'},[coverage]));
  }

  var lead;
  if(!o.needsAttention){
    lead = h('p',{class:'team-lead'},['All ' + o.working + ' working their lists. ' +
      o.sent7d + ' messages sent across the team this week.' + dir]);
  } else if(!o.strandedUpcoming){
    /* Somebody needs attention but is not sitting on any booked work — a new
       starter with no calendar, most often.

       Without this the sentence below leads with a bold red "0 booked
       appointments belong to...", which is both nonsense and alarming. Found
       by rendering a real-shaped team and reading it, not by a test: every
       assertion about this line was about the case where the number is
       non-zero. */
    lead = h('p',{class:'team-lead'},[
      o.working + ' of ' + o.total + ' working their lists, and nobody who has '
      + 'stopped is holding booked work. ' + o.sent7d + ' messages sent this week.' + dir]);
  } else {
    lead = h('p',{class:'team-lead', html:
      '<strong>' + o.strandedUpcoming + '</strong> booked ' +
      (o.strandedUpcoming === 1 ? tw.one : tw.many) +
      ' belong to someone who is not following anyone up. ' +
      o.working + ' of ' + o.total + ' are working their lists. ' +
      o.sent7d + ' messages sent this week.' + dir});
  }
  box.appendChild(lead);

  o.members.forEach(function(m){
    var nums = [
      h('div',{},[h('b',{},[String(m.upcoming)]), 'booked']),
      h('div',{},[
        h('b',{},[String(m.sent7d)]), 'sent 7d',
        m.trend === null || m.trend === 0 ? '' :
          h('span',{class:'team-trend ' + (m.trend > 0 ? 'up' : 'down'),
                    title:'versus the previous 7 days'},
            [(m.trend > 0 ? '\u2191' : '\u2193') + Math.abs(m.trend)])
      ]),
      h('div',{},[
        /* Did they turn up. The number a manager actually asks for, kept
           separate from "completed" because that divides by every logged
           call including reschedules; this divides only by calls that
           reached came-or-did-not. */
        m.showUpRate === null
          ? h('span',{class:'unknown',
                      title: m.unlogged
                        ? m.unlogged + ' finished calls have no outcome recorded'
                        : 'not enough decided calls yet'},['\u2014'])
          : h('b',{title: m.decidedCalls + ' calls reached a yes or no'},[m.showUpRate + '%']),
        m.showUpRate === null ? '' : 'showed up'
      ]),
      h('div',{},[
        m.completionRate === null
          ? h('span',{class:'unknown',
                      title: m.unlogged
                        ? m.unlogged + ' finished calls have no outcome recorded, so a rate here would be meaningless'
                        : 'not enough finished calls yet'},['not enough logged'])
          : h('b',{title: m.outcomeCoverage + '% of finished calls have an outcome recorded'},
              [m.completionRate + '%']),
        m.completionRate === null ? '' : 'completed'
      ]),
      h('div',{},[
        m.replyRate === null
          ? h('span',{class:'unknown', title:'Replies are only recorded for accounts where they are reconciled. This is not a zero.'},['not measured'])
          : h('b',{},[m.replyRate + '%']),
        m.replyRate === null ? '' : 'replies'
      ])
    ];
    var open = !!m.userId && TEAM_OPEN === m.userId;
    var row = h('div',{class:'team-row' + (m.needsAttention ? '' : ' is-ok') + (m.queue.length ? ' can-open' : '') + (open ? ' is-open' : ''),
                       'data-action': m.queue.length ? 'team-toggle' : '', 'data-uid': m.userId || ''},[
      h('div',{class:'team-who'},[
        h('span',{class:'team-name'},[
          m.queue.length ? (open ? '\u25be ' : '\u25b8 ') : '', m.name
        ]),
        h('span',{class:'team-why'},[m.why]),
        /* All the small facts on ONE wrapping line.

           .team-who is a flex column, so every one of these was becoming a
           full-width block on a line of its own — four stacked red sentences
           per person, each opening with a separator that separated nothing,
           and a row 135px tall. Caught by rendering eight people and looking,
           which no unit test here can do.

           They are findings, not alarms: a manager should be able to take
           them in sideways while reading down the names. */
        h('div',{class:'team-flags'},[
        m.daysSinceSignIn === null ? '' :
          h('span',{class:'team-seen' + (m.daysSinceSignIn >= 7 ? ' is-away' : '')},
            [lastSeenLabel(m.daysSinceSignIn)]),
        m.unlogged ? h('span',{class:'team-seen is-away',
                               title:'Finished calls with no outcome recorded'},
          [' \u00b7 ' + m.unlogged + ' unlogged']) : '',
        /* Sending well, beside sending a lot.

           Without this the row rewards volume and says nothing about quality,
           and on this book the highest-volume newcomer is also the one texting
           people at eleven at night.

           Shown as a count with the window spelled out, never a rate, and only
           once there are a few — one late text is a person working late, not a
           habit. The tooltip says the timezone is a guess from the area code,
           because a wrong guess looks exactly like a badly timed text and a
           manager should not open that conversation certain. */
        /* Why their reply rate is blank, next to the blank.

           Shown before the out-of-hours count because it is the one a manager
           can do something about this afternoon, and because an unexplained
           "not measured" reads as the product not working rather than as a
           question nobody has answered. */
        /* The other end of the queue. The row already says how much booked
           work has had nothing sent; this says how many calls were missed and
           then dropped. On this book one person has 45 of them. */
        m.noShowsUnchased >= 3 ? h('span',{class:'team-seen is-away',
          title: 'No-shows in the last ' + NOSHOW_CHASE_DAYS + ' days with no '
               + 'follow-up sent. Older ones are not counted \u2014 going back '
               + 'weeks later is not really a follow-up.'},
          [' \u00b7 ' + m.noShowsUnchased + ' no-shows not chased']) : '',
        m.awaitingReview >= 5 ? h('span',{class:'team-seen is-away',
          title:'Messages sent more than a day ago where nobody has said '
              + 'whether a reply came. The reply rate stays blank until these '
              + 'are answered \u2014 they are in Ghost Recall Today.'},
          [' \u00b7 ' + m.awaitingReview + ' replies unanswered']) : '',
        m.outsideHours >= 3 ? h('span',{class:'team-seen is-away',
          title:'Sent before 8am or after 9pm where the contact lives. Their '
              + 'timezone is guessed from the phone number, so some of these '
              + 'may be the guess being wrong rather than the timing.'},
          [' \u00b7 ' + m.outsideHours + ' out of hours']) : ''
        ])
      ]),
      h('span',{class:'team-state ' + (TEAM_STATE_CLASS[m.state] || 's-setup')},[m.state]),
      h('div',{class:'team-nums'}, nums),
      roleControl(m)
    ]);
    box.appendChild(row);

    /* The appointments behind the number. "11 booked and nothing sent" is a
       statistic; "Dana Reyes, Thursday, nobody has spoken to her" is something
       you can act on, so the untouched ones are marked and listed first. */
    if(open){
      var list = h('div',{class:'team-queue'},[]);
      list.appendChild(activityBars(m));
      list.appendChild(touchEffectPanel(m));
      list.appendChild(attendancePanel(m));
      if(m.untouched){
        list.appendChild(h('div',{class:'team-queue-head'},[
          m.untouched + ' of ' + m.queue.length + ' with nothing sent yet'
        ]));
      }
      /* Covering for somebody, rather than clicking every row.

         One picker per appointment is right for a single call with the wrong
         owner. It is the wrong tool for a fortnight's absence: three people
         here hold 43 booked appointments between them and have sent nothing
         in a week.

         Only offered where it is the actual problem — somebody who is not
         working their list. On a row that is ticking along, a bulk handover
         is far more likely to be a slip than an intention. */
      if(m.queue.length > 1 && m.needsAttention && o.members.length > 1){
        var bulkSel = h('select',{class:'tq-assign','data-bulk-to':m.userId},[]);
        o.members.forEach(function(x){
          if(!x.userId || x.userId === m.userId) return;
          bulkSel.appendChild(h('option',{value:x.userId},
            [x.userId === STATE.userId ? 'me' : x.name]));
        });
        if(bulkSel.childNodes.length){
          var withHistory = m.queue.filter(function(q){ return !q.untouched; }).length;
          list.appendChild(h('div',{class:'tq-bulk'},[
            h('span',{},['Cover all ' + m.queue.length + ':']),
            bulkSel,
            h('button',{class:'btn btn-sm','data-action':'bulk-assign',
              'data-uid':m.userId, 'data-who':m.name, 'data-n':String(m.queue.length),
              'data-hist':String(withHistory)},['Move them'])
          ]));
        }
      }
      m.queue.forEach(function(q){
        list.appendChild(h('div',{class:'tq-row' + (q.untouched ? ' tq-untouched' : '')
                                   + (q.today && q.untouched ? ' tq-today' : '')},[
          h('span',{class:'tq-when'},[fmtDayTime(q.when)]),
          h('span',{class:'tq-name'},[q.name]),
          h('span',{class:'tq-status'},[q.status]),
          h('span',{class:'tq-sent'},[q.untouched ? 'nothing sent' : q.sent + ' sent']),
          /* Who owns it, as a picker rather than a one-way Take.

             A one-way button could not hand a call back, or pass it to a
             third person — and handing over work somebody has already started
             is exactly the case a departure creates. So any upcoming
             appointment can move to anyone on the team, including back.

             A call with messages already sent is still movable, but it says
             so, because taking over mid-conversation should be a decision
             rather than a slip. */
          assignPicker(q, m, o.members)
        ]));
      });
      box.appendChild(list);
    }
  });

  /* People who have never used Ghost Recall, kept out of the ranking above.

     They are an onboarding problem, not a performance one, and ranked by
     booked work they would sit at the top every single day and bury the team
     actually being managed. Shown, with their counts, so nothing is hidden —
     just not treated as the same question. */
  if(o.notStarted.length){
    box.appendChild(h('div',{class:'team-notstarted-head'},[
      'Not using it yet \u2014 ' + o.notStarted.length + ' ' +
      (o.notStarted.length === 1 ? 'person' : 'people') +
      (o.notStartedUpcoming
        ? ', holding ' + o.notStartedUpcoming + ' booked ' +
          (o.notStartedUpcoming === 1 ? tw.one : tw.many)
        : '')
    ]));
    o.notStarted.forEach(function(m){
      box.appendChild(h('div',{class:'team-row is-dormant'},[
        h('div',{class:'team-who'},[
          h('span',{class:'team-name'},[m.name]),
          h('span',{class:'team-why'},[
            m.daysSinceSignIn === null ? 'Never signed in.'
              : m.daysSinceSignIn >= 7 ? 'Last opened the app ' + m.daysSinceSignIn + ' days ago.'
              : 'Signing in, but has never sent or logged anything.'
          ])
        ]),
        h('span',{class:'team-state s-setup'},['not started']),
        h('div',{class:'team-nums'},[
          h('div',{},[h('b',{},[String(m.upcoming)]), 'booked']),
          h('div',{},[h('b',{},[String(m.unlogged)]), 'unlogged'])
        ])
      ]));
    });
  }

  if(STATE.canInvite) box.appendChild(invitePanel());

  if(o.replyRateMeasuredFor < o.total){
    box.appendChild(h('div',{class:'team-note'},[
      'Reply rate is only shown for the ' + o.replyRateMeasuredFor + ' of ' + o.total +
      ' accounts where replies are actually reconciled. For everyone else it is ' +
      'unknown rather than zero — nobody has looked, which is not the same as nobody answering.' +
      /* And what it would take to fix it. The refusal above is right, but on
         its own it reads as a permanent limitation rather than as a backlog
         somebody can clear in a sitting. */
      (o.awaitingReview
        ? ' There ' + (o.awaitingReview === 1 ? 'is 1 message' : 'are ' + o.awaitingReview + ' messages')
          + ' across the team waiting on that question, in each person\u2019s own Ghost Recall Today.'
        : '')
    ]));
  }
}

/* Account health for the accounts you can actually see.

   It was called "All accounts" and said "N accounts healthy". It is fed
   state.platform, which is state.team, which is loadTeamRows — strictly your
   own organisation, because RLS gives the browser nothing else. At the time of
   writing Ghost Recall has thirteen accounts across seven organisations and
   this screen showed eight of them while claiming to be all of them: a
   confident, specific, wrong statement about the size of the product.

   The intent in the original note was right and is kept below: this is the
   support view, account-level facts only, and it must never grow a
   contact-shaped field — logic.js has a test asserting that. What it cannot
   be, until there is a deliberate product-owner role and a function to serve
   it, is cross-organisation. A real platform view means handing one person
   health data about other businesses, which is a privilege that should be
   granted on purpose rather than inherited from a label.

   Until then it says what it is. */
function renderOwnerTab(){
  var box = el('owner-view');
  var btn = el('tab-btn-owner');
  if(!box) return;

  var rows = STATE && STATE.platform;
  if(!rows || !rows.length){
    if(btn) btn.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  if(btn) btn.classList.remove('hidden');

  var o = platformOverview(rows, new Date());
  box.innerHTML = '';
  box.appendChild(h('div',{class:'team-head'},[ h('h3',{},['Account health']) ]));
  box.appendChild(h('p',{class:'team-lead', html:
    o.needHelp
      ? '<strong>' + o.needHelp + '</strong> of ' + o.total + ' need help. ' +
        o.neverUsed + ' have never sent a message.'
      : 'All ' + o.total + ' healthy.'}));
  // Said once, plainly, rather than implied by a title that overstates it.
  box.appendChild(h('p',{class:'team-note'},[
    'The accounts in ' + (STATE.orgName || 'your organisation') + '. Ghost Recall '
    + 'cannot show you another business\u2019s account from here.'
  ]));

  o.accounts.forEach(function(a){
    var meta = [];
    if(a.signedUpDays !== null) meta.push('signed up ' + a.signedUpDays + 'd ago');
    if(a.lastSignInDays !== null) meta.push('last in ' + a.lastSignInDays + 'd ago');
    box.appendChild(h('div',{class:'acct-row' + (a.healthy ? ' is-ok' : '')},[
      h('div',{},[
        h('div',{class:'acct-name'},[a.name]),
        h('div',{class:'acct-meta'},[meta.join(' \u00b7 ')])
      ]),
      h('div',{},[
        a.problem
          ? h('div',{class:'acct-problem'},[a.problem])
          : h('div',{class:'acct-ok'},['Working normally']),
        a.fix ? h('div',{class:'acct-fix'},[a.fix]) : ''
      ]),
      h('div',{class:'acct-nums'},[
        h('div',{},[h('b',{},[String(a.contacts)]), 'contacts']),
        h('div',{},[h('b',{},[String(a.upcoming)]), 'booked']),
        h('div',{},[h('b',{},[String(a.sentEver)]), 'sent'])
      ])
    ]));
  });

  box.appendChild(h('div',{class:'owner-note'},[
    'Account health only. This view never shows another business\u2019s contacts, ' +
    'messages or notes \u2014 opening someone\u2019s actual book to debug something ' +
    'should be a deliberate, consented step, not a screen that is always on.'
  ]));
}

/* Which appearance is chosen, shown on the control.

   Reads the attribute rather than storage, so it reflects what the page is
   actually doing -- including when storage was unavailable and the choice
   silently did not stick. */
/* The Appearance panel.

   Preview is immediate and Save is explicit, which is the shape the brief
   asks for and the right one: colour is judged by looking, not by reading
   hex. Cancel restores the saved theme, so experimenting costs nothing. */
/* The parts that must update WHILE somebody types, without touching the
   fields they are typing in.

   Re-rendering the whole panel on every keystroke would rewrite the hex
   input and send the caret to the end after each character. But a contrast
   warning that only appears once focus leaves is a warning shown after the
   damage -- the whole point is to see it as the colour changes. So the
   warning block and the preset highlight refresh; the inputs do not. */
function refreshThemeMeta(){
  var t = themeDraft();
  var box = el('ap-warnings');
  if(box){
    var warns = themeWarnings(t.colors);
    box.innerHTML = warns.length
      ? '<div class="ap-warn"><strong>\u26a0 Hard to read</strong>' +
        warns.map(function(w){
          return '<div class="ap-warn-row"><span>' + escapeHtml(w.pair.label) +
            ' \u2014 ' + w.ratio + ':1, needs ' + CONTRAST_MIN + '</span>' +
            '<button class="btn btn-sm" data-action="theme-fix" data-field="' +
            escapeHtml(w.fix) + '" data-hex="' + escapeHtml(w.suggested) +
            '">Make readable</button></div>';
        }).join('') + '</div>'
      : '';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.ap-preset'), function(b){
    b.classList.toggle('on', b.getAttribute('data-preset') === t.preset);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.ap-mode'), function(b){
    b.classList.toggle('on', b.getAttribute('data-mode') === t.mode);
  });
}

function renderAppearance(){
  var box = el('appearance-body'); if(!box) return;
  var t = themeDraft();
  var warns = themeWarnings(t.colors);

  function swatch(field, label){
    var v = t.colors[field];
    return '<label class="ap-row"><span class="ap-label">' + escapeHtml(label) + '</span>' +
      '<span class="ap-controls">' +
        '<input type="color" class="ap-wheel" data-action="theme-color" data-field="' +
          escapeHtml(field) + '" value="' + escapeHtml(v) + '" aria-label="' +
          escapeHtml(label) + ' colour picker">' +
        /* The hex field is not decoration. A colour wheel cannot be driven
           from a keyboard with any precision, and a brand colour arrives as
           a hex string -- somebody pasting #DC2F4A should not have to hunt
           for it by eye. The two stay in step. */
        '<input type="text" class="ap-hex" data-action="theme-hex" data-field="' +
          escapeHtml(field) + '" value="' + escapeHtml(v) + '" maxlength="7" ' +
          'spellcheck="false" aria-label="' + escapeHtml(label) + ' hex value">' +
      '</span></label>';
  }

  var presets = Object.keys(THEME_PRESETS).map(function(k){
    return '<button class="ap-preset' + (t.preset === k ? ' on' : '') +
      '" data-action="theme-preset" data-preset="' + k + '">' +
      '<span class="ap-chip" style="background:' + THEME_PRESETS[k].colors.accent + '"></span>' +
      escapeHtml(THEME_PRESETS[k].label) + '</button>';
  }).join('');

  var modes = ['light','dark','system'].map(function(m){
    return '<button class="ap-mode' + (t.mode === m ? ' on' : '') +
      '" data-action="theme-mode" data-mode="' + m + '">' +
      m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
  }).join('');

  box.innerHTML =
    '<div class="ap-sec"><h4>Mode</h4><div class="ap-modes">' + modes + '</div>' +
      '<div class="msgx-sub">System follows your device.</div></div>' +

    '<div class="ap-sec"><h4>Preset</h4><div class="ap-presets">' + presets +
      '<button class="ap-preset' + (t.preset === 'custom' ? ' on' : '') +
      '" data-action="theme-preset" data-preset="custom">Custom</button></div></div>' +

    '<div class="ap-sec"><h4>Colours</h4>' +
      swatch('accent', 'Accent') +
      swatch('bubble', 'Your messages') +
      swatch('sidebar', 'Navigation bar') +
      '<details class="ap-adv"><summary>Advanced colours</summary>' +
        swatch('bg', 'Page background') +
        swatch('card', 'Panels') +
        swatch('ink', 'Text') +
        swatch('ink-soft', 'Secondary text') +
        swatch('bubble-ink', 'Message text') +
        swatch('sidebar-ink', 'Navigation text') +
      '</details></div>' +

    '<div id="ap-warnings"></div>' +

    '<div class="ap-actions">' +
      '<button class="btn btn-sm btn-primary" data-action="theme-save">Save</button>' +
      '<button class="btn btn-sm" data-action="theme-cancel">Cancel</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="theme-reset">Reset to default</button>' +
    '</div>';

  refreshThemeMeta();
}

/* Paint a theme onto the page.

   Sets the derived tokens as inline custom properties on <html>, which beat
   the stylesheet's :root without editing it -- so the whole app re-themes,
   not just this workspace, and nothing has to know which screens exist.

   mode decides which base palette the untouched tokens fall back to:
   'system' removes the attribute so the media query takes over again. */
function applyTheme(theme){
  var t = sanitizeTheme(theme);
  var root = document.documentElement;

  if(t.mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t.mode);

  var tokens = themeTokens(t);
  Object.keys(tokens).forEach(function(k){
    if(tokens[k]) root.style.setProperty(k, tokens[k]);
  });
}

/* Back to whatever the stylesheet says, with nothing overridden. */
function clearThemeOverrides(){
  var root = document.documentElement;
  Object.keys(themeTokens({preset:'default'})).forEach(function(k){
    root.style.removeProperty(k);
  });
}

/* The working copy while Appearance is open.

   Edits preview immediately and are discarded by Cancel, so this is held
   apart from STATE.theme -- the saved one -- rather than written over it.
   Without the separation, Cancel has nothing to go back to. */
var THEME_DRAFT = null;

function themeDraft(){
  if(!THEME_DRAFT) THEME_DRAFT = sanitizeTheme(STATE && STATE.theme);
  return THEME_DRAFT;
}

function renderThemePick(){
  var box = el('theme-pick'); if(!box) return;
  var cur = document.documentElement.getAttribute('data-theme') || 'auto';
  Array.prototype.forEach.call(box.querySelectorAll('button'), function(b){
    b.classList.toggle('on', b.getAttribute('data-theme') === cur);
  });
}

/* Per-person UI preferences that survive a reload.

   localStorage rather than app_settings on purpose. These are per-DEVICE
   answers as much as per-person ones -- somebody may well want the day's
   cards open on a laptop and folded on a phone -- and a server round trip to
   remember whether a panel is folded is more machinery than the question
   deserves. Keyed by user so a shared browser does not hand one person's
   layout to the next. Wrapped because private browsing throws on both the
   read and the write. */
function uiPrefKey(name){
  return 'gr-ui:' + name + ':' + ((STATE && STATE.userId) || 'anon');
}
function readUiPref(name, dflt){
  try{
    var v = localStorage.getItem(uiPrefKey(name));
    return v === null ? dflt : v === '1';
  }catch(e){ return dflt; }
}
function writeUiPref(name, val){
  try{ localStorage.setItem(uiPrefKey(name), val ? '1' : '0'); }catch(e){}
}

/* Whether Today shows the day's cards or just the count.

   They were folded away yesterday so Today would stop carrying a second copy
   of the day's touches. For the people who actually work the list from this
   screen that turned out to be a click on every single page load -- UI is
   rebuilt from scratch each time and nothing remembered the answer, so the
   fold was not a preference, it was a daily tax. Open by default now, and
   the choice is kept: folding it is a personal way of working (you live in
   the workspace instead), not a decision to make on everybody's behalf. */
function textTodayOpen(){
  /* Key bumped to -v2 deliberately, which resets everyone to open ONCE.

     Before 22 October this fold reset on every page load, so hiding the
     cards never stuck. Making it stick was right, but it also meant a single
     click of "Hide the cards" -- or one made weeks ago, or by somebody
     sharing the machine -- silently hid the day's work for good. That is a
     bad way to find out, on a Monday with 62 texts due and somebody asking
     where their reminders went. The preference keeps working from here; this
     just clears the one state nobody chose on purpose. */
  if(UI.textTodayOpen === null) UI.textTodayOpen = readUiPref('text-today-open-v2', true);
  return UI.textTodayOpen;
}
function setTextTodayOpen(v){
  UI.textTodayOpen = !!v;
  writeUiPref('text-today-open-v2', UI.textTodayOpen);
}

/* Which tab is open, on the body, so the stylesheet can reach it.

   The global day-progress header and the alerts strip sit ABOVE every tab
   panel in the markup, so no selector rooted at the active panel can touch
   them -- they are preceding siblings. Reflecting the tab on an ancestor is
   what lets a phone drop that header on the one tab where it is in the way. */
function tabMoreOpen(){
  var menu = document.getElementById('tab-more-menu');
  return !!menu && !menu.hasAttribute('hidden');
}

function setTabMoreOpen(open){
  var menu = document.getElementById('tab-more-menu');
  var btn = document.getElementById('tab-more-summary');
  if(!menu || !btn) return;
  if(open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
  btn.setAttribute('aria-expanded', String(!!open));
  if(open){
    /* Anchored from the button's own rect, every time it opens.

       The menu is no longer a child of the strip -- it cannot be, because the
       strip is masked and a mask clips its descendants -- so it has nothing
       to position against in CSS. Measuring on open also means it follows the
       button when the strip is scrolled, which a static rule could not. */
    var r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom) + 'px';
    if(window.innerWidth <= 560){
      menu.style.left = '10px';
      menu.style.right = '10px';
    } else {
      /* Right edges aligned, so the menu never runs off the side whatever
         the button's position. Measured from the right so the width does not
         have to be known before it is shown. */
      menu.style.left = 'auto';
      menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    }
    /* Focus the first section in the menu, so a keyboard user lands inside
       what they just opened rather than at the top of the page. */
    var first = menu.querySelector('.tab-btn:not(.hidden)');
    if(first) first.focus();
  }
}

/* Clicking anywhere else closes it, and so does Escape. Bound once at the
   document, in the capture phase, so a handler that stops propagation
   somewhere in the page cannot leave the menu stuck open over the screen. */
(function(){
  if(typeof document === 'undefined') return;
  document.addEventListener('click', function(e){
    if(!tabMoreOpen()) return;
    var wrap = document.getElementById('tab-more');
    if(wrap && !wrap.contains(e.target)) setTabMoreOpen(false);
  }, true);
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && tabMoreOpen()){
      setTabMoreOpen(false);
      var btn = document.getElementById('tab-more-summary');
      if(btn) btn.focus();
    }
  }, true);
})();

function markActiveTab(){
  try{ document.body.setAttribute('data-tab', UI.tab || ''); }catch(e){}
  /* Which screen am I on, when the screen lives behind More.

     The tab strip marks .active on the button it switched to, and seven of
     those buttons are now inside a closed <details> where nobody can see the
     mark. Without this, opening Performance leaves every visible tab
     unlit -- which reads as "no tab is selected", not as "the selected one
     is in here".

     Also closes the menu after a pick. A disclosure that stays open over the
     screen it just navigated to is a thing to dismiss, and dismissing it is
     work the click already did. */
  try{
    var more = document.getElementById('tab-more');
    if(!more) return;
    /* Where the strip ends, for the phone menu that is pinned to the
       viewport rather than to the strip it scrolls with. Measured rather
       than guessed: the strip sits under a header whose height changes with
       the account's name and the wrap at narrow widths, so a constant here
       would be wrong on exactly the screens this is for. */
    var nav = more.parentNode;
    if(nav && nav.getBoundingClientRect){
      var b = Math.round(nav.getBoundingClientRect().bottom);
      if(b > 0) document.documentElement.style.setProperty('--tabs-bottom', b + 'px');
    }
    var inside = more.querySelector('.tab-more-menu .tab-btn[data-tab="' + (UI.tab || '') + '"]');
    var summary = document.getElementById('tab-more-summary');
    if(summary) summary.classList.toggle('active', !!inside);
    if(inside) setTabMoreOpen(false);
  }catch(e){ /* navigation chrome is never worth breaking a render for */ }
}

function renderAll(){
  if(!STATE) return;
  markActiveTab();
  applyTerminology();
  // Shown once, on an account that has nothing in it yet. Deliberately after
  // the first render so the wizard opens over a real app rather than a blank
  // page — seeing what it will look like is part of the pitch.
  if(!ONBOARDING && needsOnboarding()) setTimeout(startOnboarding, 0);
  renderCalendarHealth();
  renderHealthAlerts();
  renderThemePick();
  renderProgressBar();
  renderConfirmSends();
  renderStats();
  renderTodos();
  renderThreadsTab();
  renderRecentReplies();
  renderUnplacedReplies();
  renderOnDeck();
  renderUnlogged();
  renderCallsBoard();
  renderGhostToday();
  renderRecentSends();
  renderClientsTab();
  renderVariantsTab();
  renderEmailLibrary();
  renderVariantPerformance();
  renderWeeklyTab();
  renderCalendarTab();
  renderPendingInvites();
  renderTeamTab();
  renderOwnerTab();
  renderClosedTab();
  renderDeadTab();
  var eodCount = computeEndOfDayItems(STATE).length;
  var eodEl = el('eod-count'); if(eodEl) eodEl.textContent = '(' + eodCount + ')';
  // Last, so it sees the controls this render just produced.
  applyReadOnlyUI();
}


/* The calendar connection, stated before anyone has to wonder.

   Every other feature depends on bookings arriving. When they stop arriving
   the app looks fine and simply has less in it, which is indistinguishable
   from a quiet week — so three people in a row waited days before mentioning
   it, and one of them was diagnosed only after a full afternoon.

   Above the fold and not inside the collapsed alert summary, because a
   warning nobody expands is a warning nobody reads. */
function renderCalendarHealth(){
  var box = el('calendar-health');
  if(!box) return;
  var info = describeCalendarHealth(calendarHealth(STATE.calendarConnections, new Date()));
  if(!info){
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.classList.toggle('severe', info.severity === 'error');
  box.innerHTML = '';
  box.appendChild(h('span', {}, [info.text]));
  box.appendChild(h('span', {class: 'spacer'}, []));
  box.appendChild(h('button', {
    class: 'btn btn-sm',
    'data-action': info.action === 'Sync now' ? 'sync-calendar-now' : 'connect-calendar'
  }, [info.action]));
}

function renderHealthAlerts(){
  var box = el('health-alerts'); if(!box) return;
  box.innerHTML = '';
  var alerts = computeHealthAlerts(STATE);
  alerts.forEach(function(a){
    if(a.type === 'no-phone'){
      var div = h('div', {class:'alert alert-danger'}, [
        h('span', {}, [document.createTextNode('')]),
      ]);
      div.innerHTML = '<strong>' + a.clients.length + ' upcoming client(s)</strong> have no phone number — they can\'t be texted: ' + a.clients.map(function(c){ return escapeHtml(c.name); }).join(', ');
      box.appendChild(div);
    } else if(a.type === 'never-texted'){
      var div2 = document.createElement('div');
      div2.className = 'alert alert-danger';
      var shown = a.clients.slice(0, 8);
      var rest = a.clients.length - shown.length;
      div2.innerHTML = '<strong>' + a.clients.length + ' client(s) never got a single text</strong> — no welcome, no reminder, nothing, before their status locked the cadence out: ' +
        shown.map(function(c){ return escapeHtml(c.name) + ' (' + escapeHtml(c.status) + ')'; }).join(', ') +
        (rest > 0 ? ', +' + rest + ' more (see All clients tab)' : '');
      box.appendChild(div2);
    } else if(a.type === 'imminent-untexted'){
      var div3 = document.createElement('div');
      div3.className = 'alert alert-danger';
      var shown3 = a.clients.slice(0, 8);
      var rest3 = a.clients.length - shown3.length;
      div3.innerHTML = '<strong>' + a.clients.length + ' call(s) in the next 48 hours with no text sent yet</strong> — catch these before the call happens: ' +
        shown3.map(function(c){ return escapeHtml(c.name); }).join(', ') +
        (rest3 > 0 ? ', +' + rest3 + ' more' : '');
      box.appendChild(div3);
    } else if(a.type === 'duplicate'){
      a.groups.forEach(function(g){
        var div = document.createElement('div');
        div.className = 'alert';
        div.innerHTML = '<span><strong>Possible duplicate booking:</strong> ' + escapeHtml(g[0].name) + ' appears ' + g.length + ' times</span><span class="spacer"></span>';
        var btn = h('button', {class:'btn btn-sm', 'data-action':'hide-duplicate', 'data-cid': g[1].id}, ['Hide duplicate']);
        div.appendChild(btn);
        box.appendChild(div);
      });
    }
  });

  // The one-line summary is what people actually read. Naming the count, and
  // only colouring it when there is something to act on, keeps a healthy
  // account from looking like a warning.
  var wrap = el('health-alerts-wrap');
  var summary = el('alerts-summary-text');
  if(wrap && summary){
    var n = box.children.length;
    wrap.classList.toggle('has-issues', n > 0);
    /* Say WHICH issue, not how many.

       "1 data issue worth a look" is a number and a shrug: it gives no way to
       judge whether to open it, so after the second day it stops being read
       at all. Naming it means the decision can be made from the closed state,
       which for most of these is "that one is fine, leave it".

       Several issues still collapse to a count, because a list in a one-line
       summary is just the panel again. */
    summary.textContent = n ? describeAlerts(alerts, n) : 'Everything looks healthy';
    if(!n) wrap.removeAttribute('open');
  }
}

function describeAlerts(alerts, n){
  if(n > 1) return n + ' things worth a look';
  var a = alerts[0];
  if(!a) return '1 thing worth a look';
  var count;
  if(a.type === 'no-phone'){
    count = a.clients.length;
    return count + ' upcoming ' + (count === 1 ? termLower('contact') : termLower('contactPlural')) +
      ' with no phone number';
  }
  if(a.type === 'never-texted'){
    count = a.clients.length;
    return count + ' ' + (count === 1 ? termLower('contact') : termLower('contactPlural')) +
      ' closed out before a single text went';
  }
  if(a.type === 'imminent-untexted'){
    count = a.clients.length;
    return count + ' call' + (count === 1 ? '' : 's') + ' within 48 hours, nothing sent yet';
  }
  if(a.type === 'duplicate'){
    count = a.groups.length;
    return count + ' possible duplicate booking' + (count === 1 ? '' : 's');
  }
  return '1 thing worth a look';
}


/* "Did that one actually send?"

   The question only this person can answer, asked only where nothing else
   can answer it: external sends, past the grace window, that the Mac agent
   has plainly not found. An integrated send reports its own fate and is
   never listed here.

   Shown on Today because that is where somebody lands when they come back
   from Messages, which is the moment they still remember what happened. */
function renderConfirmSends(){
  var box = el('confirm-sends'); if(!box) return;
  var pending = awaitingConfirmation(STATE, new Date());
  if(!pending.length){ box.innerHTML = ''; return; }

  /* Capped, with the count told plainly. 793 of this account's messages are
     unconfirmed; rendering all of them would turn the dashboard into a
     backlog nobody will ever clear, and a wall of 793 rows is read as
     impossible rather than as work. */
  var show = pending.slice(0, 5);
  box.innerHTML =
    '<div class="confirm-head"><strong>' + pending.length +
      (pending.length === 1 ? ' send needs' : ' sends need') + ' confirming</strong>' +
      '<span class="msgx-sub"> \u00b7 a draft was opened and nothing came back</span></div>' +
    show.map(function(a){
      return '<div class="confirm-row">' +
        '<div class="confirm-who"><strong>' + escapeHtml(firstName(a.name)) + '</strong>' +
          '<span class="msgx-sub"> \u00b7 ' + escapeHtml(shortWhen(a.at)) + '</span></div>' +
        '<div class="confirm-text">' + escapeHtml(a.text.slice(0, 90)) + '</div>' +
        '<div class="confirm-actions">' +
          '<button class="btn btn-sm btn-primary" data-action="confirm-send" data-cid="' +
            escapeHtml(a.clientId) + '" data-mid="' + escapeHtml(a.messageId) + '">I sent it</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="unsend-message" data-cid="' +
            escapeHtml(a.clientId) + '" data-mid="' + escapeHtml(a.messageId) +
            '" title="Puts the touch back on the list as though it had never been opened.">Not sent</button>' +
        '</div></div>';
    }).join('') +
    (pending.length > show.length
      ? '<div class="msgx-sub confirm-more">' + (pending.length - show.length) +
        ' older ones are not listed. They stay unconfirmed, which is the truth about them.</div>'
      : '');
}

function renderProgressBar(){
  var now = new Date();
  var todayKey = tzDateKey(now, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  var clients = Object.keys(STATE.clients).map(function(k){ return STATE.clients[k]; }).filter(function(c){ return !c.ignored; });
  var due = getTextTodayList(STATE, now, '');
  var sentToday = 0;
  clients.forEach(function(c){ c.messageLog.forEach(function(m){ if(tzDateKey(new Date(m.sentAt), Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC') === todayKey) sentToday++; }); });
  /* Confirmed, not merely attempted.

     This counted every logged message as sent, which on the external route
     means it counted drafts being OPENED. 770 of 1,252 messages have no
     evidence behind them, so the old number was describing intent and
     calling it work.

     The gap is shown rather than hidden: a low count with "4 awaiting
     confirmation" beside it reads as something to finish, where a low count
     alone reads as a day wasted. */
  var prog = textingProgress(STATE, now, due.length);
  var total = prog.total;
  var pctDone = prog.pct;
  var label = el('progress-label');
  if(label){
    label.textContent = prog.confirmed + ' of ' + total + ' confirmed today' +
      (prog.awaiting ? ' \u00b7 ' + prog.awaiting + ' awaiting confirmation' : '') +
      (prog.failed ? ' \u00b7 ' + prog.failed + ' failed' : '');
  }
  var fill = el('progress-fill');
  if(fill){
    fill.style.width = pctDone + '%';
    fill.classList.toggle('full', total > 0 && prog.confirmed === total);
  }
  var pct = el('progress-pct'); if(pct) pct.textContent = total > 0 ? pctDone + '%' : '';
  var rc = el('remaining-count'); if(rc) rc.textContent = due.length;

  /* The four counts, which are also the way in.

     Built from conversationList, the same derivation the workspace renders,
     so a card and the list it opens can never disagree. Due now and due
     later are split by the TCPA window that send-sms actually enforces --
     a touch for somebody it is 6am for is not work anybody can do now, and
     counting it as though it were makes the number a lie by omission. */
  var statBox = el('pw-stats');
  if(statBox){
    /* From the one queue, and each number says what it counts.

       These four were "Due now", "Due later", "Waiting" and "Unread", built
       from two derivations while two more numbers on the same screen came
       from two others. Four answers to one question, 52 / 24 / 35 / 63.

       Now they come from actionQueue, and the units are named rather than
       left to be inferred: `To do` and `Later` are TASKS, `Replies` is a
       task group inside that total, and `Unread` is MESSAGES nobody has
       looked at -- which is not a task count and never was. The titles say
       so out loud, because a tooltip is where somebody goes when a number
       surprises them. */
    var crows = conversationList(STATE, now);
    var ccounts = conversationCounts(crows);
    var aq = actionQueue(STATE, now);
    var ac = actionQueueCounts(aq);
    var cards = [
      {cls: 'now', n: ac.tasks, k: 'To do', filter: 'action',
       t: ac.tasks + ' ' + (ac.tasks === 1 ? 'job' : 'jobs') + ' you can do right now, across ' +
          ac.clients + ' ' + (ac.clients === 1 ? 'person' : 'people') + '.'},
      {cls: 'later', n: ac.held, k: 'Later', filter: 'later',
       t: 'Real work that is not doable yet — mostly outside sending hours where they are. Each row says which.'},
      {cls: 'waiting', n: ac.byGroup.needs_response || 0, k: 'Replies', filter: 'replies',
       t: 'People who wrote to you and have had no answer. Counted inside To do, not on top of it.'},
      {cls: 'unread', n: ccounts.unread, k: 'Unread', filter: 'unread',
       t: 'Conversations with something you have not opened. A message count, not a task count.'}
    ];
    statBox.innerHTML = cards.map(function(c){
      return '<button class="pw-stat ' + c.cls + '" data-action="pw-stat" data-filter="' +
        c.filter + '" title="' + escapeHtml(c.t) + '"><span class="n">' +
        c.n + '</span><span class="k">' + escapeHtml(c.k) + '</span></button>';
    }).join('');
  }
}


function renderStats(){
  var box = el('stat-cards'); if(!box) return;
  var now = new Date();
  var s = computeStats(STATE, UI.statsRange, now);
  var prevNow = UI.statsRange==='today' ? new Date(now.getTime()-86400000) : (UI.statsRange==='week' ? new Date(now.getTime()-7*86400000) : null);
  var prev = prevNow ? computeStats(STATE, UI.statsRange, prevNow) : null;
  var cards = [
    // The caveat travels with the number. A show rate computed over 86 calls
    // while 24 sit unanswered looks like a fact about all 110, and silently
    // excluding them is correct maths presented misleadingly.
    ['Show-up rate', s.showUpRate, prev ? prev.showUpRate : null,
      {note: s.unloggedCalls ? s.unloggedCalls + ' unlogged' : null}],
    ['Close rate', s.closeRate, prev ? prev.closeRate : null, {}],
    /* The denominator travels with the rate, for the same reason the unlogged
       count travels with the show rate: a percentage with an invisible
       denominator is a claim nobody can check. "30% of 10 texts" and "30% of
       400" are different facts wearing the same number. */
    ['Text response rate', s.responseRate, prev ? prev.responseRate : null,
      {note: s.textsSent ? 'of ' + s.textsSent + ' texts' : 'no texts sent'}],
    ['Reschedule rate', s.rescheduleRate, prev ? prev.rescheduleRate : null, {lowerIsBetter:true}],
    ['Calls tracked', s.callsTracked, prev ? prev.callsTracked : null, {isCount:true, neutral:true}],
    /* Emails are a count, not a rate, and that is the honest shape.

       They used to be folded into the text response rate, where each one
       joined a denominator it could never join the numerator of -- an email
       opened in Gmail has nothing watching for its reply. On a book where 3
       of 10 texts were answered, one email each took the rate from 30% to
       15%, with nobody replying any less. A rate here would be a number that
       only ever falls. */
    ['Emails sent', s.emailsSent, prev ? prev.emailsSent : null,
      {isCount:true, neutral:true,
       note: s.emailReplies ? s.emailReplies + ' replied' : 'replies not tracked'}]
  ];
  box.innerHTML = '';
  cards.forEach(function(c){
    var label=c[0], val=c[1], prevVal=c[2], opts=c[3];
    var displayVal = opts.isCount ? String(val) : pct(val);
    var valueRow = document.createElement('div');
    valueRow.className = 'value';
    valueRow.appendChild(document.createTextNode(displayVal));
    var trend = trendHtml(val, prevVal, opts);
    if(trend) valueRow.insertAdjacentHTML('beforeend', trend);
    var card = h('div',{class:'stat-card'},[
      h('div',{class:'label'},[label]),
      valueRow
    ]);
    if(opts.note){
      card.appendChild(h('div',{class:'stat-note','data-action':'end-of-day',
        title:'Calls with no outcome recorded are left out of this rate — click to log them'},[opts.note]));
    }
    box.appendChild(card);
  });
}


function renderTodos(){
  var list = el('todo-list'); if(!list) return;
  list.innerHTML = '';
  STATE.todos.forEach(function(t){
    var li = document.createElement('li');
    if(t.done) li.className = 'done';
    var cb = h('input',{type:'checkbox','data-action':'toggle-todo','data-id':t.id});
    cb.checked = !!t.done;
    li.appendChild(cb);
    li.appendChild(h('span',{},[t.text]));
    li.appendChild(h('button',{class:'del','data-action':'delete-todo','data-id':t.id},['✕']));
    list.appendChild(li);
  });
}


function buildTouchCard(client, stage, now){
  var key = client.id + '|' + stage;
  var text = getCardText(STATE, client, stage);
  var original = getOriginalText(STATE, client, stage);
  var isEdited = text !== original;
  var tzInfo = tzChipInfo(client, now);

  var card = document.createElement('div');
  card.className = 'card' + (stage === 'noshow' ? ' card-noshow' : '');

  var top = document.createElement('div');
  top.className = 'card-top';
  var nameEl = h('span',{class:'name','data-action':'open-client','data-cid':client.id},[client.name]);
  /* No stage chip on the card.

     Every card now sits under a heading naming its stage, so the chip
     repeated that word on every row — and it printed the raw key, so it read
     "midcheckin" rather than "Mid-point check-in". Redundant and ugly is a
     bad combination directly under a heading that says it properly. The
     .stage-chip style stays for the review panel and focus mode, which have
     no grouping to lean on. */
  // Where this sits in the run-up to the call, so the card reads as a step in
  // a sequence rather than a standalone task.
  var prog = cadenceProgress(client, now);
  /* Arrows to move between this person's touches.

     The list only ever shows the one touch that is due, which is right nearly
     always and wrong exactly when the salesperson knows something the cadence
     does not — the introduction is redundant because they spoke yesterday, so
     what they actually want to send is the check-in. Until now the only way
     past a touch was to snooze it every morning or skip it for good.

     The arrows step through prog.pendingStages, so they can never land on a
     touch already sent for this appointment: re-sending the same message to
     the same person about the same call is the one mistake a follow-up tool
     must not make by accident.

     Moving forward does NOT skip the touch you moved past. It stays due
     tomorrow, which is what you want when you are reordering rather than
     refusing; 'Skip' below is still how you refuse one for good. */
  var pend = prog.pendingStages || [];
  var pos = pend.indexOf(stage);
  var progChip = h('span',{class:'touch-step',
    title:'Sent so far: ' + (prog.sentStages.join(', ') || 'nothing yet')},[]);
  var stepNo = prog.touches.indexOf(stage) + 1;
  if(pend.length > 1 && pos !== -1){
    var back = h('button',{class:'ts-arrow','data-action':'touch-prev','data-cid':client.id,
      'data-stage':stage, title: pos > 0 ? 'Send ' + touchLabel(pend[pos-1]) + ' instead' : ''},['\u2039']);
    if(pos === 0) back.disabled = true;
    var fwd = h('button',{class:'ts-arrow','data-action':'touch-next','data-cid':client.id,
      'data-stage':stage, title: pos < pend.length-1 ? 'Send ' + touchLabel(pend[pos+1]) + ' instead' : ''},['\u203a']);
    if(pos === pend.length - 1) fwd.disabled = true;
    progChip.appendChild(back);
    progChip.appendChild(h('span',{class:'ts-label'},
      ['Touch ' + (stepNo || '?') + ' of ' + prog.total]));
    progChip.appendChild(fwd);
  } else {
    progChip.className = 'touch-chip';
    progChip.appendChild(document.createTextNode('Touch ' + (stepNo || prog.done + 1) + ' of ' + prog.total));
  }
  var tzChip = h('span',{class:'tz-chip' + (tzInfo.warn?' tz-warn':'')},[tzInfo.timeLabel + ' their time']);
  top.appendChild(nameEl); top.appendChild(progChip); top.appendChild(tzChip);
  /* Why this person, why now -- on the card rather than behind it.

     The card showed a name, a progress chip and a timezone. Judging whether a
     message was the right thing to send meant opening the contact and reading
     the history, and on a list of fourteen that is fourteen detours.

     It is a restatement of the log, not a score or an inference: "No reply in
     4 days - mid-point check-in due, call in 4 days." Everything in it can be
     checked against the timeline below it. */
  card.appendChild(top);
  card.appendChild(h('div',{class:'why'},[explainDue(client, stage, now)]));
  /* Looking at a touch you arrowed to rather than the one that came up. Said
     plainly, because the 'why this person, why now' line above is written for
     the due touch and would otherwise read as though this were it. */
  if(UI.touchPick[client.id] === stage && prog.nextStage && prog.nextStage !== stage){
    card.appendChild(h('div',{class:'ts-moved'},[
      'You moved to this one. ' + touchLabel(prog.nextStage) +
      ' is still due and will be back tomorrow \u2014 use Skip to drop it for good.'
    ]));
  }

  if(tzInfo.warn){
    card.appendChild(h('div',{class:'tz-warn-text'},['⚠ It\'s outside normal hours for ' + client.name + ' right now.']));
  }

  var lastIdx = lastMessageIndex(client);
  if(lastIdx !== -1){
    // Was a "replied to last text" checkbox. The same question is now asked
    // once, in Ghost Recall Today, and only after the reply window has elapsed
    // — asking it here as well made one interaction look like two chores.
    // What remains is a read-only statement of where the interaction stands.
    var inter = lastInteraction(client, now);
    var quickReply = document.createElement('div');
    quickReply.className = 'quick-reply-toggle';
    quickReply.appendChild(document.createTextNode(interactionLabel(inter)));
    card.appendChild(quickReply);
  }

  var ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('data-action','edit-text');
  ta.setAttribute('data-cid', client.id);
  ta.setAttribute('data-stage', stage);
  card.appendChild(ta);

  if(isEdited){
    /* Say what a hand-edit does to the comparison.

       markSent already logs an edited send against 'custom' rather than
       crediting or debiting the template it started from — otherwise one
       person's rewrite would move the numbers for copy nobody sent. That was
       true before this note existed and the note is the point: an invisible
       safeguard is indistinguishable from no safeguard, and somebody who
       assumes their edit is being scored will draw conclusions from a league
       table it was deliberately kept out of. */
    var note = h('div',{class:'edited-note', title:
      'Edited texts are logged separately, so your wording does not add to or '
      + 'subtract from the template\u2019s reply rate.'},['edited \u2014 sent as a one-off, kept out of the template comparison']);
    var resetBtn = h('button',{'data-action':'reset-text','data-cid':client.id,'data-stage':stage},['reset']);
    note.appendChild(document.createTextNode(' \u00b7 '));
    note.appendChild(resetBtn);
    card.appendChild(note);
  }

  var actions = document.createElement('div');
  actions.className = 'card-actions';
  var digits = String(client.phone||'').replace(/\D/g,'');
  /* Three sending routes, chosen by smsSendMode rather than here.

     'mac' is the one that actually runs on this book: send-sms writes the
     text down and the Mac agent sends it out of the Messages app, from the
     number these contacts already recognise, and the reply comes back
     through the same agent. It needs that Mac awake, which is why it is a
     route and not the only route.

     'provider' sends from the team's own 10DLC number and the reply comes
     back to sms-webhook on its own. It cannot send until registration
     clears, which on this account it has not.

     'handoff' is the old sms: link to the salesperson's Messages app, whose
     reply lands on a handset nobody logs and whose send nobody can see. It
     is the fallback for when the Mac is asleep, and it is the one that
     produced 637 rows with no delivery state at all. */
  var route = smsSendMode(STATE, client);
  if(route.mode === 'provider'){
    /* Quiet hours are shown here and enforced in send-sms. Both, deliberately:
       the server is what makes it true, and this is what stops somebody
       clicking into a refusal they could have been told about first. */
    var win = smsSendWindow(client, new Date());
    if(!win.ok){
      actions.appendChild(h('span',{class:'edited-note',
        title:'Texting is allowed 8am to 9pm in their local time \u2014 the TCPA window, which carriers enforce themselves. This opens again in ' + win.hoursUntilOpen + ' hour' + (win.hoursUntilOpen === 1 ? '' : 's') + '.'},
        ['too late there \u2014 ' + win.reason]));
    } else {
      var sandbox = !!(STATE.smsNumber && STATE.smsNumber.sandbox);
      actions.appendChild(h('button',{
        class:'btn btn-sm ' + (sandbox ? 'btn-sandbox' : 'btn-primary'),
        'data-action':'send-text','data-cid':client.id,'data-stage':stage,
        title: sandbox
          ? 'Test number. The message is recorded exactly as a real one, but nothing is carried to a phone and ' + firstName(client.name) + ' will not receive it.'
          : 'Sends from ' + STATE.smsNumber.phoneNumber + '. Replies come back here automatically.'},
        [sandbox ? 'Send test text' : 'Send text']));
    }
  } else if(route.mode === 'mac'){
    /* Quiet hours shown here and enforced twice on the way out -- once in
       send-sms when this is queued, and again when the Mac claims it, because
       a Mac asleep overnight would otherwise wake up and deliver a batch
       queued at 8:50pm the following morning. */
    var macWin = smsSendWindow(client, new Date());
    if(!macWin.ok){
      actions.appendChild(h('span',{class:'edited-note',
        title:'Texting is allowed 8am to 9pm in their local time. Queued now, it would be held until that window opens — this opens again in ' + macWin.hoursUntilOpen + ' hour' + (macWin.hoursUntilOpen === 1 ? '' : 's') + '.'},
        ['too late there — ' + macWin.reason]));
    } else {
      actions.appendChild(h('button',{
        class:'btn btn-sm btn-primary',
        'data-action':'send-text','data-cid':client.id,'data-stage':stage,
        title:'Sends from Messages on your Mac, from your own number — so it arrives in the thread ' + firstName(client.name) + ' already has with you, and their reply comes back here.'},
        ['Send text']));
    }
    {
      /* And the handoff, on a phone.

         The Mac route is the right default at a desk and the wrong one in a
         pocket: that Mac may be asleep, at home, or simply not where you
         are, while the phone in your hand has Messages on it already.
         Offered as WELL rather than instead, because when the Mac is awake
         it remains the better route -- it confirms delivery and a handoff
         never can.

         Rendered OUTSIDE the sending window too, which is why it sits in its
         own block rather than in the else above. Quiet hours govern what this
         app SENDS; opening a draft sends nothing. Gating it meant that after
         9pm every card lost both controls and kept only a note, so there was
         no way to text anybody by hand from Today -- and this is the control
         that was explicitly asked to stay. The note above still says what
         time it is where they are, which should inform the decision rather
         than make it. */
      actions.appendChild(h('a',{class:'btn btn-sm handoff-btn',
        href: smsHrefFor(client, text),
        'data-action':'open-sms','data-cid':client.id,'data-stage':stage,
        title:'Opens Messages on this device instead. Logged as unconfirmed, because nothing here can see whether you pressed send.'},
        ['Open in Messages']));
    }
  } else if(route.mode === 'handoff'){
    var smsHref = digits ? ('sms:' + (digits.length===10?'+1'+digits:'+'+digits) + '&body=' + encodeURIComponent(text)) : '#';
    actions.appendChild(h('a',{class:'btn btn-sm btn-primary', href:smsHref,
      'data-action':'open-sms','data-cid':client.id,'data-stage':stage,
      title:'Opens your Messages app. ' + route.reason + ' \u2014 so their reply comes to your phone and has to be logged by hand.'},
      ['Open in Messages']));
  } else if(route.mode === 'blocked'){
    /* No send button at all, and no sms: link either. The STOP was said to
       the business, so texting from a personal handset is the same violation
       with no record of it. */
    actions.appendChild(h('span',{class:'edited-note',
      title:'Replying STOP opts a contact out for good. Texting them anyway breaks the TCPA and gets the team\u2019s number filtered by the carriers.'},
      ['opted out of texts']));
  } else {
    var dead = h('a',{class:'btn btn-sm btn-primary', href:'#',
      'data-action':'open-sms','data-cid':client.id,'data-stage':stage},['Open in Messages']);
    dead.setAttribute('aria-disabled','true');
    actions.appendChild(dead);
  }
  actions.appendChild(h('button',{class:'btn btn-sm','data-action':'copy-text','data-cid':client.id,'data-stage':stage},['Copy text']));
  /* Into the conversation, rather than only acting from here.

     The card shows what to send; the thread shows what was already said.
     Somebody about to send touch 3 to a contact who replied last week needs
     the second, and until now reaching it meant finding them by hand on
     another tab. */
  actions.appendChild(h('button',{class:'btn btn-sm','data-action':'open-thread','data-cid':client.id,
    title:'Opens this conversation, with the touch ready to send in it.'},['Open chat']));
  /* Gmail rather than the in-app composer. It needs no provider account, it
     sends from the salesperson's own mailbox so it lands in their Sent folder,
     and the reply arrives where they already look. Offered whenever there is a
     usable address — unlike the provider route it does not depend on
     email_enabled, which is why email is usable today. */
  /* The same row of email buttons that sits on the contact, on the card.

     Asked for directly: the morning list is where the work happens, and
     opening a contact to send an email is a detour from it.

     A pinned email keeps its place first and marked, because for a touch that
     has an obvious email that is the one being reached for; the rest follow
     so a different choice is still one click rather than a modal. */
  if(canEmail(client) && emailLibrary(STATE).length){
    var pinnedDoc = emailForTouch(STATE, stage);
    var ordered = emailLibrary(STATE);
    if(pinnedDoc){
      ordered = [pinnedDoc].concat(ordered.filter(function(d){ return d.id !== pinnedDoc.id; }));
    }
    /* The email for THIS touch, and the rest behind a disclosure.

       Every email in the library used to be a button on every card. With ten
       docs in the library that is ten links per card down a list of sixty --
       six hundred links to find the one already marked as the right one.
       Reported as "ten email-template links repeated on individual texting
       cards", and it reads exactly like that.

       Nothing is taken away: the pinned email keeps its place and its mark,
       and the others move from one click to one disclosure click. A <details>
       rather than a modal, so the choice never leaves the card and it costs
       no CSS state and no JS. The disclosure only appears when there is
       something behind it -- a library of one must not grow an empty twisty. */
    function emailLink(d, isPinned){
      var r = renderEmailDoc(STATE, d.id, client, STATE.senderName);
      if(!r) return null;
      return h('a',{class:'ce-btn' + (isPinned ? ' ce-pinned' : ''),
        target:'_blank', rel:'noopener',
        href: gmailComposeUrl(client.email, r.subject, r.text, businessEmailAccount(STATE)),
        'data-action':'sent-by-email','data-cid':client.id,'data-doc':d.id,
        title: d.whenToSend ? 'Send ' + d.whenToSend : (d.subject || d.title)},
        ['✉ ' + d.title]);
    }
    var row = h('div',{class:'ce-btns card-emails'},[]);
    var first = ordered.length ? emailLink(ordered[0], !!pinnedDoc) : null;
    if(first) row.appendChild(first);

    var rest = [];
    ordered.slice(1).forEach(function(d){
      var a = emailLink(d, false);
      if(a) rest.push(a);
    });
    if(rest.length){
      var more = h('details',{class:'card-emails-more'},[]);
      more.appendChild(h('summary',{},[rest.length === 1
        ? '1 other email' : rest.length + ' other emails']));
      var restRow = h('div',{class:'ce-btns'},[]);
      rest.forEach(function(a){ restRow.appendChild(a); });
      more.appendChild(restRow);
      row.appendChild(more);
    }
    if(row.childNodes.length) actions.appendChild(row);
  }
  actions.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'generate-ai','data-cid':client.id,'data-stage':stage,title:'Draft a custom text from this client\'s notes, in John\'s voice'},['✨ Generate with AI']));
  actions.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'snooze-touch','data-cid':client.id,'data-stage':stage,title:'Push this to tomorrow'},['Not today']));
  // "Not today" is for a badly timed text. This is for one that is not needed
  // at all — without it, the only way to refuse a touch was to snooze it every
  // morning forever.
  actions.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'skip-touch',
    'data-cid':client.id,'data-stage':stage,
    title:'Never send this one to ' + client.name},['Skip']));
  var sentLabel = document.createElement('label');
  sentLabel.className = 'sent-label';
  var cb = h('input',{type:'checkbox','data-action':'mark-sent','data-cid':client.id,'data-stage':stage});
  sentLabel.appendChild(cb);
  sentLabel.appendChild(document.createTextNode('check once sent'));
  actions.appendChild(sentLabel);
  card.appendChild(actions);

  // Deleting a contact lives in the client modal, not on the working surface.
  // A permanent, unconfirmed-looking action sitting on every card in the
  // morning list is both a real hazard and the kind of detail that makes
  // software feel unfinished.

  return card;
}


/* The cleared-queue badge: the ghost, giving a thumbs up.

   What was here before was a ghost inside a red circle with a diagonal line
   through it, ringed by radiating impact lines, under the word "Busted!".
   That is Sony's Ghostbusters symbol, drawn from scratch rather than copied
   but recognisable as exactly the thing the rename exists to get clear of -
   and it sat on the one screen people most want to screenshot and share.

   No circle, no slash, no burst. The hand is the one accent, so clearing your
   queue reads as the ghost approving rather than the ghost being destroyed.

   This face is warmer than the brandmark's on purpose. The mark in the header
   is calm and small - at 16px a smile is a smudge - but this one is 110px and
   only ever appears at the single good moment in the day's work, so it gets a
   rounder body, a smile and a slight happy lean. Still a dark silhouette
   rather than the red filled body with large oval eyes that made the old mark
   read as the Pac-Man ghost, and the red stays on the hand alone - rosy
   cheeks were tried and dropped, they tipped it into a cartoon.

   The eyes and smile are holes cut with evenodd, so they show the panel
   behind rather than being painted a colour that would be wrong if the panel
   ever changed. */
function allClearBadgeHtml(){
  return '<div class="allclear-badge">' +
      '<svg class="allclear-ghost" width="110" height="110" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g transform="rotate(-7 26 30)">' +
          '<path fill-rule="evenodd" fill="currentColor" d="M26 9c-10.2 0-17.5 7.4-17.5 17.8v18c0 2.4 2.8 3.5 4.4 1.9l3-3 3.1 3c1 1 2.6 1 3.6 0l3.1-3 3.1 3c1 1 2.6 1 3.6 0l3-3 2.9 2.9c1.6 1.6 4.2.4 4.2-1.9V26.8C43.5 16.4 36.2 9 26 9zM20.6 24.6a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM32.4 24.6a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM20.5 34.5Q26.5 41 32.5 34.5Q26.5 37.8 20.5 34.5Z"/>' +
        '</g>' +
        '<g transform="translate(39 22)">' +
          '<g class="allclear-thumb">' +
            '<path d="M1.6 11.4h4.6v11.1H1.6a1.9 1.9 0 0 1-1.9-1.9v-7.3a1.9 1.9 0 0 1 1.9-1.9z" fill="#dc2f4a"/>' +
            '<path d="M8.1 11.1 12.7 2.6a2.5 2.5 0 0 1 4.6 1.8l-1 5.1h4.4a2.4 2.4 0 0 1 2.3 3l-2.3 8.5a2.5 2.5 0 0 1-2.4 1.8H8.1z" fill="#dc2f4a"/>' +
          '</g>' +
        '</g>' +
      '</svg>' +
    '</div>';
}

function buildAllClearPanel(subtitle){
  /* An empty account is not an empty inbox.

     A brand new user -- no calendar, no contacts -- landed here and was told
     "Busted! Inbox zero, nothing due right now." That congratulated someone
     for finishing before they have started, and offers no way to begin. The
     one screen everybody sees first was the one screen that did not answer
     "how do I get my appointments in here?".

     The celebration is earned. It belongs to someone who had work and
     cleared it, and showing it to someone with nothing cheapens it for the
     people it is actually for. */
  var setup = describeSetup(STATE, new Date());
  if(!setup.contacts){
    var div0 = document.createElement('div');
    div0.className = 'allclear-panel start-panel';
    div0.innerHTML =
      '<div class="allclear-title">' + escapeHtml(setup.headline) + '</div>' +
      '<div class="allclear-sub">' + escapeHtml(setup.detail) + '</div>' +
      '<div class="start-acts">' +
        (setup.connected
          ? '<button class="btn btn-sm" data-action="sync-calendar-now">Sync calendar now</button>' +
            /* The text above already says to check which events count as
               bookings. Saying it and not offering the door is how somebody
               ends up here twice and leaves: of six accounts that reached
               this screen without help, five never came back the next day,
               and the one who had connected a calendar got nothing.

               "Syncing, but importing nothing" is a filter problem every
               time, and the filter is four clicks away through a menu nobody
               has opened yet. */
            '<button class="btn btn-sm" data-action="open-settings">' +
            'Check which events count</button>'
          : '<button class="btn btn-green" data-action="connect-calendar" data-priority="0" data-label="Work">Connect your calendar</button>') +
        '<button class="btn btn-sm" data-action="add-client">Add someone by hand</button>' +
      '</div>' +
      '<div class="start-note">' +
        (setup.connected
          ? 'Connected to ' + escapeHtml((STATE.myCalendars || []).join(', ')) + '. ' +
            escapeHtml(describeCalendarFilter(STATE.calendarFilter))
          : 'Or open Menu \u2192 Settings to see every way appointments can get in.') +
      '</div>';
    return div0;
  }

  var div = document.createElement('div');
  div.className = 'allclear-panel';
  div.innerHTML = allClearBadgeHtml() +
    '<div class="allclear-title">All clear</div>' +
    '<div class="allclear-sub">' + escapeHtml(subtitle || 'Inbox zero — nothing due right now.') + '</div>';
  return div;
}


// The live call, pinned above the board. Everything here is one tap: their
// number, a nudge text written in the moment, and the outcome buttons — the
// half hour either side of a call is where show-up rate is actually won, and
// it's the one stretch the board itself can't help with.
/* Texts that arrived and could not be put on anybody.

   The one failure this whole channel exists to prevent is a reply nobody
   sees. Matching is deliberately strict -- an unknown number, or two
   contacts sharing one that were texted in the same send, both refuse rather
   than guess -- so refusals are expected, and a refusal that stayed only in
   the database would be the old invisible-reply problem wearing a new name.

   Above On deck, because it is the only thing on this screen where somebody
   is already waiting for an answer. Renders nothing at all when the list is
   empty, which is the normal state. */
/* Who wrote back, on the screen where the work happens.

   The conversation view only shows a reply to somebody who opens that
   contact, and nobody opens contacts speculatively -- the review prompt that
   asked "did they reply?" was answered 0 times out of 67 sends. A reply that
   waits to be found is the invisible reply again.

   Above the unplaced panel and On deck, because somebody is waiting for an
   answer. Clicking one opens that contact, where the full thread is. */
/* The inbox: every text conversation in one place.

   Until this existed, reading a thread meant guessing which contact to open.
   Fine for somebody you remember, useless across 218 of them -- and the
   reason a reply sitting in an unopened thread was, in practice, unseen.

   Clicking a row opens that contact, where the thread and the reply box
   already live, rather than building a second place to read and answer. */
function renderThreadsTab(){
  markActiveTab();     // reached from several places, not only the tab strip
  var wrap = el('msgx'); if(!wrap) return;
  var rows = conversationList(STATE, new Date());
  var waiting = rows.filter(function(r){ return r.awaitingReply; }).length;

  /* The badge counts UNREAD, not waiting. A contact waiting on a reply you
     have already read and decided to answer later is not a notification; a
     message you have never seen is. */
  var unread = rows.reduce(function(n, r){ return n + r.unread; }, 0);
  var countEl = el('threads-count');
  if(countEl) countEl.textContent = unread ? '(' + unread + ')' : '';

  /* The selected conversation survives a re-render, and falls back to the
     top of the list rather than to nothing -- a workspace that empties itself
     every time a message arrives is a workspace nobody can work in. */
  /* Only a contact that no longer EXISTS is deselected.

     This used to drop anyone absent from the conversation list, which sounds
     equivalent and is not: the list holds contacts who have said or been
     sent something, and roughly 560 of 790 have neither yet. Opening one of
     those from Today set the selection and this immediately threw it away
     and auto-selected whoever was at the top -- so clicking "Open chat" on
     Teresa landed you in Sam's thread, silently, with Sam's history on
     screen. The list is a list of conversations; the thread pane can show
     any real contact, which is the whole point of arriving from Today. */
  if(UI.threadCid && !(STATE.clients && STATE.clients[UI.threadCid])){
    UI.threadCid = null;
  }
  if(!UI.threadCid && rows.length && window.innerWidth > 860){
    UI.threadCid = rows[0].clientId;
  }
  wrap.setAttribute('data-view', UI.threadCid ? 'thread' : 'list');

  /* Searching narrows what is LISTED and nothing else. The selection and
     the badge above were settled on the full set deliberately: typing in
     the search box must not close the conversation being read. */
  /* Chips and rows come from ONE array. Counting the chips from the client
     book instead would let a badge say 11 while the list shows 10, with no
     way to tell which one lied. */
  /* One derivation feeds the chips and the list, so a count and the rows
     under it cannot disagree. */
  var qnow = new Date();
  var queue = actionQueue(STATE, qnow);
  renderMsgxFilters(msgxFilterCounts(queue, rows, qnow));

  renderLeftColumn(queue, rows, waiting);
  renderMsgxThread();
  renderMsgxProfile();

  /* Read means somebody actually looked at it.

     This used to mark the auto-selected conversation read inside the
     selection itself, which fires on every renderAll -- so opening the app on
     the Today tab silently cleared the newest thread's unread flag without
     the Texts tab ever being on screen. The badge said 2 while the count was
     0, which is how it was caught.

     Marking only when this tab is the one in front means a conversation is
     read when it has been displayed to a person, and not before. */
  /* Marking read is an EXPLICIT act, not a side effect of rendering.

     This used to mark whatever was on screen, which was fine while the only
     way to get there was clicking a conversation. It is not fine now: the
     desktop layout auto-selects the top row, so clicking a filter chip
     selected somebody and cleared their unread flag -- and with an Unread
     count now sitting in the chips, browsing filters visibly decremented it.
     Somebody watching that number would see work disappear they never saw.

     msgx-open and open-thread mark read instead, because both are somebody
     choosing a conversation. An auto-selected one stays unread until it is
     actually picked, which is the honest reading of "have you seen this". */
  if(UI.tab === 'threads' && UI.threadCid && UI.msgxOpened === UI.threadCid){
    markConversationRead(UI.threadCid, UI.msgxChannel);
    var r2 = conversationList(STATE, new Date());
    var u2 = r2.reduce(function(n, r){ return n + r.unread; }, 0);
    var badge = el('threads-count');
    if(badge) badge.textContent = u2 ? '(' + u2 + ')' : '';
    // Redraw the row so its unread pill clears with the badge, rather than
    // the two disagreeing until the next render.
    var rnow = new Date();
    var q2 = actionQueue(STATE, rnow);
    renderMsgxFilters(msgxFilterCounts(q2, r2, rnow));
    renderLeftColumn(q2, r2, r2.filter(function(r){ return r.awaitingReply; }).length);
  }
}

/* Opening a conversation marks it read.

   Written straight to conversation_reads rather than through a save: it is
   this person's own view state, RLS scopes it to them, and routing it
   through saveState would push the whole account on every click.

   Local state moves first so the badge responds immediately -- a count that
   waits for a round trip reads as broken. If the write fails the marker is
   simply stale, which shows a reply again rather than hiding one. */
function markConversationRead(cid, channel){
  if(!cid || !STATE) return;
  /* ONE channel, never both. Text and email are separate conversations and
     clearing an unseen email because somebody opened the texts is the exact
     failure the split exists to prevent. */
  var ch = channel === 'email' ? 'email' : 'sms';
  var key = readKey(cid, ch);
  var at = new Date().toISOString();
  STATE.reads = STATE.reads || {};
  if(STATE.reads[key] && Date.parse(STATE.reads[key]) >= Date.parse(at)) return;
  STATE.reads[key] = at;
  if(!STATE.userId || !window.GB_SUPABASE) return;
  try{
    window.GB_SUPABASE.from('conversation_reads')
      .upsert({user_id: STATE.userId, client_id: cid, channel: ch, last_read_at: at},
              {onConflict: 'user_id,client_id,channel'})
      .then(function(){}, function(){});
  }catch(e){ /* a read marker is never worth breaking the page for */ }
}

/* The chips ARE Today's four cards, same keys and same numbers.

   Two of Today's cards used to navigate here with filters this strip had
   never heard of -- 'needs' and 'unread' -- which fell through to the
   unfiltered action list. So the number you pressed and the list you landed
   on disagreed, every time, for two of the four. They are one vocabulary
   now: whatever Today counts, this filters by.

   MSGX_FILTERS is the whole vocabulary, in one place, so a card cannot
   invent a fifth. */
var MSGX_FILTERS = ['action','replies','later','unread','upcoming','all'];
var MSGX_FILTER_LABELS = {
  action:   'To do',
  replies:  'Replies',
  later:    'Later',
  unread:   'Unread',
  upcoming: 'Calls',
  all:      'All'
};
var MSGX_FILTER_TITLES = {
  action:   'Everything you can act on now, worst first.',
  replies:  'People who wrote to you and have had no answer.',
  later:    'Real work that is not doable yet. Each row says why.',
  unread:   'Conversations with something you have never opened.',
  upcoming: 'What is coming, confirmed or not. Not a to-do list.',
  all:      'Every conversation, newest first.'
};

/* The chip counts, derived ONCE.

   This was built in two places -- the main render and the redraw that runs
   after a conversation is marked read -- and the comment above the second one
   already warned that two copies of a branch are two things to keep in step.
   They had drifted: the redraw passed `waiting` and the strip had stopped
   reading it, so marking a conversation read silently replaced the chips with
   a set whose Replies count was always zero. One function, both call sites. */
function msgxFilterCounts(queue, rows, now){
  var ac = actionQueueCounts(queue);
  return {
    action:   ac.tasks,
    replies:  ac.byGroup.needs_response || 0,
    later:    ac.held,
    unread:   rows.filter(function(r){ return (r.unread || 0) > 0; }).length,
    upcoming: upcomingCalls(STATE, now || new Date()).length,
    all:      rows.length
  };
}

function renderMsgxFilters(counts){
  var box = el('msgx-filters'); if(!box) return;
  var cur = UI.msgxFilter || 'action';
  box.innerHTML = MSGX_FILTERS.map(function(f){
    return '<button data-action="msgx-filter" data-filter="' + f + '"' +
      (f === cur ? ' class="on"' : '') +
      ' title="' + escapeHtml(MSGX_FILTER_TITLES[f] || '') + '">' +
      escapeHtml(MSGX_FILTER_LABELS[f]) +
      ' <span class="n">' + (counts[f] || 0) + '</span></button>';
  }).join('');
}

/* The queue, in the groups the brief names, each with its count.

   Headings rather than a flat list because the groups mean different
   things: an appointment about to be missed and a routine follow-up are
   not two sizes of the same job. Reading down a list of 18 with no
   structure, they look like they are.

   Rows carry the SPECIFIC reason -- "Call in 45 min, not confirmed" rather
   than "due" -- so the list can be worked without opening anything to find
   out why it is there. */
/* Which list the left column is showing, in ONE place.

   This routing existed twice -- once on the main render and once in the
   read-marking redraw below it -- and two copies of a branch are two things
   to keep in step. One of them already drifted far enough that a filter
   change redrew the old flat list.

   Called, never recursive: the redraw path needs the LIST rebuilt, not the
   whole tab, and calling renderThreadsTab from inside itself is a stack
   overflow with a nice comment on it. */
/* The rows the left column is actually showing.

   Next has to walk the list in front of somebody, not a canonical one they
   cannot see -- otherwise pressing it on the Calls filter jumps into the
   action queue for no stated reason. */
function currentQueueRows(){
  var f = UI.msgxFilter || 'action';
  var now = new Date();
  if(f === 'all')      return filterConversations(conversationList(STATE, now), UI.msgxQuery);
  if(f === 'upcoming') return filterConversations(upcomingCalls(STATE, now), UI.msgxQuery);
  if(f === 'unread'){
    return filterConversations(conversationList(STATE, now).filter(function(r){
      return (r.unread || 0) > 0; }), UI.msgxQuery);
  }
  var q = msgxQueueRows(f, actionQueue(STATE, now));
  return filterConversations(q, UI.msgxQuery);
}

/* Which slice of the one queue a filter means. Used by the list and by Next,
   so pressing Next walks the list in front of somebody rather than a
   canonical one they cannot see. */
function msgxQueueRows(f, queue){
  if(f === 'replies') return queue.filter(function(r){ return r.group === 'needs_response'; });
  if(f === 'later')   return queue.filter(function(r){ return !r.eligible; });
  return queue.filter(function(r){ return r.eligible; });      // 'action'
}

function renderLeftColumn(queue, rows, waiting){
  var f = UI.msgxFilter || 'action';
  if(f === 'action' || f === 'replies' || f === 'later'){
    renderPriorityQueue(filterConversations(msgxQueueRows(f, queue), UI.msgxQuery));
  } else if(f === 'upcoming'){
    renderPriorityQueue(filterConversations(upcomingCalls(STATE, new Date()), UI.msgxQuery));
  } else if(f === 'unread'){
    var un = rows.filter(function(r){ return (r.unread || 0) > 0; });
    renderMsgxList(filterConversations(un, UI.msgxQuery), waiting, un.length);
  } else {
    renderMsgxList(filterConversations(rows, UI.msgxQuery), waiting, rows.length);
  }
}

function renderPriorityQueue(rows){
  var box = el('msgx-list'); if(!box) return;
  if(!rows.length){
    box.innerHTML = '<div class="msgx-empty">Nothing needs you right now.</div>';
    return;
  }
  var html = '', lastGroup = null;
  rows.forEach(function(r){
    if(r.group !== lastGroup){
      var n = rows.filter(function(x){ return x.group === r.group; }).length;
      html += '<div class="pq-head"><span>' +
        escapeHtml(ACTION_GROUP_LABELS[r.group] || PRIORITY_LABELS[r.group] || r.group) +
        '</span><b>' + n + '</b></div>';
      lastGroup = r.group;
    }
    var tone = r.group === 'call_at_risk' ? 'urgent'
             : r.group === 'needs_response' ? 'urgent'
             : r.group === 'confirmation_due' ? 'due'
             : r.group === 'missed' ? 'stop' : '';
    html += '<button class="msgx-row pq-row' +
      (r.clientId === UI.threadCid ? ' active' : '') +
      '" data-action="msgx-open" data-cid="' + escapeHtml(r.clientId) + '">' +
      '<span class="r-av' + (tone ? ' ' + tone : '') + '">' +
        escapeHtml(initialsFor(r.name)) + '</span>' +
      '<span class="r-body">' +
        '<span class="r-top"><span class="r-name">' + escapeHtml(r.name) + '</span>' +
        (r.channel === 'email'
          ? '<span class="r-chan">email</span>' : '') +
        '</span>' +
        '<span class="pq-reason ' + tone + '">' + escapeHtml(r.reason) + '</span>' +
        /* A held row says why it is held, on the row.

           Without this a Later row is indistinguishable from a To do row
           that simply has not been worked -- which is how an hour goes into
           a list where nothing can actually be sent. */
        (r.holdReason ? '<span class="pq-hold">' + escapeHtml(r.holdReason) + '</span>' : '') +
        /* The one next action, named as a verb. Deciding what to do is the
           job this list exists to have already done. */
        (r.nextAction ? '<span class="pq-next">' + escapeHtml(r.nextAction.label) + '</span>' : '') +
        (r.alsoCount ? '<span class="pq-also">+' + r.alsoCount + ' more</span>' : '') +
      '</span></button>';
  });
  box.innerHTML = html;
}

function renderMsgxList(rows, waiting, total){
  var box = el('msgx-list'); if(!box) return;
  var q = (UI.msgxQuery || '').trim();
  if(total == null) total = rows.length;

  /* The count says which question it is answering. While searching it is
     "how much of the book am I looking at"; otherwise it is the one number
     worth acting on, which is how many people are waiting. */
  var count = el('msgx-count');
  if(count){
    count.textContent = q ? (rows.length + ' of ' + total)
                          : (waiting ? waiting + ' waiting' : total + ' total');
  }

  if(!rows.length){
    /* A search that matched nothing is NOT an empty inbox. Telling somebody
       with 229 conversations that they have none reads as data loss, and it
       is the kind of thing that sends a person looking for a backup. */
    box.innerHTML = '<div class="msgx-empty">' + (q
      ? 'No conversation matches \u201c' + escapeHtml(q) + '\u201d.'
      : (STATE.smsNumber
          ? 'No texts yet. Conversations appear here once you send from ' +
            escapeHtml(STATE.smsNumber.phoneNumber) + '.'
          : 'No conversations yet. Texts opened in Messages are sent from your own phone, ' +
            'so their replies arrive there and cannot be shown here.')) + '</div>';
    return;
  }

  box.innerHTML =
    '<div class="msgx-rows">' + rows.map(function(r){
      /* ONE signal, chosen by conversationSignal. This stacked up to five
         badges per row -- unread, waiting, due, status, opted out -- and a
         list where every row looks urgent is a list where none of them do.

         Unread stays separate because it is a count: folding it into the
         badge would lose how many. */
      var sig = conversationSignal(r);
      var queued = r.dueStage && !r.messages;
      return '<button class="msgx-row' + (r.unread ? ' unread' : '') +
        (r.clientId === UI.threadCid ? ' active' : '') +
        '" data-action="msgx-open" data-cid="' + escapeHtml(r.clientId) + '">' +
        '<span class="r-av' + (sig ? ' ' + sig.tone : '') + '">' +
          escapeHtml(initialsFor(r.name)) + '</span>' +
        '<span class="r-body">' +
          '<span class="r-top">' +
            '<span class="r-name">' + escapeHtml(r.name) + '</span>' +
            '<span class="r-when">' +
              escapeHtml(queued ? 'due today' : shortWhen(r.lastAt)) + '</span>' +
          '</span>' +
          '<span class="r-mid">' +
            '<span class="r-last' + (queued ? ' unsent' : '') + '">' +
              (r.lastDir === 'out' ? 'You: ' : '') + escapeHtml(r.lastText) + '</span>' +
            (r.unread ? '<span class="r-unread">' + r.unread + '</span>' : '') +
          '</span>' +
          (sig ? '<span class="r-sig ' + sig.tone + '">' + escapeHtml(sig.label) + '</span>' : '') +
        '</span>' +
        '</button>';
    }).join('') + '</div>';
}

/* The sequence touch, shown inside the conversation.

   This is what joins the two halves of the product. Today tells you a touch
   is due; the thread tells you what was already said. Keeping them on
   separate tabs meant the person sending the touch could not see the
   conversation it lands in, which is how "just checking in" goes out to
   somebody who asked a direct question yesterday.

   The send control mirrors the one on a Today card rather than reusing the
   composer, because the composer only exists on the provider route. On the
   Messages handoff -- which is the live route today -- there is no composer
   at all, so without this the panel would be a reminder you could not act
   on. One rule for whether a text may go out (smsSendMode), two places that
   ask it. */
/* Start from one of the sequence's own templates.

   Fills the box and nothing more. Sending from the composer logs a 'custom'
   message, so picking the day-of wording here does NOT advance the sequence
   to day-of -- the touch panel above is what does that, and only for the
   touch actually due. Two routes to the same words would otherwise mean two
   ways for the cadence to disagree with itself.

   Rendered for THIS contact, so the preview is the real message with their
   name and time in it rather than a template full of placeholders. */
/* What happened to one message, opened on demand.

   Says the state in plain words, when it happened, and -- where nothing can
   know -- offers the only two answers that exist. Confirming from inside the
   conversation matters: somebody reading a thread is already looking at the
   message, and sending them to a list on another tab to answer a question
   about it is how the question goes unanswered. */
function deliveryDetail(c, it, ds, ev){
  var mode = sendMode(it);
  var lines = [
    ['State', ds.label || 'nothing recorded'],
    ['Sent from', mode === 'integrated' ? 'a provider, which reports back'
                                        : 'your own app, which does not'],
    ['Logged', fmtDate(safeDate(it.at), c.timezone) + ' ' + fmtTime(safeDate(it.at), c.timezone)]
  ];
  if(it.providerId) lines.push(['Provider reference', it.providerId]);

  var ask = '';
  if(ev === 'awaiting' && mode === 'external'){
    ask = '<div class="dlv-ask"><span class="msgx-sub">Only you can know this one.</span>' +
      '<button class="btn btn-sm btn-primary" data-action="confirm-send" data-cid="' +
        escapeHtml(c.id) + '" data-mid="' + escapeHtml(it.id || '') + '">I sent it</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="unsend-message" data-cid="' +
        escapeHtml(c.id) + '" data-mid="' + escapeHtml(it.id || '') +
        '" title="Puts the touch back on the list as though the draft had never been opened.">Not sent</button>' +
      '</div>';
  }
  return '<div class="dlv-detail">' +
    lines.map(function(l){
      return '<div class="dlv-line"><span>' + escapeHtml(l[0]) + '</span><b>' +
        escapeHtml(String(l[1])) + '</b></div>';
    }).join('') + ask + '</div>';
}

/* Half-typed words, kept across every switch.

   Keyed by contact AND channel, because they are different conversations:
   a reply started to one person must not reappear addressed to the next,
   and a text draft must not surface in an email box.

   Held in memory only. A draft is not a message and does not belong in the
   message history; losing it on a reload is survivable, losing it on a tab
   click would not be. */
function draftKey(cid, chan){
  return String(cid || '') + '|' + (chan || 'sms');
}

function stashDraft(){
  if(!UI.threadCid) return;
  var k = draftKey(UI.threadCid, UI.msgxChannel);
  var d = {};
  var t = el('msgx-text');  if(t) d.text = t.value;
  var b = el('msgx-email'); if(b) d.body = b.value;
  var j = el('msgx-subj');  if(j) d.subject = j.value;
  var n = el('msgx-note');  if(n) d.note = n.value;
  var anything = Object.keys(d).some(function(x){ return (d[x] || '').trim(); });
  if(anything) UI.drafts[k] = d; else delete UI.drafts[k];
}

function restoreDraft(){
  if(!UI.threadCid) return;
  var d = UI.drafts[draftKey(UI.threadCid, UI.msgxChannel)];
  if(!d) return;
  /* Applied AFTER the touch pre-fill, so what somebody typed wins over what
     the sequence suggested. A draft is the more recent intent. */
  var t = el('msgx-text');  if(t && d.text !== undefined) t.value = d.text;
  var b = el('msgx-email'); if(b && d.body !== undefined) b.value = d.body;
  var j = el('msgx-subj');  if(j && d.subject !== undefined) j.value = d.subject;
  var n = el('msgx-note');  if(n && d.note !== undefined) n.value = d.note;
}

function clearDraft(cid, chan){
  delete UI.drafts[draftKey(cid === undefined ? UI.threadCid : cid,
                            chan === undefined ? UI.msgxChannel : chan)];
}

function msgxTemplateSelect(c){
  var opts = cadenceTouches().map(function(stage, i){
    return '<option value="' + escapeHtml(stage) + '">Touch ' + (i + 1) + ' \u00b7 ' +
      escapeHtml(touchLabel(stage)) + '</option>';
  }).join('');
  return '<select class="msgx-tpl" data-action="msgx-template" data-cid="' + escapeHtml(c.id) + '">' +
    '<option value="">Start from a template\u2026</option>' + opts + '</select>';
}

/* The email library, as a picker.

   Same contract as the text template picker: it fills the subject and body
   and nothing else. Sending still goes through the Gmail handoff and is
   logged 'custom', so choosing the post-call recap does not advance any
   cadence.

   whenToSend rides along as the option's tooltip. The library is written
   with lines like "once their payment clears", and that is the part that
   tells somebody which of eleven to pick -- a list of titles alone makes
   them open three to find out.

   Returns '' when the library is empty, so an account that has never written
   one gets no dropdown rather than an empty one. */
function msgxEmailTemplateSelect(c){
  var docs = emailLibrary(STATE);
  if(!docs.length) return '';
  var opts = docs.map(function(d){
    return '<option value="' + escapeHtml(d.id) + '"' +
      (d.whenToSend ? ' title="' + escapeHtml(d.whenToSend) + '"' : '') + '>' +
      escapeHtml(d.title) + '</option>';
  }).join('');
  return '<select class="msgx-tpl" data-action="msgx-email-template" data-cid="' +
    escapeHtml(c.id) + '">' +
    '<option value="">Start from a template\u2026</option>' + opts + '</select>';
}

function msgxTouchPanel(c, now){
  var touch = threadTouch(STATE, c, now);
  if(!touch) return '';
  var route = smsSendMode(STATE, c);
  var win = smsSendWindow(c, now);

  var action = '';
  if(route.mode === 'provider' && win.ok){
    action = '<button class="btn btn-sm ' +
      ((STATE.smsNumber && STATE.smsNumber.sandbox) ? 'btn-sandbox' : 'btn-primary') +
      '" data-action="send-text" data-cid="' + escapeHtml(c.id) +
      '" data-stage="' + escapeHtml(touch.stage) + '">' +
      ((STATE.smsNumber && STATE.smsNumber.sandbox) ? 'Send test text' : 'Send this touch') +
      '</button>';
  } else if(route.mode === 'provider' && !win.ok){
    action = '<span class="msgx-sub">too late there \u2014 ' + escapeHtml(win.reason) + '</span>';
  } else if(route.mode === 'mac' && win.ok){
    action = '<button class="btn btn-sm btn-primary" data-action="send-text" data-cid="' +
      escapeHtml(c.id) + '" data-stage="' + escapeHtml(touch.stage) +
      '" title="Sends from Messages on your Mac, from your own number. Their reply comes back here.">' +
      'Send this touch</button>' +
      '<a class="btn btn-sm handoff-btn" href="' + escapeHtml(smsHrefFor(c, touch.text)) +
      '" data-action="open-sms" data-cid="' + escapeHtml(c.id) +
      '" data-stage="' + escapeHtml(touch.stage) +
      '" title="Opens Messages on this device instead. Logged as unconfirmed.">Open in Messages</a>';
  } else if(route.mode === 'mac' && !win.ok){
    action = '<span class="msgx-sub">too late there \u2014 ' + escapeHtml(win.reason) + '</span>';
  } else if(route.mode === 'handoff'){
    var digits = String(c.phone || '').replace(/\D/g, '');
    var href = digits
      ? ('sms:' + (digits.length === 10 ? '+1' + digits : '+' + digits) +
         '&body=' + encodeURIComponent(touch.text))
      : '#';
    action = '<a class="btn btn-sm btn-primary" href="' + escapeHtml(href) +
      '" data-action="open-sms" data-cid="' + escapeHtml(c.id) +
      '" data-stage="' + escapeHtml(touch.stage) +
      '" title="Opens your Messages app. ' + escapeHtml(route.reason) +
      ' \u2014 so their reply comes to your phone and has to be logged by hand.">' +
      'Open in Messages</a>';
  } else if(route.mode === 'blocked'){
    action = '<span class="msgx-sub">opted out of texts</span>';
  } else {
    action = '<span class="msgx-sub">' + escapeHtml(route.reason || 'cannot text this contact') + '</span>';
  }

  var cid = escapeHtml(c.id), st = escapeHtml(touch.stage);

  /* "Mark sent" belongs only where the send CANNOT be observed. On the
     provider route the Send button above already logs it, so offering this
     as well is how one touch gets recorded twice and the sequence skips a
     step. The handoff is the honest case: the draft opened somewhere this
     app cannot see, and only a person knows whether it went.

     The Mac route is observed too, and more precisely than the provider one
     -- the agent reads Apple's own is_delivered back out of the Messages
     database. So it belongs on the same side of this line as the provider,
     and leaving it off that side is what stops a single touch being logged
     twice: once by the send and once by a hand that did not need to. */
  var markSentBtn = (route.mode === 'provider' || route.mode === 'mac')
    ? ''
    : '<button class="btn btn-sm btn-ghost" data-action="msgx-mark-sent" data-cid="' + cid +
      '" data-stage="' + st + '" title="Records this touch as sent and advances the sequence. ' +
      'Only you can know whether it actually went.">Mark sent</button>';

  return '<div class="msgx-touch' + (touch.replyFirst ? ' owed' : '') + '">' +
    '<div class="msgx-touch-head"><strong>' + escapeHtml(touch.label) + '</strong>' +
      '<span class="msgx-sub"> \u00b7 due today</span></div>' +
    (touch.replyFirst
      ? '<div class="msgx-touch-warn">' + escapeHtml(firstName(c.name)) +
        ' spoke last \u2014 answer them before sending this.</div>'
      : '') +
    '<div class="msgx-touch-text">' + escapeHtml(touch.text) + '</div>' +
    '<div class="row">' + action +
      '<button class="btn btn-sm btn-ghost" data-action="open-client" data-cid="' + cid +
      '" title="Opens the contact, where this touch can be reworded for ' +
      escapeHtml(firstName(c.name)) + ' only.">Reword</button>' +
    '</div>' +
    /* The rest of the Today card's verbs, so the whole touch can be dealt
       with here: sent, badly timed, or not wanted at all. Without "Skip" the
       only way to refuse a touch was to snooze it every morning forever. */
    '<div class="row msgx-touch-more">' + markSentBtn +
      '<button class="btn btn-sm btn-ghost" data-action="snooze-touch" data-cid="' + cid +
        '" data-stage="' + st + '" title="Push this to tomorrow">Not today</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="skip-touch" data-cid="' + cid +
        '" data-stage="' + st + '" title="Never send this one to ' + escapeHtml(c.name) +
        '">Skip</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="generate-ai" data-cid="' + cid +
        '" data-stage="' + st + '" title="Draft a custom text from this contact\u2019s notes, ' +
        'in your voice. Nothing is sent.">\u2728 Generate</button>' +
    '</div></div>';
}

function renderMsgxThread(){
  var box = el('msgx-thread'); if(!box) return;
  var c = UI.threadCid && STATE.clients[UI.threadCid];
  if(!c){
    box.innerHTML = '<div class="msgx-empty">Pick a conversation to read it.</div>';
    return;
  }
  var route = smsSendMode(STATE, c);
  var win = smsSendWindow(c, new Date());

  /* Only the channel on screen. Notes are their own view: internal, never
     sent, and kept out of both histories so one can never be read as
     something the client received. */
  var viewChan = UI.msgxChannel || 'sms';
  var thread = viewChan === 'notes'
    ? conversationThread(c).filter(function(it){ return it.dir === 'note'; })
    : channelThread(c, viewChan);

  var bubbles = thread.map(function(it){
    /* A note must be unmistakable. Full width, its own colour, and the words
       "Internal note" on it -- not a bubble that merely sits on a different
       side, because sides are what distinguishes the two PEOPLE in a
       conversation and a note is neither of them. */
    if(it.dir === 'note'){
      return '<div class="msgx-note">' +
        '<div class="msgx-note-head">Internal note' +
        (it.author ? ' \u00b7 ' + escapeHtml(it.author) : '') +
        ' \u00b7 ' + escapeHtml(shortWhen(it.at)) +
        ' \u00b7 not sent to ' + escapeHtml(firstName(c.name)) + '</div>' +
        escapeHtml(it.text) + '</div>';
    }
    var ds = deliveryState(it);
    /* The channel is on the bubble, not inferred from how it looks. A thread
       now carries both, and an email that reads as a text is how somebody
       answers in a medium the contact never used. */
    var isEmail = it.dir === 'out' && it.channel === 'email';
    /* The delivery line is a control, not a caption.

       Subtle by default -- the spec is right that a permanent legend of
       every possible state across the page is noise -- and it opens on
       demand to say what the state means and when it happened. The
       explanation belongs next to the message it is about, not in a key
       somebody has to hold in their head. */
    var ev = it.dir === 'out' ? sendEvidence(it) : null;
    var open = UI.dlvOpen === it.id;
    return '<div class="msgx-b ' + (it.dir === 'in' ? 'in' : 'out') +
      (isEmail ? ' email' : '') + (ev === 'failed' ? ' failed' : '') + '">' +
      (isEmail ? '<div class="msgx-chan">Email</div>' : '') +
      escapeHtml(it.text) +
      '<div class="msgx-meta">' + escapeHtml(shortWhen(it.at)) +
        (it.dir === 'out' && ds.label
          ? ' \u00b7 <button class="dlv ' + ev + '" data-action="dlv-detail" data-mid="' +
            escapeHtml(it.id || '') + '" title="What happened to this message">' +
            escapeHtml(ds.label) + '</button>'
          : '') +
      '</div>' +
      (open ? deliveryDetail(c, it, ds, ev) : '') +
      '</div>';
  }).join('') || '<div class="msgx-empty">Nothing yet.</div>';

  /* The composer states the same truth the contact screen does, rather than
     re-deriving it: one rule for whether a text may go out, used everywhere. */
  var composer;
  if(route.mode === 'blocked'){
    composer = '<div class="msgx-sub">' + escapeHtml(firstName(c.name)) +
      ' replied STOP, so they cannot be texted.</div>';
  } else if(route.mode === 'handoff'){
    /* A real composer on the handoff route too.

       It used to say "use Open in Messages from Today", which sent somebody
       out of the conversation to send a message about it -- and even then
       only let them send the scheduled touch, never a sentence of their own.
       The draft opens in Messages exactly as the Today link does, and is
       logged with the same honesty: unverified, because nothing here can see
       whether Send was pressed. */
    composer = msgxTemplateSelect(c) +
      '<textarea id="msgx-text" rows="2" placeholder="Message to ' +
        escapeHtml(firstName(c.name)) + '\u2026"></textarea>' +
      '<div class="row">' +
        '<button class="btn btn-sm btn-primary" data-action="msgx-handoff-send" data-cid="' +
          escapeHtml(c.id) + '">Open in Messages</button>' +
        '<span class="msgx-sub">Opens your Messages app. Logged as unconfirmed \u2014 ' +
          'their reply arrives on your phone.</span>' +
      '</div>';
  } else if(route.mode === 'mac' && win.ok){
    composer = msgxTemplateSelect(c) +
      '<textarea id="msgx-text" rows="2" placeholder="Write back to ' +
      escapeHtml(firstName(c.name)) + '\u2026"></textarea>' +
      '<div class="row"><button class="btn btn-sm btn-primary" data-action="msgx-send" data-cid="' +
      escapeHtml(c.id) + '">Send</button>' +
      (canDraftReply(c)
        ? '<button class="btn btn-sm btn-ghost" data-action="msgx-draft" data-cid="' +
          escapeHtml(c.id) + '" title="Writes a suggested reply into the box for you to edit. ' +
          'Nothing is sent.">\u2728 Draft a reply</button>'
        : '') +
      '<button class="btn btn-sm btn-ghost" data-action="msgx-schedule" data-cid="' +
        escapeHtml(c.id) + '" title="Queue this for later. Every rule is checked again at send ' +
        'time, so it will not go out if they reply, opt out, or follow-ups are paused.">' +
        'Schedule\u2026</button>' +
      '<button class="btn btn-sm handoff-btn" data-action="msgx-handoff-send" data-cid="' +
        escapeHtml(c.id) + '" title="Opens Messages on this device with what you have typed. ' +
        'Logged as unconfirmed.">Open in Messages</button>' +
      '<span class="msgx-sub">from Messages on your Mac</span></div>';
  } else if(route.mode === 'mac' && !win.ok){
    composer = '<div class="msgx-sub">Too late to text them \u2014 ' + escapeHtml(win.reason) +
      '. Texting runs 8am\u20139pm their time.</div>';
  } else if(route.mode !== 'provider'){
    /* Reached by 'none' and by a handoff that fell through above. route.reason
       carries why -- no usable number, or a Mac that stopped answering. */
    composer = '<div class="msgx-sub">' +
      escapeHtml(route.reason || 'This contact cannot be texted.') + '</div>';
  } else if(!win.ok){
    composer = '<div class="msgx-sub">Too late to text them \u2014 ' + escapeHtml(win.reason) +
      '. Texting runs 8am\u20139pm their time.</div>';
  } else {
    /* The draft button only appears when they spoke last.

       Offering to draft a reply to a conversation you already answered is
       noise, and the draft itself always lands in this box for editing --
       there is no path from a suggestion to a sent message that does not go
       through a person reading it and pressing Send. */
    composer = msgxTemplateSelect(c) +
      '<textarea id="msgx-text" rows="2" placeholder="Write back to ' +
      escapeHtml(firstName(c.name)) + '\u2026"></textarea>' +
      '<div class="row"><button class="btn btn-sm btn-primary" data-action="msgx-send" data-cid="' +
      escapeHtml(c.id) + '">Send</button>' +
      (canDraftReply(c)
        ? '<button class="btn btn-sm btn-ghost" data-action="msgx-draft" data-cid="' +
          escapeHtml(c.id) + '" title="Writes a suggested reply into the box for you to edit. ' +
          'Nothing is sent.">\u2728 Draft a reply</button>'
        : '') +
      '<button class="btn btn-sm btn-ghost" data-action="msgx-schedule" data-cid="' +
        escapeHtml(c.id) + '" title="Queue this for later. Every rule is checked again at send ' +
        'time, so it will not go out if they reply, opt out, or follow-ups are paused.">' +
        'Schedule\u2026</button>' +
      '<span class="msgx-sub">from ' + escapeHtml(STATE.smsNumber.phoneNumber) + '</span></div>';
  }

  /* The note composer is always available, even when texting is not.

     A contact who opted out, or whose number is not textable, is exactly the
     one somebody needs to leave context on. Tying notes to the ability to
     send would remove them precisely when they matter most. */
  /* The channel IS the tab. Reply-vs-Email used to be a mode on the
     composer while both histories shared one scroll, which made the choice
     about what you were writing rather than which conversation you were in.
     They are different conversations with the same person. */
  var chan = UI.msgxChannel || 'sms';
  var noteMode = chan === 'notes';
  var emailMode = chan === 'email';
  /* Email is offered only where there is an address to use. A tab that opens
     a composer addressed to nobody is a tab that wastes the click. */
  var emailable = !!(c.email && canEmail(c));
  var unreadSms = channelUnread(c, (STATE.reads || {})[readKey(c.id, 'sms')], 'sms');
  var unreadEmail = channelUnread(c, (STATE.reads || {})[readKey(c.id, 'email')], 'email');
  function chanTab(key, label, count, extra){
    return '<button class="msgx-mode' + (chan === key ? ' on' : '') + (extra || '') +
      '" data-action="msgx-channel" data-channel="' + key + '">' + escapeHtml(label) +
      (count ? '<span class="chan-n">' + count + '</span>' : '') + '</button>';
  }
  var modeTabs =
    '<div class="msgx-modes">' +
      chanTab('sms', 'Text', unreadSms) +
      (emailable || channelThread(c, 'email').length
        ? chanTab('email', 'Email', unreadEmail) : '') +
      chanTab('notes', 'Notes', 0, ' note') +
    '</div>';
  if(emailMode){
    /* The Gmail handoff, same shape as the Messages one and labelled with
       the same honesty: the link opens a draft and sends nothing, so it is
       logged as unconfirmed rather than as delivered.

       Gmail rather than an in-app send: it needs no provider account, it
       goes from the salesperson's own mailbox so it lands in their Sent
       folder, and the reply arrives where they already look. Which is also
       the limitation -- that reply arrives in Gmail and nothing here sees
       it, so this thread will show what you sent and never the answer. */
    composer = msgxEmailTemplateSelect(c) +
      '<input type="text" id="msgx-subj" class="lib-input" placeholder="Subject">' +
      '<textarea id="msgx-email" rows="3" placeholder="Email to ' +
        escapeHtml(firstName(c.name)) + '\u2026"></textarea>' +
      '<div class="row">' +
        '<button class="btn btn-sm btn-primary" data-action="msgx-email-open" data-cid="' +
          escapeHtml(c.id) + '">Open in Gmail</button>' +
        '<span class="msgx-sub">Opens a draft to ' + escapeHtml(c.email) +
          '. Their reply goes to your inbox, not here.</span>' +
      '</div>';
  } else if(noteMode){
    composer = '<textarea id="msgx-note" rows="2" placeholder="Note for your team \u2014 ' +
      escapeHtml(firstName(c.name)) + ' never sees this\u2026"></textarea>' +
      '<div class="row"><button class="btn btn-sm btn-note" data-action="msgx-add-note" data-cid="' +
      escapeHtml(c.id) + '">Add note</button>' +
      '<span class="msgx-sub">Visible to your team only.</span></div>';
  }

  var hprog = cadenceProgress(c, new Date());

  box.innerHTML =
    /* Who, where they stand, and what to do about it -- in that order, on
       one line each. The status control lives HERE rather than in the right
       column: it is the thing most likely to change while reading a
       conversation, and a second copy of the same control three inches away
       is two ways to set one value. */
    '<div class="msgx-head">' +
      '<button class="btn btn-sm btn-ghost msgx-back" data-action="msgx-back">\u2039</button>' +
      '<span class="mh-av">' + escapeHtml(initialsFor(c.name)) + '</span>' +
      '<div class="mh-id">' +
        '<div class="mh-top">' +
          '<strong>' + escapeHtml(c.name) + '</strong>' +
          '<select class="msgx-status" data-action="msgx-status" data-cid="' + escapeHtml(c.id) + '">' +
            VALID_STATUSES.map(function(st){
              return '<option value="' + escapeHtml(st) + '"' +
                (st === c.status ? ' selected' : '') + '>' + escapeHtml(st) + '</option>';
            }).join('') + '</select>' +
        '</div>' +
        '<div class="msgx-sub">' + escapeHtml(c.phone || 'no phone on file') + '</div>' +
        '<div class="mh-next">Touch ' + (hprog.done + 1) + ' of ' + hprog.total +
          ' \u00b7 ' + escapeHtml(nextActionLabel(STATE, c, new Date())) + '</div>' +
      '</div>' +
      '<button class="btn btn-sm" data-action="open-client" data-cid="' + escapeHtml(c.id) + '">Open contact</button>' +
    '</div>' +
    '<div class="msgx-msgs" id="msgx-msgs">' + bubbles + '</div>' +
    msgxTouchPanel(c, new Date()) +
    '<div class="msgx-compose' + (noteMode ? ' noting' : '') + '">' + modeTabs + composer + '</div>' +
    /* Working the list is the point: deal with one, move to the next,
       without going back to hunt for where you were. */
    '<div class="msgx-next"><button class="linkish" data-action="msgx-next">Next client \u2192</button></div>';

  /* Pre-fill the box with the due touch, ONCE per contact and touch.

     Doing it on every render would retype over somebody mid-sentence, since
     this function re-runs whenever anything in the workspace changes. The
     marker is what makes it a starting point rather than a correction. */
  var ptouch = threadTouch(STATE, c, new Date());
  var pkey = ptouch ? (c.id + '|' + ptouch.stage) : null;
  if(ptouch && ptouch.prefill && UI.msgxPrefilled !== pkey){
    var tbox = el('msgx-text');
    if(tbox && !tbox.value){ tbox.value = ptouch.prefill; UI.msgxPrefilled = pkey; }
  }

  restoreDraft();

  var scroller = el('msgx-msgs');
  if(scroller) scroller.scrollTop = scroller.scrollHeight;
}

function renderMsgxProfile(){
  var box = el('msgx-profile'); if(!box) return;
  var c = UI.threadCid && STATE.clients[UI.threadCid];
  if(!c){ box.innerHTML = ''; return; }
  var now = new Date();
  var prog = cadenceProgress(c, now);
  var tz = tzChipInfo(c, now);
  var auto = automationState(c, now);

  function field(label, value){
    return '<div class="msgx-pfield"><label>' + escapeHtml(label) + '</label>' +
      '<div class="v">' + value + '</div></div>';
  }
  /* Automation says what is happening and offers the one control that
     changes it. "Why am I not being told to text her" was previously
     answerable only by inference from an empty list. */
  var autoBody = '<span class="msgx-tag ' + (auto.running ? '' : 'wait') + '">' +
    escapeHtml(auto.label) + '</span>' +
    (auto.note ? '<div class="msgx-sub" style="margin-top:3px;">' + escapeHtml(auto.note) + '</div>' : '') +
    '<div class="row" style="margin-top:6px;gap:6px;">' +
    (auto.reason === 'manual'
      ? '<button class="btn btn-sm" data-action="msgx-resume" data-cid="' + escapeHtml(c.id) +
        '">Resume follow-ups</button>'
      : (auto.reason === 'archived' || auto.reason === 'status'
          ? ''
          : '<button class="btn btn-sm btn-ghost" data-action="msgx-pause" data-cid="' + escapeHtml(c.id) +
            '" data-days="7">Pause 7 days</button>' +
            '<button class="btn btn-sm btn-ghost" data-action="msgx-pause" data-cid="' + escapeHtml(c.id) +
            '" data-days="30">30 days</button>')) +
    '</div>';

  /* What is queued for this contact. Visible to the whole team, because an
     upcoming message only one person can see is how two people send the same
     thing twice. */
  var queued = (STATE.scheduled || []).filter(function(q){ return q.clientId === c.id; });
  var queuedBody = queued.length
    ? queued.map(function(q){
        return '<div class="msgx-queued"><div class="msgx-sub">' +
          escapeHtml(fmtDate(safeDate(q.sendAt), c.timezone)) + ' ' +
          escapeHtml(fmtTime(safeDate(q.sendAt), c.timezone)) +
          ' <button class="linkish" data-action="msgx-unschedule" data-id="' +
          escapeHtml(q.id) + '">cancel</button></div>' +
          escapeHtml(q.body.slice(0, 90)) + '</div>';
      }).join('')
    : '';

  /* Where the conversation stands, for somebody picking it up cold.

     A stale summary is labelled as stale rather than quietly shown as
     current: it is confident prose and it will be believed, so "3 messages
     since this was written" has to be on screen next to it. */
  var sum = summaryState(c);
  var summaryBody;
  if(sum.state === 'none'){
    summaryBody = '<button class="btn btn-sm btn-ghost" data-action="msgx-summarise" data-cid="' +
      escapeHtml(c.id) + '">\u2728 Summarise this conversation</button>';
  } else {
    summaryBody = '<div class="msgx-summary' + (sum.state === 'stale' ? ' stale' : '') + '">' +
      escapeHtml(sum.text) + '</div>' +
      '<div class="msgx-sub" style="margin-top:4px;">' +
      (sum.state === 'stale'
        ? '<span class="msgx-tag wait">' + sum.newSince + ' message' +
          (sum.newSince === 1 ? '' : 's') + ' since this was written</span> '
        : 'As of ' + escapeHtml(shortWhen(sum.at)) + ' ago. ') +
      '<button class="linkish" data-action="msgx-summarise" data-cid="' +
      escapeHtml(c.id) + '">refresh</button></div>';
  }

  /* Sections, most-acted-on first, with the rest folded away.

     Everything here used to be one flat run of fifteen labelled fields, so
     the AI summary and the contact's phone number carried identical weight.
     Grouping is the whole point: what you need to answer "who is this and
     what do I do" stays open, and the history you occasionally want does
     not. */
  function section(key, title, body, right, collapsible){
    var open = !collapsible || UI.msgxSections[key];
    return '<div class="mp-sec">' +
      '<div class="mp-head"' +
        (collapsible ? ' data-action="msgx-section" data-key="' + escapeHtml(key) + '"' : '') + '>' +
        '<span class="mp-title">' + escapeHtml(title) + '</span>' +
        (right || '') +
        (collapsible ? '<span class="mp-chev">' + (open ? '\u25be' : '\u25b8') + '</span>' : '') +
      '</div>' +
      (open ? '<div class="mp-body">' + body + '</div>' : '') +
    '</div>';
  }

  /* The sequence as segments rather than a sentence. "Touch 3 of 5" says
     where; five blocks say how much is left, which is the part somebody
     reads without counting. */
  var segs = '';
  for(var si = 0; si < prog.total; si++){
    segs += '<span class="mp-seg' + (si < prog.done ? ' on' : '') + '"></span>';
  }

  var lastAt = lastContactAt(c);
  var recent = conversationThread(c).filter(function(it){ return it.dir !== 'note'; })
    .slice(-6).reverse();

  box.innerHTML =
    section('details', 'Client details',
      field('Phone', escapeHtml(c.phone || '\u2014')) +
      (c.email ? field('Email', escapeHtml(c.email)) : '') +
      field('Source', escapeHtml(clientSource(c))) +
      field('Their time', escapeHtml(tz.timeLabel) +
        (tz.warn ? ' <span class="msgx-tag wait">outside hours</span>' : '')),
      '<button class="btn btn-sm btn-ghost mp-act" data-action="open-client" data-cid="' +
        escapeHtml(c.id) + '">Open</button>') +

    section('status', 'Status & follow-up',
      field('Status', escapeHtml(c.status || '\u2014')) +
      field('Sequence', '<div class="mp-segs">' + segs + '</div>' +
        '<div class="msgx-sub">Touch ' + (prog.done + 1) + ' of ' + prog.total + '</div>') +
      field('Next action', escapeHtml(nextActionLabel(STATE, c, now))) +
      field('Last contact', lastAt
        ? escapeHtml(fmtDate(safeDate(lastAt), c.timezone) + ' ' + fmtTime(safeDate(lastAt), c.timezone))
        : '<span class="msgx-sub">nothing yet</span>') +
      field('Automation', autoBody) +
      (queued.length ? field('Queued to send', queuedBody) : '')) +

    (c.callDateTime
      ? section('call', 'Upcoming call',
          field('When', escapeHtml(fmtDate(safeDate(c.callDateTime), c.timezone) + ' ' +
            appointmentTimeLabel(c.callDateTime, c.timezone, viewerTimezone()).text)) +
          (c.meetLink
            ? field('Link', '<a href="' + escapeHtml(c.meetLink) + '" target="_blank" rel="noopener">' +
                escapeHtml(c.meetLink.slice(0, 44)) + '</a>')
            : ''))
      : '') +

    section('summary', 'AI summary', summaryBody) +

    section('activity', 'Recent activity',
      recent.length
        ? recent.map(function(it){
            return '<div class="mp-act-row"><span class="msgx-sub">' +
              escapeHtml(shortWhen(it.at)) + ' \u00b7 ' +
              (it.dir === 'in' ? 'them' : 'you') + '</span>' +
              '<div>' + escapeHtml(it.text.slice(0, 70)) + '</div></div>';
          }).join('')
        : '<span class="msgx-sub">Nothing yet.</span>',
      '', true) +

    section('more', 'Additional info',
      field('Booked', c.bookedDate
        ? escapeHtml(fmtDate(safeDate(c.bookedDate), c.timezone))
        : '<span class="msgx-sub">\u2014</span>') +
      field('Timezone', escapeHtml(c.timezone || '\u2014')) +
      (c.notes ? field('Notes', escapeHtml(c.notes.slice(0, 400))) : ''),
      '', true);
}

/* "3h" / "2d" / a date once it stops being this week. An inbox is scanned,
   not read, so a full timestamp on every row is noise. */
function shortWhen(iso){
  var t = Date.parse(iso);
  if(isNaN(t)) return '';
  var mins = Math.floor((Date.now() - t) / 60000);
  if(mins < 1) return 'now';
  if(mins < 60) return mins + 'm';
  var hrs = Math.floor(mins / 60);
  if(hrs < 24) return hrs + 'h';
  var days = Math.floor(hrs / 24);
  if(days < 7) return days + 'd';
  return new Date(t).toLocaleDateString();
}

function renderRecentReplies(){
  var box = el('recent-replies'); if(!box) return;
  var list = recentReplies(STATE, new Date());
  if(!list.length){ box.innerHTML = ''; return; }
  box.innerHTML = '<div class="unplaced replies-panel"><h4>' + list.length + ' repl' +
    (list.length === 1 ? 'y' : 'ies') + ' in the last ' + RECENT_REPLY_DAYS + ' days</h4>' +
    list.slice(0, 12).map(function(r){
      return '<div class="u-row"><div class="u-meta">' +
        '<button class="linkish" data-action="open-client" data-cid="' + escapeHtml(r.clientId) + '">' +
        escapeHtml(r.name) + '</button> \u00b7 ' + new Date(r.at).toLocaleString() +
        '</div>' + escapeHtml(r.text) + '</div>';
    }).join('') +
    (list.length > 12 ? '<div class="u-meta" style="padding-top:6px;">and ' +
      (list.length - 12) + ' more</div>' : '') +
    '</div>';
}

function renderUnplacedReplies(){
  var box = el('unplaced-replies'); if(!box) return;
  var list = unplacedReplies(STATE);
  if(!list.length){ box.innerHTML = ''; return; }
  box.innerHTML = '<div class="unplaced"><h4>' + list.length + ' repl' +
    (list.length === 1 ? 'y' : 'ies') + ' we could not match to a ' +
    escapeHtml(termLower('contact')) + '</h4>' +
    list.slice(0, 10).map(function(r){
      return '<div class="u-row"><div class="u-meta">' +
        escapeHtml(r.fromPhone || 'unknown number') + ' \u00b7 ' +
        new Date(r.at).toLocaleString() + ' \u00b7 ' + escapeHtml(r.reason) +
        '</div>' + escapeHtml(r.text) + '</div>';
    }).join('') +
    (list.length > 10 ? '<div class="u-meta" style="padding-top:6px;">and ' +
      (list.length - 10) + ' more</div>' : '') +
    '</div>';
}

function renderOnDeck(){
  var box = el('on-deck'); if(!box) return;
  var now = new Date();
  var od = getOnDeck(STATE, now);

  // Never render nothing — a blank strip is indistinguishable from the panel
  // being broken, so every quiet state still says what it is.
  if(!od.focus){
    var head = '<h4><span>⏱ On deck</span><span>' +
      (od.todays.length ? (od.loggedCount + ' of ' + od.todays.length + ' logged today') : 'nothing today') +
      '</span></h4>';
    var body;
    if(od.unlogged.length){
      body = '<div class="od-quiet"><strong>' + od.unlogged.length + '</strong> call' +
        (od.unlogged.length === 1 ? '' : 's') + ' earlier today still ' +
        (od.unlogged.length === 1 ? 'needs' : 'need') + ' an outcome — logging them is what keeps your show-up rate honest.</div>';
    } else if(od.next){
      var nd = safeDate(od.next.callDateTime);
      body = '<div class="od-quiet">Next on the books: <button class="od-name" data-action="open-client" data-cid="' +
        od.next.id + '">' + escapeHtml(od.next.name) + '</button> · ' +
        fmtDateHere(nd) + ' at ' + fmtTimeHere(nd) + '</div>';
    } else {
      body = '<div class="od-quiet">No upcoming calls on the books. The next booking to sync lands here with a countdown and their number.</div>';
    }
    box.innerHTML = '<div class="ondeck">' + head + body + '</div>';
    return;
  }

  var c = od.focus;
  var d = safeDate(c.callDateTime);
  var tzInfo = tzChipInfo(c, now);
  var handle = extractChannelHandle(c.youtubeLink);
  var tel = telHref(c.phone);
  var digits = String(c.phone || '').replace(/\D/g, '');
  var nudge = onDeckNudgeText(c, od.late ? 'late' : 'soon', STATE.senderName);
  var sms = digits ? ('sms:' + (digits.length === 10 ? '+1' + digits : '+' + digits) + '&body=' + encodeURIComponent(nudge)) : null;
  var resched = (c.reschedules && c.reschedules.length) || c.rescheduleCount || 0;

  var html = '<div class="ondeck' + (od.late ? ' late' : od.soon ? ' soon' : '') + '">' +
    '<h4><span>⏱ On deck</span><span>' + od.todays.length + ' call' + (od.todays.length === 1 ? '' : 's') +
      ' today' + (od.loggedCount ? (' · ' + od.loggedCount + ' logged') : '') + '</span></h4>' +
    '<div class="od-main">' +
      '<span class="od-time">' + escapeHtml(appointmentTimeLabel(c.callDateTime, c.timezone, viewerTimezone()).mine) + '</span>' +
      '<button class="od-name" data-action="open-client" data-cid="' + c.id + '">' + escapeHtml(c.name) + '</button>' +
      '<span class="od-count">' + countdownLabel(od.mins) + '</span>' +
    '</div>' +
    '<div class="od-meta">' +
      (c.phone ? ('<span>' + escapeHtml(c.phone) + '</span>') : '<span class="od-chip warn">no phone on file</span>') +
      '<span class="od-chip' + (tzInfo.warn ? ' warn' : '') + '">' + escapeHtml(tzInfo.timeLabel) + ' their time</span>' +
      (handle ? ('<span class="od-chip">▶ ' + escapeHtml(handle) + '</span>') : '') +
      (resched ? ('<span class="od-chip">↻ moved ' + resched + '×</span>') : '') +
    '</div>' +
    (c.notes && c.notes.trim() ? ('<div class="od-note"><strong>Notes:</strong> ' + escapeHtml(c.notes.trim()) + '</div>') : '') +
    (od.late ? ('<div class="od-note">' + Math.abs(od.mins) + ' minutes past the start. One "I\'m here whenever you\'re ready" text saves a lot of these before they become a no-show.</div>') : '') +
    '<div class="od-actions">' +
      (tel ? ('<a class="btn btn-sm" href="' + escapeHtml(tel) + '">📞 Call</a>') : '') +
      (sms ? ('<a class="btn btn-sm btn-primary" href="' + escapeHtml(sms) + '">💬 ' + (od.late ? 'Text "I\'m here"' : 'Send the link') + '</a>') : '') +
      (od.started ? (
        '<button class="btn btn-sm btn-green" data-action="set-outcome-quick" data-cid="' + c.id + '" data-status="Showed">✓ Showed</button>' +
        '<button class="btn btn-sm" data-action="set-outcome-quick" data-cid="' + c.id + '" data-status="No-show">✗ No-show</button>' +
        '<button class="btn btn-sm" data-action="set-outcome-quick" data-cid="' + c.id + '" data-status="Rescheduled">↻ Resched</button>'
      ) : '') +
    '</div>' +
    (od.later.length ? ('<div class="od-rest"><span>Also today:</span>' + od.later.map(function(x){
      return '<button data-action="open-client" data-cid="' + x.id + '">' +
        appointmentTimeLabel(x.callDateTime, x.timezone, viewerTimezone()).mine + ' · ' + escapeHtml(x.name) + '</button>';
    }).join('') + '</div>') : '') +
  '</div>';

  box.innerHTML = html;
}


function renderCallsBoard(){
  // Entry into focus mode lives on the list it works through, labelled with
  // the count so the size of the job is visible before committing to it.
  var todayHead = document.querySelector('#tab-calls .board-col h3');
  if(todayHead && !todayHead.querySelector('[data-action=focus-start]')){
    /* Called "Focus mode", not "Work the list". That phrase now belongs to
       the button that opens the messaging workspace, and two controls with
       the same label doing different things is worse than either name. */
    var btn = h('button',{class:'btn btn-sm focus-start','data-action':'focus-start',
      title:'Step through the due touches one at a time, without leaving this page.'},['Focus mode']);
    todayHead.appendChild(btn);
  }

  var now = new Date();
  var textToday = getTextTodayList(STATE, now, UI.callsSearch);
  /* Text today is a SUMMARY now, with the cards folded away behind it.

     The work itself moved to the messaging workspace, where the touch sits
     next to the conversation it lands in. Keeping a full second copy of it
     here is the duplication this consolidation exists to remove -- and two
     places to send the same touch is two places for somebody to send it
     twice.

     The cards are folded, not deleted. The workspace is a day old; if it
     turns out to be missing something, the old way is one click away rather
     than one deploy away. */
  var summary = el('text-today-summary');
  if(summary){
    var replied = textToday.filter(function(it){
      var th = conversationThread(it.client).filter(function(x){ return x.dir !== 'note'; });
      return th.length && th[th.length - 1].dir === 'in';
    }).length;
    summary.innerHTML = textToday.length
      ? '<strong>' + textToday.length + ' ' + (textToday.length === 1 ? 'text' : 'texts') +
          ' due today</strong>' +
        (replied
          ? ' \u00b7 <span class="tt-urgent">' + replied + ' already replied</span>, ' +
            'so a template is the wrong answer for ' + (replied === 1 ? 'that one' : 'those') + '.'
          : '') +
        '<div class="tt-actions">' +
          '<button class="btn btn-sm btn-primary" data-action="work-the-list">Work the list</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="toggle-text-today">' +
            (textTodayOpen() ? 'Hide the cards' : 'Show the cards') + '</button>' +
        '</div>'
      : '<strong>Nothing due today.</strong>';
  }

  /* The stale-filter reset runs whether or not the cards are on screen.

     Folding them away gated this too at first, and a test caught it: a
     filter pointing at a kind no longer due would survive being hidden and
     then show an empty column when the cards came back, with nothing saying
     why. Hiding something must not change what is true about it. */
  var counts = {}, order = [];
  textToday.forEach(function(it){
    if(counts[it.stage] === undefined){ counts[it.stage] = 0; order.push(it.stage); }
    counts[it.stage]++;
  });
  // A filter pointing at a kind that is no longer due would show an empty
  // column with no way to tell why, so it falls back to showing everything.
  if(UI.touchFilter && counts[UI.touchFilter] === undefined) UI.touchFilter = '';

  var todayCol = el('col-text-today');
  if(todayCol) todayCol.style.display = textTodayOpen() ? '' : 'none';
  if(todayCol && textTodayOpen()){
    todayCol.innerHTML = '';

    /* Filter buttons across the top instead of headings down the middle.

       Grouping the list fixed the order but the inline headings fought the
       cards: a divider every few rows breaks the column up exactly where you
       are trying to read down it. The same information works better as a row
       of buttons — what kinds are waiting, how many of each, and one click to
       see only those.

       Built from what is actually in the list today, so a kind with nothing
       due does not offer an empty button. Counted above, so the reset
       happens even while this is folded. */
    if(order.length > 1){
      var bar = h('div',{class:'touch-filter'},[]);
      bar.appendChild(h('button',{
        class:'tf-chip' + (UI.touchFilter ? '' : ' on'),
        'data-action':'touch-filter','data-stage':''},
        ['All', h('b',{},[String(textToday.length)])]));
      order.forEach(function(st){
        bar.appendChild(h('button',{
          class:'tf-chip ' + st + (UI.touchFilter === st ? ' on' : ''),
          'data-action':'touch-filter','data-stage':st},
          [touchLabel(st), h('b',{},[String(counts[st])])]));
      });
      todayCol.appendChild(bar);
    }

    var shown = UI.touchFilter
      ? textToday.filter(function(it){ return it.stage === UI.touchFilter; })
      : textToday;

    if(!shown.length){
      todayCol.appendChild(UI.callsSearch.trim()
        ? h('div',{class:'empty-note'},['No matches for "' + UI.callsSearch.trim() + '".'])
        : buildAllClearPanel());
    }

    /* No headings between the cards at all now.

       They were the first attempt at grouping and the buttons replaced them.
       Keeping both meant the list was divided twice over -- once by a row you
       choose from and again by dividers you did not -- and the dividers break
       the column exactly where you are reading down it.

       The buttons are the grouping. Pick the kind you are ready to work and
       the list is only that; leave it on All and the order still runs
       welcomes first through the cold chasing last, without anything cutting
       across it. */
    shown.forEach(function(it){
      /* Honour an arrow press, but only while it still makes sense.

         The pick is dropped the moment that touch is no longer pending —
         because it was sent, or because the appointment moved and the cadence
         was recomputed. Without that, a card would sit on a touch already
         gone out and the next press of 'check once sent' would log it twice. */
      var stage = it.stage;
      var picked = UI.touchPick[it.client.id];
      if(picked){
        var pending = cadenceProgress(it.client, now).pendingStages || [];
        if(pending.indexOf(picked) !== -1) stage = picked;
        else delete UI.touchPick[it.client.id];
      }
      todayCol.appendChild(buildTouchCard(it.client, stage, now));
    });
  }
  var countToday = el('count-today'); if(countToday) countToday.textContent = '(' + textToday.length + ')';
}


/* ---- recent sends: "did they reply?" review, newest first ---- */
// The one panel that nags. Every row here is a send the bandit is holding in
// limbo: it can't count as a win or a loss until someone says which it was.
// Two explicit buttons rather than a checkbox, because a checkbox left
// unticked is ambiguous — and that ambiguity is exactly what broke the stats
// in the first place.
/* Ghost Recall Today — the answer to "who should I contact?".
   Ranked by Ghost Score, and every row carries its reasons, because the whole
   value of a priority list is that the person working it believes the order.
   An unexplained ranking gets ignored, and an ignored list is worth nothing. */
/* Unlogged calls, asked on the screen you already open.

   The question existed before — in End of day, behind a button. That is why
   the backlog reached 44: answering required deciding to go and look. Here it
   sits above the day's work, with the same one-click answers, and disappears
   the moment it is empty.

   Capped at six visible rows. A wall of forty reads as a chore to be scrolled
   past; six reads as something you can finish, and the rest are one click away
   in End of day. */
function renderUnlogged(){
  var box = el('unlogged-calls');
  if(!box) return;
  box.innerHTML = '';
  var items = getUnloggedCalls(STATE, new Date());
  if(!items.length) return;

  var head = h('div',{class:'ul-head'},[
    h('strong',{},[items.length + ' past ' +
      (items.length === 1 ? termLower('appointment') : termLower('appointmentPlural')) + ' with no outcome']),
    h('span',{class:'ul-why'},['These are left out of your show rate until you answer.'])
  ]);
  var body = h('div',{class:'ul-body'},[]);
  items.slice(0, 6).forEach(function(it){
    var c = it.client;
    body.appendChild(h('div',{class:'ul-row'},[
      h('span',{class:'ul-name','data-action':'open-client','data-cid':c.id},[c.name]),
      h('span',{class:'ul-when'},[it.daysAgo === 0 ? 'today' : it.daysAgo + 'd ago']),
      h('span',{class:'ul-acts'},[
        h('button',{class:'eod-btn ok','data-action':'eod-outcome','data-cid':c.id,'data-status':'Showed'},['Showed']),
        h('button',{class:'eod-btn bad','data-action':'eod-outcome','data-cid':c.id,'data-status':'No-show'},['No-show']),
        h('button',{class:'eod-btn','data-action':'eod-outcome','data-cid':c.id,'data-status':'Rescheduled'},['Rescheduled'])
      ])
    ]));
  });
  if(items.length > 6){
    body.appendChild(h('div',{class:'ul-more','data-action':'end-of-day'},
      ['+ ' + (items.length - 6) + ' more — clear them in End of day']));
  }
  box.appendChild(h('div',{class:'ul'},[head, body]));
}


function renderGhostToday(){
  var box = el('ghost-today');
  if(!box) return;
  box.innerHTML = '';
  var now = new Date();
  var ranked = rankByGhostScore(STATE, now, {min: 26});   // nurture and above

  var counts = {immediate:0, high:0, soon:0, nurture:0};
  ranked.forEach(function(r){ counts[r.band] = (counts[r.band] || 0) + 1; });

  // Default to what is genuinely actionable today rather than everything
  // scoring above the floor. "65 need attention" is a number that gets a list
  // closed, not worked — and if everything is urgent then nothing is. Nurture
  // is real but it is this week's problem, so it sits behind a chip.
  var actionable = ranked.filter(function(r){ return r.band !== 'nurture'; });
  var filter = UI.ghostFilter || 'actionable';
  var shown = filter === 'actionable' ? actionable
            : filter === 'all' ? ranked
            : ranked.filter(function(r){ return r.band === filter; });

  var head = h('div',{class:'gt-head'},[
    h('h3',{html: brandMarkHtml(18) + '<span>Ghost Recall Today</span>'}),
    h('span',{class:'count'},[
      actionable.length
        ? (actionable.length + ' ' + (actionable.length === 1 ? termLower('contact') : termLower('contactPlural')) + ' need attention')
        : (ranked.length ? 'Nothing urgent — ' + ranked.length + ' resting in nurture' : 'Nothing needs chasing right now')
    ])
  ]);

  var filters = h('span',{class:'gt-filters'},[]);
  [['actionable','Today',actionable.length],['immediate','Immediate',counts.immediate],
   ['high','High',counts.high],['soon','Soon',counts.soon],['nurture','Nurture',counts.nurture],
   ['all','All',ranked.length]
  ].forEach(function(f){
    // A filter that would show an empty list is worse than no filter — it
    // reads as a bug. Hide bands nobody is in, but always keep All and Today.
    if(f[0] !== 'all' && f[0] !== 'actionable' && !f[2]) return;
    filters.appendChild(h('button',{
      class: 'gt-chip' + (filter === f[0] ? ' active' : ''),
      'data-action':'ghost-filter','data-band':f[0]
    },[f[1] + ' ' + f[2]]));
  });
  head.appendChild(filters);

  var body = h('div',{class:'gt-body'},[]);
  if(!shown.length){
    body.appendChild(h('div',{class:'gt-empty'},[
      ranked.length
        ? 'Nothing here right now. ' + (filter === 'actionable' ? 'Check Nurture for the slower burners.' : 'Try another band.')
        : 'Every ' + termLower('contact') + ' is either handled or resting in the ' + termLower('graveyard') + '.'
    ]));
  }

  shown.slice(0, 25).forEach(function(r){
    var c = r.client;
    var digits = String(c.phone || '').replace(/\D/g,'');
    var smsTo = digits ? ('sms:' + (digits.length === 10 ? '+1' + digits : '+' + digits)) : null;
    var rec = recommendNextAction(c, now);

    // One obvious primary action, with the rest demoted to secondary. A row of
    // equally-weighted buttons makes the salesperson decide what Ghost Recall
    // was supposed to have decided for them.
    var acts = h('span',{class:'gt-acts'},[]);
    var primary = null;
    if(rec.action === 'call' && digits){
      primary = h('a',{class:'gt-primary', href: telHref(c.phone), title: rec.why},['📞 ' + rec.label]);
    } else if((rec.action === 'text' || rec.action === 'reply') && smsTo){
      // Named msgBody, not body: `var` is function-scoped, so a `body` here
      // hoists over the panel's own `body` container and turns
      // body.appendChild(row) at the end of this loop into a call on a string.
      var msgBody = rec.stage ? getCardText(STATE, c, rec.stage) : '';
      primary = h('a',{class:'gt-primary', href: smsTo + (msgBody ? '&body=' + encodeURIComponent(msgBody) : ''),
        title: rec.why},['💬 ' + rec.label]);
    } else if(rec.action === 'wait'){
      primary = h('span',{class:'gt-primary muted', title: rec.why},['⏳ ' + rec.label]);
    }
    if(primary) acts.appendChild(primary);

    // Secondary: the other channel, always reachable — a recommendation is a
    // suggestion, not a restriction.
    if(digits && rec.action !== 'call') acts.appendChild(h('a',{href: telHref(c.phone)},['Call']));
    if(smsTo && rec.action !== 'text' && rec.action !== 'reply') acts.appendChild(h('a',{href: smsTo},['Text']));
    if(canEmail(c) && emailLibrary(STATE).length){
      acts.appendChild(h('a',{href:'#','data-action':'pick-email','data-cid':c.id},['Email']));
    }
    acts.appendChild(h('button',{'data-action':'open-client','data-cid':c.id},['Open']));

    // Where this contact sits in the one interaction lifecycle. Waiting is
    // stated, not asked about; only an interaction past the reply window turns
    // into a question, and then it is the single control below.
    var inter = lastInteraction(c, now);
    /* Ask about the send that still owes an answer, which is not always the
       latest one. Asking only about the latest meant a new touch buried the
       previous question permanently -- 348 sends on this book that nothing
       will ever ask about. pendingQuestion keeps the oldest still-answerable
       one in front of you until it is answered or expires. */
    var pending = pendingQuestion(c, now);
    var needsOutcome = pending.idx !== -1 || inter.state === 'needs_outcome';
    var askingAbout = pending.idx !== -1 ? pending.message : inter.message;

    // Only the contributions that pushed this contact UP are worth showing —
    // the penalties explain why someone is lower, which is not what a person
    // working the list from the top needs to know.
    var why = r.reasons.filter(function(x){ return x.points > 0 && x.label !== 'Baseline'; });
    var whyEl = h('div',{class:'gt-why'},[]);
    why.forEach(function(x, i){
      if(i) whyEl.appendChild(document.createTextNode('  ·  '));
      whyEl.appendChild(document.createTextNode(x.label + ' '));
      whyEl.appendChild(h('span',{class:'pt'},['+' + x.points]));
    });

    var main = h('div',{class:'gt-main'},[
      h('div',{class:'gt-name','data-action':'open-client','data-cid':c.id},[c.name + '  ·  ' + statusLabel(c.status)]),
      whyEl
    ]);
    if(inter.state !== 'none'){
      main.appendChild(h('div',{class:'gt-state ' + inter.state},[interactionLabel(inter)]));
    }
    if(rec.why) main.appendChild(h('div',{class:'gt-rec'},['→ ' + rec.why]));

    var row = h('div',{class:'gt-row' + (needsOutcome ? ' needs-outcome' : '')},[
      // The full working on hover: the row shows what lifted them, the tooltip
      // shows what held them down too, so the number reconciles with the
      // reasons printed beside it instead of looking like bad arithmetic.
      h('span',{class:'gt-score ' + r.band, title: describeScore(r)},[String(r.score)]),
      main,
      acts
    ]);

    // The one manual control, and only when Ghost Recall genuinely can't tell.
    if(needsOutcome){
      /* Name the message being answered when it is not the obvious one.

         "What happened?" is clear when it means the text you just sent. Once
         it can mean an earlier touch, an unlabelled question gets answered
         about the wrong message -- and a confidently wrong answer is worse
         for the bandit than no answer, which is the whole reason the 3-day
         ceiling exists. */
      var ocLabel = 'What happened?';
      if(askingAbout && pending.idx !== -1 && inter.message && askingAbout !== inter.message){
        /* Phrased from hoursAgo, which pendingQuestion already computed --
           no new date helper, and it cannot disagree with the window that
           decided the question was answerable in the first place. */
        var hrs = pending.hoursAgo || 0;
        var whenTxt = hrs < 24 ? 'earlier today'
          : hrs < 48 ? 'yesterday'
          // Floor, not round: 60 hours is two and a half days, and rounding
          // calls it three. Overstating how long ago it was makes the answer
          // feel less reliable than it is.
          : Math.floor(hrs / 24) + ' days ago';
        ocLabel = 'Did they reply to your ' + touchLabel(askingAbout.stage).toLowerCase() +
          ' text from ' + whenTxt + '?';
      }
      var oc = h('div',{class:'gt-outcome'},[h('span',{class:'lbl'},[ocLabel])]);
      INTERACTION_OUTCOMES.forEach(function(o){
        oc.appendChild(h('button',{class:'oc-btn','data-action':'interaction-outcome',
          'data-cid':c.id,'data-outcome':o.key},[o.label]));
      });
      row.appendChild(oc);
      // Progressive disclosure: the follow-up field only exists once an
      // outcome that needs one has been chosen.
      if(UI.outcomeOpen && UI.outcomeOpen.cid === c.id){
        row.appendChild(buildOutcomeDetail(c, UI.outcomeOpen.outcome));
      }
    }
    body.appendChild(row);
  });

  if(shown.length > 25){
    body.appendChild(h('div',{class:'gt-empty'},['+ ' + (shown.length - 25) + ' more below this cut.']));
  }

  box.appendChild(h('div',{class:'gt'},[head, body]));
}


// Progressive disclosure for the outcomes that need one more fact. Everything
// else resolves in a single tap — "No reply" asks nothing, because there is
// nothing more to know.
function buildOutcomeDetail(client, outcome){
  var box = h('div',{class:'gt-detail'},[]);
  if(outcome === 'booked'){
    box.appendChild(h('label',{},['When is it?']));
    box.appendChild(h('input',{type:'datetime-local',id:'oc-when'}));
  } else if(outcome === 'replied'){
    box.appendChild(h('label',{},['What did they say? (optional)']));
    box.appendChild(h('input',{type:'text',id:'oc-note',placeholder:'Paste their reply or a quick note…'}));
  } else if(outcome === 'not_interested'){
    box.appendChild(h('label',{},['Reason (optional)']));
    box.appendChild(h('input',{type:'text',id:'oc-note',placeholder:'Too expensive, bad timing, went elsewhere…'}));
  } else if(outcome === 'call_back'){
    box.appendChild(h('label',{},['Call back when?']));
    box.appendChild(h('input',{type:'date',id:'oc-until'}));
  }
  box.appendChild(h('button',{class:'btn btn-sm btn-green','data-action':'interaction-confirm',
    'data-cid':client.id,'data-outcome':outcome},['Save']));
  box.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'interaction-cancel'},['Cancel']));
  return box;
}


function renderRecentSends(){
  var block = el('recent-sends-block');
  var body = el('recent-sends-body');
  var title = el('recent-sends-title');
  if(!block || !body || !title) return;
  block.classList.toggle('collapsed', !UI.recentSendsOpen);

  var now = new Date();
  var recent = getRecentSends(STATE, now, 3);
  title.textContent = 'Recent sends (last 3 days)' + (recent.length ? ' — ' + recent.length : '');
  body.innerHTML = '';
  if(!recent.length){
    body.appendChild(h('div',{class:'recent-sends-empty'},['Nothing sent in the last 3 days.']));
    return;
  }
  recent.forEach(function(it){
    var sentAt = safeDate(it.message.sentAt);
    var when = sentAt ? (fmtDate(sentAt, it.client.timezone) + ' ' + fmtTime(sentAt, it.client.timezone)) : '';
    // History, not a form. The outcome is captured once in Ghost Recall Today.
    var label = h('span',{class:'replied-label'},[interactionLabel({
      state: messageState(it.message, now), hoursAgo: null, message: it.message
    })]);
    var stageChip = h('span',{class:'stage-chip' + (it.message.stage==='noshow'?' noshow':'') + (it.message.stage==='recovery'?' recovery':'')},[it.message.stage]);
    body.appendChild(h('div',{class:'recent-send-row'},[
      h('span',{class:'name'},[it.client.name]),
      stageChip,
      h('span',{class:'snippet'},[it.message.text]),
      h('span',{class:'when'},[when]),
      label
    ]));
  });
}


/* ---- all clients tab ---- */
function renderClientsTab(){
  var chipsBox = el('status-chips'); if(!chipsBox) return;
  var clients = Object.keys(STATE.clients).map(function(k){ return STATE.clients[k]; });
  var live = clients.filter(function(c){ return !c.ignored; });

  // Scored once, up front: the group chips need counts, the rows need badges,
  // and score sorting needs values — all from the same pass rather than three.
  var scoreNow = new Date();
  var scoredAll = live.map(function(c){
    return {client: c, g: computeGhostScore(c, scoreNow), p: cadenceProgress(c, scoreNow)};
  });

  chipsBox.innerHTML = '';
  chipsBox.appendChild(h('button',{class:'chip'+(!UI.scoreFilter && UI.statusFilter===null?' active':''),
    'data-action':'filter-score','data-group':''},['All (' + live.length + ')']));

  // How hot is this lead — the grouping people actually sort by — comes first.
  SCORE_GROUPS.forEach(function(grp){
    var n = scoredAll.filter(function(r){ return scoreGroupOf(r.g.band) === grp.key; }).length;
    chipsBox.appendChild(h('button',{class:'chip chip-' + grp.key + (UI.scoreFilter===grp.key?' active':''),
      'data-action':'filter-score','data-group':grp.key},[grp.label + ' (' + n + ')']));
  });

  // Pipeline status stays available after them: a different question (where is
  // this in the process) rather than a competing answer to the same one.
  VALID_STATUSES.forEach(function(st){
    var n = live.filter(function(c){ return c.status===st; }).length;
    if(!n) return;   // an empty filter reads as a bug
    chipsBox.appendChild(h('button',{class:'chip chip-status'+(UI.statusFilter===st?' active':''),
      'data-action':'filter-status','data-status':st},[statusLabel(st) + ' (' + n + ')']));
  });

  var q = UI.clientsSearch.trim().toLowerCase();
  var scoredList = scoredAll;
  if(UI.scoreFilter) scoredList = scoredList.filter(function(r){ return scoreGroupOf(r.g.band) === UI.scoreFilter; });
  if(UI.statusFilter) scoredList = scoredList.filter(function(r){ return r.client.status === UI.statusFilter; });
  if(q) scoredList = scoredList.filter(function(r){ return r.client.name.toLowerCase().indexOf(q) !== -1; });
  var list = scoredList.map(function(r){ return r.client; });

  var scored = scoredList;
  if(UI.clientsSort === 'score'){
    scored.sort(function(a, b){
      if(b.g.score !== a.g.score) return b.g.score - a.g.score;
      return byCallDate(a.client, b.client);
    });
  } else {
    scored.sort(function(a, b){ return byCallDate(a.client, b.client); });
  }
  var heads = document.querySelectorAll('#tab-clients th.sortable');
  for(var hi = 0; hi < heads.length; hi++){
    heads[hi].classList.toggle('active', heads[hi].getAttribute('data-sort') === (UI.clientsSort || 'call'));
  }

  var tbody = el('clients-table-body'); tbody.innerHTML = '';
  if(!list.length){
    var emptyTd = h('td',{colspan:'8'},[]);
    emptyTd.innerHTML = '<div class="empty-mascot">' + slimerSvg(56) + '<div>No clients found.</div></div>';
    tbody.appendChild(h('tr',{},[emptyTd]));
  }
  scored.forEach(function(row){
    var c = row.client;
    var d = safeDate(c.callDateTime);
    var when = d ? (fmtDate(d, viewerTimezone()) + ' ' + appointmentTimeLabel(d, c.timezone, viewerTimezone()).text) : '—';
    var lastIdx = lastMessageIndex(c);
    var repliedCell;
    if(lastIdx === -1){
      repliedCell = h('td',{class:'replied-cell'},['—']);
    } else {
      // Read-only: this column reports where the interaction stands rather
      // than asking the same question a fourth time.
      var st = messageState(c.messageLog[lastIdx], new Date());
      var glyph = st === 'replied' ? '👍' : st === 'waiting' ? '⏳' : st === 'no_reply' ? '—' : '?';
      repliedCell = h('td',{class:'replied-cell', title: interactionLabel(lastInteraction(c, new Date()))},[glyph]);
    }
    // The reasons travel with the number. A score with no explanation is one
    // people learn to ignore — same principle as the ranked queue, in a
    // tooltip because a table row has no room for prose.
    var why = row.g.reasons.filter(function(r){ return r.points > 0 && r.label !== 'Baseline'; })
      .map(function(r){ return r.label + ' +' + r.points; }).join('\n');
    // Marked, not hidden: a contact that simply vanished would look like data
    // loss. Saying whose it is explains why it never appears in the queue.
    var others = isOthersLead(c, STATE.myCalendars);
    var tr = h('tr',{class:'clickable' + (others ? ' others-lead' : ''),'data-action':'open-client','data-cid':c.id},[
      h('td',{class:'score-cell'},[
        h('span',{class:'score-dot ' + row.g.band, title: why || 'Nothing pushing this one up right now'},
          [String(row.g.score)])
      ]),
      h('td',{},[
        c.name,
        others ? h('span',{class:'others-tag', title:'Booked by ' + c.organizerEmail + ' — not in your follow-up queue'},
          [String(c.organizerEmail || '').split('@')[0]]) : ''
      ]),
      h('td',{class:'touch-cell', title: 'Sent so far: ' + (row.p.sentStages.join(', ') || 'nothing yet')},
        [row.p.complete ? '✓ all ' + row.p.total : row.p.label]),
      h('td',{},[when]),
      h('td',{},[h('span',{class:'status-pill st-'+c.status},[statusLabel(c.status)])]),
      h('td',{},[c.phone || '—']),
      repliedCell,
      h('td',{},[c.closeOutcome || '—'])
    ]);
    tbody.appendChild(tr);
  });
}


/* ---- variants tab ---- */
function lastFollowUpSentAt(client){
  var latest = null;
  ['recovery','noshow','rebooked','followup'].forEach(function(stage){
    var m = lastSentAtMs(client, stage);
    if(m !== null && (latest === null || m > latest)) latest = m;
  });
  return latest;
}

/* Closed — the deals that actually landed.

   Kept separate from the Graveyard rather than folded into it. A closed deal
   and a written-off lead are opposite outcomes, and a single "done" bucket
   would make both unreadable — you could no longer tell whether the pile was
   success or failure.

   Shows how many touches it took to get there, because that is the number
   that tells you whether the follow-up is doing anything. */
function renderClosedTab(){
  var body = el('closed-table-body');
  if(!body) return;
  var all = Object.keys(STATE.clients).map(function(k){ return STATE.clients[k]; })
    .filter(function(c){ return !c.ignored; });
  var closed = all.filter(function(c){ return c.closeOutcome === 'Closed'; });
  var decided = all.filter(function(c){ return c.closeOutcome; }).length;

  var countEl = el('closed-count');
  if(countEl) countEl.textContent = closed.length ? '(' + closed.length + ')' : '';

  var summary = el('closed-summary');
  if(summary){
    // The rate is over the ones with a result recorded, and says so — the
    // same honesty the show rate now carries.
    var undecided = all.length - decided;
    summary.textContent = decided
      ? closed.length + ' of ' + decided + ' decided (' + Math.round(100 * closed.length / decided) + '%)' +
        (undecided ? '  ·  ' + undecided + ' with no result recorded yet' : '')
      : 'No results recorded yet.';
  }

  closed.sort(function(a, b){
    var da = safeDate(a.callDateTime), db = safeDate(b.callDateTime);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  body.innerHTML = '';
  if(!closed.length){
    var td = h('td',{colspan:'5'},[]);
    td.innerHTML = '<div class="closed-empty">Nothing closed yet. Mark a result on a ' +
      escapeHtml(termLower('appointment')) + ' that happened and it will show up here.</div>';
    body.appendChild(h('tr',{},[td]));
    return;
  }
  closed.forEach(function(c){
    var d = safeDate(c.callDateTime);
    body.appendChild(h('tr',{class:'clickable','data-action':'open-client','data-cid':c.id},[
      h('td',{},[c.name]),
      h('td',{},[d ? fmtDate(d, c.timezone) : '—']),
      h('td',{},[d ? fmtDate(d, c.timezone) : '—']),
      h('td',{},[String((c.messageLog || []).length)]),
      h('td',{},[c.phone || '—'])
    ]));
  });
}


function renderDeadTab(){
  var tbody = el('dead-table-body'); if(!tbody) return;
  var now = new Date();
  var dead = computeDeadClients(STATE, now).slice().sort(function(a,b){
    var fa = lastFollowUpSentAt(a), fb = lastFollowUpSentAt(b);
    // oldest follow-up first — the ones that have been cold longest surface at the top
    return (fa===null?0:fa) - (fb===null?0:fb);
  });
  var countEl = el('dead-count'); if(countEl) countEl.textContent = dead.length ? '(' + dead.length + ')' : '';
  var emptyNote = el('dead-empty-note'); if(emptyNote) emptyNote.style.display = dead.length ? 'none' : '';
  tbody.innerHTML = '';
  dead.forEach(function(c){
    var callD = safeDate(c.callDateTime);
    var callWhen = callD ? (fmtDate(callD, viewerTimezone()) + ' ' + appointmentTimeLabel(callD, c.timezone, viewerTimezone()).text) : '—';
    var fMs = lastFollowUpSentAt(c);
    var followWhen = fMs !== null ? fmtDate(new Date(fMs), c.timezone) : 'never sent';
    var tr = h('tr',{class:'clickable','data-action':'open-client','data-cid':c.id},[
      h('td',{},[c.name]),
      h('td',{},[callWhen]),
      h('td',{},[h('span',{class:'status-pill st-'+c.status},[statusLabel(c.status)])]),
      h('td',{},[followWhen]),
      h('td',{},[c.phone || '—']),
      h('td',{},[h('button',{class:'btn-ghost btn btn-sm','data-action':'delete-client-quick','data-cid':c.id,title:'Remove this client entirely'},['Delete'])])
    ]);
    tbody.appendChild(tr);
  });
}


/* Does this message produce appointments, not just replies?

   Rates are shown only where the sample supports them. A variant with three
   credited appointments showing "67%" looks authoritative and is noise — and
   noise printed as a percentage is how someone ends up rewriting a template
   that was fine. Thin rows show their raw counts and say so. */
/* The email library.

   Email used to be the five touches in a different font: one subject and one
   body per stage, fired when that touch came due. Wrong about how email is
   actually used. A text is a nudge timed to a call; an email is a document —
   the pricing breakdown, the case study, the post-call recap — and it goes out
   when the conversation asks for it.

   So this is a library, not a cadence. Flat, hand-ordered, each entry labelled
   with when to send it, each as long as it needs to be, any of them reachable
   for any contact. Nothing here sends itself.

   Downloadable, because copy a business wrote should not be trapped in
   someone else's web app. */
/* From a call you just had, to a message that mentions it.

   The gap this closes: a recap email is only worth sending if it says what
   was actually discussed, and typing that out per contact is the work nobody
   does. Notes already exist — in Granola, in a notebook, in your head on the
   drive back — so the job is to get them into the contact and let them drive
   the message.

   Saving and drafting are separate buttons on purpose. The notes are worth
   keeping on the contact whether or not a draft gets written: they feed the
   recap email's {recap}, the AI text drafting, and the next person who opens
   that contact in six months. */
var NOTES_PANEL = {cid: '', notes: '', draft: null, channel: 'email', busy: false, open: false};

function recentContactsForNotes(){
  // Whoever you have most likely just spoken to: calls nearest to now first,
  // past or future, since notes get written straight after a call.
  var now = Date.now();
  return Object.keys(STATE.clients)
    .map(function(k){ return STATE.clients[k]; })
    .filter(function(c){ return !c.ignored && c.callDateTime; })
    .sort(function(a, b){
      return Math.abs(Date.parse(a.callDateTime) - now) - Math.abs(Date.parse(b.callDateTime) - now);
    })
    .slice(0, 60);
}

function renderNotesPanel(box){
  /* Closed until wanted.

     This is a tool, not the contents of the tab. Open by default it took a
     third of the screen on every visit -- a form sitting between someone and
     the emails they came to look at. It is used after a call, which is a
     minority of visits.

     A row rather than a button, so it reads as a section that opens rather
     than an action that does something. */
  var wrap = h('div',{class:'np' + (NOTES_PANEL.open ? ' open' : '')},[]);

  var head = h('div',{class:'np-head','data-action':'np-toggle'},[
    h('h3',{},['Draft from your call notes']),
    h('span',{class:'np-caret'},[NOTES_PANEL.open ? '\u25BE' : '\u25B8'])
  ]);
  wrap.appendChild(head);

  if(!NOTES_PANEL.open){
    box.appendChild(wrap);
    return;
  }

  wrap.appendChild(h('span',{class:'hint'},[
    'Paste what came out of the call. It saves to the ' + termLower('contact') +
    ' and writes a follow-up that actually mentions it.'
  ]));

  var picker = h('select',{class:'np-select','data-action':'np-client'},[]);
  picker.appendChild(h('option',{value:''},['Choose a ' + termLower('contact') + '...']));
  recentContactsForNotes().forEach(function(c){
    var d = safeDate(c.callDateTime);
    var opt = h('option',{value:c.id},[c.name + (d ? '  -  ' + fmtDate(d, c.timezone) : '')]);
    if(c.id === NOTES_PANEL.cid) opt.selected = true;
    picker.appendChild(opt);
  });
  wrap.appendChild(picker);

  wrap.appendChild(h('textarea',{class:'np-notes',rows:'6','data-action':'np-notes',
    placeholder:'Posting once a month, wants weekly. Likes the short-form idea. Budget around 800. Decides Friday.'},
    [NOTES_PANEL.notes]));

  var acts = h('div',{class:'np-acts'},[]);
  var ready = !!(NOTES_PANEL.cid && NOTES_PANEL.notes.trim());
  function btn(action, label, cls){
    var b = h('button',{class:'btn btn-sm ' + (cls||''),'data-action':action},[label]);
    if(!ready || NOTES_PANEL.busy) b.disabled = true;
    return b;
  }
  acts.appendChild(btn('np-save','Save to ' + termLower('contact'), 'btn-ghost'));
  acts.appendChild(btn('np-draft-email', NOTES_PANEL.busy ? 'Writing...' : 'Draft an email', 'btn-green'));
  acts.appendChild(btn('np-draft-sms', NOTES_PANEL.busy ? 'Writing...' : 'Draft a text', ''));
  wrap.appendChild(acts);

  if(!NOTES_PANEL.cid){
    wrap.appendChild(h('div',{class:'np-hint'},['Pick someone above to start.']));
  } else if(!NOTES_PANEL.notes.trim()){
    wrap.appendChild(h('div',{class:'np-hint'},['Paste the notes and the buttons wake up.']));
  }

  if(NOTES_PANEL.draft){
    var d = NOTES_PANEL.draft;
    var out = h('div',{class:'np-draft'},[]);
    out.appendChild(h('div',{class:'np-draft-head'},[
      h('strong',{},[d.channel === 'sms' ? 'Drafted text' : 'Drafted email']),
      h('span',{class:'hint'},['Read it before it goes. It was written from your notes, not checked against them.'])
    ]));
    if(d.channel === 'email'){
      out.appendChild(h('input',{type:'text',class:'np-subject','data-action':'np-edit','data-field':'subject',
        value: d.subject, placeholder:'Subject'}));
    }
    out.appendChild(h('textarea',{class:'np-body',rows:'10','data-action':'np-edit','data-field':'text'},[d.text]));

    var foot = h('div',{class:'np-draft-acts'},[]);
    var c = STATE.clients[NOTES_PANEL.cid];
    if(d.channel === 'email' && c && canEmail(c)){
      foot.appendChild(h('a',{class:'btn btn-sm btn-green', target:'_blank', rel:'noopener',
        href: gmailComposeUrl(c.email, d.subject, d.text, businessEmailAccount(STATE)),
        'data-action':'sent-by-email','data-cid':c.id,'data-doc':'notes-draft'},['Open in Gmail']));
    }
    foot.appendChild(h('button',{class:'btn btn-sm','data-action':'np-copy'},['Copy']));
    foot.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'np-discard'},['Discard']));
    out.appendChild(foot);
    wrap.appendChild(out);
  }

  box.appendChild(wrap);
}

function renderEmailLibrary(){
  var box = el('email-library');
  if(!box) return;
  box.innerHTML = '';

  renderNotesPanel(box);

  var docs = emailLibrary(STATE);

  var head = h('div',{class:'lib-head'},[
    h('div',{},[
      h('h3',{},['Your emails']),
      h('span',{class:'hint'},[
        docs.length
          ? docs.length + (docs.length === 1 ? ' email' : ' emails') +
            ' — pick one for any ' + termLower('contact') + ', any time. Nothing here sends by itself.'
          : 'Nowhere to keep a long email yet. Add the ones you already send — the pricing breakdown, the recap, the case study — and label when each one goes out.'
      ])
    ]),
    h('div',{class:'lib-head-actions'},[
      h('button',{class:'btn btn-sm btn-green','data-action':'email-doc-new'},['+ Add an email']),
      h('button',{class:'btn btn-sm btn-ghost','data-action':'email-lib-download',
        title:'Download all of them as a text file'},['Download all'])
    ])
  ]);
  box.appendChild(head);

  // The library could not be read at all — a different thing from an empty
  // one, and worth saying plainly so nobody concludes their emails are gone.
  if(STATE.emailLibraryUnavailable){
    box.appendChild(h('div',{class:'lib-empty'},[
      h('p',{},['Your emails could not be loaded just now. Nothing has been lost, and the rest of Ghost Recall is working normally — everything you do is still being saved.']),
      h('p',{},['If this does not clear up, the email library setup has not finished on the server yet.']),
      h('button',{class:'btn btn-sm','data-action':'reload-app'},['Try again'])
    ]));
    return;
  }

  if(!docs.length){
    // The old stage-keyed emails are the obvious first contents, and a person
    // who wrote them should not have to retype them.
    var hadOld = Object.keys(STATE.emailVariants || {}).some(function(st){
      return (STATE.emailVariants[st] || []).some(function(v){ return !v.builtin && (v.text || '').trim(); });
    });
    if(hadOld){
      box.appendChild(h('div',{class:'lib-empty'},[
        h('p',{},['The emails you wrote against the old five touches are still saved. Bring them in and you can edit them here.']),
        h('button',{class:'btn btn-sm','data-action':'email-lib-import'},['Import my old emails'])
      ]));
    }

    /* An empty tab used to end here, which is the worst moment in the app for
       somebody new: nothing to read, nothing to copy, and no indication of
       what a good entry even looks like. The starters are drafts with gaps
       left in them on purpose, so they teach the shape without pretending to
       be anyone's finished words. */
    box.appendChild(h('div',{class:'lib-empty'},[
      h('p',{},['This is where the long emails live - the ones too big to text. ' +
                'You pick one when you want it. Nothing in here sends on its own.']),
      h('p',{},['If you have not written any yet, start from five common ones and ' +
                'edit them into your own words. Each has gaps in [brackets] only ' +
                'you can fill, and the preview flags them until you do.']),
      h('button',{class:'btn btn-sm btn-green','data-action':'email-lib-starters'},
        ['Start from five common emails']),
      h('div',{class:'lib-hint'},['Or press "+ Add an email" above and write your own from scratch.'])
    ]));
    return;
  }

  docs.forEach(function(d, i){
    var open = LIB_OPEN === d.id;
    var card = h('div',{class:'lib-doc' + (open ? ' open' : '')},[]);

    var titleRow = h('div',{class:'lib-doc-head','data-action':'email-doc-toggle','data-id':d.id},[
      h('div',{class:'lib-doc-title'},[
        h('strong',{},[d.title]),
        h('span',{class:'lib-when'},[d.whenToSend ? 'Send ' + d.whenToSend : 'No timing noted'])
      ]),
      h('div',{class:'lib-doc-meta'},[
        h('span',{class:'lib-len'},[wordCount(d.body) + ' words']),
        h('span',{class:'lib-caret'},[open ? '▾' : '▸'])
      ])
    ]);
    card.appendChild(titleRow);

    if(open){
      var body = h('div',{class:'lib-doc-body'},[]);

      /* Name and timing side by side, then the email itself.

         These were six stacked fields with a paragraph of help under two of
         them, which reads as a form to be filled in rather than a thing to be
         written. The two short ones pair up, their help shrinks to one line,
         and the subject and body -- the only parts that are actually the
         email -- get the room. */
      var meta = h('div',{class:'lib-meta'},[]);
      var nameCol = h('div',{},[
        h('label',{class:'lib-label'},['Name it']),
        h('input',{type:'text',class:'lib-input',
          'data-action':'set-email-doc','data-id':d.id,'data-field':'title',
          value: d.title, placeholder:'e.g. Pricing breakdown'})
      ]);
      var whenCol = h('div',{},[
        h('label',{class:'lib-label'},['When it goes out']),
        h('input',{type:'text',class:'lib-input',
          'data-action':'set-email-doc','data-id':d.id,'data-field':'whenToSend',
          value: d.whenToSend, placeholder:'e.g. after they ask what it costs'})
      ]);
      meta.appendChild(nameCol);
      meta.appendChild(whenCol);
      body.appendChild(meta);
      body.appendChild(h('div',{class:'lib-hint'},[
        'In your own words - this is what you read when picking which to send.'
      ]));

      body.appendChild(h('label',{class:'lib-label'},['Subject line']));
      body.appendChild(h('input',{type:'text',class:'lib-input',
        'data-action':'set-email-doc','data-id':d.id,'data-field':'subject',
        value: d.subject, placeholder:'Subject'}));

      body.appendChild(h('label',{class:'lib-label'},['The email']));
      body.appendChild(h('textarea',{class:'lib-body',rows:'18',
        'data-action':'set-email-doc','data-id':d.id,'data-field':'body',
        placeholder:'Paste or write the whole thing. There is no length limit here — this is the place for the long ones.'},
        [d.body]));

      /* See it exactly as it will arrive, before it goes near anyone.

         The Gmail button opens a draft and sends nothing, but it logs the
         send the moment it is clicked — so clicking it just to look records
         an email that never went. Previewing is a different intent from
         sending and needs its own control, or the data quietly fills with
         sends that did not happen.

         Rendered against a real contact rather than dummy values, because
         the question being asked is "what does {name} become for Caitlin",
         and sample data answers a different question. */
      var pv = h('div',{class:'lib-preview'},[]);
      pv.appendChild(h('label',{class:'lib-label'},['Preview it for someone']));
      var pvSel = h('select',{class:'lib-input','data-action':'lib-preview','data-id':d.id},[]);
      pvSel.appendChild(h('option',{value:''},['Pick a ' + termLower('contact') + ' to preview with...']));
      recentContactsForNotes().forEach(function(pc){
        var o = h('option',{value:pc.id},[pc.name]);
        if(LIB_PREVIEW[d.id] === pc.id) o.selected = true;
        pvSel.appendChild(o);
      });
      pv.appendChild(pvSel);

      var pvClient = STATE.clients[LIB_PREVIEW[d.id]];
      if(pvClient){
        var r = renderEmailDoc(STATE, d.id, pvClient, STATE.senderName);
        if(r){
          var box2 = h('div',{class:'lib-preview-out'},[]);
          box2.appendChild(h('div',{class:'lp-line'},[
            h('span',{class:'lp-k'},['To']), h('span',{},[pvClient.email || '(no email address on file)'])
          ]));
          box2.appendChild(h('div',{class:'lp-line'},[
            h('span',{class:'lp-k'},['From']),
            h('span',{},[businessEmailAccount(STATE) || '(whichever Gmail you last used)'])
          ]));
          box2.appendChild(h('div',{class:'lp-line'},[
            h('span',{class:'lp-k'},['Subject']), h('strong',{},[r.subject || '(no subject)'])
          ]));
          box2.appendChild(h('pre',{class:'lp-body'},[r.text]));
          var leftovers = (r.text + ' ' + r.subject).match(/\{\w+\}|\[[A-Z][^\]]*\]/g);
          if(leftovers){
            box2.appendChild(h('div',{class:'set-warn'},[
              'Still unfilled: ' + leftovers.join(', ') + ' — these would go out exactly as written.'
            ]));
          }
          pv.appendChild(box2);
        }
      }
      body.appendChild(pv);

      var pinRow = h('div',{class:'lib-pinrow'},[
        h('span',{class:'lib-pinlabel'},['Send automatically for'])
      ]);
      var pinSel = h('select',{class:'lib-pin','data-action':'set-email-doc','data-id':d.id,'data-field':'touch'},[]);
      pinSel.appendChild(h('option',{value:''},['nothing - I pick it each time']));
      TOUCH_LIST_ORDER.forEach(function(st){
        var o = h('option',{value:st},[touchLabel(st)]);
        if(d.touch === st) o.selected = true;
        pinSel.appendChild(o);
      });
      pinRow.appendChild(pinSel);
      body.appendChild(pinRow);

      body.appendChild(h('div',{class:'lib-foot'},[
        h('span',{class:'lib-tokens'},[
          'Fills in: {name} {sender} {when} {date} {time} {link}'
        ]),
        h('div',{class:'lib-foot-actions'},[
          /* No per-email Download and no reorder arrows.
             "Download all" covers the real case -- handing the set to someone
             -- and four buttons where one is Delete made the destructive one
             just another grey button in a row. */
          h('button',{class:'btn btn-sm btn-ghost danger','data-action':'email-doc-delete','data-id':d.id},['Delete'])
        ])
      ]));
      card.appendChild(body);
    }
    box.appendChild(card);
  });
}

// Length is the one thing that tells you at a glance which of these is the
// long one, without opening it.
function wordCount(text){
  var t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/* Which email, for this contact.

   The old button had no choice to make: one email per stage, so the stage
   picked it. A library means picking, and picking is why each entry carries a
   plain-English "when to send" note — that line is what this list is for.

   Every row is a real link to Gmail with the email already filled in for this
   contact, from the business account. Same one-click-then-read-then-send flow
   as the texts, which is the part that already works. */
function openEmailPicker(client){
  var docs = emailLibrary(STATE);
  var from = businessEmailAccount(STATE);

  var rows = docs.map(function(d){
    var r = renderEmailDoc(STATE, d.id, client, STATE.senderName);
    if(!r) return '';
    return '<a class="pick-row" target="_blank" rel="noopener"' +
      ' href="' + escapeHtml(gmailComposeUrl(client.email, r.subject, r.text, from)) + '"' +
      ' data-action="sent-by-email" data-cid="' + escapeHtml(client.id) + '"' +
      ' data-doc="' + escapeHtml(d.id) + '">' +
      '<div class="pick-main">' +
        '<strong>' + escapeHtml(d.title) +
          (d.touch ? ' <span class="pick-pin">' + escapeHtml(touchLabel(d.touch)) + '</span>' : '') +
        '</strong>' +
        '<span class="pick-when">' + escapeHtml(d.whenToSend ? 'Send ' + d.whenToSend : 'No timing noted') + '</span>' +
        '<span class="pick-subj">' + escapeHtml(r.subject || '(no subject)') + '</span>' +
      '</div>' +
      '<span class="pick-go">Open in Gmail →</span>' +
    '</a>';
  }).join('');

  var head = '<div class="modal-head"><h2>Email ' + escapeHtml(client.name) + '</h2>' +
    '<button class="btn-ghost btn" data-action="close-modal">✕</button></div>';

  if(!docs.length){
    openModalHtml(head +
      '<p class="hint">There are no emails in your library yet. The Email templates tab is where they live — ' +
      'add the ones you already send and they will show up here for every ' + escapeHtml(termLower('contact')) + '.</p>' +
      '<div class="modal-foot"><button class="btn btn-green" data-action="tab" data-tab="emails">Go to Email templates</button></div>');
    return;
  }

  openModalHtml(head +
    '<p class="hint">Opens in Gmail, filled in for ' + escapeHtml(client.name) + '. Read it, then hit send.' +
    (from ? '' : ' <strong>No business account is set</strong>, so Gmail will use whichever you last signed into.') +
    '</p>' +
    '<div class="pick-list">' + rows + '</div>', true);
}

// The live object in STATE, not the sanitized copy emailLibrary() returns —
// edits have to land on the array that gets saved.
function findEmailDoc(id){
  var list = STATE.emailLibrary || [];
  for(var i = 0; i < list.length; i++){ if(list[i].id === id) return list[i]; }
  return null;
}

// Which library entry is expanded. Only one at a time: these are long, and a
// page of simultaneously-open 18-row textareas is unreadable.
var LIB_OPEN = null;
// Which contact each library entry is being previewed against. Per entry, so
// opening a second email does not silently reuse the first one's choice.
var LIB_PREVIEW = {};

/* Hand the browser a text file.

   A Blob and a synthetic click, because the alternative is a server round
   trip for content that is already sitting in memory. Revoked immediately —
   the object URL pins the whole blob in memory until it is. */
function downloadText(filename, text){
  try{
    var blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 0);
    return true;
  }catch(e){
    console.error('Ghost Recall: download failed', e);
    showToast('Could not start the download.');
    return false;
  }
}


/* The wordings behind a variant's single number.

   A variant key is not a message. On this book every key had carried
   between two and twenty-three different texts, because migrations rewrote
   builtin copy in place and kept the key -- so the row above this one is an
   average over messages that no longer exist.

   This is deliberately NOT a leaderboard. Shown here, the honest finding on
   real data is that no two wordings within a stage are far enough apart to
   call, at these volumes. A ranked list would invite acting on noise, which
   is exactly what happened when a key-level "0 replies in 25 sends" nearly
   got working copy rewritten. So each wording states its own count, and
   anything too thin to judge says so instead of showing a percentage.

   Reads from the message log rather than the counters, because the log is
   what remembers which words were actually sent. */
function buildWordingRows(stage, variantId){
  var rows = wordingBreakdown(STATE).filter(function(r){
    return r.stage === stage && r.variantId === variantId;
  });
  if(rows.length < 2) return null;   // one wording is just the row above

  var box = h('div', {class: 'vp-wordings'}, []);
  box.appendChild(h('div', {class: 'vp-wordings-note'}, [
    rows.length + ' different messages have been sent under this one name. ' +
    'Their numbers were being averaged together.'
  ]));
  rows.forEach(function(r){
    var line = h('div', {class: 'vp-wording' + (r.isCurrent ? ' is-current' : '')}, []);
    line.appendChild(h('span', {class: 'vp-w-rate'}, [
      r.rate === null ? '—' : Math.round(r.rate * 100) + '%'
    ]));
    line.appendChild(h('span', {class: 'vp-w-n'}, [
      r.rate === null
        ? r.replies + '/' + r.sends + ' — too few to judge'
        : r.replies + '/' + r.sends
    ]));
    line.appendChild(h('span', {class: 'vp-w-text'}, [
      (r.isCurrent ? 'in use now · ' : '') + r.sample.slice(0, 90) + (r.sample.length > 90 ? '…' : '')
    ]));
    box.appendChild(line);
  });
  return box;
}

function renderVariantPerformance(){
  var box = el('variant-performance');
  if(!box) return;
  box.innerHTML = '';
  var groups = computeVariantPerformance(STATE, new Date());
  if(!groups.length) return;

  var wrap = h('div',{class:'vp'},[
    h('h3',{},['What actually produces appointments']),
    h('div',{class:'hint'},[
      'Outcomes are credited to the last message sent before the appointment. ' +
      'Variants are only ever compared within a stage: a day-of text is always the last touch for ' +
      'anyone who showed up, so ranking it against a Monday text would measure timing, not copy.'
    ])
  ]);

  var pct = function(x){ return x === null ? '—' : Math.round(x * 100) + '%'; };

  groups.forEach(function(g){
    var stageBox = h('div',{class:'vp-stage'},[]);
    var head = h('h4',{},[g.stage]);
    if(!g.comparable) head.appendChild(h('span',{class:'note'},['   too few appointments yet to compare']));
    stageBox.appendChild(head);

    var table = document.createElement('table');
    table.className = 'vp-table';
    table.innerHTML = '<thead><tr><th>Variant</th><th>Sent</th><th>Reply</th>' +
      '<th>Credited</th><th>Showed</th><th>Closed</th></tr></thead>';
    var tb = document.createElement('tbody');
    g.rows.forEach(function(r){
      var tr = document.createElement('tr');
      tr.className = (!r.enoughData ? 'thin' : '') + (g.leader && g.leader.variantId === r.variantId ? ' leader' : '');
      tr.innerHTML =
        '<td>' + escapeHtml(r.variantId) + '</td>' +
        '<td>' + r.sends + '</td>' +
        '<td>' + pct(r.replyRate) + '</td>' +
        '<td>' + r.credited + '</td>' +
        '<td>' + (r.enoughData ? pct(r.showRate)
          : '<span title="not enough credited appointments to put a rate on">' + r.appointments + ' of ' + r.credited + '</span>') + '</td>' +
        '<td>' + r.closes + '</td>';
      tb.appendChild(tr);

      /* And, underneath, the messages this one row is averaging over.

         A reply rate beside a variant name reads as the rate of a message.
         It is the rate of a NAME, and on this book a name had carried up to
         twenty-three different texts. Putting them under the row is the only
         place the average can be contradicted by the thing it averages. */
      var wordings = buildWordingRows(g.stage, r.variantId);
      if(wordings){
        var wrapRow = document.createElement('tr');
        wrapRow.className = 'vp-wordings-row';
        var cell = document.createElement('td');
        cell.colSpan = 6;
        cell.appendChild(wordings);
        wrapRow.appendChild(cell);
        tb.appendChild(wrapRow);
      }
    });
    table.appendChild(tb);
    stageBox.appendChild(table);
    if(g.leader){
      /* The leader line names a winner, and the winner is a NAME.

         Seen on screen directly above the breakdown it contradicts: the line
         said "m1-v2 leads on appointments" while the rows under it showed
         that name covering three messages at 11%, 33% and 44%. Declaring a
         winner from an average over copy that no longer exists is the whole
         mistake this panel was added to expose, repeated one line down.

         Not removed -- within a single wording it is a fair statement and
         the useful one. Qualified, so it cannot be read as being about a
         message when it is about a label. */
      var leadWordings = wordingBreakdown(STATE).filter(function(r){
        return r.stage === g.stage && r.variantId === g.leader.variantId;
      }).length;
      var lead = h('div',{class:'vp-lead'},[
        '→ ' + g.leader.variantId + ' leads on appointments (' + pct(g.leader.showRate) +
        ' of ' + g.leader.credited + ')'
      ]);
      if(leadWordings > 1){
        lead.appendChild(h('span',{class:'vp-lead-caveat'},[
          ' — but that name covers ' + leadWordings +
          ' different messages, so this is an average, not a winner.'
        ]));
      }
      stageBox.appendChild(lead);
    }
    wrap.appendChild(stageBox);
  });
  box.appendChild(wrap);
}


function renderVariantsTab(){
  var box = el('variant-stage-blocks'); if(!box) return;
  box.innerHTML = '';
  var epsVal = el('epsilon-val'); if(epsVal) epsVal.textContent = Number(STATE.epsilon).toFixed(2);
  var epsSlider = el('epsilon-slider'); if(epsSlider) epsSlider.value = STATE.epsilon;

  Object.keys(STATE.variants).forEach(function(stage){
    var list = STATE.variants[stage];
    var stats = STATE.variantStats[stage] || {};
    var championId = null, championRate = -1;
    list.forEach(function(v){
      // A retired variant cannot be the champion: it is never sent again, so
      // crowning it would point at copy the app has stopped using.
      if(v.retired) return;
      var s = stats[v.id] || {sends:0,responses:0};
      var rate = (s.responses+1)/(s.sends+2);
      if(rate > championRate){ championRate = rate; championId = v.id; }
    });
    var block = document.createElement('div');
    block.className = 'variant-stage-block';
    block.appendChild(h('h3',{},[stage]));

    var hasAnySends = list.some(function(v){ return (stats[v.id]||{}).sends > 0; });
    var chartWrap = document.createElement('div');
    chartWrap.className = 'variant-chart-wrap';
    var canvas = document.createElement('canvas');
    canvas.id = 'variant-chart-' + stage;
    chartWrap.appendChild(canvas);
    block.appendChild(chartWrap);
    if(hasAnySends){
      block.appendChild(h('div',{class:'chart-caption'},['Reply rate by variant — the current champion (blue) is picked more often by the exploration slider below.']));
    } else {
      block.appendChild(h('div',{class:'chart-caption'},['No sends yet for this stage — chart fills in once texts go out.']));
    }

    var table = document.createElement('table');
    table.className = 'variant-table';
    table.innerHTML = '<thead><tr><th>Variant</th><th>Sends</th><th>Replies</th><th>Rate</th></tr></thead>';
    var tbody = document.createElement('tbody');
    list.forEach(function(v){
      var s = stats[v.id] || {sends:0,responses:0};
      var rate = s.sends>0 ? Math.round((s.responses/s.sends)*100)+'%' : '—';
      var tr = document.createElement('tr');
      if(v.retired) tr.className = 'variant-retired';
      var star = v.id===championId && !v.retired ? '<span class="champion">★</span> ' : '';
      var tag = v.retired
        ? ' <em class="v-retired-tag">retired \u2014 replaced, kept for its record</em>'
        : (v.needsChannel ? ' <em style="color:var(--ink-faint)">(needs channel)</em>' : '');
      /* The first cell is built as an element rather than written as a string.

         It used to be innerHTML and then reached back into via tr.firstChild,
         which works in a browser and returns null under the test's DOM stub —
         so the whole render pass threw and five unrelated tests failed. The
         editor below has to be appended to something real either way. */
      var cell = document.createElement('td');
      cell.innerHTML = star + escapeHtml(v.id) + tag
        + '<div class="v-text">' + escapeHtml(v.text) + '</div>';
      tr.appendChild(cell);
      ['' + s.sends, '' + s.responses, rate].forEach(function(val){
        tr.appendChild(h('td',{},[val]));
      });
      /* Rewording a variant, which is not the same as replacing it.

         Offered on live variants only. A retired one is a record of what was
         tried and how it did; editing it would make its numbers describe
         words it never sent. */
      if(!v.retired){
        cell.appendChild(h('button',{class:'v-edit','data-action':'edit-variant',
          'data-stage':stage,'data-id':v.id},['Reword']));
        var editor = h('div',{class:'v-editor hidden','data-editor':stage + '|' + v.id},[]);
        var tx = h('textarea',{class:'v-ta'},[]);
        tx.value = v.text;
        editor.appendChild(tx);
        /* Say which of the two things saving will do, BEFORE it happens.

           With sends on the clock the text is forked and this one retires, so
           the new wording starts from zero rather than inheriting a reply rate
           it did not earn. With nothing sent yet there is nothing to protect
           and the text is simply replaced. Both are reasonable; being
           surprised by either is not. */
        editor.appendChild(h('div',{class:'v-editor-note'},[
          s.sends > 0
            ? 'This one has ' + s.sends + ' reviewed send' + (s.sends === 1 ? '' : 's')
              + '. Saving starts the new wording from zero and retires this '
              + 'version, so its reply rate stays attached to the words that '
              + 'earned it.'
            : 'Nothing has been sent with this one yet, so the wording is just replaced.'
        ]));
        editor.appendChild(h('div',{class:'v-editor-acts'},[
          h('button',{class:'btn btn-sm btn-green','data-action':'save-variant',
            'data-stage':stage,'data-id':v.id},[s.sends > 0 ? 'Save as new wording' : 'Save']),
          h('button',{class:'btn btn-sm btn-ghost','data-action':'cancel-variant',
            'data-stage':stage,'data-id':v.id},['Cancel'])
        ]));
        cell.appendChild(editor);
        /* Stopping one without rewording it. The pair a person actually
           needs when the shipped copy is for a different job than theirs:
           write your own, stop the ones that do not fit. */
        cell.appendChild(h('button',{class:'v-edit v-stop','data-action':'retire-variant',
          'data-stage':stage,'data-id':v.id,'data-want':'1',
          title:'Stop sending this one. It keeps its record and can come back.'},
          ['Stop using']));
      } else {
        cell.appendChild(h('button',{class:'v-edit','data-action':'retire-variant',
          'data-stage':stage,'data-id':v.id,'data-want':'0',
          title:'Start sending this one again'},['Use again']));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    block.appendChild(table);

    var addRow = document.createElement('div');
    addRow.className = 'add-variant-row';
    var input = h('input',{type:'text',placeholder:'Add your own ' + stage + ' variant… use {name} {date} {time} {weekday} {link} {channel}','data-stage-input':stage});
    var addBtn = h('button',{class:'btn btn-sm','data-action':'add-variant','data-stage':stage},['Add']);
    addRow.appendChild(input); addRow.appendChild(addBtn);
    block.appendChild(addRow);

    box.appendChild(block);
    renderVariantBarChart(stage, list, stats, championId);
  });
}


// Emphasis form: the champion carries the one accent color, every other variant
// is de-emphasized gray — magnitude (reply rate) is the story, not identity.
function renderVariantBarChart(stage, list, stats, championId){
  var canvas = el('variant-chart-' + stage);
  if(!canvas || typeof Chart === 'undefined') return;
  var key = 'variant-' + stage;
  if(chartInstances[key]){ try{ chartInstances[key].destroy(); }catch(e){} }
  // Retired variants are left off the chart. The table keeps them, because
  // that is the record; the chart is "what should I send", and the answer
  // never includes something that will not be sent.
  list = list.filter(function(v){ return !v.retired; });
  var sorted = list.slice().sort(function(a,b){
    var sa = stats[a.id]||{sends:0,responses:0}, sb = stats[b.id]||{sends:0,responses:0};
    var ra = (sa.responses+1)/(sa.sends+2), rb = (sb.responses+1)/(sb.sends+2);
    return rb - ra;
  });
  var labels = sorted.map(function(v){ return v.id + (v.id===championId ? ' ★' : ''); });
  var values = sorted.map(function(v){ var s = stats[v.id]||{sends:0,responses:0}; return s.sends>0 ? Math.round((s.responses/s.sends)*100) : 0; });
  var champColor = cssVar('--chart-1'), mutedColor = cssVar('--chart-muted');
  var colors = sorted.map(function(v){ return v.id===championId ? champColor : mutedColor; });
  chartInstances[key] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderRadius:4, maxBarThickness:22, borderSkipped:false }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero:true, max:100, grid:{color: cssVar('--chart-grid'), drawTicks:false}, ticks:{callback:function(v){ return v+'%'; }, color: cssVar('--ink-faint')} },
        y: { grid:{display:false}, ticks:{color: cssVar('--ink-soft'), font:{weight:'600'}} }
      },
      plugins: {
        legend: {display:false},
        tooltip: {
          callbacks: {
            label: function(ctx){
              var v = sorted[ctx.dataIndex];
              var s = stats[v.id]||{sends:0,responses:0};
              var suffix = s.sends>0 && s.sends<5 ? ' (small sample)' : '';
              return ctx.formattedValue + '% reply rate — ' + s.sends + ' sent, ' + s.responses + ' replied' + suffix;
            }
          }
        }
      }
    }
  });
}


/* ---- weekly tab ---- */
var chartInstances = {};

// Canvas fillStyle can't resolve CSS custom properties itself — Chart.js needs the
// actual computed color string, so every chart color is read through this.
function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function renderWeeklyTab(){
  renderRescueScorecard();
  renderInsights();
  renderWeeklyCharts();
}

// A funnel is the honest shape of this data: each stage can only lose volume,
// never gain it, so an ordinal light→dark ramp reads the drop-off at a glance.
function renderRescueScorecard(){
  var box = el('rescue-scorecard'); if(!box) return;
  var sc = computeRescueScorecard(STATE);
  box.innerHTML = '<canvas id="rescue-funnel-chart"></canvas>';
  if(typeof Chart === 'undefined') return;
  if(chartInstances['rescue-funnel']){ try{ chartInstances['rescue-funnel'].destroy(); }catch(e){} }
  var canvas = el('rescue-funnel-chart');
  if(!canvas) return;
  var labels = ['Missed calls','Rescue texts sent','Replied','Back on calendar'];
  var values = [sc.missed, sc.rescued, sc.replied, sc.rebooked];
  var colors = [cssVar('--chart-ord-1'), cssVar('--chart-ord-2'), cssVar('--chart-ord-3'), cssVar('--chart-ord-4')];
  chartInstances['rescue-funnel'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderRadius:4, maxBarThickness:30, borderSkipped:false }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero:true, ticks:{precision:0, color: cssVar('--ink-faint')}, grid:{color: cssVar('--chart-grid'), drawTicks:false} },
        y: { grid:{display:false}, ticks:{color: cssVar('--ink-soft'), font:{weight:'600'}} }
      },
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:function(ctx){ return ctx.formattedValue; } } } }
    }
  });
}

function renderInsights(){
  var box = el('insights-panel'); if(!box) return;
  var insights = computeInsights(STATE);
  box.innerHTML = '';
  if(!insights) return;
  var block = document.createElement('div');
  block.className = 'chart-block';
  block.appendChild(h('h3',{},['Insights']));
  var ul = document.createElement('ul');
  ul.className = 'insight-list';
  insights.forEach(function(i){
    var li = document.createElement('li');
    li.textContent = i.text;

    ul.appendChild(li);
  });
  block.appendChild(ul);
  box.appendChild(block);
}

function renderWeeklyCharts(){
  var box = el('weekly-charts'); if(!box) return;
  if(typeof Chart === 'undefined') return;
  box.innerHTML = '';
  // Fixed order, never cycled by rank — slot 1 is always the same hue across
  // every chart in the app, whichever variant happens to occupy it this week.
  var seriesColors = [cssVar('--chart-1'), cssVar('--chart-2'), cssVar('--chart-3'), cssVar('--chart-4')];
  var mutedColor = cssVar('--chart-muted');
  Object.keys(STATE.variants).forEach(function(stage){
    var block = document.createElement('div');
    block.className = 'chart-block';
    block.appendChild(h('h3',{},['Reply rate by week — ' + stage]));

    var weekKeys = [];
    var perVariantWeek = {};
    STATE.variants[stage].forEach(function(v){ perVariantWeek[v.id] = {}; });
    Object.keys(STATE.clients).forEach(function(cid){
      STATE.clients[cid].messageLog.forEach(function(m){
        if(m.stage !== stage) return;
        var wk = isoWeekLabel(m.sentAt);
        if(weekKeys.indexOf(wk) === -1) weekKeys.push(wk);
        if(!perVariantWeek[m.variantId]) perVariantWeek[m.variantId] = {};
        if(!perVariantWeek[m.variantId][wk]) perVariantWeek[m.variantId][wk] = {sends:0,responses:0};
        perVariantWeek[m.variantId][wk].sends++;
        if(m.responded) perVariantWeek[m.variantId][wk].responses++;
      });
    });
    weekKeys.sort();

    if(!weekKeys.length){
      block.appendChild(h('div',{class:'chart-caption'},['No texts sent yet for this stage — the trend line fills in week by week once they go out.']));
      box.appendChild(block);
      return;
    }

    var canvas = document.createElement('canvas');
    canvas.id = 'chart-' + stage;
    block.appendChild(canvas);
    box.appendChild(block);

    var datasets = Object.keys(perVariantWeek).map(function(vid, idx){
      var color = idx < seriesColors.length ? seriesColors[idx] : mutedColor;
      return {
        label: vid,
        data: weekKeys.map(function(wk){ var w = perVariantWeek[vid][wk]; return w && w.sends ? Math.round((w.responses/w.sends)*100) : null; }),
        borderColor: color,
        backgroundColor: color + '1a', // ~10% opacity wash under the line, not a saturated block
        pointBackgroundColor: color,
        pointBorderColor: cssVar('--card'),
        pointBorderWidth: 2,
        pointRadius: 4,
        borderWidth: 2,
        fill: true,
        spanGaps: true,
        tension: 0.25
      };
    });
    if(chartInstances[stage]) { try{ chartInstances[stage].destroy(); }catch(e){} }
    chartInstances[stage] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {labels: weekKeys, datasets: datasets},
      options: {
        responsive:true,
        maintainAspectRatio:false,
        interaction: {mode:'index', intersect:false},
        scales:{
          y:{beginAtZero:true, max:100, grid:{color: cssVar('--chart-grid'), drawTicks:false}, ticks:{callback:function(v){return v+'%';}, color: cssVar('--ink-faint')}},
          x:{grid:{display:false}, ticks:{color: cssVar('--ink-faint')}}
        },
        plugins:{
          legend:{display: datasets.length > 1, position:'bottom', labels:{color: cssVar('--ink-soft'), usePointStyle:true, boxWidth:8}},
          tooltip:{mode:'index', intersect:false}
        }
      }
    });
  });
}

/* The Calendar printed a bare toLocaleTimeString with no timeZone, so it
   read the BROWSER's clock while Today read the client's -- the same call
   showing 2:00 PM on one screen and 4:00 PM on the other, neither labelled.
   Both are appointmentTimeLabel now. */
function calEventLabel(c){
  return appointmentTimeLabel(c.callDateTime, c.timezone, viewerTimezone()).mine + ' ' + c.name;
}


// The three outcomes actually worth logging at a glance right after a call —
// mirrors the reply-tracking quick-toggle: no need to open the full client
// modal just to record what happened.
function quickOutcomeButtonsHtml(clientId){
  return '<div class="cal-quick-outcome">' +
    ['Showed','No-show','Ghosted'].map(function(label){
      return '<button class="cal-qo-btn" data-action="set-outcome-quick" data-cid="'+clientId+'" data-status="'+label+'">'+label+'</button>';
    }).join('') +
    '</div>';
}


function renderCalendarTab(){
  var box = el('calendar-body'); if(!box) return;
  var byDay = getCallsByLocalDay(STATE);
  var titleEl = el('cal-title');
  if(UI.calendarView === 'week'){
    if(titleEl) titleEl.textContent = weekRangeLabel(UI.calendarAnchor);
    renderCalendarWeek(box, byDay);
  } else {
    if(titleEl) titleEl.textContent = UI.calendarAnchor.toLocaleDateString('en-US',{month:'long', year:'numeric'});
    renderCalendarMonth(box, byDay);
  }
}


function renderCalendarMonth(box, byDay){
  var anchor = UI.calendarAnchor;
  var gridStart = startOfLocalWeekDate(startOfMonth(anchor));
  var today = new Date();
  var html = '<div class="cal-scroll"><div class="cal-grid">';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d){ html += '<div class="cal-dow">'+d+'</div>'; });
  for(var i=0; i<42; i++){
    var day = addDays(gridStart, i);
    var key = localDayKey(day);
    var events = byDay[key] || [];
    var isOtherMonth = day.getMonth() !== anchor.getMonth();
    var isToday = isSameLocalDay(day, today);
    html += '<div class="cal-cell'+(isOtherMonth?' other-month':'')+(isToday?' today':'')+'">';
    html += '<div class="cal-date">'+day.getDate()+'</div>';
    var shown = events.slice(0,3);
    shown.forEach(function(c){
      html += '<div class="cal-chip st-'+c.status+'" data-action="open-client" data-cid="'+c.id+'" title="'+escapeHtml(c.name)+' · '+c.status+'">'+escapeHtml(calEventLabel(c))+'</div>';
    });
    if(events.length > 3){
      html += '<button class="cal-more" data-action="cal-view-day" data-day="'+key+'">+'+(events.length-3)+' more</button>';
    }
    html += '</div>';
  }
  html += '</div></div>';
  box.innerHTML = html;
}


function renderCalendarWeek(box, byDay){
  var start = startOfLocalWeekDate(UI.calendarAnchor);
  var today = new Date();
  var html = '<div class="cal-scroll"><div class="cal-week-grid">';
  for(var i=0; i<7; i++){
    var day = addDays(start, i);
    var key = localDayKey(day);
    var events = byDay[key] || [];
    var isToday = isSameLocalDay(day, today);
    html += '<div class="cal-week-day'+(isToday?' today':'')+'">';
    html += '<div class="cal-date">'+day.toLocaleDateString('en-US',{weekday:'short', day:'numeric'})+'</div>';
    if(!events.length) html += '<div class="empty-note">No calls.</div>';
    events.forEach(function(c){
      html += '<div class="cal-week-event st-'+c.status+'">' +
        '<div data-action="open-client" data-cid="'+c.id+'" style="cursor:pointer;">' +
        '<span class="t">'+escapeHtml(appointmentTimeLabel(c.callDateTime, c.timezone, viewerTimezone()).mine)+'</span> · '+escapeHtml(c.name) +
        '<div class="status-pill st-'+c.status+'" style="display:inline-block;margin-left:5px;">'+statusLabel(c.status)+'</div></div>' +
        quickOutcomeButtonsHtml(c.id) +
        '</div>';
    });
    html += '</div>';
  }
  html += '</div></div>';
  box.innerHTML = html;
}


var openDayListKey = null; // lets a quick-outcome click refresh the day list in place instead of just closing it


function openDayListModal(dayKey){
  openDayListKey = dayKey;
  var byDay = getCallsByLocalDay(STATE);
  var events = byDay[dayKey] || [];
  var dateLabel = new Date(dayKey+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});
  var rows = events.map(function(c){
    return '<div class="cal-day-list-event">' +
      '<div data-action="open-client" data-cid="'+c.id+'" style="cursor:pointer;">' +
      '<strong>'+escapeHtml(appointmentTimeLabel(c.callDateTime, c.timezone, viewerTimezone()).mine)+'</strong> · '+escapeHtml(c.name) +
      ' <span class="status-pill st-'+c.status+'">'+statusLabel(c.status)+'</span></div>' +
      quickOutcomeButtonsHtml(c.id) +
      '</div>';
  }).join('') || '<div class="empty-note">No calls.</div>';
  openModalHtml(
    '<div class="modal-head"><h2>'+dateLabel+'</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' + rows
  );
}


function populatePrintSheet(state){
  var now = new Date();
  el('print-date').textContent = fmtDate(now,'UTC') + ' ' + now.getFullYear();
  var callsBody = document.querySelector('#print-calls-table tbody');
  callsBody.innerHTML = '';
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    if(c.ignored || !c.callDateTime) return;
    var d = safeDate(c.callDateTime);
    if(!d || tzDateKey(d,c.timezone) !== tzDateKey(now,c.timezone)) return;
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>'+escapeHtml(appointmentTimeLabel(c.callDateTime, c.timezone, viewerTimezone()).text)+'</td><td>'+escapeHtml(c.name)+'</td><td>'+escapeHtml(c.phone)+'</td><td>&nbsp;</td>';
    callsBody.appendChild(tr);
  });
  var touchesBody = document.querySelector('#print-touches-table tbody');
  touchesBody.innerHTML = '';
  getTextTodayList(state, now, '').forEach(function(it){
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>☐</td><td>'+escapeHtml(it.client.name)+'</td><td>'+it.stage+'</td>';
    touchesBody.appendChild(tr);
  });
  var todosBody = document.querySelector('#print-todos-table tbody');
  todosBody.innerHTML = '';
  state.todos.filter(function(t){return !t.done;}).forEach(function(t){
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>☐</td><td>'+escapeHtml(t.text)+'</td>';
    todosBody.appendChild(tr);
  });
}


/* ============================================================
   10.5) AI DRAFTING (Gemini, via server-side proxy)
   The prompt is built here client-side (client notes/recap/voice-example
   data is already loaded here, none of it secret) — the gemini-draft Edge
   Function's only job is to hold the real API key and make the call, so it
   never ships to the browser. Requires the caller to be a real signed-in
   user (verified server-side), not just anyone holding the public anon key.
   ============================================================ */

function buildAIPrompt(client, stage){
  var sender = STATE.senderName || 'the sender';
  /* voiceExamples, not eligibleVariants.

     eligibleVariants gives a person's own wording exactly the same billing as
     the starter templates, so somebody who had written their own copy still
     got drafts in the stock voice -- outvoted in their own account. This puts
     their writing first and says, below, that it is theirs. */
  var voice = voiceExamples(STATE, stage, client, sender);
  var samples = voice.examples.map(function(e){ return e.text; });
  var callDate = safeDate(client.callDateTime);
  var tz = client.timezone || 'America/New_York';
  var lines = [
    /* No claim about what business this is.

       This used to say "a real estate YouTube coach" — true of exactly one
       account. Every other business's AI drafts were written as if they
       coached realtors on YouTube, so a plumber asking for a follow-up text
       got one pitching video strategy. Same mistake as the calendar filter:
       the first customer's details hard-coded as everyone's.

       The example messages already carry the business, the voice AND the
       industry, far more accurately than a label could — they are the
       business's own texts for this exact stage. Describing the industry on
       top of them added nothing even for the account it was true of. */
    'You are drafting a single SMS text message for ' + sender + ', to send to a ' +
      termLower('contact') + ' named ' + firstName(client.name) + '.',
    voice.own
      ? 'Match ' + sender + '\'s real texting voice exactly. The examples marked (their own wording) were written by ' + sender + ' personally \u2014 copy their rhythm, their punctuation and their level of formality from those above all else. The unmarked ones are stock templates: use them only to understand what this kind of message is for, never as a model for how ' + sender + ' writes.'
      : 'Match ' + sender + '\'s real texting voice exactly, shown in these example messages they actually send for this same stage ("' + stage + '"):',
    voice.examples.map(function(e){
      return '- "' + e.text + '"' + (voice.own && e.mine ? '  (their own wording)' : '');
    }).join('\n'),
    'Casual, warm, short — texting voice, not email or ad copy. No corporate phrasing, no emoji unless the examples use them, no signing off with their name unless the examples do.',
    'Infer what this business does from the examples. Never invent a service, industry or claim that is not in them.',
  ];
  if(callDate) lines.push('Their call is on ' + fmtDate(callDate, tz) + ' at ' + fmtTime(callDate, tz) + '.');
  if(client.notes) lines.push('Notes ' + sender + ' has on this ' + termLower('contact') + ': ' + client.notes);
  if(client.recap) lines.push('Recap from a prior call with them: ' + client.recap);

  /* Three rules the drafts kept breaking, each taken from a real one.

     A text that went out read: "I heard you mention you volunteer. I am
     assuming this is with an organization within your town you work with id
     love to hear more and answer your question based on that."

     Three faults in one message. It SPECULATED — "I am assuming this is with
     an organization within your town" is invented from a one-line note, and a
     guess stated as fact is read by the customer as a claim. It ran two
     sentences together with no full stop and wrote "id" for "I'd". And it was
     sixty words, which is an email arriving on a lock screen.

     The notes-based drafting added the first of these when it was written;
     this one never had it. */
  lines.push('Use only what the notes actually say. Do not speculate about them, do not guess at what they meant, and never write a sentence beginning "I am assuming" or "it sounds like" — a guess stated as fact reads to them as a claim. If the notes are thin, write less.');
  lines.push('Complete sentences with full stops and apostrophes. Not "id" or "ill" or "wont".');
  lines.push('Under 45 words. It is read on a lock screen.');
  lines.push('Write ONE replacement text message personalized using those notes/recap where it naturally fits. Output ONLY the message text itself — no quotes, no preamble, no explanation.');
  return lines.join('\n\n');
}

function callGemini(prompt){
  return window.GB_SUPABASE.functions.invoke('gemini-draft', {body: {prompt: prompt}}).then(function(res){
    if(res.error) throw new Error('Gemini request failed — ' + res.error.message);
    var text = res.data && res.data.text;
    if(!text) throw new Error(res.data && res.data.error || 'Gemini returned an empty response');
    return text;
  });
}

function generateAIMessage(cid, stage, btn){
  var client = STATE.clients[cid];
  if(!client) return;
  var originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  callGemini(buildAIPrompt(client, stage)).then(function(text){
    editedTextCache[cid + '|' + stage] = text;
    /* Both surfaces, because this is now reachable from either. Rendering
       only the morning list left the draft invisible to somebody who asked
       for it from inside a conversation -- the button would appear to do
       nothing. */
    renderCallsBoard();
    if(UI.tab === 'threads') renderThreadsTab();
    showToast('AI draft ready — review before sending.');
  }).catch(function(e){
    btn.disabled = false;
    btn.textContent = originalLabel;
    showToast('Could not generate a draft — ' + e.message);
  });
}


/* ============================================================
   11) TOASTS
   ============================================================ */

function showToast(message, undoJson){
  var box = el('toast-container'); if(!box) return;
  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.appendChild(h('span',{},[message]));
  if(undoJson){
    var btn = h('button',{'data-action':'undo-toast'},['UNDO']);
    btn.__undoJson = undoJson;
    toast.appendChild(btn);
  }
  box.appendChild(toast);
  setTimeout(function(){ if(toast.parentNode) toast.parentNode.removeChild(toast); }, 6000);
}


/* ============================================================
   12) MODALS
   ============================================================ */

/* Applying one edited field from the client modal, from either of the two
   places that need to: the change event, and the moment the modal closes.

   Returns whether anything was actually written, so a close that changed
   nothing does not trigger a render. */
function applyClientFieldEdit(t){
  if(!t || !t.getAttribute) return false;
  var cid = t.getAttribute('data-cid'), field = t.getAttribute('data-field');
  var c = STATE && STATE.clients && STATE.clients[cid];
  if(!c || !field) return false;
  var next = (field === 'callDateTime')
    ? (t.value ? parseDatetimeLocalInTZ(t.value, c.timezone || 'America/New_York') : null)
    : t.value;
  /* Nothing to write. Without this, closing a modal nobody edited would save
     the whole account and re-render for no reason. */
  if((c[field] == null ? '' : c[field]) === (next == null ? '' : next)) return false;
  c[field] = next;
  // Picking a zone by hand is a deliberate correction — flag it so the
  // area-code guess stops overriding it on every load.
  if(field === 'timezone') c.timezoneConfirmed = true;
  /* Same reason as the zone above: a derived value somebody corrected by
     hand has to survive the next sync, or they fix it, watch it stick,
     and find it reverted days later. */
  if(field === 'name') c.nameConfirmed = true;
  saveState(STATE);
  return true;
}

/* Everything typed in the modal, committed before the modal is destroyed.

   The fields save on 'change', which for a text input fires on BLUR. closeModal
   wipes modal-root's innerHTML, so a field still holding focus is removed from
   the document and the change event never fires at all. Escape, the close
   button and a click on the overlay all arrive this way.

   Johnny added a phone number to a client with a call the next afternoon, and
   it was silently discarded: typed, looked saved, gone after a reload, with no
   error anywhere. The contact had no other number, so the reminder that
   protects the show-up rate would not have gone out.

   Reading the values back off the DOM rather than trusting a focus check: a
   field edited and then tabbed past is already committed and compares equal,
   so this costs nothing and catches every field rather than only the focused
   one. */
function flushOpenClientFields(){
  var root = el('modal-root');
  if(!root || !root.querySelectorAll) return false;
  var wrote = false;
  Array.prototype.forEach.call(
    root.querySelectorAll('[data-action="save-client-field"]'),
    function(t){ if(applyClientFieldEdit(t)) wrote = true; });
  return wrote;
}

function closeModal(){
  var wrote = flushOpenClientFields();
  el('modal-root').innerHTML = '';
  openDayListKey = null;
  if(wrote) renderAll();
}

function openModalHtml(innerHtml, wide){
  el('modal-root').innerHTML = '<div class="modal-overlay" data-action="overlay-close"><div class="modal' + (wide?' modal-wide':'') + '" data-stop-close="1">' + innerHtml + '</div></div>';
}


function openAddClientModal(){
  openModalHtml(
    '<div class="modal-head"><h2>Add client</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
    '<div class="field-row"><label>Name</label><input id="f-name" type="text"></div>' +
    '<div class="two-col">' +
      '<div class="field-row"><label>Phone</label><input id="f-phone" type="text" placeholder="(555) 555-5555"></div>' +
      '<div class="field-row"><label>Email</label><input id="f-email" type="text"></div>' +
    '</div>' +
    '<div class="two-col">' +
      '<div class="field-row"><label>Call date &amp; time</label><input id="f-call" type="datetime-local"></div>' +
      '<div class="field-row"><label>Booked date</label><input id="f-booked" type="datetime-local"></div>' +
    '</div>' +
    '<div class="two-col">' +
      '<div class="field-row"><label>YouTube link</label><input id="f-yt" type="text" placeholder="https://youtube.com/@handle"></div>' +
      '<div class="field-row"><label>Meet / call link</label><input id="f-meet" type="text"></div>' +
    '</div>' +
    '<div class="field-row"><label>Client\'s timezone <span style="text-transform:none;font-weight:400;color:var(--ink-faint);">— guessed from phone once entered; texts and the local-time chip use this</span></label>' + timezoneSelectHtml('f-tz', '', 'America/New_York') + '</div>' +
    '<div class="field-row"><label>Notes</label><textarea id="f-notes"></textarea></div>' +
    '<button class="btn btn-primary" data-action="save-add-client">Add client</button>'
  );
}


/* Every email, one button each, on the contact itself.

   "I just booked Caitlin, send her the before-call email" is one thought, and
   it was four actions: find her, open the picker, read the list, choose. A
   button per email collapses that to one — the same shape as the text side,
   where the message is already written and you press send.

   This replaces picking for the common case rather than adding to it: the
   library IS the list of buttons, so a new email appears here the moment it
   is written, and nothing has to be configured to connect the two.

   Each button is a real Gmail link, filled in for this contact and pinned to
   the business account, and logs the send the same way everything else does. */
function emailButtonsHtml(c){
  if(!canEmail(c)){
    return '<div class="field-row"><label>Send an email</label>' +
      '<div class="hint">No email address on file for ' + escapeHtml(c.name) +
      ', so there is nothing to send to. Add one above.</div></div>';
  }
  var docs = emailLibrary(STATE);
  if(!docs.length){
    return '<div class="field-row"><label>Send an email</label>' +
      '<div class="hint">Nothing in your library yet. The Email templates tab is where they live.</div></div>';
  }
  var from = businessEmailAccount(STATE);
  var btns = docs.map(function(d){
    var r = renderEmailDoc(STATE, d.id, c, STATE.senderName);
    if(!r) return '';
    // title carries the timing note, so hovering answers "is this the right
    // one?" without opening anything.
    return '<a class="ce-btn" target="_blank" rel="noopener"' +
      ' href="' + escapeHtml(gmailComposeUrl(c.email, r.subject, r.text, from)) + '"' +
      ' data-action="sent-by-email" data-cid="' + escapeHtml(c.id) + '"' +
      ' data-doc="' + escapeHtml(d.id) + '"' +
      ' title="' + escapeHtml(d.whenToSend ? 'Send ' + d.whenToSend : d.subject || d.title) + '">' +
      escapeHtml(d.title) + '</a>';
  }).join('');

  return '<div class="field-row"><label>Send an email</label>' +
    '<div class="ce-btns">' + btns + '</div>' +
    '<div class="hint">Opens Gmail' + (from ? ' as ' + escapeHtml(from) : '') +
    ', written for ' + escapeHtml(firstName(c.name)) + '. Read it, then send.</div></div>';
}

function openClientModal(clientId){
  var c = STATE.clients[clientId];
  if(!c) return;
  var d = safeDate(c.callDateTime);
  var callVal = d ? formatDatetimeLocalInTZ(d, c.timezone || 'America/New_York') : '';
  // The message log is now one strand of the timeline rather than its own
  // list with its own reply checkbox — the reply question is asked once, in
  // Ghost Recall Today. Text bodies stay here because this is the one place
  // someone goes to read what was actually said.
  /* Both halves of the conversation, not just ours.

     This list used to render c.messageLog alone -- everything we sent, and
     nothing they said back. The comment above still describes it as the one
     place to read what was actually said, which it could not do while the
     replies were missing. conversationThread merges the two by time. */
  var thread = conversationThread(c);
  var msgLog = thread.map(function(it){
    if(it.dir === 'in'){
      return '<div class="msg-log-item msg-in"><div class="meta">' +
        escapeHtml(firstName(c.name)) + ' replied · ' +
        new Date(it.at).toLocaleString() +
        '</div>' + escapeHtml(it.text) + '</div>';
    }
    var m = c.messageLog[it.idx] || {};
    /* Delivery state only when the provider told us something. On the sms:
       handoff there is no receipt at all, and printing "sent" there would
       claim knowledge we do not have. */
    /* Say only what an event supports.

       This printed the raw status, and nothing at all when there was none, so
       a draft handed to the Messages app looked identical to a text a carrier
       confirmed delivering. deliveryState draws that line: what a provider or
       the Mac agent confirmed reads plainly, what we merely handed over says
       so. */
    var ds = deliveryState(it);
    var delivery = ds.label
      ? ' · <span class="' + (ds.confirmed ? 'dlv-ok' : 'dlv-unsure') + '">' +
        escapeHtml(ds.label) + '</span>'
      : '';
    return '<div class="msg-log-item msg-out"><div class="meta">' + escapeHtml(it.stage) + ' · ' +
      escapeHtml(it.variantId || '') + ' · ' + new Date(it.at).toLocaleString() + ' · ' +
      escapeHtml(interactionLabel({state: messageState(m, new Date()), hoursAgo: null})) + delivery +
      '</div>' + escapeHtml(it.text) + '</div>';
  }).join('') || '<div style="color:var(--ink-faint);font-size:12px;">No messages sent yet.</div>';

  var outcomeButtons = ['Booked','Confirmed','Showed','Rescheduled','No-show','Ghosted'].map(function(o){
    return '<button class="btn btn-sm' + ((OUTCOME_TO_STATUS[o]===c.status)?' btn-primary':'') + '" data-action="set-outcome" data-cid="'+c.id+'" data-status="'+o+'">'+o+'</button>';
  }).join('');

  openModalHtml(
    '<div class="modal-head"><h2>' + escapeHtml(c.name) + '</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
    /* What the booking is actually called in the calendar.

       Only when there is one. Every row imported before titles were kept
       stores null, and printing an empty line for those would suggest the
       event had no title rather than that we never recorded it. */
    (c.eventTitle
      ? '<div class="ev-title" title="The calendar event this came from">' +
        escapeHtml(c.eventTitle) + '</div>'
      : '') +
    /* Who this is. Derived from somebody else's calendar entry, wrong often
       enough to need correcting, and until now the one thing on this screen
       that could not be. "Unknown" renders as "Hey there," in every message
       the person receives. */
    '<div class="field-row"><label>Name' +
      (c.name === 'Unknown'
        ? ' <span style="text-transform:none;font-weight:400;color:var(--ink-faint);">' +
          '\u2014 the calendar did not say, so messages open "Hey there"</span>'
        : '') +
    '</label><input id="cf-name" data-action="save-client-field" data-cid="' + c.id +
      '" data-field="name" type="text" value="' + escapeHtml(c.name) + '"></div>' +
    '<div class="two-col">' +
      '<div class="field-row"><label>Call date &amp; time <span style="text-transform:none;font-weight:400;color:var(--ink-faint);">(' + escapeHtml(c.timezone||'America/New_York') + ')</span></label><input id="cf-call" data-action="save-client-field" data-cid="'+c.id+'" data-field="callDateTime" type="datetime-local" value="'+callVal+'"></div>' +
      '<div class="field-row"><label>Phone</label><input id="cf-phone" data-action="save-client-field" data-cid="'+c.id+'" data-field="phone" type="text" value="'+escapeHtml(c.phone)+'"></div>' +
    '</div>' +
    '<div class="field-row"><label>Client\'s timezone <span style="text-transform:none;font-weight:400;color:var(--ink-faint);">— guessed from the phone\'s area code; correct it if you know better (their YouTube channel, a video location, etc.) — texts and the local-time chip use this</span></label>' + timezoneSelectHtml('cf-tz', 'data-action="save-client-field" data-cid="'+c.id+'" data-field="timezone"', c.timezone||'America/New_York') + '</div>' +
    '<div class="field-row"><label>Notes</label><textarea data-action="save-client-field" data-cid="'+c.id+'" data-field="notes">'+escapeHtml(c.notes)+'</textarea></div>' +
    '<div class="field-row"><label>Reschedule count</label><div>' + c.rescheduleCount + '</div></div>' +
    '<div class="field-row"><label>Outcome</label><div class="outcome-btns">' + outcomeButtons + '</div></div>' +
    '<div class="field-row"><label>Call recap</label><textarea data-action="save-client-field" data-cid="'+c.id+'" data-field="recap">'+escapeHtml(c.recap)+'</textarea></div>' +
    emailButtonsHtml(c) +
    '<div class="field-row"><label>Closed?</label><div class="outcome-btns">' +
      '<button class="btn btn-sm' + (c.closeOutcome==='Closed'?' btn-green':'') + '" data-action="set-close" data-cid="'+c.id+'" data-close="Closed">Closed</button>' +
      '<button class="btn btn-sm' + (c.closeOutcome==='Not closed'?' btn-primary':'') + '" data-action="set-close" data-cid="'+c.id+'" data-close="Not closed">Not closed</button>' +
    '</div></div>' +
    '<div class="field-row"><label>Timeline</label><div id="tl-mount" class="timeline"><div class="tl-loading">Loading history…</div></div></div>' +
    '<div class="field-row"><label>Message log</label>' + msgLog + '</div>' +
    /* Replying without leaving the thread.

       The conversation view made replies readable; this makes them
       answerable. Without it, reading "can we push to Friday?" here still
       ends with somebody opening a different app to answer -- and a reply
       sent from there lands outside the thread, which is the invisible-reply
       problem rebuilding itself one message at a time.

       Only on the provider route. Over the sms: handoff there is no number of
       ours to send from, and the reply would come back to a handset. The
       reason is shown rather than the box being silently absent. */
    (function(){
      var rr = smsSendMode(STATE, c);
      if(rr.mode === 'blocked'){
        return '<div class="field-row"><label>Reply</label>' +
          '<div style="color:var(--ink-faint);font-size:12px;">' +
          escapeHtml(firstName(c.name)) + ' replied STOP, so they cannot be texted.</div></div>';
      }
      if(rr.mode !== 'provider'){
        return '<div class="field-row"><label>Reply</label>' +
          '<div style="color:var(--ink-faint);font-size:12px;">' +
          'Replying from here needs your own texting number \u2014 ' + escapeHtml(rr.reason || 'not available yet') +
          '. Until then use Messages from the daily list.</div></div>';
      }
      var win = smsSendWindow(c, new Date());
      if(!win.ok){
        return '<div class="field-row"><label>Reply</label>' +
          '<div style="color:var(--ink-faint);font-size:12px;">Too late to text them \u2014 ' +
          escapeHtml(win.reason) + '. Texting runs 8am\u20139pm their time; opens again in ' +
          win.hoursUntilOpen + ' hour' + (win.hoursUntilOpen === 1 ? '' : 's') + '.</div></div>';
      }
      return '<div class="field-row"><label>Reply</label>' +
        '<textarea id="reply-text" rows="3" placeholder="Write back to ' +
        escapeHtml(firstName(c.name)) + '\u2026"></textarea>' +
        '<div style="margin-top:6px;"><button class="btn btn-sm btn-primary" data-action="send-reply" data-cid="' +
        escapeHtml(c.id) + '">Send reply</button>' +
        '<span class="u-meta" style="margin-left:8px;">Goes out from ' +
        escapeHtml(STATE.smsNumber.phoneNumber) + '</span></div></div>';
    })() +
    '<div class="field-row" style="text-align:right;"><a href="#" class="delete-client-link" data-action="delete-client-quick" data-cid="'+c.id+'" title="Remove this client entirely">Delete client</a></div>',
    true
  );

  // The derived half of the timeline renders immediately from data already in
  // memory; recorded events are fetched after, so a slow or failed events
  // query degrades the timeline rather than delaying the modal.
  renderTimeline(c, []);
  fetchClientEvents(c.id).then(function(events){
    // The modal may have been closed or switched to another contact while the
    // request was in flight — only paint if this one is still on screen.
    var mount = el('tl-mount');
    if(mount && mount.getAttribute('data-cid') === c.id) renderTimeline(c, events);
  });
}


// Icons carry the kind at a glance; the label carries it precisely. Anything
// unrecognised still renders, with a neutral dot, rather than vanishing.
var TIMELINE_ICONS = {
  'contact.created':'✨', 'appointment.scheduled':'📅', 'appointment.rescheduled':'🔁',
  'appointment.booked':'📅', 'message.sent':'💬', 'message.replied':'💚',
  'message.no_reply':'🔇', 'stage.changed':'↗', 'outcome.logged':'✅',
  'interaction.outcome':'✅', 'followup.snoozed':'😴', 'contact.deleted':'🗑'
};

function renderTimeline(client, events){
  var mount = el('tl-mount');
  if(!mount) return;
  mount.setAttribute('data-cid', client.id);
  var entries = buildTimeline(client, events, new Date());
  mount.innerHTML = '';
  if(!entries.length){
    mount.appendChild(h('div',{class:'tl-loading'},['Nothing recorded yet.']));
    return;
  }
  // Newest first: the useful question is almost always "what just happened?"
  entries.slice().reverse().forEach(function(e){
    var when = e.ms ? new Date(e.ms) : null;
    mount.appendChild(h('div',{class:'tl-item' + (e.source === 'derived' ? ' derived' : '')},[
      h('span',{class:'tl-icon'},[TIMELINE_ICONS[e.kind] || '•']),
      h('div',{class:'tl-body'},[
        h('div',{class:'tl-label'},[
          e.label + (e.detail ? '  ·  ' + e.detail : ''),
          /* Who recorded it. An unqualified "Message sent" claims a certainty
             Ghost Recall does not have -- a text is handed to your phone and an
             email opens in Gmail, and neither can be confirmed. The first time
             someone finds a message they never sent recorded as sent, they
             stop trusting the whole log. */
          e.by ? h('span',{class:'tl-by ' + e.by},
            [e.by === 'automatic' ? 'confirmed' : 'you logged this']) : ''
        ]),
        h('div',{class:'tl-when'},[when ? when.toLocaleString() : ''])
      ])
    ]));
  });
}


/* Business settings — what makes Ghost Recall fit a business other than this
   one. Stages, vocabulary and the Ghost Score weights all already persist per
   organization; until now they could only be changed in Postgres, which meant
   the multi-industry claim was true in the data model and false in practice.

   Stages are edited as rows with an explicit role rather than as free text,
   because the role is the part the engine acts on. A stage whose role is
   unset behaves as 'open', which is the safe default but rarely the intended
   one — making it a required choice is cheaper than debugging why a custom
   "Closed Won" never stopped the follow-up cadence. */
var SETTINGS_DRAFT = null;

/* ---- onboarding ----
   A company that signs up today lands in an empty app with no instruction.
   Every setting it needs already exists; nobody tells them to open it. This is
   the difference between software someone can buy and software someone has to
   be walked through.

   Three steps, because that is how many decisions actually matter before the
   app is useful: what kind of business, what they call people, and where their
   appointments come from. Everything else has a defensible default and can be
   changed later in settings.

   Shown when an account has no clients and has never configured anything —
   never for an established account, and never again once dismissed. */
var ONBOARDING = null;

function needsOnboarding(){
  if(!STATE) return false;
  if(localStorage.getItem('gb_onboarded') === '1') return false;
  var hasClients = Object.keys(STATE.clients).length > 0;
  var hasConfig = !!(STATE.pipeline || STATE.terminology);
  return !hasClients && !hasConfig;
}

function startOnboarding(){
  ONBOARDING = {step: 1, industry: null, terminology: null, connected: false};
  renderOnboarding();
}

function finishOnboarding(skipped){
  try{ localStorage.setItem('gb_onboarded', '1'); }catch(e){}
  ONBOARDING = null;
  closeModal();
  renderAll();
  if(skipped) return;

  /* End on what setup actually produced, not on "you're set up".

     The brief's third step is "review the first follow-ups due", and it was
     the missing one -- Finish dropped you into the app with no statement of
     what had happened. That matters most where nothing happened: a calendar
     connected but nothing imported looks identical to a calendar never
     connected, and three people sat in exactly that state for days this week
     without being able to tell which problem they had.

     A panel rather than a toast, because a toast disappears and this is the
     one moment someone is deciding whether the thing works. */
  var setup = describeSetup(STATE, new Date());
  openModalHtml(
    '<div class="modal-head"><h2>' + escapeHtml(setup.headline) + '</h2>' +
    '<button class="btn-ghost btn" data-action="close-modal">\u2715</button></div>' +
    '<p class="hint">' + escapeHtml(setup.detail) + '</p>' +
    '<div class="ob-setup-rows">' +
      '<div class="ob-setup-row"><span>Calendar</span><strong>' +
        (setup.connected ? 'connected' : 'not connected yet') + '</strong></div>' +
      '<div class="ob-setup-row"><span>' + escapeHtml(term('contactPlural')) + '</span><strong>' +
        setup.contacts + '</strong></div>' +
      '<div class="ob-setup-row"><span>Due today</span><strong>' + setup.due + '</strong></div>' +
    '</div>' +
    '<div class="modal-foot" style="text-align:right;margin-top:14px;">' +
      '<button class="btn btn-green" data-action="close-modal">' +
      (setup.due ? 'Start working the list' : 'Got it') + '</button></div>');
}

function renderOnboarding(){
  var o = ONBOARDING;
  if(!o) return;
  var dots = [1,2,3].map(function(n){
    return '<span class="ob-dot' + (n === o.step ? ' active' : (n < o.step ? ' done' : '')) + '"></span>';
  }).join('');

  var bodyHtml = '';
  if(o.step === 1){
    bodyHtml =
      '<h3>What kind of business is this?</h3>' +
      '<p class="ob-sub">This sets up your stages and vocabulary. You can change any of it later.</p>' +
      '<div class="ob-grid">' +
      buildIndustryTemplates().map(function(t){
        return '<button class="ob-card' + (o.industry === t.key ? ' selected' : '') + '" data-action="ob-industry" data-key="' + t.key + '">' +
          '<strong>' + escapeHtml(t.label) + '</strong>' +
          '<span>' + escapeHtml(t.blurb) + '</span></button>';
      }).join('') + '</div>';
  } else if(o.step === 2){
    var terms = o.terminology || buildDefaultTerminology();
    bodyHtml =
      '<h3>What do you call the people you follow up with?</h3>' +
      '<p class="ob-sub">These words appear throughout the app.</p>' +
      '<div class="term-grid">' +
      [['contact','One of them'],['contactPlural','More than one'],
       ['appointment','One appointment'],['appointmentPlural','More than one appointment']
      ].map(function(f){
        return '<div><label>' + f[1] + '</label><input type="text" data-action="ob-term" data-key="' + f[0] + '" value="' + escapeHtml(terms[f[0]]) + '"></div>';
      }).join('') + '</div>';
  } else {
    bodyHtml =
      '<h3>Where do your appointments come from?</h3>' +
      '<p class="ob-sub">Ghost Recall reads your calendar and starts the follow-up sequence automatically. ' +
      'Without it you can still add people by hand.</p>' +
      '<div class="ob-connect">' +
      '<button class="btn btn-primary" data-action="connect-calendar" data-priority="0" data-label="Work">Connect Google Calendar</button>' +
      '<span class="ob-or">or</span>' +
      '<button class="btn" data-action="ob-skip-calendar">I’ll do this later</button>' +
      '</div>';
  }

  var backBtn = o.step > 1 ? '<button class="btn btn-sm btn-ghost" data-action="ob-back">Back</button>' : '';
  var nextLabel = o.step === 3 ? 'Finish' : 'Continue';
  var nextDisabled = (o.step === 1 && !o.industry) ? ' disabled' : '';

  openModalHtml(
    '<div class="ob">' +
      '<div class="ob-head"><span class="ob-dots">' + dots + '</span>' +
        '<button class="btn-ghost btn btn-sm" data-action="ob-skip">Skip setup</button></div>' +
      '<div class="ob-body">' + bodyHtml + '</div>' +
      '<div class="ob-foot">' + backBtn +
        '<span class="spacer"></span>' +
        '<button class="btn btn-primary" data-action="ob-next"' + nextDisabled + '>' + nextLabel + '</button>' +
      '</div>' +
    '</div>', true);
}

function applyOnboarding(){
  var o = ONBOARDING;
  var tpl = o.industry ? industryTemplate(o.industry) : null;
  // A template writes into the same settings an admin edits later, so this is
  // a starting point rather than a mode the account is locked into.
  if(tpl && tpl.pipeline){
    STATE.pipeline = tpl.pipeline;
    setPipeline(tpl.pipeline);
  }
  // A new business has no idea what its booking tool names events, so default
  // to the rule that needs no knowledge to be right. Existing accounts keep
  // whatever they already had.
  if(!STATE.calendarFilter){
    STATE.calendarFilter = {mode:'attendees', include:[], matchDescription:[], exclude:[]};
  }
  var terms = o.terminology || (tpl && tpl.terminology) || null;
  if(terms){
    STATE.terminology = terms;
    setTerminology(terms);
  }
  saveState(STATE);
}


/* The provider-route email composer used to live here.

   It was the other half of the stage-keyed model: pick a touch, pre-fill that
   touch's email template, send it through a provider. Email is a library now,
   and the Email button on a contact opens Gmail with the chosen document
   already filled in — so this had no way in. Nothing rendered a button that
   reached it.

   Removed rather than left hidden: dead code that still reads as a feature is
   worse than no code, because the next person has to work out whether it
   matters. The send-email Edge Function is untouched and still works if a
   provider route is ever wanted again. */

/* The build this browser is actually running.

   Kept in step with the ?v= on the script tags in app.html. Shown at the
   bottom of Business settings so a stale cache can be identified by asking
   rather than inferred from "I still cannot see it". */
var BUILD_STAMP = '20261027-39d14930g';

/* Which settings section to scroll to once the modal is up.

   Null for the ordinary "Business settings" route, which should open at the
   top as it always has. */
var SETTINGS_FOCUS = null;

function openSettingsModal(focusSection){
  SETTINGS_FOCUS = focusSection || null;
  // Edited against a draft, not live state: a half-finished pipeline (a stage
  // mid-rename, a blank row) would otherwise be what computeDue sees on the
  // next render.
  SETTINGS_DRAFT = {
    pipeline: (STATE.pipeline || buildDefaultPipeline()).map(function(st){
      return {key: st.key, label: st.label || st.key, role: st.role || 'open'};
    }),
    terminology: Object.assign(buildDefaultTerminology(), STATE.terminology || {}),
    // Deep-copied: the draft must not alias the live sequence, or removing a
    // step would take effect before anyone pressed Save.
    sequence: JSON.parse(JSON.stringify(STATE.sequence || buildDefaultSequence()))
  };
  renderSettingsModal();
}

var ROLE_HELP = {
  open:    'follow-ups keep running',
  won:     'the appointment happened; cadence stops',
  missed:  'they did not show; rescue sequence starts',
  stalled: 'in limbo; recovery nudges re-fire',
  lost:    'written off; cadence stops'
};

function renderSettingsModal(){
  var d = SETTINGS_DRAFT;
  var stageRows = d.pipeline.map(function(st, i){
    var opts = ['open','won','missed','stalled','lost'].map(function(r){
      return '<option value="'+r+'"'+(st.role===r?' selected':'')+'>'+r+' — '+ROLE_HELP[r]+'</option>';
    }).join('');
    return '<div class="stage-row">' +
      '<span class="grip">'+(i+1)+'</span>' +
      '<input type="text" value="'+escapeHtml(st.label)+'" data-action="set-stage-label" data-idx="'+i+'" placeholder="Stage name">' +
      '<select data-action="set-stage-role" data-idx="'+i+'">'+opts+'</select>' +
      '<button data-action="move-stage" data-idx="'+i+'" data-dir="-1" title="Move up">↑</button>' +
      '<button data-action="move-stage" data-idx="'+i+'" data-dir="1" title="Move down">↓</button>' +
      '<button data-action="remove-stage" data-idx="'+i+'" title="Remove">✕</button>' +
    '</div>';
  }).join('');

  var termFields = [
    ['contact','One contact'], ['contactPlural','Many contacts'],
    ['appointment','One appointment'], ['appointmentPlural','Many appointments'],
    ['graveyard','The Graveyard']
  ].map(function(f){
    return '<div><label>'+f[1]+'</label><input type="text" data-action="set-term" data-key="'+f[0]+'" value="'+escapeHtml(d.terminology[f[0]])+'"></div>';
  }).join('');

  // Renaming a stage rewrites the status on every contact currently sitting on
  // it, so say so before they hit save rather than after.
  var counts = {};
  Object.keys(STATE.clients).forEach(function(cid){
    var st = STATE.clients[cid].status;
    counts[st] = (counts[st] || 0) + 1;
  });
  var current = (STATE.pipeline || buildDefaultPipeline()).map(function(s){ return s.key; });
  var removed = current.filter(function(k){
    return !d.pipeline.some(function(st){ return st.key === k; }) && counts[k];
  });

  openModalHtml(
    '<div class="modal-head"><h2>Business settings</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
    /* Starting from a template, after the first run.

       The nine templates were only ever offered in the onboarding wizard, and
       that wizard never comes back: it is gated on a localStorage flag, so
       anyone who clicked past it could never pick one. That is not
       hypothetical — a sales manager who also runs hiring signed up, skipped
       setup in seven seconds, and had no way to reach the recruiting template
       from anywhere in the product. */
    '<div class="set-section"><h3>Start from a template</h3>' +
    '<div class="hint">Sets the stage names and wording below. Your ' +
      escapeHtml(termLower('contactPlural')) + ' move across by what each stage ' +
      '<em>means</em>, so a finished ' + escapeHtml(termLower('appointment')) +
      ' stays finished even though the stage is called something new.</div>' +
    '<div class="tpl-row">' +
    buildIndustryTemplates().filter(function(t){ return t.key !== 'custom'; })
      .map(function(t){
        return '<button class="btn btn-sm tpl-btn" data-action="use-template" data-key="' +
          escapeHtml(t.key) + '" title="' + escapeHtml(t.blurb) + '">' +
          escapeHtml(t.label) + '</button>';
      }).join('') +
    '</div></div>' +
    '<div class="set-section"><h3>Pipeline stages</h3>' +
    '<div class="hint">The role is what Ghost Recall acts on, not the name — so an HVAC shop can call its won stage “Estimate Completed” and the cadence still stops there.</div>' +
    stageRows +
    '<button class="btn btn-sm" data-action="add-stage">+ Add stage</button>' +
    (removed.length ? '<div class="set-warn">⚠ ' + removed.map(function(k){ return counts[k] + ' contact(s) on “' + escapeHtml(k) + '”'; }).join(', ') +
      ' — removing a stage leaves them on it. Unrecognised stages behave as “open”, so they keep getting followed up rather than disappearing.</div>' : '') +
    '</div>' +
    /* The cadence, editable rather than merely listed.

       It showed each step with a ✕ and a "restore the default" button, so the
       only two things anybody could do were delete a touch and put it back.
       You could not add one, change when one fires, or reorder them -- which
       means "five touches on this rhythm" was effectively the only cadence
       the product had, and every business that wanted four touches on a
       different rhythm was being told to run someone else's playbook.

       The engine has been data-driven and persisted per account for a while;
       what was missing was a way to reach it. The trigger vocabulary is a
       closed set from logic.js, so the form cannot offer a trigger the
       evaluator does not implement -- one that would silently never fire. */
    '<div class="set-section" id="set-cadence"><h3>Follow-up cadence</h3>' +
    '<div class="hint">How many times Ghost Recall chases, and when. ' +
      'Removing a touch stops it firing; its message templates stay put, so ' +
      'nothing is lost if you add it back. Order sets the numbering you see on ' +
      'a card (“touch 2 of 4”) \u2014 when each one fires is set by its timing.</div>' +
    (function(){
      var seq = SETTINGS_DRAFT.sequence || [];
      var runup = [], repeat = [];
      seq.forEach(function(st, i){
        ((st.trigger || {}).type === 'repeat_while_role' ? repeat : runup).push({st: st, i: i});
      });
      var stages = Object.keys(STATE.variants || {});

      var rows = runup.map(function(row, n){
        var st = row.st, i = row.i;
        var choice = cadenceTriggerChoice((st.trigger || {}).type);
        return '<div class="stage-row cad-row">' +
          '<span class="grip" title="Touch ' + (n+1) + '">' + (n+1) + '</span>' +
          '<select data-action="set-step-stage" data-idx="' + i + '" title="Which message this touch sends">' +
            /* touchLabel, not the raw key. This form is where a plumber
               decides how often to chase an estimate, and "midcheckin" is
               our word, not theirs. */
            stages.map(function(sk){
              return '<option value="' + escapeHtml(sk) + '"' +
                (sk === st.stage ? ' selected' : '') + '>' +
                escapeHtml(touchLabel(sk)) + '</option>';
            }).join('') +
          '</select>' +
          '<select data-action="set-step-trigger" data-idx="' + i + '" title="When it fires">' +
            cadenceTriggerChoices().map(function(ch){
              return '<option value="' + ch.type + '"' +
                (choice && ch.type === choice.type ? ' selected' : '') + '>' +
                escapeHtml(ch.label) + '</option>';
            }).join('') +
          '</select>' +
          (choice && choice.param
            ? '<input class="cad-num" type="number" data-action="set-step-param" data-idx="' + i + '"' +
              ' min="' + choice.min + '" max="' + choice.max + '"' +
              ' value="' + escapeHtml(String((st.trigger || {})[choice.param] || choice.dflt)) + '">' +
              '<span class="cad-unit">' + escapeHtml(choice.unit) + '</span>'
            : '<span class="cad-num-gap"></span>') +
          '<button data-action="move-step" data-idx="' + i + '" data-dir="-1"' +
            (n === 0 ? ' disabled' : '') + ' title="Move earlier">\u2191</button>' +
          '<button data-action="move-step" data-idx="' + i + '" data-dir="1"' +
            (n === runup.length - 1 ? ' disabled' : '') + ' title="Move later">\u2193</button>' +
          '<button data-action="remove-step" data-idx="' + i + '" title="Remove this touch">\u2715</button>' +
        '</div>';
      }).join('');

      /* The role-driven steps, with their interval editable and their shape
         not. "Chase a stalled deal every 2 days" is a preference; which roles
         count as stalled, and that cold leads get revived at all, is the
         product -- and the roles/anchor/window fields have no safe form. */
      var repeatRows = repeat.length
        ? '<div class="cad-sub">Rescue and revival \u2014 these keep running on their own</div>' +
          repeat.map(function(row){
            var st = row.st, t = st.trigger || {};
            return '<div class="stage-row cad-row">' +
              '<span class="grip">\u21bb</span>' +
              '<span class="cad-fixed"><strong>' + escapeHtml(touchLabel(st.stage)) + '</strong> \u2014 while ' +
                escapeHtml((t.roles || []).join(' or ')) + '</span>' +
              '<span class="cad-every">every</span>' +
              '<input class="cad-num" type="number" data-action="set-step-every" data-idx="' + row.i + '"' +
                ' min="1" max="365" value="' + escapeHtml(String(t.everyDays || 1)) + '">' +
              '<span class="cad-unit">days</span>' +
              '<button data-action="remove-step" data-idx="' + row.i + '" title="Stop this entirely">\u2715</button>' +
            '</div>';
          }).join('')
        : '';

      var warn = !runup.length
        ? '<div class="set-warn">\u26a0 No touches before the appointment. Nothing will go out ' +
          'until someone misses one or goes quiet.</div>'
        : '';

      return rows + warn +
        '<button class="btn btn-sm" data-action="add-step">+ Add touch</button> ' +
        /* Named after the industry when we can tell, and called "default"
           when we cannot. Saying "recommended" over a fallback would be the
           button quietly telling a roofer the agency rhythm is theirs. */
        '<button class="btn btn-sm" data-action="restore-sequence">' +
          (function(){
            var tpl = industryFromPipeline(SETTINGS_DRAFT.pipeline);
            return tpl && tpl.sequence
              ? 'Reset to the ' + escapeHtml(tpl.label) + ' cadence'
              : 'Reset to the default cadence';
          })() + '</button>' +
        repeatRows;
    })() +
    '</div>' +
    /* One place that answers "how do appointments get in here?".

       The question was spread across a Connect button in the menu, a filter
       section here, and nothing at all about booking links. Worse, it was
       asked as one question -- connect your calendar? -- when there are four
       genuinely different answers that differ in what Ghost Recall can DO.

       Providers that do not work are listed and marked unavailable, with what
       they would need. Hiding them makes the product look incapable; showing
       them as choices that silently do nothing turns a missing feature into a
       broken one, and the person spends an afternoon wondering what they did
       wrong. */
    '<div class="set-section"><h3>How appointments get in</h3>' +
    '<div class="hint">These are different levels of connection, not styles of the same one.</div>' +
    '<div class="sch-list">' +
    SCHEDULING_PROVIDERS.map(function(pv){
      var st = schedulingStatus(STATE);
      var on = (pv.key === 'google' && st.calendarConnected)
            || (pv.key === 'link' && st.hasBookingLink)
            || (pv.key === 'manual');
      return '<div class="sch-row' + (pv.available ? '' : ' unavailable') + '">' +
        '<div class="sch-main">' +
          '<strong>' + escapeHtml(pv.label) + '</strong>' +
          '<span class="sch-level">' + escapeHtml(SCHEDULING_LEVELS[pv.level]) + '</span>' +
          '<div class="sch-blurb">' + escapeHtml(pv.blurb) + '</div>' +
          (pv.caveat ? '<div class="sch-caveat">' + escapeHtml(pv.caveat) + '</div>' : '') +
          (pv.needs ? '<div class="sch-needs">Not available yet. ' + escapeHtml(pv.needs) + '</div>' : '') +
        '</div>' +
        '<div class="sch-state">' +
          (!pv.available ? '<span class="sch-tag off">not available</span>'
            : on ? '<span class="sch-tag on">in use</span>'
            : pv.key === 'google'
              ? '<button class="btn btn-sm" data-action="connect-calendar" data-priority="0" data-label="Work">Connect</button>'
              : '<span class="sch-tag">available</span>') +
        '</div></div>';
    }).join('') +
    '</div>' +
    '<div class="term-grid" style="margin-top:10px;"><div><label>Your booking link</label>' +
      '<input type="text" data-action="set-booking-link" value="' +
      escapeHtml(STATE.bookingLink || '') +
      '" placeholder="https://calendar.google.com/..."></div></div>' +
    '<div class="hint" style="margin-top:5px;">Use <code>{bookinglink}</code> in any message or email and this gets filled in. Changing it here changes it everywhere.</div>' +
    '</div>' +

    '<div class="set-section"><h3>Which calendar events become ' + escapeHtml(termLower('contactPlural')) + '</h3>' +
    '<div class="hint">If your bookings are not appearing, this is almost always why.</div>' +
    ['attendees','keywords','all'].map(function(m){
      var labels = {
        attendees: ['Events with an outside guest', 'Anything with a guest from outside your own email domain. Works without setup.'],
        keywords:  ['Events matching words in the title', 'For booking tools that name events predictably.'],
        all:       ['Everything on the calendar', 'Only sensible for a calendar used just for bookings.']
      };
      var cf = STATE.calendarFilter || {};
      return '<label class="cal-mode' + ((cf.mode || 'keywords') === m ? ' selected' : '') + '">' +
        '<input type="radio" name="calmode" data-action="set-cal-mode" data-mode="' + m + '"' +
        ((cf.mode || 'keywords') === m ? ' checked' : '') + '>' +
        '<span><strong>' + labels[m][0] + '</strong><em>' + labels[m][1] + '</em></span></label>';
    }).join('') +
    ((STATE.calendarFilter && STATE.calendarFilter.mode === 'keywords')
      ? '<div class="term-grid" style="margin-top:8px;"><div><label>Title contains any of these</label>' +
        '<input type="text" data-action="set-cal-words" data-key="include" value="' +
        escapeHtml(((STATE.calendarFilter || {}).include || []).join(', ')) +
        '" placeholder="strategy session, discovery call"></div></div>' : '') +
    '<div class="term-grid" style="margin-top:8px;"><div><label>Never include events titled</label>' +
      '<input type="text" data-action="set-cal-words" data-key="exclude" value="' +
      escapeHtml(((STATE.calendarFilter || {}).exclude || []).join(', ')) +
      '" placeholder="team meeting, lunch"></div></div>' +
    /* And clean up what the rule came too late for.

       An exclusion only ever applied to the next sync, so somebody who
       notices junk in their list sets the rule and watches the junk stay
       exactly where it is. The offer appears once the rule is saved, because
       typing here deliberately does not re-render — rebuilding the modal
       would steal the caret mid-word. */
    (function(){
      var ex = contactsMatchingExclusions(STATE, (STATE.calendarFilter || {}).exclude);
      if(!ex.matched.length) return '';
      return '<div class="set-warn" style="margin-top:8px;">' +
        ex.matched.length + ' already-imported ' +
        (ex.matched.length === 1 ? 'event matches' : 'events match') +
        ' these words. The rule only stops new ones arriving.' +
        '<button class="btn btn-sm" style="margin-left:8px;" data-action="apply-exclusions">' +
        'Hide ' + (ex.matched.length === 1 ? 'it' : 'them') + '</button>' +
        (ex.untitled
          ? '<div class="hint" style="margin-top:6px;">' + ex.untitled +
            ' older ' + (ex.untitled === 1 ? 'contact was' : 'contacts were') +
            ' imported before Ghost Recall kept event titles, so they cannot be ' +
            'checked against a title rule.</div>'
          : '') +
        '</div>';
    })() +
    '</div>' +
    /* Email settings are now one question: which Gmail do client emails open
       from.

       This section used to carry two switches — "allow sending email from
       this account" and "send due follow-up emails automatically" — plus a
       warning about verifying a sending domain. None of them did anything any
       more. Email is a library you send by hand through your own Gmail, the
       automatic sender refuses live runs, and the first switch gated nothing
       except the display of the second. A control that does nothing is worse
       than a missing one: it tells someone a thing is on when it is not.

       The stored values are left in the database untouched, so nothing is
       lost if a provider route comes back. They are just no longer presented
       as choices that have an effect. */
    '<div class="set-section"><h3>Email</h3>' +
    '<div class="hint">Your emails live in the Email templates tab. The Email button on a ' +
      escapeHtml(termLower('contact')) + ' opens Gmail with one of them already written, ' +
      'so it sends from you and replies come back to you.</div>' +
    '<div class="term-grid" style="margin-top:8px;">' +
      '<div><label>Send client email from</label><input type="text" data-action="set-email-field" data-key="emailFromAddress" value="' +
        escapeHtml(STATE.emailFromAddress || '') + '" placeholder="' +
        escapeHtml(businessEmailAccount(STATE) || 'you@yourdomain.com') + '"></div>' +
    '</div>' +
    (businessEmailAccount(STATE)
      ? '<div class="hint" style="margin-top:6px;">The Email button opens Gmail as <strong>' +
        escapeHtml(businessEmailAccount(STATE)) + '</strong>' +
        (STATE.emailFromAddress ? '.' : ', taken from your connected calendar. Set an address above to override it.') + '</div>'
      : '<div class="set-warn" style="margin-top:6px;">No business account known yet, so the Email button would open whichever Gmail you last used. Connect a calendar or set an address above.</div>') +
    '</div>' +
    /* Connecting a Mac.

       Apple gives no way to read iMessage except from a Mac signed into that
       Apple ID, so the only software that can see those conversations runs on
       the person's own machine. This is where it gets a credential.

       The token is shown once and never again -- only its hash is stored, so
       this list leaking is not a leak of anybody's access. */
    /* A status panel, not a control panel.

       It says which of the three routes is in use and what the others would
       need, and it changes nothing: how a message is sent is decided by
       smsSendMode, which this does not touch. A "coming soon" section that
       quietly alters behaviour is the opposite of what it is for. */
    '<div class="set-section"><h3>Messaging</h3>' +
    '<div class="hint">How texts leave Ghost Recall today, and what is not switched on yet. ' +
    'Nothing here changes your current workflow.</div>' +
    '<div id="messaging-setup"></div></div>' +
    '<div class="set-section"><h3>Connect this Mac</h3>' +
    '<div class="hint">Pulls your existing text threads with clients into the Texts tab. ' +
    'Only conversations with people who are already contacts are read \u2014 everything else ' +
    'stays on your Mac. Needs a Mac running the agent; nothing to install on your phone.</div>' +
    '<div id="device-tokens"></div>' +
    '<div style="margin-top:8px;">' +
      '<button class="btn btn-sm" data-action="new-device-token">Create a token for this Mac</button>' +
    '</div></div>' +
    '<div class="set-section"><h3>What you call things</h3>' +
    '<div class="hint">Changes the words in the interface. Nothing behavioural.</div>' +
    '<div class="term-grid">' + termFields + '</div></div>' +
    '<div class="field-row" style="text-align:right;">' +
      '<button class="btn btn-sm btn-ghost" data-action="reset-settings">Reset to defaults</button> ' +
      '<button class="btn btn-sm btn-green" data-action="save-settings">Save settings</button>' +
    '</div>' +
    '<div class="build-stamp">Build ' + escapeHtml(BUILD_STAMP) + '</div>',
    true
  );
  renderMessagingSetup();
  renderDeviceTokens();

  /* Land on the section that was asked for.

     The cadence editor sits three sections into a long modal reached from a
     menu item called "Business settings" -- which is how the first person
     who went looking for it did not find it. Opening the modal at the top
     and hoping is the same miss again.

     Cleared once used, so a later Save-and-reopen behaves normally; and the
     scroll runs after paint, since the element does not exist until
     openModalHtml has written it. */
  if(SETTINGS_FOCUS === 'cadence'){
    SETTINGS_FOCUS = null;
    setTimeout(function(){
      var sec = el('set-cadence');
      if(!sec) return;
      if(sec.scrollIntoView) sec.scrollIntoView({block:'start'});
      // Briefly marked, so it is obvious which of ten sections you landed on.
      sec.classList.add('set-landed');
      setTimeout(function(){ sec.classList.remove('set-landed'); }, 2000);
    }, 0);
  }
}

/* Say it before they click, and dim what will not work.

   Tested in a browser and this was the gap: the gate worked perfectly --
   nothing saved, nothing logged, the right toast -- and the screen looked
   completely normal. Every button live, nothing explaining why the app had
   stopped responding. A dead end dressed as a working app is worse than a
   locked door, because it reads as broken software rather than an unpaid
   bill.

   Two parts. A banner that states it once, and a dimming pass over the
   controls that will refuse.

   The controls stay CLICKABLE on purpose. A disabled button cannot explain
   itself; a dimmed one that answers "read-only, here is why" when pressed
   is the kinder of the two. The dimming is what stops somebody trying in
   the first place. */
function applyReadOnlyUI(){
  if(!STATE) return;
  var st = billingState();
  var ro = !billingAllowsWrite(st);
  var level = billingNotice(st);
  document.body.classList.toggle('is-read-only', ro);

  /* Clear the dimming first, every time, rather than assuming a re-render
     washed it off.

     Seen in the browser: moving from read-only back to full left seven
     controls still greyed. Most of the screen is rebuilt by renderAll and
     loses the class with the old nodes, but the header and menu are static
     markup in app.html -- those nodes survive, and the class stayed on them.
     In production that is an account that has just PAID still looking half
     broken until a hard refresh, which is the worst possible moment for it. */
  if(!ro){
    var stale = document.querySelectorAll('.ro-off');
    for(var j = 0; j < stale.length; j++) stale[j].classList.remove('ro-off');
  }

  var bar = el('readonly-bar');
  if(level === 'none'){
    if(bar) bar.remove();
    return;
  }
  if(!bar){
    bar = h('div', {id: 'readonly-bar'}, []);
    var root = el('app-root');
    if(root) root.insertBefore(bar, root.firstChild);
  }
  // Warn and stop look different on purpose: one is "fix this soon", the
  // other is "this is why nothing works".
  bar.className = 'ro-bar ' + (level === 'stop' ? 'ro-stop' : 'ro-warn');
  bar.innerHTML = '';
  /* Two elements rather than one string with a dash in it. On a phone the
     bar wraps, and a literal "— " then starts its own line looking like a
     typo. */
  bar.appendChild(h('strong', {}, [st.headline]));
  bar.appendChild(h('span', {class: 'ro-detail'}, [st.detail]));
  bar.appendChild(h('button', {class: 'btn btn-sm', 'data-action': 'open-settings'},
    ['Billing']));

  // Dimming belongs to read-only alone. A warning account still works, and
  // greying its buttons would say otherwise.
  if(!ro) return;

  /* One pass over whatever was just rendered, rather than a check at sixty
     call sites. Driven by the same list the gate consults, so a control
     cannot look live while the gate refuses it -- or look dead while it
     still works. */
  var nodes = document.querySelectorAll('[data-action]');
  for(var i = 0; i < nodes.length; i++){
    var n = nodes[i];
    if(!isReadOnlyBlocked(n.getAttribute('data-action'))) continue;
    n.classList.add('ro-off');
    if(!n.getAttribute('title')) n.setAttribute('title', 'Read-only \u2014 subscribe to use this');
  }
}

/* What billing says about this account right now.

   Computed rather than stored, so it cannot go stale against a webhook that
   landed while the tab was open. Counts the team from the members already
   loaded for the Team tab; falls back to one, because a solo account is
   still one seat. */
function billingState(){
  if(!STATE) return null;
  // STATE.team is what loadTeamRows fills and the Team tab renders from --
  // the same list, so the seat count cannot disagree with the names shown
  // beside it. One when there is no team: a solo account is still one seat.
  var members = (STATE.team && STATE.team.length) ? STATE.team.length : 1;
  return subscriptionState(STATE.subscription, members, new Date());
}

/* Said once, plainly, and never as a dead end.

   The toast names what happened and what fixes it. It does not try to sell
   from inside an error -- the billing panel in Settings does that, and this
   points at it. */
var billingWallShownAt = 0;
function showBillingWall(){
  var st = billingState();
  var now = Date.now();
  // One message per few seconds: a read-only account clicking around should
  // not stack six identical toasts.
  if(now - billingWallShownAt < 4000) return;
  billingWallShownAt = now;
  showToast((st && st.headline ? st.headline + '. ' : '') +
    'Read-only until the subscription is sorted \u2014 your data is all here, ' +
    'and exports still work.');
}

/* A step copied deeply enough that editing the draft cannot reach the
   template it came from.

   buildIndustryTemplates() rebuilds its list on every call, so the objects
   are fresh -- but the trigger is a nested object, and a draft that shared
   one with anything else would write through it. Cheap insurance on a path
   where the symptom would be a setting that changes a different setting. */
function cloneStep(st){
  return {key: st.key, stage: st.stage, trigger: Object.assign({}, st.trigger)};
}

function saveSettingsDraft(){
  var d = SETTINGS_DRAFT;
  // A blank-named stage is a half-finished edit, not a stage. Dropping them on
  // save is kinder than refusing to save and making someone hunt for the row.
  var stages = d.pipeline
    .map(function(st){ return {key: (st.label || '').trim(), label: (st.label || '').trim(), role: st.role || 'open'}; })
    .filter(function(st){ return st.key; });
  if(!stages.length){
    showToast('A pipeline needs at least one stage.');
    return;
  }
  if(!stages.some(function(st){ return st.role === 'open'; })){
    // Without an open stage nothing is ever followed up, which looks exactly
    // like the app being broken.
    showToast('Keep at least one “open” stage, or nothing will ever be followed up.');
    return;
  }
  if(!d.sequence.length){
    showToast('A cadence needs at least one step, or Ghost Recall will never follow up.');
    return;
  }
  // Email fields were edited live in STATE; persist them with the rest.
  /* Only when a template was loaded. Editing stages by hand keeps its
     documented behaviour — an orphaned status behaves as open and the warning
     above says so — because a rename is a small change somebody is watching.
     Swapping a template changes every stage at once, and leaving all of them
     orphaned would put the whole book back into the follow-up cadence. */
  var moved = null;
  if(d.remap){
    moved = remapStatusesByRole(STATE, stages);
    d.remap = false;
  }
  STATE.pipeline = stages;
  STATE.terminology = d.terminology;
  STATE.sequence = d.sequence;
  setPipeline(stages);
  setTerminology(d.terminology);
  setSequence(d.sequence);
  saveState(STATE);
  closeModal();
  renderAll();
  showToast(moved && moved.moved
    ? 'Settings saved. ' + moved.moved + ' moved to the matching new stage.'
    : 'Settings saved.');
}


function openWeeklyDigestModal(){
  var text = buildWeeklyDigest(STATE, new Date());
  openModalHtml(
    '<div class="modal-head"><h2>Weekly digest</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
    '<textarea id="digest-text" style="width:100%;min-height:280px;font-family:monospace;font-size:12px;">' + escapeHtml(text) + '</textarea>' +
    '<button class="btn btn-primary" style="margin-top:8px;" data-action="copy-digest">Copy to clipboard</button>',
    true
  );
}


function openBulkPasteModal(){
  openModalHtml(
    '<div class="modal-head"><h2>Bulk paste</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
    '<div class="field-row"><label>Paste booking emails / invites / a list — one client per line or blank-line-separated block</label>' +
    '<textarea id="bulk-input" style="min-height:160px;"></textarea></div>' +
    '<button class="btn" data-action="preview-bulk">Preview</button>' +
    '<div id="bulk-preview"></div>',
    true
  );
}


function openICSModal(){
  openModalHtml(
    '<div class="modal-head"><h2>Import .ics</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
    '<div class="field-row"><label>Choose a .ics file exported from Google Calendar</label><input type="file" id="ics-file" accept=".ics"></div>' +
    '<div id="ics-preview"></div>',
    true
  );
}


function renderImportPreviewTable(containerId, parsedList, confirmAction){
  var existingKeys = {};
  Object.keys(STATE.clients).forEach(function(cid){ var c = STATE.clients[cid]; existingKeys[(c.name||'').toLowerCase()+'|'+(c.phone||'').replace(/\D/g,'')] = true; });
  var rows = parsedList.map(function(p, idx){
    var skip = !p.callDateTime;
    var dup = !skip && existingKeys[(p.name||'').toLowerCase()+'|'+(p.phone||'').replace(/\D/g,'')];
    var flag = skip ? '<span class="flag-skip">skip — no date found</span>' : (dup ? '<span class="flag-dup">already exists</span>' : '');
    return '<tr><td>'+escapeHtml(p.name)+'</td><td>'+escapeHtml(p.phone||'')+'</td><td>'+escapeHtml(p.email||'')+'</td><td>'+(p.callDateTime?new Date(p.callDateTime).toLocaleString():'—')+'</td><td>'+flag+'</td></tr>';
  }).join('');
  var html = '<table class="preview-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Call time</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<button class="btn btn-primary" data-action="'+confirmAction+'">Import ' + parsedList.filter(function(p){return p.callDateTime;}).length + ' clients</button>';
  var container = document.getElementById(containerId);
  if(container) container.innerHTML = html;
}


var pendingImport = [];


/* ============================================================
   13) EVENTS — one delegated click handler + supporting listeners
   ============================================================ */

function isTypingTarget(t){
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}


document.addEventListener('click', function(ev){
  var target = ev.target.closest ? ev.target.closest('[data-action]') : null;
  if(!target){
    if(ev.target.id === 'overflow-menu' || ev.target.closest('.menu-dropdown')) return;
    var menu = el('overflow-menu');
    if(menu && !menu.classList.contains('hidden') && !ev.target.closest('.menu-wrap')) menu.classList.add('hidden');
    return;
  }
  var action = target.getAttribute('data-action');
  var cid = target.getAttribute('data-cid');
  var stage = target.getAttribute('data-stage');

  /* One gate, before the switch, rather than a check inside sixty handlers.

     Read-only is what an ended trial or a long-dead card leaves behind. The
     list it consults is enumerated in logic.js and deliberately not inferred
     from "does this handler save" -- a guess would both block things that
     must keep working and silently start blocking anything added later.

     Everything not on that list still runs: the daily list, opening a
     contact, message history, search, print, and both exports. Somebody
     whose card expired can still get their own data out. */
  if(isReadOnlyBlocked(action) && !billingAllowsWrite(billingState())){
    showBillingWall();
    return;
  }

  switch(action){
    case 'open-appearance':
      el('overflow-menu').classList.add('hidden');
      THEME_DRAFT = sanitizeTheme(STATE && STATE.theme);
      /* The app's own modal, not a bespoke one: it already centres, dims
         the page and closes on the overlay. */
      openModalHtml(
        '<div class="modal-head"><h2>Appearance</h2>' +
        '<button class="btn-ghost btn" data-action="theme-cancel">\u2715</button></div>' +
        '<div id="appearance-body"></div>', false);
      var apm = document.querySelector('#modal-root .modal');
      if(apm) apm.classList.add('ap-modal');
      renderAppearance();
      break;
    case 'theme-mode':
      themeDraft().mode = target.getAttribute('data-mode') || 'system';
      applyTheme(THEME_DRAFT);
      renderAppearance();
      break;
    case 'theme-preset': {
      var pk = target.getAttribute('data-preset');
      if(pk === 'custom'){
        /* Custom starts from whatever is on screen, not from a blank set.
           Somebody who nudges a preset then presses Custom means "like
           this, but mine" -- handing them defaults would throw away the
           thing they were reacting to. */
        THEME_DRAFT = sanitizeTheme({mode: themeDraft().mode, preset: 'custom',
                                     colors: themeDraft().colors});
      } else {
        THEME_DRAFT = sanitizeTheme({mode: THEME_PRESETS[pk].mode, preset: pk});
      }
      applyTheme(THEME_DRAFT);
      renderAppearance();
      break;
    }
    case 'theme-fix': {
      var ff = target.getAttribute('data-field');
      var fh = target.getAttribute('data-hex');
      var dft = themeDraft();
      dft.colors[ff] = fh;
      dft.preset = 'custom';
      applyTheme(dft);
      renderAppearance();
      break;
    }
    case 'theme-save': {
      var toSave = sanitizeTheme(THEME_DRAFT);
      STATE.theme = toSave;
      /* Mirrored locally so the <head> script can paint before the
         stylesheet on the next load. The row is the record; this is the
         copy that prevents a flash of the wrong colours. */
      /* Stored with the DERIVED tokens already computed, because the <head>
         script runs before logic.js exists and cannot derive anything. It
         sets variables and nothing else -- which is the only shape of code
         that belongs before first paint. */
      try{
        localStorage.setItem('gr-theme-full', JSON.stringify(
          {mode: toSave.mode, tokens: themeTokens(toSave)}));
      }catch(e){}
      closeModal();
      saveTheme(toSave).then(function(r){
        showToast(r.ok ? 'Appearance saved.'
                       : 'Saved on this device only \u2014 ' + r.error + '.');
      });
      break;
    }
    case 'theme-cancel':
      /* Back to the SAVED theme, not to the default. Cancel means "forget
         what I just did", and a cancel that resets you is a trap. */
      THEME_DRAFT = null;
      if(STATE && STATE.theme) applyTheme(STATE.theme); else clearThemeOverrides();
      closeModal();
      break;
    case 'theme-reset':
      /* Clears the pre-paint mirror as well. Leaving it would repaint the
         abandoned colours on the next load, before state arrives to correct
         them -- a flash of a theme somebody explicitly reset. */
      try{ localStorage.removeItem('gr-theme-full'); }catch(e){}
      clearThemeOverrides();
      THEME_DRAFT = sanitizeTheme({mode:'system', preset:'default'});
      applyTheme(THEME_DRAFT);
      renderAppearance();
      break;
    case 'set-theme': {
      /* 'auto' REMOVES the attribute rather than writing a value, so the
         media query takes over again. Writing 'auto' into data-theme would
         match neither rule and silently pin the light palette. */
      var th = target.getAttribute('data-theme') || 'auto';
      if(th === 'auto'){
        document.documentElement.removeAttribute('data-theme');
        try{ localStorage.removeItem('gr-theme'); }catch(e){}
      } else {
        document.documentElement.setAttribute('data-theme', th);
        try{ localStorage.setItem('gr-theme', th); }catch(e){}
      }
      renderThemePick();
      break;
    }
    case 'toggle-menu':
      el('overflow-menu').classList.toggle('hidden');
      break;
    case 'sign-out':
      el('overflow-menu').classList.add('hidden');
      window.GB_SUPABASE.auth.signOut();
      break;
    case 'connect-calendar': {
      el('overflow-menu').classList.add('hidden');
      var priority = Number(target.getAttribute('data-priority'));
      var label = target.getAttribute('data-label');
      window.GB_SUPABASE.auth.getUser().then(function(res){
        var userId = res.data.user && res.data.user.id;
        if(!userId) return;
        /* Where to come back to. The callback lives on functions.supabase.co
           and used to finish there on a dead-end page; it now returns here,
           which also keeps the session — arriving at a different origin is
           how people ended up signing in again. Checked against an allow-list
           at the other end, because nothing signs this. */
        var state = btoa(JSON.stringify({userId: userId, priority: priority,
                                         label: label, origin: window.location.origin}));
        var params = new URLSearchParams({
          client_id: '1060862353263-1tfnpumq29898ffrnc5oh65b211v8ovr.apps.googleusercontent.com',
          redirect_uri: 'https://gqfpsjksosxvszzhhezu.functions.supabase.co/google-calendar-callback',
          response_type: 'code',
          scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
          access_type: 'offline',
          prompt: 'consent',
          state: encodeURIComponent(state)
        });
        window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
      });
      break;
    }
    case 'sync-calendar-now':
      el('overflow-menu').classList.add('hidden');
      showToast('Syncing calendar…');
      window.GB_SUPABASE.functions.invoke('google-calendar-sync').then(function(res){
        if(res.error){ showToast('Sync failed — try again in a bit.'); console.error(res.error); return; }
        var cals = (res.data && res.data.results && res.data.results[0] && res.data.results[0].calendars) || [];
        if(!cals.length){ showToast('No calendar connected yet — use "Connect calendar" first.'); return; }
        var msg = describeSyncResult(cals);
        showToast(msg.text);
        if(msg.detail) console.error('Ghost Recall: calendar sync — ' + msg.detail);
        if(msg.ok) init();
      });
      break;
    /* More: open, close, and get out of the way.

       Was a <details>. Safari stops toggling a disclosure once `display` is
       overridden on its <summary>, and the CSS does exactly that to line the
       chevron up -- so the control was dead on the browser this is used in,
       and worked everywhere I tested it. A button and aria-expanded have no
       browser-specific behaviour left to break. */
    case 'tab-more':
      setTabMoreOpen(!tabMoreOpen());
      break;
    case 'tab':
      UI.tab = target.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b===target); });
      document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.toggle('active', p.id==='tab-'+UI.tab); });
      /* AFTER the sweep above, not before. The More summary is itself a
         .tab-btn, so a sweep that lights only the clicked element takes the
         summary's mark straight back off -- picking Performance left every
         visible tab unlit, which reads as no tab being selected at all. */
      markActiveTab();
      /* The messaging workspace is laid out from the window width, and a
         hidden panel measures nothing useful. Rendered at load in a narrow
         pane it picks the phone layout and keeps it after the window grows,
         because switching tabs only toggles a class. Re-rendering on arrival
         costs nothing and makes the panes right whatever happened before. */
      if(UI.tab === 'threads') renderThreadsTab();
      break;
    case 'set-stats-range':
      UI.statsRange = target.getAttribute('data-range');
      document.querySelectorAll('#stats-range-toggle button').forEach(function(b){ b.classList.toggle('active', b===target); });
      renderStats();
      break;
    case 'cal-prev':
      UI.calendarAnchor = UI.calendarView==='week' ? addDays(UI.calendarAnchor,-7) : addMonths(UI.calendarAnchor,-1);
      renderCalendarTab();
      break;
    case 'cal-next':
      UI.calendarAnchor = UI.calendarView==='week' ? addDays(UI.calendarAnchor,7) : addMonths(UI.calendarAnchor,1);
      renderCalendarTab();
      break;
    case 'cal-today':
      UI.calendarAnchor = new Date();
      renderCalendarTab();
      break;
    case 'cal-set-view':
      UI.calendarView = target.getAttribute('data-view');
      document.querySelectorAll('#cal-view-toggle button').forEach(function(b){ b.classList.toggle('active', b===target); });
      renderCalendarTab();
      break;
    case 'cal-view-day':
      openDayListModal(target.getAttribute('data-day'));
      break;
    case 'filter-score': {
      var grp = target.getAttribute('data-group');
      UI.scoreFilter = grp || null;
      // Picking a temperature clears the pipeline filter — combining them
      // silently produces an empty table that reads as broken.
      UI.statusFilter = null;
      // Sorting by score is what someone wants the moment they pick a band.
      if(grp) UI.clientsSort = 'score';
      renderClientsTab();
      break;
    }
    case 'filter-status':
      UI.statusFilter = target.getAttribute('data-status') || null;
      UI.scoreFilter = null;   // same reason as above, in the other direction
      renderClientsTab();
      break;
    case 'add-client':
      openAddClientModal();
      break;
    case 'save-add-client': {
      var callInput = el('f-call').value, bookedInput = el('f-booked').value;
      addManualClient(STATE, {
        name: el('f-name').value.trim() || 'Unknown',
        phone: el('f-phone').value.trim(),
        email: el('f-email').value.trim(),
        callDateTime: callInput ? new Date(callInput).toISOString() : null,
        bookedDate: bookedInput ? new Date(bookedInput).toISOString() : nowISO(),
        youtubeLink: el('f-yt').value.trim(),
        meetLink: el('f-meet').value.trim(),
        notes: el('f-notes').value.trim(),
        timezone: el('f-tz').value
      });
      closeModal(); renderAll();
      showToast('Client added.');
      break;
    }
    case 'open-client':
      openClientModal(cid);
      break;
    case 'close-modal':
    case 'overlay-close':
      if(action === 'overlay-close' && ev.target.getAttribute('data-stop-close')) break;
      if(action === 'overlay-close' && ev.target !== ev.currentTarget) break;
      closeModal();
      break;
    case 'set-outcome':
      lastSnapshot = snapshot();
      setOutcome(STATE, cid, target.getAttribute('data-status'));
      openClientModal(cid); renderAll();
      break;
    case 'set-outcome-quick':
      lastSnapshot = snapshot();
      setOutcome(STATE, cid, target.getAttribute('data-status'));
      renderAll();
      if(openDayListKey) openDayListModal(openDayListKey); // refresh in place rather than closing on a rapid multi-call day
      showToast(STATE.clients[cid].name + ' marked ' + target.getAttribute('data-status') + '.', lastSnapshot);
      break;
    case 'set-close':
      STATE.clients[cid].closeOutcome = target.getAttribute('data-close');
      saveState(STATE);
      openClientModal(cid); renderAll();
      break;
    case 'toggle-replied':
      doToggleReplied(cid, parseInt(target.getAttribute('data-idx'),10));
      openClientModal(cid); renderAll();
      break;
    case 'toggle-replied-quick':
      // same underlying toggle as inside the modal, but used from the board/table
      // where popping a modal open on a single tap would defeat the point
      doToggleReplied(cid, parseInt(target.getAttribute('data-idx'),10));
      renderAll();
      break;
    case 'interaction-outcome': {
      var oKey = target.getAttribute('data-outcome');
      // Outcomes needing nothing further resolve immediately — one tap, done.
      if(oKey === 'no_reply' || oKey === 'wrong_contact'){
        doInteractionOutcome(cid, oKey, {});
        UI.outcomeOpen = null;
        renderAll();
      } else {
        UI.outcomeOpen = {cid: cid, outcome: oKey};
        renderGhostToday();
      }
      break;
    }
    case 'interaction-confirm': {
      var ck = target.getAttribute('data-outcome');
      var whenEl = el('oc-when'), noteEl = el('oc-note'), untilEl = el('oc-until');
      doInteractionOutcome(cid, ck, {
        callDateTime: whenEl && whenEl.value ? new Date(whenEl.value).toISOString() : null,
        note: noteEl && noteEl.value ? noteEl.value : null,
        until: untilEl && untilEl.value ? untilEl.value : null
      });
      UI.outcomeOpen = null;
      renderAll();
      break;
    }
    case 'interaction-cancel':
      UI.outcomeOpen = null;
      renderGhostToday();
      break;
    case 'ob-industry': {
      ONBOARDING.industry = target.getAttribute('data-key');
      var t = industryTemplate(ONBOARDING.industry);
      // Pre-fill step 2 from the template so the words are already right and
      // the step becomes a confirmation rather than a blank form.
      ONBOARDING.terminology = t && t.terminology
        ? Object.assign(buildDefaultTerminology(), t.terminology)
        : buildDefaultTerminology();
      renderOnboarding();
      break;
    }
    case 'ob-next':
      if(ONBOARDING.step === 1 && !ONBOARDING.industry) break;
      if(ONBOARDING.step === 3){ applyOnboarding(); finishOnboarding(false); break; }
      ONBOARDING.step++;
      renderOnboarding();
      break;
    case 'ob-back':
      ONBOARDING.step--;
      renderOnboarding();
      break;
    case 'ob-skip-calendar':
      applyOnboarding();
      finishOnboarding(false);
      break;
    case 'ob-skip':
      // Skipping is a real choice, not a trap: nothing is applied and the
      // wizard never reappears.
      finishOnboarding(true);
      break;
    case 'msgx-email-open': {
      /* The Gmail handoff from inside a conversation.

         Same contract as the Messages one: the link opens a draft, this
         records that it was opened, and nothing claims the email was sent.
         markSentOnChannel logs channel 'email' with no providerId, which is
         exactly what deliveryState reads as "opened in Gmail -- not
         confirmed". */
      var mec = STATE.clients[cid];
      if(!mec) break;
      var subjEl = el('msgx-subj'), bodyEl = el('msgx-email');
      var msubj = (subjEl && subjEl.value.trim()) || '';
      var mbody = (bodyEl && bodyEl.value.trim()) || '';
      if(!msubj && !mbody){ showToast('Nothing to send yet.'); break; }
      window.open(gmailComposeUrl(mec.email, msubj, mbody, businessEmailAccount(STATE)), '_blank');
      markSentOnChannel(cid, 'email', (msubj ? msubj + '\n\n' : '') + mbody, 'email');
      clearDraft(cid, 'email');
      if(subjEl) subjEl.value = '';
      if(bodyEl) bodyEl.value = '';
      renderThreadsTab();
      showToast('Draft opened in Gmail \u2014 logged as unconfirmed until you send it.');
      break;
    }
    case 'sent-by-email': {
      // The link opens Gmail by itself; this records it. Optimistic, like the
      // sms: path — Ghost Recall cannot see whether Send was actually pressed,
      // so it is logged and undoable rather than confirmed beforehand.
      var ec = STATE.clients[cid];
      if(!ec) break;
      var docId = target.getAttribute('data-doc');
      /* A draft written from call notes is not a library document, so
         renderEmailDoc cannot find it and would return null — which would
         mean the send was never logged at all. That matters beyond the
         timeline: an unlogged email is an email the automated side does not
         know about, so a text could go out on top of it the same afternoon.

         It is already rendered and already on screen, so it is taken from
         the panel directly. */
      var edraft = (docId === 'notes-draft' && NOTES_PANEL.draft)
        ? {subject: NOTES_PANEL.draft.subject, text: NOTES_PANEL.draft.text}
        : (docId ? renderEmailDoc(STATE, docId, ec, STATE.senderName) : null);
      // A library email is not a cadence touch, so there is no stage to
      // advance. It is logged against 'email' so it still counts as contact —
      // which is what stops an automated text going out on top of it — and so
      // the timeline shows what was actually sent.
      if(edraft){
        lastSnapshot = snapshot();
        markSentOnChannel(cid, 'email', edraft.subject + '\n\n' + edraft.text, 'email');
        renderAll();
        closeModal();
        showToast('Logged as emailed to ' + ec.name + '.', lastSnapshot);
      }
      break;
    }
    case 'open-settings':
      openSettingsModal();
      break;
    case 'open-cadence':
      el('overflow-menu').classList.add('hidden');
      openSettingsModal('cadence');
      break;
    case 'add-stage':
      SETTINGS_DRAFT.pipeline.push({key:'', label:'', role:'open'});
      renderSettingsModal();
      break;
    case 'remove-stage':
      SETTINGS_DRAFT.pipeline.splice(parseInt(target.getAttribute('data-idx'),10), 1);
      renderSettingsModal();
      break;
    case 'move-stage': {
      var mi = parseInt(target.getAttribute('data-idx'),10);
      var dir = parseInt(target.getAttribute('data-dir'),10);
      var mj = mi + dir;
      if(mj >= 0 && mj < SETTINGS_DRAFT.pipeline.length){
        var tmp = SETTINGS_DRAFT.pipeline[mi];
        SETTINGS_DRAFT.pipeline[mi] = SETTINGS_DRAFT.pipeline[mj];
        SETTINGS_DRAFT.pipeline[mj] = tmp;
        renderSettingsModal();
      }
      break;
    }
    case 'reload-app':
      window.location.reload();
      break;
    case 'np-toggle':
      NOTES_PANEL.open = !NOTES_PANEL.open;
      renderEmailLibrary();
      break;
    case 'np-save': {
      var nsc = STATE.clients[NOTES_PANEL.cid];
      if(!nsc) break;
      nsc.recap = NOTES_PANEL.notes.trim();
      saveState(STATE);
      showToast('Saved to ' + nsc.name + '. The recap email will use it.');
      break;
    }
    case 'np-draft-email':
    case 'np-draft-sms': {
      var ndc = STATE.clients[NOTES_PANEL.cid];
      if(!ndc || !NOTES_PANEL.notes.trim()) break;
      var chan = sa === 'np-draft-sms' ? 'sms' : 'email';
      // Notes are worth keeping whether or not the draft is any good, and
      // this is the moment they are definitely in front of us.
      ndc.recap = NOTES_PANEL.notes.trim();
      saveState(STATE);

      /* The business's own words, so the model has a voice to match.

         For sms this used to be `STATE.variants.welcome.map(v => v.text)`:
         raw template source, so the model was shown "Hey {name}, ..." with
         the placeholders still in it, and starter copy ranked equally with
         anything the person had written themselves. voiceExamples renders
         them against this contact and puts their own wording first. */
      var examples = chan === 'sms'
        ? voiceExamples(STATE, 'welcome', ndc, STATE.senderName).examples
            .map(function(e){ return e.text; })
        : emailLibrary(STATE).map(function(d){ return d.body; });

      NOTES_PANEL.busy = true;
      renderEmailLibrary();
      callGemini(buildNotesPrompt({
        client: ndc, notes: NOTES_PANEL.notes, channel: chan,
        senderName: STATE.senderName, examples: examples
      })).then(function(text){
        var parts = chan === 'email' ? splitDraftedEmail(text) : {subject: '', text: text.trim()};
        NOTES_PANEL.draft = {channel: chan, subject: parts.subject, text: parts.text};
        NOTES_PANEL.busy = false;
        renderEmailLibrary();
      }).catch(function(e){
        NOTES_PANEL.busy = false;
        renderEmailLibrary();
        showToast('Could not write a draft - ' + e.message);
      });
      break;
    }
    case 'np-copy': {
      var npd = NOTES_PANEL.draft;
      if(!npd) break;
      copyToClipboard(npd.channel === 'email' && npd.subject
        ? npd.subject + '\n\n' + npd.text : npd.text);
      showToast('Copied.');
      break;
    }
    case 'np-discard':
      NOTES_PANEL.draft = null;
      renderEmailLibrary();
      break;
    case 'touch-filter':
      UI.touchFilter = target.getAttribute('data-stage') || '';
      renderCallsBoard();
      break;
    case 'pick-email': {
      var pc = STATE.clients[target.getAttribute('data-cid')];
      if(pc) openEmailPicker(pc);
      break;
    }
    case 'email-doc-new': {
      if(!STATE.emailLibrary) STATE.emailLibrary = [];
      var maxOrder = 0;
      STATE.emailLibrary.forEach(function(x){ if(x.sortOrder > maxOrder) maxOrder = x.sortOrder; });
      var fresh = {
        id: uuid(), title: 'Untitled email', whenToSend: '', subject: '', body: '',
        sortOrder: maxOrder + 10, archived: false, updatedAt: new Date().toISOString()
      };
      STATE.emailLibrary.push(fresh);
      LIB_OPEN = fresh.id;          // opened straight into edit; nobody adds one to look at it
      renderEmailLibrary();
      break;
    }
    case 'bulk-assign': {
      var bUid = target.getAttribute('data-uid');
      var bWho = target.getAttribute('data-who');
      var bN = parseInt(target.getAttribute('data-n'), 10) || 0;
      var bHist = parseInt(target.getAttribute('data-hist'), 10) || 0;
      var bSel = document.querySelector('[data-bulk-to="' + bUid + '"]');
      if(!bSel || !bSel.value) break;
      var bTo = bSel.options[bSel.selectedIndex].text;
      var bMember = (STATE.team || []).filter(function(x){ return x.userId === bUid; })[0];
      if(!bMember) break;
      /* Named, counted, and honest about the ones already in conversation —
         taking those over mid-thread is the part somebody would regret. */
      if(!confirm('Move ' + bN + ' upcoming from ' + bWho + ' to ' + bTo + '?' +
        (bHist ? '\n\n' + bHist + ' already have messages sent, so those are being '
               + 'taken over mid-conversation.' : '') +
        '\n\nYou can move any of them back individually afterwards.')) break;
      target.disabled = true;
      target.textContent = 'Moving...';
      reassignMany(bMember.queue.map(function(q){ return q.clientId; }), bSel.value,
        {fromUserId: bMember.userId, fromName: bWho, toName: bTo,
         byName: STATE.senderName || null})
        .then(function(r){
          if(!r.moved){
            showToast('Nothing moved: ' + (r.error || 'refused'));
            target.disabled = false;
            target.textContent = 'Move them';
            return;
          }
          // Partial results are reported as partial, never rounded up.
          showToast(r.failed
            ? 'Moved ' + r.moved + ' of ' + (r.moved + r.failed) + '. ' + (r.error || '')
            : 'Moved ' + r.moved + ' to ' + bTo + '.');
          init();
        });
      break;
    }
    case 'set-role': {
      var ruid = target.getAttribute('data-uid');
      var rnew = target.getAttribute('data-role');
      var rname = target.getAttribute('title') || '';
      /* Promoting is a real handover: they see every teammate's contacts,
         messages and numbers. Worth one confirmation rather than a stray
         click on a dense row. */
      if(rnew === 'admin' && !confirm(
        'Make this person a manager?\n\nThey will see every teammate\u2019s '
        + 'contacts, appointments and numbers, and be able to invite people.\n\n'
        + 'They will not get access to anyone\u2019s Google account.')) break;
      target.disabled = true;
      setMemberRole(ruid, rnew).then(function(r){
        if(!r.ok){
          showToast('Could not change role: ' + r.error);
          target.disabled = false;
          return;
        }
        showToast(rnew === 'admin' ? 'They are a manager now.' : 'Manager access removed.');
        init();   // what they can see changed; reload rather than patch
      });
      break;
    }
    case 'invite-send': {
      var emailEl = el('invite-email');
      var addr = emailEl ? emailEl.value : '';
      target.disabled = true;
      inviteToOrg(addr, 'member').then(function(r){
        target.disabled = false;
        if(!r.ok){ showToast('Could not invite: ' + r.error); return; }
        showToast('Invited ' + addr + '. They join once they accept.');
        if(emailEl) emailEl.value = '';
        init();
      });
      break;
    }
    case 'invite-accept': {
      var invId = target.getAttribute('data-id');
      target.disabled = true;
      target.textContent = 'Joining...';
      acceptOrgInvite(invId).then(function(r){
        if(!r.ok){
          showToast('Could not join: ' + r.error);
          target.disabled = false;
          renderPendingInvites();
          return;
        }
        showToast('You are on the team.');
        init();   // everything moved organisation; reload rather than patch
      });
      break;
    }
    case 'team-toggle': {
      var who = target.getAttribute('data-uid');
      TEAM_OPEN = (who && TEAM_OPEN === who) ? null : who;
      renderTeamTab();
      break;
    }
    case 'email-lib-starters': {
      /* Added as ordinary entries the moment they arrive: editable, deletable,
         and saved like anything else. They are given fresh ids rather than the
         'starter-N' ones so two people adding them never collide, and they go
         after whatever is already there rather than on top of it. */
      if(!STATE.emailLibrary) STATE.emailLibrary = [];
      var base = 0;
      STATE.emailLibrary.forEach(function(x){ if(x.sortOrder > base) base = x.sortOrder; });
      var added = starterEmailLibrary().map(function(d, i){
        return {
          id: uuid(), title: d.title, whenToSend: d.whenToSend,
          subject: d.subject, body: d.body, touch: '',
          sortOrder: base + (i + 1) * 10, archived: false,
          updatedAt: new Date().toISOString()
        };
      });
      if(!added.length) break;
      added.forEach(function(d){ STATE.emailLibrary.push(d); });
      LIB_OPEN = added[0].id;    // open the first one, so the next step is obvious
      renderEmailLibrary();
      saveState(STATE);
      showToast(added.length + ' drafts added - edit them into your own words.');
      break;
    }
    case 'email-doc-toggle': {
      var tid = target.getAttribute('data-id');
      LIB_OPEN = (LIB_OPEN === tid) ? null : tid;
      renderEmailLibrary();
      break;
    }
    case 'email-doc-delete': {
      var ddoc = findEmailDoc(target.getAttribute('data-id'));
      if(!ddoc) break;
      // Someone wrote this by hand and there is no undo for a library entry,
      // so it asks — and names the email, because "are you sure?" on the wrong
      // one is how the good email gets deleted.
      if(!confirm('Delete "' + ddoc.title + '"? This cannot be undone.\n\nDownload it first if you might want it back.')) break;
      STATE.emailLibrary = (STATE.emailLibrary || []).filter(function(x){ return x.id !== ddoc.id; });
      LIB_OPEN = null;
      saveState(STATE);
      renderEmailLibrary();
      showToast('Deleted.');
      break;
    }
    case 'email-lib-download': {
      var all = exportEmailLibrary(STATE, {businessName: STATE.senderName || ''});
      var okDl = downloadText(exportFilename((STATE.senderName || 'ghost recall') + ' emails'), all);
      if(okDl) showToast('Downloaded. Every email, with its timing note and placeholders intact.');
      break;
    }
    case 'email-lib-import': {
      // The old stage-keyed emails, carried across rather than retyped. Only
      // ever adds: the originals stay in `variants` untouched.
      var imported = seedEmailLibrary(STATE.emailVariants);
      if(!imported.length){ showToast('Nothing to import.'); break; }
      STATE.emailLibrary = (STATE.emailLibrary || []).concat(imported);
      saveState(STATE);
      renderEmailLibrary();
      showToast('Brought in ' + imported.length + (imported.length === 1 ? ' email.' : ' emails.'));
      break;
    }
    case 'apply-exclusions': {
      var ex = contactsMatchingExclusions(STATE, (STATE.calendarFilter || {}).exclude);
      if(!ex.matched.length) break;
      lastSnapshot = snapshot();
      ex.matched.forEach(function(c){ c.ignored = true; });
      saveState(STATE);
      renderSettingsModal();
      renderAll();
      // Undoable, like every other bulk hide here: the rule is a guess about
      // titles and somebody will word one too broadly.
      showToast('Hid ' + ex.matched.length +
        (ex.matched.length === 1 ? ' contact.' : ' contacts.'), lastSnapshot);
      break;
    }
    case 'set-cal-mode': {
      var cf = STATE.calendarFilter || {};
      STATE.calendarFilter = {
        mode: target.getAttribute('data-mode'),
        include: cf.include || ['strategy session'],
        matchDescription: cf.matchDescription || ['booked by'],
        exclude: cf.exclude || []
      };
      saveState(STATE);
      renderSettingsModal();
      break;
    }
    case 'remove-step':
      SETTINGS_DRAFT.sequence.splice(parseInt(target.getAttribute('data-idx'),10), 1);
      renderSettingsModal();
      break;
    case 'restore-sequence':
      /* The recommended cadence for the pipeline in front of them, not the
         agency one. Picking "Roofing" and then resetting used to hand back a
         five-touch agency rhythm, which is how a reset button teaches you
         that your industry was never really supported. */
      SETTINGS_DRAFT.sequence = recommendedSequenceFor(SETTINGS_DRAFT).map(cloneStep);
      renderSettingsModal();
      break;
    case 'add-step': {
      /* Appended after the last run-up touch rather than at the end, so a new
         touch does not land below the rescue steps where its number would be
         wrong and it would read as part of them. */
      var seqA = SETTINGS_DRAFT.sequence;
      var insertAt = 0;
      seqA.forEach(function(st, ix){
        if((st.trigger || {}).type !== 'repeat_while_role') insertAt = ix + 1;
      });
      // A stage that already has copy, preferring one not already in use --
      // a second touch on the same stage would send the same message twice.
      var used = {};
      seqA.forEach(function(st){ used[st.stage] = true; });
      var avail = Object.keys(STATE.variants || {});
      var free = avail.filter(function(k){ return !used[k]; });
      var stage = free.length ? free[0] : (avail[0] || 'welcome');
      seqA.splice(insertAt, 0, retargetStep(
        {key: stage, stage: stage, trigger: {}}, 'days_before_appointment'));
      renderSettingsModal();
      break;
    }
    case 'move-step': {
      var from = parseInt(target.getAttribute('data-idx'), 10);
      var dir = parseInt(target.getAttribute('data-dir'), 10);
      var seqM = SETTINGS_DRAFT.sequence;
      /* Swapped with the next RUN-UP step, not the next array element. The
         rescue steps are rendered in their own group below, so a plain
         index swap would appear to do nothing while quietly reordering
         something off-screen. */
      var order = [];
      seqM.forEach(function(st, ix){
        if((st.trigger || {}).type !== 'repeat_while_role') order.push(ix);
      });
      var at = order.indexOf(from);
      var to = order[at + dir];
      if(at === -1 || to === undefined) break;
      var tmp = seqM[from]; seqM[from] = seqM[to]; seqM[to] = tmp;
      renderSettingsModal();
      break;
    }
    case 'use-template': {
      var tk = target.getAttribute('data-key');
      var tpl = industryTemplate(tk);
      if(!tpl) break;
      SETTINGS_DRAFT.pipeline = tpl.pipeline.map(function(st){
        return {key: st.key, label: st.label, role: st.role};
      });
      if(tpl.terminology){
        SETTINGS_DRAFT.terminology = Object.assign(buildDefaultTerminology(), tpl.terminology);
      }
      /* The cadence is part of the template too.

         It was described as one from the start and never actually set, so
         every industry inherited the agency's rhythm -- a roofer got "the
         Monday of the appointment week" for an estimate booked on Tuesday
         for Thursday. Loaded into the draft like everything else here, so it
         is reviewable and discardable before Save rather than applied behind
         somebody's back. */
      if(tpl.sequence) SETTINGS_DRAFT.sequence = tpl.sequence.map(cloneStep);
      /* Remap on save, not now. The draft is reviewable and discardable —
         nothing has been committed yet — so rewriting statuses here would
         change real data for a choice the person can still back out of. */
      SETTINGS_DRAFT.remap = true;
      renderSettingsModal();
      showToast('Loaded ' + tpl.label + '. Review it, then Save.');
      break;
    }
    case 'reset-settings':
      SETTINGS_DRAFT = {pipeline: buildDefaultPipeline(), terminology: buildDefaultTerminology(),
                        sequence: buildDefaultSequence()};
      renderSettingsModal();
      break;
    case 'save-settings':
      saveSettingsDraft();
      break;
    case 'sort-clients':
      UI.clientsSort = target.getAttribute('data-sort');
      renderClientsTab();
      break;
    case 'ghost-filter':
      UI.ghostFilter = target.getAttribute('data-band');
      renderGhostToday();
      break;
    case 'review-replied':
      doReviewMessage(cid, parseInt(target.getAttribute('data-idx'),10), true);
      renderAll();
      break;
    case 'review-silent':
      doReviewMessage(cid, parseInt(target.getAttribute('data-idx'),10), false);
      renderAll();
      break;
    case 'toggle-recent-sends':
      UI.recentSendsOpen = !UI.recentSendsOpen;
      renderRecentSends();
      break;
    case 'copy-text': {
      var text = getCardText(STATE, STATE.clients[cid], stage);
      copyToClipboard(text);
      showToast('Copied.');
      break;
    }
    case 'reset-text': {
      delete editedTextCache[cid + '|' + stage];
      /* Reset means back to the shared template, so the SAVED row has to go
         as well. Clearing only the in-memory cache would appear to work and
         then bring the old wording back on the next reload. */
      var rtClient = STATE.clients[cid];
      if(rtClient && rtClient.messageTexts && rtClient.messageTexts[stage] != null){
        delete rtClient.messageTexts[stage];
        clearClientMessageText(cid, stage).then(function(r){
          if(!r.ok) showToast('Could not reset that wording: ' + r.error);
        });
      }
      renderCallsBoard();
      break;
    }
    case 'generate-ai':
      generateAIMessage(cid, stage, target);
      break;
    case 'snooze-touch':
      snoozeTouch(STATE, cid, stage);
      renderAll();
      showToast('Pushed to tomorrow.');
      break;
    case 'send-text':
      doSendText(cid, stage, target);
      break;
    case 'send-reply':
      doSendReply(cid, target);
      break;
    case 'open-thread': {
      /* Switch tab AND select, which 'msgx-open' alone does not do: it is
         fired from inside the workspace, where the tab is already showing. */
      UI.tab = 'threads';
      UI.threadCid = cid;
      UI.msgxOpened = cid;       // arriving from Today is also a choice
      UI.msgxPrefilled = null;   // a freshly opened thread gets its touch seeded
      document.querySelectorAll('.tab-btn').forEach(function(b){
        b.classList.toggle('active', b.getAttribute('data-tab') === 'threads'); });
      document.querySelectorAll('.tab-panel').forEach(function(pnl){
        pnl.classList.toggle('active', pnl.id === 'tab-threads'); });
      renderThreadsTab();
      break;
    }
    case 'confirm-send': {
      /* The person says it went. Recorded as its own state: weaker than a
         provider receipt, far stronger than a draft having been opened, and
         never silently upgraded to either. */
      var csC = STATE.clients[cid];
      var csM = csC && (csC.messageLog || []).filter(function(m){
        return m.id === target.getAttribute('data-mid'); })[0];
      if(!csM) break;
      lastSnapshot = snapshot();
      csM.deliveryStatus = 'sent_manual';
      saveState(STATE);
      renderAll();
      showToast('Recorded as sent to ' + firstName(csC.name) + '.', lastSnapshot);
      break;
    }
    case 'unsend-message': {
      /* It never went. The log row is removed, which puts the touch back on
         the list as though the draft had never been opened -- rather than
         leaving a message in the history that was never sent, and which
         every reply rate would then count against. */
      var usC = STATE.clients[cid];
      if(!usC) break;
      var usMid = target.getAttribute('data-mid');
      var before = (usC.messageLog || []).length;
      lastSnapshot = snapshot();
      usC.messageLog = (usC.messageLog || []).filter(function(m){ return m.id !== usMid; });
      if(usC.messageLog.length === before) break;
      saveState(STATE);
      renderAll();
      showToast('Put back on the list for ' + firstName(usC.name) + '.', lastSnapshot);
      break;
    }
    case 'toggle-text-today':
      setTextTodayOpen(!textTodayOpen());
      renderCallsBoard();
      break;
    case 'pw-stat':
      /* A count that cannot be clicked is a number somebody then has to go
         find. Same destination as Work the list, with the filter already
         matching whichever number was pressed. */
      UI.msgxFilter = target.getAttribute('data-filter') || 'all';
      UI.msgxQuery = '';
      var pwBox = el('msgx-search'); if(pwBox) pwBox.value = '';
      UI.tab = 'threads';
      document.querySelectorAll('.tab-btn').forEach(function(b){
        b.classList.toggle('active', b.getAttribute('data-tab') === 'threads'); });
      document.querySelectorAll('.tab-panel').forEach(function(pnl){
        pnl.classList.toggle('active', pnl.id === 'tab-threads'); });
      renderThreadsTab();
      break;
    case 'work-the-list': {
      /* Today -> the workspace, with the day's queue already selected.
         Deliberately does NOT pick a contact: the first one is a guess, and
         landing somebody in a conversation they did not choose is how the
         wrong person gets texted. */
      UI.tab = 'threads';
      /* 'needs' was not one of this strip's filters and never had been, so
         Work the list landed on the unfiltered queue with no chip lit. */
      UI.msgxFilter = 'action';
      UI.msgxQuery = '';
      var sbox = el('msgx-search'); if(sbox) sbox.value = '';
      document.querySelectorAll('.tab-btn').forEach(function(b){
        b.classList.toggle('active', b.getAttribute('data-tab') === 'threads'); });
      document.querySelectorAll('.tab-panel').forEach(function(pnl){
        pnl.classList.toggle('active', pnl.id === 'tab-threads'); });
      renderThreadsTab();
      break;
    }
    case 'msgx-handoff-send': {
      /* An arbitrary message, handed to Messages.

         Logged as 'custom' rather than against a sequence stage: these are
         words somebody typed, so crediting a touch would advance the cadence
         for a message that was not that touch. The touch panel above remains
         the only thing that can advance it. */
      var hc = STATE.clients[cid];
      if(!hc) break;
      var hbox = el('msgx-text');
      var htext = (hbox && hbox.value.trim()) || '';
      if(!htext){ showToast('Nothing to send yet.'); break; }
      var hdigits = String(hc.phone || '').replace(/\D/g, '');
      if(!hdigits){ showToast('That contact has no phone number.'); break; }
      window.open('sms:' + (hdigits.length === 10 ? '+1' + hdigits : '+' + hdigits) +
                  '&body=' + encodeURIComponent(htext), '_blank');
      markSentOnChannel(cid, 'custom', htext, 'sms');
      clearDraft(cid, 'sms');
      if(hbox) hbox.value = '';
      renderThreadsTab();
      showToast('Draft opened in Messages \u2014 logged as unconfirmed until you send it.');
      break;
    }
    case 'msgx-mark-sent': {
      /* The same doMarkSent the Today checkbox uses -- one way for a touch to
         become sent, so the two surfaces cannot disagree about the sequence. */
      lastSnapshot = snapshot();
      var msName = STATE.clients[cid] ? firstName(STATE.clients[cid].name) : 'them';
      doMarkSent(cid, stage);
      showToast('Marked sent for ' + msName + '.', lastSnapshot);
      break;
    }
    case 'msgx-section': {
      var sk = target.getAttribute('data-key');
      UI.msgxSections[sk] = !UI.msgxSections[sk];
      renderMsgxProfile();
      break;
    }
    case 'dlv-detail': {
      var dmid = target.getAttribute('data-mid');
      UI.dlvOpen = (UI.dlvOpen === dmid) ? null : dmid;
      renderMsgxThread();
      break;
    }
    case 'msgx-filter':
      UI.msgxFilter = target.getAttribute('data-filter') || 'all';
      renderThreadsTab();
      break;
    case 'msgx-open':
      /* Stash BEFORE the selection moves. stashDraft keys on UI.threadCid,
         so running it after the switch filed the previous contact's
         half-typed reply under the NEW one -- and opening Nick showed
         Julia's words in the box addressed to him. Order is the whole fix. */
      stashDraft();
      UI.threadCid = cid;
      UI.msgxOpened = cid;          // somebody chose this one
      /* Where they sat when opened. Finishing their task removes them from
         the queue, and by the time Next is pressed the list no longer
         contains them -- this is what lets nextInQueue hand back whoever
         moved up rather than skipping them. */
      UI.msgxIndex = currentQueueRows().findIndex(function(r){ return r.clientId === cid; });
      markConversationRead(cid, UI.msgxChannel);
      renderThreadsTab();
      break;
    case 'msgx-back':
      UI.threadCid = null;
      renderThreadsTab();
      break;
    case 'msgx-send':
      doMsgxSend(cid, target);
      break;
    case 'msgx-next': {
      var nrows = currentQueueRows();
      var nid = nextInQueue(nrows, UI.threadCid, UI.msgxIndex);
      if(!nid){
        showToast('That was the last one.');
        break;
      }
      stashDraft();
      UI.threadCid = nid;
      UI.msgxOpened = nid;
      UI.msgxIndex = nrows.findIndex(function(r){ return r.clientId === nid; });
      UI.msgxPrefilled = null;      // the new contact gets its own touch seeded
      markConversationRead(nid, UI.msgxChannel);
      renderThreadsTab();
      break;
    }
    case 'msgx-channel': {
      var newChan = target.getAttribute('data-channel') || 'sms';
      /* The draft for the channel being LEFT is kept before the switch, so
         half-typed words survive moving between tabs. */
      stashDraft();
      UI.msgxChannel = newChan;
      UI.msgxNote = newChan === 'notes';
      if(newChan !== 'notes') markConversationRead(UI.threadCid, newChan);
      renderThreadsTab();
      break;
    }
    case 'msgx-mode':
      UI.msgxMode = target.getAttribute('data-mode');
      // Kept in step so anything still reading the old flag stays correct.
      UI.msgxNote = UI.msgxMode === 'note';
      renderMsgxThread();
      break;
    case 'msgx-add-note':
      doAddNote(cid, target);
      break;
    case 'msgx-draft':
      doDraftReply(cid, target);
      break;
    case 'msgx-schedule':
      doScheduleSend(cid, target);
      break;
    case 'msgx-summarise':
      doSummarise(cid, target);
      break;
    case 'msgx-unschedule':
      doCancelScheduled(target.getAttribute('data-id'));
      break;
    case 'msgx-pause': {
      var days = parseInt(target.getAttribute('data-days'), 10) || 7;
      var until = new Date(Date.now() + days * 86400000).toISOString();
      lastSnapshot = snapshot();
      setAutomationPause(STATE, cid, until, '');
      saveState(STATE);
      renderAll();
      showToast('Follow-ups paused for ' + days + ' days.', lastSnapshot);
      break;
    }
    case 'msgx-resume':
      lastSnapshot = snapshot();
      setAutomationPause(STATE, cid, null, '');
      saveState(STATE);
      renderAll();
      showToast('Follow-ups running again.', lastSnapshot);
      break;
    case 'new-device-token':
      createDeviceToken(target);
      break;
    case 'revoke-device-token':
      revokeDeviceToken(target.getAttribute('data-id'));
      break;
    case 'open-sms':
      /* Recorded before the handoff to Messages, not 700ms after it.

         It used to wait 700ms and then look for the card's checkbox in the
         DOM, ticking it if it found one. Two ways that records nothing:

         1. By the time the timer fires, the OS has handed over to Messages
            and this page is in the background. A backgrounded tab can be
            suspended or discarded outright -- routine on iOS, possible
            anywhere -- and a pending setTimeout in a discarded page never
            runs. Ethan sent a morning's worth of texts this way and none of
            them were marked, which is exactly this shape: the sends that
            vanish are the ones where Messages took over fastest.
         2. The lookup is by rendered markup. Any re-render in that 700ms
            window, or any surface whose card has no checkbox, and the mark
            is silently skipped -- the `if(cb)` had no else.

         The state is the record and the checkbox is only a picture of it, so
         this writes the state and lets the next render redraw the checkbox.
         hasSentStage replaces `!cb.checked` as the double-send guard, which
         also makes it correct across a reload and in a second tab.

         Optimistic, like the email path: Ghost Recall cannot see whether Send
         was actually pressed in Messages, so this is logged and undoable
         rather than confirmed beforehand. */
      /* Same rule as doSendText, for the same reason: guarded with
         hasSentStage this logged nothing for a contact whose call had moved,
         so the text opened in Messages and left no record of itself. */
      if(STATE.clients[cid] && !touchAlreadySent(STATE.clients[cid], stage)){
        lastSnapshot = snapshot();
        var smsName = STATE.clients[cid].name, smsSnap = lastSnapshot;
        doMarkSent(cid, stage, true);
        /* Recorded as unverified, not sent. Messages has the draft; whether it
           was sent, edited or abandoned is not something this can see. The Mac
           agent upgrades it to delivered if it finds the real message later,
           which is the only honest route to a confirmed state. */
        var handed = STATE.clients[cid].messageLog[STATE.clients[cid].messageLog.length - 1];
        if(handed && !handed.deliveryStatus){ handed.deliveryStatus = 'unverified'; saveState(STATE); }
        // Shown with the deferred repaint, so it is waiting when they come
        // back from Messages. Optimistic marking needs a visible way out:
        // the one case this gets wrong is deciding not to press Send.
        setTimeout(function(){
          showToast('Marked as sent to ' + smsName + '.', smsSnap);
        }, 700);
      }
      break;
    case 'copy-remaining': {
      var items = getTextTodayList(STATE, new Date(), '');
      var dump = items.map(function(it){ return it.client.name + ' (' + it.stage + ')\n' + getCardText(STATE, it.client, it.stage); }).join('\n\n----------\n\n');
      copyToClipboard(dump);
      showToast('Copied ' + items.length + ' messages.');
      break;
    }
    case 'add-todo':
      addTodo();
      break;
    case 'delete-todo':
      lastSnapshot = snapshot();
      STATE.todos = STATE.todos.filter(function(t){ return t.id !== target.getAttribute('data-id'); });
      saveState(STATE); renderTodos();
      showToast('To-do deleted.', lastSnapshot);
      break;
    case 'hide-duplicate':
      lastSnapshot = snapshot();
      STATE.clients[cid].ignored = true;
      saveState(STATE); renderAll();
      showToast('Duplicate hidden.', lastSnapshot);
      break;
    case 'delete-client-quick': {
      lastSnapshot = snapshot();
      var deletedName = STATE.clients[cid] ? STATE.clients[cid].name : 'Client';
      deleteClient(STATE, cid);
      closeModal();
      renderAll();
      showToast(deletedName + ' deleted.', lastSnapshot);
      break;
    }
    case 'import-ics':
      el('overflow-menu').classList.add('hidden');
      openICSModal();
      break;
    case 'bulk-paste':
      el('overflow-menu').classList.add('hidden');
      openBulkPasteModal();
      break;
    case 'weekly-digest':
      el('overflow-menu').classList.add('hidden');
      openWeeklyDigestModal();
      break;
    case 'print-sheet':
      el('overflow-menu').classList.add('hidden');
      populatePrintSheet(STATE);
      window.print();
      break;
    case 'export-backup':
      el('overflow-menu').classList.add('hidden');
      exportBackup();
      break;
    case 'export-csv':
      el('overflow-menu').classList.add('hidden');
      exportClientsCsv();
      showToast('CSV exported.');
      break;
    case 'trigger-import-backup':
      el('overflow-menu').classList.add('hidden');
      el('import-backup-input').click();
      break;
    case 'copy-digest':
      copyToClipboard(el('digest-text').value);
      showToast('Digest copied.');
      break;
    case 'preview-bulk':
      pendingImport = parseBulkPaste(el('bulk-input').value);
      renderImportPreviewTable('bulk-preview', pendingImport, 'confirm-bulk-import');
      break;
    case 'confirm-bulk-import': {
      var toImport = pendingImport.filter(function(p){ return p.callDateTime; });
      var res = commitImportedClients(STATE, toImport);
      closeModal(); renderAll();
      showToast('Imported ' + res.added + ' new, updated ' + res.updated + '.');
      break;
    }
    case 'confirm-ics-import': {
      var res2 = commitImportedClients(STATE, pendingImport.filter(function(p){ return p.callDateTime; }));
      closeModal(); renderAll();
      showToast('Imported ' + res2.added + ' new, updated ' + res2.updated + ', ' + res2.rescheduled + ' rescheduled.');
      break;
    }
    case 'retry-save':
      // Forces the same pending diff at the database again; SYNCED was left
      // untouched by the failure, so nothing has been forgotten.
      saveState(STATE);
      break;
    case 'focus-start':
      startFocusMode();
      break;
    case 'focus-send':
      // The anchor's own navigation opens Messages; this records the send.
      focusSend();
      break;
    case 'focus-send-provider':
      focusSendProvider(target);
      break;
    case 'focus-copy': {
      var ft = el('focus-text');
      if(ft) copyToClipboard(ft.value);
      focusSend();
      break;
    }
    case 'focus-skip':
      focusAdvance();
      break;
    case 'skip-touch': {
      lastSnapshot = snapshot();
      var skName = STATE.clients[cid] ? STATE.clients[cid].name : 'this contact';
      skipTouch(STATE, cid, stage);
      renderAll();
      showToast('Skipped for ' + skName + '. It will not come back.', lastSnapshot);
      break;
    }
    case 'focus-skip-forever': {
      var fs = FOCUS.queue[FOCUS.i];
      skipTouch(STATE, fs.cid, fs.stage);
      focusAdvance();
      break;
    }
    case 'focus-snooze': {
      var fc = FOCUS.queue[FOCUS.i];
      snoozeTouch(STATE, fc.cid, fc.stage, new Date());
      focusAdvance();
      break;
    }
    case 'focus-exit':
      exitFocusMode();
      break;
    case 'resolve-stale': {
      lastSnapshot = snapshot();
      var mode = target.getAttribute('data-mode');
      var res = resolveStaleCalls(STATE, mode, 30, new Date());
      renderEndOfDay();
      renderAll();
      showToast(res.count + ' old ' + (res.count === 1 ? 'call' : 'calls') + ' ' +
        (mode === 'archive' ? 'archived — they stay out of your rates either way'
                            : 'marked ' + (mode === 'showed' ? 'showed' : 'no-show')) + '.',
        lastSnapshot);
      break;
    }
    case 'eod-outcome':
      lastSnapshot = snapshot();
      setOutcome(STATE, cid, target.getAttribute('data-status'));
      // Re-render in place rather than closing: the point is to clear a list,
      // and a modal that shuts after every click turns 44 items into 44 trips.
      // Only while the modal is actually open — these same buttons now appear
      // on the Today tab, where popping End of day open would be a jump scare.
      if(el('modal-root') && el('modal-root').innerHTML) renderEndOfDay();
      renderAll();
      break;
    case 'eod-close':
      STATE.clients[cid].closeOutcome = target.getAttribute('data-close');
      saveState(STATE);
      renderEndOfDay();
      renderAll();
      break;
    case 'eod-todo':
      STATE.todos.forEach(function(t){
        if(t.id === target.getAttribute('data-id')){ t.done = true; t.doneAt = nowISO(); }
      });
      saveState(STATE);
      renderEndOfDay();
      renderAll();
      break;
    case 'end-of-day':
      openEndOfDayModal();
      break;
    case 'undo-toast':
      if(target.__undoJson) restoreSnapshot(target.__undoJson);
      target.closest('.toast').remove();
      break;
    case 'edit-variant': {
      var ed = document.querySelector('[data-editor="' + target.getAttribute('data-stage')
        + '|' + target.getAttribute('data-id') + '"]');
      if(ed) ed.classList.toggle('hidden');
      break;
    }
    case 'retire-variant': {
      var qstage = target.getAttribute('data-stage');
      var qid = target.getAttribute('data-id');
      var qwant = target.getAttribute('data-want') === '1';
      var qr = retireVariant(STATE, qstage, qid, qwant);
      if(!qr.ok){ showToast(qr.error); break; }
      saveState(STATE);
      renderVariantsTab();
      showToast(qwant ? 'Stopped. It keeps its record.' : 'Back in rotation.');
      break;
    }
    case 'cancel-variant': {
      renderVariantsTab();
      break;
    }
    case 'save-variant': {
      var vstage = target.getAttribute('data-stage');
      var vid = target.getAttribute('data-id');
      var ed2 = document.querySelector('[data-editor="' + vstage + '|' + vid + '"]');
      var ta2 = ed2 && ed2.querySelector('textarea');
      var r = editVariant(STATE, vstage, vid, ta2 ? ta2.value : '');
      if(!r.ok){
        // 'unchanged' is not a failure worth a red bar, but silence after
        // pressing Save reads as a bug.
        showToast(r.error === 'unchanged' ? 'That is the same wording.' : 'Could not save: ' + r.error);
        break;
      }
      saveState(STATE);
      renderVariantsTab();
      showToast(r.action === 'forked'
        ? 'Saved as a new wording, starting from zero. The old one kept its '
          + r.keptSends + ' sends and retired.'
        : 'Wording updated.');
      break;
    }
    case 'touch-prev':
    case 'touch-next': {
      var tcid = target.getAttribute('data-cid');
      var tclient = STATE.clients[tcid];
      if(!tclient) break;
      var tpend = (cadenceProgress(tclient, new Date()).pendingStages) || [];
      var at = tpend.indexOf(target.getAttribute('data-stage'));
      if(at === -1) break;
      var to = at + (action === 'touch-next' ? 1 : -1);
      if(to < 0 || to >= tpend.length) break;
      UI.touchPick[tcid] = tpend[to];
      // Re-render rather than patch: the card's every control carries
      // data-stage, and a half-swapped card would send one touch while
      // logging another.
      renderCallsBoard();
      break;
    }
    case 'add-variant': {
      var stg = target.getAttribute('data-stage');
      var input2 = document.querySelector('[data-stage-input="'+stg+'"]');
      var val = input2 && input2.value.trim();
      if(val){
        var newId = stg + '_custom_' + Date.now().toString(36);
        STATE.variants[stg].push({id:newId, text:val, needsChannel:/\{channel\}/.test(val), builtin:false});
        STATE.variantStats[stg][newId] = {sends:0,responses:0};
        saveState(STATE);
        input2.value='';
        renderVariantsTab();
      }
      break;
    }
    case 'toggle-todo':
      STATE.todos.forEach(function(t){ if(t.id === target.getAttribute('data-id')){ t.done = !t.done; t.doneAt = t.done ? nowISO() : null; } });
      saveState(STATE); renderTodos();
      break;
    default: break;
  }
});


document.addEventListener('change', function(ev){
  var t = ev.target;
  if(t.getAttribute && t.getAttribute('data-action') === 'team-assign'){
    assignFromPicker(t);
    return;
  }
  /* The change handler dispatches its own actions -- the settings selects,
     the sent checkbox, the client fields -- so the gate has to be here too.
     Blocking only the click path would leave every dropdown in Settings
     live on a read-only account. */
  if(t.getAttribute && isReadOnlyBlocked(t.getAttribute('data-action'))
     && !billingAllowsWrite(billingState())){
    showBillingWall();
    renderAll();   // put the control back to what the state actually says
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'msgx-email-template'){
    var etpCid = t.getAttribute('data-cid'), etpId = t.value;
    var etpClient = STATE.clients[etpCid];
    if(etpId && etpClient){
      var doc = renderEmailDoc(STATE, etpId, etpClient, STATE.senderName);
      /* A library row can be deleted in another tab between this list being
         drawn and somebody picking from it. renderEmailDoc answers null for
         that, and blanking the composer would read as the app losing what
         they had typed. */
      if(doc){
        var sj = el('msgx-subj'), bd = el('msgx-email');
        if(sj) sj.value = doc.subject || '';
        if(bd){ bd.value = doc.text || ''; bd.focus(); }
      } else {
        showToast('That template is no longer in your library.');
      }
    }
    t.value = '';
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'msgx-template'){
    var tpCid = t.getAttribute('data-cid'), tpStage = t.value;
    var tpBox = el('msgx-text');
    if(tpStage && tpBox && STATE.clients[tpCid]){
      /* Replaces whatever is in the box. Appending would silently glue two
         messages together, and somebody who picked a template after typing
         meant to start over. */
      tpBox.value = getCardText(STATE, STATE.clients[tpCid], tpStage);
      tpBox.focus();
    }
    t.value = '';          // back to the prompt, so it reads as an action
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'msgx-status'){
    var stCid = t.getAttribute('data-cid');
    var stClient = STATE.clients[stCid];
    if(stClient){
      lastSnapshot = snapshot();
      var wasStatus = stClient.status;
      setOutcome(STATE, stCid, t.value);
      /* renderAll, not just this pane. A status that stops the cadence
         changes what is due, which changes the queue, the chip counts and
         the Today list. Redrawing one pane would leave three surfaces
         disagreeing about the same contact. */
      renderAll();
      showToast(firstName(stClient.name) + ': ' + wasStatus + ' \u2192 ' + t.value + '.', lastSnapshot);
    }
    return;
  }
  /* Tailored wording, saved when the box loses focus rather than on every
     keystroke -- one row per contact per touch, not one write per letter.

     editedTextCache is cleared on the way through. It is checked FIRST by
     getCardText, so leaving the typed value in it would shadow the saved
     row and the two could drift apart without anything showing it. */
  if(t.getAttribute && t.getAttribute('data-action') === 'edit-text'){
    var etCid = t.getAttribute('data-cid'), etStage = t.getAttribute('data-stage');
    var etClient = STATE.clients[etCid];
    if(etClient && OVERRIDABLE_STAGES.indexOf(etStage) !== -1){
      var etOriginal = getOriginalText(STATE, etClient, etStage);
      var etValue = t.value;
      etClient.messageTexts = etClient.messageTexts || {};
      delete editedTextCache[etCid + '|' + etStage];
      if(!etValue.trim() || etValue === etOriginal){
        /* Back to the template. The row is removed rather than stored as a
           copy of the template -- an override that happens to equal the
           template would freeze this contact out of future template edits
           and out of the A/B learning, silently. */
        delete etClient.messageTexts[etStage];
        clearClientMessageText(etCid, etStage).then(function(r){
          if(!r.ok) showToast('Could not reset that wording: ' + r.error);
        });
      } else {
        etClient.messageTexts[etStage] = etValue;
        saveClientMessageText(etCid, etStage, etValue).then(function(r){
          showToast(r.ok
            ? 'Saved \u2014 ' + firstName(etClient.name) + ' only.'
            : 'Could not save that wording: ' + r.error);
        });
      }
      renderCallsBoard();
    }
    return;
  }
  if(SETTINGS_DRAFT && t.getAttribute && t.getAttribute('data-action') === 'set-step-stage'){
    var ssI = parseInt(t.getAttribute('data-idx'), 10);
    if(SETTINGS_DRAFT.sequence[ssI]){
      SETTINGS_DRAFT.sequence[ssI].stage = t.value;
      // The key is only an identifier, but a step whose key says 'dayof'
      // while its stage says 'monday' is a trap for the next reader.
      SETTINGS_DRAFT.sequence[ssI].key = t.value;
      renderSettingsModal();
    }
    return;
  }
  if(SETTINGS_DRAFT && t.getAttribute && t.getAttribute('data-action') === 'set-step-trigger'){
    var stI = parseInt(t.getAttribute('data-idx'), 10);
    if(SETTINGS_DRAFT.sequence[stI]){
      SETTINGS_DRAFT.sequence[stI] = retargetStep(SETTINGS_DRAFT.sequence[stI], t.value);
      // Re-rendered because the number field appears, disappears or changes
      // unit with the trigger.
      renderSettingsModal();
    }
    return;
  }
  if(SETTINGS_DRAFT && t.getAttribute && t.getAttribute('data-action') === 'set-step-param'){
    var spI = parseInt(t.getAttribute('data-idx'), 10);
    var spStep = SETTINGS_DRAFT.sequence[spI];
    if(spStep){
      var spChoice = cadenceTriggerChoice((spStep.trigger || {}).type);
      if(spChoice && spChoice.param){
        /* Clamped in the model, not just by the input's min/max. A number
           field accepts anything when typed into, and a 0 or a blank here
           would reach the evaluator as a trigger with no timing. */
        spStep.trigger[spChoice.param] = clampCadenceParam(spChoice, t.value);
        renderSettingsModal();
      }
    }
    return;
  }
  if(SETTINGS_DRAFT && t.getAttribute && t.getAttribute('data-action') === 'set-step-every'){
    var seI = parseInt(t.getAttribute('data-idx'), 10);
    var seStep = SETTINGS_DRAFT.sequence[seI];
    if(seStep && seStep.trigger){
      var every = Math.round(Number(t.value));
      if(!isFinite(every) || every < 1) every = 1;
      if(every > 365) every = 365;
      seStep.trigger.everyDays = every;
      renderSettingsModal();
    }
    return;
  }
  if(SETTINGS_DRAFT && t.getAttribute && t.getAttribute('data-action') === 'set-stage-role'){
    var ri = parseInt(t.getAttribute('data-idx'), 10);
    if(SETTINGS_DRAFT.pipeline[ri]) SETTINGS_DRAFT.pipeline[ri].role = t.value;
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'mark-sent'){
    var cid = t.getAttribute('data-cid'), stage = t.getAttribute('data-stage');
    if(t.checked) doMarkSent(cid, stage);
  }
  if(t.id === 'epsilon-slider'){
    STATE.epsilon = parseFloat(t.value);
    saveState(STATE);
    el('epsilon-val').textContent = STATE.epsilon.toFixed(2);
  }
  if(t.id === 'f-tz'){ t.setAttribute('data-touched', '1'); }
  /* An edited email saves itself when you leave the field.

     Everything else in the app works this way -- a contact's notes, its
     recap, its phone number. The library alone required pressing Save, so
     editing an email and clicking away lost the edit silently. That is both
     friction and a data loss, and the inconsistency is its own problem:
     having learned that typing is enough everywhere else, nobody goes
     looking for a button here.

     On change rather than on input, so it saves when you leave a field
     instead of on every keystroke. */
  /* A text input, so it belongs on change rather than in the click switch --
     a click handler would never fire for typing, and the link would appear to
     save while never being written. */
  if(t.getAttribute && t.getAttribute('data-action') === 'set-booking-link'){
    STATE.bookingLink = t.value.trim();
    setBookingLink(STATE.bookingLink);
    saveState(STATE);
    renderAll();
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'set-email-doc'){
    var edoc = findEmailDoc(t.getAttribute('data-id'));
    if(edoc){
      edoc[t.getAttribute('data-field')] = t.value;
      edoc.updatedAt = new Date().toISOString();
      saveState(STATE);
      renderEmailLibrary();
    }
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'save-client-field'){
    var cid2 = t.getAttribute('data-cid'), field = t.getAttribute('data-field');
    if(applyClientFieldEdit(t)){
      renderAll();
      // the call-time field is displayed in the client's own zone, so a
      // timezone change needs the modal itself re-drawn to stay correct
      if(field === 'timezone') openClientModal(cid2);
    }
  }
  if(t.id === 'ics-file' && t.files && t.files[0]){
    var reader = new FileReader();
    reader.onload = function(){
      var events = parseICS(reader.result);
      pendingImport = events.map(clientFromICSEvent).filter(Boolean);
      renderImportPreviewTable('ics-preview', pendingImport, 'confirm-ics-import');
    };
    reader.readAsText(t.files[0]);
  }
  if(t.id === 'import-backup-input' && t.files && t.files[0]){
    var reader2 = new FileReader();
    reader2.onload = function(){
      try{
        var parsed = JSON.parse(reader2.result);
        STATE = migrateState(parsed);
        saveState(STATE);
        renderAll();
        showToast('Backup imported.');
      }catch(e){ showToast('That file could not be read as a Ghost Recall backup.'); }
    };
    reader2.readAsText(t.files[0]);
    t.value = '';
  }
});


document.addEventListener('input', function(ev){
  var t = ev.target;
  /* On INPUT, not change. A text field fires change only on blur, so the
     handler sat in the change listener and typing a hex previewed nothing
     until focus left -- which for a colour picker is the entire point gone.
     input also fires continuously while a colour wheel is dragged, which is
     what makes the preview live. */
  if(t.getAttribute && (t.getAttribute('data-action') === 'theme-color' ||
                        t.getAttribute('data-action') === 'theme-hex')){
    var tf = t.getAttribute('data-field');
    var val = t.value;
    /* The hex box accepts whatever is being typed and only commits once it
       parses. Rejecting every keystroke would make it impossible to type
       '#dc2f4a' at all, since the first five are not a colour. */
    var rgb = hexToRgb(val);
    if(!rgb) return;
    var d = themeDraft();
    d.colors[tf] = rgbToHex(rgb);
    d.preset = 'custom';
    applyTheme(d);
    /* Only the partner control is updated, never the field being typed in:
       rewriting it would move the caret to the end on every character. */
    var partner = document.querySelector('[data-action="' +
      (t.getAttribute('data-action') === 'theme-hex' ? 'theme-color' : 'theme-hex') +
      '"][data-field="' + tf + '"]');
    if(partner) partner.value = d.colors[tf];
    refreshThemeMeta();
    return;
  }

  // Settings edits land in the draft, never in STATE — the modal is only
  // committed on save, so a stage mid-rename never reaches computeDue.
  // Deliberately no re-render on keystroke: rebuilding the modal would steal
  // focus and drop the caret mid-word.
  var sa = t.getAttribute && t.getAttribute('data-action');
  if(SETTINGS_DRAFT && sa === 'set-stage-label'){
    var si = parseInt(t.getAttribute('data-idx'), 10);
    if(SETTINGS_DRAFT.pipeline[si]) SETTINGS_DRAFT.pipeline[si].label = t.value;
    return;
  }
  if(ONBOARDING && sa === 'ob-term'){
    ONBOARDING.terminology[t.getAttribute('data-key')] = t.value;
    return;   // no re-render: rebuilding the modal would steal focus mid-word
  }
  if(sa === 'lib-preview'){
    LIB_PREVIEW[t.getAttribute('data-id')] = t.value;
    renderEmailLibrary();
    return;
  }
  if(sa === 'np-client'){
    NOTES_PANEL.cid = t.value;
    // Pull across whatever is already on the contact, so notes written
    // earlier are not silently replaced by an empty box.
    var npc = STATE.clients[t.value];
    if(npc && !NOTES_PANEL.notes.trim()) NOTES_PANEL.notes = npc.recap || '';
    NOTES_PANEL.draft = null;
    renderEmailLibrary();
    return;
  }
  if(sa === 'np-notes'){
    NOTES_PANEL.notes = t.value;
    // No re-render: it would steal focus mid-sentence. The buttons enable on
    // the next render, which the select or a button press triggers.
    var npBtns = document.querySelectorAll('[data-action^="np-draft"], [data-action="np-save"]');
    for(var npI = 0; npI < npBtns.length; npI++){
      npBtns[npI].disabled = !(NOTES_PANEL.cid && t.value.trim());
    }
    return;
  }
  if(sa === 'np-edit'){
    if(NOTES_PANEL.draft) NOTES_PANEL.draft[t.getAttribute('data-field')] = t.value;
    return;   // no re-render: it would steal focus mid-sentence
  }
  if(sa === 'set-email-doc'){
    var doc = findEmailDoc(t.getAttribute('data-id'));
    if(doc) doc[t.getAttribute('data-field')] = t.value;
    return;   // no re-render: it would steal focus mid-sentence
  }
  if(sa === 'set-email-tpl'){
    var est = t.getAttribute('data-stage');
    var fld = t.getAttribute('data-field');
    if(!STATE.emailVariants) STATE.emailVariants = {};
    var list = STATE.emailVariants[est] = (STATE.emailVariants[est] || []);
    var ownIdx = -1;
    list.forEach(function(v, i){ if(!v.builtin && ownIdx === -1) ownIdx = i; });
    if(ownIdx === -1){
      // A stage's own template is created the moment someone types in it, and
      // given a stable key so edits land on the same row rather than piling up.
      list.push({id: 'own-' + est, subject: '', text: '', builtin: false, channel: 'email'});
      ownIdx = list.length - 1;
    }
    list[ownIdx][fld] = t.value;
    return;   // no re-render: it would steal focus mid-sentence
  }
  if(sa === 'set-cal-words'){
    var cfw = STATE.calendarFilter || {mode:'keywords'};
    // Split on commas, drop blanks — an empty term would match every event.
    cfw[t.getAttribute('data-key')] = t.value.split(',')
      .map(function(x){ return x.trim(); })
      .filter(function(x){ return x.length; });
    STATE.calendarFilter = cfw;
    return;
  }
  if(sa === 'set-email-field'){
    // Written straight to STATE rather than the settings draft: these are
    // account credentials-ish plumbing, not part of the pipeline edit that
    // Save commits, and half-typing an address should not block saving stages.
    STATE[t.getAttribute('data-key')] = t.value.trim() || null;
    return;
  }
  if(SETTINGS_DRAFT && sa === 'set-term'){
    SETTINGS_DRAFT.terminology[t.getAttribute('data-key')] = t.value;
    return;
  }
  if(t.getAttribute && t.getAttribute('data-action') === 'edit-text'){
    var cid = t.getAttribute('data-cid'), stage = t.getAttribute('data-stage');
    var original = getOriginalText(STATE, STATE.clients[cid], stage);
    if(t.value === original) delete editedTextCache[cid+'|'+stage];
    else editedTextCache[cid+'|'+stage] = t.value;
  }
  if(t.id === 'calls-search'){ UI.callsSearch = t.value; renderCallsBoard(); }
  if(t.id === 'clients-search'){ UI.clientsSearch = t.value; renderClientsTab(); }
  /* Only the list is redrawn. Running the whole tab render would rebuild the
     thread pane under the reader and jump it back to the bottom on every
     keystroke. */
  if(t.id === 'msgx-search'){
    UI.msgxQuery = t.value;
    var allRows = conversationList(STATE, new Date());
    renderMsgxList(filterConversationsBy(allRows, UI.msgxFilter, UI.msgxQuery),
                   allRows.filter(function(r){ return r.awaitingReply; }).length,
                   allRows.length);
  }
  if(t.id === 'f-phone'){
    // Keep the timezone guess in sync with the phone as it's typed, but stop
    // once the user has explicitly picked a zone themselves (see the
    // 'change' handler below, which sets data-touched on that select).
    var tzSelect = el('f-tz');
    if(tzSelect && !tzSelect.getAttribute('data-touched')){
      tzSelect.value = timezoneForClient(t.value, 'America/New_York');
    }
  }
});


document.addEventListener('keydown', function(ev){
  if(isTypingTarget(ev.target)) return;
  if(ev.key === 'Escape'){ closeModal(); return; }
  // Focus mode owns the keyboard while it is open, so the global shortcuts
  // below (tab numbers, search) cannot fire underneath it.
  if(FOCUS){
    var typing = ev.target && ev.target.id === 'focus-text';
    if(ev.key === 'Escape'){ ev.preventDefault(); exitFocusMode(); return; }
    if(ev.key === 'Enter' && !typing){
      ev.preventDefault();
      /* Whichever send action this contact actually has -- and if it has
         none, Enter does nothing.

         It used to read `if(sendLink) sendLink.click(); else focusSend()`,
         so a contact with no send button still got marked as sent by the
         Enter key. That was harmless while the only buttonless case was a
         missing phone number. It is not harmless now: an opted-out contact
         has no send button, and the fallback would have logged a text to
         someone who replied STOP without anything appearing on screen. */
      var sendEl = document.querySelector('[data-action=focus-send], [data-action=focus-send-provider]')
        || document.querySelector('[data-action=focus-copy]');
      if(sendEl) sendEl.click();
      return;
    }
    if((ev.key === 's' || ev.key === 'S') && !typing){ ev.preventDefault(); focusAdvance(); return; }
    return;
  }
  if(ev.key === '/'){ ev.preventDefault(); var s = el('calls-search'); if(s){ UI.tab='calls'; document.querySelector('[data-action=tab][data-tab=calls]').click(); s.focus(); } return; }
  // Kept in step with the tab bar, including Closed and the Graveyard — a
  // shortcut that stops halfway along the row is worse than none.
  if(['1','2','3','4','5','6','7','8'].indexOf(ev.key) !== -1){
    // Kept in step with the tab bar. Texts sits third there, so it does here.
    var tabs = ['calls','clients','threads','variants','weekly','calendar','closed','dead'];
    var btn = document.querySelector('[data-action=tab][data-tab="'+tabs[+ev.key-1]+'"]');
    if(btn) btn.click();
  }
});


// Fire-and-forget: builtin (shared) templates pool their sends/responses
// across every account via increment_builtin_stat (atomic +1, so this can
// never be used to set the count to anything arbitrary). Custom/hand-added
// variants aren't pooled — their stats stay purely in this account's own
// variant_stats row, already handled by saveState().
function pooledIncrementIfBuiltin(stage, variantId, field, delta){
  // Accounts that don't log replies don't get to move the shared numbers —
  // their sends are guaranteed-zero-reply and drag every variant they touch
  // down the ranking. See the pools_learning migration.
  if(!STATE.poolsLearning) return;
  var variant = (STATE.variants[stage] || []).filter(function(v){ return v.id === variantId; })[0];
  if(!variant || !variant.builtin) return;
  window.GB_SUPABASE.rpc('increment_builtin_stat', {p_stage: stage, p_variant_key: variantId, p_field: field, p_delta: delta || 1})
    .then(function(res){ if(res.error) console.error('pooled stat increment failed', res.error); });
}

/* The outcome buttons, with the shared numbers kept in step.

   This is the route that actually gets used. recordInteractionOutcome
   resolves the reply question as a side effect of the salesperson saying
   what happened -- which is the right design -- but it lives in logic.js and
   logic.js has no way to reach Supabase, so the pooled table never heard
   about any of it.

   Worth recording how close I came to missing this. I found the pooled table
   empty, traced it to the "replied"/"no reply" buttons calling reviewMessage
   directly, fixed those, deployed, and reported it solved. Those two buttons
   are dead code: a commit on 22 September replaced that whole review queue
   with these outcome buttons and left the handlers behind. I had patched the
   path nobody walks. What gave it away was the review rate by week -- 94% in
   August, then exactly 0% from 28 September, which no gradual habit decays
   into.

   So this wraps the live path the same way, reading the message state before
   recordInteractionOutcome mutates it. */
function doInteractionOutcome(cid, outcomeKey, extra){
  var client = STATE.clients[cid];
  if(!client) return;
  // Which message this outcome is about, and what it looked like beforehand.
  var inter = lastInteraction(client, new Date());
  var msg = inter.idx !== -1 ? client.messageLog[inter.idx] : null;
  var wasReviewed = msg ? !!msg.reviewed : false;
  var wasReplied = msg ? !!msg.responded : false;

  recordInteractionOutcome(STATE, cid, outcomeKey, extra);

  if(!msg || !msg.reviewed) return;      // nothing was resolved
  var didReply = !!msg.responded;
  if(!wasReviewed){
    pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'sends');
    if(didReply) pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'responses');
  } else if(didReply !== wasReplied){
    pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'responses', didReply ? 1 : -1);
  }
}

/* Every route that reviews a message, and the only place pooled numbers move.

   The pooled table held 370 sends and zero responses -- every row, across
   every variant, while the real reply rates ran 6% to 43%. Two separate
   faults produced that, and either alone would have been enough:

     1. Replies were recorded only here, from the old checkbox. The buttons
        people actually press -- "replied" and "no reply" -- called
        reviewMessage directly and touched nothing. So responses never moved.
     2. Sends were counted at SEND time, by doMarkSent and markSentOnChannel,
        while responses were counted at review time. Mismatched denominators:
        the pooled rate was diluted by every message nobody had got to yet.

   The second is the mistake markSent's own comment describes and refuses to
   make for per-account stats -- "an unreviewed send is simply absent from the
   math instead of being counted as a failure" -- reintroduced one layer out.

   The damage was not cosmetic. This account is the only one with pooled
   learning on, and loadState OVERWRITES its per-account stats with the
   pooled rows, so pickVariant was scoring every builtin message at
   (0+1)/(sends+2). That is not a bandit; it is a counter that prefers
   whatever has been used least. It had not been learning for as long as the
   pooled table has existed.

   So: one helper, mirroring reviewMessage's own accounting exactly. A send
   enters the pooled denominator at the same moment it enters the per-account
   one, and never before. */
function doReviewMessage(cid, idx, didReply){
  var client = STATE.clients[cid];
  var msg = client && client.messageLog[idx];
  if(!msg) return;
  // Read BEFORE reviewMessage mutates the row, or "was this already
  // reviewed" is always true and a first review never counts its send.
  var wasReviewed = !!msg.reviewed;
  var wasReplied = !!msg.responded;

  reviewMessage(STATE, cid, idx, didReply);

  /* No 'custom' check here: pooledIncrementIfBuiltin already refuses any
     variant that is not in this account's list and flagged builtin, and
     'custom' is in neither. A second guard would read as load-bearing while
     being impossible to fail -- mutation proved it. */
  if(!wasReviewed){
    pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'sends');
    if(didReply) pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'responses');
  } else if(didReply !== wasReplied){
    // Changed their mind. The pooled table needs the matching ±1 or it
    // drifts from the per-message truth forever.
    pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'responses', didReply ? 1 : -1);
  }
}

// The old checkbox: ticking means "yes they replied", unticking "no". Routed
// through the same helper so it cannot drift from the buttons.
function doToggleReplied(cid, idx){
  var client = STATE.clients[cid];
  var msg = client && client.messageLog[idx];
  if(!msg) return;
  doReviewMessage(cid, idx, !msg.responded);
}

/* Records a send on a specific channel.

   markSent assumes SMS, because that was the only channel when it was written.
   An email sent through Gmail still has to advance the cadence and count in
   the stats, or the touch simply fires again tomorrow as though nothing
   happened. */
/* What the sync actually did, said out loud.

   This used to sum `added` and `updated` across calendars and print the
   total. Which meant three completely different outcomes produced the same
   reassuring sentence — "Synced: 0 new, 0 updated":

     - the token refresh failed, so nothing was even fetched
     - events were fetched and the calendar filter matched none of them
     - there genuinely was nothing new

   The function has always returned a per-calendar `error` for the first case.
   The app threw it away. So somebody whose sync had been broken for a week
   got a green toast telling them it worked, every time they pressed the
   button, and the only way to find out otherwise was to open dev tools.

   An error is now the headline, because it is the only one of the three the
   person can act on. */
function describeSyncResult(cals){
  var failed = cals.filter(function(c){ return c && c.error; });
  var added = 0, updated = 0, scanned = 0, filteredOut = 0;
  cals.forEach(function(c){
    added += c.added || 0; updated += c.updated || 0;
    scanned += c.scanned || 0; filteredOut += c.filteredOut || 0;
  });

  if(failed.length === cals.length){
    var why = String(failed[0].error || '');
    // A refresh failure is the one with a specific, actionable cause, and it
    // is the likeliest: the Google consent screen expires refresh tokens
    // every 7 days while it is still in Testing.
    var reconnect = /refresh|invalid_grant|unauthorized|401/i.test(why);
    return {
      ok: false,
      text: reconnect
        ? 'Calendar not connected any more — Google expired the connection. Reconnect the calendar and it will pick up today\'s bookings.'
        : 'Sync could not reach your calendar. Nothing was changed. Details are in the console.',
      detail: why
    };
  }

  if(failed.length){
    return {
      ok: true,
      text: added + ' new, ' + updated + ' updated — but ' + failed.length +
        ' of ' + cals.length + ' calendars failed. ' + (failed[0].calendar || '') + ' did not sync.',
      detail: String(failed[0].error || '')
    };
  }

  if(!added && !updated && scanned > 0){
    // The filter case. Nothing is wrong with the connection, and this is the
    // state two people onboarding sat in for days with an empty app.
    return {
      ok: true,
      text: 'Read ' + scanned + ' events and none of them looked like a booking. ' +
        'Check which events count as bookings in Settings → Calendar.',
      detail: 'scanned ' + scanned + ', filtered out ' + filteredOut
    };
  }

  /* Deliberately NOT special-casing scanned === 0 here.

     The first version of this change did, and a test already in the suite
     caught it: "a genuinely quiet calendar is not dressed up as a problem".
     That is right. For somebody who syncs every day, nothing read means
     nothing new, and alarming them about an empty window would be wrong.

     The same result means something else entirely to somebody who connected a
     minute ago and has no contacts at all — and that difference is about who
     is asking, not about the sync. It is handled where that is known, in
     noteCalendarReturn. */
  if(!added && !updated){
    return {ok: true, text: 'Already up to date — nothing new on the calendar.', detail: null};
  }

  return {ok: true, text: 'Synced: ' + added + ' new, ' + updated + ' updated.', detail: null};
}

function markSentOnChannel(cid, stage, text, channel){
  var client = STATE.clients[cid];
  if(!client) return;
  markSent(STATE, cid, stage, text);
  var logged = client.messageLog[client.messageLog.length - 1];
  if(logged){
    logged.channel = channel || 'sms';
    // Only SMS templates carry the shared bandit stats. Crediting an email
    // send to an SMS variant would make both numbers meaningless.
    /* No pooled 'sends' here. It is counted when the message is reviewed,
       alongside the per-account one -- see doReviewMessage. Counting it now
       put every unreviewed send in the denominator and none of them in the
       numerator. */
  }
  saveState(STATE);
}

/* Send a text from the team's own number, through send-sms.

   The opposite of the sms: handoff in one way that matters: this one knows
   whether it worked. The handoff is optimistic -- Ghost Recall cannot see
   whether Send was ever pressed in Messages, so it logs first and offers an
   undo. Here the provider either accepted the message or it did not, so
   nothing is logged until it did. An optimistic log on this path would
   invent sends that never left.

   The server does the logging, because provider_id is minted there and it is
   the only thing tying a reply or a receipt back to this message. The local
   log then adopts the server's row id, so the next save upserts onto that row
   rather than creating a second one -- 297 duplicate rows have already
   inflated every reply figure in this product once. */
/* A free-text reply inside a conversation.

   Deliberately NOT routed through markSent. markSent picks a cadence variant,
   scores it, and advances Booked -> Confirmed -> Reminded as reminders go
   out. None of that is true of answering a question: a reply to "can we push
   to Friday?" is not a touch in the sequence, and letting it advance the
   status would move somebody to Reminded for a message that reminded them of
   nothing. It is logged against 'custom' for the same reason a hand-edited
   send is -- it is nobody's template, so it must not move any template's
   numbers. */
/* Device tokens: the credential the Mac agent uses.

   Shown once at creation and never recoverable -- the server keeps only a
   hash. That is deliberate: a list of machines somebody has connected is
   useful to see, and a list of working credentials is not something this
   screen should be able to hand out twice. */
var SETUP_BADGES = {
  on:      ['In use',          'setup-on'],
  standby: ['Standby',         'setup-standby'],
  soon:    ['Coming soon',     'setup-soon'],
  test:    ['Test only',       'setup-test'],
  stalled: ['Needs attention', 'setup-bad'],
  off:     ['Not connected',   'setup-off']
};

function renderMessagingSetup(){
  var box = el('messaging-setup'); if(!box) return;
  var setup = messagingSetup(STATE, new Date());
  box.innerHTML = setup.modes.map(function(m){
    var badge = SETUP_BADGES[m.status] || SETUP_BADGES.off;
    return '<div class="setup-row"><div class="setup-head">' +
      '<span class="setup-title">' + escapeHtml(m.title) + '</span>' +
      '<span class="setup-badge ' + badge[1] + '">' + escapeHtml(badge[0]) + '</span>' +
      '</div><div class="setup-detail">' + escapeHtml(m.detail) + '</div></div>';
  }).join('');
}

function renderDeviceTokens(){
  var box = el('device-tokens'); if(!box) return;
  /* Guarded, because this is a small corner of a big screen.

     Business settings carries the pipeline, the cadence editor, terminology
     and the save button. A list of connected Macs failing -- an older client
     library, a table that is not there yet -- must not take all of that down
     with it. A test caught exactly that: the whole settings modal threw. */
  var q;
  try {
    q = window.GB_SUPABASE.from('device_tokens')
      .select('id,label,created_at,last_seen_at,revoked_at')
      .order('created_at', {ascending:false});
  } catch(e) {
    box.innerHTML = '<div class="hint">Could not check connected Macs.</div>';
    return;
  }
  q.then(function(res){
      var rows = (res && res.data) || [];
      var live = rows.filter(function(r){ return !r.revoked_at; });
      if(!live.length){
        box.innerHTML = '<div class="hint">No Mac connected yet.</div>';
        return;
      }
      box.innerHTML = live.map(function(r){
        return '<div class="u-row"><div class="u-meta">' +
          escapeHtml(r.label || 'this Mac') + ' \u00b7 added ' +
          new Date(r.created_at).toLocaleDateString() + ' \u00b7 ' +
          (r.last_seen_at
            ? 'last synced ' + new Date(r.last_seen_at).toLocaleString()
            : 'never synced yet') +
          ' <button class="linkish" data-action="revoke-device-token" data-id="' +
          escapeHtml(r.id) + '">disconnect</button></div></div>';
      }).join('');
  }, function(){
    box.innerHTML = '<div class="hint">Could not check connected Macs.</div>';
  });
}

function createDeviceToken(btn){
  if(btn){ btn.disabled = true; btn.textContent = 'Creating\u2026'; }
  window.GB_SUPABASE.rpc('create_device_token', {p_label: 'Mac \u00b7 ' + new Date().toLocaleDateString()})
    .then(function(res){
      if(btn){ btn.disabled = false; btn.textContent = 'Create a token for this Mac'; }
      if(res.error || !res.data){
        showToast('Could not create a token: ' + ((res.error && res.error.message) || 'unknown error'));
        return;
      }
      /* Shown once, in a box they can copy from, with the command that uses
         it -- because a secret handed over with no instructions is a secret
         that gets pasted somewhere it should not be. */
      var tok = res.data;
      openModalHtml(
        '<div class="modal-head"><h2>Connect this Mac</h2>' +
        '<button class="btn-ghost btn" data-action="close-modal">\u2715</button></div>' +
        '<div class="hint">Copy this now. It is shown once and cannot be retrieved again \u2014 ' +
        'if you lose it, disconnect this Mac and create another.</div>' +
        '<textarea readonly rows="2" style="width:100%;margin:10px 0;font-family:ui-monospace,monospace;font-size:12px;">' +
        escapeHtml(tok) + '</textarea>' +
        /* The commands below carry no token.

           A command with a secret in it gets pasted into shell history, and a
           command with a PLACEHOLDER in it gets run verbatim -- which has
           already happened here, with an API key set to the literal string
           "re_yourNewKeyHere". So the agent asks for the token itself, once,
           and remembers it. */
        '<div class="hint">In Terminal, from the ghostbuster folder, run these two. ' +
        'The first asks you to paste the token above; nothing goes into your shell history.</div>' +
        '<textarea readonly rows="2" style="width:100%;margin:6px 0;font-family:ui-monospace,monospace;font-size:12px;">' +
        'python3 tools/imessage-agent.py --set-token\npython3 tools/imessage-agent.py --dry-run</textarea>' +
        '<div class="hint">The second reports what it would sync without sending anything. ' +
        'Drop <strong>--dry-run</strong> to do it for real, and use <strong>--watch</strong> to keep it ' +
        'running. Terminal needs Full Disk Access (System Settings \u2192 Privacy &amp; Security) or ' +
        'macOS blocks reading Messages.</div>', true);
    });
}

function revokeDeviceToken(id){
  if(!id) return;
  window.GB_SUPABASE.rpc('revoke_device_token', {p_id: id}).then(function(res){
    if(res.error){ showToast('Could not disconnect that Mac.'); return; }
    showToast('Disconnected. That Mac can no longer sync.');
    renderDeviceTokens();
  });
}

/* Sending from the workspace composer.

   Deliberately the same path as the contact screen's reply box -- one way to
   send a free-text message, so the cadence rules, the opt-out check and the
   logging cannot drift between two places that look the same to a user. */
/* Writing the summary, and recording what it covers.

   conversationSummaryThrough is saved alongside it, because without it the
   summary has no way of knowing it has gone out of date -- and a confident
   summary that predates the last three messages is the failure this whole
   feature has to avoid. */
function doSummarise(cid, target){
  var client = STATE.clients[cid];
  if(!client) return;
  var label = target ? target.textContent : '';
  if(target){ target.disabled = true; target.textContent = 'Reading\u2026'; }

  var through = summaryThrough(client);
  callGemini(conversationSummaryPrompt(STATE, client)).then(function(text){
    if(target){ target.disabled = false; target.textContent = label; }
    var summary = String(text || '').trim();
    if(!summary){ showToast('Nothing came back \u2014 try again.'); return; }
    client.conversationSummary = summary;
    client.conversationSummaryAt = nowISO();
    /* What it covers, captured BEFORE the call rather than after: a message
       arriving while the model was thinking is not described by this summary,
       and recording "now" would claim it was. */
    client.conversationSummaryThrough = through;
    saveState(STATE);
    renderThreadsTab();
  }).catch(function(e){
    if(target){ target.disabled = false; target.textContent = label; }
    showToast('Could not summarise that \u2014 ' + (e && e.message ? e.message : 'try again') + '.');
  });
}

/* Queueing a message for later.

   The composer's text is taken as-is; nothing here decides whether sending is
   wise, because that decision belongs at send time. send-scheduled re-runs
   every rule when the moment arrives -- a reply, an opt-out or a pause in the
   meantime drops it, and quiet hours hold it rather than cancelling. */
function doScheduleSend(cid, target){
  var client = STATE.clients[cid];
  if(!client) return;
  var box = el('msgx-text');
  var text = box && box.value.trim();
  if(!text){ showToast('Write the message first, then schedule it.'); return; }
  if(!STATE.userId || !STATE.orgId){
    showToast('Could not tell which account you are in \u2014 try reloading.');
    return;
  }

  var choice = prompt(
    'Send this later:\n  1  tomorrow morning\n  2  in 3 days\n  3  next week\n\n' +
    'Type 1, 2 or 3.', '1');
  if(choice === null) return;
  var days = choice.trim() === '3' ? 7 : choice.trim() === '2' ? 3 : 1;

  /* 9am in THEIR timezone, not ours.

     A message queued "tomorrow morning" by somebody in New York for a contact
     in Los Angeles should land at 9am Pacific. Quiet hours would hold it
     anyway, but arriving at the right hour beats arriving at the first legal
     one. parseDatetimeLocalInTZ does the wall-clock-to-UTC conversion the
     client modal already uses, so DST is handled the same way in both. */
  var tz = client.timezone || 'America/New_York';
  var day = formatDatetimeLocalInTZ(addDays(new Date(), days), tz).slice(0, 10);
  var whenIso = parseDatetimeLocalInTZ(day + 'T09:00', tz);
  var when = whenIso ? new Date(whenIso) : null;
  if(!when || isNaN(when.getTime())){
    showToast('Could not work out when that would be \u2014 try again.');
    if(target){ target.disabled = false; target.textContent = 'Schedule\u2026'; }
    return;
  }

  if(target){ target.disabled = true; target.textContent = 'Queuing\u2026'; }
  window.GB_SUPABASE.from('scheduled_messages')
    .insert({client_id: cid, org_id: STATE.orgId, user_id: STATE.userId,
             body: text, send_at: when.toISOString(), status: 'pending'})
    .then(function(res){
      if(target){ target.disabled = false; target.textContent = 'Schedule\u2026'; }
      if(res && res.error){ showToast('Could not queue that message.'); return; }
      STATE.scheduled = STATE.scheduled || [];
      STATE.scheduled.push({id: uid(), clientId: cid, body: text, sendAt: when.toISOString()});
      if(box) box.value = '';
      renderThreadsTab();
      showToast('Queued for ' + fmtDate(when, client.timezone) + ' \u2014 it will not go ' +
        'if they reply or opt out first.');
    }, function(){
      if(target){ target.disabled = false; target.textContent = 'Schedule\u2026'; }
      showToast('Could not queue that message.');
    });
}

function doCancelScheduled(id){
  if(!id) return;
  window.GB_SUPABASE.from('scheduled_messages')
    .update({status: 'cancelled', reason: 'cancelled by hand', resolved_at: nowISO()})
    .eq('id', id)
    .then(function(res){
      if(res && res.error){ showToast('Could not cancel that message.'); return; }
      STATE.scheduled = (STATE.scheduled || []).filter(function(s){ return s.id !== id; });
      renderThreadsTab();
      showToast('Removed from the queue.');
    }, function(){ showToast('Could not cancel that message.'); });
}

/* Drafting a suggested reply.

   It writes into the composer and stops. There is deliberately no "draft and
   send" path: a suggestion the model produced has to be read by the person
   whose name is on the message before it goes anywhere. The spec for this
   says an uncertain interpretation must never be treated as a confirmed
   customer decision, and the only reliable enforcement is a human reading it.

   The existing box is replaced rather than appended to -- a draft merged into
   something half-typed produces a message nobody wrote. */
function doDraftReply(cid, target){
  var client = STATE.clients[cid];
  if(!client) return;
  var box = el('msgx-text');
  if(!box) return;
  if(box.value.trim() && !confirm('Replace what you have typed with a suggested reply?')) return;

  var label = target ? target.textContent : '';
  if(target){ target.disabled = true; target.textContent = 'Thinking\u2026'; }

  callGemini(replyDraftPrompt(STATE, client)).then(function(text){
    if(target){ target.disabled = false; target.textContent = label; }
    var draft = String(text || '').trim().replace(/^["\u201c]|["\u201d]$/g, '');
    if(!draft){ showToast('Nothing came back \u2014 try again.'); return; }
    var b = el('msgx-text');
    if(b){ b.value = draft; b.focus(); }
    showToast('Draft ready \u2014 read it before sending.');
  }).catch(function(e){
    if(target){ target.disabled = false; target.textContent = label; }
    showToast('Could not write a draft \u2014 ' + (e && e.message ? e.message : 'try again') + '.');
  });
}

/* Adding an internal note.

   It never touches message_log, send-sms, or any provider. Notes live in
   their own table precisely so "this cannot be sent" is a property of where
   it is stored, not of remembering to check a flag before sending. */
function doAddNote(cid, target){
  var client = STATE.clients[cid];
  if(!client) return;
  var box = el('msgx-note');
  var body = box && box.value.trim();
  if(!body){ showToast('Nothing to note yet.'); return; }
  if(!STATE.userId || !STATE.orgId){
    // org_id is NOT NULL and the insert would be rejected. Saying so beats a
    // silent failure that looks like the note was saved.
    showToast('Could not tell which account you are in \u2014 try reloading.');
    return;
  }

  if(target){ target.disabled = true; target.textContent = 'Saving\u2026'; }
  var at = nowISO();
  window.GB_SUPABASE.from('conversation_notes')
    .insert({client_id: cid, org_id: STATE.orgId,
             user_id: STATE.userId, body: body, created_at: at})
    .then(function(res){
      if(target){ target.disabled = false; target.textContent = 'Add note'; }
      if(res && res.error){ showToast('Could not save that note.'); return; }
      client.threadNotes = client.threadNotes || [];
      client.threadNotes.push({
        id: uid(), body: body, userId: STATE.userId,
        author: (STATE.teamNames && STATE.teamNames[STATE.userId]) || STATE.senderName || '',
        at: at
      });
      if(box) box.value = '';
      renderMsgxThread();
      showToast('Note added. ' + firstName(client.name) + ' will not see it.');
    }, function(){
      if(target){ target.disabled = false; target.textContent = 'Add note'; }
      showToast('Could not save that note.');
    });
}

function doMsgxSend(cid, target){
  var box = el('msgx-text');
  var text = box && box.value.trim();
  if(!text){ showToast('Nothing to send yet.'); return; }
  doSendReply(cid, target, text, function(){ renderThreadsTab(); });
}

function doSendReply(cid, target, textOverride, onDone){
  var client = STATE.clients[cid];
  if(!client) return;
  /* The text comes from whichever composer called -- the contact screen's box
     or the workspace one. Everything after this point is identical, which is
     the point: two composers, one set of rules about whether and how a
     message may go out. */
  var box = el('reply-text');
  var text = textOverride || (box && box.value.trim());
  if(!text){ showToast('Nothing to send yet.'); return; }

  if(target){ target.disabled = true; target.textContent = 'Sending\u2026'; }
  var restore = function(){
    if(target){ target.disabled = false; target.textContent = 'Send reply'; }
  };

  var replyRoute = smsSendMode(STATE, client).mode;
  window.GB_SUPABASE.functions.invoke('send-sms', {
    body: {clientId: cid, text: text, stage: 'custom', variantId: 'custom',
           route: replyRoute === 'mac' ? 'mac' : undefined}
  }).then(function(res){
    var err = res && res.error, data = res && res.data;
    if(err || !data || !data.ok){ restore(); showToast(smsSendError(data, err)); return; }
    client.messageLog.push({
      id: data.messageId || uid(),
      stage: 'custom', variantId: 'custom',
      text: data.sentText || text,
      sentAt: nowISO(), responded: false, respondedAt: null, reviewed: false,
      /* The server's own word for it. This said 'sent' unconditionally, which
         was already generous on the provider route and is plainly false on
         the Mac one, where the agent has not yet picked the row up. */
      channel: 'sms', deliveryStatus: data.status || 'sent'
    });
    saveState(STATE);
    if(box) box.value = '';
    var mx = el('msgx-text'); if(mx) mx.value = '';
    if(onDone) onDone();
    else openClientModal(cid);   // redraw the thread with the new message in it
    showToast(data.route === 'mac'
      ? 'Queued for your Mac \u2014 it sends from Messages within seconds.'
      : 'Replied to ' + client.name + '.');
  }).catch(function(e){
    restore();
    showToast('Could not send that reply: ' + (e && e.message ? e.message : 'the request failed') + '.');
  });
}

/* One function for both automatic routes.

   The provider hands the text to a carrier and the Mac hands it to the
   Messages app, but everything around that is identical -- the double-send
   guard, adopting the server's row id, the opt-out notice the server
   appended. The only real difference is what may honestly be claimed
   afterwards: the provider has accepted the message, while the Mac route has
   only written it down for an agent that has not polled yet.

   The route is decided HERE rather than carried in from the button that was
   clicked. A Mac that stopped answering between the render and the click
   would otherwise still be sent to, because the button was drawn while it
   was awake -- and the queue it writes to would have nobody draining it.
   Asking at the moment of the click is what keeps this and the server
   agreeing about which route is live. */
/* The sms: draft link, in one place.

   Three sites were each rebuilding this by hand. A link that is right in two
   of them and wrong in the third is the kind of bug that only appears for
   contacts whose number is shaped unusually. */
function smsHrefFor(client, text){
  var digits = String((client && client.phone) || '').replace(/\D/g, '');
  if(!digits) return '#';
  var e164 = digits.length === 10 ? '+1' + digits : '+' + digits;
  return 'sms:' + e164 + '&body=' + encodeURIComponent(text || '');
}

function doSendText(cid, stage, target){
  var client = STATE.clients[cid];
  if(!client) return;
  var route = smsSendMode(STATE, client).mode;
  /* Same double-send guard as the handoff path, and for the same reason: a
     second click while the first request is in flight would send twice.

     It SAYS so now. This was a bare `return`, so a button that refused to act
     looked identical to one that was broken -- and that is exactly how it
     looked while testing the sandbox, where nothing happened and nothing
     explained why. A guard that declines silently is indistinguishable from a
     bug. */
  /* Asked the way the cadence asks it. hasSentStage here meant "ever sent",
     which refused every rescheduled contact whose card the cadence had just
     offered. See touchAlreadySent. */
  if(touchAlreadySent(client, stage)){
    showToast(touchLabel(stage) + ' already went out to ' + firstName(client.name) +
      ' for this ' + termLower('appointment') + '. Nothing was sent.');
    return;
  }

  var text = getCardText(STATE, client, stage);
  var label = target ? target.textContent : '';
  if(target){ target.disabled = true; target.textContent = 'Sending\u2026'; }

  var restore = function(){
    if(target){ target.disabled = false; target.textContent = label || 'Send text'; }
  };

  window.GB_SUPABASE.functions.invoke('send-sms', {
    body: {clientId: cid, text: text, stage: stage, variantId: null,
           route: route === 'mac' ? 'mac' : undefined}
  }).then(function(res){
    /* invoke() resolves with {data, error}. A non-2xx is reported in error,
       but the function's own body -- which carries the reason a send was
       refused, like an opt-out or an unregistered number -- comes back in
       res.data for a 2xx only. So both have to be read, or every failure
       reads as a generic one. */
    var err = res && res.error;
    var data = res && res.data;
    if(err || !data || !data.ok){
      restore();
      showToast(smsSendError(data, err));
      return;
    }
    lastSnapshot = snapshot();
    // The text the server actually sent, which carries the carrier opt-out
    // notice on a first message. Logging our own copy instead would leave the
    // record disagreeing with the message, and the next save would overwrite
    // the server's row with it.
    markSent(STATE, cid, stage, data.sentText || text);
    var logged = client.messageLog[client.messageLog.length - 1];
    if(logged){
      logged.channel = 'sms';
      // Adopting the server's id is what keeps this one row. See above.
      if(data.messageId) logged.id = data.messageId;
      /* And the server's status, so this row does not read as 'not
         confirmed' while the server already calls it 'queued'. Two
         descriptions of one message is the thing the delivery states exist
         to avoid. */
      if(data.status) logged.deliveryStatus = data.status;
    }
    saveState(STATE);
    renderAll();
    /* What can be claimed, and nothing more. On the Mac route NOTHING has
       been sent at this point: the row is written and the agent has not yet
       asked for it. Saying "Texted Bob" here would be the old lie with a new
       mechanism behind it. */
    showToast(
      data.route === 'mac'
        ? 'Queued for your Mac \u2014 it sends from Messages within seconds.'
        : (data.real === false
            ? 'Test message recorded for ' + client.name + ' \u2014 nothing was sent to a phone.'
            : 'Texted ' + client.name + ' from ' + (data.from || 'your number') + '.'),
      lastSnapshot);
  }).catch(function(e){
    restore();
    showToast('Could not send that text: ' + (e && e.message ? e.message : 'the request failed') + '.');
  });
}

/* What to tell someone when a text does not go out.

   The function already answers why -- an opt-out, no registered number, a
   provider rejection -- and that reason is the only useful part. A generic
   "could not send" would send them looking in the wrong place, which on this
   path means looking at the contact when the answer is that 10DLC
   registration has not cleared. */
function smsSendError(data, err){
  var code = data && data.code;
  if(code === 'no_number') return 'No registered texting number yet \u2014 A2P 10DLC registration has to clear first.';
  if(code === 'bad_number') return (data && data.error) || 'That number cannot be texted.';
  if(code === 'no_provider') return 'Texting is not switched on for this account yet.';
  if(code === 'no_phone') return 'That contact has no phone number.';
  if(code === 'quiet_hours') return (data && data.error) || 'Too late to text them where they are.';
  if(data && data.error) return data.error;
  if(err && err.message) return 'Could not send that text: ' + err.message + '.';
  return 'Could not send that text.';
}

function doMarkSent(cid, stage, deferRender){
  var client = STATE.clients[cid];
  // A contact can vanish between the click and the handler -- deleted in
  // another tab, or resolved by a calendar sync. getCardText would throw.
  if(!client) return;
  var text = getCardText(STATE, client, stage);
  markSent(STATE, cid, stage, text);   // persists; saveState lives in markSent
  // No pooled 'sends' here either: it is counted at review time, with the
  // per-account one. See doReviewMessage.
  /* Re-rendering can be deferred, but the save above never is.

     renderAll() rebuilds the morning list and removes the <a> that was just
     clicked, which in principle can cost a browser the navigation it was
     about to follow. Precautionary rather than demonstrated: focus mode has
     always rendered synchronously on the same kind of anchor and nobody has
     reported Messages failing to open there. Kept because delaying the
     repaint costs nothing and it puts the undo toast on screen for when they
     come back, and because the one thing that must not be delayed -- the
     write -- now happens before this either way. */
  if(deferRender) setTimeout(renderAll, 700);
  else renderAll();
}


function addTodo(){
  var input = el('todo-input');
  var text = input.value.trim();
  if(!text) return;
  STATE.todos.push({id:uid(), text:text, done:false, createdAt:nowISO(), doneAt:null});
  saveState(STATE);
  input.value = '';
  renderTodos();
}


function copyToClipboard(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).catch(function(){ fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text){
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
}


function exportBackup(){
  var data = JSON.stringify(STATE, null, 2);
  downloadFile(data, 'ghost-recall-backup-' + new Date().toISOString().slice(0,10) + '.json', 'application/json');
}

function exportClientsCsv(){
  var csv = buildClientsCsv(STATE);
  downloadFile(csv, 'ghost-recall-clients-' + new Date().toISOString().slice(0,10) + '.csv', 'text/csv');
}

function downloadFile(content, filename, mimeType){
  var blob = new Blob([content], {type:mimeType});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}


/* End of day — the place a day gets closed out.

   It used to be a read-only list: "Overdue, unlogged — Karen Villegas" and
   nothing else. It named 44 outcomes nobody had recorded and then made someone
   go find each contact individually, which is why 24 past calls were still
   sitting open and 20 completed ones had no close on file. A list that reports
   work without letting you do it just moves the work somewhere less convenient.

   Every row is now actionable in one click. Same seams as everywhere else —
   setOutcome, closeOutcome, the todo toggle — so nothing here is a parallel
   way of recording the same facts. */
/* ---- focus mode ----
   The daily loop was: read a card, click into Messages, send, come back, tick
   a box, find the next card. Fifty-three times. Every one of those steps is
   cheap on its own and the sum is why a morning list gets abandoned halfway.

   This is the same work as one screen at a time: the message, the person, one
   button. Send opens Messages and marks it sent in the same click, then
   advances. That is optimistic — Ghost Recall cannot see whether the message
   actually left the phone — so every send is undoable from the toast rather
   than being confirmed in advance. Asking first would reintroduce the step
   this exists to remove, and a wrong "sent" costs one undo while the friction
   costs the whole list.
   ============================================================ */
var FOCUS = null;

function startFocusMode(){
  var list = getTextTodayList(STATE, new Date(), UI.callsSearch || '');
  if(!list.length){ showToast('Nothing left to send.'); return; }
  FOCUS = {queue: list.map(function(it){ return {cid: it.client.id, stage: it.stage}; }), i: 0, sent: 0};
  renderFocus();
}

function exitFocusMode(){
  var sent = FOCUS ? FOCUS.sent : 0;
  FOCUS = null;
  closeModal();
  renderAll();
  if(sent) showToast(sent + ' message' + (sent === 1 ? '' : 's') + ' sent.');
}

function focusAdvance(){
  FOCUS.i++;
  if(FOCUS.i >= FOCUS.queue.length){ exitFocusMode(); return; }
  renderFocus();
}

function renderFocus(){
  if(!FOCUS) return;
  var cur = FOCUS.queue[FOCUS.i];
  var c = cur && STATE.clients[cur.cid];
  // A contact can disappear mid-run — deleted in another tab, or its cadence
  // resolved by a calendar sync. Skip rather than crash.
  if(!c){ focusAdvance(); return; }

  var text = getCardText(STATE, c, cur.stage);
  var digits = String(c.phone || '').replace(/\D/g, '');
  var smsHref = digits
    ? 'sms:' + (digits.length === 10 ? '+1' + digits : '+' + digits) + '&body=' + encodeURIComponent(text)
    : null;
  var tz = tzChipInfo(c, new Date());
  var prog = cadenceProgress(c, new Date());
  var focusRoute = smsSendMode(STATE, c);

  openModalHtml(
    '<div class="focus">' +
      '<div class="focus-top">' +
        '<span class="focus-count">' + (FOCUS.i + 1) + ' of ' + FOCUS.queue.length + '</span>' +
        '<div class="focus-track"><div class="focus-fill" style="width:' +
          Math.round((FOCUS.i / FOCUS.queue.length) * 100) + '%"></div></div>' +
        '<button class="btn btn-sm btn-ghost" data-action="focus-exit">Done for now</button>' +
      '</div>' +
      '<div class="focus-who">' +
        '<h2>' + escapeHtml(c.name) + '</h2>' +
        '<span class="stage-chip">' + escapeHtml(cur.stage) + '</span>' +
        '<span class="touch-chip">Touch ' + (prog.done + 1) + ' of ' + prog.total + '</span>' +
        '<span class="tz-chip' + (tz.warn ? ' tz-warn' : '') + '">' + escapeHtml(tz.timeLabel) + ' their time</span>' +
      '</div>' +
      (tz.warn ? '<div class="focus-warn">⚠ It’s outside normal hours for ' + escapeHtml(c.name) + ' right now.</div>' : '') +
      '<textarea class="focus-text" id="focus-text" rows="6">' + escapeHtml(text) + '</textarea>' +
      '<div class="focus-acts">' +
        (focusRoute.mode === 'provider' || focusRoute.mode === 'mac'
          ? '<button class="btn btn-primary btn-lg focus-send" data-action="focus-send-provider">Send &amp; next</button>'
          : focusRoute.mode === 'handoff' && smsHref
          ? '<a class="btn btn-primary btn-lg focus-send" href="' + smsHref + '" data-action="focus-send">Send &amp; next</a>'
          : focusRoute.mode === 'blocked'
          /* No send action of any kind. Focus mode is a rapid loop -- the
             whole point is that Enter advances without reading -- so an
             opted-out contact appearing here with any send button is the one
             place somebody would text them without noticing. */
          ? '<span class="focus-warn">' + escapeHtml(c.name) + ' replied STOP and cannot be texted.</span>'
          : '<button class="btn btn-lg" data-action="focus-copy">Copy &amp; next</button>') +
        '<button class="btn" data-action="focus-skip">Not now</button>' +
        '<button class="btn btn-ghost" data-action="focus-snooze">Not today</button>' +
        '<button class="btn btn-ghost" data-action="focus-skip-forever">Never send this</button>' +
      '</div>' +
      '<div class="focus-hint">' +
        (focusRoute.mode === 'blocked' ? 'S to skip · Esc to stop' : 'Enter to send · S to skip · Esc to stop') +
      '</div>' +
    '</div>', true);
}

/* The answering routes inside focus mode: the provider, and the Mac.

   One difference from focusSend, and it is the point of the whole channel:
   this one waits. focusSend advances immediately because it cannot know
   whether Messages ever sent anything, so it logs optimistically and relies
   on the undo. Here the server answers, so the queue must not move until it
   has -- advancing first would leave a failed send behind a screen nobody is
   looking at any more, which is the failure this product already has in the
   form of 0 reviews out of 67 sends.

   On a refusal it stays on this contact with the reason on screen, because
   the reasons are all things the person can act on.

   The Mac route answers a weaker question than the provider does, and it is
   worth being clear about: what it confirms is that the text was QUEUED, not
   that Messages sent it. A Mac that quits Messages a second later fails
   after this screen has moved on. That failure is not lost -- it lands on the
   row as send_error and shows in the thread and the delivery states -- but it
   is not caught here, the way a provider rejection is. */
function focusSendProvider(target){
  var cur = FOCUS && FOCUS.queue[FOCUS.i];
  var c = cur && STATE.clients[cur.cid];
  if(!c){ focusAdvance(); return; }

  var edited = el('focus-text');
  var text = (edited && edited.value) || getCardText(STATE, c, cur.stage);
  if(edited && edited.value !== getCardText(STATE, c, cur.stage)){
    editedTextCache[cur.cid + '|' + cur.stage] = edited.value;
  }
  if(target){ target.disabled = true; target.textContent = 'Sending\u2026'; }

  var focusMode = smsSendMode(STATE, c).mode;
  window.GB_SUPABASE.functions.invoke('send-sms', {
    body: {clientId: cur.cid, text: text, stage: cur.stage, variantId: null,
           route: focusMode === 'mac' ? 'mac' : undefined}
  }).then(function(res){
    var err = res && res.error, data = res && res.data;
    if(err || !data || !data.ok){
      if(target){ target.disabled = false; target.textContent = 'Send & next'; }
      showToast(smsSendError(data, err));
      return;
    }
    lastSnapshot = snapshot();
    markSent(STATE, cur.cid, cur.stage, data.sentText || text);
    var logged = c.messageLog[c.messageLog.length - 1];
    if(logged){
      logged.channel = 'sms';
      // The server's row id, so the next save merges rather than duplicating.
      if(data.messageId) logged.id = data.messageId;
      if(data.status) logged.deliveryStatus = data.status;
    }
    saveState(STATE);
    FOCUS.sent++;
    focusAdvance();
  }).catch(function(e){
    if(target){ target.disabled = false; target.textContent = 'Send & next'; }
    showToast('Could not send that text: ' + (e && e.message ? e.message : 'the request failed') + '.');
  });
}

function focusSend(){
  var cur = FOCUS.queue[FOCUS.i];
  var c = STATE.clients[cur.cid];
  if(!c) { focusAdvance(); return; }
  var edited = el('focus-text');
  if(edited && edited.value !== getCardText(STATE, c, cur.stage)){
    editedTextCache[cur.cid + '|' + cur.stage] = edited.value;
  }
  lastSnapshot = snapshot();
  doMarkSent(cur.cid, cur.stage);
  FOCUS.sent++;
  focusAdvance();
}


function openEndOfDayModal(){
  renderEndOfDay();
}

function renderEndOfDay(){
  var items = computeEndOfDayItems(STATE);
  var groups = {'today-no-outcome':[], 'overdue-unlogged':[], 'no-close':[], todo:[]};
  items.forEach(function(it){ if(groups[it.type]) groups[it.type].push(it); });

  function section(title, hint, rowsHtml){
    if(!rowsHtml) return '';
    return '<div class="eod-section"><h4>' + title +
      (hint ? ' <span class="eod-hint">' + hint + '</span>' : '') + '</h4>' + rowsHtml + '</div>';
  }
  function outcomeRow(c, urgent){
    // The three answers that actually close a past call. Anything more nuanced
    // belongs in the contact itself, and offering it here would slow down the
    // one job this screen exists for.
    return '<div class="eod-row' + (urgent ? ' urgent' : '') + '">' +
      '<span class="eod-name" data-action="open-client" data-cid="' + c.id + '">' + escapeHtml(c.name) + '</span>' +
      '<span class="eod-when">' + (c.callDateTime ? fmtDate(safeDate(c.callDateTime), c.timezone) : '') + '</span>' +
      '<span class="eod-acts">' +
        '<button class="eod-btn ok" data-action="eod-outcome" data-cid="' + c.id + '" data-status="Showed">Showed</button>' +
        '<button class="eod-btn bad" data-action="eod-outcome" data-cid="' + c.id + '" data-status="No-show">No-show</button>' +
        '<button class="eod-btn" data-action="eod-outcome" data-cid="' + c.id + '" data-status="Rescheduled">Rescheduled</button>' +
      '</span></div>';
  }

  var html = '<div class="modal-head"><h2>End of day</h2>' +
    '<button class="btn-ghost btn" data-action="close-modal">✕</button></div>';

  if(!items.length){
    html += '<div class="allclear-panel">' + allClearBadgeHtml() +
      '<div class="allclear-title">All clear</div>' +
      '<div class="allclear-sub">The day is closed — nothing left.</div></div>';
    openModalHtml(html, true);
    return;
  }

  html += section('Calls today with no outcome', 'log these while you remember them',
    groups['today-no-outcome'].map(function(it){ return outcomeRow(it.client, false); }).join(''));

  // Anything past a month is beyond recall, so it gets a batch answer rather
  // than a row-by-row guess. Offered only when there is actually a pile.
  var stale = getUnloggedCalls(STATE, new Date()).filter(function(it){ return it.daysAgo >= 30; });
  var staleBar = stale.length >= 3
    ? '<div class="eod-bulk">' +
      '<span>' + stale.length + ' of these are over a month old — you will not remember them individually.</span>' +
      '<button class="eod-btn" data-action="resolve-stale" data-mode="archive">Archive them</button>' +
      '<button class="eod-btn bad" data-action="resolve-stale" data-mode="noshow">All no-show</button>' +
      '<button class="eod-btn ok" data-action="resolve-stale" data-mode="showed">All showed</button>' +
      '</div>'
    : '';

  html += section('Overdue, never logged', 'these are left out of your show rate until you answer',
    staleBar + groups['overdue-unlogged'].map(function(it){ return outcomeRow(it.client, true); }).join(''));

  html += section('Showed, but no result recorded', '',
    groups['no-close'].map(function(it){
      return '<div class="eod-row">' +
        '<span class="eod-name" data-action="open-client" data-cid="' + it.client.id + '">' + escapeHtml(it.client.name) + '</span>' +
        '<span class="eod-when"></span>' +
        '<span class="eod-acts">' +
          '<button class="eod-btn ok" data-action="eod-close" data-cid="' + it.client.id + '" data-close="Closed">Closed</button>' +
          '<button class="eod-btn" data-action="eod-close" data-cid="' + it.client.id + '" data-close="Not closed">Not closed</button>' +
        '</span></div>';
    }).join(''));

  // No "Still to send" section. That is the Today tab, which already shows a
  // progress bar and a copy-all button for exactly those texts — repeating
  // them here was a third of this screen and made the count unclearable.

  html += section('To-dos', '',
    groups.todo.map(function(it){
      return '<div class="eod-row"><span class="eod-name">' + escapeHtml(it.todo.text) + '</span>' +
        '<span class="eod-when"></span><span class="eod-acts">' +
        '<button class="eod-btn ok" data-action="eod-todo" data-id="' + it.todo.id + '">Done</button>' +
        '</span></div>';
    }).join(''));

  openModalHtml(html, true);
}


/* ============================================================
   14) BOOT
   ============================================================ */

/* Coming back from connecting a calendar.

   The callback redirects here with ?calendar=connected. Say so, and take the
   parameter straight back out of the address bar so a refresh or a shared
   link does not replay the message. The sync already ran inside the callback,
   so the bookings are in by the time this runs — there is nothing to press. */
function noteCalendarReturn(){
  var q;
  try{ q = new URLSearchParams(window.location.search); }catch(e){ return; }
  var status = q.get('calendar');
  if(!status) return;
  var cal = q.get('cal');
  var reason = q.get('reason');
  q.delete('calendar'); q.delete('cal'); q.delete('reason');
  try{
    var rest = q.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? '?' + rest : ''));
  }catch(e){}
  if(status === 'connected'){
    /* Say what actually arrived, not what was hoped for.

       This claimed "your bookings are in" whichever way the sync went, at the
       single moment that decides whether somebody stays — and it contradicted
       the panel directly beneath it, which correctly read "Calendar
       connected, nothing imported yet".

       Not hypothetical: every account outside the main organisation signed up
       and never came back, five of the six on the same day they joined. One
       of them connected a calendar and got nothing. Being told it worked, by
       an app showing an empty list, is worse than being told why it did not. */
    var landed = Object.keys((STATE && STATE.clients) || {}).length;
    if(landed){
      showToast((cal ? cal + ' connected. ' : 'Calendar connected. ') +
        landed + (landed === 1 ? ' booking imported.' : ' bookings imported.'));
    } else {
      /* Nothing arrived, which is the moment that decides whether somebody
         stays. The callback already ran a sync server-side but its counts
         never reach the browser, so this asks again purely to find out WHY —
         describeSyncResult already knows how to tell the difference between
         an empty calendar, events that matched no filter, and a connection
         that failed. Being told "nothing matched" is barely better than an
         empty list; being told "read 14 events and none looked like a
         booking" is something somebody can act on. */
      showToast((cal ? cal + ' connected. ' : 'Connected. ') + 'Checking what came in\u2026');
      window.GB_SUPABASE.functions.invoke('google-calendar-sync').then(function(res){
        if(res.error){
          showToast('Connected, but the first sync did not run. Try "Sync calendar now".');
          return;
        }
        var cals = (res.data && res.data.results && res.data.results[0] && res.data.results[0].calendars) || [];
        if(!cals.length){
          showToast('Connected, but nothing matched yet \u2014 check which events count as bookings in Settings.');
          return;
        }
        var why = describeSyncResult(cals);
        /* Nothing read AND nothing here already: an empty calendar or the
           wrong Google account, not a quiet day. describeSyncResult says
           "already up to date" for this, which is correct for a daily sync
           and the wrong answer to the only question a new arrival has. */
        var readNothing = cals.reduce(function(n, c){ return n + (c.scanned || 0); }, 0) === 0;
        showToast(readNothing && !cals.some(function(c){ return c.error; })
          ? 'Connected, but that calendar has nothing on it between a week ago '
            + 'and six months ahead. If your bookings live on another Google '
            + 'account, connect that one.'
          : why.text);
        if(why.detail) console.log('Ghost Recall: first sync —', why.detail);
        init();   // anything that did arrive on this second pass
      });
    }
  } else if(reason === 'already'){
    /* The one failure with a real instruction attached. Shown as a panel
       rather than a toast: it asks the person to go and do something in
       another product, which is more than a line that fades. */
    openModalHtml(
      '<div class="modal-head"><h2>Google needs you to disconnect first</h2>' +
      '<button class="btn-ghost btn" data-action="close-modal">\u2715</button></div>' +
      '<p class="hint">Google did not send back the permission Ghost Recall needs to ' +
      'keep reading your calendar. That almost always means this Google account was ' +
      'connected once before and the old access was never removed.</p>' +
      '<p class="hint">Open your Google Account \u2192 Security \u2192 <strong>Third-party ' +
      'access</strong>, remove Ghost Recall, then connect again here.</p>' +
      '<div class="modal-foot" style="text-align:right;margin-top:14px;">' +
      '<button class="btn btn-green" data-action="close-modal">Got it</button></div>');
  } else {
    showToast(reason === 'save'
      ? 'Google connected, but saving it failed. Try connecting again.'
      : 'Could not finish connecting to Google. Try again.');
  }
}

async function init(){
  STATE = await loadState();
  /* The row is authoritative: it is what follows somebody to a new device,
     where the local mirror does not exist. */
  if(STATE && STATE.theme) applyTheme(STATE.theme);
  renderAll();
  // After the render, so the toast lands on a screen that already has the
  // newly imported bookings on it rather than over an empty one.
  noteCalendarReturn();
}

// A countdown that only updates on reload is worse than none — it reads as
// authoritative while quietly going stale. Re-render just the panel on a
// timer; it's cheap and touches nothing else.
if(typeof setInterval !== 'undefined'){
  setInterval(function(){ if(STATE) renderOnDeck(); }, 30000);
  /* The agent's heartbeat has to keep up with the clock it is compared to.

     Everything loadState fetched is a snapshot from startup. That is fine for
     state the person rewrites as they work; it is wrong for a timestamp whose
     whole job is to be measured against now. Left unrefreshed, a tab open for
     more than AGENT_SEND_STALE_MINUTES decided the Mac had gone silent and
     fell back to the handoff -- on a Mac that was answering every two minutes.

     Re-rendered only when the value actually moves, so this costs one small
     indexed read a minute and no repaints. */
  setInterval(function(){
    if(!STATE || typeof refreshDeviceAgent !== 'function') return;
    refreshDeviceAgent(STATE).then(function(changed){
      if(changed && STATE) renderAll();
    });
  }, 60000);
}

/* The workspace switches between three panes and one on a width boundary, so
   a resize past it has to re-lay it out -- otherwise dragging a window wider
   leaves a phone layout on a desktop. Debounced, because resize fires per
   pixel and this rebuilds three panels. */
if(typeof window !== 'undefined' && window.addEventListener){
  var msgxResizeTimer = null;
  window.addEventListener('resize', function(){
    if(UI.tab !== 'threads' || !STATE) return;
    clearTimeout(msgxResizeTimer);
    msgxResizeTimer = setTimeout(renderThreadsTab, 180);
  });
}
// No DOMContentLoaded auto-boot here — auth.js owns the boot sequence in the
// hosted build (it calls init() itself only once a signed-in session is
// confirmed; otherwise it shows the sign-in screen instead).

if(typeof document !== 'undefined' && document.addEventListener){
  document.addEventListener('DOMContentLoaded', init);
}

/* ---- test hook (harmless in the browser: window exists, module doesn't) ---- */
var __GB_EXPORTS__ = {
  STORAGE_KEY: STORAGE_KEY,
  buildDefaultState: buildDefaultState, buildDefaultVariants: buildDefaultVariants,
  sanitizeClient: sanitizeClient, migrateState: migrateState, loadState: loadState, saveState: saveState,
  computeDue: computeDue,
  extractChannelHandle: extractChannelHandle, pickVariant: pickVariant, renderTemplate: renderTemplate,
  getCardText: getCardText, getOriginalText: getOriginalText,
  markSent: markSent, toggleReplied: toggleReplied, setOutcome: setOutcome, recordReschedule: recordReschedule,
  snoozeTouch: snoozeTouch,
  parseICS: parseICS, clientFromICSEvent: clientFromICSEvent, parseHeuristicDate: parseHeuristicDate,
  parseBulkPaste: parseBulkPaste, commitImportedClients: commitImportedClients, addManualClient: addManualClient,
  computeStats: computeStats, computeHealthAlerts: computeHealthAlerts, deleteClient: deleteClient,
  getTextTodayList: getTextTodayList,
  computeEndOfDayItems: computeEndOfDayItems, buildWeeklyDigest: buildWeeklyDigest,
  computeRescueScorecard: computeRescueScorecard, computeInsights: computeInsights,
  AREA_CODE_TZ: AREA_CODE_TZ, timezoneForClient: timezoneForClient,
  formatDatetimeLocalInTZ: formatDatetimeLocalInTZ, parseDatetimeLocalInTZ: parseDatetimeLocalInTZ,
  buildClientsCsv: buildClientsCsv, csvField: csvField, trendHtml: trendHtml,
  renderAll: renderAll, init: init,
  getCallsByLocalDay: getCallsByLocalDay, renderCalendarTab: renderCalendarTab,
  lastMessageIndex: lastMessageIndex,
  _getUI: function(){ return UI; },
  /* The day's cards: open by default and remembered. Exposed because the
     default is the whole point of the change -- folding it was costing two
     people a click on every page load -- and a silent flip back to false
     would look like nothing at all. */
  textTodayOpen: textTodayOpen, setTextTodayOpen: setTextTodayOpen,
  _resetCaches: function(){ stickyVariantCache = {}; editedTextCache = {}; },
  _setState: function(s){ STATE = s; }
};
if(typeof module !== 'undefined' && module.exports){ module.exports = __GB_EXPORTS__; }
if(typeof window !== 'undefined'){ window.GhostBuster = __GB_EXPORTS__; }
