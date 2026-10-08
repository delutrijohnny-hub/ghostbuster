'use strict';
/* Ghost Recall (hosted build) — Supabase-backed persistence.
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

/* Who else can this account see, and what are they doing?

   Deliberately built out of the rows RLS already decides this caller may read,
   aggregated here in JavaScript. No new database function, no service key, no
   second source of truth about who can see whom: if the security layer says an
   account is invisible, nothing here can surface it. An individual with no
   team reads exactly their own row and gets no tab.

   Every failure path returns an empty list rather than throwing. A team view
   is a nice-to-have; the email library taught this codebase once already that
   a secondary panel which throws takes the whole app down with it, and nobody
   should lose their morning list because a manager widget could not load. */
/* Building a team: invite, accept, and see what is outstanding.

   An invite is only ever a request. Accepting re-stamps the joiner's contacts,
   messages and settings into the new organisation — that is what makes them
   visible to their manager — so a one-sided "add by email" would let anybody
   type a stranger's address and absorb their entire book. Nothing moves until
   the person whose data it is accepts, and the database verifies that against
   the email on their own token. These are thin wrappers; the rules live in
   accept_org_invite and the policies on org_invites. */
async function inviteToOrg(email, role){
  var sb = window.GB_SUPABASE;
  var clean = String(email || '').trim().toLowerCase();
  if(!clean || clean.indexOf('@') === -1) return {ok:false, error:'that is not an email address'};
  var who = await sb.auth.getUser();
  var me = who && who.data && who.data.user;
  if(!me) return {ok:false, error:'not signed in'};
  var mine = await sb.from('memberships').select('org_id, role').eq('user_id', me.id);
  var managed = ((mine && mine.data) || []).filter(function(m){
    return m.role === 'admin' || m.role === 'owner'; })[0];
  if(!managed) return {ok:false, error:'only a manager can invite people'};
  var res = await sb.from('org_invites')
    .insert({org_id: managed.org_id, email: clean,
             role: (role === 'admin' ? 'admin' : 'member'), invited_by: me.id})
    .select('id');
  if(res.error){
    // The unique index on (org, email) is the common case, and "already
    // invited" is friendlier than a constraint name.
    if(/duplicate|unique/i.test(res.error.message || '')) return {ok:false, error:'already invited'};
    return {ok:false, error: res.error.message || 'could not invite'};
  }
  return {ok:true};
}

async function acceptOrgInvite(id){
  var res = await window.GB_SUPABASE.rpc('accept_org_invite', {invite: id});
  if(res.error) return {ok:false, error: res.error.message || String(res.error)};
  var r = res.data || {};
  return r.ok ? {ok:true} : {ok:false, error: r.error || 'could not accept'};
}

/* Whether this person can build a team at all, and what their organisation is
   called.

   This exists because of a gap that made every manager feature unsellable: the
   team tab hides itself when handed fewer than two people, and the invite box
   lived inside it. So a brand-new customer — who is always alone on day one —
   had no way to add their first colleague. The database was never the problem;
   provision_org_for_new_user makes every signup an 'owner', which
   user_managed_org_ids accepts. The only thing missing was a door.

   Role names are kept in step with user_managed_org_ids ('owner','admin') on
   purpose. If they drift, the button appears and the insert is refused by RLS,
   which is a confusing failure rather than an unsafe one. */
async function loadOrgRole(sb, uid){
  try{
    if(!uid) return {canInvite:false, orgName:''};
    var res = await sb.from('memberships')
      .select('role, org_id, organizations(name)')
      .eq('user_id', uid);
    var row = ((res && res.data) || [])[0];
    if(!row) return {canInvite:false, orgName:''};
    return {
      canInvite: row.role === 'owner' || row.role === 'admin',
      orgName: (row.organizations && row.organizations.name) || ''
    };
  }catch(e){ return {canInvite:false, orgName:''}; }
}

async function loadPendingInvites(sb){
  try{
    var res = await sb.rpc('my_pending_invites');
    if(res.error || !res.data) return [];
    return res.data.map(function(r){
      return {id: r.id, orgName: r.org_name || 'a team', role: r.role, invitedAt: r.created_at};
    });
  }catch(e){ return []; }
}

/* Invites THIS person sent and nobody has taken up yet.

   Filtered on invited_by deliberately. org_invites carries a second policy so
   an invited person can see the invite addressed to them, which means a plain
   select here would also return a manager's own incoming invite from some
   other company and list it under "you invited". */
