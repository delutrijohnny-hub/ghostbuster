'use strict';
/* The private Ghost assistant.
 *
 * Failure-isolated on purpose: it never calls a messaging or CRM mutator, it
 * is wrapped so a missing table or a 403 costs the panel and nothing else,
 * and every path through it ends with the CRM exactly as it was. An AI panel
 * that can take the app down with it is a worse trade than no AI panel.
 *
 * It is quiet by default. The launcher appears only for an enrolled account,
 * and nothing runs until it is asked: no polling, no opening briefing, no
 * badge. A helper that announces itself every morning is the clutter this
 * was meant to remove.
 */
(function () {
  var root = null, launcher = null, output = null, status = null,
      question = null, controls = [], generation = 0, dismissals = {},
      dismissalsTable = true;

  function el(tag, text, parent, cls) {
    var n = document.createElement(tag);
    if (text != null && text !== '') n.textContent = text;
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function button(label, action, parent, cls) {
    var b = el('button', label, parent, cls);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  }
  function sb() { return window.GB_SUPABASE; }

  /* Any render that throws leaves the panel half-built and the app intact.
     Stated here once rather than try/caught at twenty call sites. */
  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); }
      catch (e) { if (status) status.textContent = 'Something went wrong drawing that. Nothing was changed.'; }
    };
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    if (launcher) { launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
  }

  function reset() {
    generation++;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    if (launcher && launcher.parentNode) launcher.parentNode.removeChild(launcher);
    root = launcher = output = status = question = null;
    controls = [];
  }

  // ---------- rendering ----------

  /* An observation and a suggestion are drawn differently because they ARE
     different: one is a fact about the records with evidence attached, the
     other is a proposal somebody has to agree with. Making them look alike
     is how a guess gets acted on as though it were a measurement. */
  function renderFinding(f, parent) {
    var card = el('div', '', parent, 'ga-card ga-observation');
    var head = el('div', '', card, 'ga-card-head');
    el('span', f.confidence === 'possible' ? 'Possible' : 'Observed', head,
       'ga-tag ' + (f.confidence === 'possible' ? 'maybe' : 'certain'));
    el('span', f.source || 'CRM records', head, 'ga-src');
    el('p', f.detail, card);
    if (f.evidence) {
      var bits = [];
      Object.keys(f.evidence).forEach(function (k) {
        var v = f.evidence[k];
        if (v == null || (Array.isArray(v) && !v.length)) return;
        bits.push(k.replace(/([A-Z])/g, ' $1').toLowerCase() + ': ' +
                  (Array.isArray(v) ? v.slice(0, 3).join('; ') : v));
      });
      if (bits.length) el('p', bits.join('  ·  '), card, 'ga-evidence');
    }
    linkClients(f.clientIds, card);
  }

  /* Every recommendation is walkable back to the people it is about. A
     finding that cannot be opened is one nobody can check. */
  function linkClients(ids, parent) {
    var list = (ids || []).slice(0, 6);
    if (!list.length) return;
    var row = el('div', '', parent, 'ga-links');
    list.forEach(function (id) {
      var c = (window.STATE && window.STATE.clients && window.STATE.clients[id]) || null;
      button(c ? c.name : 'Open contact', function () {
        close();
        if (typeof window.openClientModal === 'function') window.openClientModal(id);
      }, row, 'ga-link');
    });
    if ((ids || []).length > list.length) {
      el('span', '+' + ((ids || []).length - list.length) + ' more', row, 'ga-more');
    }
  }

  function renderSuggestion(s, parent) {
    if (dismissals[s.id] === 'dismissed') return;
    var card = el('div', '', parent, 'ga-card ga-suggestion');
    var head = el('div', '', card, 'ga-card-head');
    el('span', 'Suggestion', head, 'ga-tag suggest');
    el('span', 'from CRM records', head, 'ga-src');
    el('p', s.noticed, card, 'ga-noticed');

    if (s.evidence) {
      var e = s.evidence;
      var line = e.metric ? e.metric + ': ' + JSON.stringify(e.value) : '';
      if (e.of) line += ' of ' + e.of;
      if (e.period) line += '  ·  measured over ' + e.period;
      if (line) el('p', line, card, 'ga-evidence');
    }
    if (s.whyItMatters) el('p', s.whyItMatters, card, 'ga-why');
    if (s.proposedChange) {
      var pc = el('div', '', card, 'ga-change');
      el('strong', 'Proposed change', pc);
      el('p', s.proposedChange, pc);
    }
    if (s.limits && s.limits.length) {
      var lim = el('details', '', card, 'ga-limits');
      el('summary', 'What this cannot tell you', lim);
      el('p', [].concat(s.limits).join(''), lim);
    }
    verdictRow(s.id, card);
  }

  /* Three answers, and they mean different things.

     'Dismissed' is "true, stop telling me" -- which these checks need,
     because they are deterministic and will otherwise produce the identical
     suggestion every morning forever. 'Incorrect' is "wrong about my book",
     and it is the only one that says anything about whether the checks work.
     Collapsing the two would throw that away. */
  function verdictRow(id, parent) {
    var row = el('div', '', parent, 'ga-verdicts');
    var current = dismissals[id] || null;
    [['helpful', 'Helpful'], ['incorrect', 'Not right'], ['dismissed', 'Don’t show again']]
      .forEach(function (pair) {
        var b = button(pair[1], function () { saveVerdict(id, pair[0], row); }, row,
                       'ga-verdict' + (current === pair[0] ? ' on' : ''));
        b.setAttribute('aria-pressed', String(current === pair[0]));
      });
    if (current) {
      el('span', current === 'dismissed' ? 'Hidden from now on'
         : current === 'helpful' ? 'Marked helpful' : 'Marked not right',
         row, 'ga-verdict-note');
    }
    if (!dismissalsTable) {
      el('span', 'Saved for this view only — the feedback table is not set up yet.',
         row, 'ga-verdict-note');
    }
  }

  function saveVerdict(id, verdict, row) {
    dismissals[id] = verdict;
    var epoch = generation;
    var done = function (ok) {
      if (epoch !== generation || !root) return;
      if (!ok) dismissalsTable = false;
      // Redraw just this row, so a dismissal takes effect without a re-run.
      if (verdict === 'dismissed' && row && row.parentNode && row.parentNode.parentNode) {
        row.parentNode.parentNode.removeChild(row.parentNode);
      } else if (row && row.parentNode) {
        var card = row.parentNode;
        card.removeChild(row);
        verdictRow(id, card);
      }
    };
    var uid = window.STATE && window.STATE.userId;
    if (!uid || !sb()) { done(false); return; }
    try {
      sb().from('assistant_suggestion_feedback')
        .upsert({user_id: uid, suggestion_id: id, verdict: verdict,
                 updated_at: new Date().toISOString()}, {onConflict: 'user_id,suggestion_id'})
        .then(function (r) { done(!(r && r.error)); }, function () { done(false); });
    } catch (e) { done(false); }
  }

  function renderCoverage(cov, parent) {
    var d = el('details', '', parent, 'ga-coverage');
    el('summary', 'What I looked at', d);
    var body = el('div', '', d);
    el('p', cov.clients + ' contacts, ' + cov.messages + ' messages, ' +
       cov.replies + ' of them replies' +
       (cov.oldestMessageAt
          ? ' · history from ' + new Date(cov.oldestMessageAt).toLocaleDateString() +
            ' to ' + new Date(cov.newestMessageAt).toLocaleDateString()
          : ' · no message history on record'), body);
    (cov.limits || []).forEach(function (l) { el('p', l, body, 'ga-limit'); });
    el('p', 'Anything outside this is something I cannot see, so I will not tell you it did not happen.',
       body, 'ga-limit');
  }

  var renderBriefing = safe(function (r) {
    output.replaceChildren();
    renderCoverage(r.coverage, output);

    var c = r.counts || {};
    el('p', c.tasks + ' ' + (c.tasks === 1 ? 'job' : 'jobs') + ' you can do now across ' +
       c.clients + ' ' + (c.clients === 1 ? 'person' : 'people') +
       (c.held ? ', and ' + c.held + ' more that cannot be done yet.' : '.'),
       output, 'ga-lead');

    if (r.priorities && r.priorities.length) {
      el('h3', 'What needs you', output);
      r.priorities.slice(0, 8).forEach(function (p) {
        var card = el('div', '', output, 'ga-card ga-priority');
        var head = el('div', '', card, 'ga-card-head');
        el('span', p.groupLabel, head, 'ga-tag ' + (p.eligible ? 'certain' : 'maybe'));
        el('span', 'from ' + p.source, head, 'ga-src');
        el('p', p.name + ' — ' + p.reason, card);
        if (p.holdReason) el('p', 'Not yet: ' + p.holdReason, card, 'ga-evidence');
        el('p', 'Next: ' + p.nextAction, card, 'ga-why');
        linkClients([p.clientId], card);
      });
      if (r.priorities.length > 8) {
        el('p', r.priorities.length - 8 + ' more are on Today, in the same order.', output, 'ga-limit');
      }
    } else {
      el('p', 'Nothing is waiting on you right now.', output, 'ga-lead');
    }

    if (r.appointments && r.appointments.length) {
      el('h3', 'Coming up', output);
      r.appointments.slice(0, 6).forEach(function (a) {
        var card = el('div', '', output, 'ga-card ga-appointment');
        el('p', a.name + ' — ' + a.when + (a.confirmed ? ' · confirmed' : ' · not confirmed'), card);
        if (!a.timezoneConfirmed) {
          el('p', 'Their timezone is derived from their area code, not confirmed.', card, 'ga-evidence');
        }
        linkClients([a.clientId], card);
      });
    }

    if (r.findings && r.findings.length) {
      el('h3', 'What looks wrong in the records', output);
      r.findings.forEach(function (f) { renderFinding(f, output); });
    }
  });

  var renderReview = safe(function (r) {
    output.replaceChildren();
    renderCoverage(r.coverage, output);
    var shown = (r.suggestions || []).filter(function (s) { return dismissals[s.id] !== 'dismissed'; });
    if (!shown.length) {
      el('p', (r.suggestions || []).length
          ? 'Everything I can see has already been dismissed. Nothing new.'
          : 'Nothing in the records suggests a change right now.', output, 'ga-lead');
    }
    shown.forEach(function (s) { renderSuggestion(s, output); });

    var u = r.usageMeasurement || {};
    var note = el('div', '', output, 'ga-card ga-usage');
    el('span', 'Not measured', el('div', '', note, 'ga-card-head'), 'ga-tag maybe');
    el('p', u.note || 'Product usage is not recorded on this account.', note);
  });

  // ---------- running ----------

  var run = function (mode) {
    var epoch = generation;
    if (mode === 'ask' && !question.value.trim()) { question.focus(); return; }
    controls.forEach(function (b) { b.disabled = true; });
    output.replaceChildren();
    status.textContent = 'Reading your current records…';

    var payload = {mode: mode, question: mode === 'ask' ? question.value.trim() : ''};
    try { payload.viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { payload.viewerTimezone = 'UTC'; }

    /* sb() is window.GB_SUPABASE, and reaching .functions on it throws
       SYNCHRONOUSLY when the app has not finished loading in this tab. That
       throw happens outside the promise chain below, so .catch never ran: the
       panel sat on "Reading your current records…" with both buttons disabled
       forever, nothing was sent, and the only trace was a line in the console.
       Silence is the worst failure this panel can produce, because it looks
       exactly like work in progress.

       It also broke this file's own promise that a failure costs the panel and
       nothing else — disabled controls never came back, so the panel was dead
       until the page was reloaded. loadDismissals already guarded the same
       call shape; the call that matters did not. */
    var pending;
    try {
      pending = sb().functions.invoke('ghost-assistant', {body: payload});
    } catch (e) {
      pending = Promise.reject(new Error('Ghost Recall is still loading in this tab, ' +
        'so the assistant could not be reached. Reload the page and try again.'));
    }
    if (!pending || typeof pending.then !== 'function') {
      pending = Promise.reject(new Error('The assistant could not be reached.'));
    }

    pending.then(function (res) {
      if (epoch !== generation || !root) return;
      var data = res && res.data;
      if ((res && res.error) || !data || data.error) {
        throw new Error((data && data.error) ||
          'The assistant could not be reached. Nothing was changed.');
      }
      var ai = data.ai || {};
      status.textContent = 'Read ' + new Date(data.result.asOf).toLocaleString() +
        ' · Read-only · ' + (ai.enabled ? 'AI summary on' : 'No external AI');

      if (ai.note) el('p', ai.note, output, 'ga-limit');
      if (ai.error) el('p', ai.error, output, 'ga-limit');
      if (data.narrative) {
        var n = el('div', '', output, 'ga-card ga-narrative');
        el('span', 'AI summary of the findings below', el('div', '', n, 'ga-card-head'), 'ga-tag maybe');
        el('p', data.narrative, n);
      }
      var holder = el('div', '', output);
      var prev = output; output = holder;
      if (mode === 'optimize') renderReview(data.result); else renderBriefing(data.result);
      output = prev;
    }).catch(function (err) {
      if (epoch !== generation || !root) return;
      status.textContent = (err && err.message ? err.message : 'The assistant is unavailable.') +
        ' No messages were sent and no records were changed.';
    }).then(function () {
      if (epoch === generation && root) controls.forEach(function (b) { b.disabled = false; });
    });
  };

  function loadDismissals(uid) {
    try {
      return sb().from('assistant_suggestion_feedback')
        .select('suggestion_id,verdict').eq('user_id', uid)
        .then(function (r) {
          if (r && r.error) { dismissalsTable = false; return; }
          (r && r.data || []).forEach(function (row) {
            dismissals[row.suggestion_id] = row.verdict;
          });
        }, function () { dismissalsTable = false; });
    } catch (e) { dismissalsTable = false; return Promise.resolve(); }
  }

  // ---------- the panel ----------

  window.gbAssistantStop = reset;

  window.gbAssistantStart = function () {
    reset();
    var epoch = generation;
    if (!sb()) return Promise.resolve();
    return Promise.resolve()
      .then(function () { return sb().auth.getUser(); })
      .then(function (who) {
        var user = who && who.data && who.data.user;
        if (!user) return null;
        /* The enrollment check here is a COURTESY, not the gate. It decides
           whether to draw a button. The real gate is in the database: the
           endpoint refuses, and reserve_assistant_run raises, for anybody not
           enrolled. Hiding a control is not a permission. */
        return sb().from('assistant_pilot_users').select('enabled')
          .eq('user_id', user.id).eq('enabled', true).maybeSingle()
          .then(function (r) {
            if (r && r.error) return null;
            return (r && r.data) ? user : null;
          });
      })
      .then(function (user) {
        if (!user || epoch !== generation) return;
        return Promise.resolve(loadDismissals(user.id)).then(function () { build(); });
      })
      .catch(function () { /* the CRM must survive a pilot that cannot start */ });
  };

  function build() {
    var host = document.getElementById('app-root') || document.body;

    launcher = button('👻', function () {
      root.hidden = !root.hidden;
      launcher.setAttribute('aria-expanded', String(!root.hidden));
      if (!root.hidden) (question || root).focus();
    }, host);
    launcher.id = 'ga-launcher';
    launcher.title = 'Your private assistant';
    launcher.setAttribute('aria-label', 'Open your private assistant');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-controls', 'ga-panel');

    root = el('section', '', host);
    root.id = 'ga-panel';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Your private Ghost Recall assistant');

    var header = el('div', '', root, 'ga-head');
    el('h2', 'Your assistant', header);
    button('Close', close, header, 'ga-close');

    el('p', 'Private pilot · Read-only. It can suggest and draft. It cannot send ' +
       'anything, change a record, merge anybody, or alter your settings.', root, 'ga-sub');

    var actions = el('div', '', root, 'ga-actions');
    controls = [
      button('My briefing', function () { run('briefing'); }, actions, 'ga-primary'),
      button('Improve my workflow', function () { run('optimize'); }, actions)
    ];

    var label = el('label', 'Ask about your clients or your workflow', root, 'ga-label');
    label.htmlFor = 'ga-question';
    question = el('textarea', '', root);
    question.id = 'ga-question';
    question.rows = 2;
    question.maxLength = 1500;
    question.placeholder = 'Who needs me today? What should I know before my next call?';
    controls.push(button('Ask', function () { run('ask'); }, root, 'ga-ask'));

    status = el('p', 'Nothing runs until you ask.', root, 'ga-status');
    status.setAttribute('role', 'status');
    output = el('div', '', root, 'ga-output');

    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }
})();
