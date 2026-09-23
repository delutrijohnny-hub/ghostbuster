'use strict';
/* GhostBuster (hosted build) — Supabase-backed persistence.
   Replaces the local build's localStorage loadState()/saveState() under the
   same names — that's the one seam every mutator in logic.js already calls
   through, per the rebuild plan. loadState() now returns a Promise (app.js's
   init() awaits it); saveState() still fires-and-forgets exactly like the
   local build always did, since no call site ever awaited or used its
   return value.

   saveState() writes incrementally: it diffs the in-memory state against
   SYNCED (what the database was last known to hold) and issues only the rows
   that actually changed. It previously did a full resync — upserting every
   row and deleting anything absent from memory, including a
   delete-the-whole-log-and-reinsert for message_log. That was acceptable
   while one user owned one dataset and nothing else could write to it; it is
   not survivable once two people share data, because the last save wins by
   deleting the other's work. Message rows now carry a client-generated uuid
   so they have stable identity from the moment they exist, which is what
   makes a surgical diff possible at all. See the persistence section below
   for the two invariants that keep deletes safe.

   Depends on window.GB_SUPABASE, the supabase-js client created once in
   auth.js. Loaded after logic.js, before app.js. */

// Fallback when the account has no explicit sender_name set yet — derived
// from the email's local-part (before the @ and before any . _ + separator)
// rather than the Google profile display name, since that name can be
// lowercase/a nickname/differently spelled than what someone actually wants
// clients to see. Anyone can still override it explicitly (sender_name in
// app_settings) if the derived guess isn't right — see credentials-reference
// for the two real accounts' explicit values.
function deriveSenderName(email){
  var local = String(email || '').split('@')[0] || '';
  var first = local.split(/[._+]/)[0] || local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : 'there';
}