async function loadSentInvites(sb, uid){
  try{
    if(!uid) return [];
    var res = await sb.from('org_invites')
      .select('id, email, role, created_at, accepted_at')
      .eq('invited_by', uid)
      .is('accepted_at', null)
      .is('revoked_at', null);
    if(res.error || !res.data) return [];
    return res.data.map(function(r){
      return {id: r.id, email: r.email, role: r.role, sentAt: r.created_at};
    });
  }catch(e){ return []; }
}

/* Hand over several appointments at once, when somebody is away.

   One at a time is right for a single call that needs a different owner. It is
   the wrong tool for covering a fortnight's absence: three people here are
   holding 43 booked appointments between them and have sent nothing in a week,
   and clicking 43 pickers is not a plan.

   Sequential rather than Promise.all, deliberately. The partial result has to
   be truthful — RLS can refuse an individual row, and a parallel run makes
   "moved 12 of 17" unreliable about WHICH 12. It also keeps a burst of writes
   off the database for what is a once-in-a-while action.

   Never throws. A caller gets counts and the first reason, so a half-finished
   move is reported as a half-finished move rather than as success. */
async function reassignMany(clientIds, toUserId, ctx){
  var ids = Array.isArray(clientIds) ? clientIds : [];
  var moved = 0, failed = 0, firstError = null;
  for(var i = 0; i < ids.length; i++){
    try{
      var r = await reassignClient(ids[i], toUserId, ctx);
      if(r && r.ok){ moved++; }
      else { failed++; if(!firstError) firstError = (r && r.error) || 'refused'; }
    }catch(e){
      failed++;
      if(!firstError) firstError = String(e);
    }
  }
  return {moved: moved, failed: failed, error: firstError};
}

/* Appoint or stand down another manager.

   The rules live in set_member_role, not here: a manager may only change
   somebody in an organisation they manage, and NOBODY may change their own
   role. That second rule is what makes locking an organisation out
   impossible — demotion only ever applies to someone else, so whoever does it
   is still a manager afterwards, with no counting and no race. */
async function setMemberRole(userId, role){
  var res = await window.GB_SUPABASE.rpc('set_member_role',
    {target: userId, new_role: role});
  if(res.error) return {ok:false, error: res.error.message || String(res.error)};
  var r = res.data || {};
  return r.ok ? {ok:true, role:r.role} : {ok:false, error: r.error || 'could not change role'};
}

/* Move one appointment to a different person on the team.

   The case this exists for: somebody has booked calls in the diary and has
   not opened the app for a fortnight. The calls happen regardless. A manager
   needs to hand them to whoever will actually make them, and until now the
   team view could only report the problem.

   Deliberately NOT part of saveState. That path diffs STATE.clients, which
   holds only the signed-in person's own contacts — a teammate's row is not in
   it and never will be. So this is a direct, single-row write, and the caller
   reloads afterwards rather than trying to patch two lists in memory.

   Security is left entirely to RLS: the policy allows a write only where the
   row is yours or sits in an organisation you manage. A member who tries this
   on somebody else's contact gets nothing back and nothing changes. The
   org_id is untouched because both people are in the same organisation —
   moving work across organisations is a different question with a different
   answer. */
async function reassignClient(clientId, toUserId, ctx){
  var sb = window.GB_SUPABASE;
  if(!clientId || !toUserId) return {ok:false, error:'missing id'};
  /* One call, not two writes from the browser.

     The move and its record have to happen together or not at all. Done
     separately from here the contact changed hands and the record was refused
     outright — events_org_insert requires user_id = auth.uid(), so a browser
     may only write history about itself, which is the right rule and which a
     handover must cross: the entry belongs on the NEW OWNER's timeline or the
     person inheriting the work cannot see where it came from.

     reassign_client also checks the thing nothing checked before — that the
     destination is actually on the team. The clients policy constrains org_id
     and manager-ness but never the incoming user_id, so a reassignment to any
     uuid was permitted and would strand the contact with an owner who cannot
     see it. */
  var res = await sb.rpc('reassign_client', {
    p_client: clientId,
    p_to: toUserId,
    p_meta: {
      fromName: (ctx && ctx.fromName) || null,
      toName: (ctx && ctx.toName) || null,
      byName: (ctx && ctx.byName) || null
    }
  });
  if(res.error) return {ok:false, error: res.error.message || String(res.error)};
  var r = res.data || {};
  return r.ok ? {ok:true} : {ok:false, error: r.error || 'not allowed'};
}

