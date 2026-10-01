'use strict';
/* Test harness for The GhostBuster.
   Most tests run against logic.js directly via plain require() — it has
   zero DOM dependency, so no stubbing needed.
   The handful of tests that exercise the render layer (renderAll,
   renderCalendarTab — app.js) still need a stubbed DOM-less vm context;
   that harness now loads logic.js + app.js concatenated (exactly what the
   browser does via two <script src> tags in sequence) instead of
   regex-extracting an inline <script> from index.html. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const GB = require('./logic.js');

const logicSrc = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const code = logicSrc + '\n' + appSrc;

// node --check equivalent: make sure both files still parse as valid JS together.
new vm.Script(code, { filename: 'logic.js + app.js' });
console.log('node --check equivalent: OK (logic.js + app.js parse as valid JS)');

// Guards against exactly the bug found in the wild: renderDeadTab() was
// fully written, wired to real HTML elements, and unit-testable — but
// renderAll() never actually called it, so the Dead Clients tab silently
// rendered empty forever regardless of real data. Every render*() function
// must have at least one call site beyond its own `function` declaration.
{
  const renderFnNames = [...appSrc.matchAll(/^function (render\w+)\(\)\{/gm)].map(m => m[1]);
  assert.ok(renderFnNames.length > 5, 'sanity check: expected to find several render*() functions in app.js, found ' + renderFnNames.length);
  const orphaned = renderFnNames.filter(name => {
    const callSites = appSrc.match(new RegExp('\\b' + name + '\\(\\)', 'g')) || [];
    return callSites.length < 2; // 1 = only the `function name(){` declaration itself
  });
  assert.deepStrictEqual(orphaned, [], 'render*() function(s) defined but never called anywhere in app.js: ' + orphaned.join(', '));
  console.log('  ok  - every render*() function in app.js has at least one real call site (none are orphaned like renderDeadTab was)');
}

// ---- stubs (only used by the render-layer tests below, via GBFull) ----
class LocalStorageStub {
  constructor(){ this.store = {}; }
  getItem(k){ return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
  setItem(k, v){ this.store[k] = String(v); }
  removeItem(k){ delete this.store[k]; }
  clear(){ this.store = {}; }
}

// Properties that a "does this hang or throw" DOM stub must report as absent
// rather than as another live node — anything code might loop on
// (`while (node.firstChild)`, `for (... i < collection.length ...)`) has to
// bottom out, or a perfectly normal DOM idiom turns into an infinite loop
// against this stub specifically (real DOM churns through these as nodes are
// removed; a Proxy that always answers "yes, there's more" never does).
const NOOP_PROXY_EMPTY_PROPS = new Set([
  'firstChild', 'lastChild', 'nextSibling', 'previousSibling', 'parentNode', 'parentElement',
  'length', 'childElementCount'
]);
function makeNoopProxy() {
  const target = function () {};
  const handler = {
    get(t, prop) {
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'length') return 0;
      if (NOOP_PROXY_EMPTY_PROPS.has(prop)) return null;
      return proxy;
    },
    set() { return true; },
    apply() { return proxy; },
    construct() { return proxy; },
    has() { return true; }
  };
  const proxy = new Proxy(target, handler);
  return proxy;
}

function makeDocumentStub() {
  const proxy = makeNoopProxy();
  return proxy;
}

const sandbox = {};
sandbox.localStorage = new LocalStorageStub();
sandbox.document = makeDocumentStub();
sandbox.window = sandbox; // window.X === global X
sandbox.navigator = { clipboard: undefined };
sandbox.console = console;
sandbox.getComputedStyle = function () { return { getPropertyValue: function () { return '#000000'; } }; };
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.alert = () => {};
sandbox.confirm = () => true;
sandbox.prompt = () => '';
sandbox.Chart = function () { this.destroy = () => {}; };
sandbox.FileReader = function () {};
sandbox.Blob = function () {};
sandbox.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };

const context = vm.createContext(sandbox);
vm.runInContext(code, context, { filename: 'logic.js + app.js' });

const GBFull = sandbox.GhostBuster;
assert.ok(GBFull, 'GhostBuster test hook was not exposed on window');

let failures = 0;
// Async tests are queued and awaited before the summary. Without this, an
// async fn() returns a promise the runner drops on the floor: a failing
// assertion inside it becomes an unhandled rejection while the test still
// prints "ok". A test that cannot fail is worse than no test.
const pendingTests = [];
function reportFail(name, e) {
  failures++;
  console.log('  FAIL -', name);
  console.log('       ', e && e.message);
  if (e && e.stack) console.log(e.stack.split('\n').slice(1,4).join('\n'));
}
function test(name, fn) {
  try {
    GB._resetCaches();
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result.then(
        () => console.log('  ok  -', name),
        (e) => reportFail(name, e)
      ));
      return;
    }
    console.log('  ok  -', name);
  } catch (e) {
    reportFail(name, e);
  }
}

function freshClient(overrides) {
  const base = {
    id: 'c1', googleEventId: null,
    name: 'Jane Realtor', phone: '5125551234', email: 'jane@example.com',
    youtubeLink: '', meetLink: 'https://meet.google.com/abc-defg-hij',
    callDateTime: null, bookedDate: new Date().toISOString(),
    timezone: 'America/Chicago',
    status: 'Booked', messageLog: [], notes: '', recap: '',
    closeOutcome: undefined, reschedules: [], rescheduleCount: 0,
    stalledSince: null, ignored: false, manuallyAdded: true
  };
  return Object.assign(base, overrides);
}
function isoDaysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString(); }
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
// vm contexts have their own Array constructor, so arrays crossing the
// context boundary aren't assert.deepStrictEqual-compatible even when
// their contents match. Compare by value via JSON instead.
function assertDue(actual, expected) {
  assert.strictEqual(JSON.stringify(Array.from(actual)), JSON.stringify(expected));
}

// hosted/logic.js must stay byte-identical to logic.js — they are the same
// file served two ways, and the tests only load one of them. This drifted
// silently once already: uuid() and recordEvent() were added to one copy and
// the deployed build shipped without them.
{
  const a = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, 'hosted', 'logic.js'), 'utf8');
  assert.strictEqual(a, b, 'logic.js and hosted/logic.js have drifted — run: cp logic.js hosted/logic.js');
  console.log('  ok  - logic.js and hosted/logic.js are byte-identical');
}

// The Edge Function shares logic.js rather than reimplementing the cadence.
// parse.ts already demonstrates the cost of a hand-maintained copy — its
// AREA_CODE_TZ table is a second source of truth that has to be updated twice.
// A third copy of computeDue would be considerably worse: it decides what gets
// sent to real people, unattended.
{
  const a = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, 'supabase', 'functions', '_shared', 'logic.js'), 'utf8');
  assert.strictEqual(a, b,
    'logic.js and supabase/functions/_shared/logic.js have drifted — run: cp logic.js supabase/functions/_shared/logic.js');
  console.log('  ok  - the Edge Function shares the same logic.js, byte for byte');
}

console.log('\n--- computeDue ---');

test('booked today, call 3 weeks out -> welcome due', () => {
  const c = freshClient({ bookedDate: new Date().toISOString(), callDateTime: isoDaysFromNow(21) });
  const due = GB.computeDue(c, new Date());
  assert.ok(due.includes('welcome'), 'expected welcome in ' + JSON.stringify(due));
});

test('welcome due for a long-lead-time client is never filtered out of the text-today list by call date', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'c-longlead', bookedDate: new Date().toISOString(), callDateTime: isoDaysFromNow(21) });
  state.clients[c.id] = c;
  const items = GB.getTextTodayList(state, new Date(), '');
  assert.ok(items.some(it => it.client.id === c.id && it.stage === 'welcome'));
});

test('text-today queue puts a new booking\'s welcome text above an overdue noshow rescue', () => {
  const state = GB.buildDefaultState();
  // Distinct phones: these are two different people, and the queue now shows
  // one card per human rather than one per client record.
  const noshowClient = freshClient({
    id: 'c-noshow', phone: '5125550001', bookedDate: isoDaysAgo(10), callDateTime: isoDaysAgo(2),
    status: 'No-show',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(9), responded: false, respondedAt: null }]
  });
  const newBookingClient = freshClient({
    id: 'c-new-welcome', phone: '5125550002', bookedDate: new Date().toISOString(), callDateTime: isoDaysFromNow(21)
  });
  state.clients[noshowClient.id] = noshowClient;
  state.clients[newBookingClient.id] = newBookingClient;
  const items = GB.getTextTodayList(state, new Date(), '');
  const noshowIdx = items.findIndex(it => it.client.id === noshowClient.id && it.stage === 'noshow');
  const welcomeIdx = items.findIndex(it => it.client.id === newBookingClient.id && it.stage === 'welcome');
  assert.ok(noshowIdx !== -1, 'expected a noshow item in the queue, got ' + JSON.stringify(items));
  assert.ok(welcomeIdx !== -1, 'expected a welcome item in the queue, got ' + JSON.stringify(items));
  assert.ok(welcomeIdx < noshowIdx, 'expected welcome (new booking) to rank above noshow rescue');
});

test('call today, already welcomed -> only dayof due', () => {
  // Explicit hours rather than "now": the call has to be LATER today for the
  // day-of text to make sense, and anchoring both ends removes the
  // time-of-day flakiness this suite has been bitten by before.
  const now = new Date(); now.setHours(8, 0, 0, 0);
  const callAt = new Date(now); callAt.setHours(15, 0, 0, 0);
  const c = freshClient({
    bookedDate: isoDaysAgo(5),
    callDateTime: callAt.toISOString(),
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(4), responded: false, respondedAt: null }]
  });
  assertDue(GB.computeDue(c, now), ['dayof']);
});

test('a call that has already started gets no more run-up texts', () => {
  const now = new Date(); now.setHours(18, 0, 0, 0);
  const callAt = new Date(now); callAt.setHours(15, 0, 0, 0);   // three hours ago
  const c = freshClient({ bookedDate: isoDaysAgo(5), callDateTime: callAt.toISOString() });
  assertDue(GB.computeDue(c, now), [],
    'a day-of text sent after the call is worse than no text at all');
});

test('Completed client shows nothing due', () => {
  const c = freshClient({ status: 'Completed', callDateTime: isoDaysAgo(1) });
  assertDue(GB.computeDue(c, new Date()), []);
});

test('Ghosted, stalled 5 days -> recovery due', () => {
  const c = freshClient({ status: 'Ghosted', stalledSince: isoDaysAgo(5) });
  assert.ok(GB.computeDue(c, new Date()).includes('recovery'));
});

test('Ghosted, stalled 1 day -> nothing due', () => {
  const c = freshClient({ status: 'Ghosted', stalledSince: isoDaysAgo(1) });
  assertDue(GB.computeDue(c, new Date()), []);
});

test('No-show yesterday -> noshow due', () => {
  const c = freshClient({ status: 'No-show', callDateTime: isoDaysAgo(1) });
  assert.ok(GB.computeDue(c, new Date()).includes('noshow'));
});

test('No-show 30 days ago -> the intensive rescue is over, the slow lane picks it up', () => {
  // This previously asserted "nothing due", which encoded exactly the problem:
  // the 14-day rescue window closed and the lead was never contacted again.
  const c = freshClient({ status: 'No-show', callDateTime: isoDaysAgo(30) });
  assertDue(GB.computeDue(c, new Date()), ['revival']);
});

test('a no-show inside the rescue window gets the rescue, not the slow lane', () => {
  const c = freshClient({ status: 'No-show', callDateTime: isoDaysAgo(3) });
  const due = GB.computeDue(c, new Date());
  assert.ok(due.includes('noshow'));
  assert.ok(!due.includes('revival'), 'the monthly nudge should not overlap the intensive chase');
});

test('no-show rescue re-fires every few days, not just once — covers "said they wanted to reschedule but never gave a date"', () => {
  const c = freshClient({
    status: 'No-show', callDateTime: isoDaysAgo(9),
    messageLog: [{ stage: 'noshow', variantId: 'n1', text: 'hi', sentAt: isoDaysAgo(8), responded: true, respondedAt: isoDaysAgo(8) }]
  });
  // last rescue was 8 days ago — well past the re-fire window, and they DID
  // reply (just never locked a date), so it should still be due again.
  assert.ok(GB.computeDue(c, new Date()).includes('noshow'));
});

test('no-show rescue does NOT re-fire the day after it was just sent', () => {
  const c = freshClient({
    status: 'No-show', callDateTime: isoDaysAgo(2),
    messageLog: [{ stage: 'noshow', variantId: 'n1', text: 'hi', sentAt: isoDaysAgo(1), responded: false, respondedAt: null }]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('noshow'));
});

test('Rescheduled with no new date re-fires recovery every few days, not just once', () => {
  const c = freshClient({
    status: 'Rescheduled', stalledSince: isoDaysAgo(9),
    messageLog: [{ stage: 'recovery', variantId: 'r1', text: 'hi', sentAt: isoDaysAgo(8), responded: true, respondedAt: isoDaysAgo(8) }]
  });
  assert.ok(GB.computeDue(c, new Date()).includes('recovery'));
});

test('No-show already rescued -> nothing due', () => {
  const callTime = isoDaysAgo(2);
  const c = freshClient({
    status: 'No-show', callDateTime: callTime,
    messageLog: [{ stage: 'noshow', variantId: 'n1', text: 'hi', sentAt: new Date().toISOString(), responded: false, respondedAt: null }]
  });
  assertDue(GB.computeDue(c, new Date()), []);
});

test('ignored client shows nothing due and is excluded from stats', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'ig1', ignored: true, status: 'Completed', callDateTime: isoDaysAgo(1), closeOutcome: 'Closed' });
  state.clients[c.id] = c;
  assertDue(GB.computeDue(c, new Date()), []);
  const stats = GB.computeStats(state, 'all', new Date());
  assert.strictEqual(stats.callsTracked, 0, 'ignored client must not count toward calls tracked');
});

console.log('\n--- timezone-aware modal round trip ---');

test('formatDatetimeLocalInTZ / parseDatetimeLocalInTZ round-trip a client-local wall time to the same UTC instant', () => {
  const utcISO = '2026-08-18T22:00:00.000Z'; // 5:00 PM America/Chicago (CDT, UTC-5)
  const wall = GB.formatDatetimeLocalInTZ(new Date(utcISO), 'America/Chicago');
  assert.strictEqual(wall, '2026-08-18T17:00');
  const backToUTC = GB.parseDatetimeLocalInTZ(wall, 'America/Chicago');
  assert.strictEqual(backToUTC, utcISO);
});

console.log('\n--- real .ics data (from an actual MarketMakerMGMT booking) ---');

// This mirrors an actual "Second call | Youtube Strategy Session" booking pulled from
// John's calendar: DTSTART is zone-qualified (no trailing Z), and DESCRIPTION carries
// literal Google-Calendar HTML markup (<b>, <br>) rather than plain text.
const REAL_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/New_York:20260728T160000',
  'DTEND;TZID=America/New_York:20260728T163000',
  'DTSTAMP:20260716T175026Z',
  'UID:2mh2mk17p2d7sjfkuv6t5gdcrc',
  'CREATED:20260716T175026Z',
  'DESCRIPTION:<b>Booked by</b>\\nNick McDonald\\nNick@goasknick.com\\n661-235-5445\\n<br><b>Youtube Link</b>\\nhttps://www.youtube.com/@goasknick/shorts\\n<br><p>Book a personalized YouTube strategy call.</p>',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Second Call | Youtube Strategy Session (Nick McDonald)',
  'ATTENDEE;CN=info@marketmakermgmt.com;PARTSTAT=NEEDS-ACTION:mailto:info@marketmakermgmt.com',
  'ATTENDEE;CN=nick@goasknick.com;PARTSTAT=NEEDS-ACTION:mailto:nick@goasknick.com',
  'ATTENDEE;CN=will@marketmakermgmt.com;PARTSTAT=ACCEPTED:mailto:will@marketmakermgmt.com',
  'ATTENDEE;CN=john@marketmakermgmt.com;PARTSTAT=NEEDS-ACTION:mailto:john@marketmakermgmt.com',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('a real zone-qualified DTSTART parses to the correct UTC instant, not the viewer\'s own timezone', () => {
  const events = GB.parseICS(REAL_ICS);
  assert.strictEqual(events.length, 1);
  const client = GB.clientFromICSEvent(events[0]);
  assert.ok(client, 'event should be recognized as a strategy session');
  // 4:00 PM America/Chicago... no wait, this event is America/New_York -> 4:00 PM EDT = 20:00 UTC
  assert.strictEqual(client.callDateTime, '2026-07-28T20:00:00.000Z');
});

test('HTML-laden description does not break name/phone/link extraction', () => {
  const events = GB.parseICS(REAL_ICS);
  const client = GB.clientFromICSEvent(events[0]);
  assert.strictEqual(client.name, 'Nick McDonald', 'name should come from the SUMMARY parentheses');
  assert.strictEqual(client.phone, '661-235-5445');
  assert.strictEqual(client.youtubeLink, 'https://www.youtube.com/@goasknick/shorts');
  assert.strictEqual(client.email, 'nick@goasknick.com', 'should skip @marketmakermgmt.com attendees and pick the client');
});

test('email comes from the description ("Booked by") text, not the attendee list — a teammate cc\'d on the invite with a personal gmail cannot get mistaken for the client, regression for a real Donna Cave booking', () => {
  const ics = 'BEGIN:VEVENT\r\n' +
    'DTSTART;TZID=America/New_York:20260807T163000\r\n' +
    'UID:donna-cave-regression\r\n' +
    'CREATED:20260715T181319Z\r\n' +
    'DESCRIPTION:<b>Booked by</b>\\nDonna Cave\\nusranches@gmail.com\\n208-315-2888\\n<br><b>YouTube Link </b>\\nhttps://www.youtube.com/@IdahoWildRiversRealtyGroup-y8g/videos\\n<br>Book a call.\r\n' +
    'SUMMARY:Second call | Youtube Strategy Session (Donna Cave)\r\n' +
    // Attendee order matters here: a teammate's personal (non-company) gmail
    // sorts BEFORE the real client's email — the old attendee-scraping logic
    // would have grabbed this one first and silently mislabeled Donna's email.
    'ATTENDEE;CN=john@marketmakermgmt.com:mailto:john@marketmakermgmt.com\r\n' +
    'ATTENDEE;CN=vionna@marketmakermgmt.com:mailto:vionna@marketmakermgmt.com\r\n' +
    'ATTENDEE;CN=marinosarahk@gmail.com:mailto:marinosarahk@gmail.com\r\n' +
    'ATTENDEE;CN=usranches@gmail.com:mailto:usranches@gmail.com\r\n' +
    'END:VEVENT';
  const client = GB.clientFromICSEvent(GB.parseICS(ics)[0]);
  assert.strictEqual(client.email, 'usranches@gmail.com', 'should use the description-stated email, not whichever attendee happens to sort first');
});

test('a Google-redirect-wrapped YouTube link resolves to the clean URL, not the tracking wrapper', () => {
  const wrapped = 'BEGIN:VEVENT\r\n' +
    'DTSTART;TZID=America/New_York:20260729T150000\r\n' +
    'UID:redirect-test-1\r\n' +
    'CREATED:20260728T201332Z\r\n' +
    'DESCRIPTION:<b>Booked by</b>\\nLeticia Isambo\\nLeticia.Isambo@exprealty.com\\n2404275301\\n<br><b>YouTube Link </b>\\n<a href="https://www.google.com/url?q=https://www.youtube.com/@DMVLivingInvesting/videos&sa=D&source=calendar">https://www.youtube.com/@DMVLivingInvesting/videos</a>\\n<br>Book a call.\r\n' +
    'SUMMARY:Review| Youtube Strategy Session (Leticia Isambo)\r\n' +
    'ATTENDEE;CN=joey@marketmakermgmt.com:mailto:joey@marketmakermgmt.com\r\n' +
    'ATTENDEE;CN=leticia.isambo@gmail.com:mailto:leticia.isambo@gmail.com\r\n' +
    'END:VEVENT';
  const client = GB.clientFromICSEvent(GB.parseICS(wrapped)[0]);
  assert.strictEqual(client.youtubeLink, 'https://www.youtube.com/@DMVLivingInvesting/videos');
});

console.log('\n--- migration ---');

test('old backup missing the noshow stage entirely loads without throwing and gains it', () => {
  const oldBackup = {
    clients: {
      abc: { id: 'abc', name: 'Old Client', phone: '5125551111', callDateTime: isoDaysFromNow(2), bookedDate: isoDaysAgo(3), status: 'Booked', messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hey', sentAt: isoDaysAgo(3), responded: true, respondedAt: isoDaysAgo(2) }] }
    },
    variants: { welcome: [{ id: 'w1', text: 'hey {name}' }], monday: [], midcheckin: [], dayof: [] }, // no recovery, no noshow at all
    variantStats: { welcome: { w1: { sends: 1, responses: 1 } } },
    epsilon: 0.3
  };
  let state;
  assert.doesNotThrow(() => { state = GB.migrateState(oldBackup); });
  assert.ok(state.variants.noshow && state.variants.noshow.length >= 3, 'noshow stage should be freshly seeded with built-ins');
  assert.ok(state.clients.abc, 'existing client must survive migration');
  assert.strictEqual(state.clients.abc.messageLog.length, 1, 'existing message log must survive migration');
  assert.strictEqual(state.variantStats.welcome.w1.sends, 1, 'existing stats must survive migration');
});

test('completely empty/garbage saved data does not throw', () => {
  assert.doesNotThrow(() => GB.migrateState(null));
  assert.doesNotThrow(() => GB.migrateState(undefined));
  assert.doesNotThrow(() => GB.migrateState('garbage'));
  assert.doesNotThrow(() => GB.migrateState({ clients: { x: null, y: 'nope', z: { callDateTime: 'not-a-date', status: 'BOGUS' } } }));
});

console.log('\n--- rebooking detection ---');

test('a new booking with the same phone+email as an existing client, but a different call time, is flagged rebooked', () => {
  const state = GB.buildDefaultState();
  const original = freshClient({ id: 'orig', name: 'Jane Realtor', phone: '5125551234', email: 'jane@example.com', callDateTime: isoDaysAgo(20), status: 'Ghosted' });
  state.clients[original.id] = original;
  const res = GB.commitImportedClients(state, [{
    googleEventId: 'evt-new', name: 'Jane Realtor', phone: '512-555-1234', email: 'Jane@Example.com',
    callDateTime: isoDaysFromNow(3), bookedDate: GB.nowISO ? GB.nowISO() : new Date().toISOString()
  }]);
  assert.strictEqual(res.added, 1);
  const newClient = Object.values(state.clients).find(c => c.googleEventId === 'evt-new');
  assert.ok(newClient, 'new client should have been created');
  assert.strictEqual(newClient.rebooked, true, 'phone+email match (case/formatting-insensitive) with a different call time must mark rebooked');
});

test('a brand new phone+email with no prior match is not flagged rebooked', () => {
  const state = GB.buildDefaultState();
  const res = GB.commitImportedClients(state, [{
    googleEventId: 'evt-stranger', name: 'Stranger', phone: '5125559999', email: 'stranger@example.com',
    callDateTime: isoDaysFromNow(3), bookedDate: new Date().toISOString()
  }]);
  const newClient = Object.values(state.clients).find(c => c.googleEventId === 'evt-stranger');
  assert.strictEqual(newClient.rebooked, false);
});

test('computeDue gives a rebooked client the "rebooked" stage instead of "welcome"', () => {
  const c = freshClient({ id: 'rb', callDateTime: isoDaysFromNow(5), rebooked: true });
  const due = GB.computeDue(c, new Date());
  assert.ok(due.includes('rebooked'), 'expected rebooked in ' + JSON.stringify(due));
  assert.ok(!due.includes('welcome'), 'a rebooked client should not also get a cold welcome, got ' + JSON.stringify(due));
});

test('an unsent rebooked text ranks at the top of the text-today queue, same as welcome', () => {
  const state = GB.buildDefaultState();
  const noshowClient = freshClient({
    id: 'c-noshow-2', phone: '5125550003', bookedDate: isoDaysAgo(10), callDateTime: isoDaysAgo(2), status: 'No-show',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(9), responded: false, respondedAt: null }]
  });
  const rebookedClient = freshClient({ id: 'c-rebooked', phone: '5125550004', callDateTime: isoDaysFromNow(3), rebooked: true });
  state.clients[noshowClient.id] = noshowClient;
  state.clients[rebookedClient.id] = rebookedClient;
  const items = GB.getTextTodayList(state, new Date(), '');
  const noshowIdx = items.findIndex(it => it.client.id === noshowClient.id && it.stage === 'noshow');
  const rebookedIdx = items.findIndex(it => it.client.id === rebookedClient.id && it.stage === 'rebooked');
  assert.ok(rebookedIdx !== -1 && noshowIdx !== -1);
  assert.ok(rebookedIdx < noshowIdx, 'expected rebooked to rank above a noshow rescue, same as welcome does');
});

console.log('\n--- dead clients ---');

test('a Ghosted client goes dead 14+ days after their last recovery text with no rebooking', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({
    id: 'dead-1', status: 'Ghosted', callDateTime: isoDaysAgo(20),
    messageLog: [{ stage: 'recovery', variantId: 'r1', text: 'hey', sentAt: isoDaysAgo(15), responded: false, respondedAt: null }]
  });
  state.clients[c.id] = c;
  const dead = GB.computeDeadClients(state, new Date(), 14);
  assert.strictEqual(dead.length, 1);
  assert.strictEqual(dead[0].id, 'dead-1');
});

test('a Ghosted client is not dead yet if their last recovery text was sent fewer than 14 days ago', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({
    id: 'not-dead-1', status: 'Ghosted', callDateTime: isoDaysAgo(5),
    messageLog: [{ stage: 'recovery', variantId: 'r1', text: 'hey', sentAt: isoDaysAgo(3), responded: false, respondedAt: null }]
  });
  state.clients[c.id] = c;
  const dead = GB.computeDeadClients(state, new Date(), 14);
  assert.strictEqual(dead.length, 0);
});

test('a client who was rebooked (matching phone+email with a later call time elsewhere) is never marked dead', () => {
  const state = GB.buildDefaultState();
  const oldOne = freshClient({
    id: 'old-ghost', name: 'Jane Realtor', phone: '5125551234', email: 'jane@example.com', status: 'Ghosted', callDateTime: isoDaysAgo(30),
    messageLog: [{ stage: 'recovery', variantId: 'r1', text: 'hey', sentAt: isoDaysAgo(20), responded: false, respondedAt: null }]
  });
  const newBooking = freshClient({
    id: 'new-booking', name: 'Jane Realtor', phone: '5125551234', email: 'jane@example.com', status: 'Booked', callDateTime: isoDaysFromNow(5), rebooked: true
  });
  state.clients[oldOne.id] = oldOne;
  state.clients[newBooking.id] = newBooking;
  const dead = GB.computeDeadClients(state, new Date(), 14);
  assert.strictEqual(dead.length, 0, 'the old record should not be flagged dead once the same contact has a newer booking on file');
});

test('sameContact matches on phone alone when emails differ — real people often rebook under a different email (work vs personal, a typo the first time)', () => {
  const a = freshClient({ id: 'a', phone: '720-802-4041', email: 'work@example.com' });
  const b = freshClient({ id: 'b', phone: '(720) 802-4041', email: 'personal@gmail.com' });
  assert.ok(GB.sameContact(a, b), 'same phone number should be enough to recognize the same person even with a different email');
});

test('sameContact falls back to email match only when a phone number is missing on one side', () => {
  const a = freshClient({ id: 'a', phone: '', email: 'jane@example.com' });
  const b = freshClient({ id: 'b', phone: '5125551234', email: 'jane@example.com' });
  assert.ok(GB.sameContact(a, b), 'no phone to compare on one side — email match should still count');
});

test('sameContact does not match two different people who happen to share nothing in common', () => {
  const a = freshClient({ id: 'a', phone: '5125551234', email: 'jane@example.com' });
  const b = freshClient({ id: 'b', phone: '9995550000', email: 'someone-else@example.com' });
  assert.ok(!GB.sameContact(a, b));
});

test('a real rebooking with the same phone but a different email is correctly detected and tagged as a followup, not a fresh lead — regression for Kyle Gilmore / Cassandra Salamone / Leticia Isambo', () => {
  const state = GB.buildDefaultState();
  const original = freshClient({
    id: 'original', googleEventId: 'evt-1', name: 'Cassandra Salamone',
    phone: '602-402-8387', email: 'homes@cassandrasoldit.com',
    status: 'Completed', callDateTime: isoDaysAgo(10)
  });
  state.clients[original.id] = original;
  const res = GB.commitImportedClients(state, [{
    googleEventId: 'evt-2', name: 'Cassandra Salamone',
    phone: '6024028387', email: 'csalamone2016@gmail.com',
    callDateTime: isoDaysFromNow(14), bookedDate: new Date().toISOString()
  }]);
  assert.strictEqual(res.added, 1);
  const added = Object.values(state.clients).find(c => c.googleEventId === 'evt-2');
  assert.ok(added.rebooked, 'should be recognized as the same contact rebooking, despite the different email');
  assert.ok(added.hadPriorCall, 'the prior record was Completed, so this should route to "followup" not "rebooked"');
});

test('a Completed AND Closed client (an actual won deal) is never marked dead, no matter how long ago the call was', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'closed-old', status: 'Completed', closeOutcome: 'Closed', callDateTime: isoDaysAgo(60) });
  state.clients[c.id] = c;
  assert.strictEqual(GB.computeDeadClients(state, new Date(), 14).length, 0);
});

test('a Completed but NOT closed client with no follow-up call booked for 14+ days goes dead — they had a real call, it just never closed', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'completed-not-closed-old', status: 'Completed', closeOutcome: 'Not closed', callDateTime: isoDaysAgo(20) });
  state.clients[c.id] = c;
  const dead = GB.computeDeadClients(state, new Date(), 14);
  assert.ok(dead.some(x => x.id === 'completed-not-closed-old'));
});

test('a Completed but NOT closed client is NOT yet dead while still inside the 14-day follow-up window', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'completed-not-closed-recent', status: 'Completed', closeOutcome: 'Not closed', callDateTime: isoDaysAgo(5) });
  state.clients[c.id] = c;
  const dead = GB.computeDeadClients(state, new Date(), 14);
  assert.ok(!dead.some(x => x.id === 'completed-not-closed-recent'));
});

test('a client with a qualifying status but zero messages ever sent still goes dead 14+ days after their call date', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'silent-noshow', status: 'No-show', callDateTime: isoDaysAgo(16), messageLog: [] });
  state.clients[c.id] = c;
  const dead = GB.computeDeadClients(state, new Date(), 14);
  assert.strictEqual(dead.length, 1);
});

test('a client who has gone dead no longer clutters the Text Today queue with endless noshow rescue texts', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'dead-but-still-noshow', status: 'No-show', callDateTime: isoDaysAgo(20) });
  state.clients[c.id] = c;
  // sanity: without the dead check this client would otherwise still be due for 'noshow' rescue
  const stillEligibleStatuses = GB.computeDue(c, new Date());
  const items = GB.getTextTodayList(state, new Date(), '');
  assert.ok(!items.some(it => it.client.id === c.id), 'a dead client must not appear in the active text queue, even if computeDue would still surface a stage for them: ' + JSON.stringify(stillEligibleStatuses));
});

test('a client rebooked after going cold immediately reappears in the Text Today queue — going dead is self-correcting, not a one-way door', () => {
  const state = GB.buildDefaultState();
  const goneCold = freshClient({ id: 'cold-1', status: 'No-show', callDateTime: isoDaysAgo(20) });
  const rebooking = freshClient({ id: 'cold-1-rebooked', status: 'Booked', phone: goneCold.phone, email: goneCold.email, callDateTime: isoDaysFromNow(5), bookedDate: new Date().toISOString() });
  state.clients[goneCold.id] = goneCold;
  state.clients[rebooking.id] = rebooking;
  const items = GB.getTextTodayList(state, new Date(), '');
  assert.ok(items.some(it => it.client.id === rebooking.id), 'the fresh rebooking should be active and queued for its welcome/rebooked text');
});

console.log('\n--- edited text is source of truth ---');

test('markSent stores the exact text passed in, even if edited from the generated default', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'edit1', callDateTime: null });
  state.clients[c.id] = c;
  const edited = 'Totally custom hand-written message, not from any template.';
  GB.markSent(state, c.id, 'welcome', edited);
  assert.strictEqual(state.clients[c.id].messageLog[0].text, edited);
});

test('a hand-edited or AI-generated send is logged as variantId "custom" and does not pollute the underlying template\'s bandit stats', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'edit2', callDateTime: null });
  state.clients[c.id] = c;
  const before = JSON.parse(JSON.stringify(state.variantStats.welcome || {}));
  GB.markSent(state, c.id, 'welcome', 'A fully custom message written from notes, matching no template.');
  const logged = state.clients[c.id].messageLog[0];
  assert.strictEqual(logged.variantId, 'custom');
  const after = state.variantStats.welcome || {};
  Object.keys(after).forEach(vid => {
    const beforeSends = (before[vid] && before[vid].sends) || 0;
    assert.strictEqual(after[vid].sends, beforeSends, 'a real template variant\'s send count must not move when a custom message is sent instead');
  });
});

test('an un-edited, template-rendered send is attributed to its variant, and credits the bandit once reviewed', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'edit3', callDateTime: null });
  state.clients[c.id] = c;
  const variant = GB.pickVariant(state, 'welcome', c);
  const rendered = GB.getOriginalText ? GB.getOriginalText(state, c, 'welcome') : null;
  GB.markSent(state, c.id, 'welcome', rendered !== null ? rendered : variant.text);
  const logged = state.clients[c.id].messageLog[0];
  assert.notStrictEqual(logged.variantId, 'custom');
  // The send is attributed immediately but stays out of the denominator until
  // the reply question is actually answered — see reviewMessage.
  assert.strictEqual(state.variantStats.welcome[logged.variantId].sends, 0);
  GB.reviewMessage(state, c.id, 0, false);
  assert.strictEqual(state.variantStats.welcome[logged.variantId].sends, 1);
});

console.log('\n--- variant bandit ---');

test('pickVariant never returns undefined even with an empty variants stage', () => {
  const state = GB.buildDefaultState();
  state.variants.welcome = []; // corrupted / emptied stage
  const c = freshClient({});
  let v;
  assert.doesNotThrow(() => { v = GB.pickVariant(state, 'welcome', c); });
  assert.ok(v && typeof v.id === 'string');
});

test('needsChannel variants are ineligible without a readable @handle', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ youtubeLink: 'https://youtube.com/channel/UC12345' }); // not human-readable
  for (let i = 0; i < 25; i++) {
    const v = GB.pickVariant(state, 'welcome', c, { forceReroll: true });
    assert.notStrictEqual(v.id, 'w3', 'w3 needs a channel and should never be picked here');
  }
});

test('picked variant stays sticky across repeated picks until reset', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({});
  const first = GB.pickVariant(state, 'welcome', c);
  for (let i = 0; i < 10; i++) {
    const again = GB.pickVariant(state, 'welcome', c);
    assert.strictEqual(again.id, first.id);
  }
});

console.log('\n--- delete client ---');

test('deleteClient removes the client and only that client', () => {
  const state = GB.buildDefaultState();
  state.clients.keep = freshClient({ id: 'keep', name: 'Keep Me' });
  state.clients.gone = freshClient({ id: 'gone', name: 'Delete Me' });
  GB.deleteClient(state, 'gone');
  assert.ok(state.clients.keep, 'unrelated client must survive');
  assert.strictEqual(state.clients.gone, undefined);
});

console.log('\n--- CSV export ---');

test('csvField quotes and escapes fields containing commas, quotes, or newlines', () => {
  assert.strictEqual(GB.csvField('plain'), 'plain');
  assert.strictEqual(GB.csvField('Smith, John'), '"Smith, John"');
  assert.strictEqual(GB.csvField('She said "hi"'), '"She said ""hi"""');
  assert.strictEqual(GB.csvField(null), '');
  assert.strictEqual(GB.csvField(3), '3');
});

test('buildClientsCsv emits a header row plus one row per non-ignored client', () => {
  const state = GB.buildDefaultState();
  state.clients.a = freshClient({ id: 'a', name: 'Included Client', ignored: false });
  state.clients.b = freshClient({ id: 'b', name: 'Excluded Client', ignored: true });
  const csv = GB.buildClientsCsv(state);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines.length, 2, 'header + 1 client row (ignored client excluded)');
  assert.ok(lines[0].startsWith('Name,Phone,Email'));
  assert.ok(lines[1].includes('Included Client'));
  assert.ok(!csv.includes('Excluded Client'));
});

console.log('\n--- trend arrows ---');

test('trendHtml shows an up arrow in green when a higher-is-better stat improves', () => {
  const html = GB.trendHtml(0.80, 0.70, {});
  assert.ok(html.includes('trend up'));
  assert.ok(html.includes('▲10%'));
});

test('trendHtml shows an up arrow in red (not green) for reschedule rate, where lower is better', () => {
  const html = GB.trendHtml(0.30, 0.10, { lowerIsBetter: true });
  assert.ok(html.includes('trend down'), 'an increase in reschedule rate is a regression, should render as "down"/red');
  assert.ok(html.includes('▲20%'));
});

test('trendHtml renders nothing when there is no prior-period data to compare against', () => {
  assert.strictEqual(GB.trendHtml(0.5, null, {}), '');
  assert.strictEqual(GB.trendHtml(0.5, undefined, {}), '');
});

console.log('\n--- snooze a touch ---');

test('snoozing a due stage suppresses it today but it reappears tomorrow', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'snooze1', callDateTime: null }); // welcome has no date gating, always a clean due target
  state.clients[c.id] = c;
  assert.ok(GB.computeDue(c, new Date()).includes('welcome'), 'sanity: welcome should be due before snoozing');
  GB.snoozeTouch(state, c.id, 'welcome', new Date());
  assertDue(GB.computeDue(c, new Date()), []);
  const tomorrow = new Date(Date.now() + 25 * 3600000); // comfortably past midnight
  assert.ok(GB.computeDue(c, tomorrow).includes('welcome'), 'should self-expire and become due again the next day');
});

test('sending a touch clears any snooze that was set on it', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ id: 'snooze2', callDateTime: null });
  state.clients[c.id] = c;
  GB.snoozeTouch(state, c.id, 'welcome', new Date());
  assert.ok(state.clients[c.id].snoozedUntil.welcome, 'sanity: snooze should be recorded');
  GB.markSent(state, c.id, 'welcome', 'hi');
  assert.strictEqual(state.clients[c.id].snoozedUntil.welcome, undefined);
});

test('an old backup with no snoozedUntil field loads without throwing and treats the client as unsnoozed', () => {
  const raw = { clients: { z: { id: 'z', name: 'Old Client', status: 'Booked', messageLog: [] } } };
  let state;
  assert.doesNotThrow(() => { state = GB.migrateState(raw); });
  assert.deepStrictEqual(Object.keys(state.clients.z.snoozedUntil), []);
});

console.log('\n--- recent sends ---');

test('getRecentSends returns messages sent within the window, newest first, excluding ignored clients', () => {
  const state = GB.buildDefaultState();
  const now = new Date();
  const cOld = freshClient({
    id: 'rs-old', name: 'Old Sender',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'too old', sentAt: isoDaysAgo(10), responded: false, respondedAt: null }]
  });
  const cNewer = freshClient({
    id: 'rs-newer', name: 'Newer Sender',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'sent yesterday', sentAt: isoDaysAgo(1), responded: false, respondedAt: null }]
  });
  const cNewest = freshClient({
    id: 'rs-newest', name: 'Newest Sender',
    messageLog: [{ stage: 'dayof', variantId: 'd1', text: 'sent today', sentAt: now.toISOString(), responded: false, respondedAt: null }]
  });
  const cIgnored = freshClient({
    id: 'rs-ignored', name: 'Ignored Sender', ignored: true,
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'should not appear', sentAt: now.toISOString(), responded: false, respondedAt: null }]
  });
  [cOld, cNewer, cNewest, cIgnored].forEach(c => { state.clients[c.id] = c; });

  const recent = GB.getRecentSends(state, now, 3);
  assert.strictEqual(recent.length, 2, 'expected only the two sends inside the 3-day window, got ' + JSON.stringify(recent.map(r=>r.client.name)));
  assert.strictEqual(recent[0].client.id, 'rs-newest', 'expected newest send first');
  assert.strictEqual(recent[1].client.id, 'rs-newer', 'expected second-newest send second');
  assert.strictEqual(recent[0].idx, 0, 'idx must point at the message\'s position in that client\'s messageLog, for the replied-toggle to address the right entry');
});

console.log('\n--- health alerts ---');

test('computeHealthAlerts flags a real duplicate booking — same person, same slot booked twice by accident', () => {
  const state = GB.buildDefaultState();
  const t = new Date().toISOString();
  const a = freshClient({ id: 'dup-a', name: 'Sam Buyer', phone: '5125551234', callDateTime: t });
  const b = freshClient({ id: 'dup-b', name: 'Sam Buyer', phone: '5125551234', callDateTime: t });
  state.clients[a.id] = a; state.clients[b.id] = b;
  const alerts = GB.computeHealthAlerts(state);
  assert.ok(alerts.some(x => x.type === 'duplicate'), 'two entries for the same person at the same time should be flagged as a real duplicate');
});

test('computeHealthAlerts does NOT flag a legitimate rebooking (same person, genuinely different call dates) as a duplicate — that is what the rebooked/followup messaging is for', () => {
  const state = GB.buildDefaultState();
  const a = freshClient({ id: 'rebook-a', name: 'Jane Realtor', phone: '5125551234', callDateTime: isoDaysAgo(30), status: 'Completed' });
  const b = freshClient({ id: 'rebook-b', name: 'Jane Realtor', phone: '5125551234', callDateTime: isoDaysFromNow(5), rebooked: true, hadPriorCall: true });
  state.clients[a.id] = a; state.clients[b.id] = b;
  const alerts = GB.computeHealthAlerts(state);
  assert.ok(!alerts.some(x => x.type === 'duplicate'), 'a real second call weeks apart is not a duplicate to clean up, it is expected behavior');
});

test('computeHealthAlerts flags a client whose status stopped the cadence before any text ever went out', () => {
  const state = GB.buildDefaultState();
  const neverTexted = freshClient({ id: 'never-texted', name: 'Never Texted', status: 'No-show', messageLog: [] });
  const properlyTexted = freshClient({
    id: 'properly-texted', name: 'Properly Texted', status: 'No-show',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(5), responded: false, respondedAt: null }]
  });
  const stillActive = freshClient({ id: 'still-active', name: 'Still Active', status: 'Booked', messageLog: [] });
  [neverTexted, properlyTexted, stillActive].forEach(c => { state.clients[c.id] = c; });

  const alerts = GB.computeHealthAlerts(state);
  const nt = alerts.find(a => a.type === 'never-texted');
  assert.ok(nt, 'expected a never-texted alert, got ' + JSON.stringify(alerts.map(a=>a.type)));
  assert.strictEqual(nt.clients.length, 1, 'only the client with status stopping the cadence AND an empty messageLog should be flagged');
  assert.strictEqual(nt.clients[0].id, 'never-texted');
});

test('computeHealthAlerts does not flag a never-texted client while their status still allows cadence to run', () => {
  const state = GB.buildDefaultState();
  const stillActive = freshClient({ id: 'still-active-2', name: 'Still Active', status: 'Booked', messageLog: [] });
  state.clients[stillActive.id] = stillActive;
  const alerts = GB.computeHealthAlerts(state);
  assert.ok(!alerts.some(a => a.type === 'never-texted'), 'a Booked client with no messages yet is normal, not a silent drop');
});

test('computeHealthAlerts warns about a call in the next 48 hours that never got a welcome text — catches the gap before it happens, not after', () => {
  const state = GB.buildDefaultState();
  const soon = freshClient({ id: 'soon-untexted', name: 'Soon Untexted', status: 'Booked', callDateTime: isoDaysFromNow(1), messageLog: [] });
  state.clients[soon.id] = soon;
  const alerts = GB.computeHealthAlerts(state);
  const a = alerts.find(x => x.type === 'imminent-untexted');
  assert.ok(a, 'expected an imminent-untexted alert, got ' + JSON.stringify(alerts.map(x=>x.type)));
  assert.strictEqual(a.clients[0].id, 'soon-untexted');
});

test('computeHealthAlerts does not warn about an imminent call once the welcome text has actually gone out', () => {
  const state = GB.buildDefaultState();
  const texted = freshClient({
    id: 'soon-texted', status: 'Booked', callDateTime: isoDaysFromNow(1),
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: new Date().toISOString(), responded: false, respondedAt: null }]
  });
  state.clients[texted.id] = texted;
  const alerts = GB.computeHealthAlerts(state);
  assert.ok(!alerts.some(a => a.type === 'imminent-untexted'));
});

test('computeHealthAlerts does not warn about a call more than 48 hours out — not imminent yet', () => {
  const state = GB.buildDefaultState();
  const later = freshClient({ id: 'far-untexted', status: 'Booked', callDateTime: isoDaysFromNow(5), messageLog: [] });
  state.clients[later.id] = later;
  const alerts = GB.computeHealthAlerts(state);
  assert.ok(!alerts.some(a => a.type === 'imminent-untexted'));
});

console.log('\n--- calendar tab ---');

test('getCallsByLocalDay buckets clients by their call date and excludes ignored clients', () => {
  const state = GB.buildDefaultState();
  const d = new Date(); d.setHours(15, 0, 0, 0);
  const c1 = freshClient({ id: 'cal1', callDateTime: d.toISOString() });
  const c2 = freshClient({ id: 'cal2', callDateTime: d.toISOString(), ignored: true });
  state.clients[c1.id] = c1; state.clients[c2.id] = c2;
  const byDay = GB.getCallsByLocalDay(state);
  const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  assert.ok(byDay[key], 'expected a bucket for today');
  assert.strictEqual(byDay[key].length, 1, 'ignored client must not appear on the calendar');
  assert.strictEqual(byDay[key][0].id, 'cal1');
});

test('lastMessageIndex finds the most recently sent message regardless of log order', () => {
  const c = freshClient({
    messageLog: [
      { stage: 'welcome', variantId: 'w1', text: 'a', sentAt: isoDaysAgo(3), responded: false, respondedAt: null },
      { stage: 'dayof', variantId: 'd1', text: 'b', sentAt: isoDaysAgo(1), responded: false, respondedAt: null },
      { stage: 'monday', variantId: 'm1', text: 'c', sentAt: isoDaysAgo(2), responded: false, respondedAt: null }
    ]
  });
  assert.strictEqual(GB.lastMessageIndex(c), 1);
});

test('renderCalendarTab does not throw in month or week view, empty or populated', () => {
  const state = GBFull.buildDefaultState();
  const d = new Date();
  state.clients['cal3'] = freshClient({ id: 'cal3', callDateTime: d.toISOString() });
  GBFull._setState(state);
  GBFull._getUI().calendarView = 'month';
  assert.doesNotThrow(() => GBFull.renderCalendarTab());
  GBFull._getUI().calendarView = 'week';
  assert.doesNotThrow(() => GBFull.renderCalendarTab());
  GBFull._setState(GBFull.buildDefaultState());
  assert.doesNotThrow(() => GBFull.renderCalendarTab());
});

console.log('\n--- on deck ---');

// These tests reason about "today", so they are anchored to a fixed 9am rather
// than to the real clock. Anchored to Date.now() they were time-of-day
// dependent: run after ~9pm, "a call 180 minutes out" lands tomorrow and drops
// out of today's list, so the suite passed all day and failed every evening.
const ON_DECK_NOW = (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d; })();

// Build a client whose call is `mins` from the anchor, so these read as "a call
// 10 minutes out" rather than as ISO string arithmetic.
function clientAtMinutes(id, mins, overrides) {
  return freshClient(Object.assign({
    id: id,
    name: id,
    phone: '213-555-0100',
    callDateTime: new Date(ON_DECK_NOW.getTime() + mins * 60000).toISOString(),
  }, overrides || {}));
}
function stateWith(clients) {
  const s = GB.buildDefaultState();
  clients.forEach(c => { s.clients[c.id] = c; });
  return s;
}

test('the next unresolved call today becomes the focus', () => {
  const s = stateWith([clientAtMinutes('soon', 10), clientAtMinutes('later', 180)]);
  const od = GB.getOnDeck(s, ON_DECK_NOW);
  assert.strictEqual(od.focus.id, 'soon');
  assert.strictEqual(od.later.length, 1);
});

test('a call inside the soon window is flagged soon, not late', () => {
  const od = GB.getOnDeck(stateWith([clientAtMinutes('a', 10)]), ON_DECK_NOW);
  assert.strictEqual(od.soon, true);
  assert.strictEqual(od.late, false);
  assert.strictEqual(od.started, false);
});

test('a call a few minutes past its start is late and counts as started', () => {
  const od = GB.getOnDeck(stateWith([clientAtMinutes('a', -10)]), ON_DECK_NOW);
  assert.strictEqual(od.late, true);
  assert.strictEqual(od.started, true);
});

test('a call well past its start stops being live — end of day owns it', () => {
  const s = stateWith([clientAtMinutes('cold', -120)]);
  const od = GB.getOnDeck(s, ON_DECK_NOW);
  assert.strictEqual(od.focus, null);
  assert.strictEqual(od.unlogged.length, 1, 'still needs an outcome, just not live');
});

test('a call with an outcome already logged is never the focus', () => {
  const od = GB.getOnDeck(stateWith([clientAtMinutes('done', -10, { status: 'Completed' })]), ON_DECK_NOW);
  assert.strictEqual(od.focus, null);
  assert.strictEqual(od.loggedCount, 1);
});

test('ignored clients stay out of it entirely', () => {
  const od = GB.getOnDeck(stateWith([clientAtMinutes('hidden', 10, { ignored: true })]), ON_DECK_NOW);
  assert.strictEqual(od.focus, null);
  assert.strictEqual(od.todays.length, 0);
});

test('with nothing live today it falls back to the next booking on the books', () => {
  const s = stateWith([clientAtMinutes('future', 60 * 24 * 3)]);
  const od = GB.getOnDeck(s, ON_DECK_NOW);
  assert.strictEqual(od.focus, null);
  assert.strictEqual(od.next.id, 'future');
});

test('countdownLabel reads naturally either side of the start', () => {
  assert.strictEqual(GB.countdownLabel(0), 'starting now');
  assert.strictEqual(GB.countdownLabel(12), 'in 12 min');
  assert.strictEqual(GB.countdownLabel(-8), 'started 8 min ago');
  assert.strictEqual(GB.countdownLabel(90), 'in 1h 30m');
});

test('telHref normalises a 10 digit number to E.164', () => {
  assert.strictEqual(GB.telHref('213-555-0100'), 'tel:+12135550100');
  assert.strictEqual(GB.telHref(''), null);
});

test('the live nudge text never invents a link it does not have', () => {
  const withLink = GB.onDeckNudgeText({ name: 'Sarah Jones', meetLink: 'https://meet.google.com/abc' }, 'late');
  const without = GB.onDeckNudgeText({ name: 'Sarah Jones', meetLink: '' }, 'late');
  assert.ok(withLink.includes('https://meet.google.com/abc'));
  assert.ok(withLink.includes('Sarah'));
  assert.ok(!/link/i.test(without), 'no link on file should not produce a dangling link promise');
});

console.log('\n--- full render pass ---');

test('renderAll does not throw on an empty state', () => {
  GBFull._setState(GBFull.buildDefaultState());
  assert.doesNotThrow(() => GBFull.renderAll());
});

test('renderAll does not throw on a populated state', () => {
  const state = GBFull.buildDefaultState();
  for (let i = 0; i < 5; i++) {
    const c = freshClient({ id: 'pop' + i, callDateTime: isoDaysFromNow(i - 2), status: ['Booked','Confirmed','Completed','No-show','Ghosted'][i] });
    state.clients[c.id] = c;
  }
  GBFull._setState(state);
  assert.doesNotThrow(() => GBFull.renderAll());
});

console.log('\n--- T-1h reminder (hourbefore) ---');

function minsFromNow(n) { return new Date(Date.now() + n * 60000).toISOString(); }

test('call 45 min out, dayof already sent -> hourbefore due', () => {
  const now = new Date();
  const c = freshClient({
    bookedDate: isoDaysAgo(5),
    callDateTime: minsFromNow(45),
    messageLog: [
      { stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(4), responded: false, respondedAt: null },
      { stage: 'dayof', variantId: 'd1', text: 'morning', sentAt: isoDaysAgo(0), responded: false, respondedAt: null }
    ]
  });
  assert.ok(GB.computeDue(c, now).includes('hourbefore'));
});

test('call 3 hours out -> hourbefore NOT yet due', () => {
  const c = freshClient({ bookedDate: isoDaysAgo(5), callDateTime: minsFromNow(180) });
  assert.ok(!GB.computeDue(c, new Date()).includes('hourbefore'));
});

test('call 4 min out -> past the floor, hourbefore no longer due', () => {
  const c = freshClient({ bookedDate: isoDaysAgo(5), callDateTime: minsFromNow(4) });
  assert.ok(!GB.computeDue(c, new Date()).includes('hourbefore'));
});

test('call already started -> hourbefore never fires late', () => {
  const c = freshClient({ bookedDate: isoDaysAgo(5), callDateTime: minsFromNow(-30) });
  assert.ok(!GB.computeDue(c, new Date()).includes('hourbefore'));
});

test('hourbefore only fires once', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(5),
    callDateTime: minsFromNow(40),
    messageLog: [{ stage: 'hourbefore', variantId: 'h1', text: 'soon', sentAt: minsFromNow(-5), responded: false, respondedAt: null }]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('hourbefore'));
});

test('no-show client 45 min out -> cadence stopped, no hourbefore', () => {
  const c = freshClient({ status: 'No-show', bookedDate: isoDaysAgo(5), callDateTime: minsFromNow(45) });
  assert.ok(!GB.computeDue(c, new Date()).includes('hourbefore'));
});

test('every hourbefore variant promises a link and renders one', () => {
  const c = freshClient({ callDateTime: minsFromNow(45) });
  GB.buildDefaultVariants().hourbefore.forEach(v => {
    assert.ok(v.text.includes('{link}'), 'variant ' + v.id + ' should carry the meet link');
    const out = GB.renderTemplate(v.text, c, 'Johnny');
    assert.ok(!out.includes('{'), 'variant ' + v.id + ' left an unrendered placeholder: ' + out);
  });
});

test('sending hourbefore moves Booked -> Reminded', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: minsFromNow(45) });
  state.clients[c.id] = c;
  GB.markSent(state, c.id, 'hourbefore', 'anything at all');
  assert.strictEqual(state.clients[c.id].status, 'Reminded');
});

console.log('\n--- reply review (bandit denominator) ---');

test('a send does NOT count toward the bandit until reviewed', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  state.clients[c.id] = c;
  const v = GB.pickVariant(state, 'welcome', c);
  GB.markSent(state, c.id, 'welcome', GB.renderTemplate(v.text, c, state.senderName));
  assert.strictEqual(state.variantStats.welcome[v.id].sends, 0, 'unreviewed send must not enter the denominator');
  assert.strictEqual(state.clients[c.id].messageLog[0].reviewed, false);
});

test('reviewing "no reply" counts the send but no response', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  state.clients[c.id] = c;
  const v = GB.pickVariant(state, 'welcome', c);
  GB.markSent(state, c.id, 'welcome', GB.renderTemplate(v.text, c, state.senderName));
  GB.reviewMessage(state, c.id, 0, false);
  assert.strictEqual(state.variantStats.welcome[v.id].sends, 1);
  assert.strictEqual(state.variantStats.welcome[v.id].responses, 0);
});

test('reviewing "replied" counts both', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  state.clients[c.id] = c;
  const v = GB.pickVariant(state, 'welcome', c);
  GB.markSent(state, c.id, 'welcome', GB.renderTemplate(v.text, c, state.senderName));
  GB.reviewMessage(state, c.id, 0, true);
  assert.strictEqual(state.variantStats.welcome[v.id].sends, 1);
  assert.strictEqual(state.variantStats.welcome[v.id].responses, 1);
});

test('changing the answer moves responses but never double-counts the send', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  state.clients[c.id] = c;
  const v = GB.pickVariant(state, 'welcome', c);
  GB.markSent(state, c.id, 'welcome', GB.renderTemplate(v.text, c, state.senderName));
  GB.reviewMessage(state, c.id, 0, true);
  GB.reviewMessage(state, c.id, 0, false);
  GB.reviewMessage(state, c.id, 0, true);
  assert.strictEqual(state.variantStats.welcome[v.id].sends, 1, 'send counted exactly once');
  assert.strictEqual(state.variantStats.welcome[v.id].responses, 1);
});

test('hand-edited text carries no template stats but still reviews clean', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  state.clients[c.id] = c;
  GB.markSent(state, c.id, 'welcome', 'totally rewritten by hand');
  assert.strictEqual(state.clients[c.id].messageLog[0].variantId, 'custom');
  assert.doesNotThrow(() => GB.reviewMessage(state, c.id, 0, true));
  assert.strictEqual(state.clients[c.id].messageLog[0].reviewed, true);
});

test('getAwaitingReview skips fresh sends, surfaces settled ones', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  c.messageLog = [
    { stage: 'welcome', variantId: 'w1', text: 'just now', sentAt: minsFromNow(-5), responded: false, respondedAt: null, reviewed: false },
    { stage: 'monday', variantId: 'm1', text: 'yesterday', sentAt: isoDaysAgo(1), responded: false, respondedAt: null, reviewed: false },
    { stage: 'dayof', variantId: 'd1', text: 'answered', sentAt: isoDaysAgo(1), responded: true, respondedAt: isoDaysAgo(1), reviewed: true }
  ];
  state.clients[c.id] = c;
  const q = GB.getAwaitingReview(state, new Date());
  assert.strictEqual(q.length, 1, 'only the settled, unanswered one belongs in the queue');
  assert.strictEqual(q[0].message.text, 'yesterday');
});

test('getAwaitingReview ages out stale sends rather than asking about them', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ callDateTime: isoDaysFromNow(2) });
  c.messageLog = [
    { stage: 'welcome', variantId: 'w1', text: 'two days ago', sentAt: isoDaysAgo(2), responded: false, respondedAt: null, reviewed: false },
    { stage: 'monday', variantId: 'm1', text: 'ten days ago', sentAt: isoDaysAgo(10), responded: false, respondedAt: null, reviewed: false }
  ];
  state.clients[c.id] = c;
  const q = GB.getAwaitingReview(state, new Date());
  assert.strictEqual(q.length, 1, 'a ten-day-old send is past honest recall and should not be asked about');
  assert.strictEqual(q[0].message.text, 'two days ago');
});

test('getAwaitingReview ignores archived clients', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({ ignored: true });
  c.messageLog = [{ stage: 'welcome', variantId: 'w1', text: 'x', sentAt: isoDaysAgo(1), responded: false, respondedAt: null, reviewed: false }];
  state.clients[c.id] = c;
  assert.strictEqual(GB.getAwaitingReview(state, new Date()).length, 0);
});

test('legacy data: a logged reply counts as reviewed, an unanswered one does not', () => {
  const migrated = GB.sanitizeClient({
    id: 'legacy', name: 'Old Record', phone: '5125551234',
    messageLog: [
      { stage: 'welcome', variantId: 'w1', text: 'a', sentAt: isoDaysAgo(9), responded: true, respondedAt: isoDaysAgo(9) },
      { stage: 'monday', variantId: 'm1', text: 'b', sentAt: isoDaysAgo(8), responded: false, respondedAt: null }
    ]
  });
  assert.strictEqual(migrated.messageLog[0].reviewed, true, 'a reply on file is self-evidently reviewed');
  assert.strictEqual(migrated.messageLog[1].reviewed, false, 'never-answered stays unknown, not a rejection');
});

console.log('\n--- custom pipelines (industry-agnostic stages) ---');

// The point of the role model: an HVAC shop's stages share no names at all with
// the agency defaults, but drive the same cadence, rescue and recovery engine.
const HVAC_PIPELINE = [
  {key:'New Inquiry',        label:'New Inquiry',        role:'open'},
  {key:'Contacted',          label:'Contacted',          role:'open'},
  {key:'Estimate Scheduled', label:'Estimate Scheduled', role:'open'},
  {key:'Estimate Completed', label:'Estimate Completed', role:'won'},
  {key:'Missed Estimate',    label:'Missed Estimate',    role:'missed'},
  {key:'Awaiting Decision',  label:'Awaiting Decision',  role:'stalled'},
  {key:'Lost',               label:'Lost',               role:'lost'}
];
function withPipeline(stages, fn){
  GB.setPipeline(stages);
  try { fn(); } finally { GB.setPipeline(null); }   // always restore the defaults
}

test('defaults reproduce the old hard-coded behaviour exactly', () => {
  assert.strictEqual(GB.stopsCadence('Completed'), true);
  assert.strictEqual(GB.stopsCadence('No-show'), true);
  assert.strictEqual(GB.stopsCadence('Ghosted'), true);
  assert.strictEqual(GB.stopsCadence('Booked'), false);
  assert.strictEqual(GB.stopsCadence('Confirmed'), false);
  assert.strictEqual(GB.stopsCadence('Rescheduled'), false);
  // the old STOP_1TO4 map and the role model must agree on every stage
  GB.VALID_STATUSES.forEach(st => {
    assert.strictEqual(GB.stopsCadence(st), !!GB.STOP_1TO4[st], 'disagreement on ' + st);
  });
});

test('an HVAC stage named nothing like "Completed" still stops the cadence', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const c = freshClient({status:'Estimate Completed', callDateTime: isoDaysAgo(1)});
    assertDue(GB.computeDue(c, new Date()), []);
    assert.strictEqual(GB.isWon('Estimate Completed'), true);
  });
});

test('an HVAC "missed" stage drives the no-show rescue sequence', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const c = freshClient({status:'Missed Estimate', callDateTime: isoDaysAgo(2)});
    assert.ok(GB.computeDue(c, new Date()).includes('noshow'),
      'a missed appointment should trigger rescue regardless of what the stage is called');
  });
});

test('an HVAC "stalled" stage drives recovery nudges', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const c = freshClient({status:'Awaiting Decision', stalledSince: isoDaysAgo(5)});
    assert.ok(GB.computeDue(c, new Date()).includes('recovery'));
  });
});

test('an open stage still runs the normal cadence under a custom pipeline', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const c = freshClient({status:'New Inquiry', callDateTime: isoDaysFromNow(3), bookedDate: isoDaysAgo(1)});
    assert.ok(GB.computeDue(c, new Date()).includes('welcome'));
  });
});

test('a stage an admin deleted reads as open, so contacts never fall out of the system', () => {
  withPipeline(HVAC_PIPELINE, () => {
    assert.strictEqual(GB.stageRole('Some Stage That Was Removed'), 'open');
    const c = freshClient({status:'Some Stage That Was Removed', callDateTime: isoDaysFromNow(3), bookedDate: isoDaysAgo(1)});
    assert.ok(GB.computeDue(c, new Date()).length > 0, 'an orphaned contact must keep getting followed up');
  });
});

test('statusLabel ghosts by meaning, not by the word "Ghosted"', () => {
  withPipeline(HVAC_PIPELINE, () => {
    assert.ok(GB.statusLabel('Lost').startsWith('👻'));
    assert.ok(GB.statusLabel('Missed Estimate').startsWith('👻'));
    assert.ok(!GB.statusLabel('New Inquiry').startsWith('👻'));
  });
});

test('setPipeline(null) and an empty list both fall back to the defaults', () => {
  GB.setPipeline([]);
  assert.strictEqual(GB.getPipeline().length, GB.buildDefaultPipeline().length);
  GB.setPipeline(null);
  assert.strictEqual(GB.stopsCadence('Completed'), true);
});

console.log('\n--- ghost score ---');

test('the reasons ARE the arithmetic: they sum to the score', () => {
  const c = freshClient({
    callDateTime: isoDaysFromNow(1), bookedDate: isoDaysAgo(20), status: 'Confirmed',
    messageLog: [{stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(9),responded:true,respondedAt:isoDaysAgo(9),reviewed:true}]
  });
  const g = GB.computeGhostScore(c, new Date());
  const summed = g.reasons.reduce((a, r) => a + r.points, 0);
  assert.strictEqual(summed, g.raw, 'an explanation that does not add up is not an explanation');
  assert.strictEqual(g.score, Math.min(100, Math.max(0, g.raw)));
});

test('score is always within 0-100 however the rules stack', () => {
  const hot = freshClient({
    callDateTime: isoDaysFromNow(1), bookedDate: isoDaysAgo(60), status: 'Booked',
    messageLog: [{stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(40),responded:true,respondedAt:isoDaysAgo(40),reviewed:true}]
  });
  const cold = freshClient({status:'Ghosted', bookedDate: isoDaysAgo(400), closeOutcome:'Lost', stalledSince: isoDaysAgo(300)});
  [hot, cold].forEach(c => {
    const g = GB.computeGhostScore(c, new Date());
    assert.ok(g.score >= 0 && g.score <= 100, 'out of range: ' + g.score);
  });
});

test('bands map to the documented thresholds', () => {
  assert.strictEqual(GB.ghostScoreBand(95), 'immediate');
  assert.strictEqual(GB.ghostScoreBand(91), 'immediate');
  assert.strictEqual(GB.ghostScoreBand(90), 'high');
  assert.strictEqual(GB.ghostScoreBand(76), 'high');
  assert.strictEqual(GB.ghostScoreBand(75), 'soon');
  assert.strictEqual(GB.ghostScoreBand(51), 'soon');
  assert.strictEqual(GB.ghostScoreBand(50), 'nurture');
  assert.strictEqual(GB.ghostScoreBand(26), 'nurture');
  assert.strictEqual(GB.ghostScoreBand(25), 'low');
});

test('an imminent appointment with a history of replying and a month of silence ranks top', () => {
  const c = freshClient({
    callDateTime: isoDaysFromNow(1), bookedDate: isoDaysAgo(40), status: 'Confirmed',
    messageLog: [{stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(34),responded:true,respondedAt:isoDaysAgo(34),reviewed:true}]
  });
  const g = GB.computeGhostScore(c, new Date());
  assert.ok(g.score >= 76, 'expected high or immediate, got ' + g.score + ' (' + g.band + ')');
});

test('a logged outcome drops a contact off the list', () => {
  const base = {callDateTime: isoDaysAgo(3), bookedDate: isoDaysAgo(20), status:'Completed'};
  const open = GB.computeGhostScore(freshClient(base), new Date());
  const closed = GB.computeGhostScore(freshClient(Object.assign({}, base, {closeOutcome:'Closed'})), new Date());
  assert.ok(closed.score < open.score, 'recording an outcome must reduce urgency, not raise it');
});

test('unreviewed sends are not counted as unanswered attempts', () => {
  const mk = (reviewed) => freshClient({
    status:'Booked', bookedDate: isoDaysAgo(20), callDateTime: null,
    messageLog: [1,2,3,4,5].map(i => ({stage:'monday',variantId:'m1',text:'x',
      sentAt: isoDaysAgo(i), responded:false, respondedAt:null, reviewed}))
  });
  const known = GB.computeGhostScore(mk(true), new Date());
  const unknown = GB.computeGhostScore(mk(false), new Date());
  const pen = g => g.reasons.filter(r => /unanswered/.test(r.label)).length;
  assert.strictEqual(pen(known), 1, 'five confirmed-silent sends should carry a penalty');
  assert.strictEqual(pen(unknown), 0, 'sends nobody checked are not evidence of silence');
});

test('ranking excludes archived contacts and sorts hottest first', () => {
  const s = GB.buildDefaultState();
  s.clients['a'] = freshClient({id:'a', name:'Hot', status:'Confirmed', callDateTime: isoDaysFromNow(1),
    bookedDate: isoDaysAgo(40),
    messageLog:[{stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(34),responded:true,respondedAt:isoDaysAgo(34),reviewed:true}]});
  s.clients['b'] = freshClient({id:'b', name:'Mild', status:'Booked', bookedDate: isoDaysAgo(5), callDateTime:null});
  s.clients['c'] = freshClient({id:'c', name:'Archived', status:'Confirmed', ignored:true, callDateTime: isoDaysFromNow(1), bookedDate: isoDaysAgo(40)});
  const ranked = GB.rankByGhostScore(s, new Date(), {min:0});
  assert.ok(!ranked.some(r => r.client.id === 'c'), 'archived contacts must not appear');
  assert.strictEqual(ranked[0].client.id, 'a');
  assert.ok(ranked[0].score >= ranked[ranked.length-1].score);
});

test('scoring reads stage roles, so a custom pipeline scores correctly', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const c = freshClient({status:'Missed Estimate', callDateTime: isoDaysAgo(2), bookedDate: isoDaysAgo(20)});
    const g = GB.computeGhostScore(c, new Date());
    assert.ok(g.reasons.some(r => /Missed appointment/.test(r.label)),
      'an HVAC missed-estimate must score like a no-show, got: ' + g.reasons.map(r=>r.label).join(' | '));
  });
});

console.log('\n--- one interaction lifecycle ---');

const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
const msg = (over) => Object.assign({stage:'welcome', variantId:'w1', text:'x',
  sentAt: hoursAgo(48), responded:false, respondedAt:null, reviewed:false}, over || {});

test('a fresh send is waiting, not a question', () => {
  assert.strictEqual(GB.messageState(msg({sentAt: hoursAgo(2)}), new Date()), 'waiting');
  assert.strictEqual(GB.messageState(msg({sentAt: hoursAgo(23)}), new Date()), 'waiting');
});

test('past the reply window it becomes a question', () => {
  assert.strictEqual(GB.messageState(msg({sentAt: hoursAgo(25)}), new Date()), 'needs_outcome');
});

test('an answered message is settled either way', () => {
  assert.strictEqual(GB.messageState(msg({reviewed:true, responded:true}), new Date()), 'replied');
  assert.strictEqual(GB.messageState(msg({reviewed:true, responded:false}), new Date()), 'no_reply');
});

test('the review queue no longer asks about anything inside the wait window', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({messageLog:[msg({sentAt: hoursAgo(3)})]});
  st.clients[c.id] = c;
  assert.strictEqual(GB.getAwaitingReview(st, new Date()).length, 0,
    'asking 3 hours after a send is asking a question nobody can answer');
});

test('"No reply" resolves the interaction and feeds the bandit', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({callDateTime: isoDaysFromNow(3)});
  st.clients[c.id] = c;
  const v = GB.pickVariant(st, 'welcome', c);
  GB.markSent(st, c.id, 'welcome', GB.renderTemplate(v.text, c, st.senderName));
  c.messageLog[0].sentAt = hoursAgo(48);
  GB.recordInteractionOutcome(st, c.id, 'no_reply', {});
  assert.strictEqual(c.messageLog[0].reviewed, true);
  assert.strictEqual(c.messageLog[0].responded, false);
  assert.strictEqual(st.variantStats.welcome[v.id].sends, 1, 'the send must still reach the bandit');
  assert.strictEqual(st.variantStats.welcome[v.id].responses, 0);
});

test('"They replied" credits the variant and stores the note', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({callDateTime: isoDaysFromNow(3)});
  st.clients[c.id] = c;
  const v = GB.pickVariant(st, 'welcome', c);
  GB.markSent(st, c.id, 'welcome', GB.renderTemplate(v.text, c, st.senderName));
  GB.recordInteractionOutcome(st, c.id, 'replied', {note:'said call me Friday'});
  assert.strictEqual(st.variantStats.welcome[v.id].responses, 1);
  assert.ok(/call me Friday/.test(c.notes));
});

test('"Booked" sets the appointment and returns the contact to an open stage', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({status:'Ghosted', stalledSince: isoDaysAgo(9)});
  st.clients[c.id] = c;
  GB.markSent(st, c.id, 'recovery', 'anything');
  const when = isoDaysFromNow(4);
  GB.recordInteractionOutcome(st, c.id, 'booked', {callDateTime: when});
  assert.strictEqual(c.callDateTime, when);
  assert.strictEqual(GB.isOpenStage(c.status), true, 'a booking must reopen the cadence, got ' + c.status);
  assert.strictEqual(c.stalledSince, null);
});

test('"Not interested" moves the contact to a lost stage', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({status:'Booked'});
  st.clients[c.id] = c;
  GB.markSent(st, c.id, 'welcome', 'anything');
  GB.recordInteractionOutcome(st, c.id, 'not_interested', {note:'too expensive'});
  assert.strictEqual(GB.stageRole(c.status), 'lost');
  assert.ok(/too expensive/.test(c.notes));
});

test('"Wrong contact" archives without pretending they replied', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({});
  st.clients[c.id] = c;
  GB.markSent(st, c.id, 'welcome', 'anything');
  GB.recordInteractionOutcome(st, c.id, 'wrong_contact', {});
  assert.strictEqual(c.ignored, true);
  assert.strictEqual(c.messageLog[0].responded, false, 'a wrong number is not a reply');
});

test('outcomes work under a custom pipeline', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const st = GB.buildDefaultState();
    const c = freshClient({status:'New Inquiry'});
    st.clients[c.id] = c;
    GB.markSent(st, c.id, 'welcome', 'anything');
    GB.recordInteractionOutcome(st, c.id, 'not_interested', {});
    assert.strictEqual(c.status, 'Lost', 'should land on the HVAC pipeline’s lost stage');
  });
});

test('every outcome writes an event carrying the analytics context', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({callDateTime: isoDaysFromNow(3)});
  st.clients[c.id] = c;
  GB.markSent(st, c.id, 'welcome', 'anything custom');
  st.pendingEvents = [];
  GB.recordInteractionOutcome(st, c.id, 'replied', {});
  const ev = st.pendingEvents.find(e => e.kind === 'interaction.outcome');
  assert.ok(ev, 'expected an interaction.outcome event');
  ['outcome','replied','stage','variantId','pipelineStage','hoursToResponse'].forEach(k => {
    assert.ok(k in ev.data, 'event must carry ' + k + ' for later analytics');
  });
});

test('the analytics that read reply data still work after an outcome', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({callDateTime: isoDaysAgo(1), status:'Completed'});
  st.clients[c.id] = c;
  GB.markSent(st, c.id, 'welcome', 'anything');
  GB.recordInteractionOutcome(st, c.id, 'replied', {});
  assert.doesNotThrow(() => GB.computeStats(st, 'all', new Date()));
  assert.doesNotThrow(() => GB.computeInsights(st, new Date()));
  assert.doesNotThrow(() => GB.computeRescueScorecard(st, new Date()));
  assert.doesNotThrow(() => GB.buildWeeklyDigest(st, new Date()));
  const g = GB.computeGhostScore(c, new Date());
  assert.ok(g.reasons.some(r => /replied before/.test(r.label)), 'Ghost Score must still see the reply');
});

// A call to a function that does not exist parses fine and only fails when that
// line runs — which for a settings modal means the first person to hit Save.
// Found exactly that: three calls to toast() when the helper is showToast().
{
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const logicSrcH = fs.readFileSync(path.join(__dirname, 'hosted', 'logic.js'), 'utf8');
  const appSrcH   = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const dataSrcH  = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const all = strip(logicSrcH + '\n' + appSrcH + '\n' + dataSrcH);
  const defined = new Set([
    ...[...all.matchAll(/function\s+([A-Za-z_$]\w*)/g)].map(m => m[1]),
    ...[...all.matchAll(/(?:var|let|const)\s+([A-Za-z_$]\w*)\s*=\s*(?:function|\()/g)].map(m => m[1])
  ]);
  const KEYWORDS = new Set(['if','for','while','switch','catch','return','typeof','new','await',
    'else','do','try','throw','delete','void','in','of','function','var','let','const']);
  const BROWSER = new Set(['Number','String','Boolean','Array','Object','Date','Math','JSON','parseInt',
    'parseFloat','isNaN','isFinite','setTimeout','setInterval','clearTimeout','clearInterval','fetch',
    'encodeURIComponent','decodeURIComponent','alert','confirm','prompt','require','Promise','RegExp',
    'Error','Set','Map','btoa','atob','getComputedStyle','structuredClone','Intl','escape','unescape',
    'URLSearchParams','FileReader','Blob',
    'Chart']);   // Chart.js, loaded from a CDN in index.html
  const called = [...strip(appSrcH).matchAll(/(?<![.\w$])([A-Za-z_$]\w{2,})\s*\(/g)].map(m => m[1]);
  const missing = [...new Set(called)].filter(n => !defined.has(n) && !KEYWORDS.has(n) && !BROWSER.has(n));
  assert.deepStrictEqual(missing, [], 'app.js calls function(s) that are never defined: ' + missing.join(', '));
  console.log('  ok  - every function hosted/app.js calls is actually defined');
}

// A stage that logic.js can produce but the database rejects makes every save
// fail, not just that row — the whole batch is refused. 'revival' shipped that
// way and broke saving outright until the constraint was widened. The three
// tables carrying the same list are the reason this is easy to miss.
{
  const migrations = fs.readdirSync(path.join(__dirname, 'supabase', 'migrations'))
    .filter(f => f.endsWith('.sql')).sort();
  let allowed = null;
  migrations.forEach(f => {
    const sql = fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', f), 'utf8');
    const matches = [...sql.matchAll(/check\s*\(stage in \(([^)]+)\)\)/g)];
    matches.forEach(m => {
      allowed = new Set(m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')));
    });
  });
  assert.ok(allowed, 'could not find a stage constraint in any migration');
  const produced = new Set(Object.keys(GB.buildDefaultVariants())
    .concat(Object.keys(GB.buildDefaultEmailVariants()))
    .concat(GB.buildDefaultSequence().map(s => s.stage)));
  const rejected = [...produced].filter(st => !allowed.has(st));
  assert.deepStrictEqual(rejected, [],
    'logic.js can produce stage(s) the database will reject, which fails the entire save: ' + rejected.join(', '));
  console.log('  ok  - every stage the app can produce is accepted by the database');
}

/* The same guard, for stages the UI hard-codes.

   The check above derives stages from logic.js. It would not have caught the
   email library, which logs its sends with a literal 'email' written in
   app.js — a stage no sequence and no variant set mentions. That literal was
   one deploy away from reproducing the 'revival' outage exactly: a rejected
   insert fails the whole batched save, and the user's only symptom is that
   nothing saves any more.

   So: read the literals out of the hosted source and hold them to the same
   constraint. Crude, and it is meant to be — it needs to notice a string
   somebody typed, which is precisely what a derived list cannot do. */
{
  const migrations = fs.readdirSync(path.join(__dirname, 'supabase', 'migrations'))
    .filter(f => f.endsWith('.sql')).sort();
  let allowed = null;
  migrations.forEach(f => {
    const sql = fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', f), 'utf8');
    const matches = [...sql.matchAll(/check\s*\(stage in \(([^)]+)\)\)/g)];
    matches.forEach(m => {
      allowed = new Set(m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')));
    });
  });

  const appjs = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  // markSentOnChannel(cid, '<stage>', ...) and markSent(STATE, cid, '<stage>', ...)
  const literals = new Set();
  for (const m of appjs.matchAll(/markSent(?:OnChannel)?\(\s*(?:STATE\s*,\s*)?[A-Za-z0-9_.]+\s*,\s*'([a-z]+)'/g)) {
    literals.add(m[1]);
  }
  assert.ok(literals.size, 'expected to find at least one hard-coded stage in app.js — has the call shape changed?');
  const bad = [...literals].filter(st => !allowed.has(st));
  assert.deepStrictEqual(bad, [],
    'app.js logs a message with stage(s) the database will reject, which fails the entire save: ' + bad.join(', '));
  console.log('  ok  - every stage hard-coded in the app is accepted too (' + [...literals].sort().join(', ') + ')');
}

console.log('\n--- sending through the salesperson’s own Gmail ---');

test('the link carries the recipient, subject and body', () => {
  const u = GB.gmailComposeUrl('dana@example.com', 'Confirmed for Oct 2',
    'Hi Dana,\n\nSee you then.\n\nJohnny', 'john@marketmakermgmt.com');
  assert.ok(u.startsWith('https://mail.google.com/mail/'));
  assert.ok(u.includes('to=dana%40example.com'));
  assert.ok(u.includes('su=Confirmed%20for%20Oct%202'));
  assert.ok(u.includes('body=Hi%20Dana'));
  assert.ok(u.includes('view=cm'), 'without this Gmail opens the inbox, not a compose window');
});

test('it pins the sending account, so a client email cannot go from a personal one', () => {
  const u = GB.gmailComposeUrl('a@b.com', 's', 'b', 'john@marketmakermgmt.com');
  assert.ok(u.includes('authuser=john%40marketmakermgmt.com'));
});

test('with no account configured it lets Gmail decide', () => {
  // A bad authuser value drops people on an account chooser, which is worse
  // than letting Gmail use its default.
  const u = GB.gmailComposeUrl('a@b.com', 's', 'b', null);
  assert.ok(!u.includes('authuser='));
});

test('the sending account comes from the business calendar, not the personal one', () => {
  // Nobody is asked to type this. The mailbox the bookings arrive in IS the
  // work account, so the connected calendar answers the question for free.
  assert.strictEqual(
    GB.businessEmailAccount({ myCalendars: ['john@marketmakermgmt.com'] }),
    'john@marketmakermgmt.com');
});

test('an explicit setting beats the calendar', () => {
  // Some people book on one address and send from another.
  assert.strictEqual(GB.businessEmailAccount({
    emailFromAddress: 'hello@marketmakermgmt.com',
    myCalendars: ['john@marketmakermgmt.com'],
  }), 'hello@marketmakermgmt.com');
});

test('a shared calendar id is not a mailbox and is skipped', () => {
  // Handing Gmail one of these as authuser lands on an account chooser.
  assert.strictEqual(GB.businessEmailAccount({
    myCalendars: ['abc123def@group.calendar.google.com', 'john@marketmakermgmt.com'],
  }), 'john@marketmakermgmt.com');
});

test('with nothing connected it says so rather than guessing', () => {
  assert.strictEqual(GB.businessEmailAccount({ myCalendars: [] }), null);
  assert.strictEqual(GB.businessEmailAccount({ myCalendars: ['holidays'] }), null);
  assert.strictEqual(GB.businessEmailAccount({ emailFromAddress: '   ' }), null);
  assert.strictEqual(GB.businessEmailAccount(null), null);
});

test('the Email button opens the business account, end to end', () => {
  // The two pieces together: what the app actually does per contact.
  const state = { myCalendars: ['john@marketmakermgmt.com'] };
  const u = GB.gmailComposeUrl('dana@example.com', 's', 'b', GB.businessEmailAccount(state));
  assert.ok(u.includes('authuser=john%40marketmakermgmt.com'),
    'a client email must not be able to leave from a personal Gmail');
});

test('a body with newlines and symbols survives the round trip', () => {
  const body = 'Hi Dana,\n\nHere is the link: https://meet.google.com/a-b-c?x=1&y=2\n\nJohnny';
  const u = GB.gmailComposeUrl('a@b.com', 'Subject & more', body, null);
  const parsed = new URL(u);
  assert.strictEqual(parsed.searchParams.get('body'), body, 'the email must arrive as written');
  assert.strictEqual(parsed.searchParams.get('su'), 'Subject & more');
});

test('the examples came from the business, not from invention', () => {
  // Written fresh they read like software, which is the one thing nobody
  // answers. These carry the phrasing from their own sales document.
  const e = GB.buildDefaultEmailVariants();
  assert.ok(/meeting link for our call/i.test(e.dayof[0].text),
    'the day-of email should use their own reminder phrasing');
  assert.ok(/not just for views/i.test(e.welcome[0].text),
    'the welcome should carry their own positioning line');
});

/* Strip comments so a guard can look at code that actually runs.

   A line-based filter is not good enough: a block comment's continuation
   lines start with ordinary words, so an explanation OF a hard-coded value
   reads as the value itself. Both guards below first failed on their own
   comments describing the bug they prevent. */
function codeOnly(src){
  let out = '', i = 0, n = src.length;
  while(i < n){
    const two = src.slice(i, i + 2);
    if(two === '/*'){
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
    } else if(two === '//'){
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
    } else {
      out += src[i]; i++;
    }
  }
  return out;
}

console.log('\n--- drafting from the notes of a call that just happened ---');

{
  const client = GB.sanitizeClient({id: 'c', name: 'Dana Reed', phone: '2135550100'});
  const notes = 'Posting monthly, wants weekly. Budget ~800. Decides Friday.';

  test('the notes are the source, and the model is told not to go beyond them', () => {
    /* Notes are shorthand. A model filling gaps in shorthand produces
       confident sentences about things that were never said — which the
       customer then reads and corrects, or worse, believes. */
    const p = GB.buildNotesPrompt({client, notes, channel: 'email', senderName: 'Johnny'});
    assert.ok(p.includes(notes), 'the notes must actually be in the prompt');
    assert.ok(/do not invent/i.test(p), 'the model must be told not to invent');
    assert.ok(/shorter message rather than filling the gap/i.test(p),
      'and told what to do instead when the notes are thin');
  });

  test('it writes in the business own voice, not in software voice', () => {
    const p = GB.buildNotesPrompt({client, notes, channel: 'email', senderName: 'Johnny',
      examples: ['Hey {name}, great connecting today. Here is what I think we can build.']});
    assert.ok(p.includes('great connecting today'), 'examples must reach the prompt');
  });

  test('a text and an email are asked for differently', () => {
    const sms = GB.buildNotesPrompt({client, notes, channel: 'sms', senderName: 'Johnny'});
    const email = GB.buildNotesPrompt({client, notes, channel: 'email', senderName: 'Johnny'});
    assert.ok(/lock screen/i.test(sms), 'a text should be asked to be short');
    assert.ok(/no subject line/i.test(sms), 'and to skip the subject');
    assert.ok(/Subject: /.test(email), 'an email should be asked for a subject line');
  });

  test('a drafted email splits into subject and body', () => {
    const d = GB.splitDraftedEmail('Subject: Great talking today\n\nHi Dana,\n\nHere is the plan.');
    assert.strictEqual(d.subject, 'Great talking today');
    assert.ok(d.text.startsWith('Hi Dana,'));
  });

  test('a draft with no subject line becomes all body, never a paragraph in the subject', () => {
    // A paragraph in the subject field is a far more visible failure than a
    // missing subject, so the first line is never silently promoted.
    const d = GB.splitDraftedEmail('Hi Dana,\n\nGreat talking today about the weekly cadence.');
    assert.strictEqual(d.subject, '');
    assert.ok(d.text.startsWith('Hi Dana,'));
  });

  test('empty notes produce a prompt rather than throwing', () => {
    const p = GB.buildNotesPrompt({client, notes: '', channel: 'email'});
    assert.ok(typeof p === 'string' && p.length > 0);
    assert.strictEqual(GB.splitDraftedEmail('').text, '');
    assert.strictEqual(GB.splitDraftedEmail(null).text, '');
  });

  test('a draft sent from the panel is still logged as contact', () => {
    /* 'notes-draft' is not a library document id, so renderEmailDoc returns
       null for it. Left alone, the send would never be recorded — and an
       unlogged email is one the automated side does not know about, so a text
       could go out on top of it the same afternoon. */
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const block = app.slice(app.indexOf("case 'sent-by-email'"), app.indexOf("case 'pick-email'"));
    assert.ok(/notes-draft/.test(block),
      'the sent-by-email handler does not recognise a notes draft, so it would not log it');
    assert.ok(/NOTES_PANEL\.draft/.test(block),
      'and it should take the text from the panel, which already has it rendered');
  });

  test('the panel renders, empty and with a draft', () => {
    const ctx = makeHostedCtx();
    vm.runInContext(`
      STATE = buildDefaultState();
      STATE.senderName = 'Johnny';
      STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Dana Reed', phone:'2135550100',
        email:'dana@example.com', timezone:'America/New_York', status:'Booked',
        callDateTime: new Date(Date.now() - 3600000).toISOString()});
    `, ctx);
    assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx),
      'the panel must render before anything is chosen');

    vm.runInContext(`
      NOTES_PANEL.cid = 'c1';
      NOTES_PANEL.notes = 'Wants weekly. Budget 800.';
      NOTES_PANEL.draft = {channel:'email', subject:'Great talking', text:'Hi Dana,'};
    `, ctx);
    assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx),
      'and with a draft on screen');

    // A contact with no email address must not be offered an Open in Gmail
    // button that cannot work.
    vm.runInContext("STATE.clients['c1'].email = '';", ctx);
    assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx));
  });
}