async function loadState(){
  var sb = window.GB_SUPABASE;
  var userRes = await sb.auth.getUser();
  var user = userRes.data && userRes.data.user;
  if(!user) return buildDefaultState();
  var uid = user.id;

  var clientsRes = await sb.from('clients').select('*, message_log(*)').eq('user_id', uid);
  if(clientsRes.error) throw clientsRes.error;
  var variantsRes = await sb.from('variants').select('*').eq('user_id', uid);
  if(variantsRes.error) throw variantsRes.error;
  var statsRes = await sb.from('variant_stats').select('*').eq('user_id', uid);
  if(statsRes.error) throw statsRes.error;
  var todosRes = await sb.from('todos').select('*').eq('user_id', uid);
  if(todosRes.error) throw todosRes.error;
  var settingsRes = await sb.from('app_settings').select('*').eq('user_id', uid).maybeSingle();
  if(settingsRes.error) throw settingsRes.error;

  var state = {
    clients: {},
    variants: {},
    variantStats: {},
    todos: (todosRes.data || []).map(function(t){
      return {id: t.id, text: t.text, done: !!t.done, createdAt: t.created_at, doneAt: t.done_at};
    }),
    epsilon: settingsRes.data ? Number(settingsRes.data.epsilon) : 0.2,
    senderName: (settingsRes.data && settingsRes.data.sender_name) || deriveSenderName(user.email),
    poolsLearning: !!(settingsRes.data && settingsRes.data.pools_learning),
    // null/absent means "use the built-in defaults" — an empty array is
    // treated the same way rather than as a pipeline with no stages, which
    // would strand every contact on an unrecognised stage.
    pipeline: (settingsRes.data && Array.isArray(settingsRes.data.pipeline) && settingsRes.data.pipeline.length)
      ? settingsRes.data.pipeline : null,
    terminology: (settingsRes.data && settingsRes.data.terminology) || null,
    scoreWeights: (settingsRes.data && settingsRes.data.score_weights) || null,
    pendingEvents: [],
    lastSync: null
  };

  // Activate before anything reads a stage role or renders a noun. These are
  // module-level in logic.js precisely so computeDue and friends don't need the
  // state threaded through them; the cost is that they must be set here, once,
  // before the first render.
  setPipeline(state.pipeline);
  setTerminology(state.terminology);

  (clientsRes.data || []).forEach(function(row){
    state.clients[row.id] = {
      id: row.id,
      googleEventId: row.google_event_id,
      name: row.name, phone: row.phone, email: row.email,
      youtubeLink: row.youtube_link, meetLink: row.meet_link,
      callDateTime: row.call_date_time, bookedDate: row.booked_date,
      timezone: row.timezone, timezoneConfirmed: !!row.timezone_confirmed, status: row.status,
      messageLog: (row.message_log || []).slice().sort(function(a,b){
        return new Date(a.sent_at) - new Date(b.sent_at);
      }).map(function(m){
        return {
          id: m.id,
          stage: m.stage, variantId: m.variant_key, text: m.text,
          sentAt: m.sent_at, responded: !!m.responded, respondedAt: m.responded_at,
          reviewed: !!m.reviewed
        };
      }),
      notes: row.notes, recap: row.recap,
      closeOutcome: row.close_outcome || undefined,
      reschedules: row.reschedules || [],
      rescheduleCount: row.reschedule_count,
      stalledSince: row.stalled_since,
      ignored: !!row.ignored, manuallyAdded: !!row.manually_added,
      snoozedUntil: row.snoozed_until || {}
    };
  });

  var seedNeeded = !(variantsRes.data && variantsRes.data.length);
  if(seedNeeded){
    var defaults = buildDefaultVariants();
    state.variants = defaults;
    var seedRows = [];
    Object.keys(defaults).forEach(function(stage){
      defaults[stage].forEach(function(v){
        seedRows.push({user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin, needs_channel: !!v.needsChannel});
      });
    });
    var seedRes = await sb.from('variants').insert(seedRows);
    if(seedRes.error) throw seedRes.error;
  } else {
    (variantsRes.data || []).forEach(function(row){
      if(!state.variants[row.stage]) state.variants[row.stage] = [];
      state.variants[row.stage].push({id: row.variant_key, text: row.text, builtin: !!row.builtin, needsChannel: !!row.needs_channel});
    });

    // An account seeded before a new built-in stage existed has variant rows,
    // so the seed branch above never runs for it — and it would silently never
    // receive that stage's templates. Backfill only the stages it's actually
    // missing, leaving every existing row (and any hand-written variant)
    // untouched. This is how 'hourbefore' reaches accounts created earlier.
    var defaultsByStage = buildDefaultVariants();
    var missingRows = [];
    Object.keys(defaultsByStage).forEach(function(stage){
      if(state.variants[stage] && state.variants[stage].length) return;
      state.variants[stage] = defaultsByStage[stage];
      defaultsByStage[stage].forEach(function(v){
        missingRows.push({user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin, needs_channel: !!v.needsChannel});
      });
    });
    if(missingRows.length){
      var backfillRes = await sb.from('variants').insert(missingRows);
      if(backfillRes.error) console.error('GhostBuster: variant backfill failed', backfillRes.error);
    }
  }

  (statsRes.data || []).forEach(function(row){
    if(!state.variantStats[row.stage]) state.variantStats[row.stage] = {};
    state.variantStats[row.stage][row.variant_key] = {sends: row.sends, responses: row.responses};
  });

  // Built-in (shared) templates can learn from everyone's sends rather than
  // just this account's — but only between accounts that actually log
  // replies. An account that sends and never logs contributes sends that can
  // never produce a reply, and because pickVariant scores with
  // (responses+1)/(sends+2) those aren't neutral: they push a variant down
  // the ranking, which had the bandit favouring whichever message had been
  // used least. Opt-in via app_settings.pools_learning; everyone else falls
  // back to their own per-user variant_stats, already loaded above.
  var pooledRes = (settingsRes.data && settingsRes.data.pools_learning)
    ? await sb.from('builtin_variant_stats').select('*')
    : {error: null, data: []};
  if(!pooledRes.error){
    (pooledRes.data || []).forEach(function(row){
      if(!state.variantStats[row.stage]) state.variantStats[row.stage] = {};
      var isBuiltin = (state.variants[row.stage] || []).some(function(v){ return v.id === row.variant_key && v.builtin; });
      if(isBuiltin) state.variantStats[row.stage][row.variant_key] = {sends: row.sends, responses: row.responses};
    });
  }

  // Any variant (seeded or user-added) with no stats row yet gets a zeroed one,
  // same guarantee buildDefaultState() gives the local build.
  Object.keys(state.variants).forEach(function(stage){
    if(!state.variantStats[stage]) state.variantStats[stage] = {};
    state.variants[stage].forEach(function(v){
      if(!state.variantStats[stage][v.id]) state.variantStats[stage][v.id] = {sends: 0, responses: 0};
    });
  });

  if(!settingsRes.data){
    var settingsSeedRes = await sb.from('app_settings').insert({user_id: uid, epsilon: 0.2});
    if(settingsSeedRes.error) throw settingsSeedRes.error;
  }

  // The baseline every later save diffs against: what the database is known to
  // hold right now. Until this is set, saveState refuses to delete anything —
  // so a failed or partial load can never be mistaken for "the user emptied
  // their account".
  SYNCED = snapshot(state, uid);

  return state;
}

