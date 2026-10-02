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


// A friendly big-green-ghost mascot for "nothing here" moments — distinct from the
// white no-ghost "Busted!" logo, which is reserved for actually clearing your queue.
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

var UI = {tab:'calls', statsRange:'today', callsSearch:'', touchFilter:'', clientsSearch:'', statusFilter:null, calendarView:'month', calendarAnchor:new Date(), recentSendsOpen:true};

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


function renderAll(){
  if(!STATE) return;
  applyTerminology();
  // Shown once, on an account that has nothing in it yet. Deliberately after
  // the first render so the wizard opens over a real app rather than a blank
  // page — seeing what it will look like is part of the pitch.
  if(!ONBOARDING && needsOnboarding()) setTimeout(startOnboarding, 0);
  renderCalendarHealth();
  renderHealthAlerts();
  renderProgressBar();
  renderStats();
  renderTodos();
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
  renderClosedTab();
  renderDeadTab();
  var eodCount = computeEndOfDayItems(STATE).length;
  var eodEl = el('eod-count'); if(eodEl) eodEl.textContent = '(' + eodCount + ')';
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


function renderProgressBar(){
  var now = new Date();
  var todayKey = tzDateKey(now, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  var clients = Object.keys(STATE.clients).map(function(k){ return STATE.clients[k]; }).filter(function(c){ return !c.ignored; });
  var due = getTextTodayList(STATE, now, '');
  var sentToday = 0;
  clients.forEach(function(c){ c.messageLog.forEach(function(m){ if(tzDateKey(new Date(m.sentAt), Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC') === todayKey) sentToday++; }); });
  var total = sentToday + due.length;
  var pctDone = total > 0 ? Math.round((sentToday/total)*100) : 0;
  var label = el('progress-label'); if(label) label.textContent = sentToday + ' of ' + total + ' touches sent today';
  var fill = el('progress-fill');
  if(fill){
    fill.style.width = pctDone + '%';
    fill.classList.toggle('full', total > 0 && due.length === 0);
  }
  var rc = el('remaining-count'); if(rc) rc.textContent = due.length;
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
  var progChip = h('span',{class:'touch-chip', title:'Sent so far: ' + (prog.sentStages.join(', ') || 'nothing yet')},
    ['Touch ' + (prog.done + 1) + ' of ' + prog.total]);
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
    var note = h('div',{class:'edited-note'},['edited']);
    var resetBtn = h('button',{'data-action':'reset-text','data-cid':client.id,'data-stage':stage},['reset']);
    note.appendChild(document.createTextNode(' · '));
    note.appendChild(resetBtn);
    card.appendChild(note);
  }

  var actions = document.createElement('div');
  actions.className = 'card-actions';
  var digits = String(client.phone||'').replace(/\D/g,'');
  var smsHref = digits ? ('sms:' + (digits.length===10?'+1'+digits:'+'+digits) + '&body=' + encodeURIComponent(text)) : '#';
  var smsLink = h('a',{class:'btn btn-sm btn-primary', href:smsHref, 'data-action':'open-sms','data-cid':client.id,'data-stage':stage},['Open in Messages']);
  if(!digits) smsLink.setAttribute('aria-disabled','true');
  actions.appendChild(smsLink);
  actions.appendChild(h('button',{class:'btn btn-sm','data-action':'copy-text','data-cid':client.id,'data-stage':stage},['Copy text']));
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
    var row = h('div',{class:'ce-btns card-emails'},[]);
    ordered.forEach(function(d){
      var r = renderEmailDoc(STATE, d.id, client, STATE.senderName);
      if(!r) return;
      var a = h('a',{class:'ce-btn' + (pinnedDoc && d.id === pinnedDoc.id ? ' ce-pinned' : ''),
        target:'_blank', rel:'noopener',
        href: gmailComposeUrl(client.email, r.subject, r.text, businessEmailAccount(STATE)),
        'data-action':'sent-by-email','data-cid':client.id,'data-doc':d.id,
        title: d.whenToSend ? 'Send ' + d.whenToSend : (d.subject || d.title)},
        ['✉ ' + d.title]);
      row.appendChild(a);
    });
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


function bustedBadgeHtml(){
  return '<div class="busted-badge">' +
      '<svg class="impact-lines" viewBox="0 0 150 150" width="150" height="150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g stroke="#dc2f4a" stroke-width="4" stroke-linecap="round">' +
          '<line x1="117" y1="75" x2="147" y2="75"/>' +
          '<line x1="105" y1="105" x2="116" y2="116"/>' +
          '<line x1="75" y1="117" x2="75" y2="147"/>' +
          '<line x1="45" y1="105" x2="34" y2="116"/>' +
          '<line x1="33" y1="75" x2="3" y2="75"/>' +
          '<line x1="45" y1="45" x2="34" y2="34"/>' +
          '<line x1="75" y1="33" x2="75" y2="3"/>' +
          '<line x1="105" y1="45" x2="116" y2="34"/>' +
        '</g>' +
      '</svg>' +
      '<svg class="no-ghost" width="110" height="110" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M32 6c-12 0-20 9-20 21v19c0 2 2 3 3.5 1.5L19 44l4 4 4-4 5 4 5-4 4 4 3.5-3.5C46 46 48 45 48 43V27C48 15 40 6 32 6z" fill="#fff"/>' +
        '<ellipse cx="24" cy="27" rx="4.3" ry="5.4" fill="#17171a"/>' +
        '<ellipse cx="40" cy="27" rx="4.3" ry="5.4" fill="#17171a"/>' +
        '<path d="M26 39q6 5 12 0" stroke="#17171a" stroke-width="2.4" stroke-linecap="round" fill="none"/>' +
        '<circle cx="32" cy="30" r="27" fill="none" stroke="#dc2f4a" stroke-width="4.5"/>' +
        '<line x1="10" y1="10" x2="54" y2="52" stroke="#dc2f4a" stroke-width="4.5" stroke-linecap="round"/>' +
      '</svg>' +
    '</div>';
}

function buildBustedPanel(subtitle){
  /* An empty account is not an empty inbox.

     A brand new user -- no calendar, no contacts -- landed here and was told
     "Busted! Inbox zero, nothing due right now." That congratulates someone
     for finishing before they have started, and offers no way to begin. The
     one screen everybody sees first was the one screen that did not answer
     "how do I get my appointments in here?".

     "Busted!" is earned. It belongs to someone who had work and cleared it,
     and showing it to someone with nothing cheapens it for the people it is
     actually for. */
  var setup = describeSetup(STATE, new Date());
  if(!setup.contacts){
    var div0 = document.createElement('div');
    div0.className = 'busted-panel start-panel';
    div0.innerHTML =
      '<div class="busted-title">' + escapeHtml(setup.headline) + '</div>' +
      '<div class="busted-sub">' + escapeHtml(setup.detail) + '</div>' +
      '<div class="start-acts">' +
        (setup.connected
          ? '<button class="btn btn-sm" data-action="sync-calendar-now">Sync calendar now</button>'
          : '<button class="btn btn-green" data-action="connect-calendar" data-priority="0" data-label="Work">Connect your calendar</button>') +
        '<button class="btn btn-sm" data-action="add-client">Add someone by hand</button>' +
      '</div>' +
      '<div class="start-note">' +
        (setup.connected
          ? 'Connected to ' + escapeHtml((STATE.myCalendars || []).join(', ')) + '.'
          : 'Or open Menu \u2192 Settings to see every way appointments can get in.') +
      '</div>';
    return div0;
  }

  var div = document.createElement('div');
  div.className = 'busted-panel';
  div.innerHTML = bustedBadgeHtml() +
    '<div class="busted-title">Busted!</div>' +
    '<div class="busted-sub">' + escapeHtml(subtitle || 'Inbox zero — nothing due right now.') + '</div>';
  return div;
}


// The live call, pinned above the board. Everything here is one tap: their
// number, a nudge text written in the moment, and the outcome buttons — the
// half hour either side of a call is where show-up rate is actually won, and
// it's the one stretch the board itself can't help with.
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
        fmtDate(nd, od.next.timezone) + ' at ' + fmtTime(nd, od.next.timezone) + '</div>';
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
      '<span class="od-time">' + fmtTime(d, c.timezone) + '</span>' +
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
        fmtTime(safeDate(x.callDateTime), x.timezone) + ' · ' + escapeHtml(x.name) + '</button>';
    }).join('') + '</div>') : '') +
  '</div>';

  box.innerHTML = html;
}


function renderCallsBoard(){
  // Entry into focus mode lives on the list it works through, labelled with
  // the count so the size of the job is visible before committing to it.
  var todayHead = document.querySelector('#tab-calls .board-col h3');
  if(todayHead && !todayHead.querySelector('[data-action=focus-start]')){
    var btn = h('button',{class:'btn btn-sm btn-primary focus-start','data-action':'focus-start'},['Work the list']);
    todayHead.appendChild(btn);
  }

  var now = new Date();
  var textToday = getTextTodayList(STATE, now, UI.callsSearch);
  var todayCol = el('col-text-today');
  if(todayCol){
    todayCol.innerHTML = '';

    /* Filter buttons across the top instead of headings down the middle.

       Grouping the list fixed the order but the inline headings fought the
       cards: a divider every few rows breaks the column up exactly where you
       are trying to read down it. The same information works better as a row
       of buttons — what kinds are waiting, how many of each, and one click to
       see only those.

       Built from what is actually in the list today, so a kind with nothing
       due does not offer an empty button. */
    var counts = {}, order = [];
    textToday.forEach(function(it){
      if(counts[it.stage] === undefined){ counts[it.stage] = 0; order.push(it.stage); }
      counts[it.stage]++;
    });

    // A filter pointing at a kind that is no longer due would show an empty
    // column with no way to tell why, so it falls back to showing everything.
    if(UI.touchFilter && counts[UI.touchFilter] === undefined) UI.touchFilter = '';

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
        : buildBustedPanel());
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
      todayCol.appendChild(buildTouchCard(it.client, it.stage, now));
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
    h('h3',{},['👻 Ghost Recall Today']),
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
    var needsOutcome = inter.state === 'needs_outcome';

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
      var oc = h('div',{class:'gt-outcome'},[h('span',{class:'lbl'},['What happened?'])]);
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
    var when = d ? (fmtDate(d, c.timezone) + ' ' + fmtTime(d, c.timezone)) : '—';
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
    var callWhen = callD ? (fmtDate(callD, c.timezone) + ' ' + fmtTime(callD, c.timezone)) : '—';
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
      '<p class="hint">There are no emails in your library yet. The Emails tab is where they live — ' +
      'add the ones you already send and they will show up here for every ' + escapeHtml(termLower('contact')) + '.</p>' +
      '<div class="modal-foot"><button class="btn btn-green" data-action="tab" data-tab="emails">Go to Emails</button></div>');
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
    });
    table.appendChild(tb);
    stageBox.appendChild(table);
    if(g.leader){
      stageBox.appendChild(h('div',{class:'vp-lead'},[
        '→ ' + g.leader.variantId + ' leads on appointments (' + pct(g.leader.showRate) +
        ' of ' + g.leader.credited + ')'
      ]));
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
      var star = v.id===championId ? '<span class="champion">★</span> ' : '';
      tr.innerHTML = '<td>' + star + escapeHtml(v.id) + (v.needsChannel?' <em style="color:var(--ink-faint)">(needs channel)</em>':'') + '<div style="color:var(--ink-faint);font-size:11.5px;max-width:420px;">' + escapeHtml(v.text) + '</div></td><td>'+s.sends+'</td><td>'+s.responses+'</td><td>'+rate+'</td>';
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
    if(i.small) li.appendChild(h('span',{class:'hint-tag'},['hint · small sample']));
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

function calEventLabel(c){ return new Date(c.callDateTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) + ' ' + c.name; }


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
        '<span class="t">'+escapeHtml(new Date(c.callDateTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</span> · '+escapeHtml(c.name) +
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
      '<strong>'+escapeHtml(new Date(c.callDateTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</strong> · '+escapeHtml(c.name) +
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
    tr.innerHTML = '<td>'+fmtTime(d,c.timezone)+'</td><td>'+escapeHtml(c.name)+'</td><td>'+escapeHtml(c.phone)+'</td><td>&nbsp;</td>';
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
  var samples = eligibleVariants(STATE, stage, client).map(function(v){ return renderTemplate(v.text, client, sender); });
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
    'Match ' + sender + '\'s real texting voice exactly, shown in these example messages they actually send for this same stage ("' + stage + '"):',
    samples.map(function(s){ return '- "' + s + '"'; }).join('\n'),
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
    renderCallsBoard();
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

function closeModal(){ el('modal-root').innerHTML = ''; openDayListKey = null; }

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
      '<div class="hint">Nothing in your library yet. The Emails tab is where they live.</div></div>';
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
  var msgLog = c.messageLog.map(function(m){
    return '<div class="msg-log-item"><div class="meta">' + escapeHtml(m.stage) + ' · ' + escapeHtml(m.variantId || '') + ' · ' +
      new Date(m.sentAt).toLocaleString() + ' · ' + escapeHtml(interactionLabel({state: messageState(m, new Date()), hoursAgo: null})) +
      '</div>' + escapeHtml(m.text) + '</div>';
  }).join('') || '<div style="color:var(--ink-faint);font-size:12px;">No messages sent yet.</div>';

  var outcomeButtons = ['Booked','Confirmed','Showed','Rescheduled','No-show','Ghosted'].map(function(o){
    return '<button class="btn btn-sm' + ((OUTCOME_TO_STATUS[o]===c.status)?' btn-primary':'') + '" data-action="set-outcome" data-cid="'+c.id+'" data-status="'+o+'">'+o+'</button>';
  }).join('');

  openModalHtml(
    '<div class="modal-head"><h2>' + escapeHtml(c.name) + '</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>' +
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

function openSettingsModal(){
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
    '<div class="set-section"><h3>Pipeline stages</h3>' +
    '<div class="hint">The role is what Ghost Recall acts on, not the name — so an HVAC shop can call its won stage “Estimate Completed” and the cadence still stops there.</div>' +
    stageRows +
    '<button class="btn btn-sm" data-action="add-stage">+ Add stage</button>' +
    (removed.length ? '<div class="set-warn">⚠ ' + removed.map(function(k){ return counts[k] + ' contact(s) on “' + escapeHtml(k) + '”'; }).join(', ') +
      ' — removing a stage leaves them on it. Unrecognised stages behave as “open”, so they keep getting followed up rather than disappearing.</div>' : '') +
    '</div>' +
    '<div class="set-section"><h3>Follow-up cadence</h3>' +
    '<div class="hint">When Ghost Recall chases. Removing a step stops that touch firing; the message templates for it stay put, so nothing is lost if you add it back.</div>' +
    SETTINGS_DRAFT.sequence.map(function(st, i){
      return '<div class="stage-row">' +
        '<span class="grip">' + (i+1) + '</span>' +
        '<span style="flex:1;min-width:0;font-size:12.5px;"><strong>' + escapeHtml(st.stage) + '</strong> — ' +
        escapeHtml(describeTrigger(st.trigger)) + '</span>' +
        '<button data-action="remove-step" data-idx="' + i + '" title="Remove this touch">✕</button>' +
      '</div>';
    }).join('') +
    (SETTINGS_DRAFT.sequence.length < buildDefaultSequence().length
      ? '<button class="btn btn-sm" data-action="restore-sequence">Restore the default cadence</button>' : '') +
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
    '<div class="hint">Your emails live in the Emails tab. The Email button on a ' +
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
    '<div class="set-section"><h3>What you call things</h3>' +
    '<div class="hint">Changes the words in the interface. Nothing behavioural.</div>' +
    '<div class="term-grid">' + termFields + '</div></div>' +
    '<div class="field-row" style="text-align:right;">' +
      '<button class="btn btn-sm btn-ghost" data-action="reset-settings">Reset to defaults</button> ' +
      '<button class="btn btn-sm btn-green" data-action="save-settings">Save settings</button>' +
    '</div>',
    true
  );
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
  STATE.pipeline = stages;
  STATE.terminology = d.terminology;
  STATE.sequence = d.sequence;
  setPipeline(stages);
  setTerminology(d.terminology);
  setSequence(d.sequence);
  saveState(STATE);
  closeModal();
  renderAll();
  showToast('Settings saved.');
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

  switch(action){
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
        var state = btoa(JSON.stringify({userId: userId, priority: priority, label: label}));
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
    case 'tab':
      UI.tab = target.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b===target); });
      document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.toggle('active', p.id==='tab-'+UI.tab); });
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
        recordInteractionOutcome(STATE, cid, oKey, {});
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
      recordInteractionOutcome(STATE, cid, ck, {
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

      // The business's own words, so the model has a voice to match.
      var examples = chan === 'sms'
        ? (STATE.variants.welcome || []).map(function(v){ return v.text; })
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
      SETTINGS_DRAFT.sequence = buildDefaultSequence();
      renderSettingsModal();
      break;
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
      reviewMessage(STATE, cid, parseInt(target.getAttribute('data-idx'),10), true);
      renderAll();
      break;
    case 'review-silent':
      reviewMessage(STATE, cid, parseInt(target.getAttribute('data-idx'),10), false);
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
    case 'reset-text':
      delete editedTextCache[cid + '|' + stage];
      renderCallsBoard();
      break;
    case 'generate-ai':
      generateAIMessage(cid, stage, target);
      break;
    case 'snooze-touch':
      snoozeTouch(STATE, cid, stage);
      renderAll();
      showToast('Pushed to tomorrow.');
      break;
    case 'open-sms':
      setTimeout(function(){
        var cb = document.querySelector('input[data-action="mark-sent"][data-cid="'+cid+'"][data-stage="'+stage+'"]');
        if(cb && !cb.checked){ cb.checked = true; doMarkSent(cid, stage); }
      }, 700);
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
    var c = STATE.clients[cid2];
    if(c){
      if(field === 'callDateTime') c.callDateTime = t.value ? parseDatetimeLocalInTZ(t.value, c.timezone || 'America/New_York') : null;
      else c[field] = t.value;
      // Picking a zone by hand is a deliberate correction — flag it so the
      // area-code guess stops overriding it on every load.
      if(field === 'timezone') c.timezoneConfirmed = true;
      saveState(STATE); renderAll();
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
      var sendLink = document.querySelector('[data-action=focus-send]');
      if(sendLink) sendLink.click(); else focusSend();
      return;
    }
    if((ev.key === 's' || ev.key === 'S') && !typing){ ev.preventDefault(); focusAdvance(); return; }
    return;
  }
  if(ev.key === '/'){ ev.preventDefault(); var s = el('calls-search'); if(s){ UI.tab='calls'; document.querySelector('[data-action=tab][data-tab=calls]').click(); s.focus(); } return; }
  // Kept in step with the tab bar, including Closed and the Graveyard — a
  // shortcut that stops halfway along the row is worse than none.
  if(['1','2','3','4','5','6','7'].indexOf(ev.key) !== -1){
    var tabs = ['calls','clients','variants','weekly','calendar','closed','dead'];
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

// toggleReplied() can flip a reply mark back off (checked by mistake) — the
// pooled table needs the matching -1 in that case, or it drifts out of sync
// with the real per-message state forever.
function doToggleReplied(cid, idx){
  var client = STATE.clients[cid];
  var msg = client && client.messageLog[idx];
  toggleReplied(STATE, cid, idx);
  if(msg && msg.variantId !== 'custom') pooledIncrementIfBuiltin(msg.stage, msg.variantId, 'responses', msg.responded ? 1 : -1);
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
    if(channel !== 'email' && logged.variantId !== 'custom'){
      pooledIncrementIfBuiltin(stage, logged.variantId, 'sends');
    }
  }
  saveState(STATE);
}

function doMarkSent(cid, stage){
  var client = STATE.clients[cid];
  var text = getCardText(STATE, client, stage);
  markSent(STATE, cid, stage, text);
  var logged = client.messageLog[client.messageLog.length - 1];
  if(logged && logged.variantId !== 'custom') pooledIncrementIfBuiltin(stage, logged.variantId, 'sends');
  renderAll();
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
        (smsHref
          ? '<a class="btn btn-primary btn-lg focus-send" href="' + smsHref + '" data-action="focus-send">Send &amp; next</a>'
          : '<button class="btn btn-lg" data-action="focus-copy">Copy &amp; next</button>') +
        '<button class="btn" data-action="focus-skip">Not now</button>' +
        '<button class="btn btn-ghost" data-action="focus-snooze">Not today</button>' +
        '<button class="btn btn-ghost" data-action="focus-skip-forever">Never send this</button>' +
      '</div>' +
      '<div class="focus-hint">Enter to send · S to skip · Esc to stop</div>' +
    '</div>', true);
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
    html += '<div class="busted-panel">' + bustedBadgeHtml() +
      '<div class="busted-title">Busted!</div>' +
      '<div class="busted-sub">The day is closed — nothing left.</div></div>';
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

async function init(){
  STATE = await loadState();
  renderAll();
}

// A countdown that only updates on reload is worse than none — it reads as
// authoritative while quietly going stale. Re-render just the panel on a
// timer; it's cheap and touches nothing else.
if(typeof setInterval !== 'undefined'){
  setInterval(function(){ if(STATE) renderOnDeck(); }, 30000);
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
  _resetCaches: function(){ stickyVariantCache = {}; editedTextCache = {}; },
  _setState: function(s){ STATE = s; }
};
if(typeof module !== 'undefined' && module.exports){ module.exports = __GB_EXPORTS__; }
if(typeof window !== 'undefined'){ window.GhostBuster = __GB_EXPORTS__; }
