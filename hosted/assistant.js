'use strict';
// Independent, failure-isolated pilot. Never calls messaging or CRM mutators.
(function () {
  var root, launcher, output, status, question, controls, generation = 0;
  function el(tag, text, parent) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  function reset() {
    generation++;
    if (root) root.remove();
    if (launcher) launcher.remove();
    root = launcher = null;
  }
  function button(label, action, parent) {
    var b = el('button', label, parent); b.type = 'button'; b.addEventListener('click', action); return b;
  }
  async function run(mode) {
    var epoch = generation;
    if (mode === 'ask' && !question.value.trim()) { question.focus(); return; }
    controls.forEach(function(b){b.disabled = true;});
    output.replaceChildren(); status.textContent = 'Checking your current records…';
    try {
      var result = await window.GB_SUPABASE.functions.invoke('ghost-assistant', {body:{mode:mode,question:mode === 'ask' ? question.value.trim() : ''}});
      if (epoch !== generation || !root) return;
      if (result.error || !result.data || result.data.error) throw new Error(result.data && result.data.error || 'Assistant unavailable. Check pilot setup or try again shortly.');
      var data = result.data;
      status.textContent = 'Checked ' + new Date(data.as_of).toLocaleString() + ' · Read-only · Recent history and text may be limited';
      el('div',data.answer,output).className = 'ga-answer';
      if (data.findings && data.findings.length) {
        el('h3','Verified workflow checks',output);
        data.findings.forEach(function(f){
          var card = el('div','',output); card.className = 'ga-finding';
          el('p',f.detail,card);
          (f.client_ids || []).slice(0,5).forEach(function(id){
            button('Review client',function(){
              if (typeof openClientModal === 'function') { root.hidden = true; launcher.setAttribute('aria-expanded','false'); openClientModal(id); }
            },card);
          });
        });
      }
      var feedback = el('div','Was this useful?',output);
      ['helpful','incorrect'].forEach(function(value){
        button(value === 'helpful' ? 'Helpful' : 'Needs correction',async function(){
          var saved = await window.GB_SUPABASE.from('assistant_runs').update({feedback:value}).eq('id',data.id);
          if (epoch !== generation) return;
          feedback.textContent = saved.error ? 'Could not save feedback. Try another briefing.' : 'Feedback saved: ' + value;
        },feedback);
      });
    } catch (error) {
      if (epoch === generation && root) status.textContent = error.message + ' No messages were sent or records changed.';
    } finally {
      if (epoch === generation && root) controls.forEach(function(b){b.disabled = false;});
    }
  }
  window.gbAssistantStop = reset;
  window.gbAssistantStart = async function () {
    reset();
    var epoch = generation;
    try {
      var who = await window.GB_SUPABASE.auth.getUser();
      var user = who.data && who.data.user;
      if (!user) return;
      var allowed = await window.GB_SUPABASE.from('assistant_pilot_users').select('enabled').eq('user_id',user.id).eq('enabled',true).maybeSingle();
      if (epoch !== generation || allowed.error || !allowed.data) return;
      var app = document.getElementById('app-root');
      launcher = button('👻 Assistant', function(){
        root.hidden = !root.hidden;
        launcher.setAttribute('aria-expanded',String(!root.hidden));
        if (!root.hidden) question.focus();
      },app);
      launcher.id = 'ga-launcher'; launcher.setAttribute('aria-expanded','false'); launcher.setAttribute('aria-controls','ga-panel');
      root = el('section','',app); root.id = 'ga-panel'; root.hidden = true; root.setAttribute('aria-label','Private Ghost Recall assistant');
      var header = el('header','',root);
      el('h2','Your Ghost assistant',header);
      button('Close',function(){root.hidden=true;launcher.setAttribute('aria-expanded','false');launcher.focus();},header);
      el('p','Private pilot · Suggestions only. Review messages in your existing texting workspace.',root);
      var actions = el('div','',root); actions.className = 'ga-actions';
      controls = [button('My briefing',function(){run('briefing');},actions),button('Improve my workflow',function(){run('optimize');},actions)];
      var label = el('label','Ask about your clients or workflow',root); label.htmlFor = 'ga-question';
      question = el('textarea','',root); question.id='ga-question';question.maxLength=1500;question.rows=3;
      question.placeholder = 'Who needs my attention? What should I prepare for my next call?';
      controls.push(button('Ask assistant',function(){run('ask');},root));
      status = el('p','Choose a briefing or ask a question. Nothing runs until you ask.',root);status.setAttribute('role','status');
      output = el('div','',root); output.className='ga-output';
      root.addEventListener('keydown',function(e){if(e.key==='Escape'){root.hidden=true;launcher.setAttribute('aria-expanded','false');launcher.focus();}});
    } catch (_) { /* Missing pilot migration must never break the CRM. */ }
  };
})();