console.log('\n--- a message with no appointment on it still reads like English ---');

{
  const mk = (over) => GB.sanitizeClient(Object.assign({
    id: 'c', name: 'Dana Reed', phone: '2135550100', timezone: 'America/New_York'
  }, over));
  const noDate = mk({});
  const soonCall = mk({callDateTime: new Date(Date.now() + 3 * 86400000).toISOString(),
                       meetLink: 'https://meet.google.com/a-b-c'});
  const farCall = mk({callDateTime: new Date(Date.now() + 30 * 86400000).toISOString()});

  test('an empty placeholder takes its preposition with it', () => {
    /* "Looking forward to our call on {weekday}." used to go out as
       "...our call on ." to a real client, because the placeholder emptied
       and the word leading up to it stayed. This happens whenever something
       is sent before a time is booked, which is normal. */
    assert.strictEqual(
      GB.renderTemplate('Looking forward to our call on {weekday}.', noDate, 'Bob'),
      'Looking forward to our call.');
    assert.strictEqual(
      GB.renderTemplate('Hey {name}, see you at {time}.', noDate, 'Bob'),
      'Hey Dana, see you.');
    assert.strictEqual(
      GB.renderTemplate("You're locked in for {date} at {time}.", noDate, 'Bob'),
      "You're locked in.");
  });

  test('a word that merely ENDS in a preposition is not amputated', () => {
    /* Found in a real send. "Excited to chat {date}" went out as "Excited to
       ch" because the cleanup matched the "at" inside "ch|at" -- no word
       boundary. Every word ending in at, on, for, in or by was exposed:
       "great format {date}" became "great form."

       A word boundary is the difference between removing a preposition and
       amputating the end of a word, and the failure is invisible in the
       template and only visible in the inbox. */
    const cases = [
      ['Excited to chat {date} - a few examples inside', 'Excited to chat - a few examples inside'],
      ['We can chat {weekday}.', 'We can chat.'],
      ['That is a great format {date}.', 'That is a great format.'],
      ['Your platform {date} is ready.', 'Your platform is ready.'],
      ['A carton {date}.', 'A carton.'],
    ];
    cases.forEach(([tpl, want]) => {
      assert.strictEqual(GB.renderTemplate(tpl, noDate, 'Bob'), want);
    });
  });

  test('a preposition that belongs to the sentence is left alone', () => {
    /* The reason this is done at substitution time rather than on the
       finished string: afterwards "hopping on at ." and "locked in for ."
       look identical — a preposition before a full stop — but "hopping on."
       is correct and "locked in for." is not. An earlier attempt stripped
       them afterwards and turned "You're locked in for Oct 4" into
       "You're locked." */
    assert.strictEqual(
      GB.renderTemplate('Hey {name}, hopping on at {time}. Link below.', noDate, 'Bob'),
      'Hey Dana, hopping on. Link below.');
    assert.strictEqual(
      GB.renderTemplate("You're locked in for {date}.", noDate, 'Bob'),
      "You're locked in.");
  });

  test('nothing changes when there IS an appointment', () => {
    const out = GB.renderTemplate("You're locked in for {date} at {time}.", soonCall, 'Bob');
    assert.ok(/locked in for \w/.test(out), out);
    assert.ok(/ at \d/.test(out), out);
    assert.ok(!/ {2}/.test(out));
  });

  test('{when} carries its own preposition and says "soon" when nothing is booked', () => {
    // The opt-in placeholder, for copy that has to read either way.
    assert.strictEqual(
      GB.renderTemplate('Looking forward to our call {when}.', noDate, 'Bob'),
      'Looking forward to our call soon.');
    const near = GB.renderTemplate('Looking forward to our call {when}.', soonCall, 'Bob');
    assert.ok(/call on \w+day\.$/.test(near), 'a day name inside the week: ' + near);
    const far = GB.renderTemplate('Looking forward to our call {when}.', farCall, 'Bob');
    assert.ok(/call on \w+ \d+\.$/.test(far), 'a date beyond it: ' + far);
  });

  test('{date} never invents an appointment that does not exist', () => {
    /* A welcome touch fires for a contact with NO call date — a manually
       added lead. Substituting "soon" there would turn "You're locked in for
       {date}" into "You're locked in soon", telling someone they have an
       appointment they never booked. Saying nothing is recoverable; asserting
       a booking is not. */
    const out = GB.renderTemplate('Call is {date} at {time}, {weekday}.', noDate, 'Bob');
    assert.ok(!/soon/.test(out), 'only {when} may say soon: ' + out);
    const lead = GB.sanitizeClient({id: 'x', name: 'Pat', phone: '2135550100',
      status: 'Booked', bookedDate: new Date(Date.now() - 86400000).toISOString()});
    assert.ok(GB.computeDue(lead, new Date()).includes('welcome'),
      'sanity: a dateless contact really does come due a welcome');
  });

  test('{recap} carries what was actually said on the call', () => {
    /* The post-call recap email was a generic list of what the service
       includes. An email that says "here is what we discussed" and then
       describes nothing in particular is worse than not sending one.

       The Call recap field has existed on every contact all along and the AI
       drafting already used it; templates could not reach it. */
    const withRecap = mk({recap: 'Posting monthly, wants weekly. Budget ~800.'});
    const out = GB.renderTemplate('We covered:\n\n{recap}', withRecap, 'Bob');
    assert.ok(out.includes('Posting monthly, wants weekly'), out);
  });

  test('an empty recap shows a marker, not a gap', () => {
    // Same reasoning as {link}: these open in Gmail and are read before they
    // are sent, so an obvious gap gets filled and an empty space gets missed.
    const out = GB.renderTemplate('We covered:\n\n{recap}', noDate, 'Bob');
    assert.ok(/paste your call notes/i.test(out), out);
    assert.ok(!/\{recap\}/.test(out), 'the placeholder itself must never ship');
  });

  test('every built-in renders cleanly with no appointment at all', () => {
    const v = GB.buildDefaultVariants();
    const broken = [];
    Object.keys(v).forEach(stage => v[stage].forEach(x => {
      const out = GB.renderTemplate(x.text, noDate, 'Bob');
      if (/ {2}/.test(out) || /\s[.,]/.test(out) || /\b(at|for)\s*[.,]/.test(out)) {
        broken.push(stage + '/' + x.id + ': ' + out);
      }
    }));
    assert.deepStrictEqual(broken, [], 'reads badly without an appointment:\n' + broken.join('\n'));
  });
}

