'use strict';
/* The Desk Assistant — a phone on a stand, thirty seconds before a call.
 *
 * Four things in one screen: pick the appointment, read or hear a brief, talk,
 * then say what was promised and have it become a note and a task.
 *
 * Failure-isolated on the same terms as assistant.js: every render is wrapped,
 * a missing table or a 403 costs this panel and nothing else, and no path
 * through it leaves the CRM in a state the rest of the app did not ask for.
 * A helper that can take the app down with it is a worse trade than no helper.
 *
 * It writes exactly twice, both through tables the app already owns, both only
 * after a person has read the proposal and pressed Save:
 *   conversation_notes — the same table doAddNote uses, which nothing can send
 *   todos             — the same checklist the Today tab shows
 * Nothing else. It cannot text anybody, change a status, alter a cadence or
 * record a decline.
 *
 * NOTHING HERE CALLS A MODEL. The brief is composed by deskCheatSheet from
 * records the account already holds, and the recap is parsed by deskParseRecap
 * with a regex. That is a deliberate limit, not a stopgap: a rep reading a
 * brief at speed can only safely repeat a claim that can be checked against
 * the thread, and every sourced line here carries where it came from.
 */
(function () {
  var root = null, launcher = null, cid = null, sheet = null,
      research = null, proposal = null, recog = null, listening = false,
      speaking = false, generation = 0;

  function sb() { return window.GB_SUPABASE; }
  function esc(s) { return escapeHtml(s == null ? '' : String(s)); }

  /* The rep's own timezone, from the browser. There is no column for it and
     inventing one would be a schema change to learn something the device
     already knows -- and knows better, because a rep travelling is in a
     different zone from the one a settings page would remember. */
  function repTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; }
    catch (e) { return 'America/New_York'; }
  }

  function newId() {
    try { return crypto.randomUUID(); }
    catch (e) { return 'd' + Date.now() + '-' + Math.random().toString(16).slice(2); }
  }

  /* Any render that throws leaves this panel broken and the app intact. */
  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); }
      catch (e) {
        var s = document.getElementById('dk-status');
        if (s) s.textContent = 'Something went wrong drawing that. Nothing was saved.';
      }
    };
  }

  function status(msg) {
    var s = document.getElementById('dk-status');
    if (s) s.textContent = msg || '';
  }

  // ------------------------------------------------------------------ speech out

  var ttsOk = (function () {
    try { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); }
    catch (e) { return false; }
  })();

  /* Read the brief aloud, and never before it is asked for.
   *
   * One utterance per line rather than one for the whole script: a phone
   * truncates a long utterance, and a rep who wants to stop should not have to
   * wait for a paragraph to finish. Stop cancels the queue outright.
   */
  function speak() {
    if (!ttsOk || !sheet) return;
    stopSpeak();
    var lines = deskScript(sheet);
    if (!lines.length) return;
    speaking = true;
    paintSpeech();
    lines.forEach(function (line, i) {
      var u = new SpeechSynthesisUtterance(line);
      u.rate = 1.02;
      if (i === lines.length - 1) {
        u.onend = function () { speaking = false; paintSpeech(); };
      }
      u.onerror = function () { speaking = false; paintSpeech(); };
      try { window.speechSynthesis.speak(u); } catch (e) { speaking = false; }
    });
  }

  function stopSpeak() {
    try { if (ttsOk) window.speechSynthesis.cancel(); } catch (e) { /* nothing to stop */ }
    speaking = false;
    paintSpeech();
  }

  function paintSpeech() {
    var read = document.getElementById('dk-read');
    var stop = document.getElementById('dk-stop');
    if (read) read.textContent = speaking ? 'Reading…' : '▶ Read brief';
    if (stop) stop.disabled = !speaking;
  }

  // ------------------------------------------------------------------- speech in

  var asrCtor = (function () {
    try { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
    catch (e) { return null; }
  })();

  /* The mic is explicit, visibly on, and stoppable.
   *
   * Never started on load and never left running: it is a microphone in a
   * room where somebody has just had a private conversation. The transcript
   * goes into the same textarea the typed fallback uses, so the rest of the
   * flow cannot tell how the words arrived -- which is what makes the typed
   * path a real fallback rather than a lesser one.
   */
  function startListening() {
    if (!asrCtor) { status('This browser has no speech recognition. Type it instead.'); return; }
    stopListening();
    try { recog = new asrCtor(); } catch (e) { recog = null; }
    if (!recog) { status('Could not start the microphone. Type it instead.'); return; }
    recog.lang = 'en-US';
    recog.continuous = true;
    recog.interimResults = true;

    var box = document.getElementById('dk-recap');
    var base = box ? box.value : '';

    recog.onresult = safe(function (ev) {
      var finalText = '', interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (finalText) base = (base ? base + ' ' : '') + finalText.trim();
      if (box) box.value = (base + (interim ? ' ' + interim : '')).trim();
    });
    recog.onerror = safe(function (ev) {
      listening = false; paintMic();
      var why = ev && ev.error === 'not-allowed'
        ? 'Microphone access was refused. Type the recap instead.'
        : 'The microphone stopped. What was captured is in the box; type the rest.';
      status(why);
    });
    recog.onend = safe(function () { listening = false; paintMic(); });

    try { recog.start(); listening = true; status(''); }
    catch (e) { listening = false; status('Could not start the microphone. Type it instead.'); }
    paintMic();
  }

  function stopListening() {
    if (recog) { try { recog.stop(); } catch (e) { /* already stopped */ } }
    recog = null;
    listening = false;
    paintMic();
  }

  function paintMic() {
    var b = document.getElementById('dk-mic');
    var live = document.getElementById('dk-listening');
    if (b) b.textContent = listening ? '■ Stop listening' : '● Start listening';
    if (live) {
      live.hidden = !listening;
      live.textContent = listening ? 'Listening… speak now' : '';
    }
  }

  // ---------------------------------------------------------------------- views

  function appointments() {
    try { return deskAppointments(window.STATE, new Date()) || []; }
    catch (e) { return []; }
  }

  function current() {
    var list = appointments();
    if (!list.length) return null;
    var pick = null;
    list.forEach(function (a) { if (a.clientId === cid) pick = a; });
    return pick || list[0];
  }

  function build() {
    if (!sheet && !cid) { /* nothing yet; render decides */ }
    render();
  }

  var render = safe(function () {
    if (!root) return;
    var appt = current();
    cid = appt ? appt.clientId : null;
    sheet = null;
    if (appt && window.STATE && window.STATE.clients[cid]) {
      try {
        sheet = deskCheatSheet(window.STATE, window.STATE.clients[cid], new Date(),
                               {research: research});
      } catch (e) { sheet = null; }
    }

    var body = document.getElementById('dk-body');
    if (!body) return;
    body.innerHTML = appt ? (apptHtml(appt) + researchHtml() + playbackHtml() +
                             briefHtml() + recapHtml()) : emptyHtml();
    paintSpeech();
    paintMic();
  });

  /* No upcoming appointment is a normal state, not an error, and it says what
     would change it rather than leaving a blank panel. */
  function emptyHtml() {
    return '<div class="dk-empty">' +
      '<strong>No upcoming calls.</strong>' +
      '<p>This shows appointments that are still ahead of you, on your own book. ' +
      'Book one, or open a contact and set a call time, and it will appear here.</p>' +
      '</div>';
  }

  function apptHtml(a) {
    var mine = deskLocalTime(a.callAt, repTz());
    var list = appointments();
    var opts = list.map(function (x) {
      return '<option value="' + esc(x.clientId) + '"' +
        (x.clientId === a.clientId ? ' selected' : '') + '>' +
        esc(x.name) + ' · ' + esc(deskLocalTime(x.callAt, repTz()).time) + '</option>';
    }).join('');

    return '<section class="dk-appt">' +
      '<div class="dk-k">Next call</div>' +
      '<h2>' + esc(a.name) + '</h2>' +
      /* The rep's clock FIRST -- they are the one standing up to take it --
         and the prospect's beside it, labelled, because every other screen in
         this app prints the prospect's zone and a brief that silently switched
         is how somebody rings an hour early. */
      '<div class="dk-when"><strong>' + esc(mine.time) + '</strong> your time' +
        '<span class="dk-sep">·</span>' + esc(a.theirTime) + ' theirs' +
        ' <span class="dk-tz">(' + esc(a.theirTimezone) + ')</span></div>' +
      '<div class="dk-meta">' + esc(countdownLabel ? countdownLabel(a.minsUntil) : a.minsUntil + ' min') +
        '<span class="dk-sep">·</span>' +
        (a.confirmed ? 'Confirmed' : '<span class="dk-warn">Not confirmed</span>') +
        (a.declined ? '<span class="dk-sep">·</span><span class="dk-warn">They said no</span>' : '') +
      '</div>' +
      /* Unconfirmed links to the confirmation touch the app ALREADY has,
         rather than a second way to chase the same thing. */
      (!a.confirmed && a.confirmTouch
        ? '<button class="dk-btn dk-sub" data-action="send-text" data-cid="' + esc(a.clientId) +
          '" data-stage="' + esc(a.confirmTouch) + '">Send the ' +
          esc(touchLabel ? touchLabel(a.confirmTouch) : a.confirmTouch) + '</button>'
        : (!a.confirmed
            ? '<div class="dk-note">No confirmation reminder is due right now. ' +
              'Open the contact to chase it.</div>' : '')) +
      (list.length > 1
        ? '<label class="dk-pick">Another call ' +
          '<select id="dk-pick">' + opts + '</select></label>' : '') +
      '</section>';
  }

  /* Research is optional, pasted, and labelled rep-provided wherever it shows.
     There is no retrieval integration in this app -- see the brief's own gaps
     list, which says so rather than implying it looked and found nothing. */
  function researchHtml() {
    if (research) {
      return '<section class="dk-res"><div class="dk-k">Rep-provided research</div>' +
        '<div class="dk-resq">' + esc(research.excerpt) + '</div>' +
        '<div class="dk-src">You pasted this' +
          (research.url ? ' from ' + esc(research.url) : ', source not given') + '</div>' +
        '<button class="dk-btn dk-sub" id="dk-res-clear">Remove it</button></section>';
    }
    return '<details class="dk-res"><summary>Add research you have checked (optional)</summary>' +
      '<label class="dk-lbl">Public URL you verified is theirs' +
        '<input type="url" id="dk-res-url" placeholder="https://…"></label>' +
      '<label class="dk-lbl">Paste a public excerpt' +
        '<textarea id="dk-res-text" rows="3" placeholder="A paragraph from their site or channel…"></textarea></label>' +
      '<div class="dk-src">Nothing is fetched. This app has no retrieval integration, so ' +
        'whatever you paste is shown as rep-provided — vouched for by you, not by us.</div>' +
      '<button class="dk-btn" id="dk-res-use">Use this</button></details>';
  }

  function playbackHtml() {
    if (!ttsOk) {
      return '<section class="dk-play"><div class="dk-note">This browser cannot read ' +
        'aloud. The written brief below is the whole brief.</div></section>';
    }
    /* Ordinary buttons, deliberately: they work with touch and a keyboard, and
       a physical button mapped to a keypress can reach them later without any
       of this changing. */
    return '<section class="dk-play">' +
      '<button class="dk-btn dk-big" id="dk-read">▶ Read brief</button>' +
      '<button class="dk-btn dk-big dk-ghost" id="dk-stop" disabled>■ Stop</button>' +
      '</section>';
  }

  function briefHtml() {
    if (!sheet) return '<div class="dk-note">Could not build a brief for that contact.</div>';
    var out = [];

    if (sheet.declined) {
      out.push('<div class="dk-alarm"><strong>They said no.</strong> ' +
        (sheet.declined.reason ? '“' + esc(sheet.declined.reason) + '” ' : '') +
        'Do not pitch on this call.</div>');
    }

    /* A follow-up leads with the last conversation and what is owed, because
       those are the two things that make a second call go wrong. */
    if (sheet.lastConversation) {
      out.push('<section><div class="dk-k">Last time · ' +
        esc(sheet.lastConversation.daysAgo <= 0 ? 'today'
            : sheet.lastConversation.daysAgo + 'd ago') + '</div>' +
        '<blockquote>' + esc(sheet.lastConversation.text) + '</blockquote></section>');
    }
    if (sheet.promises.length) {
      out.push('<section><div class="dk-k">You owe them</div><ul class="dk-owed">' +
        sheet.promises.map(function (p) {
          return '<li>' + esc(p.text) +
            (p.confidence === 'inferred' ? ' <em>(inferred)</em>' : '') + '</li>';
        }).join('') + '</ul></section>');
    }

    /* SOURCED and SUGGESTED are separate blocks with separate headings, and the
       sourced half carries provenance on every line. A rep who cannot tell
       "she said her budget is 20k" from "ask about budget" will eventually say
       the second as though it were the first, to the person who would know. */
    var onRecord = sheet.sourced.filter(function (x) { return x.label !== 'Outstanding'; });
    if (onRecord.length) {
      out.push('<section><div class="dk-k">On record</div>' +
        onRecord.map(function (x) {
          return '<div class="dk-fact"><span class="dk-flab">' + esc(x.label) + '</span>' +
            '<div class="dk-ftext">' + esc(x.text) + '</div>' +
            '<div class="dk-src">from ' + esc(x.source) + '</div></div>';
        }).join('') + '</section>');
    }

    var g = sheet.suggested;
    out.push('<section class="dk-sugg"><div class="dk-k">Suggested — not from the record</div>' +
      '<div class="dk-s"><span class="dk-slab">Open with</span>' + esc(g.opener) + '</div>' +
      (g.focus.kind !== 'none'
        ? '<div class="dk-s"><span class="dk-slab">' +
          (g.focus.kind === 'objection' ? 'Open objection' : 'Opportunity') +
          '</span>' + esc(g.focus.text) +
          (g.focus.source ? '<div class="dk-src">from ' + esc(g.focus.source) + '</div>' : '') +
          '</div>'
        : '<div class="dk-s"><span class="dk-slab">Focus</span>' + esc(g.focus.text) + '</div>') +
      (g.questions.length
        ? '<div class="dk-s"><span class="dk-slab">Ask</span><ol class="dk-qs">' +
          g.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') +
          '</ol></div>' : '') +
      '<div class="dk-s"><span class="dk-slab">Goal</span>' + esc(g.goal) + '</div>' +
      '</section>');

    if (sheet.gaps.length) {
      out.push('<details class="dk-gaps"><summary>What this cannot tell you (' +
        sheet.gaps.length + ')</summary><ul>' +
        sheet.gaps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        '</ul></details>');
    }
    return '<div class="dk-brief">' + out.join('') + '</div>';
  }

  function recapHtml() {
    if (proposal) return proposalHtml();
    return '<section class="dk-recap"><div class="dk-k">After the call</div>' +
      (asrCtor
        ? '<button class="dk-btn dk-big" id="dk-mic">● Start listening</button>' +
          '<div class="dk-live" id="dk-listening" hidden aria-live="polite"></div>'
        : '<div class="dk-note">This browser has no speech recognition, so type the ' +
          'recap below. Everything after this point is identical either way.</div>') +
      '<label class="dk-lbl">What happened' +
        '<textarea id="dk-recap" rows="3" placeholder="He spoke with the referral and wants a sample script by Friday."></textarea></label>' +
      '<button class="dk-btn" id="dk-make">Turn into a note and a task</button>' +
      '</section>';
  }

  /* The review step. The client and the appointment are named ABOVE the fields,
     because "save this where?" is the question a rep cannot answer from a note
     body -- and the whole point of an approval step is that what is being
     approved is visible. */
  function proposalHtml() {
    var a = current();
    var p = proposal;
    return '<section class="dk-prop"><div class="dk-k">Review before saving</div>' +
      '<div class="dk-dest"><strong>' + esc(p.name) + '</strong>' +
        (a ? '<span class="dk-sep">·</span>call ' + esc(deskLocalTime(a.callAt, repTz()).date) +
             ' ' + esc(deskLocalTime(a.callAt, repTz()).time) : '') +
      '</div>' +
      '<label class="dk-lbl">Note on the contact' +
        '<textarea id="dk-note" rows="4">' + esc(p.note) + '</textarea></label>' +
      '<div class="dk-src">Saved as an internal note. ' + esc(p.firstName) +
        ' never sees it, and it can never be sent.</div>' +

      '<label class="dk-lbl">Follow-up task' +
        '<input type="text" id="dk-task" value="' + esc(p.task.text) + '"></label>' +
      '<label class="dk-lbl">Due' +
        '<input type="date" id="dk-due" value="' + esc(p.task.dueDate || '') + '"></label>' +
      (p.task.dateNeedsRep
        ? '<div class="dk-warn-box">' + esc(p.task.dateWhy) +
          ' Pick a date, or leave it empty and the task is saved without one.</div>'
        : '<div class="dk-src">From “' + esc(p.task.datePhrase) + '” in your recap, read in ' +
          esc(repTz()) + '.</div>') +
      (!p.task.found
        ? '<div class="dk-warn-box">Nothing in that recap sounded like a commitment, so ' +
          'this task is a guess at best. Edit it, or clear the text to save only the note.</div>'
        : '') +

      '<div class="dk-acts">' +
        '<button class="dk-btn dk-big" id="dk-save">Save note and task</button>' +
        '<button class="dk-btn dk-ghost" id="dk-cancel">Back</button>' +
      '</div></section>';
  }

  // ---------------------------------------------------------------------- saving

  /* Two inserts, each with an id generated ONCE when the proposal was built.
   *
   * That is what makes a retry safe: the second attempt carries the same
   * primary key, so the database refuses it as a duplicate and this treats
   * that refusal as success rather than writing a second copy. And each half
   * records its own outcome, so a note that saved while the task failed is not
   * saved twice when the rep presses Save again.
   */
  var doSave = safe(function () {
    var p = proposal;
    if (!p) return;
    var noteBox = document.getElementById('dk-note');
    var taskBox = document.getElementById('dk-task');
    var dueBox = document.getElementById('dk-due');
    var btn = document.getElementById('dk-save');

    var noteText = noteBox ? noteBox.value.trim() : '';
    var taskText = taskBox ? taskBox.value.trim() : '';
    var dueDate = dueBox ? dueBox.value : '';

    if (!noteText && !taskText) { status('Nothing to save.'); return; }
    var st = window.STATE;
    if (!st || !st.userId || !st.orgId) {
      status('Could not tell which account you are in. Reload and try again.');
      return;
    }
    var client = st.clients[p.clientId];
    if (!client) { status('That contact is no longer loaded. Reload and try again.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    status('');

    var jobs = [];

    if (noteText && !p.saved.note) {
      jobs.push(sb().from('conversation_notes')
        .insert({id: p.ids.note, client_id: p.clientId, org_id: st.orgId,
                 user_id: st.userId, body: noteText, created_at: p.at})
        .then(function (res) {
          if (res && res.error && !isDuplicate(res.error)) throw new Error('note');
          p.saved.note = true;
          /* Mirrored into the loaded state so the contact's thread shows it
             without a reload, exactly as doAddNote does. */
          client.threadNotes = client.threadNotes || [];
          client.threadNotes.push({
            id: p.ids.note, body: noteText, userId: st.userId,
            author: (st.teamNames && st.teamNames[st.userId]) || st.senderName || '',
            at: p.at
          });
        }));
    }

    if (taskText && !p.saved.task) {
      jobs.push(insertTask(st, p, taskText, dueDate).then(function () {
        p.saved.task = true;
        st.todos = st.todos || [];
        st.todos.push({id: p.ids.task, text: taskText, done: false,
                       createdAt: p.at, doneAt: null,
                       clientId: p.clientId, dueAt: dueDate || null});
      }));
    }

    Promise.all(jobs).then(function () {
      proposal = null;
      research = research;             // kept: the brief is still the same call
      if (typeof renderAll === 'function') { try { renderAll(); } catch (e) { /* app's own */ } }
      render();
      status('Saved. The note is on ' + p.firstName + '’s thread and the task is on your list.');
    }, safe(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Save note and task'; }
      /* Which half landed is stated, because "it failed" after a partial save
         invites a second press that would otherwise duplicate the good half.
         It will not -- p.saved guards that -- but the rep should still know. */
      status(p.saved.note
        ? 'The note saved; the task did not. Press Save again to retry just the task.'
        : 'Nothing saved. Press Save again to retry.');
    }));
  });

  function isDuplicate(err) {
    var c = String((err && (err.code || err.message)) || '');
    return c.indexOf('23505') !== -1 || /duplicate key/i.test(c);
  }

  /* The task insert, with a fallback for a database that has not had the
     migration yet.

     todos gained client_id and due_at in 20261104010000_todos_client_and_due,
     which an operator applies separately. Until then the insert is retried
     without those two columns -- and the date is ALSO written into the task
     text, both ways round, so nothing is lost either way and the migration
     upgrades sorting rather than enabling the feature. */
  function insertTask(st, p, taskText, dueDate) {
    var dueIso = dueDate ? deskDueInstant(dueDate, repTz()) : null;
    var withDate = dueDate
      ? taskText + ' — due ' + fmtDate(new Date(dueIso), repTz())
      : taskText;
    var base = {id: p.ids.task, user_id: st.userId, org_id: st.orgId,
                text: withDate, done: false, created_at: p.at, done_at: null};
    var full = Object.assign({}, base, {client_id: p.clientId, due_at: dueIso});

    return sb().from('todos').insert(full).then(function (res) {
      if (!res || !res.error) return res;
      if (isDuplicate(res.error)) return res;
      if (isMissingColumn(res.error)) {
        return sb().from('todos').insert(base).then(function (r2) {
          if (r2 && r2.error && !isDuplicate(r2.error)) throw new Error('task');
          return r2;
        });
      }
      throw new Error('task');
    });
  }

  function isMissingColumn(err) {
    var c = String((err && (err.code || err.message)) || '');
    return c.indexOf('42703') !== -1 || /column .* does not exist/i.test(c) ||
           /could not find the .* column/i.test(c);
  }

  // --------------------------------------------------------------------- wiring

  var onClick = safe(function (ev) {
    var t = ev.target;
    if (!t || !t.id) return;
    if (t.id === 'dk-read') { speak(); return; }
    if (t.id === 'dk-stop') { stopSpeak(); return; }
    if (t.id === 'dk-mic') { listening ? stopListening() : startListening(); return; }
    if (t.id === 'dk-res-use') {
      var u = document.getElementById('dk-res-url');
      var x = document.getElementById('dk-res-text');
      research = deskResearch({url: u ? u.value : '', excerpt: x ? x.value : ''});
      if (!research) { status('Paste an excerpt first — a URL on its own is not fetched.'); return; }
      render();
      return;
    }
    if (t.id === 'dk-res-clear') { research = null; render(); return; }
    if (t.id === 'dk-make') {
      var box = document.getElementById('dk-recap');
      var text = box ? box.value.trim() : '';
      if (!text) { status('Say or type what happened first.'); return; }
      stopListening();
      var parsed = deskParseRecap(text, new Date(), repTz());
      if (!parsed) { status('Nothing to turn into a note.'); return; }
      var c = window.STATE && window.STATE.clients[cid];
      proposal = {
        clientId: cid,
        name: c ? c.name : '',
        firstName: c ? firstName(c.name) : '',
        note: parsed.note,
        task: parsed.task,
        at: nowISO(),
        /* Generated ONCE, here. See doSave: this is what makes a retry safe. */
        ids: {note: newId(), task: newId()},
        saved: {note: false, task: false}
      };
      render();
      return;
    }
    if (t.id === 'dk-save') { doSave(); return; }
    if (t.id === 'dk-cancel') { proposal = null; render(); return; }
  });

  var onChange = safe(function (ev) {
    if (ev.target && ev.target.id === 'dk-pick') {
      cid = ev.target.value;
      /* Research belongs to the contact it was pasted for, so switching calls
         drops it rather than carrying somebody else's company blurb onto the
         next brief. */
      research = null;
      proposal = null;
      render();
    }
  });

  function open() {
    if (!root) return;
    root.hidden = false;
    if (launcher) launcher.setAttribute('aria-expanded', 'true');
    render();
    var h = document.getElementById('dk-title');
    if (h) h.focus();
  }

  function close() {
    stopSpeak();
    stopListening();
    if (root) root.hidden = true;
    if (launcher) { launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
  }

  function mount() {
    var host = document.getElementById('app-root') || document.body;

    launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.id = 'dk-launcher';
    launcher.className = 'dk-launcher';
    launcher.textContent = '☎ Desk';
    launcher.title = 'Desk Assistant — prep for your next call';
    launcher.setAttribute('aria-label', 'Open the Desk Assistant');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-controls', 'dk-panel');
    launcher.addEventListener('click', function () { root.hidden ? open() : close(); });
    host.appendChild(launcher);

    root = document.createElement('div');
    root.id = 'dk-panel';
    root.className = 'dk-panel';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-labelledby', 'dk-title');
    root.innerHTML =
      '<header class="dk-head">' +
        '<h1 id="dk-title" tabindex="-1">Desk Assistant</h1>' +
        '<button type="button" class="dk-x" id="dk-close" aria-label="Close">✕</button>' +
      '</header>' +
      '<div class="dk-live" id="dk-status" role="status" aria-live="polite"></div>' +
      '<div id="dk-body"></div>';
    host.appendChild(root);

    document.getElementById('dk-close').addEventListener('click', close);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    });
  }

  /* Enrollment is checked before the launcher exists, and that is a courtesy
     rather than the permission: every read below goes through RLS as the
     signed-in user, and both writes are refused by policy for anybody else's
     contact. Hiding a button is not security and this does not pretend it is.
     The gate is the same table ghost-assistant uses -- one pilot list, not a
     second one to keep in step. */
  window.GBDesk = {
    start: function () {
      var epoch = ++generation;
      if (!sb() || root) return;
      Promise.resolve(sb().auth.getUser())
        .then(function (r) {
          var user = r && r.data && r.data.user;
          if (!user || epoch !== generation) return null;
          return sb().from('assistant_pilot_users').select('enabled')
            .eq('user_id', user.id).eq('enabled', true).maybeSingle()
            .then(function (q) { return (q && !q.error && q.data) ? user : null; });
        })
        .then(function (user) {
          if (!user || epoch !== generation || root) return;
          mount();
        })
        .catch(function () { /* the CRM must survive a pilot that cannot start */ });
    },
    stop: function () {
      generation++;
      stopSpeak();
      stopListening();
      if (launcher && launcher.parentNode) launcher.parentNode.removeChild(launcher);
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = launcher = null;
      cid = sheet = research = proposal = null;
    }
  };

  /* The same hook names auth.js already calls for the assistant, so the boot
     sequence has one shape rather than two. Torn down on sign-out for the
     same reason the assistant is: this holds one account's contact names and
     one account's recap in the DOM, and leaving either behind a hidden
     container would survive into whoever signs in next. */
  window.gbDeskStart = function () { window.GBDesk.start(); };
  window.gbDeskStop = function () { window.GBDesk.stop(); };
})();
