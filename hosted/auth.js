'use strict';
/* GhostBuster (hosted build) — thin Google sign-in gate.
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
  }catch(e){
    console.error('GhostBuster: failed to load your data', e);
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