console.log('\n--- one text a day, and an email does not use it up ---');

{
  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const sms = (stage, when) => ({id: 'm' + stage, stage, variantId: 'v', text: 'x',
    sentAt: when || new Date().toISOString(), responded: false, respondedAt: null,
    reviewed: false, channel: 'sms'});
  const email = () => ({id: 'me', stage: 'email', variantId: 'lib', text: 'x',
    sentAt: new Date().toISOString(), responded: false, respondedAt: null,
    reviewed: false, channel: 'email'});
  const mk = (log, call) => GB.sanitizeClient({
    id: 'c', name: 'Caitlin', phone: '2135550100', email: 'c@e.com',
    timezone: 'America/New_York', status: 'Booked', bookedDate: ago(24 * 10),
    callDateTime: call || new Date(Date.now() + 4 * 86400000).toISOString(),
    messageLog: log || []});
  const queued = (c) => GB.getTextTodayList({clients: {c}, variants: GB.buildDefaultVariants(),
    variantStats: {}, todos: [], myCalendars: []}, new Date(), '').map(i => i.stage);

  test('sending one text does not immediately queue the next one', () => {
    /* pickTodaysTouch shows a single row per person when several touches come
       due together, but nothing stopped the NEXT one appearing the moment the
       first was sent. Sending Caitlin her welcome put her straight back in the
       list with a midpoint text, so anyone working the queue top to bottom
       texted the same person twice in an afternoon. */
    assert.deepStrictEqual(queued(mk()), ['welcome']);
    assert.deepStrictEqual(queued(mk([sms('welcome')])), [],
      'a second text the same day is the thing being prevented');
  });

  test('an email does not use up the day allowance', () => {
    // Different channel, lands somewhere else, and sending the pre-call email
    // and then the text is a normal follow-up rather than a pile-on.
    assert.deepStrictEqual(queued(mk([email()])), ['welcome']);
  });

  test('the day-of link still goes out even if a text already went this morning', () => {
    // Missing a meeting link to avoid a second message is a far worse trade.
    const todayCall = new Date(new Date().setHours(23, 0, 0, 0)).toISOString();
    assert.deepStrictEqual(queued(mk([sms('welcome')], todayCall)), ['dayof']);
  });

  test('yesterday does not block today', () => {
    assert.ok(queued(mk([sms('welcome', ago(26))])).length,
      'the allowance is per day, not a rolling window');
  });

  test('it is their day that counts, not ours', () => {
    /* "Today" for someone in Hawaii is not today here, and the whole point is
       how many messages THEY received. */
    const hawaii = GB.sanitizeClient({id: 'h', name: 'Keanu', phone: '8085550100',
      timezone: 'Pacific/Honolulu', status: 'Booked', bookedDate: ago(24 * 10),
      callDateTime: new Date(Date.now() + 4 * 86400000).toISOString(),
      messageLog: [sms('welcome')]});
    assert.strictEqual(typeof GB.sentCadenceTouchToday(hawaii, new Date()), 'boolean');
  });
}