async function loadTeamRows(sb, uid){
  try{
    var memRes = await sb.from('memberships').select('org_id, user_id, role');
    if(memRes.error || !memRes.data) return [];
    var mems = memRes.data;

    // Only the caller showing up means a one-person account: no team, no tab.
    var peers = {}, orgRoleOf = {};
    mems.forEach(function(m){
      peers[m.user_id] = true;
      // 'admin'/'owner' vs 'member' — not the pipeline stage role below, which
      // is a different thing entirely that happens to share the word.
      orgRoleOf[m.user_id] = m.role;
    });
    if(Object.keys(peers).length < 2) return [];

    /* A readable name per person.

       This used to come from the organisation's name, which worked only while
       every account sat alone in a one-person org named after them. The moment
       a real team shares one organisation, that labels everybody "Market Maker
       Management" and the tab shows six identical rows. Found by looking at
       it, not by anything failing.

       sender_name is what they already sign their messages with, so it is the
       name they would recognise. Where it is blank, the local part of their
       connected calendar address is a decent stand-in, and auth.users stays
       unreachable from the browser either way. */
    var nameFor = {}, rolesFor = {}, termsFor = {};
    var sRes = await sb.from('app_settings').select('user_id, sender_name, pipeline, terminology');
    ((sRes && sRes.data) || []).forEach(function(r){
      var n = String(r.sender_name || '').trim();
      if(n) nameFor[r.user_id] = n;
      /* Each person read against their OWN stage names.

         This counted the literal strings 'Completed' and 'No-show', which are
         the default pipeline's words. A real estate team closes a call as
         'Showing Completed'; an HVAC firm as 'Walkthrough Done'. On any
         template but the default, every finished call would have been counted
         as one nobody logged, and every show-up rate would have read 0% — a
         confident, specific, wrong number rather than a blank. */
      rolesFor[r.user_id] = pipelineRoleMap(r.pipeline);
      // Their own vocabulary, so the team view can tell whether the team
      // shares one or spans several — see teamAppointmentWords.
      termsFor[r.user_id] = r.terminology || null;
    });
    var defaultRoles = pipelineRoleMap(null);
    function roleOf(userId, status){
      var m = rolesFor[userId] || defaultRoles;
      // An unknown status is one the pipeline was edited to drop. Treating it
      // as still open is the safe reading: it shows up as work needing an
      // outcome rather than silently counting as a win.
      return m[status] || 'open';
    }

    var cRes = await sb.from('clients')
      .select('id, user_id, name, call_date_time, status, created_at, ignored, timezone');
    if(cRes.error || !cRes.data) return [];

    var ownerOf = {}, callTimeOf = {}, tzOf = {}, agg = {};
    function bucket(u){
      if(!agg[u]) agg[u] = {userId:u, name: nameFor[u] || 'teammate', contacts:0,
        upcoming:0, sentEver:0, sent7d:0, replies:0, completed:0, noshows:0,
        rescheduled:0, connectedCalendars:0, lastSync:null, lastSentAt:null,
        /* The appointments behind the number, so a manager can see WHICH calls
           somebody is sitting on rather than only how many. Deliberately only
           on the team rows: the owner view looks at other businesses and must
           never carry a contact's name. */
        sentPrev7d:0, pastCalls:0, unlogged:0, touchesBeforeCall:0, sentAt: [],
        outsideHours:0, awaitingReview:0,
        upcomingList: [], lastSignIn: null, signedUp: null};
      return agg[u];
    }
    Object.keys(peers).forEach(bucket);

    var now = Date.now();
    cRes.data.forEach(function(c){
      ownerOf[c.id] = c.user_id;
      tzOf[c.id] = c.timezone || null;
      var b = bucket(c.user_id);
      /* An ignored contact is not work, so it must not read as a booked
         appointment nobody has spoken to. Zachary had 132 occurrences of one
         standing meeting marked ignored; counting them would have shown him
         sitting on 137 untouched calls when the real figure is 10. */
      if(c.ignored) return;
      b.contacts++;
      var t = c.call_date_time ? Date.parse(c.call_date_time) : NaN;
      if(!isNaN(t) && t >= now){
        b.upcoming++;
        // A fortnight is as far as anybody acts on; beyond that it is noise.
        if(t - now <= 14 * 86400000){
          b.upcomingList.push({clientId: c.id, name: c.name || 'Unknown',
                               when: c.call_date_time, status: c.status, sent: 0});
        }
      }
      var role = roleOf(c.user_id, c.status);
      if(role === 'won') b.completed++;
      else if(role === 'missed') b.noshows++;
      // Declared in the bucket and surfaced by teamMemberState, but nothing
      // ever incremented it, so every team row reported zero reschedules.
      else if(role === 'stalled') b.rescheduled++;
      /* A call that has happened and still sits on a booked-ish status is one
         nobody recorded the outcome of. It is the denominator for every
         performance figure on this screen, so it is counted rather than
         assumed. */
      if(!isNaN(t)) callTimeOf[c.id] = t;
      if(!isNaN(t) && t < now){
        b.pastCalls++;
        // 'open' is exactly Booked/Confirmed/Reminded on the default pipeline,
        // and the equivalent three on every other template. A 'lost' status is
        // an outcome somebody recorded, so it is not unlogged.
        if(role === 'open') b.unlogged++;
      }
    });

    var sentPer = {};
    var mRes = await sb.from('message_log').select('client_id, sent_at, responded, reviewed');
    ((mRes && mRes.data) || []).forEach(function(m){
      var u = ownerOf[m.client_id];
      if(!u) return;
      var b = bucket(u);
      b.sentEver++;
      if(m.responded) b.replies++;
      var t = m.sent_at ? Date.parse(m.sent_at) : NaN;
      if(isNaN(t)) return;
      if(now - t <= 7 * 86400000) b.sent7d++;
      /* The week before last week, so the tab can say whether this is getting
         better. No new table and no nightly job: the message log already
         holds every timestamp, it was only ever being asked about one
         window. */
      else if(now - t <= 14 * 86400000) b.sentPrev7d++;
      if(b.lastSentAt === null || t > b.lastSentAt) b.lastSentAt = t;
      // Kept raw so weeklyActivity can bucket them. The log already holds
      // every timestamp; nothing new is stored or fetched for the history.
      b.sentAt.push(m.sent_at);
      /* Texts that landed at an unreasonable hour where the person RECEIVING
         them lives. The same 8am-9pm window the contact card already warns
         about, so the count and the warning cannot disagree.

         A quality signal to sit beside the volume one. Without it the team
         view rewards sending hard and says nothing about sending well — and
         on this book the highest-volume newcomer is also the one texting
         people at eleven at night. */
      if(isOutsideLocalHours(m.sent_at, tzOf[m.client_id])) b.outsideHours++;
      /* Messages old enough to know the answer, where nobody has said whether
         a reply came. This is WHY the reply rate column is blank for almost
         everyone, and the blank is honest — nobody has looked is not the same
         as nobody answered — but a manager reading "not measured" had no way
         to see that it is two minutes of somebody's attention away.

         REPLY_WAIT_HOURS, not a fresh number: it is the same threshold that
         decides when Ghost Recall Today starts asking. */
      if(!m.reviewed && (now - t) >= REPLY_WAIT_HOURS * 3600000) b.awaitingReview++;
      sentPer[m.client_id] = (sentPer[m.client_id] || 0) + 1;
      /* Touches that landed BEFORE the call, which is the only kind that can
         affect whether somebody turns up. Counted as activity, not as a
         claim about cause. */
      var ct = callTimeOf[m.client_id];
      if(ct && t < ct) b.touchesBeforeCall++;
    });

    /* Sync health comes through a function, not the table.

       google_oauth_tokens is owner-only, because refresh_token is a live
       credential rather than a record. Reading it directly here would return
       nothing for a teammate and the view would report everyone as "no
       calendar connected" — a confident wrong answer that looks exactly like
       the real thing. team_calendar_health returns four columns and no tokens. */
    var tRes = await sb.rpc('team_calendar_health');
    ((tRes && tRes.data) || []).forEach(function(r){
      var b = bucket(r.user_id);
      // Fallback label for anybody who never set a sender name.
      if(!nameFor[r.user_id] && r.calendar_id){
        nameFor[r.user_id] = String(r.calendar_id).split('@')[0];
        b.name = nameFor[r.user_id];
      }
      b.connectedCalendars++;
      var t = r.last_sync ? Date.parse(r.last_sync) : NaN;
      if(!isNaN(t) && (b.lastSync === null || t > Date.parse(b.lastSync))) b.lastSync = r.last_sync;
    });

    /* When each person last opened the app.

       Without this a manager cannot tell "ignoring their list" from "has not
       logged in for twelve days", and those need opposite conversations.
       auth.users is unreachable from the browser, so this comes through a
       function that returns two timestamps and nothing else — no email, no
       phone, no provider identity. */
    var aRes = await sb.rpc('team_sign_in_activity');
    ((aRes && aRes.data) || []).forEach(function(r){
      var b = agg[r.user_id];
      if(!b) return;
      b.lastSignIn = r.last_sign_in || null;
      b.signedUp = r.signed_up || null;
    });

    return Object.keys(agg).map(function(u){
      var b = agg[u];
      b.name = nameFor[u] || b.name || 'teammate';
      /* Eight weeks of activity, so "did that conversation change anything"
         has an answer. The current week is flagged partial by weeklyActivity;
         anything reading these bars must say so or it reports a collapse
         every time somebody looks before Friday. */
      b.weeks = weeklyActivity(b.sentAt, new Date(now), 8);
      delete b.sentAt;             // the raw list is scaffolding, not state
      b.terminology = termsFor[u] || null;
      b.orgRole = orgRoleOf[u] || 'member';
      b.isManager = b.orgRole === 'admin' || b.orgRole === 'owner';
      b.upcomingList.forEach(function(x){ x.sent = sentPer[x.clientId] || 0; });
      b.upcomingList.sort(function(x, y){ return Date.parse(x.when) - Date.parse(y.when); });
      b.idleDays = b.lastSentAt === null ? null : Math.floor((now - b.lastSentAt) / 86400000);
      /* Only an account with at least one recorded reply can have a reply RATE.
         Zero recorded replies is genuinely ambiguous - nobody answered, or
         nobody ever reconciled them - and the view must not resolve that
         ambiguity in the flattering direction or the alarming one. */
      b.repliesMeasured = b.replies > 0;
      return b;
    });
  }catch(e){
    console.error('Ghost Recall: team view unavailable', e);
    return [];
  }
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
  // Which calendars are mine — the identity that decides whose lead a booking
  // is. Not the login address: these accounts sign in personally and organize
  // from a work address. A failure here leaves the list empty, which
  // isOthersLead reads as "cannot tell", so nothing is misfiled.
  // The email library. Its own table rather than more stage-keyed variants:
  // these are documents, hand-ordered, and not tied to a touch.
  /* A missing library must never take the app down with it.

     This was written as `if(libRes.error) throw` — the same shape as every
     load above it, which is correct for tables that have existed for months
     and catastrophic for one added this morning. Deploy the code before the
     migration and loadState throws on a table that does not exist yet, so
     nobody can open Ghost Recall at all: not the Emails tab, the whole app.
     Contacts, today's texts, everything, gone behind a blank screen because
     an email library could not be read.

     So it degrades. No library is a missing feature; no app is an outage. */
  var libRes = await sb.from('email_library').select('*').eq('user_id', uid).order('sort_order');
  var libraryUnavailable = false;
  if(libRes.error){
    console.error('Ghost Recall: email library unavailable', libRes.error);
    // NOT reportSaveHealth. That channel renders a red bar reading "Your
    // changes aren't being saved. Anything you do now will be lost" — which
    // was a lie here, and a frightening one: saves were fine, one read had
    // failed. A user read that bar and reported their work was not saving.
    //
    // A degraded feature belongs inside that feature, where it is true and
    // where someone can act on it.
    libraryUnavailable = true;
    libRes = {data: [], error: null};
  }

  // last_sync and connected_at come along so the app can tell somebody their
  // calendar has stopped syncing, instead of waiting for them to notice that
  // no new bookings have arrived.
  var calRes = await sb.from('google_oauth_tokens')
    .select('calendar_id, last_sync, connected_at').eq('user_id', uid);
  var myCalendars = (!calRes.error && calRes.data)
    ? calRes.data.map(function(r){ return r.calendar_id; }).filter(Boolean) : [];
  var calConnections = (!calRes.error && calRes.data)
    ? calRes.data.map(function(r){
        return {calendarId: r.calendar_id, lastSync: r.last_sync, connectedAt: r.connected_at};
      }) : [];

  var state = {
    // Who is signed in. Needed by the team view to tell your own row from a
    // colleague's, and to know who an appointment is being moved to.
    userId: uid,
    clients: {},
    variants: {},
    emailVariants: {},
    // Read by the Emails tab so it can explain itself, rather than showing an
    // empty library and letting someone conclude their emails were deleted.
    calendarConnections: calConnections,
    emailLibraryUnavailable: libraryUnavailable,
    emailLibrary: (libRes.data || []).map(function(r){
      return {
        id: r.id, title: r.title, whenToSend: r.when_to_send || '',
        subject: r.subject || '', body: r.body || '', touch: r.touch || '',
        sortOrder: Number.isFinite(r.sort_order) ? r.sort_order : 0,
        archived: !!r.archived, updatedAt: r.updated_at
      };
    }),
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
    sequence: (settingsRes.data && Array.isArray(settingsRes.data.sequence) && settingsRes.data.sequence.length)
      ? settingsRes.data.sequence : null,
    scoreWeights: (settingsRes.data && settingsRes.data.score_weights) || null,
    calendarFilter: (settingsRes.data && settingsRes.data.calendar_filter) || null,
    myCalendars: myCalendars,
    emailEnabled: !!(settingsRes.data && settingsRes.data.email_enabled),
    autoSendEmail: !!(settingsRes.data && settingsRes.data.auto_send_email),
    emailFromName: (settingsRes.data && settingsRes.data.email_from_name) || null,
    emailFromAddress: (settingsRes.data && settingsRes.data.email_from_address) || null,
    emailReplyTo: (settingsRes.data && settingsRes.data.email_reply_to) || null,
    // The link people book through. A saved link is not a connection -- it
    // goes into messages, and nothing can see what gets booked through it.
    bookingLink: (settingsRes.data && settingsRes.data.booking_link) || '',
    pendingEvents: [],
    lastSync: null
  };

  // Activate before anything reads a stage role or renders a noun. These are
  // module-level in logic.js precisely so computeDue and friends don't need the
  // state threaded through them; the cost is that they must be set here, once,
  // before the first render.
  setPipeline(state.pipeline);
  setTerminology(state.terminology);
  setSequence(state.sequence);

  (clientsRes.data || []).forEach(function(row){
    state.clients[row.id] = {
      id: row.id,
      googleEventId: row.google_event_id,
      eventTitle: row.event_title || null,
      organizerEmail: row.organizer_email,
      emailStatus: row.email_status || 'ok',
      name: row.name, phone: row.phone, email: row.email,
      youtubeLink: row.youtube_link, meetLink: row.meet_link,
      callDateTime: row.call_date_time, bookedDate: row.booked_date,
      timezone: row.timezone, timezoneConfirmed: !!row.timezone_confirmed, status: row.status,
      messageLog: (row.message_log || []).slice().sort(function(a,b){
        return new Date(a.sent_at) - new Date(b.sent_at);
      }).map(function(m){
        return {
          id: m.id, channel: m.channel || 'sms',
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
      snoozedUntil: row.snoozed_until || {},
      skippedStages: row.skipped_stages || {}
    };
  });

  var seedNeeded = !(variantsRes.data && variantsRes.data.length);
  if(seedNeeded){
    var defaults = buildDefaultVariants();
    state.variants = defaults;
    var seedRows = [];
    Object.keys(defaults).forEach(function(stage){
      defaults[stage].forEach(function(v){
        seedRows.push({user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin, needs_channel: !!v.needsChannel, channel: 'sms'});
      });
    });
    var seedRes = await sb.from('variants').insert(seedRows);
    if(seedRes.error) throw seedRes.error;
  } else {
    // Split by channel. Without this an email template lands in the SMS
    // rotation and pickVariant can hand a subject-line-and-paragraphs email to
    // someone expecting a text — a latent bug that only bites the moment
    // somebody writes their first email.
    (variantsRes.data || []).forEach(function(row){
      if((row.channel || 'sms') === 'email'){
        if(!state.emailVariants[row.stage]) state.emailVariants[row.stage] = [];
        state.emailVariants[row.stage].push({
          id: row.variant_key, subject: row.subject || '', text: row.text,
          builtin: !!row.builtin, channel: 'email'
        });
        return;
      }
      if(!state.variants[row.stage]) state.variants[row.stage] = [];
      // retired survives the round trip or a reworded variant comes back from
      // the dead on the next sign-in, quietly competing again on a reply rate
      // that belongs to wording nobody sends any more.
      state.variants[row.stage].push({id: row.variant_key, text: row.text, builtin: !!row.builtin,
                                      needsChannel: !!row.needs_channel, retired: !!row.retired});
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
        missingRows.push({user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin, needs_channel: !!v.needsChannel, channel: 'sms'});
      });
    });
    if(missingRows.length){
      var backfillRes = await sb.from('variants').insert(missingRows);
      if(backfillRes.error) console.error('Ghost Recall: variant backfill failed', backfillRes.error);
    }
  }

  /* Moving email off the cadence must not look like email being deleted.

     An account with emails written against stages but an empty library gets
     them carried across, once. The `variants` rows are left in place: if this
     insert fails, or a later release changes its mind, the originals are still
     there. Seeded straight into the database rather than only into memory, so
     it happens whether or not the user goes on to save anything. */
  if(!(libRes.data || []).length){
    var seeded = seedEmailLibrary(state.emailVariants);
    if(seeded.length){
      var seedRows = seeded.map(function(d, i){
        return {user_id: uid, title: d.title, when_to_send: d.whenToSend,
                subject: d.subject, body: d.body, sort_order: i * 10};
      });
      var libSeedRes = await sb.from('email_library').insert(seedRows).select('*');
      if(libSeedRes.error){
        console.error('Ghost Recall: email library seed failed', libSeedRes.error);
      } else {
        state.emailLibrary = (libSeedRes.data || []).map(function(r){
          return {id: r.id, title: r.title, whenToSend: r.when_to_send || '',
                  subject: r.subject || '', body: r.body || '', touch: r.touch || '',
                  sortOrder: Number.isFinite(r.sort_order) ? r.sort_order : 0,
                  archived: !!r.archived, updatedAt: r.updated_at};
        });
      }
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
    // A new account is seeded with an explicit calendar filter. The column
    // has a default now and parse.ts falls back to the same thing, but this is
    // the layer a person can actually SEE and change in Settings — and an
    // account whose filter was invisible because it was null is precisely how
    // three people ended up with empty apps.
    var settingsSeedRes = await sb.from('app_settings').insert({
      user_id: uid, epsilon: 0.2,
      calendar_filter: {mode: 'attendees', exclude: []}
    });
    if(settingsSeedRes.error) throw settingsSeedRes.error;
  }

  // The baseline every later save diffs against: what the database is known to
  // hold right now. Until this is set, saveState refuses to delete anything —
  // so a failed or partial load can never be mistaken for "the user emptied
  // their account".
  // Per-account config into the engine, next to pipeline and sequence.
  setBookingLink(state.bookingLink);

  /* The team and owner views. Loaded last and never allowed to fail the load:
     state is already complete and usable by this point, so a manager widget
     that cannot read anything costs a tab, not a morning. Both tabs hide
     themselves when handed an empty list, so an individual account simply
     never sees them. */
  state.team = await loadTeamRows(sb, uid);
  state.platform = state.team;
  // An invite waiting for you, and the ones you have sent that nobody has
  // taken up. Both degrade to empty rather than failing the load.
  var orgRole = await loadOrgRole(sb, uid);
  state.canInvite = orgRole.canInvite;
  state.orgName = orgRole.orgName;
  state.pendingInvites = await loadPendingInvites(sb);
  state.sentInvites = state.canInvite ? await loadSentInvites(sb, uid) : [];

  SYNCED = buildSyncSnapshot(state, uid);

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

/* Persistence health, reported outward.

   The snapshot-shadowing bug survived a week because saveState's try/catch
   turned total failure into console.error — visible only to someone with dev
   tools open, which no salesperson ever has. A save that fails is not a
   logging concern, it is the user's work disappearing, and they are the one
   who needs to know.

   Reported through a window property rather than a shared function name,
   because two files declaring the same top-level name is exactly what caused
   the original bug. */
function reportSaveHealth(ok, detail){
  try{
    window.GB_SAVE_HEALTH = {ok: ok, detail: detail || null, at: Date.now()};
    if(typeof window.GB_ON_SAVE_HEALTH === 'function') window.GB_ON_SAVE_HEALTH(window.GB_SAVE_HEALTH);
  }catch(e){ /* reporting must never be the thing that breaks a save */ }
}

function rowClient(c, uid){
  return {
    id: c.id, user_id: uid, google_event_id: c.googleEventId || null,
    organizer_email: c.organizerEmail || null,
    // null, never '': a row imported before titles were kept must stay
    // distinguishable from an event genuinely titled nothing.
    event_title: c.eventTitle || null,
    email_status: c.emailStatus || 'ok',
    name: c.name, phone: c.phone, email: c.email,
    youtube_link: c.youtubeLink, meet_link: c.meetLink,
    call_date_time: c.callDateTime, booked_date: c.bookedDate,
    timezone: c.timezone, timezone_confirmed: !!c.timezoneConfirmed, status: c.status,
    notes: c.notes, recap: c.recap, close_outcome: c.closeOutcome || null,
    reschedules: c.reschedules, reschedule_count: c.rescheduleCount,
    stalled_since: c.stalledSince, ignored: !!c.ignored, manually_added: !!c.manuallyAdded,
    snoozed_until: c.snoozedUntil || {},
    skipped_stages: c.skippedStages || {}
  };
}
function rowMessage(m, clientId){
  return {
    id: m.id, client_id: clientId, stage: m.stage, variant_key: m.variantId || '',
    text: m.text, sent_at: m.sentAt, responded: !!m.responded,
    responded_at: m.respondedAt, reviewed: !!m.reviewed,
    channel: m.channel || 'sms'
  };
}
function rowTodo(t, uid){
  return {id: t.id, user_id: uid, text: t.text, done: !!t.done, created_at: t.createdAt, done_at: t.doneAt};
}
function rowVariant(v, stage, uid){
  return {user_id: uid, stage: stage, variant_key: v.id, text: v.text, builtin: !!v.builtin,
          needs_channel: !!v.needsChannel, channel: 'sms', retired: !!v.retired};
}
function rowEmailVariant(v, stage, uid){
  return {user_id: uid, stage: stage, variant_key: v.id, text: v.text,
          subject: v.subject || '', builtin: !!v.builtin, needs_channel: false, channel: 'email'};
}
function rowEmailDoc(d, uid){
  return {id: d.id, user_id: uid, title: d.title, when_to_send: d.whenToSend || '',
          subject: d.subject || '', body: d.body || '', touch: d.touch || null,
          sort_order: d.sortOrder, archived: !!d.archived};
}
function rowStat(s, stage, vk, uid){
  return {user_id: uid, stage: stage, variant_key: vk, sends: s.sends, responses: s.responses};
}

// Row objects are built with a fixed key order above, so stringify is a stable
// identity test — no key sorting needed.
function same(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

// Snapshot of everything persistable, keyed the way the diff needs it.
// Named buildSyncSnapshot, not snapshot: app.js declares its own snapshot()
// for the undo buffer and loads after this file, so a function called
// `snapshot` here is silently replaced at runtime. That shadowing broke every
// save for a week — saveState received a JSON string instead of a bucketed
// snapshot, diff() threw on it, and the try/catch turned a total persistence
// failure into a console message nobody was reading.
function buildSyncSnapshot(state, uid){
  var snap = {clients:{}, messages:{}, todos:{}, variants:{}, stats:{}, emailDocs:{}, settings:null};
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
    (state.variants[stage] || []).forEach(function(v){ snap.variants['sms|' + stage + '|' + v.id] = rowVariant(v, stage, uid); });
  });
  Object.keys(state.emailVariants || {}).forEach(function(stage){
    (state.emailVariants[stage] || []).forEach(function(v){
      snap.variants['email|' + stage + '|' + v.id] = rowEmailVariant(v, stage, uid);
    });
  });
  (state.emailLibrary || []).forEach(function(d){
    // A library entry with no id has never been saved; give it one here so the
    // diff can address it and an edit does not insert a second copy each save.
    if(!d.id) d.id = uuid();
    snap.emailDocs[d.id] = rowEmailDoc(d, uid);
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
    sequence: state.sequence || null,
    calendar_filter: state.calendarFilter || null,
    email_enabled: !!state.emailEnabled,
    auto_send_email: !!state.autoSendEmail,
    email_from_name: state.emailFromName || null,
    email_from_address: state.emailFromAddress || null,
    email_reply_to: state.emailReplyTo || null,
    booking_link: state.bookingLink || null,
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
    if(res.error){ console.error('Ghost Recall: events fetch failed', res.error); return []; }
    return res.data || [];
  }catch(e){
    // A timeline that cannot load is a degraded view, never a broken modal —
    // the derived history still renders from records already in memory.
    console.error('Ghost Recall: events fetch threw', e);
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
  var next = buildSyncSnapshot(state, uid);
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
    if(upVars.length) writes.push(sb.from('variants').upsert(upVars, {onConflict: 'user_id,stage,channel,variant_key'}));

    var st = diff(prev && prev.stats, next.stats);
    var upStats = st.added.concat(st.changed);
    if(upStats.length) writes.push(sb.from('variant_stats').upsert(upStats, {onConflict: 'user_id,stage,variant_key'}));

    var ed = diff(prev && prev.emailDocs, next.emailDocs);
    var upDocs = ed.added.concat(ed.changed);
    if(upDocs.length){
      // Same copy-before-stamping rule as clients: updated_at on the snapshot
      // row itself would poison the baseline and make every later save think
      // every email had changed.
      var stampedDocs = upDocs.map(function(r){
        var out = {}; Object.keys(r).forEach(function(k){ out[k] = r[k]; });
        out.updated_at = new Date().toISOString();
        return out;
      });
      writes.push(sb.from('email_library').upsert(stampedDocs));
    }
    // Deleting an email someone wrote is worth being careful about: explicit
    // ids only, and never before a baseline exists.
    if(prev && ed.removedKeys.length) writes.push(sb.from('email_library').delete().in('id', ed.removedKeys));

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

    if(!writes.length){ reportSaveHealth(true); return; }

    var results = await Promise.all(writes);
    var failed = results.filter(function(r){ return r && r.error; });
    if(failed.length){
      // Leave SYNCED where it is so the same diff is retried on the next save
      // rather than being silently forgotten.
      console.error('Ghost Recall: saveState partial failure', failed.map(function(r){ return r.error; }));
      reportSaveHealth(false, (failed[0].error && failed[0].error.message) || 'a write was rejected');
      return;
    }

    if(pending.length){
      state.pendingEvents = (state.pendingEvents || []).slice(pending.length);
    }
    if(ticket > SAVE_LANDED){ SAVE_LANDED = ticket; SYNCED = next; }
    reportSaveHealth(true);
  }catch(e){
    console.error('Ghost Recall: saveState failed', e);
    reportSaveHealth(false, (e && e.message) || 'unexpected error while saving');
  }
}
