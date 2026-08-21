'use strict';
/* GhostBuster (hosted build) — Supabase-backed persistence.
   Replaces the local build's localStorage loadState()/saveState() under the
   same names — that's the one seam every mutator in logic.js already calls
   through, per the rebuild plan. loadState() now returns a Promise (app.js's
   init() awaits it); saveState() still fires-and-forgets exactly like the
   local build always did, since no call site ever awaited or used its
   return value.

   saveState() does a full resync of the in-memory state on every call
   (upsert every client/todo/variant/variant_stat row, delete-and-reinsert
   message_log per user) rather than a surgical incremental diff. At this
   data scale (tens to low hundreds of clients) that's milliseconds of work
   and it sidesteps an entire class of client-side diffing bugs — worth the
   trade. It also avoids needing a server-generated id round-tripped back
   into an in-memory message_log entry before it's addressable: message_log
   rows are never referenced by id from the client at all.

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
    lastSync: null
  };

  (clientsRes.data || []).forEach(function(row){
    state.clients[row.id] = {
      id: row.id,
      googleEventId: row.google_event_id,
      name: row.name, phone: row.phone, email: row.email,
      youtubeLink: row.youtube_link, meetLink: row.meet_link,
      callDateTime: row.call_date_time, bookedDate: row.booked_date,
      timezone: row.timezone, status: row.status,
      messageLog: (row.message_log || []).slice().sort(function(a,b){
        return new Date(a.sent_at) - new Date(b.sent_at);
      }).map(function(m){
        return {
          stage: m.stage, variantId: m.variant_key, text: m.text,
          sentAt: m.sent_at, responded: !!m.responded, respondedAt: m.responded_at
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
  }

  (statsRes.data || []).forEach(function(row){
    if(!state.variantStats[row.stage]) state.variantStats[row.stage] = {};
    state.variantStats[row.stage][row.variant_key] = {sends: row.sends, responses: row.responses};
  });

  // Built-in (shared) templates learn from everyone's sends, not just this
  // account's — with several real accounts now sending the exact same
  // wording, pooling gives the bandit far more signal per template than any
  // one person's own trickle of traffic would. Only applies to builtin
  // variants; a hand-added custom one stays purely personal per-user stats.
  var pooledRes = await sb.from('builtin_variant_stats').select('*');
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

  return state;
}

async function saveState(state){
  var sb = window.GB_SUPABASE;
  var userRes = await sb.auth.getUser();
  var user = userRes.data && userRes.data.user;
  if(!user) return;
  var uid = user.id;

  try{
    await sb.from('app_settings').upsert({user_id: uid, epsilon: state.epsilon, sender_name: state.senderName, updated_at: new Date().toISOString()});

    var todoIds = state.todos.map(function(t){ return t.id; });
    var todoRows = state.todos.map(function(t){
      return {id: t.id, user_id: uid, text: t.text, done: !!t.done, created_at: t.createdAt, done_at: t.doneAt};
    });
    if(todoRows.length) await sb.from('todos').upsert(todoRows);
    var delTodos = sb.from('todos').delete().eq('user_id', uid);
    delTodos = todoIds.length ? delTodos.not('id', 'in', '(' + todoIds.join(',') + ')') : delTodos;
    await delTodos;

    var clientIds = Object.keys(state.clients);
    var clientRows = clientIds.map(function(id){
      var c = state.clients[id];
      return {
        id: c.id, user_id: uid, google_event_id: c.googleEventId || null,
        name: c.name, phone: c.phone, email: c.email,
        youtube_link: c.youtubeLink, meet_link: c.meetLink,
        call_date_time: c.callDateTime, booked_date: c.bookedDate,
        timezone: c.timezone, status: c.status,
        notes: c.notes, recap: c.recap, close_outcome: c.closeOutcome || null,
        reschedules: c.reschedules, reschedule_count: c.rescheduleCount,
        stalled_since: c.stalledSince, ignored: !!c.ignored, manually_added: !!c.manuallyAdded,
        snoozed_until: c.snoozedUntil || {}, updated_at: new Date().toISOString()
      };
    });
    if(clientRows.length) await sb.from('clients').upsert(clientRows);
    var delClients = sb.from('clients').delete().eq('user_id', uid);
    delClients = clientIds.length ? delClients.not('id', 'in', '(' + clientIds.join(',') + ')') : delClients;
    await delClients;

    if(clientIds.length) await sb.from('message_log').delete().in('client_id', clientIds);
    var msgRows = [];
    clientIds.forEach(function(id){
      state.clients[id].messageLog.forEach(function(m){
        msgRows.push({
          client_id: id, stage: m.stage, variant_key: m.variantId || '', text: m.text,
          sent_at: m.sentAt, responded: !!m.responded, responded_at: m.respondedAt
        });
      });
    });
    if(msgRows.length) await sb.from('message_log').insert(msgRows);

    var variantRows = [];
    Object.keys(state.variants).forEach(function(stage){
      (state.variants[stage] || []).forEach(function(v){
        variantRows.push({user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin, needs_channel: !!v.needsChannel});
      });
    });
    if(variantRows.length) await sb.from('variants').upsert(variantRows, {onConflict: 'user_id,stage,variant_key'});

    var statRows = [];
    Object.keys(state.variantStats).forEach(function(stage){
      Object.keys(state.variantStats[stage] || {}).forEach(function(vk){
        var s = state.variantStats[stage][vk];
        statRows.push({user_id: uid, stage: stage, variant_key: vk, sends: s.sends, responses: s.responses});
      });
    });
    if(statRows.length) await sb.from('variant_stats').upsert(statRows, {onConflict: 'user_id,stage,variant_key'});
  }catch(e){
    console.error('GhostBuster: saveState failed', e);
  }
}