console.log('\n--- the morning list reads in an order ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const soon = (d) => new Date(Date.now() + d * 86400000).toISOString();
  let ph = 3000;
  const mk = (name, over) => GB.sanitizeClient(Object.assign({
    id: name, name: name, phone: '21355' + (++ph), timezone: 'America/New_York',
    status: 'Booked', bookedDate: ago(30)
  }, over));

  test('welcomes come first and the cold chasing comes last', () => {
    // Johnny's ask, directly: a first hello should open the list, and a
    // recovery nudge should not be sitting between two day-of reminders.
    const items = [
      {stage: 'recovery',   client: mk('cold')},
      {stage: 'dayof',      client: mk('today')},
      {stage: 'welcome',    client: mk('new')},
      {stage: 'noshow',     client: mk('missed')},
      {stage: 'midcheckin', client: mk('mid')},
    ];
    items.sort(GB.byTouchOrder);
    assert.strictEqual(items[0].stage, 'welcome');
    assert.strictEqual(items[items.length - 1].stage, 'recovery');
  });

  test('revival sits after recovery — it is the coldest thing in the list', () => {
    const items = [{stage: 'revival', client: mk('ancient')}, {stage: 'recovery', client: mk('cold')}];
    items.sort(GB.byTouchOrder);
    assert.deepStrictEqual(items.map(i => i.stage), ['recovery', 'revival']);
  });

  test('the reminders read in the order the cadence walks toward the call', () => {
    const items = [
      {stage: 'hourbefore', client: mk('h')},
      {stage: 'monday',     client: mk('m')},
      {stage: 'dayof',      client: mk('d')},
      {stage: 'midcheckin', client: mk('c')},
    ];
    items.sort(GB.byTouchOrder);
    assert.deepStrictEqual(items.map(i => i.stage),
      ['monday', 'midcheckin', 'dayof', 'hourbefore']);
  });

  test('inside a group, the soonest call comes first', () => {
    // So the day-of block reads in the order the calls actually happen.
    const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    const items = [
      {stage: 'dayof', client: mk('four',  {callDateTime: at(16)})},
      {stage: 'dayof', client: mk('nine',  {callDateTime: at(9)})},
      {stage: 'dayof', client: mk('noon',  {callDateTime: at(12)})},
    ];
    items.sort(GB.byTouchOrder);
    assert.deepStrictEqual(items.map(i => i.client.name), ['nine', 'noon', 'four']);
  });

  test('a stage from a custom sequence still lands somewhere sensible', () => {
    // Not dumped at the top above the welcomes, and not below the cold
    // chasing where it would never be seen.
    const items = [
      {stage: 'recovery',     client: mk('cold')},
      {stage: 'second_visit', client: mk('custom')},
      {stage: 'welcome',      client: mk('new')},
    ];
    items.sort(GB.byTouchOrder);
    assert.strictEqual(items[0].stage, 'welcome');
    assert.strictEqual(items[items.length - 1].stage, 'recovery');
    assert.strictEqual(items[1].stage, 'second_visit');
  });

  test('the heading is tinted by what the group means, not per stage name', () => {
    /* Three meanings, reusing the colours the rest of the app already uses:
       green to open, red for a missed call, amber for the cold chasing.
       Tying the class to the stage key means a stage with no colour falls
       back to the neutral chip rather than being invisible. */
    const styles = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
    ['welcome', 'rebooked', 'followup'].forEach(st =>
      assert.ok(styles.includes('.touch-group-chip.' + st), st + ' should be tinted'));
    assert.ok(/\.touch-group-chip\.noshow\{[^}]*red/.test(styles), 'a missed call should read red');
    assert.ok(/\.touch-group-chip\.recovery,[\s\S]{0,60}revival\{[^}]*amber/.test(styles),
      'the cold chasing should read amber');
    // The neutral default has to exist, or an untinted stage has no chip at all.
    assert.ok(/\.touch-group-chip\{[^}]*background/.test(styles));
  });

  test('every stage the list can produce gets a readable heading', () => {
    // The card chip used to print the raw key, so it read "midcheckin". The
    // heading replaced it, which only works if the heading is readable.
    GB.TOUCH_LIST_ORDER.forEach(st => {
      const label = GB.touchLabel(st);
      assert.ok(label && label !== st, st + ' has no readable label: ' + label);
      assert.ok(/^[A-Z]/.test(label), label + ' should start capitalised');
    });
  });

  test('the per-card stage chip is gone, since the heading now says it', () => {
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function buildTouchCard'), app.indexOf('function', app.indexOf('function buildTouchCard') + 10));
    assert.ok(!/stageChip/.test(fn),
      'buildTouchCard still adds a stage chip, duplicating the group heading');
    // But the style must survive for the panels that have no grouping.
    assert.ok(/stage-chip/.test(app), 'the review panel and focus mode still need it');
  });

  test('the Today list renders filtered and unfiltered, and recovers from a stale filter', () => {
    /* A filter pointing at a kind that is no longer due would show an empty
       column with no way to tell why -- the cards are gone and the button
       that hid them is gone too, because the bar is built from what is
       actually in the list. It falls back to showing everything. */
    const ctx = makeHostedCtx();
    const soon = new Date(Date.now() + 5 * 86400000).toISOString();
    vm.runInContext(`
      STATE = buildDefaultState();
      for (var i = 0; i < 4; i++) {
        STATE.clients['c' + i] = sanitizeClient({id:'c' + i, name:'P' + i,
          phone:'21355501' + i, timezone:'America/New_York', status:'Booked',
          bookedDate: new Date(Date.now() - 20*86400000).toISOString(),
          callDateTime: '${soon}'});
      }
    `, ctx);
    assert.doesNotThrow(() => vm.runInContext('renderCallsBoard()', ctx), 'unfiltered');

    vm.runInContext("UI.touchFilter = 'welcome';", ctx);
    assert.doesNotThrow(() => vm.runInContext('renderCallsBoard()', ctx), 'filtered to a real kind');

    vm.runInContext("UI.touchFilter = 'noshow';", ctx);
    assert.doesNotThrow(() => vm.runInContext('renderCallsBoard()', ctx), 'filtered to a kind with nothing due');
    assert.strictEqual(vm.runInContext('UI.touchFilter', ctx), '',
      'a filter with nothing behind it must reset, or the column is empty with no way back');
  });

  test('the real list comes out grouped, not interleaved', () => {
    // End to end through getTextTodayList, not just the comparator.
    const clients = {};
    const add = (c) => { clients[c.id] = c; };
    add(mk('newA',  {callDateTime: soon(6)}));
    add(mk('newB',  {callDateTime: soon(5)}));
    add(mk('coldA', {status: 'Ghosted', callDateTime: ago(40), bookedDate: ago(90)}));
    const state = {clients, variants: GB.buildDefaultVariants(), variantStats: {},
                   todos: [], epsilon: 0.2, myCalendars: []};
    const list = GB.getTextTodayList(state, new Date(), '');
    const ranks = list.map(it => GB.touchListRank(it.stage));
    const sorted = ranks.slice().sort((a, b) => a - b);
    assert.deepStrictEqual(ranks, sorted,
      'the list must come out already grouped: ' + JSON.stringify(list.map(i => i.stage)));
  });
}

console.log('\n--- end of day closes the books, it does not repeat the day ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  // Unique phone per contact: the queue dedupes by person, so a shared number
  // silently collapses five contacts into one and the fixture stops testing
  // what it claims to.
  let phoneSeq = 1000;
  const mk = (id, over) => GB.sanitizeClient(Object.assign({
    id: id, name: id, phone: '21355' + (++phoneSeq), timezone: 'America/New_York',
    status: 'Booked', bookedDate: ago(30)
  }, over));
  const build = (clients, todos) => ({
    clients: clients, variants: GB.buildDefaultVariants(), variantStats: {},
    todos: todos || [], epsilon: 0.2
  });

  test('texts still to send are not counted here — that is the Today tab', () => {
    /* This screen used to include every due touch. On the live book that was
       roughly a third of a count of 40, and it was work the person had just
       been looking at on Today, which already shows a progress bar and a
       copy-all button for exactly those texts. */
    const clients = {};
    for (let i = 0; i < 5; i++) {
      clients['due' + i] = mk('due' + i, {
        callDateTime: new Date(Date.now() + 5 * 86400000).toISOString()
      });
    }
    const state = build(clients);
    assert.strictEqual(GB.computeEndOfDayItems(state).length, 0,
      'a day with texts outstanding but nothing to LOG has nothing to close');
    // And they are still queued where they belong.
    assert.strictEqual(GB.getTextTodayList(state, new Date(), '').length, 5,
      'removing them from end of day must not remove them from Today');
  });

  test('it can actually reach zero, which is what makes it worth opening', () => {
    /* The real cost of the old behaviour: the count could never hit zero
       while a single text was unsent, so the screen never felt finishable and
       its "Busted!" empty state was effectively unreachable. A list you
       cannot clear stops being a list anyone opens. */
    const clients = {};
    for (let i = 0; i < 8; i++) {
      clients['due' + i] = mk('due' + i, {
        callDateTime: new Date(Date.now() + 3 * 86400000).toISOString()
      });
    }
    clients.logged = mk('logged', {status: 'Completed', callDateTime: ago(2), closeOutcome: 'Closed'});
    assert.strictEqual(GB.computeEndOfDayItems(build(clients)).length, 0,
      'everything answered means done, however many texts are still queued');
  });

  test('the questions only the end of the day can answer are all still here', () => {
    const clients = {
      today:   mk('today',   {callDateTime: new Date(new Date().setHours(9, 0, 0, 0)).toISOString()}),
      overdue: mk('overdue', {callDateTime: ago(9)}),
      won:     mk('won',     {status: 'Completed', callDateTime: ago(4)}),
    };
    const items = GB.computeEndOfDayItems(build(clients, [{id: 'td1', text: 'call back', done: false}]));
    const types = {};
    items.forEach(i => { types[i.type] = (types[i.type] || 0) + 1; });
    assert.strictEqual(types['today-no-outcome'], 1, 'did today\'s call happen?');
    assert.strictEqual(types['overdue-unlogged'], 1, 'did the old one?');
    assert.strictEqual(types['no-close'], 1, 'did the won one close?');
    assert.strictEqual(types.todo, 1);
    assert.ok(!items.some(i => i.type === 'touch'), 'no touches');
  });

  test('a finished to-do and an answered call both stop appearing', () => {
    const clients = {
      answered: mk('answered', {status: 'No-show', callDateTime: ago(3)}),
      closed:   mk('closed',   {status: 'Completed', callDateTime: ago(3), closeOutcome: 'Not closed'}),
    };
    const items = GB.computeEndOfDayItems(build(clients, [{id: 'td1', text: 'done thing', done: true}]));
    assert.strictEqual(items.length, 0, 'got: ' + JSON.stringify(items.map(i => i.type)));
  });

  test('the screen renders with items and when the day is closed', () => {
    const ctx = makeHostedCtx();
    vm.runInContext(`
      STATE = buildDefaultState();
      STATE.clients['a'] = sanitizeClient({id:'a', name:'Dana', phone:'2135550100',
        timezone:'America/New_York', status:'Booked', bookedDate:'${ago(30)}',
        callDateTime:'${ago(9)}'});
    `, ctx);
    assert.doesNotThrow(() => vm.runInContext('renderEndOfDay()', ctx));
    vm.runInContext("STATE.clients = {};", ctx);
    assert.doesNotThrow(() => vm.runInContext('renderEndOfDay()', ctx),
      'the empty state must render — it is now actually reachable');
  });
}

console.log('\n--- a brand new business, end to end ---');

/* The test that would have caught today.

   Every individual piece was tested. Nothing walked a NEW account from
   signing up to sending its first message, so nobody noticed that the pieces
   composed into an app that imported nothing and, when it did, introduced the
   business as a different company.

   Three people hit that in a row. This is the guard for the composition, not
   the parts: an account with no settings, no filter, no templates and no
   history has to end up able to follow up on a booking. */
{
  /* A realistic booking from somebody else's booking tool.

     The first version of this fixture said "Booked by John Smith" — which is
     MarketMaker's own booking-tool wording, and the legacy keyword rule
     matches on exactly that phrase. So step 1 passed WITH the bug reverted,
     making it a test that could not fail: the same trap as the old test that
     asserted the broken fallback.

     Nothing here contains "strategy session" or "booked by", because a
     plumber's calendar would not. */
  const plumberBooking = {
    id: 'gcal-evt-1',
    summary: 'Water heater estimate - John Smith',
    description: 'Appointment requested via website\njohn@gmail.com\n(512) 555-1234',
    organizer: {email: 'bob@acmeplumbing.com'},
    attendees: [
      {email: 'bob@acmeplumbing.com', self: true},
      {email: 'dispatch@acmeplumbing.com'},
      {email: 'john@gmail.com'},
    ],
  };

  test('step 1: a booking with no configuration at all is recognised', () => {
    // The exact failure: an unconfigured account filtered for another
    // company's event titles, so this returned false and nothing imported.
    assert.strictEqual(GB.matchesCalendarFilter(plumberBooking, undefined), true,
      'a new account must import a booking without being configured first');
    // The fixture must NOT satisfy the legacy rule, or this test cannot fail.
    assert.strictEqual(
      GB.matchesCalendarFilter(plumberBooking, GB.LEGACY_CALENDAR_FILTER), false,
      'the fixture looks like a MarketMaker booking, so step 1 would pass either way');
    assert.strictEqual(GB.matchesCalendarFilter(plumberBooking, null), true);
    assert.strictEqual(GB.matchesCalendarFilter(plumberBooking, {}), true);
  });

  test('step 2: onboarding leaves the account with a filter it can see', () => {
    // Not merely relying on a fallback — an invisible setting is how this
    // went unnoticed for so long.
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function applyOnboarding'),
                         app.indexOf('function', app.indexOf('function applyOnboarding') + 10));
    assert.ok(/calendarFilter/.test(fn), 'onboarding must write a calendar filter');
    assert.ok(/attendees/.test(fn), 'and it must be the rule that needs no setup');
  });

  test('step 3: the imported contact is the customer, not the office', () => {
    // dispatch@acmeplumbing.com is on the invite. Emailing dispatch instead
    // of the homeowner is invisible until somebody notices.
    const ics = [
      'BEGIN:VCALENDAR','BEGIN:VEVENT','UID:gcal-evt-1',
      'SUMMARY:Water heater estimate (John Smith)',
      'DESCRIPTION:Booked by John Smith',
      'DTSTART:20261005T150000Z',
      'ORGANIZER;CN=Bob:mailto:bob@acmeplumbing.com',
      'ATTENDEE;CN=Dispatch:mailto:dispatch@acmeplumbing.com',
      'ATTENDEE;CN=John:mailto:john@gmail.com',
      'END:VEVENT','END:VCALENDAR'
    ].join('\r\n');
    const parsed = GB.clientFromICSEvent(GB.parseICS(ics)[0]);
    assert.strictEqual(parsed.email, 'john@gmail.com');
    assert.strictEqual(parsed.name, 'John Smith');
  });

  test('step 4: the contact is due a first touch, and it is sendable', () => {
    const state = {
      clients: {}, variants: GB.buildDefaultVariants(), variantStats: {},
      todos: [], epsilon: 0.2, senderName: 'Bob'
    };
    const c = GB.sanitizeClient({
      id: 'p1', name: 'John Smith', phone: '5125551234', email: 'john@gmail.com',
      bookedDate: new Date().toISOString(),
      callDateTime: new Date(Date.now() + 4 * 86400000).toISOString(),
      timezone: 'America/Chicago'
    });
    state.clients.p1 = c;

    const due = GB.computeDue(c, new Date());
    assert.ok(due.includes('welcome'), 'a fresh booking owes a welcome: ' + JSON.stringify(due));

    const eligible = GB.eligibleVariants(state, 'welcome', c);
    assert.ok(eligible.length, 'there must be something to send');
    const picked = GB.pickVariant(state, 'welcome', c);
    assert.ok(picked && picked.text, 'the bandit must return a real variant');
  });

  test('step 5: every message this new business could send names only itself', () => {
    /* The one that would have been most embarrassing: a plumber's customer
       receiving a text introducing the sender as a marketing agency, offering
       to fix their YouTube channel.

       Checked across EVERY variant the bandit could pick, not just the first,
       because which one goes out is chosen at random. */
    const c = GB.sanitizeClient({
      id: 'p1', name: 'John Smith', phone: '5125551234', email: 'john@gmail.com',
      bookedDate: new Date().toISOString(),
      callDateTime: new Date(Date.now() + 4 * 86400000).toISOString(),
      timezone: 'America/Chicago',
      meetLink: 'https://meet.google.com/a-b-c'
    });
    const state = {clients: {p1: c}, variants: GB.buildDefaultVariants(),
                   variantStats: {}, todos: [], senderName: 'Bob'};

    const offenders = [];
    Object.keys(state.variants).forEach(stage => {
      GB.eligibleVariants(state, stage, c).forEach(v => {
        const out = GB.renderTemplate(v.text, c, 'Bob');
        if (/marketmaker|youtube|realtor/i.test(out)) offenders.push(stage + '/' + v.id + ': ' + out);
      });
    });
    assert.deepStrictEqual(offenders, [],
      'a message this business could send names someone else:\n' + offenders.join('\n'));
  });

  test('step 6: nothing in the whole first-run path signs the wrong name', () => {
    const c = GB.sanitizeClient({id:'p1', name:'John Smith', phone:'5125551234',
      bookedDate: new Date().toISOString(),
      callDateTime: new Date(Date.now() + 4 * 86400000).toISOString(),
      timezone:'America/Chicago'});
    const state = {clients:{p1:c}, variants: GB.buildDefaultVariants(),
                   variantStats:{}, todos:[], senderName:'Bob'};
    Object.keys(state.variants).forEach(stage => {
      GB.eligibleVariants(state, stage, c).forEach(v => {
        const out = GB.renderTemplate(v.text, c, 'Bob');
        assert.ok(!/Johnny/.test(out), stage + '/' + v.id + ' signs the wrong name: ' + out);
      });
    });
  });
}

console.log('\n--- a library email is not a text variant ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const book = (n, log) => {
    const clients = {};
    for (let i = 0; i < n; i++) {
      clients['c' + i] = GB.sanitizeClient({
        id: 'c' + i, name: 'P' + i, phone: '213555010' + (i % 10),
        timezone: 'America/New_York', status: 'Completed',
        bookedDate: ago(40), callDateTime: ago(5), messageLog: log(i)
      });
    }
    return {clients, variants: GB.buildDefaultVariants(), variantStats: {}, todos: []};
  };

  test('a library email does not steal the appointment credit from the text that earned it', () => {
    /* The panel credits the outcome to the LAST message before the
       appointment. A library email sent the morning of the call is the last
       message — so it took the credit away from the day-of text, quietly
       making a real text variant look like it produced nothing.

       This is the half of the problem that corrupts existing numbers, not
       just adds a stray section. */
    const state = book(12, (i) => [
      {id:'t'+i, stage:'dayof', variantId:'d1', text:'t', sentAt: ago(6),
       responded: i < 5, respondedAt: i < 5 ? ago(6) : null, reviewed: true, channel:'sms'},
      {id:'e'+i, stage:'email', variantId:'lib-uuid-1234', text:'e', sentAt: ago(5.1),
       responded: false, respondedAt: null, reviewed: true, channel:'email'},
    ]);
    const groups = GB.computeVariantPerformance(state, new Date());
    assert.deepStrictEqual(groups.map(g => g.stage), ['dayof'],
      'only touch stages belong in a panel that compares touch wordings');
    const row = groups[0].rows.find(r => r.variantId === 'd1');
    assert.strictEqual(row.credited, 12, 'the day-of text must keep its credit');
    assert.strictEqual(row.appointments, 12);
  });

  test('library emails never appear as a variant row', () => {
    // Their id is a document uuid, so the row would have been labelled with
    // raw hex under a heading reading "email".
    const state = book(12, (i) => [
      {id:'e'+i, stage:'email', variantId:'b3f1c2d4e5f60718', text:'e', sentAt: ago(8),
       responded: i < 4, respondedAt: i < 4 ? ago(7) : null, reviewed: true, channel:'email'},
    ]);
    const groups = GB.computeVariantPerformance(state, new Date());
    assert.deepStrictEqual(groups, [], 'got: ' + JSON.stringify(groups.map(g => g.stage)));
  });

  test('an email touch from the OLD stage-keyed set is still measured', () => {
    // Only the library's 'email' stage is excluded. An email written against
    // a real touch is still that touch, and still comparable.
    const state = book(12, (i) => [
      {id:'e'+i, stage:'dayof', variantId:'own-dayof', text:'e', sentAt: ago(6),
       responded: i < 4, respondedAt: i < 4 ? ago(6) : null, reviewed: true, channel:'email'},
    ]);
    const groups = GB.computeVariantPerformance(state, new Date());
    assert.deepStrictEqual(groups.map(g => g.stage), ['dayof']);
  });

  test('a library email still counts as contact, which is what it is for', () => {
    // Excluding it from VARIANT stats must not make it invisible: "has this
    // person been contacted" is what stops an automated text landing on top
    // of an email somebody sent by hand.
    const c = GB.sanitizeClient({id:'c1', name:'Dana', phone:'2135550100',
      timezone:'America/New_York', status:'Booked', bookedDate: ago(10),
      callDateTime: new Date(Date.now() + 86400000).toISOString(),
      messageLog:[{id:'m1', stage:'email', variantId:'lib-1', text:'e',
        sentAt: new Date(Date.now() - 3600000).toISOString(),
        responded:false, respondedAt:null, reviewed:false, channel:'email'}]});
    const inter = GB.lastInteraction(c, new Date());
    assert.ok(inter && inter.message, 'the email must be the last interaction');
    assert.strictEqual(inter.message.stage, 'email');
    // And it is not counted as one of the five touches, because it is not one.
    assert.strictEqual(GB.cadenceProgress(c, new Date()).done, 0);
  });
}

console.log('\n--- a dead calendar connection says so ---');