/* ============================================================
   INCREMENTAL PERSISTENCE

   saveState used to do a full resync on every call: upsert every row, then
   delete anything not present in memory, and for message_log delete the whole
   log and reinsert it. At one user per account that was merely wasteful. It is
   not survivable the moment two people share a dataset — whoever saves last
   deletes the other's work, silently, with no error. It is also unrecoverable
   rather than merely wrong: the delete lands even if the process dies before
   the reinsert.

   This version diffs against SYNCED, a snapshot of exactly what the database
   was last known to hold, and writes only what actually changed. Two
   invariants make it safe:

     1. Deletes are always by explicit id — never "delete everything not in
        this list". A partial or failed load can therefore never cascade into
        data loss.
     2. Nothing is deleted at all unless SYNCED exists, i.e. unless this tab
        has genuinely loaded the data it is about to reconcile against.

   SYNCED is only advanced after a write succeeds, so a failed save leaves the
   next save with the same work to do rather than quietly dropping it.
   ============================================================ */

var SYNCED = null;
// saveState is fire-and-forget and every mutator calls it, so two saves can be
// in flight at once. The writes themselves are idempotent (upserts, plus
// deletes by explicit id), but if an older save finishes last it would install
// a staler baseline than the one already there — costing redundant writes on
// every later save. Each save claims a ticket and only advances SYNCED if no
// newer save has already landed.
var SAVE_SEQ = 0;
var SAVE_LANDED = 0;

function rowClient(c, uid){
  return {
    id: c.id, user_id: uid, google_event_id: c.googleEventId || null,
    name: c.name, phone: c.phone, email: c.email,
    youtube_link: c.youtubeLink, meet_link: c.meetLink,
    call_date_time: c.callDateTime, booked_date: c.bookedDate,
    timezone: c.timezone, timezone_confirmed: !!c.timezoneConfirmed, status: c.status,
    notes: c.notes, recap: c.recap, close_outcome: c.closeOutcome || null,
    reschedules: c.reschedules, reschedule_count: c.rescheduleCount,
    stalled_since: c.stalledSince, ignored: !!c.ignored, manually_added: !!c.manuallyAdded,
    snoozed_until: c.snoozedUntil || {}
  };
}
function rowMessage(m, clientId){
  return {
    id: m.id, client_id: clientId, stage: m.stage, variant_key: m.variantId || '',
    text: m.text, sent_at: m.sentAt, responded: !!m.responded,
    responded_at: m.respondedAt, reviewed: !!m.reviewed
  };
}
function rowTodo(t, uid){
  return {id: t.id, user_id: uid, text: t.text, done: !!t.done, created_at: t.createdAt, done_at: t.doneAt};
}
function rowVariant(v, stage, uid){
  return {user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin, needs_channel: !!v.needsChannel};
}
function rowStat(s, stage, vk, uid){
  return {user_id: uid, stage: stage, variant_key: vk, sends: s.sends, responses: s.responses};
}

