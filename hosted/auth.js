'use strict';
/* Ghost Recall (hosted build) — thin Google sign-in gate.
   Owns the boot sequence: show the sign-in screen until Supabase reports a
   session, then reveal #app-root and hand off to app.js's init() (which
   pulls state through data.js). Loaded last, after logic.js/data.js/app.js
   have all defined their globals but before any of them have run. */

window.GB_SUPABASE = window.supabase.createClient(
  'https://gqfpsjksosxvszzhhezu.supabase.co',
  'sb_publishable_WbDf3Iwzk3cZU0zAa8qmXA_R_nwj7HJ'
);

var gbBooted = false;

function gbShowSignedIn(){
  document.getElementById('signin-screen').classList.add('hidden');
  document.getElementById('app-root').classList.remove('hidden');
}
function gbShowSignedOut(){
  /* Tear the assistant down on sign-out, before the app is hidden. It holds
     one account's findings in the DOM, and leaving them behind a hidden
     container would survive into whoever signs in next. */
  if(window.gbAssistantStop) window.gbAssistantStop();
  document.getElementById('app-root').classList.add('hidden');
  document.getElementById('signin-screen').classList.remove('hidden');
}

async function gbBoot(session){
  if(!session){ gbShowSignedOut(); return; }
  gbShowSignedIn();
  if(gbBooted) return; // already ran init() once this page load; auth events can fire more than once
  gbBooted = true;
  try{
    await init(); // from app.js — awaits loadState() (data.js), then renderAll()
    /* After init, because the panel reads STATE for contact names, and
       deliberately NOT awaited: an assistant that is slow to decide whether
       it is enrolled must not hold up the CRM behind it. It draws itself
       when it is ready, or never, and either way the app is already usable. */
    if(window.gbAssistantStart) window.gbAssistantStart();
  }catch(e){
    console.error('Ghost Recall: failed to load your data', e);
    document.getElementById('signin-error').textContent =
      'Something went wrong loading your data. Try refreshing the page.';
  }
}

document.getElementById('google-signin-btn').addEventListener('click', function(){
  document.getElementById('signin-error').textContent = '';
  window.GB_SUPABASE.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
});

window.GB_SUPABASE.auth.onAuthStateChange(function(_event, session){
  gbBoot(session);
});

window.GB_SUPABASE.auth.getSession().then(function(res){
  gbBoot(res.data.session);
});