{
  const ago = (hrs) => new Date(Date.now() - hrs * 3600000).toISOString();
  const H = (conns) => GB.calendarHealth(conns, new Date());

  test('a calendar syncing normally shows nothing at all', () => {
    // A healthy account must not carry a warning bar. This is most of the
    // time, and a bar that is always there is furniture.
    assert.strictEqual(H([{calendarId:'a', lastSync: ago(3)}]).state, 'ok');
    assert.strictEqual(GB.describeCalendarHealth(H([{calendarId:'a', lastSync: ago(3)}])), null);
  });

  test('a sync gap longer than the cron interval is a failure, not a quiet week', () => {
    // The cron runs twice daily, so 36h+ means a sync FAILED rather than was
    // not due. This is the gap that went unnoticed for days.
    assert.strictEqual(H([{calendarId:'a', lastSync: ago(20)}]).state, 'ok',
      'a normal overnight gap must not cry wolf');
    assert.strictEqual(H([{calendarId:'a', lastSync: ago(40)}]).state, 'stale');
  });

  test('the message says what stopped and what to press, not "token expired"', () => {
    const info = GB.describeCalendarHealth(H([{calendarId:'a', lastSync: ago(24 * 5)}]));
    assert.strictEqual(info.severity, 'error');
    assert.ok(/5 days/.test(info.text), 'name the gap: ' + info.text);
    assert.ok(/[Rr]econnect/.test(info.action + info.text), 'say what to do: ' + info.text);
    assert.ok(!/token|oauth|refresh_token|401/i.test(info.text),
      'nobody outside this codebase knows what that means: ' + info.text);
  });

  test('a freshly connected calendar is given time before it is called broken', () => {
    // Connected seconds ago and not yet synced is normal, not a fault.
    assert.strictEqual(H([{calendarId:'a', connectedAt: ago(0.2)}]).state, 'ok');
    // Connected yesterday and still never synced is a real problem.
    const info = GB.describeCalendarHealth(H([{calendarId:'a', connectedAt: ago(30)}]));
    assert.ok(/never finished a sync/.test(info.text), info.text);
  });

  test('one dead calendar out of two is reported without claiming both are down', () => {
    const h = H([{calendarId:'work', lastSync: ago(2)}, {calendarId:'old', lastSync: ago(300)}]);
    assert.strictEqual(h.state, 'partial');
    const info = GB.describeCalendarHealth(h);
    assert.ok(/One of your calendars/.test(info.text), info.text);
  });

  test('an account with no calendar connected is not nagged about syncing', () => {
    // They get the onboarding prompt instead; two messages about the same
    // thing is worse than one.
    assert.strictEqual(H([]).state, 'none');
    assert.strictEqual(GB.describeCalendarHealth(H([])), null);
    assert.strictEqual(GB.describeCalendarHealth(H(null)), null);
  });

  test('every button in the app points at a handler that exists', () => {
    /* The notice's button first said 'sync-calendar'. The handler is
       'sync-calendar-now'. That would have shipped a warning bar whose only
       button did nothing — worse than no bar, because it tells someone the
       fix is one click away and then refuses.

       The DOM stub is a noop proxy, so rendered markup cannot be read back to
       catch this. It is checkable statically, and worth checking for every
       button rather than just this one. */
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');

    const used = new Set();
    /* Two syntaxes, both real, matched precisely.

       A first attempt matched only `'data-action': 'literal'` and PASSED on
       the exact bug it was written for, because that action is chosen by a
       ternary and the literal is not adjacent to the key. A second attempt
       took every kebab-case literal on the line and drowned in tag names and
       CSS classes. So: the direct value, and the two branches of a ternary. */
    for (const m of app.matchAll(/'data-action'\s*:\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
    for (const m of app.matchAll(
        /'data-action'\s*:[^,\n]*?\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)) {
      used.add(m[1]); used.add(m[2]);
    }
    for (const m of app.matchAll(/data-action=\\?"([a-z0-9-]+)/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-action="([a-z0-9-]+)"/g)) used.add(m[1]);

    const handled = new Set();
    for (const m of app.matchAll(/case '([a-z0-9-]+)'/g)) handled.add(m[1]);
    for (const m of app.matchAll(/=== '([a-z0-9-]+)'/g)) handled.add(m[1]);

    assert.ok(used.size > 50, 'the scan found almost no buttons — has the markup style changed?');
    assert.ok(used.has('sync-calendar-now'), 'sanity: the calendar notice\'s own action should be found');

    const dead = [...used].filter(a => !handled.has(a)).sort();
    assert.deepStrictEqual(dead, [],
      'button(s) point at an action no handler implements: ' + dead.join(', '));
  });

  test('the full render pass still works with a dead connection', () => {
    const ctx = makeHostedCtx();
    vm.runInContext(`
      STATE = buildDefaultState();
      STATE.calendarConnections = [{calendarId:'a@b.com', lastSync: '${ago(500)}'}];
    `, ctx);
    assert.doesNotThrow(() => vm.runInContext('renderAll()', ctx));
  });
}

console.log('\n--- nothing about one customer is hard-coded as everyone’s ---');

test('the contact email is the outside guest, not a colleague on the booking', () => {
  /* This used to strip a literal @marketmakermgmt.com, which fails BOTH ways.
     For any other business the strip never matches, so the first attendee
     wins — and if that is a teammate cc'd on the call, the teammate's address
     is saved as the customer's and every follow-up email goes to them. */
  const ics = [
    'BEGIN:VCALENDAR','BEGIN:VEVENT','UID:evt1',
    'SUMMARY:Roof inspection (John Smith)',
    'DESCRIPTION:Booked by John Smith',
    'DTSTART:20261005T150000Z',
    'ORGANIZER;CN=Bob:mailto:bob@acmeplumbing.com',
    'ATTENDEE;CN=Teammate:mailto:dave@acmeplumbing.com',
    'ATTENDEE;CN=John Smith:mailto:john@gmail.com',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
  const ev = GB.parseICS(ics)[0];
  assert.strictEqual(ev.organizerEmail, 'bob@acmeplumbing.com',
    'ORGANIZER has to be parsed, or there is no way to know whose domain is internal');
  const c = GB.clientFromICSEvent(ev);
  assert.strictEqual(c.email, 'john@gmail.com',
    'the customer, not the colleague — a follow-up to the colleague is invisible until someone notices');
});

test('a MarketMaker booking still picks the client, not the teammate', () => {
  // The behaviour that was correct before must stay correct: this is the
  // account the hard-coded domain existed for.
  const ics = [
    'BEGIN:VCALENDAR','BEGIN:VEVENT','UID:evt2',
    'SUMMARY:Strategy Session (Dana Reed)',
    'DESCRIPTION:Booked by Dana Reed',
    'DTSTART:20261005T150000Z',
    'ORGANIZER;CN=Johnny:mailto:john@marketmakermgmt.com',
    'ATTENDEE;CN=Niklaus:mailto:niklaus.c@marketmakermgmt.com',
    'ATTENDEE;CN=Dana:mailto:dana@example.com',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
  const c = GB.clientFromICSEvent(GB.parseICS(ics)[0]);
  assert.strictEqual(c.email, 'dana@example.com');
});

test('an event with no organizer still yields a contact rather than nothing', () => {
  // Unknown internal domain must degrade to "take the first guest", not to
  // "discard every address".
  const ics = [
    'BEGIN:VCALENDAR','BEGIN:VEVENT','UID:evt3',
    'SUMMARY:Estimate (Pat Lee)','DESCRIPTION:Booked by Pat Lee',
    'DTSTART:20261005T150000Z',
    'ATTENDEE;CN=Pat:mailto:pat@somewhere.com',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
  const c = GB.clientFromICSEvent(GB.parseICS(ics)[0]);
  assert.strictEqual(c.email, 'pat@somewhere.com');
});

test('no source file names one customer\'s domain in its logic', () => {
  // The cheapest possible guard against this whole class of bug. A mention in
  // a COMMENT is fine — explaining the history is useful; a mention in code
  // that runs is one business's details deciding another's behaviour.
  const files = ['logic.js', 'hosted/data.js', 'hosted/app.js',
                 path.join('supabase','functions','_shared','parse.ts')];
  files.forEach(rel => {
    const code = codeOnly(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
    assert.ok(!/marketmakermgmt/i.test(code),
      rel + ' names marketmakermgmt in code that runs — one business\'s details deciding another\'s behaviour');
  });
  // Sanity: the guard must be able to see a real occurrence.
  assert.ok(/marketmakermgmt/i.test(codeOnly("var x = /@marketmakermgmt\\.com$/i;")),
    'codeOnly stripped too much — the guard would pass on anything');
});

test('rewriting a starter text gives it a new id, because pooling is keyed by id', () => {
  /* builtin_variant_stats is keyed (stage, variant_key) GLOBALLY, across every
     account. So if a starter text's wording changes but its id does not, an
     account seeded today and one seeded last month both report into the same
     row while sending materially different messages — and the bandit ranks
     copy using numbers earned by copy that no longer exists.

     This compares the current defaults against the version in git from before
     the industry-neutral rewrite. Any id appearing in both with different text
     is the bug. It is a cheap check and it is the kind of thing nobody
     remembers at the moment they are editing copy. */
  const { execSync } = require('child_process');
  let previous;
  try {
    previous = execSync('git show 08ffce1~1:hosted/logic.js', {cwd: __dirname, encoding: 'utf8'});
  } catch (e) {
    console.log('     (skipped — git history not available here)');
    return;
  }
  const ctx = {globalThis: {}, console};
  vm.createContext(ctx);
  vm.runInContext(previous, ctx);
  const before = ctx.globalThis.GBLogic.buildDefaultVariants();
  const after = GB.buildDefaultVariants();

  const collisions = [];
  Object.keys(after).forEach(stage => after[stage].forEach(v => {
    const old = (before[stage] || []).find(x => x.id === v.id);
    if (old && old.text !== v.text) collisions.push(stage + '/' + v.id);
  }));
  assert.deepStrictEqual(collisions, [],
    'starter text(s) changed wording while keeping an id that already carries pooled ' +
    'stats for the old wording: ' + collisions.join(', '));
});

test('no two starter variants share an id within a stage', () => {
  // Re-keying by hand is exactly when a duplicate slips in, and a duplicate
  // key would make two different texts indistinguishable to the bandit.
  const v = GB.buildDefaultVariants();
  Object.keys(v).forEach(stage => {
    const ids = v[stage].map(x => x.id);
    assert.strictEqual(new Set(ids).size, ids.length,
      'duplicate variant id in ' + stage + ': ' + ids.join(', '));
  });
});

test('the starter texts a new account gets work for any business', () => {
  /* 17 of the 28 default texts were written for one YouTube agency, and one
     introduced the sender as "with MarketMakerMGMT". Every new account is
     seeded with these and the bandit rotates them, so a plumber's customer
     could receive a text naming a marketing agency they have never heard of,
     offering to fix their channel.

     Existing accounts are unaffected — variants are only seeded into an
     account with no rows at all — so this changes what NEW businesses start
     with, not anyone's own copy.

     Three are exempt: they carry needsChannel, so they are only ever eligible
     for a contact who actually has a YouTube channel on file. */
  const v = GB.buildDefaultVariants();
  const specific = /youtube|marketmaker|realtor|\bchannel\b|\bvideo\b|\bviews\b|watch time/i;
  const offenders = [];
  Object.keys(v).forEach(stage => v[stage].forEach(x => {
    if (x.needsChannel) return;
    if (specific.test(x.text)) offenders.push(stage + '/' + x.id);
  }));
  assert.deepStrictEqual(offenders, [],
    'starter text(s) assume one industry: ' + offenders.join(', '));

  // A gated variant is genuinely gated, or the exemption is a loophole.
  Object.keys(v).forEach(stage => v[stage].forEach(x => {
    if (specific.test(x.text)) {
      assert.ok(x.needsChannel,
        stage + '/' + x.id + ' is industry-specific but not gated');
    }
  }));
});

test('every starter text still renders into a real message', () => {
  // Rewriting copy is exactly when a placeholder gets fat-fingered, and an
  // unrendered {nmae} goes out to a customer looking like a mail merge.
  const base = {id:'c', name:'Dana Reed', phone:'2135550100',
    timezone:'America/New_York', meetLink:'https://meet.google.com/a-b-c',
    callDateTime: new Date(Date.now() + 86400000).toISOString()};
  const plain = GB.sanitizeClient(base);
  // A gated variant is only ever offered for a contact that HAS a channel, so
  // that is the contact to render it against.
  const withChannel = GB.sanitizeClient(
    Object.assign({}, base, {youtubeLink: 'https://youtube.com/@danareed'}));
  const v = GB.buildDefaultVariants();
  Object.keys(v).forEach(stage => v[stage].forEach(x => {
    const out = GB.renderTemplate(x.text, x.needsChannel ? withChannel : plain, 'Bob');
    assert.ok(!/\{[a-z]+\}/i.test(out),
      stage + '/' + x.id + ' left an unfilled placeholder: ' + out);
    assert.ok(out.length > 20, stage + '/' + x.id + ' rendered to almost nothing');
    assert.ok(!/\s{2,}/.test(out.replace(/\n/g, ' ')),
      stage + '/' + x.id + ' has a double space, usually a removed placeholder: ' + out);
  }));
});

test('a channel-specific starter is never offered to a contact without one', () => {
  // The gating is what makes the three exemptions above safe. Without it, w3
  // renders as "Got  open and locked you in for..." — a double space and a
  // sentence missing its subject, sent to a customer.
  const plain = GB.sanitizeClient({id:'c', name:'Dana', phone:'2135550100'});
  const eligible = GB.eligibleVariants(
    {variants: GB.buildDefaultVariants()}, 'welcome', plain);
  assert.ok(eligible.length, 'a contact with no channel must still have something to send');
  assert.ok(!eligible.some(x => x.needsChannel),
    'a channel-specific text was offered to a contact with no channel');
  assert.ok(!eligible.some(x => /\{channel\}/.test(x.text)));
});

test('a text never falls back to signing someone else\'s real name', () => {
  /* The fallback was 'Johnny'. On any other account that is a text going to
     a stranger's customer signed by a person at a different company —
     confidently, and unfixably once sent. */
  const c = GB.sanitizeClient({id:'c', name:'Dana Reed', phone:'2135550100'});
  const out = GB.renderTemplate('Hi {name}, {sender} here.', c, '');
  assert.ok(!/Johnny/i.test(out), 'got: ' + out);
  const named = GB.renderTemplate('Hi {name}, {sender} here.', c, 'Bob');
  assert.strictEqual(named, 'Hi Dana, Bob here.');
});

test('the AI prompt makes no claim about what the business does', () => {
  // It used to assert "a real estate YouTube coach" for every account, so a
  // plumber asking for a follow-up got one pitching video strategy.
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function buildAIPrompt'), app.indexOf('function callGemini'));
  const code = codeOnly(fn);
  assert.ok(!/real estate/i.test(code), 'the prompt still asserts an industry');
  assert.ok(!/YouTube/i.test(code), 'the prompt still asserts a service');
  assert.ok(!/'Johnny'/.test(code), 'the prompt still falls back to a real person');
  assert.ok(/Never invent a service, industry or claim/.test(fn),
    'the model should be told to infer the business from the examples, not guess');
});

console.log('\n--- what the calendar sync tells you ---');

{
  // describeSyncResult lives in app.js, which needs the DOM stub.
  const ctx = makeHostedCtx();
  const call = (cals) => vm.runInContext('describeSyncResult(' + JSON.stringify(cals) + ')', ctx);

  test('an expired Google connection says so, instead of claiming success', () => {
    // The actual reported symptom: press Sync, get a cheerful green toast,
    // nothing appears, no way to find out why. The consent screen is still in
    // Testing, which expires refresh tokens every 7 days.
    const r = call([{calendar:'ethan@marketmakermgmt.com',
      error:'Error: Token refresh failed: {"error":"invalid_grant"}'}]);
    assert.strictEqual(r.ok, false);
    assert.ok(/reconnect/i.test(r.text), 'it must say what to DO: ' + r.text);
    assert.ok(!/0 new/.test(r.text), 'never report a count for a sync that never ran');
  });

  test('a failure that is not an expired token does not claim it is one', () => {
    const r = call([{calendar:'a@b.com', error:'Error: Calendar API error: {"code":403}'}]);
    assert.strictEqual(r.ok, false);
    assert.ok(!/reconnect/i.test(r.text), 'wrong advice is worse than none: ' + r.text);
    assert.ok(/nothing was changed/i.test(r.text));
  });

  test('one calendar failing out of two is reported, not averaged away', () => {
    const r = call([
      {calendar:'work@x.com', added:3, updated:1, scanned:9, filteredOut:5},
      {calendar:'personal@x.com', error:'Error: Token refresh failed'},
    ]);
    assert.ok(/3 new/.test(r.text));
    assert.ok(/personal@x.com/.test(r.text), 'name the one that broke: ' + r.text);
  });

  test('a filter that excludes everything is named as the cause', () => {
    // This is the state the calendar_filter migration put every pre-existing
    // account into: filtering for one company's event titles.
    const r = call([{calendar:'a@b.com', added:0, updated:0, scanned:14, filteredOut:14}]);
    assert.ok(/14 events/.test(r.text), r.text);
    assert.ok(/Settings/.test(r.text), 'point at the setting that fixes it: ' + r.text);
  });

  test('a genuinely quiet calendar is not dressed up as a problem', () => {
    const r = call([{calendar:'a@b.com', added:0, updated:0, scanned:0, filteredOut:0}]);
    assert.ok(/up to date/i.test(r.text), r.text);
    assert.strictEqual(r.ok, true);
  });

  test('a normal sync still just reports the numbers', () => {
    const r = call([{calendar:'a@b.com', added:2, updated:5, scanned:11, filteredOut:4}]);
    assert.ok(/2 new/.test(r.text) && /5 updated/.test(r.text), r.text);
    assert.strictEqual(r.ok, true);
  });

  test('an older function that reports no counts still gets a sane message', () => {
    // The deployed function does not return scanned/filteredOut until it is
    // redeployed. The app has to be useful before that happens.
    const r = call([{calendar:'a@b.com', added:0, updated:0}]);
    assert.strictEqual(r.ok, true);
    assert.ok(r.text.length > 0);
    assert.ok(!/undefined|NaN/.test(r.text), 'missing fields must not leak into the message: ' + r.text);
  });
}

console.log('\n--- the email library ---');

test('an entry keeps its timing note in the writer’s own words', () => {
  // The whole point of the change: "after they ask what it costs" is a real
  // answer and is not one of five stages.
  const d = GB.sanitizeEmailDoc({
    title: 'Pricing breakdown', whenToSend: 'after they ask what it costs',
    subject: 'The numbers', body: 'Long body.'
  });
  assert.strictEqual(d.whenToSend, 'after they ask what it costs');
});

test('a long email survives intact — this is the column that exists for it', () => {
  const long = 'Paragraph.\n\n'.repeat(400);
  const d = GB.sanitizeEmailDoc({title: 'Case study', body: long});
  assert.strictEqual(d.body, long, 'an email must not be truncated anywhere in the round trip');
});

test('an entirely empty entry is a discarded draft, not data', () => {
  assert.strictEqual(GB.sanitizeEmailDoc({title: '', subject: '', body: '   '}), null);
  assert.strictEqual(GB.sanitizeEmailDoc(null), null);
});

test('an untitled entry is kept, because a body is the part worth saving', () => {
  const d = GB.sanitizeEmailDoc({body: 'I wrote this and forgot to name it.'});
  assert.ok(d);
  assert.strictEqual(d.title, 'Untitled email');
});

test('the library comes back in the order the business put it in', () => {
  const state = {emailLibrary: [
    {id:'c', title:'Third', body:'x', sortOrder:30},
    {id:'a', title:'First', body:'x', sortOrder:10},
    {id:'b', title:'Second', body:'x', sortOrder:20},
  ]};
  assert.deepStrictEqual(GB.emailLibrary(state).map(d => d.title), ['First','Second','Third']);
});

test('two never-reordered entries still come back in a stable order', () => {
  // All-zero sortOrder is the normal state of a freshly imported library, and
  // a list that reshuffles itself between renders looks broken.
  const state = {emailLibrary: [
    {id:'b', title:'Beta', body:'x'}, {id:'a', title:'Alpha', body:'x'},
  ]};
  assert.deepStrictEqual(GB.emailLibrary(state).map(d => d.title), ['Alpha','Beta']);
});

test('archived entries are hidden but not lost', () => {
  const state = {emailLibrary: [
    {id:'a', title:'Live', body:'x'}, {id:'b', title:'Old', body:'x', archived:true},
  ]};
  assert.deepStrictEqual(GB.emailLibrary(state).map(d => d.title), ['Live']);
  assert.strictEqual(GB.emailLibrary(state, {includeArchived:true}).length, 2);
});

test('moving email off the cadence does not look like email being deleted', () => {
  // The single worst outcome of this change would be a business opening the
  // app to find the emails they wrote gone.
  const seeded = GB.seedEmailLibrary({
    dayof: [{id:'own-dayof', subject:'Today at {time}', text:'Here is the link: {link}'}],
    welcome: [{id:'own-welcome', subject:'Confirmed', text:'You are booked.'}],
  });
  assert.strictEqual(seeded.length, 2);
  const titles = seeded.map(d => d.title);
  assert.ok(titles.includes('Day of the call email'), 'got: ' + titles.join(', '));
  assert.ok(titles.includes('Welcome email'));
  // And the timing note survives, because an email written for one moment
  // must not lose the only record of which moment.
  const dayof = seeded.find(d => d.title === 'Day of the call email');
  assert.ok(dayof.whenToSend, 'the stage timing should become the note');
});

test('the import carries only what the business wrote, never the built-ins', () => {
  // Seeding software's own starting points into the library would fill it with
  // words nobody chose and bury the two emails they cared about.
  const seeded = GB.seedEmailLibrary({
    welcome: [
      {id:'ew1', builtin:true, subject:'Built in', text:'Software wrote this.'},
      {id:'own-welcome', subject:'Mine', text:'I wrote this.'},
    ],
  });
  assert.strictEqual(seeded.length, 1);
  assert.strictEqual(seeded[0].subject, 'Mine');
});

test('importing an account with no written emails imports nothing', () => {
  assert.deepStrictEqual(GB.seedEmailLibrary({welcome:[{id:'ew1',builtin:true,text:'x'}]}), []);
  assert.deepStrictEqual(GB.seedEmailLibrary({}), []);
  assert.deepStrictEqual(GB.seedEmailLibrary(null), []);
});

test('a custom stage key is titled readably rather than printed raw', () => {
  // stageLabel answers for pipeline stages and returns the key for anything
  // else, which is how a library ends up titled "midcheckin email".
  assert.strictEqual(GB.touchLabel('midcheckin'), 'Mid-point check-in');
  assert.strictEqual(GB.touchLabel('second_visit'), 'Second visit');
  assert.strictEqual(GB.touchLabel(''), 'Untitled');
});

test('an entry fills in for a contact, with the same placeholders as everything else', () => {
  const state = {emailLibrary: [{
    id:'d1', title:'Day of', body:'Hi {name},\n\nLink: {link}\n\n{sender}',
    subject:'Today at {time}',
  }]};
  const client = {name:'Dana', meetLink:'https://meet.google.com/a-b-c',
    callDateTime:'2026-10-02T15:00:00Z', timezone:'America/New_York'};
  const r = GB.renderEmailDoc(state, 'd1', client, 'Johnny');
  assert.ok(r.text.includes('Hi Dana,'));
  assert.ok(r.text.includes('meet.google.com/a-b-c'));
  assert.ok(r.text.includes('Johnny'));
  assert.ok(!r.subject.includes('{time}'), 'the subject must be rendered too');
});

test('editing an email saves itself, like every other field in the app', () => {
  /* Contacts' notes, recap and phone all save when you leave the field. The
     library alone required pressing Save, so editing an email and clicking
     away lost it silently. The inconsistency is its own problem: having
     learned that typing is enough everywhere else, nobody goes looking for a
     button here. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const changeStart = app.indexOf("document.addEventListener('change'");
  const inputStart = app.indexOf("document.addEventListener('input'");
  assert.ok(changeStart !== -1 && inputStart > changeStart, 'listeners not where expected');
  const changeBlock = app.slice(changeStart, inputStart);

  assert.ok(changeBlock.includes("'set-email-doc'"),
    'an email edit must be handled on change, so it saves when you leave the field');
  const handler = changeBlock.slice(changeBlock.indexOf("'set-email-doc'"));
  assert.ok(/saveState\(STATE\)/.test(handler.slice(0, 500)),
    'and it must actually save');

  // The Save button is gone, because leaving it implies the other fields do
  // not save themselves.
  assert.ok(!app.includes("'email-doc-save'"),
    'the explicit Save button should be gone now that editing autosaves');
});

test('previewing an email neither sends it nor logs it', () => {
  /* The Gmail button opens a draft and sends nothing, but it logs the send
     the moment it is clicked -- so clicking it just to look would record an
     email that never went. Previewing is a different intent from sending and
     needs its own control, or the data quietly fills with sends that did not
     happen. */
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.senderName = 'Johnny';
    STATE.emailLibrary = [{id:'a', title:'Before the call', whenToSend:'after they book',
      subject:'Chat on {weekday}', body:'Hey {name}, see you {when}.', sortOrder:0}];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Caitlin Reed', phone:'2135550100',
      email:'caitlin@example.com', timezone:'America/New_York', status:'Booked',
      callDateTime: new Date(Date.now() + 3*86400000).toISOString()});
    LIB_OPEN = 'a'; LIB_PREVIEW = {a: 'c1'};
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx),
    'the preview must render');

  // Nothing was sent: no message landed on the contact.
  const logged = vm.runInContext("STATE.clients['c1'].messageLog.length", ctx);
  assert.strictEqual(logged, 0, 'previewing must not log a send');
});

test('the preview warns about anything still unfilled', () => {
  // A [PLACEHOLDER] or a {brace} that survives to the preview is one that
  // would go out exactly as written, which is the whole point of looking.
  const client = GB.sanitizeClient({id: 'c1', name: 'Caitlin', phone: '2135550100'});
  const state = {emailLibrary: [{id: 'a', title: 'X', subject: 's',
    body: 'Hi {name}, pay here: [PASTE THE RIGHT PACKAGE LINK HERE]', sortOrder: 0}]};
  const r = GB.renderEmailDoc(state, 'a', client, 'Johnny');
  const leftovers = (r.text + ' ' + r.subject).match(/\{\w+\}|\[[A-Z][^\]]*\]/g);
  assert.deepStrictEqual(leftovers, ['[PASTE THE RIGHT PACKAGE LINK HERE]'],
    'the placeholder must be detectable: ' + r.text);
});

test('the contact modal offers one button per email, each a real Gmail link', () => {
  /* "I just booked Caitlin, send her the before-call email" is one thought,
     and it was four actions: find her, open the picker, read the list,
     choose. The library IS the list of buttons, so a new email appears there
     the moment it is written and nothing has to be wired up. */
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.senderName = 'Johnny';
    STATE.myCalendars = ['john@marketmakermgmt.com'];
    STATE.emailLibrary = [
      {id:'a', title:'Before the call - what we do', whenToSend:'after they book',
       subject:'Excited to chat {date}', body:'Hey {name}, looking forward to it.', sortOrder:0},
      {id:'b', title:'Post-call recap', whenToSend:'same day',
       subject:'Great talking', body:'Hi {name}, here is what we covered.', sortOrder:10}
    ];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Caitlin Reed', phone:'2135550100',
      email:'caitlin@example.com', timezone:'America/New_York', status:'Booked',
      callDateTime: new Date(Date.now() + 4*86400000).toISOString()});
  `, ctx);
  const html = vm.runInContext("emailButtonsHtml(STATE.clients['c1'])", ctx);

  assert.ok(html.includes('Before the call - what we do'), 'a button per email: ' + html.slice(0, 200));
  assert.ok(html.includes('Post-call recap'));
  assert.ok(html.includes('mail.google.com'), 'each must be a real compose link');
  assert.ok(html.includes('authuser=john%40marketmakermgmt.com'),
    'and must open the business account, not whichever Gmail was last used');
  assert.ok(html.includes('Caitlin'), 'filled in for this contact');
  assert.ok(!/\{name\}/.test(html), 'placeholders must be rendered, never shipped raw');
  assert.ok(/data-action="sent-by-email"/.test(html), 'and the send must still be logged');
});

test('a contact with no email address is told why, not shown dead buttons', () => {
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.emailLibrary = [{id:'a', title:'X', subject:'s', body:'b', sortOrder:0}];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'NoMail', phone:'2135550100'});
  `, ctx);
  const html = vm.runInContext("emailButtonsHtml(STATE.clients['c1'])", ctx);
  assert.ok(!/mail\.google\.com/.test(html), 'no compose link that cannot work');
  assert.ok(/No email address/.test(html), 'say why: ' + html);
});

