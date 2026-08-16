'use strict';
/* GhostBuster (hosted build) — render layer, event handling, and app boot.
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

var UI = {tab:'calls', statsRange:'today', callsSearch:'', clientsSearch:'', statusFilter:null, calendarView:'month', calendarAnchor:new Date(), recentSendsOpen:true};

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


function renderAll(){
  if(!STATE) return;
  renderHealthAlerts();
  renderProgressBar();
  renderStats();
  renderTodos();
  renderCallsBoard();
  renderRecentSends();
  renderClientsTab();
  renderVariantsTab();
  renderWeeklyTab();
  renderCalendarTab();
  renderDeadTab();
  var eodCount = computeEndOfDayItems(STATE).length;
  var eodEl = el('eod-count'); if(eodEl) eodEl.textContent = '(' + eodCount + ')';
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
    ['Show-up rate', s.showUpRate, prev ? prev.showUpRate : null, {}],
    ['Close rate', s.closeRate, prev ? prev.closeRate : null, {}],
    ['Text response rate', s.responseRate, prev ? prev.responseRate : null, {}],
    ['Reschedule rate', s.rescheduleRate, prev ? prev.rescheduleRate : null, {lowerIsBetter:true}],
    ['Calls tracked', s.callsTracked, prev ? prev.callsTracked : null, {isCount:true, neutral:true}]
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
    box.appendChild(h('div',{class:'stat-card'},[
      h('div',{class:'label'},[label]),
      valueRow
    ]));
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
  var stageChip = h('span',{class:'stage-chip' + (stage==='noshow'?' noshow':'') + (stage==='recovery'?' recovery':'')},[stage]);
  var tzChip = h('span',{class:'tz-chip' + (tzInfo.warn?' tz-warn':'')},[tzInfo.timeLabel + ' their time']);
  top.appendChild(nameEl); top.appendChild(stageChip); top.appendChild(tzChip);
  card.appendChild(top);

  if(tzInfo.warn){
    card.appendChild(h('div',{class:'tz-warn-text'},['⚠ It\'s outside normal hours for ' + client.name + ' right now.']));
  }

  var lastIdx = lastMessageIndex(client);
  if(lastIdx !== -1){
    var lastMsg = client.messageLog[lastIdx];
    var quickReply = document.createElement('label');
    quickReply.className = 'quick-reply-toggle';
    var qcb = h('input',{type:'checkbox','data-action':'toggle-replied-quick','data-cid':client.id,'data-idx':String(lastIdx)});
    qcb.checked = !!lastMsg.responded;
    quickReply.appendChild(qcb);
    quickReply.appendChild(document.createTextNode('replied to last text (' + lastMsg.stage + ')'));
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
  actions.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'generate-ai','data-cid':client.id,'data-stage':stage,title:'Draft a custom text from this client\'s notes, in John\'s voice'},['✨ Generate with AI']));
  actions.appendChild(h('button',{class:'btn btn-sm btn-ghost','data-action':'snooze-touch','data-cid':client.id,'data-stage':stage,title:'Push this to tomorrow'},['Not today']));
  var sentLabel = document.createElement('label');
  sentLabel.className = 'sent-label';
  var cb = h('input',{type:'checkbox','data-action':'mark-sent','data-cid':client.id,'data-stage':stage});
  sentLabel.appendChild(cb);
  sentLabel.appendChild(document.createTextNode('check once sent'));
  actions.appendChild(sentLabel);
  card.appendChild(actions);

  var deleteRow = document.createElement('div');
  deleteRow.className = 'card-delete-row';
  deleteRow.appendChild(h('button',{'data-action':'delete-client-quick','data-cid':client.id,title:'Remove this client entirely'},['Delete client']));
  card.appendChild(deleteRow);

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
  var div = document.createElement('div');
  div.className = 'busted-panel';
  div.innerHTML = bustedBadgeHtml() +
    '<div class="busted-title">Busted!</div>' +
    '<div class="busted-sub">' + escapeHtml(subtitle || 'Inbox zero — nothing due right now.') + '</div>';
  return div;
}


function renderCallsBoard(){
  var now = new Date();
  var textToday = getTextTodayList(STATE, now, UI.callsSearch);
  var todayCol = el('col-text-today');
  if(todayCol){
    todayCol.innerHTML = '';
    if(!textToday.length){
      todayCol.appendChild(UI.callsSearch.trim() ? h('div',{class:'empty-note'},['No matches for "' + UI.callsSearch.trim() + '".']) : buildBustedPanel());
    }
    textToday.forEach(function(it){ todayCol.appendChild(buildTouchCard(it.client, it.stage, now)); });
  }
  var countToday = el('count-today'); if(countToday) countToday.textContent = '(' + textToday.length + ')';
}


/* ---- recent sends: "did they reply?" review, newest first ---- */
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
    var repliedCb = h('input',{type:'checkbox','data-action':'toggle-replied-quick','data-cid':it.client.id,'data-idx':String(it.idx)});
    repliedCb.checked = !!it.message.responded;
    var label = h('label',{class:'replied-label'},[repliedCb, 'replied']);
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
  chipsBox.innerHTML = '';
  var allChip = h('button',{class:'chip'+(UI.statusFilter===null?' active':''),'data-action':'filter-status','data-status':''},['All (' + clients.filter(function(c){return !c.ignored;}).length + ')']);
  chipsBox.appendChild(allChip);
  VALID_STATUSES.forEach(function(st){
    var n = clients.filter(function(c){ return c.status===st && !c.ignored; }).length;
    chipsBox.appendChild(h('button',{class:'chip'+(UI.statusFilter===st?' active':''),'data-action':'filter-status','data-status':st},[st + ' (' + n + ')']));
  });

  var q = UI.clientsSearch.trim().toLowerCase();
  var list = clients.filter(function(c){ return !c.ignored; });
  if(UI.statusFilter) list = list.filter(function(c){ return c.status===UI.statusFilter; });
  if(q) list = list.filter(function(c){ return c.name.toLowerCase().indexOf(q)!==-1; });
  list.sort(byCallDate);

  var tbody = el('clients-table-body'); tbody.innerHTML = '';
  if(!list.length){
    var emptyTd = h('td',{colspan:'6'},[]);
    emptyTd.innerHTML = '<div class="empty-mascot">' + slimerSvg(56) + '<div>No clients found.</div></div>';
    tbody.appendChild(h('tr',{},[emptyTd]));
  }
  list.forEach(function(c){
    var d = safeDate(c.callDateTime);
    var when = d ? (fmtDate(d, c.timezone) + ' ' + fmtTime(d, c.timezone)) : '—';
    var lastIdx = lastMessageIndex(c);
    var repliedCell;
    if(lastIdx === -1){
      repliedCell = h('td',{class:'replied-cell'},['—']);
    } else {
      var repliedCb = h('input',{type:'checkbox','data-action':'toggle-replied-quick','data-cid':c.id,'data-idx':String(lastIdx)});
      repliedCb.checked = !!c.messageLog[lastIdx].responded;
      repliedCell = h('td',{class:'replied-cell'},[repliedCb]);
    }
    var tr = h('tr',{class:'clickable','data-action':'open-client','data-cid':c.id},[
      h('td',{},[c.name]),
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
  var samples = eligibleVariants(STATE, stage, client).map(function(v){ return renderTemplate(v.text, client); });
  var callDate = safeDate(client.callDateTime);
  var tz = client.timezone || 'America/New_York';
  var lines = [
    'You are drafting a single SMS text message for John, a real estate YouTube coach, to send to a client/lead named ' + firstName(client.name) + '.',
    'Match John\'s real texting voice exactly, shown in these example messages he actually sends for this same stage ("' + stage + '"):',
    samples.map(function(s){ return '- "' + s + '"'; }).join('\n'),
    'Casual, warm, short — texting voice, not email or ad copy. No corporate phrasing, no emoji unless the examples use them, no signing off with his name unless the examples do.',
  ];
  if(callDate) lines.push('Their call is on ' + fmtDate(callDate, tz) + ' at ' + fmtTime(callDate, tz) + '.');
  if(client.notes) lines.push('Notes John has on this client: ' + client.notes);
  if(client.recap) lines.push('Recap from a prior call with them: ' + client.recap);
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


function openClientModal(clientId){
  var c = STATE.clients[clientId];
  if(!c) return;
  var d = safeDate(c.callDateTime);
  var callVal = d ? formatDatetimeLocalInTZ(d, c.timezone || 'America/New_York') : '';
  var msgLog = c.messageLog.map(function(m, idx){
    return '<div class="msg-log-item"><div class="meta">' + m.stage + ' · ' + m.variantId + ' · ' + new Date(m.sentAt).toLocaleString() +
      ' <label style="float:right;"><input type="checkbox" data-action="toggle-replied" data-cid="'+c.id+'" data-idx="'+idx+'" '+(m.responded?'checked':'')+'> replied</label></div>' +
      escapeHtml(m.text) + '</div>';
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
    '<div class="field-row"><label>Closed?</label><div class="outcome-btns">' +
      '<button class="btn btn-sm' + (c.closeOutcome==='Closed'?' btn-green':'') + '" data-action="set-close" data-cid="'+c.id+'" data-close="Closed">Closed</button>' +
      '<button class="btn btn-sm' + (c.closeOutcome==='Not closed'?' btn-primary':'') + '" data-action="set-close" data-cid="'+c.id+'" data-close="Not closed">Not closed</button>' +
    '</div></div>' +
    '<div class="field-row"><label>Message log</label>' + msgLog + '</div>' +
    '<div class="field-row" style="text-align:right;"><a href="#" class="delete-client-link" data-action="delete-client-quick" data-cid="'+c.id+'" title="Remove this client entirely">Delete client</a></div>',
    true
  );
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
        var added = cals.reduce(function(sum,c){ return sum + (c.added||0); }, 0);
        var updated = cals.reduce(function(sum,c){ return sum + (c.updated||0); }, 0);
        if(!cals.length){ showToast('No calendar connected yet — use "Connect calendar" first.'); return; }
        showToast('Synced: ' + added + ' new, ' + updated + ' updated.');
        init();
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
    case 'filter-status':
      UI.statusFilter = target.getAttribute('data-status') || null;
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
      toggleReplied(STATE, cid, parseInt(target.getAttribute('data-idx'),10));
      openClientModal(cid); renderAll();
      break;
    case 'toggle-replied-quick':
      // same underlying toggle as inside the modal, but used from the board/table
      // where popping a modal open on a single tap would defeat the point
      toggleReplied(STATE, cid, parseInt(target.getAttribute('data-idx'),10));
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
  if(t.getAttribute && t.getAttribute('data-action') === 'save-client-field'){
    var cid2 = t.getAttribute('data-cid'), field = t.getAttribute('data-field');
    var c = STATE.clients[cid2];
    if(c){
      if(field === 'callDateTime') c.callDateTime = t.value ? parseDatetimeLocalInTZ(t.value, c.timezone || 'America/New_York') : null;
      else c[field] = t.value;
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
      }catch(e){ showToast('That file could not be read as a GhostBuster backup.'); }
    };
    reader2.readAsText(t.files[0]);
    t.value = '';
  }
});


document.addEventListener('input', function(ev){
  var t = ev.target;
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
  if(ev.key === '/'){ ev.preventDefault(); var s = el('calls-search'); if(s){ UI.tab='calls'; document.querySelector('[data-action=tab][data-tab=calls]').click(); s.focus(); } return; }
  if(['1','2','3','4','5'].indexOf(ev.key) !== -1){
    var tabs = ['calls','clients','variants','weekly','calendar'];
    var btn = document.querySelector('[data-action=tab][data-tab="'+tabs[+ev.key-1]+'"]');
    if(btn) btn.click();
  }
});


function doMarkSent(cid, stage){
  var client = STATE.clients[cid];
  var text = getCardText(STATE, client, stage);
  markSent(STATE, cid, stage, text);
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
  downloadFile(data, 'ghostbuster-backup-' + new Date().toISOString().slice(0,10) + '.json', 'application/json');
}

function exportClientsCsv(){
  var csv = buildClientsCsv(STATE);
  downloadFile(csv, 'ghostbuster-clients-' + new Date().toISOString().slice(0,10) + '.csv', 'text/csv');
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


function openEndOfDayModal(){
  var items = computeEndOfDayItems(STATE);
  var groups = {touch:[], 'today-no-outcome':[], 'overdue-unlogged':[], 'no-close':[], todo:[]};
  items.forEach(function(it){ groups[it.type].push(it); });
  function line(text, extraClass){ return '<li style="padding:6px 0;border-bottom:1px solid var(--border);' + (extraClass||'') + '">' + text + '</li>'; }
  var html = '<div class="modal-head"><h2>End of day</h2><button class="btn-ghost btn" data-action="close-modal">✕</button></div>';
  if(!items.length){
    html += '<div class="busted-panel">' + bustedBadgeHtml() + '<div class="busted-title">Busted!</div><div class="busted-sub">The day is closed — nothing left.</div></div>';
  } else {
    html += '<ol style="padding-left:18px;">';
    groups.touch.sort(function(a,b){ return a.stage==='noshow'?-1:(b.stage==='noshow'?1:0); }).forEach(function(it){ html += line('Text due — <strong>' + escapeHtml(it.client.name) + '</strong> (' + it.stage + ')'); });
    groups['today-no-outcome'].forEach(function(it){ html += line('Today\'s call, no outcome logged — <strong>' + escapeHtml(it.client.name) + '</strong>'); });
    groups['overdue-unlogged'].forEach(function(it){ html += line('<span style="color:var(--red-dark);font-weight:700;">Overdue, unlogged</span> — ' + escapeHtml(it.client.name)); });
    groups['no-close'].forEach(function(it){ html += line('Showed, no close recorded — ' + escapeHtml(it.client.name)); });
    groups.todo.forEach(function(it){ html += line('To-do — ' + escapeHtml(it.todo.text)); });
    html += '</ol>';
  }
  openModalHtml(html, true);
}


/* ============================================================
   14) BOOT
   ============================================================ */

async function init(){
  STATE = await loadState();
  renderAll();
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