// Row objects are built with a fixed key order above, so stringify is a stable
// identity test — no key sorting needed.
function same(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

// Snapshot of everything persistable, keyed the way the diff needs it.
function snapshot(state, uid){
  var snap = {clients:{}, messages:{}, todos:{}, variants:{}, stats:{}, settings:null};
  Object.keys(state.clients).forEach(function(cid){
    var c = state.clients[cid];
    snap.clients[cid] = rowClient(c, uid);
    c.messageLog.forEach(function(m){
      if(!m.id) m.id = uuid();           // legacy rows loaded before ids existed
      snap.messages[m.id] = rowMessage(m, cid);
    });
  });
  (state.todos || []).forEach(function(t){ snap.todos[t.id] = rowTodo(t, uid); });
  Object.keys(state.variants).forEach(function(stage){
    (state.variants[stage] || []).forEach(function(v){ snap.variants[stage + '|' + v.id] = rowVariant(v, stage, uid); });
  });
  Object.keys(state.variantStats).forEach(function(stage){
    Object.keys(state.variantStats[stage] || {}).forEach(function(vk){
      snap.stats[stage + '|' + vk] = rowStat(state.variantStats[stage][vk], stage, vk, uid);
    });
  });
  snap.settings = {
    user_id: uid, epsilon: state.epsilon,
    sender_name: state.senderName, pools_learning: !!state.poolsLearning,
    pipeline: state.pipeline || null,
    terminology: state.terminology || null,
    score_weights: state.scoreWeights || null
  };
  return snap;
}

// Returns {added:[row], changed:[row], removedKeys:[key]} for one bucket.
function diff(prev, next){
  var out = {added: [], changed: [], removedKeys: []};
  Object.keys(next).forEach(function(k){
    if(!prev || !(k in prev)) out.added.push(next[k]);
    else if(!same(prev[k], next[k])) out.changed.push(next[k]);
  });
  if(prev) Object.keys(prev).forEach(function(k){ if(!(k in next)) out.removedKeys.push(k); });
  return out;
}

// Events are fetched per contact rather than loaded into state: the table is
// append-only and grows without bound, and the only place it is read is one
// contact's timeline. Keeping it out of the in-memory state is what stops
// memory and every save's diff from growing with history.
async function fetchClientEvents(clientId){
  var sb = window.GB_SUPABASE;
  try{
    var res = await sb.from('events').select('kind, at, data')
      .eq('client_id', clientId).order('at', {ascending: true}).limit(200);
    if(res.error){ console.error('GhostBuster: events fetch failed', res.error); return []; }
    return res.data || [];
  }catch(e){
    // A timeline that cannot load is a degraded view, never a broken modal —
    // the derived history still renders from records already in memory.
    console.error('GhostBuster: events fetch threw', e);
    return [];
  }
}


async function saveState(state){
  var sb = window.GB_SUPABASE;
  var userRes = await sb.auth.getUser();
  var user = userRes.data && userRes.data.user;
  if(!user) return;
  var uid = user.id;

  var ticket = ++SAVE_SEQ;
  var next = snapshot(state, uid);
  var prev = SYNCED;
  var writes = [];

  try{
    var c = diff(prev && prev.clients, next.clients);
    var upClients = c.added.concat(c.changed);
    if(upClients.length){
      // Stamped onto a copy, never onto the snapshot row itself: these objects
      // become SYNCED, and a server-side bookkeeping column baked into the
      // baseline would make every subsequent diff see a phantom change.
      var stamped = upClients.map(function(r){
        var out = {}; Object.keys(r).forEach(function(k){ out[k] = r[k]; });
        out.updated_at = new Date().toISOString();
        return out;
      });
      writes.push(sb.from('clients').upsert(stamped));
    }
    // Explicit ids only. Never a "delete everything not in this set" filter.
    if(prev && c.removedKeys.length) writes.push(sb.from('clients').delete().in('id', c.removedKeys));

    var m = diff(prev && prev.messages, next.messages);
    if(m.added.length) writes.push(sb.from('message_log').insert(m.added));
    // Messages change only via review (responded/reviewed), so an upsert keyed
    // on the client-generated id is enough — no delete-and-reinsert.
    if(m.changed.length) writes.push(sb.from('message_log').upsert(m.changed));
    if(prev && m.removedKeys.length) writes.push(sb.from('message_log').delete().in('id', m.removedKeys));

    var t = diff(prev && prev.todos, next.todos);
    var upTodos = t.added.concat(t.changed);
    if(upTodos.length) writes.push(sb.from('todos').upsert(upTodos));
    if(prev && t.removedKeys.length) writes.push(sb.from('todos').delete().in('id', t.removedKeys));

    var v = diff(prev && prev.variants, next.variants);
    var upVars = v.added.concat(v.changed);
    if(upVars.length) writes.push(sb.from('variants').upsert(upVars, {onConflict: 'user_id,stage,variant_key'}));

    var st = diff(prev && prev.stats, next.stats);
    var upStats = st.added.concat(st.changed);
    if(upStats.length) writes.push(sb.from('variant_stats').upsert(upStats, {onConflict: 'user_id,stage,variant_key'}));

    if(!prev || !same(prev.settings, next.settings)){
      var s = {};
      Object.keys(next.settings).forEach(function(k){ s[k] = next.settings[k]; });
      s.updated_at = new Date().toISOString();
      writes.push(sb.from('app_settings').upsert(s));
    }

    // Append-only history. Drained here rather than held in state so memory
    // stays flat as the timeline grows.
    var pending = (state.pendingEvents || []).slice();
    if(pending.length){
      writes.push(sb.from('events').insert(pending.map(function(e){
        return {id: e.id, user_id: uid, client_id: e.clientId, kind: e.kind, at: e.at, data: e.data};
      })));
    }

    if(!writes.length) return;

    var results = await Promise.all(writes);
    var failed = results.filter(function(r){ return r && r.error; });
    if(failed.length){
      // Leave SYNCED where it is so the same diff is retried on the next save
      // rather than being silently forgotten.
      console.error('GhostBuster: saveState partial failure', failed.map(function(r){ return r.error; }));
      return;
    }

    if(pending.length){
      state.pendingEvents = (state.pendingEvents || []).slice(pending.length);
    }
    if(ticket > SAVE_LANDED){ SAVE_LANDED = ticket; SYNCED = next; }
  }catch(e){
    console.error('GhostBuster: saveState failed', e);
  }
}