test('an empty library points at where emails live rather than showing nothing', () => {
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.emailLibrary = [];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Dana', phone:'2135550100', email:'d@e.com'});
  `, ctx);
  const html = vm.runInContext("emailButtonsHtml(STATE.clients['c1'])", ctx);
  assert.ok(/Emails tab/.test(html), html);
});

test('the contact modal still renders end to end with the buttons in it', () => {
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.emailLibrary = [{id:'a', title:'X', whenToSend:'now', subject:'s', body:'Hi {name}', sortOrder:0}];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Dana', phone:'2135550100',
      email:'d@e.com', timezone:'America/New_York', status:'Booked',
      callDateTime: new Date(Date.now() + 86400000).toISOString()});
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext("openClientModal('c1')", ctx));
});

test('an email pinned to a touch is what that touch sends', () => {
  /* Sending a text is one tap. Email cost two extra clicks because every send
     went through the picker, and in practice the same email goes out for the
     same touch nearly every time. Re-making a decision you have already made
     is the friction that stops a channel being used. */
  const state = {emailLibrary: [
    {id: 'a', title: 'Pricing breakdown', body: 'x', sortOrder: 0},
    {id: 'b', title: 'Day of', body: 'y', touch: 'dayof', sortOrder: 10},
  ]};
  assert.strictEqual(GB.emailForTouch(state, 'dayof').title, 'Day of');
  assert.strictEqual(GB.emailForTouch(state, 'welcome'), null,
    'an unpinned touch must fall back to the picker, not to an arbitrary email');
  assert.strictEqual(GB.emailForTouch(state, ''), null);
  assert.strictEqual(GB.emailForTouch({emailLibrary: []}, 'dayof'), null);
});

test('two emails pinned to one touch resolve the same way every time', () => {
  // Library order decides, so the answer is stable rather than whichever row
  // the database happened to return first.
  const state = {emailLibrary: [
    {id: 'b', title: 'Second', body: 'y', touch: 'dayof', sortOrder: 20},
    {id: 'a', title: 'First', body: 'x', touch: 'dayof', sortOrder: 10},
  ]};
  assert.strictEqual(GB.emailForTouch(state, 'dayof').title, 'First');
});

test('the pin survives a round trip through the sanitizer', () => {
  assert.strictEqual(GB.sanitizeEmailDoc({title: 'x', body: 'y', touch: 'dayof'}).touch, 'dayof');
  assert.strictEqual(GB.sanitizeEmailDoc({title: 'x', body: 'y'}).touch, '');
  assert.strictEqual(GB.sanitizeEmailDoc({title: 'x', body: 'y', touch: 42}).touch, '');
});

test('a deleted entry renders as nothing, not as a blank email', () => {
  // So the caller can say "that email is gone" instead of opening an empty
  // compose window addressed to a real client.
  assert.strictEqual(GB.renderEmailDoc({emailLibrary: []}, 'gone', {name:'Dana'}, 'J'), null);
});

test('the export is readable, and keeps the placeholders visible', () => {
  const state = {emailLibrary: [
    {id:'a', title:'Pricing breakdown', whenToSend:'after they ask what it costs',
     subject:'The numbers', body:'Hi {name},\n\nHere is the breakdown.'},
    {id:'b', title:'Post-call recap', whenToSend:'same day as the call',
     subject:'Recap', body:'Good talking today.', sortOrder:10},
  ]};
  const out = GB.exportEmailLibrary(state, {businessName:'MarketMakerMGMT'});
  assert.ok(out.includes('MarketMakerMGMT'));
  assert.ok(out.includes('2 emails'));
  assert.ok(out.includes('Pricing breakdown'));
  assert.ok(out.includes('after they ask what it costs'), 'the timing note is the most useful line in the file');
  assert.ok(out.includes('{name}'), 'a rendered export would be one contact\'s mail, not the template set');
  assert.ok(out.indexOf('Pricing breakdown') < out.indexOf('Post-call recap'), 'export follows the library order');
});

test('exporting an empty library says so rather than handing over a blank file', () => {
  const out = GB.exportEmailLibrary({emailLibrary: []});
  assert.ok(/empty/i.test(out));
});

test('a downloaded file has a name findable in a Downloads folder', () => {
  const n = GB.exportFilename('MarketMakerMGMT emails', '2026-09-30T12:00:00Z');
  assert.strictEqual(n, 'marketmakermgmt-emails-2026-09-30.txt');
  // Nothing a filesystem will argue about.
  assert.ok(!/[^a-z0-9.-]/.test(GB.exportFilename('Pricing: 50% / “final”')));
  assert.ok(GB.exportFilename('').startsWith('ghostbuster-'));
});

console.log('\n--- your emails, GhostBuster’s timing ---');

test('the unattended sender will not mail a built-in template', () => {
  // A business should never discover that software has been sending its own
  // words to its customers.
  const c = freshClient({callDateTime: isoDaysFromNow(2)});
  assert.strictEqual(GB.getAuthoredEmailDraft({emailVariants:{}}, c, 'welcome', 'Johnny'), null);
  const builtinOnly = {emailVariants:{welcome:[{id:'ew1', subject:'s', text:'t', builtin:true}]}};
  assert.strictEqual(GB.getAuthoredEmailDraft(builtinOnly, c, 'welcome', 'Johnny'), null,
    'shipping a default is not the same as a business choosing to send it');
});

test('an email written by hand is used', () => {
  const c = freshClient({callDateTime: isoDaysFromNow(2)});
  const written = {emailVariants:{welcome:[
    {id:'own-welcome', subject:'Confirmed for {date}', text:'Hi {name}, see you {date}.', builtin:false}]}};
  const d = GB.getAuthoredEmailDraft(written, c, 'welcome', 'Johnny');
  assert.ok(d);
  assert.ok(!d.subject.includes('{') && !d.text.includes('{'), 'placeholders must render');
  assert.ok(d.text.startsWith('Hi Jane'), 'got: ' + d.text);
});

test('an empty template does not count as written', () => {
  const c = freshClient({});
  const blank = {emailVariants:{welcome:[{id:'own-welcome', subject:'x', text:'   ', builtin:false}]}};
  assert.strictEqual(GB.getAuthoredEmailDraft(blank, c, 'welcome', 'Johnny'), null,
    'a half-started draft must not go out automatically');
});

test('manual sending still offers the examples', () => {
  // A person reads the draft before it goes, so a starting point is helpful
  // there and dangerous unattended.
  const c = freshClient({callDateTime: isoDaysFromNow(1), meetLink:'https://meet.google.com/a-b-c'});
  assert.ok(GB.getEmailDraft(GB.buildDefaultState(), c, 'dayof', 'Johnny'));
});

test('every editable stage says when it sends, in words', () => {
  GB.emailEditableStages().forEach(stage => {
    const t = GB.stageTiming(stage);
    assert.ok(t && t !== 'custom trigger',
      stage + ' has no plain-English timing, so nobody can write the right email for it');
    assert.ok(!/trigger|repeat_while_role|anchor/.test(t), stage + ' leaks jargon: ' + t);
  });
});

test('the timing follows the cadence rather than being written down twice', () => {
  const before = GB.stageTiming('monday');
  withSequence(GB.buildDefaultSequence().filter(s => s.key !== 'monday'), () => {
    assert.notStrictEqual(GB.stageTiming('monday'), before,
      'a label that keeps describing a removed touch is worse than no label');
  });
});

test('the editor covers every touch the cadence can send', () => {
  const stages = GB.emailEditableStages();
  GB.buildDefaultSequence().forEach(step => {
    assert.ok(stages.includes(step.stage), 'no way to write an email for ' + step.stage);
  });
  ['rebooked','followup'].forEach(st =>
    assert.ok(stages.includes(st), st + ' fires in place of welcome and needs its own email'));
});

console.log('\n--- a bounced address is a stop, not a retry ---');

test('a healthy address can be emailed', () => {
  assert.strictEqual(GB.canEmail(freshClient({email:'a@b.com'})), true);
  assert.strictEqual(GB.canEmail(freshClient({email:'a@b.com', emailStatus:'ok'})), true);
});

test('bounced and complained addresses cannot', () => {
  // Continuing to mail a dead box is how a sending domain's reputation goes,
  // and that failure is not contained to one contact.
  assert.strictEqual(GB.canEmail(freshClient({email:'a@b.com', emailStatus:'bounced'})), false);
  assert.strictEqual(GB.canEmail(freshClient({email:'a@b.com', emailStatus:'complained'})), false);
  assert.strictEqual(GB.canEmail(freshClient({email:'a@b.com', emailStatus:'unsubscribed'})), false);
});

test('no address at all is not emailable either', () => {
  assert.strictEqual(GB.canEmail(freshClient({email:''})), false);
  assert.strictEqual(GB.canEmail(null), false);
});

test('contacts default to emailable, so nothing existing is silently blocked', () => {
  const c = GB.sanitizeClient({id:'x', name:'X', phone:'2135550100', email:'a@b.com'});
  assert.strictEqual(c.emailStatus, 'ok');
  assert.strictEqual(GB.canEmail(c), true);
});

{
  const hook = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', 'email-webhook', 'index.ts'), 'utf8');

  test('the webhook refuses to act without a verified signature', () => {
    // An unverified webhook is an open endpoint that can mark any contact as
    // having replied, or blacklist any address.
    assert.ok(hook.includes('RESEND_WEBHOOK_SECRET'), 'must require a signing secret');
    assert.ok(/if \(!WEBHOOK_SECRET\)/.test(hook), 'and refuse outright when it is absent');
    assert.ok(hook.includes('wh.verify('), 'must verify, not merely receive');
    assert.ok(hook.includes('Signature did not verify'), 'and reject on failure');
  });

  test('it records the raw payload before interpreting anything', () => {
    const logAt = hook.indexOf("/email_events");
    const actAt = hook.indexOf("email.delivered");
    assert.ok(logAt > 0 && logAt < actAt,
      'attribution involves judgement, so the evidence must be kept first');
  });

  test('a bounce stops future sending rather than just noting the failure', () => {
    assert.ok(hook.includes("email_status: status === 'bounced'"),
      'marking the message is not enough; the address has to be taken out of use');
  });

  test('a reply marks the message reviewed, not just answered', () => {
    // The whole point: a reply GhostBuster saw itself needs no human
    // confirmation afterwards.
    assert.ok(/responded: true/.test(hook) && /reviewed: true/.test(hook));
  });

  test('an unrecognised sender is logged and ignored, not guessed at', () => {
    assert.ok(hook.includes('sender not recognised'),
      'attributing a reply to the wrong contact teaches the bandit the wrong lesson');
  });
}

console.log('\n--- clearing an old backlog honestly ---');

function staleState(){
  const st = GB.buildDefaultState();
  st.clients['old1'] = freshClient({id:'old1', name:'Old1', phone:'2135550001', status:'Booked',
    bookedDate: isoDaysAgo(120), callDateTime: isoDaysAgo(60)});
  st.clients['old2'] = freshClient({id:'old2', name:'Old2', phone:'2135550002', status:'Booked',
    bookedDate: isoDaysAgo(120), callDateTime: isoDaysAgo(45)});
  st.clients['recent'] = freshClient({id:'recent', name:'Recent', phone:'2135550003', status:'Booked',
    bookedDate: isoDaysAgo(20), callDateTime: isoDaysAgo(3)});
  return st;
}

test('only the genuinely old ones are batched', () => {
  const st = staleState();
  const res = GB.resolveStaleCalls(st, 'archive', 30, new Date());
  assert.strictEqual(res.count, 2, 'a call from three days ago is still worth answering properly');
  assert.strictEqual(st.clients['recent'].ignored, false);
});

test('archiving asserts nothing about what happened', () => {
  const st = staleState();
  GB.resolveStaleCalls(st, 'archive', 30, new Date());
  assert.strictEqual(st.clients['old1'].ignored, true);
  assert.ok(!GB.isWon(st.clients['old1'].status) && !GB.isMissed(st.clients['old1'].status),
    'archiving must not invent an outcome — unknown stays unknown');
});

test('archived calls stay out of the show rate rather than dragging it down', () => {
  const st = staleState();
  st.clients['good'] = freshClient({id:'good', name:'Good', phone:'2135550004',
    status:'Completed', callDateTime: isoDaysAgo(10)});
  const before = GB.computeStats(st, 'all', new Date()).showUpRate;
  GB.resolveStaleCalls(st, 'archive', 30, new Date());
  const after = GB.computeStats(st, 'all', new Date()).showUpRate;
  assert.strictEqual(before, after,
    'they were already excluded as unknown; archiving should not move the number');
});

test('marking them no-show does move the number, which is why it is a choice', () => {
  const st = staleState();
  st.clients['good'] = freshClient({id:'good', name:'Good', phone:'2135550004',
    status:'Completed', callDateTime: isoDaysAgo(10)});
  const before = GB.computeStats(st, 'all', new Date()).showUpRate;
  GB.resolveStaleCalls(st, 'noshow', 30, new Date());
  const after = GB.computeStats(st, 'all', new Date()).showUpRate;
  assert.ok(after < before, 'asserting a guess changes the statistic, so the user has to make it');
});

test('a batch answer lands exactly like a manual one', () => {
  const st = staleState();
  st.pendingEvents = [];
  GB.resolveStaleCalls(st, 'showed', 30, new Date());
  assert.ok(GB.isWon(st.clients['old1'].status));
  assert.ok(st.pendingEvents.some(e => e.kind === 'outcome.logged'),
    'must route through setOutcome, not write status directly');
});

test('clearing the backlog empties the prompt', () => {
  const st = staleState();
  assert.strictEqual(GB.getUnloggedCalls(st, new Date()).length, 3);
  GB.resolveStaleCalls(st, 'archive', 30, new Date());
  assert.strictEqual(GB.getUnloggedCalls(st, new Date()).length, 1, 'only the recent one is left');
});

console.log('\n--- the analytics agree with each other ---');

test('the unlogged count matches the list it links to', () => {
  // The stat card links straight to the prompt; if they use different rules
  // the number promises work the list does not contain.
  const st = GB.buildDefaultState();
  const mk = (id, status) => { st.clients[id] = freshClient({id, name:id, phone:'21355500'+id,
    bookedDate: isoDaysAgo(30), callDateTime: isoDaysAgo(4), status}); };
  mk('1','Booked'); mk('2','Completed'); mk('3','No-show');
  mk('4','Rescheduled'); mk('5','Ghosted');
  const s = GB.computeStats(st, 'all', new Date());
  assert.strictEqual(s.unloggedCalls, GB.getUnloggedCalls(st, new Date()).length,
    'the stat and the prompt must count the same thing');
  assert.strictEqual(s.unloggedCalls, 1, 'only the one still on an open stage');
});

test('a custom pipeline keeps its statuses through a load', () => {
  // These were being rewritten to 'Booked' on every load, silently destroying
  // an entire book's outcomes each time the app opened.
  withPipeline(HVAC_PIPELINE, () => {
    HVAC_PIPELINE.forEach(stage => {
      const c = GB.sanitizeClient({id:'x', name:'X', phone:'2135550100', status: stage.key});
      assert.strictEqual(c.status, stage.key, stage.key + ' was rewritten on load');
    });
  });
});

test('an unrecognised status is preserved, not replaced', () => {
  const c = GB.sanitizeClient({id:'x', name:'X', phone:'2135550100', status:'Some Renamed Stage'});
  assert.strictEqual(c.status, 'Some Renamed Stage',
    'renaming a stage must not erase it from every contact sitting on it');
});

test('a new contact starts on the configured pipeline, not the agency default', () => {
  withPipeline(HVAC_PIPELINE, () => {
    assert.strictEqual(GB.defaultOpenStage(), 'New Inquiry');
    const c = GB.sanitizeClient({id:'x', name:'X', phone:'2135550100'});
    assert.strictEqual(c.status, 'New Inquiry');
  });
  assert.strictEqual(GB.defaultOpenStage(), 'Booked');
});

test('the status filter list follows the active pipeline', () => {
  withPipeline(HVAC_PIPELINE, () => {
    assert.ok(GB.VALID_STATUSES.includes('Estimate Completed'));
    assert.ok(!GB.VALID_STATUSES.includes('Completed'),
      'showing another business’s stages as filters is worse than useless');
  });
  assert.ok(GB.VALID_STATUSES.includes('Completed'), 'and restored afterwards');
});

test('a custom stalled stage still sets the recovery anchor', () => {
  // Without stalledSince the recovery sequence never fires at all, silently.
  withPipeline(HVAC_PIPELINE, () => {
    const st = GB.buildDefaultState();
    st.clients['a'] = freshClient({id:'a', phone:'2135550100', status:'New Inquiry'});
    GB.setOutcome(st, 'a', 'Awaiting Decision');
    assert.ok(st.clients['a'].stalledSince, 'no anchor means no recovery nudges, ever');
  });
});

test('a custom pipeline reaches the Graveyard, and so the slow lane', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const st = GB.buildDefaultState();
    st.clients['a'] = freshClient({id:'a', name:'A', phone:'2135550100', status:'Missed Estimate',
      bookedDate: isoDaysAgo(90), callDateTime: isoDaysAgo(60)});
    assert.strictEqual(GB.computeDeadClients(st, new Date()).length, 1,
      'otherwise these contacts are never nurtured either');
  });
});

console.log('\n--- whose lead is it ---');

const mine = ['john@marketmakermgmt.com'];

test('a booking organized by a teammate is not yours to follow up', () => {
  const c = freshClient({organizerEmail:'ethan.m@marketmakermgmt.com'});
  assert.strictEqual(GB.isOthersLead(c, mine), true);
});

test('your own bookings stay yours', () => {
  assert.strictEqual(GB.isOthersLead(freshClient({organizerEmail:'john@marketmakermgmt.com'}), mine), false);
  assert.strictEqual(GB.isOthersLead(freshClient({organizerEmail:'JOHN@MarketMakerMGMT.com'}), mine), false,
    'address comparison must not be case sensitive');
});

test('an unknown organizer is left alone rather than guessed at', () => {
  // Being wrong here means either texting another rep's client or silently
  // dropping your own.
  assert.strictEqual(GB.isOthersLead(freshClient({organizerEmail:null}), mine), false);
  assert.strictEqual(GB.isOthersLead(freshClient({organizerEmail:''}), mine), false);
});

test('with no connected calendar nothing is misfiled', () => {
  const c = freshClient({organizerEmail:'someone@else.com'});
  assert.strictEqual(GB.isOthersLead(c, []), false);
  assert.strictEqual(GB.isOthersLead(c, undefined), false);
});

test('it compares against the calendar, not the login', () => {
  // These accounts sign in personally and organize from a work address;
  // comparing against the login would misfile every one of their own contacts.
  const c = freshClient({organizerEmail:'john@marketmakermgmt.com'});
  assert.strictEqual(GB.isOthersLead(c, ['delutrijohnny@gmail.com']), true,
    'wrong identity, wrong answer — which is why myCalendars is what is passed');
  assert.strictEqual(GB.isOthersLead(c, mine), false);
});

test("a teammate's lead never reaches the send queue or the ranked list", () => {
  const st = GB.buildDefaultState();
  st.myCalendars = mine;
  st.clients['theirs'] = freshClient({id:'theirs', name:'Theirs', phone:'2135550001',
    organizerEmail:'tessa@marketmakermgmt.com',
    bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  st.clients['mine'] = freshClient({id:'mine', name:'Mine', phone:'2135550002',
    organizerEmail:'john@marketmakermgmt.com',
    bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  const queued = GB.getTextTodayList(st, new Date(), '').map(i => i.client.id);
  assert.deepStrictEqual(queued, ['mine']);
  const ranked = GB.rankByGhostScore(st, new Date(), {min:0}).map(r => r.client.id);
  assert.ok(!ranked.includes('theirs'), 'nor should it be ranked for attention');
});

console.log('\n--- nobody falls out of the follow-up ---');

test('a cold lead still gets a monthly nudge instead of silence', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({
    id:'cold', phone:'2135550001', status:'Ghosted',
    callDateTime: isoDaysAgo(120), bookedDate: isoDaysAgo(150),
    stalledSince: isoDaysAgo(120),
    messageLog:[{stage:'recovery',variantId:'r1',text:'x',sentAt: isoDaysAgo(40),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  st.clients['cold'] = c;
  const items = GB.getTextTodayList(st, new Date(), '');
  assert.strictEqual(items.length, 1, 'a lead in the Graveyard must not vanish from the list');
  assert.strictEqual(items[0].stage, 'revival');
});

test('the Graveyard gets the slow lane only, never the intensive chase', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({
    id:'cold', phone:'2135550001', status:'Ghosted',
    callDateTime: isoDaysAgo(90), bookedDate: isoDaysAgo(120),
    stalledSince: isoDaysAgo(90),
    messageLog:[{stage:'recovery',variantId:'r1',text:'x',sentAt: isoDaysAgo(40),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  st.clients['cold'] = c;
  // computeDue alone would still offer recovery; the list is what narrows it.
  assert.ok(GB.computeDue(c, new Date()).includes('recovery'));
  const stages = GB.getTextTodayList(st, new Date(), '').map(i => i.stage);
  assert.deepStrictEqual(stages, ['revival'], 'weekly chasing of a cold lead is what makes it spam');
});

test('it waits a month between nudges, not days', () => {
  const recent = freshClient({
    status:'Ghosted', stalledSince: isoDaysAgo(90), callDateTime: isoDaysAgo(90),
    messageLog:[{stage:'revival',variantId:'v1',text:'x',sentAt: isoDaysAgo(9),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(!GB.computeDue(recent, new Date()).includes('revival'),
    'nine days after the last nudge is pestering, not nurture');
  const due = freshClient({
    status:'Ghosted', stalledSince: isoDaysAgo(90), callDateTime: isoDaysAgo(90),
    messageLog:[{stage:'revival',variantId:'v1',text:'x',sentAt: isoDaysAgo(35),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(GB.computeDue(due, new Date()).includes('revival'));
});

test('someone who bought is left alone', () => {
  const c = freshClient({
    status:'Completed', closeOutcome:'Closed',
    callDateTime: isoDaysAgo(120), bookedDate: isoDaysAgo(150),
    messageLog:[{stage:'dayof',variantId:'d1',text:'x',sentAt: isoDaysAgo(120),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('revival'),
    'nurturing a customer who already bought is how a sequence becomes spam');
});

test('a call that happened but never closed does get nurtured', () => {
  const c = freshClient({
    status:'Completed', closeOutcome: undefined,
    callDateTime: isoDaysAgo(120), bookedDate: isoDaysAgo(150),
    messageLog:[{stage:'dayof',variantId:'d1',text:'x',sentAt: isoDaysAgo(120),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(GB.computeDue(c, new Date()).includes('revival'),
    'they showed up and never bought — that is the definition of a lead worth keeping');
});

test('the nudge is measured from the last contact, whatever it was', () => {
  // Anchoring to the appointment would keep firing on a fixed grid regardless
  // of whether someone was messaged yesterday.
  const c = freshClient({
    status:'Ghosted', stalledSince: isoDaysAgo(200), callDateTime: isoDaysAgo(200),
    messageLog:[{stage:'recovery',variantId:'r1',text:'x',sentAt: isoDaysAgo(2),
                 responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('revival'),
    'someone messaged two days ago has not been forgotten');
});

test('a reply still pauses the slow lane', () => {
  const c = freshClient({
    status:'Ghosted', stalledSince: isoDaysAgo(90), callDateTime: isoDaysAgo(90),
    messageLog:[{stage:'revival',variantId:'v1',text:'x',sentAt: isoDaysAgo(35),
                 responded:true, respondedAt: isoDaysAgo(1), reviewed:true}]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('revival'),
    'they wrote back — a person owes them a person');
});

test('every revival message makes it easy to say no', () => {
  // A nurture text that is hard to refuse stops being nurture.
  GB.buildDefaultVariants().revival.forEach(v => {
    assert.ok(/no hard feelings|a no both work|no all work|just say|leave you be|stop bugging|or a no/i.test(v.text),
      'revival variant ' + v.id + ' gives no easy way out: ' + v.text);
  });
});

test('the slow lane trickles instead of dumping the backlog', () => {
  const st = GB.buildDefaultState();
  for(let i = 0; i < 20; i++){
    st.clients['c'+i] = freshClient({
      id:'c'+i, name:'C'+i, phone:'21355500' + String(i).padStart(2,'0'),
      status:'Ghosted', stalledSince: isoDaysAgo(100 + i), callDateTime: isoDaysAgo(100 + i),
      bookedDate: isoDaysAgo(160),
      messageLog:[{stage:'recovery',variantId:'r1',text:'x',sentAt: isoDaysAgo(60 + i),
                   responded:false, respondedAt:null, reviewed:true}]
    });
  }
  const revivals = GB.getTextTodayList(st, new Date(), '').filter(i => i.stage === 'revival');
  assert.strictEqual(revivals.length, GB.REVIVAL_DAILY_CAP,
    'twenty at once is a mail merge, not nurture');
});

test('the longest silences are reached first', () => {
  const st = GB.buildDefaultState();
  st.clients['recent'] = freshClient({
    id:'recent', name:'Recent', phone:'2135550001', status:'Ghosted',
    stalledSince: isoDaysAgo(100), callDateTime: isoDaysAgo(100), bookedDate: isoDaysAgo(160),
    messageLog:[{stage:'recovery',variantId:'r1',text:'x',sentAt: isoDaysAgo(35),
                 responded:false, respondedAt:null, reviewed:true}]});
  for(let i = 0; i < 8; i++){
    st.clients['old'+i] = freshClient({
      id:'old'+i, name:'Old'+i, phone:'21355510' + String(i).padStart(2,'0'), status:'Ghosted',
      stalledSince: isoDaysAgo(300), callDateTime: isoDaysAgo(300), bookedDate: isoDaysAgo(360),
      messageLog:[{stage:'recovery',variantId:'r1',text:'x',sentAt: isoDaysAgo(200 + i),
                   responded:false, respondedAt:null, reviewed:true}]});
  }
  const names = GB.getTextTodayList(st, new Date(), '')
    .filter(i => i.stage === 'revival').map(i => i.client.name);
  assert.ok(!names.includes('Recent'),
    'the one contacted five weeks ago can wait behind the ones silent for months');
});

console.log('\n--- skipping a touch for good ---');

test('a skipped touch never comes back', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({id:'a', phone:'2135550001', bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  st.clients['a'] = c;
  assert.ok(GB.computeDue(c, new Date()).includes('welcome'));
  GB.skipTouch(st, 'a', 'welcome');
  assert.ok(!GB.computeDue(c, new Date()).includes('welcome'));
  // and still gone a fortnight later, unlike a snooze
  const later = new Date(Date.now() + 14 * 86400000);
  assert.ok(!GB.computeDue(c, later).includes('welcome'),
    'a skip is an answer, not a deferral');
});

test('skipping one touch leaves the rest of the cadence alone', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({id:'a', phone:'2135550001', bookedDate: isoDaysAgo(9), callDateTime: isoDaysFromNow(2)});
  st.clients['a'] = c;
  const before = GB.computeDue(c, new Date());
  assert.ok(before.length > 1, 'fixture should have several due');
  GB.skipTouch(st, 'a', before[0]);
  const after = GB.computeDue(c, new Date());
  assert.ok(!after.includes(before[0]));
  assert.ok(after.length === before.length - 1, 'only the skipped one goes');
});

test('skipping sends nothing and credits no variant', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({id:'a', phone:'2135550001', bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  st.clients['a'] = c;
  GB.skipTouch(st, 'a', 'welcome');
  assert.strictEqual(c.messageLog.length, 0, 'nothing was sent, so nothing is logged');
  const stats = st.variantStats.welcome || {};
  assert.ok(Object.keys(stats).every(k => stats[k].sends === 0),
    'a message never sent must not count toward what the templates are measured on');
});

test('a skip is recorded so it is auditable, not a silent gap', () => {
  const st = GB.buildDefaultState();
  st.clients['a'] = freshClient({id:'a', phone:'2135550001', callDateTime: isoDaysFromNow(5)});
  st.pendingEvents = [];
  GB.skipTouch(st, 'a', 'monday');
  const ev = st.pendingEvents.find(e => e.kind === 'touch.skipped');
  assert.ok(ev && ev.data.stage === 'monday');
});

test('a skip can be undone', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({id:'a', phone:'2135550001', bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  st.clients['a'] = c;
  GB.skipTouch(st, 'a', 'welcome');
  GB.unskipTouch(st, 'a', 'welcome');
  assert.ok(GB.computeDue(c, new Date()).includes('welcome'));
});

test('old data with no skippedStages loads without throwing', () => {
  const c = GB.sanitizeClient({id:'old', name:'Old', phone:'2135550001'});
  assert.deepStrictEqual(c.skippedStages, {});
  assert.doesNotThrow(() => GB.computeDue(c, new Date()));
});

test('a snooze still expires — the two are different tools', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({id:'a', phone:'2135550001', bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  st.clients['a'] = c;
  GB.snoozeTouch(st, 'a', 'welcome', new Date());
  assert.ok(!GB.computeDue(c, new Date()).includes('welcome'), 'gone today');
  const tomorrow = new Date(Date.now() + 2 * 86400000);
  assert.ok(GB.computeDue(c, tomorrow).includes('welcome'), 'and back afterwards');
});

console.log('\n--- unlogged outcomes are visible, not silent ---');

test('an unlogged call is unknown, never counted as a no-show', () => {
  const st = GB.buildDefaultState();
  st.clients['showed'] = freshClient({id:'showed', phone:'2135550001', status:'Completed', callDateTime: isoDaysAgo(3)});
  st.clients['missed'] = freshClient({id:'missed', phone:'2135550002', status:'No-show', callDateTime: isoDaysAgo(3)});
  st.clients['unknown'] = freshClient({id:'unknown', phone:'2135550003', status:'Booked', callDateTime: isoDaysAgo(3)});
  const s = GB.computeStats(st, 'all', new Date());
  assert.strictEqual(s.showUpRate, 0.5, 'the rate is over the two that were answered');
  assert.strictEqual(s.unloggedCalls, 1, 'and the third is reported, not swallowed');
});

test('the show rate asks the role, so a custom pipeline is not miscounted', () => {
  withPipeline(HVAC_PIPELINE, () => {
    const st = GB.buildDefaultState();
    st.clients['a'] = freshClient({id:'a', phone:'2135550001', status:'Estimate Completed', callDateTime: isoDaysAgo(2)});
    st.clients['b'] = freshClient({id:'b', phone:'2135550002', status:'Missed Estimate', callDateTime: isoDaysAgo(2)});
    const s = GB.computeStats(st, 'all', new Date());
    assert.strictEqual(s.showUpRate, 0.5,
      'a "Missed Estimate" is a no-show; matching the literal string would have shown 100%');
  });
});

test('getUnloggedCalls finds exactly the calls owed an answer', () => {
  const st = GB.buildDefaultState();
  st.clients['past-open']  = freshClient({id:'past-open', phone:'2135550001', status:'Booked', callDateTime: isoDaysAgo(5)});
  st.clients['past-done']  = freshClient({id:'past-done', phone:'2135550002', status:'Completed', callDateTime: isoDaysAgo(5)});
  st.clients['past-missed']= freshClient({id:'past-missed', phone:'2135550003', status:'No-show', callDateTime: isoDaysAgo(5)});
  st.clients['future']     = freshClient({id:'future', phone:'2135550004', status:'Booked', callDateTime: isoDaysFromNow(3)});
  st.clients['no-date']    = freshClient({id:'no-date', phone:'2135550005', status:'Booked', callDateTime: null});
  st.clients['archived']   = freshClient({id:'archived', phone:'2135550006', status:'Booked', callDateTime: isoDaysAgo(5), ignored:true});
  const ids = GB.getUnloggedCalls(st, new Date()).map(x => x.client.id);
  assert.deepStrictEqual(ids, ['past-open'],
    'only a past appointment still sitting on an open stage is owed an outcome');
});

test('a stalled or lost contact is not owed an outcome', () => {
  // "Rescheduled" and "Ghosted" are answers: they say the appointment is not
  // happening. Asking again would be nagging about a question already settled.
  const st = GB.buildDefaultState();
  st.clients['r'] = freshClient({id:'r', phone:'2135550001', status:'Rescheduled', callDateTime: isoDaysAgo(4)});
  st.clients['g'] = freshClient({id:'g', phone:'2135550002', status:'Ghosted', callDateTime: isoDaysAgo(4)});
  assert.strictEqual(GB.getUnloggedCalls(st, new Date()).length, 0);
});

test('the oldest come first, because those do the most damage', () => {
  const st = GB.buildDefaultState();
  st.clients['recent'] = freshClient({id:'recent', phone:'2135550001', status:'Booked', callDateTime: isoDaysAgo(2)});
  st.clients['ancient'] = freshClient({id:'ancient', phone:'2135550002', status:'Booked', callDateTime: isoDaysAgo(40)});
  const out = GB.getUnloggedCalls(st, new Date());
  assert.strictEqual(out[0].client.id, 'ancient');
  assert.strictEqual(out[0].daysAgo, 40);
});

test('answering one removes it from the list', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({id:'a', phone:'2135550001', status:'Booked', callDateTime: isoDaysAgo(6)});
  st.clients['a'] = c;
  assert.strictEqual(GB.getUnloggedCalls(st, new Date()).length, 1);
  GB.setOutcome(st, 'a', 'Showed');
  assert.strictEqual(GB.getUnloggedCalls(st, new Date()).length, 0);
});

console.log('\n--- the run-up stops at the appointment ---');

test('a welcome is never queued for a call that already happened', () => {
  // Reported from the live app: welcome texts sitting in the morning list for
  // contacts whose call was weeks ago, promising to meet them on a date that
  // had already passed.
  const c = freshClient({
    bookedDate: isoDaysAgo(30),
    callDateTime: isoDaysAgo(21),
    status: 'Booked'          // nobody ever logged an outcome
  });
  assertDue(GB.computeDue(c, new Date()), [],
    'the run-up is over; this belongs in End of day as overdue and unlogged');
});

test('stopCadence alone does not cover it', () => {
  // The old guard only fired once someone recorded an outcome, and the whole
  // problem is the contacts nobody recorded one for.
  const c = freshClient({bookedDate: isoDaysAgo(30), callDateTime: isoDaysAgo(21), status: 'Booked'});
  assert.strictEqual(GB.stopsCadence(c.status), false, 'the status is still open');
  assertDue(GB.computeDue(c, new Date()), [], 'and yet nothing should be queued');
});

test('every run-up touch stops, not just the welcome', () => {
  const past = {bookedDate: isoDaysAgo(40), callDateTime: isoDaysAgo(10), status:'Booked'};
  ['welcome','monday','midcheckin','dayof','hourbefore'].forEach(stage => {
    const c = freshClient(Object.assign({}, past, {
      messageLog: ['welcome','monday','midcheckin','dayof','hourbefore']
        .filter(x => x !== stage)
        .map(x => ({stage:x, variantId:'x', text:'x', sentAt: isoDaysAgo(20),
                    responded:false, respondedAt:null, reviewed:true}))
    }));
    assert.ok(!GB.computeDue(c, new Date()).includes(stage),
      stage + ' should not fire after the appointment');
  });
});

test('the rescue sequences still run after the call — that is their whole point', () => {
  const missed = freshClient({status:'No-show', callDateTime: isoDaysAgo(2), bookedDate: isoDaysAgo(20)});
  assert.ok(GB.computeDue(missed, new Date()).includes('noshow'),
    'a no-show rescue exists precisely because the appointment is over');
  const stalled = freshClient({status:'Ghosted', stalledSince: isoDaysAgo(6), callDateTime: isoDaysAgo(9)});
  assert.ok(GB.computeDue(stalled, new Date()).includes('recovery'));
});

test('a contact with no appointment yet still gets welcomed', () => {
  const c = freshClient({bookedDate: isoDaysAgo(1), callDateTime: null});
  assert.ok(GB.computeDue(c, new Date()).includes('welcome'),
    'no date is not the same as a date in the past');
});

test('a rescheduled call re-opens the run-up for the new date', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(40),
    callDateTime: isoDaysFromNow(3),      // moved forward
    reschedules: [isoDaysAgo(1)],
    status: 'Booked'
  });
  assert.ok(GB.computeDue(c, new Date()).length > 0,
    'the appointment is in the future again, so the run-up applies again');
});

test('a contact-anchored step is not blocked by a past appointment', () => {
  // days_after_create is about how long someone has been in the system, not
  // about a meeting.
  withSequence([{key:'chase', stage:'recovery', trigger:{type:'days_after_create', days:3}}], () => {
    const c = freshClient({bookedDate: isoDaysAgo(10), callDateTime: isoDaysAgo(5), status:'Booked'});
    assert.ok(GB.computeDue(c, new Date()).includes('recovery'),
      'a chase sequence should not be silenced by an old appointment');
  });
});

console.log('\n--- a reschedule restarts the appointment touches ---');

/* A fixed morning "now", so these read the same at 9am and at 5pm.

   These three tests put the appointment at 16:00 today and then passed the
   real clock as `now`. Which means they asserted "a day-of text is due" —
   true all morning, and correctly false from 16:00 onwards, because you do
   not send a day-of reminder after the call has happened. So the suite passed
   every morning and failed every afternoon.

   A suite that fails depending on the wall clock is worse than a missing
   test: it teaches you that a red run is probably nothing. The rest of the
   file already passes an explicit `now` for exactly this reason. */
const DAYOF_NOW = (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d; })();
const DAYOF_CALL = (() => { const d = new Date(); d.setHours(16, 0, 0, 0); return d.toISOString(); })();
// Earlier the same morning, so "already sent today" is unambiguous.
const DAYOF_SENT = (() => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.toISOString(); })();

test('a moved call gets a fresh day-of text', () => {
  // The live bug: a day-of text sent for the OLD date marked the stage sent
  // forever, so the new date never got one. 11 upcoming clients were stranded.
  const c = freshClient({
    bookedDate: isoDaysAgo(40),
    callDateTime: DAYOF_CALL,                       // 16:00 today, vs a 09:00 now
    reschedules: [isoDaysAgo(3)],
    messageLog: [{stage:'dayof',variantId:'d1',text:'x',sentAt: isoDaysAgo(30),
      responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(GB.computeDue(c, DAYOF_NOW).includes('dayof'),
    'a day-of text sent for a call a month ago must not block today’s');
});

test('but the same text sent since the move is not sent twice', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(40),
    callDateTime: DAYOF_CALL,
    reschedules: [isoDaysAgo(3)],
    messageLog: [{stage:'dayof',variantId:'d1',text:'x',sentAt: DAYOF_SENT,
      responded:false, respondedAt:null, reviewed:false}]
  });
  assert.ok(!GB.computeDue(c, DAYOF_NOW).includes('dayof'));
});

test('rescheduling does not make someone a stranger again', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(40), callDateTime: isoDaysFromNow(5),
    reschedules: [isoDaysAgo(1)],
    messageLog: [{stage:'welcome',variantId:'w1',text:'x',sentAt: isoDaysAgo(39),
      responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('welcome'),
    'the welcome is anchored to the contact, not the appointment');
});

test('a contact who never rescheduled behaves exactly as before', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(10),
    callDateTime: DAYOF_CALL,
    reschedules: [],
    messageLog: [{stage:'dayof',variantId:'d1',text:'x',sentAt: DAYOF_SENT,
      responded:false, respondedAt:null, reviewed:false}]
  });
  assert.ok(!GB.computeDue(c, DAYOF_NOW).includes('dayof'));
});

test('appointmentSetAt reads the most recent move', () => {
  const c = freshClient({reschedules: [isoDaysAgo(9), isoDaysAgo(4), isoDaysAgo(1)]});
  const at = GB.appointmentSetAt(c);
  assert.ok(Math.abs(at - Date.parse(isoDaysAgo(1))) < 1000, 'should use the latest reschedule');
  assert.strictEqual(GB.appointmentSetAt(freshClient({reschedules: []})), null);
});

console.log('\n--- recommended next action ---');

test('a reply means a person owes them a person', () => {
  const c = freshClient({messageLog:[{stage:'welcome',variantId:'w1',text:'x',
    sentAt: isoDaysAgo(2), responded:true, respondedAt: isoDaysAgo(1), reviewed:true}]});
  const rec = GB.recommendNextAction(c, new Date());
  assert.strictEqual(rec.action, 'reply');
});

test('minutes from the call, a text is too slow', () => {
  const c = freshClient({status:'Confirmed',
    callDateTime: new Date(Date.now() + 8 * 60000).toISOString()});
  const rec = GB.recommendNextAction(c, new Date());
  assert.strictEqual(rec.action, 'call');
  assert.ok(/minutes/.test(rec.why));
});

test('a due touch recommends sending that touch', () => {
  const c = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
  const rec = GB.recommendNextAction(c, new Date());
  assert.strictEqual(rec.action, 'text');
  assert.strictEqual(rec.stage, 'welcome');
});

test('after enough unanswered texts it switches channel instead', () => {
  const log = [];
  for(let i = GB.UNANSWERED_SWITCH_AT; i >= 1; i--){
    log.push({stage:'monday',variantId:'m1',text:'x',sentAt: isoDaysAgo(i + 1),
      responded:false, respondedAt:null, reviewed:true});
  }
  const c = freshClient({bookedDate: isoDaysAgo(10), callDateTime: isoDaysFromNow(5), messageLog: log});
  const rec = GB.recommendNextAction(c, new Date());
  assert.strictEqual(rec.action, 'call', 'texting has stopped working; got ' + JSON.stringify(rec));
  assert.ok(rec.stage, 'the due message should still be available underneath');
});

test('but an appointment reminder is never downgraded to a call', () => {
  const log = [];
  for(let i = 5; i >= 1; i--){
    log.push({stage:'monday',variantId:'m1',text:'x',sentAt: isoDaysAgo(i + 1),
      responded:false, respondedAt:null, reviewed:true});
  }
  const c = freshClient({bookedDate: isoDaysAgo(10),
    callDateTime: new Date(Date.now() + 45 * 60000).toISOString(), messageLog: log});
  const rec = GB.recommendNextAction(c, new Date());
  assert.strictEqual(rec.stage, 'hourbefore', 'the link still needs sending; got ' + JSON.stringify(rec));
});

test('unreviewed sends do not count toward the channel switch', () => {
  const log = [];
  for(let i = 5; i >= 1; i--){
    log.push({stage:'monday',variantId:'m1',text:'x',sentAt: isoDaysAgo(i + 1),
      responded:false, respondedAt:null, reviewed:false});
  }
  const c = freshClient({messageLog: log});
  assert.strictEqual(GB.consecutiveUnanswered(c), 0, 'nobody checked, so it is not evidence of silence');
});

test('a just-sent touch says wait rather than inventing work', () => {
  const c = freshClient({bookedDate: isoDaysAgo(10), callDateTime: isoDaysFromNow(20),
    messageLog:[{stage:'welcome',variantId:'w1',text:'x',
      sentAt: new Date(Date.now() - 3*3600000).toISOString(), responded:false, respondedAt:null, reviewed:false}]});
  const rec = GB.recommendNextAction(c, new Date());
  assert.strictEqual(rec.action, 'wait');
});

test('a high score with no scheduled touch left still gets an action', () => {
  // The failure this exists to prevent: the queue explains at length why
  // someone needs attention, then offers no way to give it.
  const c = freshClient({
    status:'Confirmed', bookedDate: isoDaysAgo(40),
    callDateTime: isoDaysFromNow(1),
    messageLog: ['welcome','monday','midcheckin'].map((st, i) => ({
      stage: st, variantId: st[0]+'1', text:'x', sentAt: isoDaysAgo(34 - i),
      responded: i === 0, respondedAt: i === 0 ? isoDaysAgo(34) : null, reviewed:true
    }))
  });
  const score = GB.computeGhostScore(c, new Date());
  const rec = GB.recommendNextAction(c, new Date());
  assert.ok(score.score >= 51, 'fixture should score high, got ' + score.score);
  assert.notStrictEqual(rec.action, 'none', 'a high score must never resolve to "nothing due"');
  assert.ok(rec.why, 'and it must say why');
});

test('a contact with no phone says so instead of recommending the impossible', () => {
  const c = freshClient({phone:'', bookedDate: isoDaysAgo(30), callDateTime: null,
    messageLog:[{stage:'welcome',variantId:'w1',text:'x',sentAt: isoDaysAgo(20),
      responded:false, respondedAt:null, reviewed:true}]});
  const rec = GB.recommendNextAction(c, new Date());
  assert.ok(rec.action === 'none' || rec.action === 'outcome', 'got ' + rec.action);
});

console.log('\n--- configurable sequences ---');

function withSequence(steps, fn){
  GB.setSequence(steps);
  try { fn(); } finally { GB.setSequence(null); }
}

test('the default sequence is what the hard-coded rules did', () => {
  // The real assertion is the whole computeDue suite above still passing; this
  // just pins the shape so a step cannot be dropped unnoticed.
  const keys = GB.buildDefaultSequence().map(s => s.key);
  assert.deepStrictEqual(keys,
    ['welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow','revival']);
});

test('a business can drop a touch it does not want', () => {
  // An HVAC shop has no use for "Monday of the call week".
  const noMonday = GB.buildDefaultSequence().filter(s => s.key !== 'monday');
  withSequence(noMonday, () => {
    const c = freshClient({
      bookedDate: isoDaysAgo(6),
      callDateTime: isoDaysFromNow(2),
      messageLog: [{stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(5),responded:false,respondedAt:null,reviewed:true}]
    });
    assert.ok(!GB.computeDue(c, new Date()).includes('monday'));
  });
});

test('days_before_appointment fires on exactly that day', () => {
  withSequence([{key:'t2', stage:'midcheckin', trigger:{type:'days_before_appointment', days:2}}], () => {
    const two = freshClient({bookedDate: isoDaysAgo(9), callDateTime: isoDaysFromNow(2)});
    const four = freshClient({bookedDate: isoDaysAgo(9), callDateTime: isoDaysFromNow(4)});
    assert.ok(GB.computeDue(two, new Date()).includes('midcheckin'), 'should fire 2 days out');
    assert.ok(!GB.computeDue(four, new Date()).includes('midcheckin'), 'should not fire 4 days out');
  });
});

test('days_after_create drives a cadence with no appointment at all', () => {
  // A contact with no booked call — the HVAC "we quoted you, chase it" case.
  withSequence([{key:'chase', stage:'recovery', trigger:{type:'days_after_create', days:3}}], () => {
    const old = freshClient({bookedDate: isoDaysAgo(5), callDateTime: null});
    const fresh = freshClient({bookedDate: isoDaysAgo(1), callDateTime: null});
    assert.ok(GB.computeDue(old, new Date()).includes('recovery'));
    assert.ok(!GB.computeDue(fresh, new Date()).includes('recovery'));
  });
});

test('repeat_while_role re-fires on its own clock and respects its window', () => {
  withSequence([{key:'rescue', stage:'noshow', trigger:{type:'repeat_while_role', roles:['missed'],
    anchor:'appointment', afterDays:0, everyDays:4, windowDays:14}}], () => {
    const justMissed = freshClient({status:'No-show', callDateTime: isoDaysAgo(1)});
    const recentlySent = freshClient({status:'No-show', callDateTime: isoDaysAgo(5),
      messageLog:[{stage:'noshow',variantId:'n1',text:'x',sentAt:isoDaysAgo(1),responded:false,respondedAt:null,reviewed:true}]});
    const longGone = freshClient({status:'No-show', callDateTime: isoDaysAgo(40)});
    assert.ok(GB.computeDue(justMissed, new Date()).includes('noshow'));
    assert.ok(!GB.computeDue(recentlySent, new Date()).includes('noshow'), 'should wait everyDays between sends');
    assert.ok(!GB.computeDue(longGone, new Date()).includes('noshow'), 'should stop past the window');
  });
});

test('a rescue step still fires after the appointment cadence has stopped', () => {
  // The whole point of a no-show rescue is that it runs once the normal
  // cadence is over.
  const c = freshClient({status:'No-show', callDateTime: isoDaysAgo(2)});
  assert.ok(GB.computeDue(c, new Date()).includes('noshow'));
});

test('an unrecognised trigger fires nothing rather than guessing', () => {
  withSequence([{key:'x', stage:'welcome', trigger:{type:'someday_maybe'}}], () => {
    const c = freshClient({bookedDate: isoDaysAgo(3), callDateTime: isoDaysFromNow(3)});
    assert.deepStrictEqual(Array.from(GB.computeDue(c, new Date())), [],
      'guessing a schedule would send real texts nobody asked for');
  });
});

test('an empty or broken sequence falls back to the defaults', () => {
  GB.setSequence([]);
  assert.strictEqual(GB.getSequence().length, GB.buildDefaultSequence().length);
  GB.setSequence([{stage:'welcome'}, {trigger:{type:'on_create'}}]);   // both invalid
  assert.strictEqual(GB.getSequence().length, GB.buildDefaultSequence().length);
  GB.setSequence(null);
});

test('rebooked and followup still override the first touch under a custom sequence', () => {
  withSequence([{key:'hello', stage:'welcome', trigger:{type:'on_create'}}], () => {
    const stranger = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5)});
    const returning = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5), rebooked:true});
    const veteran = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(5), rebooked:true, hadPriorCall:true});
    assert.ok(GB.computeDue(stranger, new Date()).includes('welcome'));
    assert.ok(GB.computeDue(returning, new Date()).includes('rebooked'));
    assert.ok(GB.computeDue(veteran, new Date()).includes('followup'));
  });
});

console.log('\n--- one touch per person per day ---');

test('several touches due produce one card, not three', () => {
  const st = GB.buildDefaultState();
  // The common real case: a booking backfilled late, so welcome, monday and
  // midcheckin all come due at once.
  st.clients['a'] = freshClient({id:'a', name:'Pam', phone:'5125550010',
    bookedDate: isoDaysAgo(9), callDateTime: isoDaysFromNow(2)});
  const due = GB.computeDue(st.clients['a'], new Date());
  assert.ok(due.length > 1, 'fixture should have several due, got ' + JSON.stringify(due));
  const items = GB.getTextTodayList(st, new Date(), '');
  assert.strictEqual(items.length, 1, 'one person, one card');
});

test('the touch chosen is the most time-critical one due', () => {
  assert.strictEqual(GB.pickTodaysTouch(['midcheckin','welcome','monday']), 'welcome',
    'introduce yourself before checking in');
  assert.strictEqual(GB.pickTodaysTouch(['welcome','dayof']), 'dayof',
    'the meeting link beats an introduction');
  assert.strictEqual(GB.pickTodaysTouch(['dayof','hourbefore']), 'hourbefore');
  assert.strictEqual(GB.pickTodaysTouch(['midcheckin','monday']), 'monday');
});

test('a stage from a custom sequence is still sendable', () => {
  assert.strictEqual(GB.pickTodaysTouch(['something-bespoke']), 'something-bespoke');
});

test('whatever is not sent today is still due tomorrow', () => {
  /* This test's NAME was always right and its assertion was always wrong: it
     demanded the next touch surface the moment the first was sent, which is
     the same day, not tomorrow. So it locked in the double-texting — send
     Caitlin her welcome and she reappeared immediately with a midpoint text.

     Same shape as the calendar-filter test that asserted its own bug. Worth
     saying plainly: a test whose name and assertion disagree is worse than no
     test, because the name is what anyone reads when deciding whether the
     behaviour is covered. */
  const st = GB.buildDefaultState();
  st.clients['a'] = freshClient({id:'a', phone:'5125550011',
    bookedDate: isoDaysAgo(9), callDateTime: isoDaysFromNow(4)});
  const now = new Date();

  const first = GB.getTextTodayList(st, now, '')[0].stage;
  GB.markSent(st, 'a', first, 'sent it');

  assert.deepStrictEqual(GB.getTextTodayList(st, now, ''), [],
    'nothing else should surface for the same person on the same day');

  // Tomorrow, the next one is there.
  const tomorrow = new Date(now.getTime() + 26 * 3600000);
  const next = GB.getTextTodayList(st, tomorrow, '');
  assert.strictEqual(next.length, 1, 'the next touch should surface the following day');
  assert.notStrictEqual(next[0].stage, first, 'and it should be a different one');
});

test('one human with two client records gets one card', () => {
  // A contact who ghosted and rebooked legitimately has two rows.
  const st = GB.buildDefaultState();
  st.clients['old'] = freshClient({id:'old', name:'Geri Westfall', phone:'386-852-0339',
    status:'Ghosted', stalledSince: isoDaysAgo(9), bookedDate: isoDaysAgo(40)});
  st.clients['new'] = freshClient({id:'new', name:'Geri  Westfall', phone:'(386) 852 0339',
    status:'Ghosted', stalledSince: isoDaysAgo(8), bookedDate: isoDaysAgo(30)});
  const items = GB.getTextTodayList(st, new Date(), '');
  assert.strictEqual(items.length, 1, 'same phone, differently formatted, is one person');
});

test('two different people are never collapsed', () => {
  const st = GB.buildDefaultState();
  st.clients['a'] = freshClient({id:'a', name:'Ann', phone:'5125550020', bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(6)});
  st.clients['b'] = freshClient({id:'b', name:'Bob', phone:'5125550021', bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(6)});
  assert.strictEqual(GB.getTextTodayList(st, new Date(), '').length, 2);
});

console.log('\n--- five-touch progress ---');

test('progress counts the run-up, not the rescue sequences', () => {
  const touches = GB.cadenceTouches();
  assert.deepStrictEqual(touches, ['welcome','monday','midcheckin','dayof','hourbefore']);
  assert.ok(touches.indexOf('noshow') === -1 && touches.indexOf('recovery') === -1,
    'a rescue is what happens after the run-up fails, not part of it');
});

test('it reads 0 of 5 for a fresh booking and counts up', () => {
  const c = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(6)});
  assert.strictEqual(GB.cadenceProgress(c, new Date()).label, '0 of 5');
  c.messageLog = [{stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(1),responded:false,respondedAt:null,reviewed:true}];
  const p = GB.cadenceProgress(c, new Date());
  assert.strictEqual(p.label, '1 of 5');
  assert.strictEqual(p.nextStage, 'monday');
});

test('a rebooked or followup intro counts as the welcome touch', () => {
  const c = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(6), rebooked:true,
    messageLog:[{stage:'rebooked',variantId:'rb1',text:'x',sentAt:isoDaysAgo(1),responded:false,respondedAt:null,reviewed:true}]});
  assert.strictEqual(GB.cadenceProgress(c, new Date()).done, 1,
    'the introduction happened, whichever face it wore');
});

test('a moved call resets the progress for that appointment', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(40), callDateTime: isoDaysFromNow(4),
    reschedules: [isoDaysAgo(2)],
    messageLog:[{stage:'midcheckin',variantId:'c1',text:'x',sentAt:isoDaysAgo(20),responded:false,respondedAt:null,reviewed:true}]});
  const p = GB.cadenceProgress(c, new Date());
  assert.ok(p.sentStages.indexOf('midcheckin') === -1,
    'a check-in for the old date is not progress toward the new one');
});

test('the total follows a customised cadence instead of always saying five', () => {
  withSequence(GB.buildDefaultSequence().filter(s => s.key !== 'monday'), () => {
    const c = freshClient({bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(6)});
    assert.strictEqual(GB.cadenceProgress(c, new Date()).total, 4,
      'a business that dropped a touch should not be told it has five');
  });
});

test('a fully worked run-up reports complete', () => {
  const c = freshClient({bookedDate: isoDaysAgo(10), callDateTime: isoDaysFromNow(1),
    messageLog: ['welcome','monday','midcheckin','dayof','hourbefore'].map(st => ({
      stage: st, variantId: 'x', text:'x', sentAt: isoDaysAgo(2), responded:false, respondedAt:null, reviewed:true}))});
  const p = GB.cadenceProgress(c, new Date());
  assert.strictEqual(p.complete, true);
  assert.strictEqual(p.nextStage, null);
});

console.log('\n--- email channel ---');

test('every SMS stage has an email counterpart', () => {
  const sms = Object.keys(GB.buildDefaultVariants());
  const email = GB.buildDefaultEmailVariants();
  sms.forEach(stage => assert.ok(email[stage] && email[stage].length,
    'no email version of the ' + stage + ' touch — that channel would silently do nothing'));
});

test('email variants carry a subject and render cleanly', () => {
  const c = freshClient({callDateTime: isoDaysFromNow(1), meetLink:'https://meet.google.com/abc-defg-hij'});
  const all = GB.buildDefaultEmailVariants();
  Object.keys(all).forEach(stage => {
    all[stage].forEach(v => {
      assert.ok(v.subject && v.subject.trim(), stage + '/' + v.id + ' has no subject line');
      assert.strictEqual(v.channel, 'email');
      const subject = GB.renderTemplate(v.subject, c, 'Johnny');
      const body = GB.renderTemplate(v.text, c, 'Johnny');
      assert.ok(!subject.includes('{'), stage + '/' + v.id + ' left a placeholder in the subject: ' + subject);
      assert.ok(!body.includes('{'), stage + '/' + v.id + ' left a placeholder in the body');
    });
  });
});

test('email and SMS variant ids never collide', () => {
  const sms = Object.values(GB.buildDefaultVariants()).flat().map(v => v.id);
  const email = Object.values(GB.buildDefaultEmailVariants()).flat().map(v => v.id);
  const clash = email.filter(id => sms.indexOf(id) !== -1);
  assert.deepStrictEqual(clash, [], 'shared ids would merge two channels’ stats: ' + clash.join(', '));
});

test('a link-bearing email actually carries the meeting link', () => {
  const c = freshClient({callDateTime: isoDaysFromNow(1), meetLink:'https://meet.google.com/xyz-1234-abc'});
  ['dayof','hourbefore'].forEach(stage => {
    const draft = GB.getEmailDraft(GB.buildDefaultState(), c, stage, 'Johnny');
    assert.ok(draft, 'no draft for ' + stage);
    assert.ok(draft.text.includes('meet.google.com'), stage + ' email should include the link');
  });
});

test('getEmailDraft returns null for a stage with no email form', () => {
  const c = freshClient({});
  assert.strictEqual(GB.getEmailDraft(GB.buildDefaultState(), c, 'no-such-stage', 'Johnny'), null);
});

test('the send function refuses clearly when nothing is configured', () => {
  const src = fs.readFileSync(path.join(__dirname, 'supabase', 'functions', 'send-email', 'index.ts'), 'utf8');
  // Each of these is a way to send mail on someone's behalf that should not be
  // possible; a missing check here is a real-world harm, not a broken test.
  assert.ok(src.includes('no_provider'), 'must refuse when the API key is absent');
  assert.ok(src.includes('email_enabled'), 'must refuse when the account has not switched sending on');
  assert.ok(src.includes('Not your contact'), 'must verify the caller owns the contact');
  assert.ok(src.includes('/auth/v1/user'), 'must resolve the bearer token to a real user');
  assert.ok(src.includes('OPTIONS'), 'must answer CORS preflight or the browser never reaches it');
});

console.log('\n--- automatic email guardrails ---');

// This function mails real people with nobody watching. Each of these is a way
// that could go wrong at scale, so they are asserted against the source rather
// than trusted to stay true.
{
  const src = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', 'auto-send-email', 'index.ts'), 'utf8');

  test('it shares the cadence engine instead of reimplementing it', () => {
    // Must be a STATIC import: the deploy bundler cannot trace a dynamic
    // require, and shipping this function without logic.js killed every
    // invocation with WORKER_ERROR.
    assert.ok(src.includes("import '../_shared/logic.js'"),
      'a third copy of computeDue would decide what gets sent to real people');
    // The call, not the word — it is named in a comment explaining why it was
    // removed, and that comment is worth keeping.
    assert.ok(!/createRequire\s*\(/.test(src),
      'a dynamic require is not bundled, so the dependency ships missing');
    assert.ok(src.includes('GB.computeDue('), 'must use the same due calculation as the app');
    assert.ok(src.includes('GB.pickTodaysTouch('), 'and the same one-per-day choice');
  });

  test('dry run is the default, and a live run needs a secret', () => {
    assert.ok(/dryRun = payload\.dryRun !== false/.test(src),
      'an accidental invocation must report, not mail');
    assert.ok(src.includes('CRON_SECRET'), 'a live run must be authenticated');
    assert.ok(/!dryRun && \(!CRON_SECRET \|\| payload\.secret !== CRON_SECRET\)/.test(src));
  });

  test('it only touches accounts that opted in twice', () => {
    assert.ok(src.includes('email_enabled=eq.true'), 'must require email to be enabled');
    assert.ok(src.includes('auto_send_email=eq.true'), 'must require automatic sending separately');
  });

  test('it respects working hours where the contact is, not where the server is', () => {
    assert.ok(src.includes('timeZone: tz'), 'the hour must be computed in their zone');
    assert.ok(/SEND_FROM_HOUR|SEND_TO_HOUR/.test(src));
    assert.ok(src.includes('outside their working hours'));
  });

  test('it cannot contact the same person twice in a day', () => {
    assert.ok(src.includes('already contacted today'),
      'automation must not add to a conversation a human already started today');
  });

  test('a misconfiguration cannot empty an entire book in one run', () => {
    assert.ok(src.includes('MAX_PER_RUN_PER_ORG'), 'there must be a per-run cap');
  });

  test('config is reset between accounts so one business cannot leak into another', () => {
    // logic.js holds pipeline and sequence module-level; a loop over orgs must
    // set and clear them, or the second org inherits the first one's cadence.
    assert.ok(src.includes('GB.setPipeline(settings.pipeline'), 'must set per account');
    assert.ok(src.includes('GB.setPipeline(null)'), 'and clear it afterwards');
    assert.ok(src.includes('GB.setSequence(null)'));
  });

  test('sent mail is logged the same shape a manual send produces', () => {
    assert.ok(src.includes("channel: 'email'"), 'must record the channel');
    assert.ok(src.includes('/message_log'), 'must log at all, or the cadence never advances');
    assert.ok(src.includes('reviewed: false'), 'and must enter the reply-review queue like any other send');
  });
}

test('settings offers no switch for sending that no longer happens', () => {
  /* This used to assert that turning email off also turned automatic sending
     off — correct while both switches did something. Email is a library sent
     by hand through the person's own Gmail now, and the unattended sender
     refuses live runs, so both switches controlled nothing.

     A control that does nothing is worse than a missing one: it tells someone
     a thing is on when it is not, and they plan around it. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  ['set-email-enabled', 'set-auto-email'].forEach(action => {
    assert.ok(!app.includes("data-action=\"" + action),
      'settings still renders the dead ' + action + ' switch');
    assert.ok(!app.includes("case '" + action + "'"),
      'a handler for ' + action + ' survives with nothing to trigger it');
  });
  // The one email setting that does something must still be there.
  assert.ok(app.includes('emailFromAddress'),
    'the sending account is the one email setting that still has an effect');
});

test('the stored email settings are kept, so nothing is lost', () => {
  // Removing the switches must not drop the columns or stop persisting them —
  // a provider route may come back, and silently discarding a configured
  // address would be a data loss nobody asked for.
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  ['email_enabled', 'auto_send_email', 'email_from_address', 'email_reply_to'].forEach(col => {
    assert.ok(data.includes(col), 'data.js stopped persisting ' + col);
  });
});

test('the unreachable provider composer is gone, not just hidden', () => {
  // It was the other half of the stage-keyed model and nothing rendered a way
  // in. Dead code that reads as a feature costs the next person real time.
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  assert.ok(!/function openEmailComposer/.test(app));
  assert.ok(!/function doSendEmail/.test(app));
  // The Edge Function stays — it works, and it is the route back if wanted.
  assert.ok(fs.existsSync(path.join(__dirname, 'supabase', 'functions', 'send-email', 'index.ts')),
    'the send-email function should not have been deleted');
});

console.log('\n--- site routing ---');

test('the app lives at /app and the landing page owns the root', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
  const landing = fs.readFileSync(path.join(__dirname, 'hosted', 'index.html'), 'utf8');
  assert.ok(app.includes('id="app-root"'), 'app.html should be the CRM shell');
  assert.ok(app.includes('src="logic.js"') && app.includes('src="app.js"'),
    'app.html must still load its scripts from the same directory');
  assert.ok(!landing.includes('id="app-root"'), 'index.html should be the landing page, not the app');
  assert.ok(landing.includes('href="/app"'), 'the landing page must link to the app');
});

test('cleanUrls is configured, or /app 404s in production', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
  assert.strictEqual(cfg.cleanUrls, true,
    'without this, /app does not resolve to app.html and every sign-in link breaks');
});

test('the landing page does not promise anything that is not built', () => {
  const landing = fs.readFileSync(path.join(__dirname, 'hosted', 'index.html'), 'utf8').toLowerCase();
  // Email sending, billing and team features do not exist yet. Claiming them
  // on the page someone signs up from is the fastest way to lose their trust.
  ['email campaign', 'send emails', 'unlimited users', 'free trial', 'per month', 'integrations with']
    .forEach(claim => assert.ok(!landing.includes(claim),
      'landing page claims "' + claim + '", which is not built yet'));
});

console.log('\n--- which calendar events become contacts ---');

const ev = (over) => Object.assign({summary:'', description:'', organizer:{email:'me@acme.com'}, attendees:[]}, over || {});

test('the legacy rule still behaves exactly as it did', () => {
  assert.strictEqual(GB.isStrategySessionEvent(ev({summary:'Strategy Session (Dana Reed)'})), true);
  assert.strictEqual(GB.isStrategySessionEvent(ev({description:'Booked by Dana Reed'})), true);
  assert.strictEqual(GB.isStrategySessionEvent(ev({summary:'Weekly team meeting'})), false);
  assert.strictEqual(GB.isStrategySessionEvent(ev({summary:'Roof inspection - John Smith'})), false);
});

test('attendee mode recognises a booking without knowing any wording', () => {
  // The whole point: a roofing company should not have to name events
  // "strategy session" for their calendar to work.
  const f = {mode:'attendees'};
  assert.strictEqual(GB.matchesCalendarFilter(
    ev({summary:'Roof inspection - John Smith', attendees:[{email:'john@gmail.com'}]}), f), true);
  assert.strictEqual(GB.matchesCalendarFilter(
    ev({summary:'Estimate: 14 Oak St', attendees:[{email:'homeowner@yahoo.com'}]}), f), true);
});

test('attendee mode ignores internal meetings and rooms', () => {
  const f = {mode:'attendees'};
  assert.strictEqual(GB.matchesCalendarFilter(
    ev({summary:'Standup', attendees:[{email:'colleague@acme.com'}]}), f), false,
    'a colleague on your own domain is not a booking');
  assert.strictEqual(GB.matchesCalendarFilter(
    ev({summary:'Focus time', attendees:[{email:'me@acme.com', self:true}]}), f), false);
  assert.strictEqual(GB.matchesCalendarFilter(
    ev({summary:'Board room', attendees:[{email:'room@acme.com', resource:true}]}), f), false);
  assert.strictEqual(GB.matchesCalendarFilter(ev({summary:'Dentist'}), f), false,
    'an event with no guests at all is not a booking');
});

test('exclusions win in every mode', () => {
  ['all','attendees','keywords'].forEach(mode => {
    const f = {mode, include:['inspection'], exclude:['weekly team meeting']};
    assert.strictEqual(GB.matchesCalendarFilter(
      ev({summary:'Weekly team meeting', attendees:[{email:'someone@else.com'}]}), f), false,
      mode + ' mode should still honour the exclusion');
  });
});

test('all mode takes everything that is not excluded', () => {
  const f = {mode:'all', exclude:['lunch']};
  assert.strictEqual(GB.matchesCalendarFilter(ev({summary:'Anything at all'}), f), true);
  assert.strictEqual(GB.matchesCalendarFilter(ev({summary:'Lunch with Sam'}), f), false);
});

test('an unconfigured account gets the sensible default, NOT the first customer\'s titles', () => {
  /* This test previously asserted the opposite, with a comment claiming it
     prevented "a silently empty app" — while locking in the exact bug that
     caused three of them.

     An account with no calendar_filter fell back to MarketMaker's event
     titles, so everyone who signed up had their calendar filtered for the
     phrase "strategy session". niklaus, ronin and ethan each connected a
     calendar, imported nothing, and were diagnosed from scratch.

     Unconfigured means the sensible default. A booking is an event with a
     guest from outside your own domain, whatever anyone calls it. */
  const booking = ev({summary:'Roof inspection - John Smith',
                      attendees:[{email:'john@gmail.com'}]});
  assert.strictEqual(GB.matchesCalendarFilter(booking, undefined), true,
    'a plumber\'s booking must import on an unconfigured account');
  assert.strictEqual(GB.matchesCalendarFilter(booking, {}), true);
  assert.strictEqual(GB.matchesCalendarFilter(booking, {mode: null}), true);

  // And an internal meeting still must not become a contact.
  assert.strictEqual(GB.matchesCalendarFilter(
    ev({summary:'Standup', attendees:[{email:'colleague@acme.com'}]}), undefined), false);

  // The legacy rule is still reachable — explicitly, by the accounts that
  // were backfilled with it, and by the .ics import path.
  assert.strictEqual(GB.isStrategySessionEvent(ev({summary:'Strategy Session (Dana)'})), true);
});

test('a new account is seeded with a filter it can see, not left null', () => {
  // Relying on a fallback is what caused this. The row should say what it
  // means, so the setting is visible and changeable in Settings.
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const seed = data.slice(data.indexOf("from('app_settings').insert("));
  const stmt = seed.slice(0, seed.indexOf('}'));
  assert.ok(/calendar_filter/.test(stmt),
    'the first-load settings seed must set calendar_filter explicitly');
  assert.ok(/attendees/.test(stmt), 'and it must be outside-guest mode: ' + stmt);
});

test('the database defaults the filter too, so no row can be born null', () => {
  const migrations = fs.readdirSync(path.join(__dirname, 'supabase', 'migrations'))
    .filter(f => f.endsWith('.sql')).sort()
    .map(f => fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', f), 'utf8'))
    .join('\n');
  assert.ok(/alter column calendar_filter set default/i.test(migrations),
    'calendar_filter needs a column default — a migration that only backfills leaves every later signup null');
  // And the accounts already stranded have to be repaired, not just future ones.
  assert.ok(/set calendar_filter[\s\S]{0,300}where calendar_filter is null/i.test(migrations),
    'the repair half is missing: anyone already null stays broken');
});

test('the Edge Function and logic.js apply the same rule', () => {
  // The function syncs Google Calendar, logic.js parses .ics imports. If they
  // disagree, the same calendar produces different contacts depending on how
  // it arrived.
  const ts = fs.readFileSync(path.join(__dirname, 'supabase', 'functions', '_shared', 'parse.ts'), 'utf8');
  ['matchesCalendarFilter', "mode === 'all'", "mode === 'attendees'", 'exclude', 'matchDescription']
    .forEach(token => assert.ok(ts.includes(token), 'parse.ts is missing ' + token));
  assert.ok(/LEGACY_FILTER/.test(ts), 'parse.ts must keep the legacy rule for the accounts that chose it');
  // The two copies must agree on what UNCONFIGURED means, which is the thing
  // that was wrong: one company's titles instead of a general default.
  assert.ok(/DEFAULT_FILTER/.test(ts), 'parse.ts must have a general default');
  assert.ok(/:\s*DEFAULT_FILTER/.test(ts),
    'parse.ts must FALL BACK to the general default, not to LEGACY_FILTER');
});

console.log('\n--- industry templates ---');

test('every template is a valid, workable configuration', () => {
  GB.buildIndustryTemplates().forEach(t => {
    assert.ok(t.key && t.label && t.blurb, 'template missing basics: ' + JSON.stringify(t));
    if(!t.pipeline) return;   // 'custom' deliberately keeps the defaults
    const roles = t.pipeline.map(p => p.role);
    // Without these three a business is silently broken: nothing gets chased,
    // nothing ever completes, and no-shows never trigger a rescue.
    ['open','won','missed'].forEach(r =>
      assert.ok(roles.indexOf(r) !== -1, t.key + ' has no ' + r + ' stage'));
    t.pipeline.forEach(st => {
      assert.ok(st.key && st.label, t.key + ' has a nameless stage');
      assert.ok(['open','won','missed','stalled','lost'].indexOf(st.role) !== -1,
        t.key + ' has an unknown role: ' + st.role);
    });
  });
});

test('templates have distinct keys and every one is retrievable', () => {
  const keys = GB.buildIndustryTemplates().map(t => t.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate template keys');
  keys.forEach(k => assert.ok(GB.industryTemplate(k), 'could not fetch ' + k));
  assert.strictEqual(GB.industryTemplate('nope'), null);
});

test('a template drives the real engine, not a parallel one', () => {
  const hvac = GB.industryTemplate('hvac');
  GB.setPipeline(hvac.pipeline);
  try {
    assert.strictEqual(GB.stopsCadence('Estimate Completed'), true);
    assert.strictEqual(GB.isMissed('Missed Estimate'), true);
    assert.strictEqual(GB.isStalledStage('Awaiting Decision'), true);
    // and the agency's own stage names stop being special
    assert.strictEqual(GB.isWon('Completed'), false);
  } finally { GB.setPipeline(null); }
});

test('every template can run a full cadence without knowing its stage names', () => {
  GB.buildIndustryTemplates().forEach(t => {
    if(!t.pipeline) return;
    GB.setPipeline(t.pipeline);
    try {
      const openStage = t.pipeline.find(p => p.role === 'open').key;
      const c = freshClient({status: openStage, bookedDate: isoDaysAgo(1), callDateTime: isoDaysFromNow(4)});
      assert.ok(GB.computeDue(c, new Date()).length > 0, t.key + ': a new booking should have a touch due');
      const missedStage = t.pipeline.find(p => p.role === 'missed').key;
      const m = freshClient({status: missedStage, callDateTime: isoDaysAgo(2)});
      assert.ok(GB.computeDue(m, new Date()).includes('noshow'), t.key + ': a miss should trigger rescue');
    } finally { GB.setPipeline(null); }
  });
});

test('the custom template leaves the defaults alone', () => {
  const custom = GB.industryTemplate('custom');
  assert.strictEqual(custom.pipeline, null);
  assert.strictEqual(custom.terminology, null);
});

console.log('\n--- hot / good / nurture / dead grouping ---');

test('every band lands in exactly one group', () => {
  const bands = ['immediate','high','soon','nurture','low'];
  bands.forEach(b => {
    const hits = GB.SCORE_GROUPS.filter(g => g.bands.indexOf(b) !== -1);
    assert.strictEqual(hits.length, 1, b + ' should belong to exactly one group');
  });
});

test('hot covers both urgent bands, because they mean the same instruction', () => {
  assert.strictEqual(GB.scoreGroupOf('immediate'), 'hot');
  assert.strictEqual(GB.scoreGroupOf('high'), 'hot');
  assert.strictEqual(GB.scoreGroupOf('soon'), 'good');
  assert.strictEqual(GB.scoreGroupOf('nurture'), 'nurture');
  assert.strictEqual(GB.scoreGroupOf('low'), 'dead');
});

test('an unknown band falls to dead rather than vanishing from every filter', () => {
  assert.strictEqual(GB.scoreGroupOf('something-new'), 'dead');
});

test('the groups partition a real book with nothing left over', () => {
  const st = GB.buildDefaultState();
  for(let i = 0; i < 12; i++){
    st.clients['c'+i] = freshClient({id:'c'+i, name:'C'+i, phone:'2135550100',
      bookedDate: isoDaysAgo(i * 7),
      callDateTime: i % 3 === 0 ? isoDaysFromNow(1) : (i % 3 === 1 ? isoDaysAgo(5) : null),
      status: ['Booked','Completed','No-show','Ghosted'][i % 4]});
  }
  const live = Object.keys(st.clients).map(k => st.clients[k]);
  const counted = GB.SCORE_GROUPS.reduce((n, g) => n + live.filter(c =>
    g.bands.indexOf(GB.computeGhostScore(c, new Date()).band) !== -1).length, 0);
  assert.strictEqual(counted, live.length, 'every contact must appear under exactly one chip');
});

console.log('\n--- pause on reply ---');

const repliedMsg = (over) => Object.assign({stage:'welcome', variantId:'w1', text:'x',
  sentAt: isoDaysAgo(2), responded:true, respondedAt: isoDaysAgo(1), reviewed:true}, over || {});

test('a recent reply holds the automated cadence', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(10), callDateTime: isoDaysFromNow(6),
    messageLog: [repliedMsg()]
  });
  const due = GB.computeDue(c, new Date());
  assert.ok(!due.includes('monday') && !due.includes('midcheckin'),
    'nudges should be held while they are mid-conversation, got ' + JSON.stringify(due));
});

test('but never holds a reminder for an imminent appointment', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(10),
    callDateTime: new Date(Date.now() + 45 * 60000).toISOString(),
    messageLog: [repliedMsg()]
  });
  const due = GB.computeDue(c, new Date());
  assert.ok(due.includes('hourbefore'),
    'a reply must not cost someone their meeting link, got ' + JSON.stringify(due));
});

test('the pause expires so a good conversation cannot become a forgotten lead', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(30), callDateTime: isoDaysFromNow(6),
    messageLog: [repliedMsg({sentAt: isoDaysAgo(20), respondedAt: isoDaysAgo(20)})]
  });
  const due = GB.computeDue(c, new Date());
  assert.ok(due.length > 0, 'a reply 20 days ago must not still be suppressing follow-ups');
});

test('a reply with no logged time produces no pause rather than a fictional one', () => {
  // The 459 replies recovered from Messages have no responded_at at all.
  const c = freshClient({
    bookedDate: isoDaysAgo(30), callDateTime: isoDaysFromNow(6),
    messageLog: [repliedMsg({sentAt: isoDaysAgo(25), respondedAt: null})]
  });
  assert.ok(GB.computeDue(c, new Date()).length > 0,
    'falling back to a months-old send time should not pause anything today');
});

test('an unanswered contact is unaffected', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(10), callDateTime: isoDaysFromNow(6),
    messageLog: [repliedMsg({responded:false, respondedAt:null})]
  });
  assert.strictEqual(GB.replyPauseUntil(c), null);
});

test('a held contact says it is waiting on a human, not that it is handled', () => {
  const c = freshClient({messageLog:[repliedMsg()]});
  const label = GB.interactionLabel(GB.lastInteraction(c, new Date()));
  assert.ok(/your turn/.test(label), 'got: ' + label);
});

console.log('\n--- variant performance ---');

function perfClient(id, over){
  return freshClient(Object.assign({id, name:id, phone:'2135550100'}, over));
}

test('an outcome is credited to the last message before the appointment', () => {
  const st = GB.buildDefaultState();
  // The day-of text goes out hours before the call, not at the same instant —
  // equal timestamps would not be "before" and the fixture would prove nothing.
  st.clients['a'] = perfClient('a', {
    status:'Completed', callDateTime: isoDaysAgo(2),
    messageLog:[
      {stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(9),responded:false,respondedAt:null,reviewed:true},
      {stage:'dayof',variantId:'d2',text:'y',sentAt:isoDaysAgo(2.2),responded:false,respondedAt:null,reviewed:true}
    ]});
  const perf = GB.computeVariantPerformance(st, new Date());
  const dayof = perf.find(g => g.stage === 'dayof').rows.find(r => r.variantId === 'd2');
  const welcome = perf.find(g => g.stage === 'welcome').rows.find(r => r.variantId === 'w1');
  assert.strictEqual(dayof.credited, 1, 'the last touch takes the credit');
  assert.strictEqual(dayof.appointments, 1);
  assert.strictEqual(welcome.credited, 0, 'earlier touches are not credited');
  assert.strictEqual(welcome.sends, 1, 'but they still count as sends');
});

test('messages sent after the appointment are never credited for it', () => {
  const st = GB.buildDefaultState();
  st.clients['a'] = perfClient('a', {
    status:'No-show', callDateTime: isoDaysAgo(5),
    messageLog:[{stage:'noshow',variantId:'n1',text:'x',sentAt:isoDaysAgo(3),responded:false,respondedAt:null,reviewed:true}]});
  const perf = GB.computeVariantPerformance(st, new Date());
  const n1 = perf.find(g => g.stage === 'noshow').rows.find(r => r.variantId === 'n1');
  assert.strictEqual(n1.credited, 0, 'a rescue text sent after the miss did not cause the miss');
});

test('a thin sample refuses to claim a rate or a leader', () => {
  const st = GB.buildDefaultState();
  for(let i = 0; i < 3; i++){
    st.clients['c'+i] = perfClient('c'+i, {status:'Completed', callDateTime: isoDaysAgo(2),
      messageLog:[{stage:'dayof',variantId:'d1',text:'x',sentAt:isoDaysAgo(3),responded:false,respondedAt:null,reviewed:true}]});
  }
  const g = GB.computeVariantPerformance(st, new Date()).find(x => x.stage === 'dayof');
  assert.strictEqual(g.rows[0].enoughData, false, '3 credited is not enough to rate');
  assert.strictEqual(g.leader, null, 'one variant with data is not a comparison');
  assert.strictEqual(g.comparable, false);
});

test('a leader is only named once two variants clear the sample floor', () => {
  const st = GB.buildDefaultState();
  const mk = (i, vid, showed) => {
    st.clients[vid+i] = perfClient(vid+i, {
      status: showed ? 'Completed' : 'No-show', callDateTime: isoDaysAgo(2),
      messageLog:[{stage:'dayof',variantId:vid,text:'x',sentAt:isoDaysAgo(3),responded:false,respondedAt:null,reviewed:true}]});
  };
  for(let i = 0; i < GB.VARIANT_MIN_SAMPLE; i++) mk(i, 'd1', i < 8);   // strong
  for(let i = 0; i < GB.VARIANT_MIN_SAMPLE; i++) mk(i, 'd2', i < 2);   // weak
  const g = GB.computeVariantPerformance(st, new Date()).find(x => x.stage === 'dayof');
  assert.strictEqual(g.comparable, true);
  assert.strictEqual(g.leader.variantId, 'd1', 'the higher appointment rate should lead');
});

test('unreviewed sends and custom text stay out of the numbers', () => {
  const st = GB.buildDefaultState();
  st.clients['a'] = perfClient('a', {status:'Completed', callDateTime: isoDaysAgo(1),
    messageLog:[
      {stage:'welcome',variantId:'w1',text:'x',sentAt:isoDaysAgo(5),responded:false,respondedAt:null,reviewed:false},
      {stage:'welcome',variantId:'custom',text:'y',sentAt:isoDaysAgo(4),responded:true,respondedAt:isoDaysAgo(4),reviewed:true}
    ]});
  const g = GB.computeVariantPerformance(st, new Date()).find(x => x.stage === 'welcome');
  const w1 = g ? g.rows.find(r => r.variantId === 'w1') : null;
  assert.ok(!w1 || w1.sends === 0, 'an unreviewed send is not evidence');
  assert.ok(!g || !g.rows.some(r => r.variantId === 'custom'), 'hand-written text is not a template result');
});

test('computeVariantPerformance survives sparse data', () => {
  const st = GB.buildDefaultState();
  st.clients['a'] = perfClient('a', {callDateTime: null, messageLog: []});
  st.clients['b'] = perfClient('b', {callDateTime: 'nonsense', messageLog: [
    {stage:'welcome',variantId:'w1',text:'x',sentAt:'also-nonsense',responded:false,respondedAt:null,reviewed:true}]});
  assert.doesNotThrow(() => GB.computeVariantPerformance(st, new Date()));
});

// logic.js, data.js and app.js all load into one global scope, in that order.
// Two files declaring a function with the same name is not an error anywhere —
// the later one silently wins, and the earlier file's callers get a different
// function with a different signature.
//
// This is not hypothetical. data.js had snapshot(state, uid) for the
// persistence diff; app.js has snapshot() for the undo buffer and loads after
// it. saveState therefore received a JSON string, diff() threw on it, and the
// try/catch turned total persistence failure into a console message. Every
// save failed for a week and the app looked fine throughout.
//
// The existing "every function app.js calls is defined" check could never
// catch this: the function was defined. It was the wrong one.
{
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const files = ['logic.js', 'data.js', 'app.js'];
  const declared = {};
  files.forEach(f => {
    const src = strip(fs.readFileSync(path.join(__dirname, 'hosted', f), 'utf8'));
    // Top-level declarations only: nested ones are function-scoped and safe.
    [...src.matchAll(/^function\s+([A-Za-z_$]\w*)/gm)].forEach(m => {
      (declared[m[1]] = declared[m[1]] || []).push(f);
    });
    [...src.matchAll(/^var\s+([A-Za-z_$]\w*)\s*=\s*function/gm)].forEach(m => {
      (declared[m[1]] = declared[m[1]] || []).push(f);
    });
  });
  const clashes = Object.keys(declared)
    .filter(n => new Set(declared[n]).size > 1)
    .map(n => n + ' (' + [...new Set(declared[n])].join(' + ') + ')');
  assert.deepStrictEqual(clashes, [],
    'the same top-level name is declared in more than one hosted file; the ' +
    'last one loaded silently wins: ' + clashes.join(', '));
  console.log('  ok  - no top-level name is declared in two hosted files');
}

console.log('\n--- contact timeline ---');

test('history is reconstructed for contacts that predate the events table', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(30), callDateTime: isoDaysAgo(10),
    reschedules: [isoDaysAgo(20)],
    messageLog: [
      {stage:'welcome',variantId:'w1',text:'a',sentAt:isoDaysAgo(29),responded:true,respondedAt:isoDaysAgo(28),reviewed:true},
      {stage:'dayof',variantId:'d1',text:'b',sentAt:isoDaysAgo(10),responded:false,respondedAt:null,reviewed:true}
    ]
  });
  const tl = GB.buildTimeline(c, [], new Date());
  const kinds = tl.map(e => e.kind);
  assert.ok(kinds.includes('contact.created'), 'missing creation');
  assert.ok(kinds.filter(k => k === 'message.sent').length === 2, 'both sends should appear');
  assert.ok(kinds.includes('message.replied'), 'the logged reply should appear');
  assert.ok(kinds.includes('appointment.rescheduled'), 'the reschedule should appear');
  assert.ok(tl.every(e => e.source === 'derived'), 'with no events, everything is derived');
});

test('entries are in chronological order', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(30), callDateTime: isoDaysAgo(2),
    messageLog: [
      {stage:'monday',variantId:'m1',text:'b',sentAt:isoDaysAgo(5),responded:false,respondedAt:null,reviewed:true},
      {stage:'welcome',variantId:'w1',text:'a',sentAt:isoDaysAgo(25),responded:false,respondedAt:null,reviewed:true}
    ]
  });
  const tl = GB.buildTimeline(c, [], new Date());
  for(let i = 1; i < tl.length; i++){
    assert.ok(tl[i].ms >= tl[i-1].ms, 'timeline out of order at index ' + i);
  }
});

test('recorded events merge in and win over the derived version of the same fact', () => {
  const sentAt = isoDaysAgo(3);
  const c = freshClient({bookedDate: isoDaysAgo(10), callDateTime: null,
    messageLog: [{stage:'welcome',variantId:'w1',text:'a',sentAt,responded:false,respondedAt:null,reviewed:true}]});
  const events = [{kind:'message.sent', at: sentAt, data:{stage:'welcome', variantId:'w1', channel:'sms'}}];
  const tl = GB.buildTimeline(c, events, new Date());
  const sends = tl.filter(e => e.kind === 'message.sent');
  assert.strictEqual(sends.length, 1, 'the same send must not appear twice');
  assert.strictEqual(sends[0].source, 'event', 'the recorded version carries more context and should win');
});

test('an unknown event kind still renders rather than disappearing', () => {
  const c = freshClient({bookedDate: isoDaysAgo(2)});
  const tl = GB.buildTimeline(c, [{kind:'something.new', at: isoDaysAgo(1), data:{}}], new Date());
  assert.ok(tl.some(e => e.kind === 'something.new'), 'unrecognised kinds must not be dropped');
});

test('a reply logged late is marked approximate rather than given a false time', () => {
  const c = freshClient({bookedDate: isoDaysAgo(10), callDateTime: null,
    messageLog: [{stage:'welcome',variantId:'w1',text:'a',sentAt:isoDaysAgo(5),responded:true,respondedAt:null,reviewed:true}]});
  const tl = GB.buildTimeline(c, [], new Date());
  const reply = tl.find(e => e.kind === 'message.replied');
  assert.ok(reply, 'expected the reply');
  assert.ok(/approximate/.test(reply.detail), 'a missing reply time must be admitted, not invented');
});

test('buildTimeline never throws on sparse or broken data', () => {
  assert.doesNotThrow(() => GB.buildTimeline(null, [], new Date()));
  assert.doesNotThrow(() => GB.buildTimeline(freshClient({bookedDate:null, callDateTime:null}), null, new Date()));
  assert.doesNotThrow(() => GB.buildTimeline(freshClient({}), [{kind:'x', at:'not-a-date', data:null}], new Date()));
});

console.log('\n--- hosted render smoke test ---');

/* The hosted build had never actually been rendered by a test — only parsed,
   and checked for orphaned functions and undefined calls. That gap shipped a
   real bug to production: inside the GhostBuster Today row loop a local named
   `body` (the SMS message text) hoisted over the panel's own `body` container,
   so body.appendChild(row) became a call on a string and the whole panel threw.
   It parsed fine, every function it called existed, and every test passed.

   This runs the hosted files against the same DOM stub and asserts the render
   path does not throw for each shape of row the panel can produce. */
function makeHostedCtx(){
  const box = {};
  box.localStorage = new LocalStorageStub();
  box.document = makeDocumentStub();
  box.window = box;
  box.navigator = { clipboard: undefined };
  box.console = console;
  box.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
  box.setTimeout = setTimeout; box.clearTimeout = clearTimeout;
  box.setInterval = () => 0; box.clearInterval = () => {};
  box.alert = () => {}; box.confirm = () => true; box.prompt = () => '';
  box.Chart = function(){ this.destroy = () => {}; };
  box.FileReader = function(){}; box.Blob = function(){};
  box.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
  box.encodeURIComponent = encodeURIComponent;
  box.GB_SUPABASE = { auth: { getUser: async () => ({data:{user:{id:'u1', email:'a@b.com'}}}) },
                      from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({data:[],error:null}) }) }) }) }) };
  const ctx = vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','logic.js'),'utf8'), ctx, {filename:'hosted/logic.js'});
  // data.js provides loadState/saveState/fetchClientEvents that app.js expects
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','data.js'),'utf8'), ctx, {filename:'hosted/data.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','app.js'),'utf8'), ctx, {filename:'hosted/app.js'});
  return ctx;
}

test('every GhostBuster Today row shape renders without throwing', () => {
  const ctx = makeHostedCtx();
  // One contact per branch the row builder can take: a due text, a call
  // recommendation, a waiting send, an unanswered one, and a reply.
  const seed = `
    STATE = buildDefaultState();
    var mk = function(id, over){
      var c = sanitizeClient(Object.assign({id:id, name:id, phone:'2135550100',
        bookedDate: new Date(Date.now()-20*86400000).toISOString(),
        timezone:'America/Chicago', status:'Booked'}, over));
      STATE.clients[id] = c; return c;
    };
    mk('due',      {callDateTime: new Date(Date.now()+5*86400000).toISOString()});
    mk('imminent', {status:'Confirmed', callDateTime: new Date(Date.now()+8*60000).toISOString()});
    mk('waiting',  {callDateTime: new Date(Date.now()+9*86400000).toISOString(),
                    messageLog:[{id:'m1',stage:'welcome',variantId:'w1',text:'hi',
                      sentAt:new Date(Date.now()-3*3600000).toISOString(),responded:false,respondedAt:null,reviewed:false}]});
    mk('unanswered',{callDateTime: new Date(Date.now()+9*86400000).toISOString(),
                    messageLog:[{id:'m2',stage:'welcome',variantId:'w1',text:'hi',
                      sentAt:new Date(Date.now()-4*86400000).toISOString(),responded:false,respondedAt:null,reviewed:false}]});
    mk('replied',  {callDateTime: new Date(Date.now()+9*86400000).toISOString(),
                    messageLog:[{id:'m3',stage:'welcome',variantId:'w1',text:'hi',
                      sentAt:new Date(Date.now()-2*86400000).toISOString(),responded:true,
                      respondedAt:new Date(Date.now()-1*86400000).toISOString(),reviewed:true}]});
    mk('nophone',  {phone:'', callDateTime: new Date(Date.now()+9*86400000).toISOString()});
  `;
  vm.runInContext(seed, ctx);
  assert.doesNotThrow(() => vm.runInContext('renderGhostToday()', ctx),
    'the ranked queue must render for every row shape');
});

test('the email library renders, empty and full', () => {
  const ctx = makeHostedCtx();
  vm.runInContext('STATE = buildDefaultState(); STATE.emailLibrary = [];', ctx);
  assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx),
    'an account with no emails must still get a page telling it what to do');

  vm.runInContext(`
    STATE.emailLibrary = [
      {id:'a', title:'Pricing breakdown', whenToSend:'after they ask what it costs',
       subject:'The numbers', body:'Hi {name},\\n\\n' + 'Detail. '.repeat(300), sortOrder:0},
      {id:'b', title:'Untitled email', whenToSend:'', subject:'', body:'', sortOrder:10}
    ];
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx),
    'a long email and a blank one are both ordinary rows');

  // The expanded state is a different render path — 18-row textarea, the
  // whole edit form — and it is the one a person actually spends time in.
  vm.runInContext("LIB_OPEN = 'a';", ctx);
  assert.doesNotThrow(() => vm.runInContext('renderEmailLibrary()', ctx),
    'the open entry must render');
});

