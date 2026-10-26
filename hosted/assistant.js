'use strict';
/* Read-only pilot. All actions route to existing reviewed workflows. */
(function(root){
  function brief(state, now, logic){
    now = now || new Date();
    var clients = Object.values(state.clients || {}).filter(function(c){ return c && !c.ignored; });
    var rows = logic.conversationList(state, now);
    var priorities = [];
    clients.forEach(function(c){
      var row = rows.find(function(r){ return r.clientId === c.id; });
      var call = Date.parse(c.callDateTime || '');
      var soon = call >= now.getTime() && call < now.getTime() + 86400000;
      var due = logic.computeDue(c, now);
      var reason = row && row.awaitingReply ? 'Their latest message is waiting for an answer.'
        : soon ? 'Appointment in the next 24 hours. Review the conversation before the call.'
        : due.length ? 'Your existing follow-up schedule has a touch due.' : '';
      if(reason) priorities.push({id:c.id, name:c.name || 'Unnamed client', reason:reason,
        kind:row && row.awaitingReply ? 'Reply' : soon ? 'Appointment' : 'Follow-up',
        rank:row && row.awaitingReply ? 0 : soon ? 1 : 2,
        at:soon ? call : (row && row.lastT) || 0});
    });
    priorities.sort(function(a,b){ return a.rank-b.rank || a.at-b.at || a.id.localeCompare(b.id); });
    var tips = [];
    var cal = logic.calendarHealth(state.calendarConnections, now);
    if(cal.state === 'stale' || cal.state === 'partial') tips.push('A connected calendar is behind on syncing. Check Calendar before relying on the appointment list.');
    if(cal.state === 'none') tips.push('No Google calendar connection is loaded. If bookings should sync automatically, check Calendar.');
    var missing = clients.filter(function(c){ return !c.phone && !c.email; }).length;
    if(missing) tips.push(missing + ' clients have neither a phone number nor an email. Add a contact method before planning outreach.');
    var waiting = priorities.filter(function(p){ return p.kind === 'Reply'; }).length;
    if(waiting) tips.push('Answer the ' + waiting + ' waiting conversations before starting routine follow-ups.');
    if(!tips.length) tips.push('No issues found by these checks. Work through the priority list, then review Performance for longer-term trends.');
    return {at:now.toISOString(), priorities:priorities, tips:tips,
      waiting:waiting, appointments:clients.filter(function(c){var t=Date.parse(c.callDateTime);return t>=now.getTime() && t<now.getTime()+86400000;}).length,
      due:priorities.filter(function(p){return p.kind==='Follow-up';}).length,
      todos:(state.todos || []).filter(function(t){return !t.done;}).map(function(t){return String(t.text || '');})};
  }
  if(typeof module !== 'undefined' && module.exports){ module.exports = {brief:brief}; return; }
  var allowed = false, busy = false, answer = '', requestVersion = 0;
  root.initAssistant = async function(){
    var version = ++requestVersion;
    try {
      var res = await root.GB_SUPABASE.functions.invoke('gemini-draft', {body:{mode:'assistant-access'}});
      if(version !== requestVersion) return;
      allowed = !res.error && res.data && res.data.allowed === true;
    } catch(e){ if(version !== requestVersion) return; allowed = false; }
    root.renderAssistant();
  };
  root.renderAssistant = function(){
    var tab = document.getElementById('tab-btn-assistant');
    var box = document.getElementById('assistant-brief');
    if(!tab || !box) return;
    tab.classList.toggle('hidden', !allowed);
    if(!allowed || !STATE){
      box.replaceChildren();
      document.getElementById('assistant-answer').textContent = '';
      return;
    }
    var b = brief(STATE, new Date(), root);
    box.replaceChildren();
    box.appendChild(h('p',{class:'assistant-meta'},['Based on loaded account data • Updated ' + new Date(b.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})]));
    box.appendChild(h('p',{},[b.waiting + ' waiting for an answer · ' + b.appointments + ' appointments in the next 24 hours · ' + b.due + ' other follow-ups due']));
    if(!b.priorities.length) box.appendChild(h('p',{},['No priorities found in the loaded data.']));
    b.priorities.slice(0,5).forEach(function(p){
      box.appendChild(h('div',{class:'assistant-item'},[
        h('div',{},[h('strong',{},[p.name]),h('p',{},[p.reason])]),
        h('button',{class:'btn btn-sm','data-action':'assistant-open','data-cid':p.id},['Review ' + p.kind.toLowerCase()])
      ]));
    });
    if(b.priorities.length>5) box.appendChild(h('button',{class:'btn btn-sm','data-action':'tab','data-tab':'threads'},['See all conversations (' + b.priorities.length + ' priorities)']));
    box.appendChild(h('h3',{},['Improve my workflow']));
    b.tips.forEach(function(t){box.appendChild(h('p',{},[t]));});
    if(b.todos.length){box.appendChild(h('h3',{},['Open tasks (' + b.todos.length + ')']));b.todos.slice(0,5).forEach(function(t){box.appendChild(h('p',{},[t]));});}
    document.getElementById('assistant-answer').textContent = answer;
  };
  document.addEventListener('click', async function(ev){
    var target = ev.target.closest('[data-action]');
    if(!target || !allowed) return;
    var action = target.getAttribute('data-action');
    if(action === 'assistant-open'){
      // Keep the existing contact's unsent draft before moving to another one.
      stashDraft();
      var button = document.createElement('button');
      button.hidden = true; button.dataset.action='open-thread'; button.dataset.cid=target.dataset.cid;
      document.body.appendChild(button); button.click(); button.remove();
    }
    if(action === 'tab' && target.dataset.tab === 'assistant') root.renderAssistant();
    if(action !== 'assistant-ask' || busy) return;
    var question = document.getElementById('assistant-question').value.trim();
    if(!question) return;
    var version = ++requestVersion, userId = STATE.userId;
    busy=true;target.disabled=true;
    answer='Thinking…';root.renderAssistant();
    try {
      var b = brief(STATE,new Date(),root);
      var context = {snapshotAt:b.at,waiting:b.waiting,appointmentsNext24Hours:b.appointments,
        otherFollowupsDue:b.due,priorities:b.priorities.slice(0,20),workflowChecks:b.tips,openTasks:b.todos.slice(0,10)};
      var res = await root.GB_SUPABASE.functions.invoke('gemini-draft', {body:{mode:'assistant',question:question,context:context}});
      if(res.error || !res.data || !res.data.text) throw new Error('Assistant unavailable');
      if(version===requestVersion && STATE.userId===userId) answer=res.data.text;
    } catch(e){if(version===requestVersion) answer='Could not reach the assistant. Your priority list still works. Please try again.';}
    finally{busy=false;target.disabled=false;root.renderAssistant();}
  });
  root.clearAssistant = function(){allowed=false;answer='';requestVersion++;root.renderAssistant();var q=document.getElementById('assistant-question');if(q)q.value='';};
})(typeof window !== 'undefined' ? window : globalThis);
