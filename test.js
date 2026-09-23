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
  const noshowClient = freshClient({
    id: 'c-noshow', bookedDate: isoDaysAgo(10), callDateTime: isoDaysAgo(2),
    status: 'No-show',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(9), responded: false, respondedAt: null }]
  });
  const newBookingClient = freshClient({
    id: 'c-new-welcome', bookedDate: new Date().toISOString(), callDateTime: isoDaysFromNow(21)
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
  const now = new Date();
  const c = freshClient({
    bookedDate: isoDaysAgo(5),
    callDateTime: now.toISOString(),
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(4), responded: false, respondedAt: null }]
  });
  const due = GB.computeDue(c, now);
  assertDue(due, ['dayof']);
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

test('No-show 30 days ago -> nothing due', () => {
  const c = freshClient({ status: 'No-show', callDateTime: isoDaysAgo(30) });
  assertDue(GB.computeDue(c, new Date()), []);
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
    id: 'c-noshow-2', bookedDate: isoDaysAgo(10), callDateTime: isoDaysAgo(2), status: 'No-show',
    messageLog: [{ stage: 'welcome', variantId: 'w1', text: 'hi', sentAt: isoDaysAgo(9), responded: false, respondedAt: null }]
  });
  const rebookedClient = freshClient({ id: 'c-rebooked', callDateTime: isoDaysFromNow(3), rebooked: true });
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

console.log('\n--- a reschedule restarts the appointment touches ---');

test('a moved call gets a fresh day-of text', () => {
  // The live bug: a day-of text sent for the OLD date marked the stage sent
  // forever, so the new date never got one. 11 upcoming clients were stranded.
  const c = freshClient({
    bookedDate: isoDaysAgo(40),
    callDateTime: new Date(new Date().setHours(16, 0, 0, 0)).toISOString(),  // today
    reschedules: [isoDaysAgo(3)],
    messageLog: [{stage:'dayof',variantId:'d1',text:'x',sentAt: isoDaysAgo(30),
      responded:false, respondedAt:null, reviewed:true}]
  });
  assert.ok(GB.computeDue(c, new Date()).includes('dayof'),
    'a day-of text sent for a call a month ago must not block today’s');
});

test('but the same text sent since the move is not sent twice', () => {
  const c = freshClient({
    bookedDate: isoDaysAgo(40),
    callDateTime: new Date(new Date().setHours(16, 0, 0, 0)).toISOString(),
    reschedules: [isoDaysAgo(3)],
    messageLog: [{stage:'dayof',variantId:'d1',text:'x',sentAt: new Date().toISOString(),
      responded:false, respondedAt:null, reviewed:false}]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('dayof'));
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
    callDateTime: new Date(new Date().setHours(16, 0, 0, 0)).toISOString(),
    reschedules: [],
    messageLog: [{stage:'dayof',variantId:'d1',text:'x',sentAt: new Date().toISOString(),
      responded:false, respondedAt:null, reviewed:false}]
  });
  assert.ok(!GB.computeDue(c, new Date()).includes('dayof'));
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
    ['welcome','monday','midcheckin','dayof','hourbefore','recovery','noshow']);
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

test('hosted/data.js parses and defines the persistence seam', () => {
  const d = makeDataCtx();
  assert.strictEqual(d.run('typeof saveState'), 'function');
  assert.strictEqual(d.run('typeof snapshot'), 'function');
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