test('the picker renders for a contact, and when the library is empty', () => {
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.senderName = 'Johnny';
    STATE.myCalendars = ['john@marketmakermgmt.com'];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Dana', email:'dana@example.com',
      phone:'2135550100', callDateTime:new Date(Date.now()+86400000).toISOString(),
      timezone:'America/New_York', status:'Booked'});
    STATE.emailLibrary = [];
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext("openEmailPicker(STATE.clients['c1'])", ctx),
    'with nothing in the library the picker must explain, not throw');

  vm.runInContext(`
    STATE.emailLibrary = [{id:'a', title:'Day of', whenToSend:'the morning of the call',
      subject:'Today at {time}', body:'Hi {name}, link: {link}', sortOrder:0}];
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext("openEmailPicker(STATE.clients['c1'])", ctx));

  // The part that matters: the row is a real Gmail link, filled in, pinned to
  // the business account.
  const html = vm.runInContext("el('modal-root').innerHTML", ctx);
  assert.ok(html.includes('mail.google.com'), 'each row must be a real compose link');
  assert.ok(html.includes('authuser=john%40marketmakermgmt.com'),
    'a client email must not be able to leave from a personal Gmail');
  assert.ok(html.includes('Dana'), 'the email should already be filled in for this contact');
  assert.ok(html.includes('the morning of the call'),
    'the timing note is what someone reads to pick');
});

test('a contact with no email is never offered one', () => {
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    STATE.emailLibrary = [{id:'a', title:'Day of', subject:'s', body:'b', sortOrder:0}];
    STATE.clients['c1'] = sanitizeClient({id:'c1', name:'NoMail', phone:'2135550100',
      callDateTime:new Date(Date.now()+86400000).toISOString(),
      timezone:'America/New_York', status:'Booked'});
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext('renderAll()', ctx));
  // Asserted at the seam that decides it, rather than by grepping rendered
  // markup — the DOM stub does not serialize, so a markup assertion here would
  // pass whatever the code did.
  assert.strictEqual(vm.runInContext("canEmail(STATE.clients['c1'])", ctx), false);
  assert.strictEqual(vm.runInContext("canEmail({email:'d@e.com', emailStatus:'ok'})", ctx), true);
  assert.strictEqual(vm.runInContext("canEmail({email:'d@e.com', emailStatus:'bounced'})", ctx), false,
    'a bounced address is worse than no address: it costs sending reputation');
});

test('the whole hosted render pass does not throw', () => {
  const ctx = makeHostedCtx();
  vm.runInContext(`
    STATE = buildDefaultState();
    for (var i = 0; i < 6; i++){
      var id = 'c' + i;
      STATE.clients[id] = sanitizeClient({id:id, name:'Client ' + i, phone:'2135550100',
        bookedDate: new Date(Date.now()-30*86400000).toISOString(),
        callDateTime: new Date(Date.now() + (i-2)*86400000).toISOString(),
        timezone:'America/Chicago',
        status:['Booked','Confirmed','Completed','No-show','Ghosted','Rescheduled'][i],
        messageLog:[{id:'x'+i,stage:'welcome',variantId:'w1',text:'hi',
          sentAt:new Date(Date.now()-5*86400000).toISOString(),
          responded: i % 2 === 0, respondedAt: i % 2 === 0 ? new Date(Date.now()-4*86400000).toISOString() : null,
          reviewed:true}]});
    }
  `, ctx);
  assert.doesNotThrow(() => vm.runInContext('renderAll()', ctx));
});

test('the hosted render pass survives an empty account', () => {
  const ctx = makeHostedCtx();
  vm.runInContext('STATE = buildDefaultState();', ctx);
  assert.doesNotThrow(() => vm.runInContext('renderAll()', ctx));
});

console.log('\n--- failing saves are visible ---');

test('a rejected write reports unhealthy, a successful one reports healthy', async () => {
  const d = makeDataCtx();
  // Swap in a database that rejects everything.
  d.ctx.window.GB_SUPABASE.from = () => ({
    upsert: () => Promise.resolve({error: {message: 'permission denied'}}),
    insert: () => Promise.resolve({error: {message: 'permission denied'}}),
    delete: () => ({in: () => Promise.resolve({error: {message: 'permission denied'}})}),
    select: () => ({eq: () => ({order: () => ({limit: async () => ({data: [], error: null})})})})
  });
  d.run(`
    var st = buildDefaultState();
    st.clients['c1'] = sanitizeClient({id:'c1', name:'A', phone:'5125551234'});
  `);
  await d.run('saveState(st)');
  const bad = d.ctx.window.GB_SAVE_HEALTH;
  assert.ok(bad && bad.ok === false, 'a rejected write must report unhealthy, not fail silently');
  assert.ok(/permission denied/.test(bad.detail || ''), 'and must carry the real reason');
});

test('the failure is surfaced through a window property, not a shared name', () => {
  // The bug this exists to catch was itself caused by two files declaring the
  // same top-level function name. Using one here would be an unusually direct
  // way to reintroduce it.
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  assert.ok(data.includes('window.GB_ON_SAVE_HEALTH'), 'data.js must report through the window hook');
  assert.ok(app.includes('window.GB_ON_SAVE_HEALTH ='), 'app.js must install it as a property');
  assert.ok(!/^function GB_ON_SAVE_HEALTH/m.test(app), 'must not be a top-level declaration');
});

test('the warning is persistent, not a toast', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const block = app.slice(app.indexOf('window.GB_ON_SAVE_HEALTH ='), app.indexOf('function renderAll()'));
  assert.ok(!/showToast/.test(block),
    'a toast disappears, and what this announces is that work is disappearing');
  assert.ok(/classList\.remove\('hidden'\)/.test(block), 'it must actually show the banner');
});

test('a save that had nothing to write still reports healthy', () => {
  // Otherwise the banner would linger after the first no-op save and train
  // everyone to ignore it.
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/if\(!writes\.length\)\{ reportSaveHealth\(true\); return; \}/.test(data));
});

console.log('\n--- end of day is actionable ---');

function renderEodHtml(seed){
  const ctx = makeHostedCtx();
  vm.runInContext('openModalHtml = function(html){ __LAST = html; };', ctx);
  vm.runInContext('STATE = buildDefaultState();' + seed + 'renderEndOfDay();', ctx);
  return vm.runInContext('__LAST', ctx) || '';
}

test('a past call with no outcome can be resolved from the list itself', () => {
  // The whole reason 24 calls sat unlogged: the list named them and then made
  // you go find each contact.
  const html = renderEodHtml(`
    STATE.clients['a'] = sanitizeClient({id:'a', name:'Karen Villegas', phone:'2135550100',
      bookedDate: new Date(Date.now()-30*86400000).toISOString(),
      callDateTime: new Date(Date.now()-6*86400000).toISOString(),
      timezone:'America/Chicago', status:'Booked'});
  `);
  assert.ok(html.includes('Karen Villegas'), 'the contact should be listed');
  ['Showed','No-show','Rescheduled'].forEach(o =>
    assert.ok(html.includes('data-status="' + o + '"'), 'missing a one-click ' + o + ' action'));
});

test('a completed call with no result offers closed / not closed', () => {
  const html = renderEodHtml(`
    STATE.clients['b'] = sanitizeClient({id:'b', name:'Dana Reed', phone:'2135550101',
      bookedDate: new Date(Date.now()-30*86400000).toISOString(),
      callDateTime: new Date(Date.now()-3*86400000).toISOString(),
      timezone:'America/Chicago', status:'Completed'});
  `);
  assert.ok(html.includes('data-close="Closed"') && html.includes('data-close="Not closed"'));
});

test('an empty day says so instead of rendering empty sections', () => {
  const html = renderEodHtml('');
  assert.ok(/Busted/i.test(html), 'a cleared day should be celebrated, not blank');
  assert.ok(!html.includes('eod-row'), 'no rows should render for an empty day');
});

test('acting on a row does not close the list', () => {
  // A modal that shuts after every click turns 44 items into 44 trips.
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const block = app.slice(app.indexOf("case 'eod-outcome':"), app.indexOf("case 'end-of-day':"));
  assert.ok(block.includes('renderEndOfDay()'), 'each action must re-render the list in place');
  assert.ok(!block.includes('closeModal()'), 'no action here should close the modal');
});

test('outcomes recorded here go through the same seam as everywhere else', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const block = app.slice(app.indexOf("case 'eod-outcome':"), app.indexOf("case 'end-of-day':"));
  assert.ok(block.includes('setOutcome(STATE'), 'must use setOutcome, not a parallel write');
  assert.ok(block.includes('lastSnapshot'), 'must stay undoable like other outcome changes');
});

console.log('\n--- incremental persistence (hosted/data.js) ---');

// hosted/data.js is browser+Supabase code, so it gets its own vm context with a
// recording stub in place of supabase-js. These tests exist for one reason: the
// old saveState deleted the entire message log on every call, and "it only
// deletes things it should" is exactly the property that silently stops holding.
// mutators call saveState() fire-and-forget; let those microtasks settle
// rather than issuing a second, racing save from the test itself.
const flush = () => new Promise(r => setTimeout(r, 0));

function makeDataCtx(){
  const calls = [];
  function table(name){
    const rec = (op) => (payload) => {
      const entry = {table: name, op, payload, filters: []};
      calls.push(entry);
      const chain = {
        eq(k,v){ entry.filters.push(['eq',k,v]); return chain; },
        in(k,v){ entry.filters.push(['in',k,v]); return chain; },
        not(k,o,v){ entry.filters.push(['not',k,o,v]); return chain; },
        then(res){ return Promise.resolve({error:null, data:[]}).then(res); }
      };
      return chain;
    };
    return {upsert: rec('upsert'), insert: rec('insert'), delete: rec('delete'), select: rec('select')};
  }
  const sandbox = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, isNaN, parseInt, parseFloat,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2,10) },
    window: { GB_SUPABASE: { auth: { getUser: async () => ({data:{user:{id:'u1', email:'a@b.com'}}}) }, from: table } }
  };
  sandbox.window.window = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','logic.js'),'utf8'), ctx, {filename:'hosted/logic.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','data.js'),'utf8'), ctx, {filename:'hosted/data.js'});
  return {ctx, calls, run: (src) => vm.runInContext(src, ctx)};
}

/* A loadState harness, with per-table control over what comes back.

   makeDataCtx only ever exercises saveState. Nothing tested loadState, which
   is how a hard `throw` on a brand-new table reached production: deploy the
   code before its migration and loadState rejects on a relation that does not
   exist, so NOBODY can open the app — not the new tab, the whole thing. */
function makeLoadCtx(tableResults){
  const results = tableResults || {};
  function table(name){
    const res = () => Promise.resolve(
      Object.prototype.hasOwnProperty.call(results, name) ? results[name] : {data: [], error: null});
    const chain = {
      eq(){ return chain; }, order(){ return chain; }, not(){ return chain; },
      maybeSingle(){ return res(); },
      then(ok, bad){ return res().then(ok, bad); }
    };
    return {select(){ return chain; },
            insert(){ return {select(){ return chain; }, then(ok,bad){ return res().then(ok,bad); }}; },
            upsert(){ return chain; }, delete(){ return chain; }};
  }
  const sandbox = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, isNaN, parseInt, parseFloat, Set,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2,10) },
    window: { GB_SUPABASE: { auth: { getUser: async () => ({data:{user:{id:'u1', email:'a@b.com'}}}) }, from: table } }
  };
  sandbox.window.window = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','logic.js'),'utf8'), ctx, {filename:'hosted/logic.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','data.js'),'utf8'), ctx, {filename:'hosted/data.js'});
  return {ctx, run: (src) => vm.runInContext(src, ctx)};
}

test('a missing email_library degrades to an empty one — it never takes the app down', async () => {
  // Exactly what a code deploy ahead of its migration looks like.
  const d = makeLoadCtx({
    email_library: {data: null, error: {message: 'relation "public.email_library" does not exist', code: '42P01'}}
  });
  const state = await d.run('loadState()');
  assert.ok(state, 'loadState must still return a usable state');
  assert.strictEqual(state.emailLibrary.length, 0, 'no library, rather than no app');
  assert.ok(state.clients, 'the rest of the account must still load');
  // And it must NOT raise the save-failure banner. That bar reads "Your
  // changes aren't being saved. Anything you do now will be lost" — which was
  // false here, and a user read it and reported their work was not saving.
  // A failed read is not a failed write.
  const health = d.run('window.GB_SAVE_HEALTH');
  assert.ok(!health || health.ok !== false,
    'a failed library READ must never claim writes are failing: ' + JSON.stringify(health));
  // The tab says so instead, where it is true.
  assert.strictEqual(state.emailLibraryUnavailable, true);
});

test('a healthy load does not mark the library unavailable', () => {
  // Otherwise every normal load would show the notice.
  const d = makeLoadCtx({});
  return d.run('loadState()').then(state => {
    assert.ok(!state.emailLibraryUnavailable);
  });
});

test('a healthy load reports no problem and carries the library through', async () => {
  const d = makeLoadCtx({
    email_library: {data: [{id:'a', title:'Pricing breakdown', when_to_send:'after they ask what it costs',
      subject:'The numbers', body:'Hi {name},', sort_order:0, archived:false, updated_at:'2026-09-30T00:00:00Z'}],
      error: null}
  });
  const state = await d.run('loadState()');
  assert.strictEqual(state.emailLibrary.length, 1);
  assert.strictEqual(state.emailLibrary[0].whenToSend, 'after they ask what it costs',
    'the snake_case column must map to the camelCase field the UI reads');
  assert.strictEqual(state.emailLibrary[0].title, 'Pricing breakdown');
});

test('hosted/data.js parses and defines the persistence seam', () => {
  const d = makeDataCtx();
  assert.strictEqual(d.run('typeof saveState'), 'function');
  assert.strictEqual(d.run('typeof buildSyncSnapshot'), 'function');
  assert.strictEqual(d.run('typeof diff'), 'function');
});

test('with no baseline loaded, a save NEVER issues a delete', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.clients['c1'] = sanitizeClient({id:'c1', name:'A', phone:'5125551234'});
  `);
  await d.run('saveState(st)');
  const deletes = d.calls.filter(c => c.op === 'delete');
  assert.deepStrictEqual(deletes, [], 'a save before any load must not delete anything, got ' + JSON.stringify(deletes));
});

test('an unchanged save writes nothing at all', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.clients['c1'] = sanitizeClient({id:'c1', name:'A', phone:'5125551234'});
  `);
  await d.run('saveState(st)');
  const after = d.calls.length;
  await d.run('saveState(st)');
  assert.strictEqual(d.calls.length, after, 'a no-op save should issue zero writes');
});

test('reviewing one message writes only that message, and deletes nothing', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    var c = sanitizeClient({id:'c1', name:'A', phone:'5125551234'});
    st.clients['c1'] = c;
    markSent(st, 'c1', 'welcome', 'hello there');
  `);
  await d.run('saveState(st)');
  d.calls.length = 0;
  d.run("reviewMessage(st, 'c1', 0, true)");   // saves internally
  await flush();
  const msgWrites = d.calls.filter(c => c.table === 'message_log');
  const deletes = d.calls.filter(c => c.op === 'delete');
  assert.deepStrictEqual(deletes, [], 'reviewing must never delete — the old code deleted the whole log here');
  assert.strictEqual(msgWrites.length, 1, 'exactly one message write expected, got ' + msgWrites.length);
  assert.strictEqual(msgWrites[0].payload.length, 1, 'only the reviewed message should be written');
});

test('a missing email_library table does not stop anything else from saving', async () => {
  // The reported symptom, and the one that has now bitten twice: one rejected
  // write in a batched save, and the user is told nothing is being saved.
  // With no library loaded there is nothing to write, so the save must be
  // completely unaffected.
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.emailLibrary = [];
    st.clients['c1'] = sanitizeClient({id:'c1', name:'Ethan lead', phone:'5125551234'});
  `);
  await d.run('saveState(st)');
  const libWrites = d.calls.filter(c => c.table === 'email_library');
  assert.strictEqual(libWrites.length, 0, 'an empty library must not write to a table that may not exist');
  const clientWrites = d.calls.filter(c => c.table === 'clients');
  assert.strictEqual(clientWrites.length, 1, 'the contact must still save');
  const health = d.run('window.GB_SAVE_HEALTH');
  assert.strictEqual(health.ok, true, 'the save must report healthy: ' + JSON.stringify(health));
});

test('an email in the library is written with the columns the table actually has', async () => {
  // A wrong column name here is not a cosmetic bug: the whole save is one
  // batch, so one rejected write means nothing saves and the user's only
  // symptom is "changes are not being saved". That has now happened twice.
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.emailLibrary = [{id:'11111111-1111-1111-1111-111111111111',
      title:'Pricing breakdown', whenToSend:'after they ask what it costs',
      subject:'The numbers', body:'Hi {name},', sortOrder:0, archived:false}];
  `);
  await d.run('saveState(st)');
  const writes = d.calls.filter(c => c.table === 'email_library');
  assert.strictEqual(writes.length, 1, 'expected exactly one email_library write');
  const row = writes[0].payload[0];

  // Read the real column list out of the migration rather than restating it,
  // so this test tracks the schema instead of a copy of it.
  const sql = fs.readFileSync(path.join(__dirname,'supabase','migrations',
    '20260930030000_email_library.sql'), 'utf8');
  const table = sql.slice(sql.indexOf('create table'), sql.indexOf(');'));
  const cols = new Set([...table.matchAll(/^\s{2}([a-z_]+)\s/gm)].map(m => m[1]));
  assert.ok(cols.has('when_to_send'), 'sanity: the column parse found nothing');

  const unknown = Object.keys(row).filter(k => !cols.has(k));
  assert.deepStrictEqual(unknown, [],
    'saveState writes column(s) email_library does not have, which fails the whole save: ' + unknown.join(', '));
  assert.strictEqual(row.when_to_send, 'after they ask what it costs',
    'the timing note must survive to the database — it is the most useful field');
  assert.strictEqual(row.body, 'Hi {name},', 'stored unrendered: this is a template, not one contact\'s mail');
});

test('editing one email writes only that email, and an unchanged library writes nothing', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.emailLibrary = [
      {id:'11111111-1111-1111-1111-111111111111', title:'One', whenToSend:'', subject:'s', body:'b', sortOrder:0, archived:false},
      {id:'22222222-2222-2222-2222-222222222222', title:'Two', whenToSend:'', subject:'s', body:'b', sortOrder:10, archived:false}
    ];
  `);
  await d.run('saveState(st)');
  const before = d.calls.length;
  await d.run('saveState(st)');
  assert.strictEqual(d.calls.length, before,
    'a no-op save must write nothing — updated_at stamped onto the snapshot row would make every save rewrite every email');

  d.calls.length = 0;
  d.run("st.emailLibrary[1].body = 'edited';");
  await d.run('saveState(st)');
  const writes = d.calls.filter(c => c.table === 'email_library');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].payload.length, 1, 'only the edited email should be written');
  assert.strictEqual(writes[0].payload[0].id, '22222222-2222-2222-2222-222222222222');
});

test('deleting an email deletes by explicit id, and never before a baseline exists', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.emailLibrary = [{id:'11111111-1111-1111-1111-111111111111', title:'One', whenToSend:'', subject:'s', body:'b', sortOrder:0, archived:false}];
  `);
  // No baseline loaded yet: a save must not read an empty-looking diff as
  // "the user deleted their library".
  d.run('st.emailLibrary = [];');
  await d.run('saveState(st)');
  assert.deepStrictEqual(
    d.calls.filter(c => c.table === 'email_library' && c.op === 'delete'), [],
    'with no baseline, a save must NEVER delete an email someone wrote');
});

test('deleting a client deletes by explicit id, never by a negated filter', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.clients['c1'] = sanitizeClient({id:'c1', name:'A', phone:'5125551234'});
    st.clients['c2'] = sanitizeClient({id:'c2', name:'B', phone:'5125551235'});
  `);
  await d.run('saveState(st)');
  d.calls.length = 0;
  d.run("deleteClient(st, 'c2')");   // saves internally
  await flush();
  const del = d.calls.filter(c => c.op === 'delete' && c.table === 'clients');
  assert.strictEqual(del.length, 1);
  // vm-realm arrays aren't deepStrictEqual-compatible with this realm's (see
  // the note by isoDaysAgo) — compare by value.
  assert.strictEqual(JSON.stringify(del[0].filters), JSON.stringify([['in','id',['c2']]]),
    'must target exactly the removed id');
});

test('events are appended, never rewritten', async () => {
  const d = makeDataCtx();
  d.run(`
    var st = buildDefaultState();
    st.clients['c1'] = sanitizeClient({id:'c1', name:'A', phone:'5125551234'});
    markSent(st, 'c1', 'welcome', 'hello there');
  `);
  await d.run('saveState(st)');
  const ev = d.calls.filter(c => c.table === 'events');
  assert.ok(ev.length >= 1, 'expected an events write');
  assert.ok(ev.every(e => e.op === 'insert'), 'events must only ever be inserted');
  const kinds = ev.flatMap(e => e.payload.map(r => r.kind));
  assert.ok(kinds.includes('message.sent'), 'expected message.sent, got ' + kinds.join(','));
  // and they must not be re-sent on the next save
  d.calls.length = 0;
  await d.run('saveState(st)');
  assert.deepStrictEqual(d.calls.filter(c => c.table === 'events'), [], 'drained events must not be written twice');
});

Promise.all(pendingTests).then(() => {
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All tests passed') + '\n');
  process.exit(failures ? 1 : 0);
});
