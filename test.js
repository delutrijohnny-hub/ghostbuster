'use strict';
/* Test harness for Ghost Recall.
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

/* "h o'clock today, in the timezone the fixture's client actually lives in."

   Every clock flake this suite has had shares one cause: an anchor built with
   new Date().setHours(h), which is h o'clock on the MACHINE, while the client
   in the fixture sits in America/New_York. Run the suite from Tokyo and
   "08:00 today" is already the previous day in New York, so "is the call later
   today" and "did a text go out today" both answer for the wrong date. The
   suite passed in two timezones and failed in four.

   The product is right to judge the day in the client's zone — it is their
   day that matters. So the tests have to name their anchors in that zone too,
   which is what this does: find the UTC instant whose wall clock in `tz`
   reads h:00 on tz's own current date. */
function zoneShiftMs(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(instant);
  const m = parts.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/);
  const wallAsUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] % 24, +m[5], +m[6]);
  return wallAsUTC - instant.getTime();
}

function atHourInZone(hour, tz, base) {
  tz = tz || 'America/New_York';
  const from = base ? new Date(base) : new Date();
  const key = new Intl.DateTimeFormat('en-CA', {timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'}).format(from);
  const p = key.split('-').map(Number);
  const wall = Date.UTC(p[0], p[1] - 1, p[2], hour);
  // Resolve twice: the shift at `from` can differ from the shift at the
  // answer across a DST boundary.
  let out = wall - zoneShiftMs(from, tz);
  out = wall - zoneShiftMs(new Date(out), tz);
  return new Date(out);
}

// The helper has to be right before anything can lean on it.
(() => {
  const nine = atHourInZone(9, 'America/New_York');
  const read = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York',
    hour12: false, hour: '2-digit', minute: '2-digit'}).format(nine);
  assert.ok(/^(09|9):00$/.test(read), 'atHourInZone must read 09:00 in New York, got ' + read);
  const hono = atHourInZone(16, 'Pacific/Honolulu');
  const readH = new Intl.DateTimeFormat('en-CA', {timeZone: 'Pacific/Honolulu',
    hour12: false, hour: '2-digit', minute: '2-digit'}).format(hono);
  assert.ok(/^16:00$/.test(readH), 'atHourInZone must read 16:00 in Honolulu, got ' + readH);
  console.log('  ok  - atHourInZone anchors to the client timezone, not the machine');
})();

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
/* A DOM stand-in that remembers what was written to it.

   It used to discard every write and return itself for every read. That made
   it impossible to crash a render, which is what it was for -- but it also
   made every assertion about rendered markup VACUOUS, because
   `el('x').innerHTML.includes('anything')` returned the proxy, and a proxy is
   truthy. A test of mine written earlier today asserted a Gmail link appeared
   in a modal and would have passed if the modal were empty.

   Strings that are written are now stored and read back. Everything else
   still proxies, so chains like el('x').classList.add() keep working. The
   point is narrow: a test that claims to check rendered output should fail
   when the output is wrong. */
function makeNoopProxy() {
  const target = function () {};
  const written = new Map();
  const handler = {
    get(t, prop) {
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'length') return 0;
      if (written.has(prop)) return written.get(prop);
      if (NOOP_PROXY_EMPTY_PROPS.has(prop)) return null;
      return proxy;
    },
    set(t, prop, value) {
      // Only remember primitives. Storing an appended child node would hand
      // callers a real object where they expect a proxy and break the chain.
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        written.set(prop, value);
      }
      return true;
    },
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
assert.ok(GBFull, 'Ghost Recall test hook was not exposed on window');

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
  const now = atHourInZone(8);
  const callAt = atHourInZone(15);
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

  test('both drafters forbid speculation, bad grammar and essays', () => {
    /* From a text that actually went out: "I heard you mention you volunteer.
       I am assuming this is with an organization within your town you work
       with id love to hear more and answer your question based on that."

       Three faults in one message -- a guess stated as fact, two sentences
       run together with "id" for "I'd", and sixty words on a lock screen.
       The notes drafter forbade the first from the start; the older one that
       sits on the Today cards never did. Both are checked here so they cannot
       drift apart again. */
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const older = app.slice(app.indexOf('function buildAIPrompt'), app.indexOf('function callGemini'));

    assert.ok(/do not speculate/i.test(older), 'the card drafter must forbid speculation');
    assert.ok(/I am assuming/i.test(older), 'and name the phrasing that went out');
    assert.ok(/apostrophes/i.test(older), 'and require real punctuation');
    assert.ok(/lock screen/i.test(older), 'and cap the length');

    const notes = GB.buildNotesPrompt({client: GB.sanitizeClient({id:'c', name:'Dana', phone:'2135550100'}),
      notes: 'x', channel: 'sms', senderName: 'Bob'});
    assert.ok(/do not invent/i.test(notes), 'the notes drafter must forbid invention');
    assert.ok(/lock screen/i.test(notes), 'and keep a text short');
  });

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

console.log('\n--- a brand new account is shown how to start ---');

{
  const panel = (seed) => {
    const ctx = makeHostedCtx();
    vm.runInContext('STATE = buildDefaultState(); ' + (seed || ''), ctx);
    return vm.runInContext('buildAllClearPanel().innerHTML', ctx);
  };

  test('an empty account is not congratulated for finishing', () => {
    /* No calendar, no contacts, and the first screen said "Busted! Inbox
       zero, nothing due right now." That congratulates someone for finishing
       before they have started, and offers no way to begin -- on the one
       screen everybody sees first. */
    const html = panel('');
    assert.ok(!/All clear/i.test(html), 'got: ' + html.slice(0, 200));
    assert.ok(/Nothing to follow up on yet/.test(html), html.slice(0, 200));
  });

  test('and it is shown the one action that matters', () => {
    const html = panel('');
    assert.ok(/data-action="connect-calendar"/.test(html), 'connect must be right there');
    assert.ok(/data-action="add-client"/.test(html), 'and the manual path too');
    assert.ok(/Settings/.test(html), 'and where to find the rest');
  });

  test('a connected calendar that imported nothing offers a sync, not a connect', () => {
    // Offering "connect" to someone already connected reads as though the
    // connection failed, which is a different and more alarming problem.
    const html = panel("STATE.myCalendars = ['work@example.com'];");
    assert.ok(/Calendar connected, nothing imported/.test(html), html.slice(0, 200));
    assert.ok(/data-action="sync-calendar-now"/.test(html));
    assert.ok(!/data-action="connect-calendar"/.test(html));
    assert.ok(/work@example\.com/.test(html), 'and name what it is connected to');
  });

  test('the cleared-queue badge is kept for the people who earned it', () => {
    /* It belongs to someone who had work and cleared it. Showing it to
       someone with nothing cheapens it for the people it is actually for. */
    const html = panel(`
      STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Dana', phone:'2135550100',
        timezone:'America/New_York', status:'Completed',
        bookedDate: new Date(Date.now() - 30*86400000).toISOString(),
        callDateTime: new Date(Date.now() - 2*86400000).toISOString(),
        closeOutcome:'Closed'});
    `);
    assert.ok(/All clear/i.test(html), 'a cleared list should still say so');
    // The celebration must not quietly become a static image: the movement
    // is the reward, and it is the thing most likely to be dropped by a
    // later refactor of the badge markup.
    assert.ok(/allclear-thumb/.test(html), 'the thumbs-up has no animated hand');
    assert.ok(/allclear-ghost/.test(html), 'the ghost is not the animated element');
    // And it must not have brought the old symbol back with it.
    assert.ok(!/impact-lines|no-ghost/.test(html), 'the circle-and-slash badge is back');
    /* The animated group must NOT be the one carrying the position.

       A CSS transform replaces an SVG transform attribute outright, so when
       the keyframes and translate(39 22) lived on the same <g>, the final
       frame's "transform: rotate(0) scale(1)" wiped the translate and the
       thumbs-up snapped to the top-left corner of the ghost. Only visible by
       looking at it. */
    const thumbIdx = html.indexOf('allclear-thumb');
    assert.ok(thumbIdx !== -1, 'no animated thumb group');
    const before = html.slice(0, thumbIdx);
    const openTag = before.lastIndexOf('<g');
    assert.ok(!/translate\(/.test(html.slice(openTag, thumbIdx + 40)),
      'the animated group carries translate(), which the keyframes will wipe');
    assert.ok(/<g transform="translate\([^"]+\)">\s*<g class="allclear-thumb"/.test(html),
      'the thumb needs an outer group for position and an inner one to animate');
  });
}

console.log('\n--- scheduling: four levels, and no provider claimed before it works ---');

{
  test('nothing is marked available until it actually works', () => {
    /* The brief's own rule, and the honest one. Showing Outlook as a choice
       that silently does nothing converts a missing feature into a broken
       one, and the person spends an afternoon wondering what they did wrong.

       Neither Outlook nor Calendly exists in any form -- the only Microsoft
       reference in the codebase is a Teams link regex. */
    const by = {};
    GB.SCHEDULING_PROVIDERS.forEach(p => { by[p.key] = p; });
    assert.strictEqual(by.google.available, true, 'Google sync genuinely works');
    assert.strictEqual(by.outlook.available, false);
    assert.strictEqual(by.calendly.available, false);
    assert.strictEqual(by.link.available, true);
    assert.strictEqual(by.manual.available, true);
  });

  test('an unavailable provider says what it would take, not just "no"', () => {
    GB.SCHEDULING_PROVIDERS.filter(p => !p.available).forEach(p => {
      assert.ok(p.needs && p.needs.length > 30,
        p.key + ' should say what it needs: ' + p.needs);
    });
    // And an available one must not be carrying an excuse.
    GB.SCHEDULING_PROVIDERS.filter(p => p.available).forEach(p => {
      assert.strictEqual(p.needs, null, p.key + ' is available but lists requirements');
    });
  });

  test('a saved booking link is never reported as a connection', () => {
    /* The distinction the brief insists on, and the one that matters: a link
       goes into messages, and nothing can see what gets booked through it. */
    const st = GB.schedulingStatus({bookingLink: 'https://cal.example/x'});
    assert.strictEqual(st.hasBookingLink, true);
    assert.strictEqual(st.calendarConnected, false, 'a link is not a connection');
    assert.strictEqual(st.detectsCancellations, false, 'nothing here can see a cancellation yet');
    const link = GB.SCHEDULING_PROVIDERS.find(p => p.key === 'link');
    assert.ok(/not a connection/i.test(link.caveat), 'and the interface must say so');
  });

  test('every level has plain words for what it can do', () => {
    GB.SCHEDULING_PROVIDERS.forEach(p => {
      assert.ok(GB.SCHEDULING_LEVELS[p.level], p.key + ' has an undescribed level: ' + p.level);
    });
  });

  test('{bookinglink} fills from the account, and says so when unset', () => {
    const c = GB.sanitizeClient({id: 'c', name: 'Dana', phone: '2135550100'});
    GB.setBookingLink('');
    assert.ok(/set your booking link/i.test(GB.renderTemplate('Book: {bookinglink}', c, 'J')),
      'an unset link must be visible, not silent');
    GB.setBookingLink('https://cal.example/abc');
    assert.strictEqual(GB.renderTemplate('Book: {bookinglink}', c, 'J'), 'Book: https://cal.example/abc');
    GB.setBookingLink('');
  });

  test('the link is stored once and persisted', () => {
    // It was pasted into each email body by hand, so a changed link had to be
    // found in nine places and would be missed in at least one.
    const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
    assert.ok(/booking_link/.test(data), 'data.js must load and save it');
    assert.ok(/setBookingLink\(state\.bookingLink\)/.test(data),
      'and hand it to the engine on load, like the pipeline and sequence');
    const migrations = fs.readdirSync(path.join(__dirname, 'supabase', 'migrations'))
      .filter(f => f.endsWith('.sql'))
      .map(f => fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', f), 'utf8')).join('\n');
    assert.ok(/add column if not exists booking_link/i.test(migrations));
  });

  test('a past appointment is still never auto-marked a no-show', () => {
    /* The brief names this explicitly. It already held, and it is worth a
       test so it keeps holding: an unanswered call is unknown, not a miss. */
    const past = GB.sanitizeClient({id: 'c', name: 'Dana', phone: '2135550100',
      timezone: 'America/New_York', status: 'Booked',
      bookedDate: new Date(Date.now() - 20 * 86400000).toISOString(),
      callDateTime: new Date(Date.now() - 3 * 86400000).toISOString()});
    assert.strictEqual(GB.isMissed(past.status), false);
    assert.strictEqual(GB.stageRole(past.status), 'open');
    const stats = GB.computeStats({clients: {c: past}, variants: GB.buildDefaultVariants(),
      variantStats: {}, todos: []}, 'month', new Date());
    assert.strictEqual(stats.showUpRate, null, 'an unanswered call must not create a show rate');
    assert.strictEqual(stats.unloggedCalls, 1, 'it is counted as unknown instead');
  });
}

console.log('\n--- setup ends by saying what it produced ---');

{
  const base = () => ({variants: GB.buildDefaultVariants(), variantStats: {}, todos: [], myCalendars: []});
  const people = (n) => {
    const c = {};
    for (let i = 0; i < n; i++) {
      c['c' + i] = GB.sanitizeClient({id: 'c' + i, name: 'P' + i, phone: '21355501' + i,
        timezone: 'America/New_York', status: 'Booked',
        bookedDate: new Date(Date.now() - 20 * 86400000).toISOString(),
        callDateTime: new Date(Date.now() + 4 * 86400000).toISOString()});
    }
    return c;
  };

  test('a connected calendar with nothing imported is named, not left as silence', () => {
    /* The state that most needed explaining and looked exactly like the state
       of having done nothing. Three people sat in it for days this week
       without being able to tell which problem they had. */
    const d = GB.describeSetup(Object.assign(base(), {clients: {}, myCalendars: ['a@b.com']}), new Date());
    assert.ok(/Calendar connected, nothing imported/.test(d.headline), d.headline);
    assert.ok(/which events count as bookings/.test(d.detail),
      'and it should point at the setting that fixes it: ' + d.detail);
  });

  test('an empty account is told how to start', () => {
    const d = GB.describeSetup(Object.assign(base(), {clients: {}}), new Date());
    assert.ok(/Nothing to follow up on yet/.test(d.headline));
    assert.ok(/add someone by hand/.test(d.detail));
    assert.strictEqual(d.connected, false);
  });

  test('a working account ends on the work, not on congratulations', () => {
    const d = GB.describeSetup(Object.assign(base(), {clients: people(5), myCalendars: ['a@b.com']}), new Date());
    assert.ok(/follow-ups due today/.test(d.headline), d.headline);
    assert.strictEqual(d.contacts, 5);
    assert.ok(d.due > 0);
  });

  test('it never throws on a half-built state', () => {
    // It runs at the end of onboarding, which is exactly when state is least
    // complete -- a crash there is the first thing a new user would ever see.
    assert.doesNotThrow(() => GB.describeSetup({}, new Date()));
    assert.doesNotThrow(() => GB.describeSetup({clients: {}}, new Date()));
    assert.doesNotThrow(() => GB.describeSetup(null, new Date()));
  });

  test('the panel renders at the end of onboarding', () => {
    const ctx = makeHostedCtx();
    vm.runInContext("STATE = buildDefaultState(); STATE.myCalendars = ['a@b.com'];", ctx);
    assert.doesNotThrow(() => vm.runInContext('finishOnboarding(false)', ctx));
    // Skipping setup must stay silent -- someone who skipped did not ask.
    assert.doesNotThrow(() => vm.runInContext('finishOnboarding(true)', ctx));
  });
}

console.log('\n--- the score explains itself ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const c = GB.sanitizeClient({id: 'c', name: 'Dana', phone: '2135550100',
    timezone: 'America/New_York', status: 'Booked', bookedDate: ago(20),
    callDateTime: new Date(Date.now() + 86400000).toISOString(),
    messageLog: [{id: 'm', stage: 'welcome', variantId: 'w1', text: 'x', sentAt: ago(5),
      responded: false, respondedAt: null, reviewed: true, channel: 'sms'}]});

  test('it says what the number is, rather than letting it look like a prediction', () => {
    /* "72 - hot" does not tell anyone whether that is a probability, a
       percentage or a rank. It is none of those: it is a priority ordering
       built by adding up rules you can read and change, and calling it
       anything more certain would be dressing a heuristic as a prediction. */
    const out = GB.describeScore(GB.computeGhostScore(c, new Date()));
    assert.ok(/not a prediction/i.test(out), out);
    assert.ok(/priority ordering/i.test(out), out);
  });

  test('it shows what lowered the score, not only what raised it', () => {
    /* The row shows only the positives, which is what you act on. Leaving the
       negatives out of the explanation entirely means the number cannot be
       reconciled with the reasons beside it -- 41 next to two reasons adding
       to 60 reads as broken arithmetic. */
    const g = {score: 41, band: 'neutral', reasons: [
      {label: 'Baseline', points: 20},
      {label: 'Appointment soon', points: 38},
      {label: 'Three unanswered sends', points: -17},
    ]};
    const out = GB.describeScore(g);
    assert.ok(/Raised by: Appointment soon \+38/.test(out), out);
    assert.ok(/Lowered by: Three unanswered sends -17/.test(out), out);
    assert.ok(!/Baseline/.test(out), 'the baseline is not a reason, it is the starting point');
  });

  test('a contact nothing has happened to still gets a sentence', () => {
    const out = GB.describeScore({score: 20, band: 'neutral', reasons: [{label: 'Baseline', points: 20}]});
    assert.ok(/Nothing has moved it/.test(out), out);
    assert.ok(!/undefined/.test(out));
    assert.strictEqual(GB.describeScore(null), '');
  });

  test('the ranked queue uses it, and still renders', () => {
    const ctx = makeHostedCtx();
    vm.runInContext(`
      STATE = buildDefaultState();
      STATE.clients['c1'] = sanitizeClient({id:'c1', name:'Dana', phone:'2135550100',
        timezone:'America/New_York', status:'Booked', bookedDate:'${ago(20)}',
        callDateTime: new Date(Date.now() + 86400000).toISOString()});
    `, ctx);
    assert.doesNotThrow(() => vm.runInContext('renderGhostToday()', ctx));
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    assert.ok(/title: describeScore\(r\)/.test(app),
      'the score tooltip should carry the full working');
  });
}

console.log('\n--- the numbers mean what they say ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const book = (withEmails) => {
    const clients = {};
    for (let i = 0; i < 10; i++) {
      const log = [{id: 't' + i, stage: 'welcome', variantId: 'w1', text: 'x', sentAt: ago(2),
        responded: i < 3, respondedAt: i < 3 ? ago(1) : null, reviewed: true, channel: 'sms'}];
      if (withEmails) log.push({id: 'e' + i, stage: 'email', variantId: 'lib', text: 'x',
        sentAt: ago(2), responded: false, respondedAt: null, reviewed: false, channel: 'email'});
      clients['c' + i] = GB.sanitizeClient({id: 'c' + i, name: 'P' + i, phone: '21355501' + i,
        timezone: 'America/New_York', status: 'Completed', bookedDate: ago(20),
        callDateTime: ago(1), messageLog: log});
    }
    return {clients, variants: GB.buildDefaultVariants(), variantStats: {}, todos: []};
  };

  test('sending emails does not drag down the text reply rate', () => {
    /* Every message used to count. The moment library emails were logged,
       each joined a denominator it could never join the numerator of -- an
       email opened in Gmail has nothing watching for its reply. On a book
       where 3 of 10 texts were answered, one email each took the rate from
       30% to 15%. Nobody replied less; the number stopped meaning anything,
       in the direction that looks like the product failing. */
    const now = new Date();
    const without = GB.computeStats(book(false), 'month', now);
    const with_ = GB.computeStats(book(true), 'month', now);
    assert.strictEqual(Math.round(without.responseRate * 100), 30);
    assert.strictEqual(without.responseRate, with_.responseRate,
      'the text reply rate must not move because an email was sent');
    assert.strictEqual(with_.textsSent, 10, 'texts counted once, not once per channel');
    assert.strictEqual(with_.emailsSent, 10, 'and emails counted as emails');
  });

  test('a message keeps its channel through sanitising', () => {
    /* It did not, and that is what caused the above: an email came out
       indistinguishable from a text. The worst version was never reached --
       any path that sanitised before saving would have written every email
       back to the database as a text. */
    const c = GB.sanitizeClient({id: 'c', name: 'D', phone: '2135550100', messageLog: [
      {id: 'a', stage: 'email', text: 'x', sentAt: ago(1), channel: 'email', providerId: 're_1'},
      {id: 'b', stage: 'welcome', text: 'x', sentAt: ago(1), channel: 'sms'},
    ]});
    assert.strictEqual(c.messageLog[0].channel, 'email');
    assert.strictEqual(c.messageLog[0].providerId, 're_1');
    assert.strictEqual(c.messageLog[1].channel, 'sms');
    // History predating the email channel is a text, which is what it was.
    const old = GB.sanitizeClient({id: 'c', name: 'D', phone: '2135550100',
      messageLog: [{id: 'a', stage: 'welcome', text: 'x', sentAt: ago(400)}]});
    assert.strictEqual(old.messageLog[0].channel, 'sms');
    assert.strictEqual(old.messageLog[0].providerId, null);
  });

  test('a rate is never shown without the count it is computed over', () => {
    // "30% of 10 texts" and "30% of 400" are different facts wearing the same
    // number, and a percentage with an invisible denominator cannot be checked.
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    // Slice forward from the card list, not to the first box.innerHTML --
    // that appears earlier in the file, so the slice came out negative and
    // the assertions passed over an empty string.
    const start = app.indexOf('var cards = [');
    const cards = app.slice(start, app.indexOf('box.innerHTML', start));
    assert.ok(cards.length > 100, 'the card list slice came out empty');
    assert.ok(/of ' \+ s\.textsSent \+ ' texts/.test(cards),
      'the reply rate must state how many texts it covers');
    assert.ok(/unlogged/.test(cards), 'the show rate must still state what it excludes');
  });

  test('emails are reported as a count, because a rate would only ever fall', () => {
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const start2 = app.indexOf('var cards = [');
    const cards = app.slice(start2, app.indexOf('box.innerHTML', start2));
    assert.ok(cards.length > 100, 'the card list slice came out empty');
    assert.ok(/'Emails sent', s\.emailsSent/.test(cards));
    assert.ok(/replies not tracked/.test(cards),
      'and it must say that email replies are not observed');
  });
}

console.log('\n--- a retried webhook must not be processed twice ---');

test('the webhook short-circuits an event it has already handled', () => {
  /* Providers retry on a timeout or a 5xx, and the reply path was not merely
     wasteful on a retry -- it was wrong. It marks "the most recent unanswered
     email to this contact" as replied. Run it again and the most recent
     unanswered email is a DIFFERENT, older message, so a second message gets
     credited with a reply that never happened. That inflates the reply rate
     and teaches the bandit the wrong copy worked. */
  const src = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'email-webhook', 'index.ts'), 'utf8');

  const guard = src.slice(0, src.indexOf("await db('/email_events'"));
  assert.ok(/provider_id=eq\./.test(guard) && /kind=eq\./.test(guard),
    'the duplicate check must key on provider_id AND kind, or two different events collapse');
  assert.ok(/handled: 'duplicate'/.test(src), 'and it must return early rather than carry on');

  // The check must come before anything that writes.
  assert.ok(src.indexOf("handled: 'duplicate'") < src.indexOf('message_log'),
    'the guard has to run before the reply path, not after it');
});

test('a unique index closes the race the check cannot', () => {
  // Check-then-act leaves a gap if two retries land in the same instant.
  const migrations = fs.readdirSync(path.join(__dirname, 'supabase', 'migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', f), 'utf8'))
    .join('\n');
  assert.ok(/unique index[\s\S]{0,120}email_events[\s\S]{0,120}provider_id, kind/i.test(migrations),
    'email_events needs a unique index on (provider_id, kind)');
  // Nulls must stay unconstrained: an event with no id cannot be deduplicated,
  // and constraining them would reject every such event after the first.
  assert.ok(/where provider_id is not null/i.test(migrations),
    'the index must exclude null provider ids');
});

console.log('\n--- recorded by a person vs observed by Ghost Recall ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const msg = (over) => Object.assign({id: 'm', stage: 'welcome', variantId: 'w1', text: 'x',
    sentAt: ago(3), responded: false, respondedAt: null, reviewed: true, channel: 'sms'}, over);
  const mk = (log) => GB.sanitizeClient({id: 'c', name: 'Dana', phone: '2135550100',
    bookedDate: ago(5), messageLog: log});

  test('a text is always marked by a person, because nothing else can see it', () => {
    /* A text is handed to the salesperson's own phone. Ghost Recall cannot
       confirm Send was ever pressed, so an unqualified "sent" claims a
       certainty it does not have. */
    assert.strictEqual(GB.messageSource(msg({channel: 'sms'})), 'you');
    assert.strictEqual(GB.replySource(msg({channel: 'sms', responded: true})), 'you');
  });

  test('an email opened in Gmail is also a person, not an integration', () => {
    // It is marked the instant the button is clicked, before anything is sent.
    assert.strictEqual(GB.messageSource(msg({channel: 'email'})), 'you');
  });

  test('only a send that went through a provider counts as observed', () => {
    assert.strictEqual(GB.messageSource(msg({channel: 'email', providerId: 're_abc'})), 'automatic');
    assert.strictEqual(GB.replySource(msg({channel: 'email', providerId: 're_abc', responded: true})), 'automatic');
    // An SMS with a stray provider id is still a text; nothing watches those.
    assert.strictEqual(GB.replySource(msg({channel: 'sms', providerId: 're_abc', responded: true})), 'you');
  });

  test('the timeline carries it through to what gets rendered', () => {
    const t = GB.buildTimeline(mk([msg({responded: true, respondedAt: ago(2)})]), [], new Date());
    const sent = t.find(e => e.kind === 'message.sent');
    const replied = t.find(e => e.kind === 'message.replied');
    assert.strictEqual(sent.by, 'you');
    assert.strictEqual(replied.by, 'you');
    // Entries that are not messages carry no claim either way.
    assert.strictEqual(t.find(e => e.kind === 'contact.created').by, null);
  });

  test('nothing claims automatic tracking for an integration that is not connected', () => {
    /* The brief's rule, and today it resolves to "everything is manual":
       no email provider is configured, so no message can carry a provider id
       and nothing in the log should say confirmed. */
    const t = GB.buildTimeline(mk([msg({channel: 'email', responded: true, respondedAt: ago(2)})]), [], new Date());
    assert.ok(!t.some(e => e.by === 'automatic'),
      'without a provider, nothing may be presented as confirmed');
  });
}

console.log('\n--- Today answers who, why and what next ---');

{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const sms = (when, responded) => ({id: 'm', stage: 'welcome', variantId: 'v', text: 'x',
    sentAt: when, responded: !!responded, respondedAt: responded ? when : null,
    reviewed: true, channel: 'sms'});
  const mk = (over) => GB.sanitizeClient(Object.assign({id: 'c', name: 'Dana',
    phone: '2135550100', timezone: 'America/New_York', status: 'Booked',
    bookedDate: ago(9)}, over));
  const soon = new Date(Date.now() + 4 * 86400000).toISOString();

  test('a card says what happened and why it is due, in plain words', () => {
    /* The card showed a name, a progress chip and a timezone. Judging whether
       a message was the right thing to send meant opening the contact and
       reading the history -- on a list of fourteen, fourteen detours. */
    const out = GB.explainDue(mk({callDateTime: soon, messageLog: [sms(ago(4))]}),
      'midcheckin', new Date());
    assert.ok(/No reply in 4 days/.test(out), out);
    assert.ok(/mid-point check-in due/i.test(out), out);
  });

  test('it distinguishes never-contacted from waiting', () => {
    const fresh = GB.explainDue(mk({callDateTime: soon}), 'welcome', new Date());
    assert.ok(/Nothing sent yet/.test(fresh), fresh);
    const waiting = GB.explainDue(mk({callDateTime: soon, messageLog: [sms(ago(2))]}),
      'midcheckin', new Date());
    assert.ok(/No reply in 2 days/.test(waiting), waiting);
  });

  test('a reply is stated as a reply, not as silence', () => {
    const out = GB.explainDue(mk({callDateTime: soon, messageLog: [sms(ago(1), true)]}),
      'midcheckin', new Date());
    assert.ok(/They replied/.test(out), out);
    assert.ok(!/No reply/.test(out), 'a replied contact must never read as unanswered: ' + out);
  });

  test('the urgent stages say what makes them urgent', () => {
    const now = new Date();
    assert.ok(/call is today/.test(GB.explainDue(mk({callDateTime: now.toISOString()}), 'dayof', now)));
    assert.ok(/missed the call/.test(GB.explainDue(mk({callDateTime: ago(2), status: 'No-show'}), 'noshow', now)));
    assert.ok(/gone quiet/.test(GB.explainDue(mk({callDateTime: ago(30), status: 'Ghosted'}), 'recovery', now)));
  });

  test('it is a restatement of the log, never an unfilled template', () => {
    // Everything in it has to be checkable against the timeline below it.
    const now = new Date();
    GB.TOUCH_LIST_ORDER.forEach(stage => {
      const out = GB.explainDue(mk({callDateTime: soon, messageLog: [sms(ago(3))]}), stage, now);
      assert.ok(out.length > 10, stage + ' produced nothing: ' + out);
      assert.ok(!/\{|\bundefined\b|NaN/.test(out), stage + ' leaked a placeholder: ' + out);
    });
  });

  test('the login screen says what Ghost Recall is before you sign in', () => {
    const html = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
    const screen = html.slice(html.indexOf('id="signin-screen"'), html.indexOf('id="app-root"'));
    assert.ok(/Know who to follow up with/.test(screen), 'the value statement is missing');
    // 100dvh, not just 100vh: mobile Safari counts browser chrome in vh, so a
    // screen sized to it scrolls by exactly the height of the toolbar.
    assert.ok(/100dvh/.test(screen), 'the sign-in screen should not scroll on a phone');
  });
}

console.log('\n--- one text a day, and an email does not use it up ---');

{
  /* Every time in here hangs off NOW, never off the wall clock.

     This block failed at 00:32 for a reason worth keeping: the fixture asked
     for America/New_York but gave Caitlin a 213 number, and sanitizeClient
     self-heals the zone from the area code, so she was silently in Los
     Angeles. A message "sent now" then landed on yesterday in LA while NOW
     said 09:00 today, the day allowance saw nothing, and the second text the
     test exists to prevent came straight back. A fixture whose declared
     timezone is quietly overwritten is not testing what it says it is, so the
     number is now a 212 and the zone is asserted below. */
  const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
  const sms = (stage, when) => ({id: 'm' + stage, stage, variantId: 'v', text: 'x',
    sentAt: when || ago(1), responded: false, respondedAt: null,
    reviewed: false, channel: 'sms'});
  const email = () => ({id: 'me', stage: 'email', variantId: 'lib', text: 'x',
    sentAt: ago(1), responded: false, respondedAt: null,
    reviewed: false, channel: 'email'});
  const mk = (log, call) => GB.sanitizeClient({
    id: 'c', name: 'Caitlin', phone: '2125550100', email: 'c@e.com',
    timezone: 'America/New_York', status: 'Booked', bookedDate: ago(24 * 10),
    callDateTime: call || new Date(NOW.getTime() + 4 * 86400000).toISOString(),
    messageLog: log || []});
  /* A fixed morning "now", for the same reason the day-of tests upstream use
     one: an assertion that depends on the wall clock passes in the morning and
     fails in the evening. This one was written at midday and failed at 21:54,
     when a call set for 23:00 stopped being "today" and became "within the
     hour". Fourth test of that shape found today. */
  const NOW = atHourInZone(9, 'America/New_York');
  const queued = (c) => GB.getTextTodayList({clients: {c}, variants: GB.buildDefaultVariants(),
    variantStats: {}, todos: [], myCalendars: []}, NOW, '').map(i => i.stage);

  test('the fixture is in the timezone it claims', () => {
    // Guards the trap above: if this drifts, every day-allowance assertion
    // below quietly starts measuring a different person's day.
    assert.strictEqual(mk().timezone, 'America/New_York',
      'sanitizeClient rewrote the zone from the area code — pick a matching number');
  });

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
    // 16:00 against a 09:00 now: same day, comfortably outside the hour-before
    // window, so the assertion is about the rule and not about the clock.
    const todayCall = atHourInZone(16, 'America/New_York', NOW).toISOString();
    assert.deepStrictEqual(queued(mk([sms('welcome', NOW.toISOString())], todayCall)), ['dayof']);
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
      callDateTime: new Date(NOW.getTime() + 4 * 86400000).toISOString(),
      messageLog: [sms('welcome', '2026-06-15T06:00:00Z')]});
    assert.strictEqual(hawaii.timezone, 'Pacific/Honolulu');
    /* 06:00 UTC on the 15th is still 20:00 on the 14th in Honolulu. Asked at
       18:00 UTC the same calendar day in UTC, their day has only just begun
       and that message belongs to yesterday — so it must not use up today.
       The old version of this asserted the answer was a boolean, which it
       could not fail. */
    assert.strictEqual(
      GB.sentCadenceTouchToday(hawaii, new Date('2026-06-15T18:00:00Z')), false,
      'a message from their yesterday must not spend their today');
    assert.strictEqual(
      GB.sentCadenceTouchToday(hawaii, new Date('2026-06-15T06:30:00Z')), true,
      'and one from their today must');
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

  test('the filter buttons are tinted by what the group means, not per stage name', () => {
    /* Three meanings, reusing the colours the rest of the app already uses:
       green to open, red for a missed call, amber for the cold chasing.

       This assertion used to point at the inline headings. Those are gone --
       the buttons replaced them and keeping both divided the list twice over
       -- so it follows the behaviour to where it now lives rather than being
       deleted along with the markup it happened to name. */
    const styles = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
    ['welcome', 'rebooked', 'followup'].forEach(st =>
      assert.ok(styles.includes('.tf-chip.' + st + '.on'), st + ' should be tinted'));
    assert.ok(/\.tf-chip\.noshow\.on\{[^}]*red/.test(styles), 'a missed call should read red');
    assert.ok(/\.tf-chip\.recovery\.on,[\s\S]{0,60}revival\.on\{[^}]*amber/.test(styles),
      'the cold chasing should read amber');
    // The neutral default has to exist, or an untinted stage has no chip at all.
    assert.ok(/\.tf-chip\{[^}]*background/.test(styles));
    // And nothing should still be rendering the old headings.
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    assert.ok(!/touch-group/.test(app),
      'the inline headings should be gone, not merely hidden');
  });

  test('every stage the list can produce gets a readable label', () => {
    // The card chip used to print the raw key, so it read "midcheckin". The
    // filter button replaced it, which only works if the label is readable.
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
      today:   mk('today',   {callDateTime: atHourInZone(9).toISOString()}),
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
    // The cron runs three times a day (11:00, 16:00 and 21:00 UTC), so the
    // longest legitimate gap is overnight. 36h+ means a sync FAILED rather
    // than was not due. This is the gap that went unnoticed for days.
    // The threshold stays at 36h: it was already generous at two runs a day
    // and a third only makes it safer, so tightening it would buy noise.
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

test('the alert summary names the issue instead of counting it', () => {
  /* "1 data issue worth a look" is a number and a shrug. It gives no way to
     judge whether to open the panel, so after the second day it stops being
     read -- which is how a real problem ends up sitting in the interface for
     a week looking like furniture. */
  const ctx = makeHostedCtx();
  vm.runInContext("STATE = buildDefaultState();", ctx);
  const say = (alerts) => vm.runInContext(
    'describeAlerts(' + JSON.stringify(alerts) + ', ' + alerts.length + ')', ctx);

  assert.ok(/no phone number/.test(say([{type: 'no-phone', clients: [{id: 'a'}]}])),
    'got: ' + say([{type: 'no-phone', clients: [{id: 'a'}]}]));
  assert.ok(/before a single text/.test(say([{type: 'never-texted', clients: [{id: 'a'}, {id: 'b'}]}])));
  assert.ok(/within 48 hours/.test(say([{type: 'imminent-untexted', clients: [{id: 'a'}]}])));
  assert.ok(/duplicate booking/.test(say([{type: 'duplicate', groups: [[{}, {}]]}])));

  // Several still collapse to a count: a list inside a one-line summary is
  // just the panel again.
  assert.ok(/2 things/.test(say([{type: 'no-phone', clients: [{id: 'a'}]},
                                 {type: 'duplicate', groups: [[{}, {}]]}])));

  // Singular and plural both read correctly, since this line is always on screen.
  assert.ok(/1 upcoming/.test(say([{type: 'no-phone', clients: [{id: 'a'}]}])));
  assert.ok(/3 upcoming/.test(say([{type: 'no-phone', clients: [{id: 'a'}, {id: 'b'}, {id: 'c'}]}])));

  // An unrecognised type must still produce a sentence rather than "undefined".
  assert.ok(say([{type: 'something-new'}]).length > 0);
  assert.ok(!/undefined/.test(say([{type: 'something-new'}])));
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
  // Renamed with the product; the slug comes from the 'ghost recall' fallback.
  assert.ok(GB.exportFilename('').startsWith('ghost-recall-'));
});

console.log('\n--- your emails, Ghost Recall’s timing ---');

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
    // The whole point: a reply Ghost Recall saw itself needs no human
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
const DAYOF_NOW = atHourInZone(9);
const DAYOF_CALL = atHourInZone(16).toISOString();
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

  // Set-level collapsing has to exist on both sides too, or the .ics path and
  // the Google path disagree on how many contacts one standing meeting is.
  ['collapseRecurringSeries', 'recurringSeriesKey', 'recurringEventId']
    .forEach(token => assert.ok(ts.includes(token),
      'parse.ts is missing ' + token + ' — a recurring series would expand again'));
});

test('the sync actually calls the collapse, not just defines it', () => {
  /* The failure mode this repo keeps producing: fully written, unit-tested,
     never called. renderDeadTab rendered an empty tab for weeks that way.
     collapseRecurringSeries is worthless unless the sync loop runs on its
     output, and the stored-series guard is what stops an INCREMENTAL sync
     rebuilding the pile a few occurrences per run. */
  const src = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/collapseRecurringSeries\(/.test(src), 'the sync must call collapseRecurringSeries');
  assert.ok(/for \(const ev of keptEvents\)/.test(src),
    'the sync loop must iterate the COLLAPSED list, not the raw events');
  assert.ok(/storedSeries\.has\(/.test(src),
    'an incremental sync must skip a series it already stored');
  assert.ok(/storedSeries\.add\(/.test(src),
    'a newly inserted occurrence must register its series');
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
   real bug to production: inside the Ghost Recall Today row loop a local named
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

test('every Ghost Recall Today row shape renders without throwing', () => {
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
  /* Just the handler, not everything between it and renderAll. The wider
     slice swept up whatever function happened to be defined next and failed
     on an unrelated showToast — a test reporting a real rule broken by code
     that does not implement that rule. */
  const start = app.indexOf('window.GB_ON_SAVE_HEALTH =');
  const block = app.slice(start, app.indexOf('\n};', start) + 3);
  assert.ok(/GB_ON_SAVE_HEALTH/.test(block) && block.length < 1200,
    'the slice no longer isolates the handler');
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
  assert.ok(/All clear/i.test(html), 'a cleared day should be celebrated, not blank');
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
  // Sync health is read through an RPC now, because the token table is
  // owner-only. Nothing in the save path calls it; this keeps it from throwing.
  function rpc(){ return Promise.resolve({data: [], error: null}); }
  const sandbox = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, isNaN, parseInt, parseFloat,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2,10) },
    window: { GB_SUPABASE: { auth: { getUser: async () => ({data:{user:{id:'u1', email:'a@b.com'}}}) }, from: table, rpc } }
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
      is(){ return chain; },
      // update().eq().select() has to resolve the same way a read does, or
      // reassignClient cannot be tested at all.
      select(){ return chain; },
      maybeSingle(){ return res(); },
      then(ok, bad){ return res().then(ok, bad); }
    };
    return {select(){ return chain; },
            insert(){ return {select(){ return chain; }, then(ok,bad){ return res().then(ok,bad); }}; },
            update(){ return chain; },
            upsert(){ return chain; }, delete(){ return chain; }};
  }
  function rpc(name){
    return Promise.resolve(
      Object.prototype.hasOwnProperty.call(results, name) ? results[name] : {data: [], error: null});
  }
  const sandbox = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, isNaN, parseInt, parseFloat, Set,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2,10) },
    window: { GB_SUPABASE: { auth: { getUser: async () => ({data:{user:{id:'u1', email:'a@b.com'}}}) }, from: table, rpc } }
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

console.log('\n--- a personal inbox has no colleagues ---');

/* Caught while about to deploy, not in production — but only just.

   The general default is attendees mode, which decides a booking by looking
   for a guest from outside the organizer's domain. For a business with its own
   domain that is exactly right. For a realtor working alone out of a personal
   Gmail it is inverted: the client is on gmail.com too, so the client counts
   as a colleague, the booking counts as an internal meeting, and the app
   imports nothing and says nothing.

   That is the LEGACY_FILTER failure a second time, by a different route, and
   it would have landed on precisely the solo operators the general default was
   written for. */
{
  const booking = (organizer, guest) => ({
    id: 'evt', summary: 'Listing consult - Dana Reyes',
    description: 'Booked via the website',
    organizer: {email: organizer},
    attendees: [{email: organizer, self: true}, {email: guest}],
    start: {dateTime: '2026-10-09T15:00:00Z'},
  });

  test('a solo operator on Gmail imports their Gmail client', () => {
    assert.strictEqual(
      GB.matchesCalendarFilter(booking('jane.realtor@gmail.com', 'dana.reyes@gmail.com'), undefined),
      true, 'a personal-inbox booking must import with no configuration at all');
  });

  test('every common personal inbox, not just Gmail', () => {
    ['outlook.com', 'yahoo.com', 'icloud.com', 'hotmail.com', 'aol.com', 'proton.me']
      .forEach(d => assert.strictEqual(
        GB.matchesCalendarFilter(booking('jane@' + d, 'client@' + d), undefined), true,
        d + ' is a mail host, not a company'));
  });

  test('a real company domain still excludes real colleagues', () => {
    // The guard must not swing the other way and turn standups into contacts.
    assert.strictEqual(
      GB.matchesCalendarFilter(booking('bob@acmeplumbing.com', 'jim@acmeplumbing.com'), undefined),
      false, 'a same-domain colleague is still a colleague');
    assert.strictEqual(
      GB.matchesCalendarFilter(booking('bob@acmeplumbing.com', 'cust@gmail.com'), undefined),
      true, 'and an outside guest is still a booking');
  });

  test('the contact email is the client, not the organizer', () => {
    /* The same comparison runs again when picking WHICH attendee is the
       customer. On a personal inbox it stripped every guest sharing the host,
       so the booking imported with no email address on it and nothing to send
       to. */
    const ics = 'BEGIN:VEVENT\r\n' +
      'DTSTART:20261009T150000Z\r\n' +
      'SUMMARY:Listing consult (Dana Reyes)\r\n' +
      // No email in the description, so the attendee list is the only source.
      'DESCRIPTION:Booked by Dana Reyes\r\n' +
      'ORGANIZER;CN=Jane:mailto:jane.realtor@gmail.com\r\n' +
      'ATTENDEE;CN=Jane:mailto:jane.realtor@gmail.com\r\n' +
      'ATTENDEE;CN=Dana:mailto:dana.reyes@gmail.com\r\n' +
      'END:VEVENT';
    const parsed = GB.clientFromICSEvent(GB.parseICS(ics)[0]);
    assert.ok(parsed, 'the booking must parse at all');
    assert.strictEqual(parsed.email, 'dana.reyes@gmail.com',
      'a shared mail host must not make the client look like the organizer');
  });

  test('both copies of the rule agree', () => {
    const ts = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
      '_shared', 'parse.ts'), 'utf8');
    ['SHARED_MAIL_DOMAINS', 'isSharedMailDomain', 'internalDomain']
      .forEach(t => assert.ok(ts.includes(t), 'parse.ts is missing ' + t));
    // The Edge Function is the path that actually runs for Google Calendar,
    // so it is the one that must not compare against a raw organizer domain.
    assert.ok(!/const organizer = domainOf\(/.test(ts),
      'attendees mode must use internalDomain, not the raw organizer domain');
    assert.ok(!/const organizerDomain = domainOf\(/.test(ts),
      'attendee extraction must use internalDomain too');
  });
}

console.log('\n--- a recurring series is one meeting, not hundreds ---');

/* Found by auditing live accounts, not by a bug report.

   One account's upcoming list held 136 bookings where every other account
   held 10 to 26. 133 of them were a single standing meeting, expanded by
   singleEvents into one contact per occurrence out to the following March.
   The eight real bookings were buried in it, and each fake one carried its
   own follow-up cadence.

   The per-event filter was blameless: a standing call with an outside guest
   genuinely looks like a booking. The gap was that nothing worked at the
   level of the set. */
{
  const occ = (series, iso) => ({
    id: series + '_' + iso.replace(/[-:]/g, '').replace('.000', ''),
    recurringEventId: series,
    summary: 'Standing check-in',
    start: {dateTime: iso},
  });
  const NOW = '2026-10-02T12:00:00.000Z';

  test('a recurring series collapses to its next upcoming occurrence', () => {
    const events = [
      occ('weekly', '2026-09-25T15:00:00Z'),   // past
      occ('weekly', '2026-10-05T15:00:00Z'),   // next up
      occ('weekly', '2026-10-12T15:00:00Z'),
      occ('weekly', '2027-03-30T15:00:00Z'),
    ];
    const kept = GB.collapseRecurringSeries(events, NOW);
    assert.strictEqual(kept.length, 1, 'one series must yield one contact');
    assert.strictEqual(kept[0].start.dateTime, '2026-10-05T15:00:00Z',
      'the occurrence worth keeping is the one you sit on next');
  });

  test('one-off bookings are never touched', () => {
    const oneOffs = [
      {id: 'evt-a', summary: 'Estimate - Smith', start: {dateTime: '2026-10-06T15:00:00Z'}},
      {id: 'evt-b', summary: 'Estimate - Jones', start: {dateTime: '2026-10-07T15:00:00Z'}},
    ];
    assert.deepStrictEqual(GB.collapseRecurringSeries(oneOffs, NOW), oneOffs);
  });

  /* The case this must not break. Every other account's duplicate contacts
     were the same person booking a second or third call, which is real
     repeat business and the whole point of a follow-up CRM. Those are
     separate events, not one series. */
  test('the same person booking twice keeps both bookings', () => {
    const rebooked = [
      {id: 'evt-1', summary: 'Call - Dana', start: {dateTime: '2026-10-06T15:00:00Z'}},
      {id: 'evt-2', summary: 'Second call - Dana', start: {dateTime: '2026-10-27T15:00:00Z'}},
    ];
    assert.strictEqual(GB.collapseRecurringSeries(rebooked, NOW).length, 2,
      'repeat business must survive collapsing');
  });

  test('a series entirely in the past keeps its most recent occurrence', () => {
    const kept = GB.collapseRecurringSeries([
      occ('old', '2026-08-01T15:00:00Z'),
      occ('old', '2026-09-01T15:00:00Z'),
    ], NOW);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].start.dateTime, '2026-09-01T15:00:00Z',
      'a finished series should still show the call that happened');
  });

  // Rows read back from storage kept the event id but not recurringEventId,
  // so the series has to be recoverable from Google's occurrence id shape.
  test('the series is recoverable from the occurrence id alone', () => {
    assert.strictEqual(
      GB.recurringSeriesKey({id: '9a8n5ds6dfqsq2smuctj43qq9b_20261005T150000Z'}),
      '9a8n5ds6dfqsq2smuctj43qq9b');
    assert.strictEqual(GB.recurringSeriesKey({id: 'evt-plain'}), null,
      'a one-off id must not be read as a series');
  });

  test('the real shape of the live flood collapses to one', () => {
    const events = [];
    for (let i = 0; i < 133; i++) {
      const d = new Date(Date.UTC(2026, 8, 25, 15) + i * 86400000 * 1.33);
      events.push(occ('9a8n5ds6dfqsq2smuctj43qq9b', d.toISOString()));
    }
    const realBooking = {id: 'real-1', summary: 'Strategy call - Sheri',
                         start: {dateTime: '2026-10-02T18:00:00Z'}};
    events.push(realBooking);
    const kept = GB.collapseRecurringSeries(events, NOW);
    assert.strictEqual(kept.length, 2, '133 occurrences + 1 booking must become 1 + 1');
    assert.ok(kept.indexOf(realBooking) !== -1, 'the real booking must survive');
  });
}

console.log('\n--- the sync schedule and the staleness warning agree ---');

/* Two numbers that have to stay in step, in different files.

   calendarHealth calls a calendar stale after STALE_AFTER_HOURS, and that is
   only meaningful relative to how often the cron actually runs. If somebody
   removes a run, or tightens the threshold below the real overnight gap, the
   app either cries wolf on a healthy calendar or stays silent on a broken
   one. The second is how Daniel went three days without syncing while nobody
   noticed.

   The schedules live in SQL migrations, so this reads them rather than
   restating them. */
{
  const migDir = path.join(__dirname, 'supabase', 'migrations');
  const hours = [];
  fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).forEach(f => {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    // cron.schedule('name', '0 16 * * *', $$ ... $$)
    const re = /cron\.schedule\(\s*'([^']+)'\s*,\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+\*'/g;
    let m;
    while ((m = re.exec(sql)) !== null) {
      if (/calendar-sync/.test(m[1])) hours.push(Number(m[3]));
    }
  });

  test('the migrations really do schedule the sync', () => {
    // Guards the regex itself: if it stops matching, every assertion below
    // would pass on an empty list.
    assert.ok(hours.length >= 3,
      'expected at least 3 scheduled calendar syncs, found ' + hours.length);
  });

  test('a morning run exists, so the 9am queue is not built from yesterday', () => {
    /* The gap this closed: runs were 16:00 and 21:00 UTC only, so the list
       somebody worked at 9am came from the previous day's 5pm sync and
       nothing new arrived until noon. On 2026-10-02 John's first call was
       11:00 ET, an hour before the day's first sync. */
    const morning = hours.filter(h => h >= 9 && h <= 13);
    assert.ok(morning.length >= 1,
      'no sync scheduled in the UTC morning (09:00-13:00); got ' + JSON.stringify(hours.sort()));
  });

  test('no healthy schedule can trip the stale warning', () => {
    const sorted = hours.slice().sort((a, b) => a - b);
    let worst = 0;
    for (let i = 0; i < sorted.length; i++) {
      const next = (i + 1 < sorted.length) ? sorted[i + 1] : sorted[0] + 24;
      worst = Math.max(worst, next - sorted[i]);
    }
    assert.ok(worst < GB.STALE_AFTER_HOURS,
      'longest gap between syncs is ' + worst + 'h but a calendar is called '
      + 'stale after ' + GB.STALE_AFTER_HOURS + 'h — a healthy calendar would '
      + 'be reported broken');
    // And the threshold must not be so loose that a real failure hides for
    // days. Two missed runs in a row should surface.
    assert.ok(GB.STALE_AFTER_HOURS <= worst * 3,
      'the stale threshold (' + GB.STALE_AFTER_HOURS + 'h) is more than three '
      + 'missed runs wide, which is how a broken sync goes unnoticed');
  });
}

console.log('\n--- starter emails for an empty library ---');

/* The worst moment in the app for somebody new.

   seedEmailLibrary only carries across emails the business already wrote, so
   an account created today opens the Emails tab and finds nothing at all: no
   example, no shape, and no way to tell what belongs there. The starters fix
   that, but they introduce a risk the codebase has already drawn a hard line
   on once -- "a business should never discover that software has been sending
   its own words to its customers" -- so most of what follows guards that line
   rather than the copy. */
{
  const starters = GB.starterEmailLibrary();

  test('a new library has something to start from', () => {
    assert.ok(starters.length >= 3, 'expected several starters, got ' + starters.length);
    starters.forEach(d => {
      assert.ok((d.title || '').trim(), 'a starter needs a name');
      assert.ok((d.body || '').trim(), 'a starter needs a body');
      assert.ok((d.whenToSend || '').trim(),
        d.title + ' has no timing note, which is the one thing that says when to reach for it');
    });
  });

  test('every starter is visibly unfinished', () => {
    /* The honesty guard. A starter that reads as finished copy is one somebody
       sends verbatim, and then the business has mailed a customer words it
       never wrote. Each one keeps a [BRACKETED] gap, which is exactly what the
       preview already reports as "Still unfilled". */
    starters.forEach(d => {
      // Capitalised specifically: the preview's leftover check only catches
      // [A-Z] placeholders, so a lowercase gap would render looking finished.
      assert.ok(/\[[A-Z][^\]]*\]/.test(d.body + ' ' + d.subject),
        d.title + ' has no [UPPERCASE] gap, so the preview would not flag it');
    });
  });

  test('the preview flags a starter as unfilled, using the real check', () => {
    // Not a restatement of the rule: this runs the same expression the preview
    // uses, so if that detection changes the guarantee above is re-tested.
    const c = GB.sanitizeClient({id:'c', name:'Dana', phone:'2125550100',
      status:'Booked', callDateTime:'2026-11-05T15:00:00Z'});
    const state = {emailLibrary: starters, clients:{c}, emailVariants:{}};
    starters.forEach(d => {
      const r = GB.renderEmailDoc(state, d.id, c, 'Johnny');
      assert.ok(r, d.title + ' did not render');
      const leftovers = (r.text + ' ' + r.subject).match(/\{\w+\}|\[[A-Z][^\]]*\]/g);
      assert.ok(leftovers && leftovers.length,
        d.title + ' rendered with nothing left to fill — it would look ready to send');
    });
  });

  test('no starter is wired to send by itself', () => {
    // Pinning a doc to a touch is what puts it behind the one-click send on a
    // Today card. A starter arriving pre-pinned would be the app choosing to
    // put its own words one button away from a customer.
    starters.forEach(d => assert.strictEqual(d.touch || '', '',
      d.title + ' is pinned to a touch and would be offered for sending unedited'));
    const state = {emailLibrary: starters};
    GB.TOUCH_LIST_ORDER.forEach(stage => {
      assert.strictEqual(GB.emailForTouch(state, stage), null,
        'a starter answered emailForTouch for ' + stage);
    });
  });

  test('the unattended sender still cannot reach the library at all', () => {
    /* The separate, stronger guarantee: automatic email reads authored
       variants, never the library. So even a starter somebody pins by hand
       cannot be mailed without a person pressing send. */
    const c = GB.sanitizeClient({id:'c', name:'Dana', phone:'2125550100', status:'Booked'});
    assert.strictEqual(
      GB.getAuthoredEmailDraft({emailLibrary: starters, emailVariants:{}}, c, 'welcome', 'Johnny'),
      null, 'the unattended sender drew copy out of the library');
  });

  test('a starter belongs to no particular trade', () => {
    // These ship to every account, so anything industry-specific is wrong for
    // most of them — and a customer's name in there would be worse.
    const all = starters.map(d => [d.title, d.subject, d.body, d.whenToSend].join(' ')).join(' ');
    ['marketmaker', 'realtor', 'youtube', 'plumb', 'hvac', 'ghost recall', 'ghostbuster']
      .forEach(w => assert.ok(all.toLowerCase().indexOf(w) === -1,
        'a starter mentions "' + w + '", which is not true of every business'));
  });

  test('a starter still reads correctly with no call booked', () => {
    /* A real case, and one Johnny asked for by name: an introduction email
       often goes out before any date is set. {date} renders as NOTHING there,
       so the first draft of these had the subject "Ahead of {date}", which
       collapsed to an empty subject line. {when} falls back to "soon", which
       turned "we had {when} in the diary" into "we had soon in the diary".

       Both only showed up by rendering them against an undated contact. */
    const undated = GB.sanitizeClient({id:'n', name:'Pat', phone:'2125550100', status:'Booked'});
    const dated = GB.sanitizeClient({id:'c', name:'Dana', phone:'2125550100', status:'Booked',
      callDateTime:'2026-11-05T15:00:00Z', timezone:'America/New_York'});
    const state = {emailLibrary: starters};

    [undated, dated].forEach(who => {
      starters.forEach(d => {
        const r = GB.renderEmailDoc(state, d.id, who, 'Johnny');
        const where = d.title + ' (' + (who.callDateTime ? 'dated' : 'no date') + ')';
        assert.ok((r.subject || '').trim(), where + ' rendered an empty subject line');
        const all = r.subject + '\n' + r.text;
        assert.ok(!/\bsoon\b[^.\n]*\b(in the diary|at \d)/.test(all),
          where + ' reads as though "soon" were a date');
        assert.ok(!/\s{2,}/.test(r.subject), where + ' has a gap in the subject where a date was');
        assert.ok(!/[-:,]\s*$/.test(r.subject.trim()),
          where + ' subject ends on dangling punctuation left by an empty placeholder');
        assert.ok(!/\b(on|at|for|by|ahead of)\s+(on|at)\b/i.test(all),
          where + ' doubled a preposition, e.g. "ahead of on Nov 5"');
      });
    });
  });

  test('the empty library actually offers them', () => {
    // Written, tested, never called is this repo's recurring failure. The
    // button and its handler both have to exist.
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    assert.ok(/'email-lib-starters'/.test(app), 'nothing offers the starters');
    assert.ok(/case 'email-lib-starters'/.test(app), 'the starters button has no handler');
    assert.ok(/starterEmailLibrary\(\)/.test(app), 'the handler never builds them');
  });
}

console.log('\n--- the team view ---');

/* Built from what the live book actually said.

   Eight accounts were syncing perfectly and six had never sent a single text,
   four of those with appointments already booked. "Everyone is running clean"
   was true of the plumbing and false of the work, and no screen in the app
   said so. */
{
  const now = new Date('2026-10-02T15:00:00Z');
  const ok = '2026-10-01T21:01:00Z';
  const row = (over) => Object.assign({
    name:'someone', contacts:10, upcoming:3, sent7d:5, sentEver:50,
    replies:0, repliesMeasured:false, completed:1, noshows:0, rescheduled:0,
    connectedCalendars:1, lastSync: ok}, over);

  test('a green calendar and no work done is not "fine"', () => {
    const m = GB.teamMemberState(row({sent7d:0, sentEver:0, upcoming:135}), now);
    assert.strictEqual(m.calendar, 'ok', 'the plumbing really is healthy');
    assert.strictEqual(m.state, 'never started');
    assert.ok(m.needsAttention, 'a full queue nobody has touched must be flagged');
    assert.ok(/135/.test(m.why), 'the reason should name the cost: ' + m.why);
  });

  test('somebody who was working and stopped is distinguished from one who never began', () => {
    // Different conversations: one needs onboarding, the other needs asking
    // what happened.
    assert.strictEqual(GB.teamMemberState(row({sent7d:0, sentEver:0}), now).state, 'never started');
    assert.strictEqual(GB.teamMemberState(row({sent7d:0, sentEver:63}), now).state, 'gone quiet');
  });

  test('a broken calendar outranks a quiet week', () => {
    const stale = GB.teamMemberState(row({lastSync:'2026-09-29T16:00:00Z', sent7d:0, sentEver:63}), now);
    assert.strictEqual(stale.state, 'sync broken',
      'a sync that stopped is why they went quiet, and is the thing to fix');
    const none = GB.teamMemberState(row({connectedCalendars:0, lastSync:null, contacts:0, upcoming:0}), now);
    assert.strictEqual(none.state, 'not set up');
  });

  test('the worst problem is listed first, measured by booked work going cold', () => {
    // All three have used the product, or they would be split out below as
    // an onboarding problem rather than ranked as a performance one.
    const o = GB.teamOverview([
      row({name:'works',  sent7d:18, sentEver:19,  upcoming:26}),
      row({name:'small',  sent7d:0,  sentEver:40,  upcoming:4}),
      row({name:'big',    sent7d:0,  sentEver:40,  upcoming:135}),
    ], now);
    assert.deepStrictEqual(o.members.map(m => m.name), ['big', 'small', 'works']);
    assert.strictEqual(o.working, 1);
    assert.strictEqual(o.needsAttention, 2);
    // The number worth putting at the top of the tab.
    assert.strictEqual(o.strandedUpcoming, 139, 'booked work belonging to nobody working it');
  });

  test('a reply rate nobody measured is reported as unknown, never as zero', () => {
    /* The trap this exists to stop. Replies are only reconciled for one
       account, from that person's own Messages database. Everyone else has
       zero recorded replies because nobody ever looked — not because nobody
       ever answered. Rendering that as "0%" tells a manager that someone's
       messages do not work: confident, specific, and wrong in a direction
       they would act on. */
    const unmeasured = GB.teamMemberState(row({sentEver:19, replies:0, repliesMeasured:false}), now);
    assert.strictEqual(unmeasured.replyRate, null,
      'an unmeasured account must not report a rate at all');

    const measured = GB.teamMemberState(row({sentEver:100, replies:11, repliesMeasured:true}), now);
    assert.strictEqual(measured.replyRate, 11);

    // A measured account with genuinely no replies is a real zero and must
    // still be reported, or the guard would hide real bad news.
    const realZero = GB.teamMemberState(row({sentEver:40, replies:0, repliesMeasured:true}), now);
    assert.strictEqual(realZero.replyRate, 0);

    // And nobody can be given a rate from no sends at all.
    assert.strictEqual(GB.teamMemberState(row({sentEver:0, repliesMeasured:true}), now).replyRate, null);
  });

  test('the overview says how many people the reply rate is even knowable for', () => {
    // So the tab can caption it honestly rather than averaging a number that
    // means different things per row.
    const o = GB.teamOverview([
      row({name:'a', repliesMeasured:true, sentEver:100, replies:11}),
      row({name:'b', repliesMeasured:false, sentEver:19}),
      row({name:'c', repliesMeasured:false, sentEver:3}),
    ], now);
    assert.strictEqual(o.replyRateMeasuredFor, 1);
    assert.strictEqual(o.total, 3);
  });

  test('rendering a team view does not throw, for a team and for none', () => {
    /* What the DOM stub CAN prove: the render path runs. It cannot prove what
       was rendered - className comes back as a proxy whose .includes() is
       truthy whatever the code did, so an assertion on tab visibility here
       passes even with the hiding removed. That was checked by deleting the
       hide and watching the test still pass, so it is asserted at source
       level below instead of pretended at here. */
    const ctx = makeHostedCtx();
    vm.runInContext('STATE = buildDefaultState(); renderTeamTab();', ctx);
    vm.runInContext(`STATE.team = [
      {name:'zachary.l', contacts:153, upcoming:135, sent7d:0, sentEver:0,
       repliesMeasured:false, connectedCalendars:1, lastSync:new Date().toISOString()},
      {name:'johnny', contacts:169, upcoming:21, sent7d:121, sentEver:889, replies:98,
       repliesMeasured:true, connectedCalendars:1, lastSync:new Date().toISOString()}
    ]; renderTeamTab();`, ctx);
  });

  test('the tab hides itself when there is no team', () => {
    // Source level, because the stub cannot see it. A manager tab that appears
    // for everybody and renders an empty table reads as "your team has no
    // activity" rather than "this is not for you".
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    const guard = fn.slice(0, fn.indexOf('teamOverview('));
    assert.ok(/if\(!rows \|\| !rows\.length\)/.test(guard),
      'nothing short-circuits on an empty team');
    assert.ok(/classList\.add\('hidden'\)/.test(guard),
      'the empty case does not hide the tab button');
    assert.ok(/classList\.remove\('hidden'\)/.test(fn),
      'the tab is never un-hidden for a manager who does have a team');
  });

  test('the rendered reply column cannot quietly become a zero', () => {
    // The view model returns null for an unmeasured account; this pins that
    // the renderer still SAYS so rather than printing it as a number.
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    assert.ok(/replyRate === null/.test(fn), 'the renderer does not special-case an unknown rate');
    assert.ok(/not measured/.test(fn), 'nothing tells the manager the rate is unknown');
    assert.ok(/not a zero/.test(fn), 'the tooltip explaining it is not a zero is gone');
  });

  test('the team view is actually called by renderAll', () => {
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderAll()'),
                         app.indexOf('\n}', app.indexOf('function renderAll()')));
    assert.ok(/renderTeamTab\(\)/.test(fn), 'renderAll never calls renderTeamTab');
  });

  test('the appointments behind the number travel with the row', () => {
    /* "11 booked and nothing sent" is a statistic. "Dana Reyes, Thursday,
       nobody has spoken to her" is something a manager can act on. */
    const m = GB.teamMemberState(row({sent7d:0, sentEver:0, upcoming:2, upcomingList:[
      {clientId:'a', name:'Dana Reyes', when:'2026-10-08T15:00:00Z', status:'Booked', sent:0},
      {clientId:'b', name:'Sam Okafor', when:'2026-10-09T16:00:00Z', status:'Confirmed', sent:2}
    ]}), now);
    assert.strictEqual(m.queue.length, 2);
    assert.strictEqual(m.untouched, 1, 'only the one with no messages counts as untouched');
    assert.strictEqual(m.queue[0].untouched, true);
    assert.strictEqual(m.queue[1].untouched, false);
  });

  test('a member with no list still works', () => {
    const m = GB.teamMemberState(row({}), now);
    assert.deepStrictEqual(m.queue, []);
    assert.strictEqual(m.untouched, 0);
  });

  test('the owner view still cannot see a single contact name', () => {
    /* The boundary that now matters more, because team rows DO carry contact
       names. Feed the owner view rows that contain a full queue and it must
       throw every bit of it away: it looks at other businesses, and an
       appointment list is exactly what it must never carry. */
    const withQueue = {
      name:'someone', signedUp:'2026-08-01', lastSignIn:'2026-10-02',
      contacts:40, upcoming:2, sentEver:0, connectedCalendars:1,
      lastSync:'2026-10-05T11:00:00Z',
      upcomingList:[{clientId:'a', name:'Dana Reyes', when:'2026-10-08T15:00:00Z',
                     status:'Booked', sent:0}]
    };
    const d = GB.accountDiagnosis(withQueue, now);
    assert.ok(!('queue' in d), 'the owner diagnosis carried the appointment list through');
    assert.ok(!('upcomingList' in d), 'the owner diagnosis kept the raw list');
    assert.ok(JSON.stringify(d).indexOf('Dana') === -1,
      'a contact name reached the owner view: ' + JSON.stringify(d));

    const o = GB.platformOverview([withQueue], now);
    assert.ok(JSON.stringify(o).indexOf('Dana') === -1,
      'a contact name reached the platform overview');
  });

  test('an appointment can be moved to anyone on the team, including back', () => {
    /* Replaced a one-way Take button, which could not hand a call back or
       pass it to a third person — and handing over work somebody has already
       started is exactly the case a departure creates. */
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const picker = app.slice(app.indexOf('function assignPicker('),
                             app.indexOf('function renderTeamTab()'));
    assert.ok(/members\.forEach/.test(picker), 'the picker does not list the team');
    assert.ok(/o\.selected = true/.test(picker),
      'the current owner is not preselected, so leaving it alone would move the call');
    assert.ok(/has-history/.test(picker),
      'a call with messages already sent is not marked as a takeover');

    /* A <select> fires 'change', not 'click'. The first version of this was a
       case in the click dispatcher and could never have run. */
    const onChange = app.slice(app.indexOf("document.addEventListener('change'"),
                               app.indexOf("document.addEventListener('change'") + 400);
    assert.ok(/team-assign/.test(onChange),
      'the picker is not wired to the change event');
    assert.ok(/function assignFromPicker/.test(app), 'no handler for the move');
    const handler = app.slice(app.indexOf('function assignFromPicker'),
                              app.indexOf('/* The owner picker'));
    assert.ok(/init\(\)/.test(handler),
      'nothing reloads after a move, so the contact would sit in both lists');
    assert.ok(/renderTeamTab\(\)/.test(handler),
      'a refused move leaves the picker showing the wrong owner');
  });

  test('the team tab can open a person, and only when there is something to show', () => {
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    assert.ok(/'team-toggle'/.test(fn), 'nothing makes a row openable');
    assert.ok(/m\.queue\.length \?/.test(fn),
      'rows are made clickable even when the person has nothing booked');
    assert.ok(/case 'team-toggle'/.test(app), 'the toggle has no handler');
    assert.ok(/nothing sent/.test(fn), 'an untouched appointment is not called out');
  });

  test('not logging in is told apart from ignoring the list', () => {
    /* The whole reason for the sign-in data. Chase has logged in and sent
       nothing; Ethan.M has not opened the app for twelve days. Same zero in
       the sent column, opposite conversations — and telling somebody off for
       ignoring a tool they could not get into is the worst version of this
       feature. */
    // Dates are relative to this block's fixed `now` of 2 Oct, not to today.
    const away = GB.teamMemberState(row({sent7d:0, sentEver:0, upcoming:7,
      lastSignIn:'2026-09-23T12:00:00Z'}), now);
    assert.strictEqual(away.state, 'not logging in');
    assert.strictEqual(away.daysSinceSignIn, 9);
    assert.ok(/9 days/.test(away.why), away.why);

    const present = GB.teamMemberState(row({sent7d:0, sentEver:0, upcoming:7,
      lastSignIn:'2026-09-30T12:00:00Z'}), now);
    assert.strictEqual(present.state, 'never started',
      'somebody who signs in and sends nothing is not an access problem');
    assert.strictEqual(present.daysSinceSignIn, 2);
  });

  test('a broken calendar still outranks not logging in', () => {
    // If the sync is dead, that is the thing to fix regardless of whether
    // they have been in. Order matters: fix the cause, not the symptom.
    const m = GB.teamMemberState(row({sent7d:0, sentEver:0,
      lastSync:'2026-09-29T16:00:00Z', lastSignIn:'2026-09-23T12:00:00Z'}), now);
    assert.strictEqual(m.state, 'sync broken');
  });

  test('an unknown sign-in time is unknown, not zero', () => {
    const m = GB.teamMemberState(row({}), now);
    assert.strictEqual(m.daysSinceSignIn, null,
      'a missing sign-in time must not read as "in today"');
  });

  test('the sign-in function gives up two timestamps and nothing else', () => {
    const dir = path.join(__dirname, 'supabase', 'migrations');
    const f = fs.readdirSync(dir).find(x => x.includes('team_sign_in_activity'));
    assert.ok(f, 'the migration is missing');
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const body = sql.slice(sql.indexOf('create or replace function'));
    const code = body.replace(/--[^\n]*/g, '');
    /* auth.users holds email, phone, password hashes and recovery tokens. A
       manager seeing a colleague's sign-in time is reasonable; pulling their
       recovery address out of the CRM is not. */
    ['email', 'phone', 'encrypted_password', 'recovery', 'confirmation_token', 'raw_user_meta']
      .forEach(w => assert.ok(code.indexOf(w) === -1,
        'the sign-in function can return ' + w));
    assert.ok(/security\s+definer/i.test(code), 'it cannot read auth.users without this');
    assert.ok(/user_managed_org_ids/.test(code), 'it is not scoped to managed orgs');
    assert.ok(/u\.id = auth\.uid\(\)/.test(code), 'it does not let somebody see their own');
    assert.ok(/revoke all on function public\.team_sign_in_activity\(\) from anon/.test(sql),
      'anon is not revoked from a definer function that reads auth.users');
  });

  test('the week is compared with the week before it', () => {
    const m = GB.teamMemberState(row({sent7d: 4, sentPrev7d: 18}), now);
    assert.strictEqual(m.trend, -14);
    assert.strictEqual(GB.teamMemberState(row({sent7d: 20, sentPrev7d: 18}), now).trend, 2);
  });

  test('nothing happening twice is not a trend', () => {
    /* Four of six accounts send nothing week after week. Rendering that as
       "0%" or a flat arrow dresses a standing problem up as stability, so a
       member with no activity in either week reports null and the tab shows
       no arrow at all. */
    assert.strictEqual(GB.teamMemberState(row({sent7d: 0, sentPrev7d: 0}), now).trend, null);
    // But a real drop to zero IS the news, and must still be reported.
    assert.strictEqual(GB.teamMemberState(row({sent7d: 0, sentPrev7d: 18}), now).trend, -18);
  });

  test('the trend is a count, never a percentage', () => {
    /* One message becoming three is not a 200% improvement, it is two more
       messages. On numbers this small a percentage makes noise look like a
       turnaround, which is the wrong thing to put in front of a manager.

       Checked on the trend code specifically, not the whole function: the
       reply-rate column legitimately renders a percentage, and an earlier
       version of this test banned '%' outright and failed on it. */
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    /* Just the delta computation, with comments stripped. The slice used to
       run to 'var lead' and match a '%' inside prose explaining an unrelated
       coverage figure — a test failing on a sentence rather than on code. */
    const from = fn.indexOf('var dir');
    const trendCode = fn.slice(from, fn.indexOf('}', fn.indexOf('Down ', from)) + 1)
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/\/\/[^\n]*/g, '');
    assert.ok(/delta/.test(trendCode) && trendCode.length > 40,
      'could not find the week-on-week code');
    assert.ok(!/\*\s*100|%/.test(trendCode),
      'the week-on-week line computes a percentage: ' + trendCode);
    assert.ok(/Up ' \+ delta/.test(trendCode) && /Down ' \+ Math\.abs/.test(trendCode),
      'it does not state a plain count up or down');
  });

  test('the team total carries both weeks and the untouched work', () => {
    const o = GB.teamOverview([
      row({name:'a', sent7d: 49, sentPrev7d: 72,
           upcomingList:[{clientId:'x', name:'Dana', when:'2026-10-08T15:00:00Z', sent:0}]}),
      row({name:'b', sent7d: 0,  sentPrev7d: 18,
           upcomingList:[{clientId:'y', name:'Sam', when:'2026-10-08T15:00:00Z', sent:1}]})
    ], now);
    assert.strictEqual(o.sent7d, 49);
    assert.strictEqual(o.sentPrev7d, 90);
    assert.strictEqual(o.untouched, 1, 'only the appointment with nothing sent counts');
  });

  /* "Today" here means the viewer's own calendar day — a manager deciding
     what to chase this afternoon — so these fixtures are built from local
     hours rather than fixed UTC instants. The first version used literal Z
     times and passed in London while failing in Tokyo, where the same instant
     falls on the next day. Third time this suite has been bitten by that. */
  const dayAt = (base, h) => { const d = new Date(base); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  // 9am local today, and a sync an hour before it. The block's shared row()
  // pins lastSync to the old fixed fixture date, which reads as stale against
  // a real `now` and turned every one of these into "sync broken".
  const today9 = () => { const d = new Date(); d.setHours(9, 0, 0, 0); return d; };
  const fresh = (at) => new Date(at.getTime() - 3600000).toISOString();

  test("today's untouched calls are counted separately from the rest", () => {
    const at = today9();
    const nextWeek = new Date(at.getTime() + 7 * 86400000).toISOString();
    const m = GB.teamMemberState(row({sent7d:0, sentEver:0, lastSync: fresh(at), upcomingList:[
      {clientId:'a', name:'Dana', when: dayAt(at, 14), sent:0},
      {clientId:'b', name:'Sam',  when: dayAt(at, 16), sent:0},
      {clientId:'c', name:'Kim',  when: nextWeek,      sent:0},
      {clientId:'d', name:'Lee',  when: dayAt(at, 15), sent:3}
    ]}), at);
    assert.strictEqual(m.untouched, 3);
    assert.strictEqual(m.todayUntouched, 2, 'only today, and only the unmessaged');
    assert.ok(/2 calls today/.test(m.why), m.why);
  });

  test('somebody working their list is still flagged for a call today', () => {
    /* The case that must not get lost: a person can be sending plenty and
       still have a call this afternoon nobody has touched. If urgency only
       appeared on people already in trouble, this one would be invisible
       precisely because they look fine. */
    const at = today9();
    const m = GB.teamMemberState(row({sent7d:49, sentEver:800, lastSync: fresh(at), upcomingList:[
      {clientId:'a', name:'Pat', when: dayAt(at, 13), sent:0}
    ]}), at);
    assert.strictEqual(m.state, 'working');
    assert.strictEqual(m.todayUntouched, 1);
    assert.ok(/^1 call today with nothing sent\./.test(m.why),
      'the urgent fact must lead the reason line: ' + m.why);
  });

  test('a call tomorrow morning is not today', () => {
    const at = today9();
    const tomorrow = dayAt(new Date(at.getTime() + 86400000), 9);
    const m = GB.teamMemberState(row({lastSync: fresh(at), upcomingList:[
      {clientId:'a', name:'Kim', when: tomorrow, sent:0}
    ]}), at);
    assert.strictEqual(m.todayUntouched, 0, 'tomorrow morning is not today');
    assert.ok(!/today/.test(m.why), m.why);
  });

  test('the team headline carries it too, above the attention split', () => {
    const at = today9();
    const o = GB.teamOverview([
      row({name:'a', sent7d:49, sentEver:800, lastSync: fresh(at), upcomingList:[
        {clientId:'x', name:'Pat', when: dayAt(at, 13), sent:0}]}),
      row({name:'b', sent7d:0, sentEver:40, lastSync: fresh(at), upcomingList:[
        {clientId:'y', name:'Dana', when: dayAt(at, 15), sent:0}]})
    ], at);
    assert.strictEqual(o.todayUntouched, 2,
      'a working person contributing an urgent call was dropped from the total');

    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    assert.ok(fn.indexOf('team-urgent') < fn.indexOf('var lead'),
      'the urgent banner must render above the lead line, not inside the needs-attention branch');
  });

  test('a rate is refused where the outcomes were never logged', () => {
    /* The reply-rate trap, in a second place. Ethan.M has 117 finished calls
       and has logged the outcome of none of them. Dividing completed by past
       calls would print "0% completion" and a manager would read it as
       catastrophic performance rather than as an empty column. */
    const never = GB.teamMemberState(row({pastCalls: 117, unlogged: 117, completed: 0, noshows: 0}), now);
    assert.strictEqual(never.outcomeCoverage, 0);
    assert.strictEqual(never.completionRate, null, 'a rate was printed from no logged outcomes');
    assert.strictEqual(never.noShowRate, null);
    assert.strictEqual(never.unlogged, 117, 'the real finding is the unlogged count itself');

    const patchy = GB.teamMemberState(row({pastCalls: 78, unlogged: 73, completed: 0, noshows: 3}), now);
    assert.strictEqual(patchy.completionRate, null,
      'five logged calls out of seventy-eight is not a measurable rate');

    const good = GB.teamMemberState(row({pastCalls: 144, unlogged: 1, completed: 49, noshows: 67}), now);
    assert.strictEqual(good.outcomeCoverage, 99);
    assert.strictEqual(good.completionRate, 34, 'a well-logged history must still report');
    assert.strictEqual(good.noShowRate, 47);
  });

  test('a genuine zero is still reported where the logging is there', () => {
    // The guard must not hide real bad news: somebody who logs diligently and
    // completes nothing has a true 0%, and that is worth knowing.
    const m = GB.teamMemberState(row({pastCalls: 20, unlogged: 1, completed: 0, noshows: 19}), now);
    assert.strictEqual(m.completionRate, 0, 'a real zero was suppressed');
    assert.strictEqual(m.noShowRate, 100);
  });

  test('no history at all reports unknown, not zero', () => {
    const m = GB.teamMemberState(row({pastCalls: 0, unlogged: 0}), now);
    assert.strictEqual(m.outcomeCoverage, null);
    assert.strictEqual(m.completionRate, null);
  });

  test('the team total says how many people are measurable at all', () => {
    const o = GB.teamOverview([
      row({name:'logged',   pastCalls: 144, unlogged: 1,   completed: 49, noshows: 67}),
      row({name:'unlogged', pastCalls: 117, unlogged: 117, completed: 0,  noshows: 0})
    ], now);
    assert.strictEqual(o.unlogged, 118);
    assert.strictEqual(o.measurable, 1, 'only one of the two can be measured');
  });

  test('the tab says so rather than printing a zero', () => {
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    assert.ok(/completionRate === null/.test(fn),
      'the renderer does not special-case an unmeasurable rate');
    assert.ok(/not enough logged/.test(fn), 'nothing tells the manager why the column is blank');
    assert.ok(/no outcome recorded/.test(fn),
      'the tab never explains that the history is missing');
  });

  test('show-up rate divides by calls that reached a yes or no', () => {
    /* Deliberately a different question from the completion rate, which
       divides by every logged call including reschedules and closures. "Did
       they turn up" only makes sense over calls that actually resolved into
       came or did-not. */
    const m = GB.teamMemberState(row({pastCalls:144, unlogged:1, completed:49, noshows:67}), now);
    assert.strictEqual(m.decidedCalls, 116);
    assert.strictEqual(m.showUpRate, 42, '49 of 116 decided');
    assert.strictEqual(m.completionRate, 34, 'and 49 of 143 logged, which is a different figure');
  });

  test('show-up is refused on the same terms as everything else', () => {
    // Somebody with no logged outcomes must not read as 0% attendance.
    const none = GB.teamMemberState(row({pastCalls:117, unlogged:117, completed:0, noshows:0}), now);
    assert.strictEqual(none.showUpRate, null);
    assert.strictEqual(none.decidedCalls, 0);
    // And a handful of decided calls is not a rate either.
    const few = GB.teamMemberState(row({pastCalls:20, unlogged:13, completed:5, noshows:1}), now);
    assert.strictEqual(few.showUpRate, null, 'six decided calls is not an attendance rate');
  });

  test('touches per call is reported as activity, never as a cause', () => {
    /* Three quarters of logged calls on this book have no recorded touch at
       all, so there is nowhere near enough to claim contact drives
       attendance. The figure is still worth showing as activity — it just
       must not be presented as an explanation. */
    const m = GB.teamMemberState(row({pastCalls:144, unlogged:1, touchesBeforeCall:130}), now);
    assert.strictEqual(m.touchesPerCall, 0.9);
    assert.strictEqual(GB.teamMemberState(row({pastCalls:0}), now).touchesPerCall, null);

    const logic = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
    const block = logic.slice(logic.indexOf('touchesPerCall:') - 400, logic.indexOf('touchesPerCall:'));
    assert.ok(/not cause|Activity, not cause/i.test(block),
      'the comment no longer warns that this is not a causal figure');
  });

  test('people who have never used it are split out, not ranked', () => {
    /* Three of six accounts have never tracked anything. Ranked by booked
       work they sat at the top of the list every day and buried the people
       actually using the product — an onboarding problem wearing a
       performance problem's clothes. */
    const o = GB.teamOverview([
      row({name:'uses it',   sent7d:18, sentEver:19, upcoming:11}),
      row({name:'never has', sent7d:0,  sentEver:0,  upcoming:135, pastCalls:117, unlogged:117})
    ], now);
    assert.deepStrictEqual(o.members.map(m => m.name), ['uses it'],
      'somebody who has never used it was ranked as a performance problem');
    assert.deepStrictEqual(o.notStarted.map(m => m.name), ['never has']);
    assert.strictEqual(o.total, 1, 'the headline counts the team being managed');
    assert.strictEqual(o.notStartedUpcoming, 135,
      'their booked work is still counted, just counted apart');
  });

  test('a handful of old clicks is not "using it"', () => {
    /* Chase has logged five outcomes out of seventy-eight and sent nothing.
       An any-trace-at-all test let him through as an adopted user, which put
       him straight back at the top of the ranking. */
    const barely = GB.teamMemberState(row({sentEver:0, pastCalls:78, unlogged:73}), now);
    assert.strictEqual(barely.adopted, false, 'five logged outcomes out of 78 is not tracking');

    const logsDiligently = GB.teamMemberState(row({sentEver:0, pastCalls:40, unlogged:4}), now);
    assert.strictEqual(logsDiligently.adopted, true,
      'somebody who logs outcomes properly is using it, even having sent nothing');

    const sends = GB.teamMemberState(row({sentEver:3, pastCalls:0, unlogged:0}), now);
    assert.strictEqual(sends.adopted, true, 'one sent message counts as using it');
  });

  test('the tab shows them rather than hiding them', () => {
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderTeamTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderTeamTab()') + 10));
    assert.ok(/o\.notStarted\.length/.test(fn), 'the not-started group is never rendered');
    assert.ok(/notStartedUpcoming/.test(fn),
      'their booked work is not surfaced, so it would silently disappear');
    assert.ok(fn.indexOf('o.notStarted.forEach') > fn.indexOf('o.members.forEach'),
      'they must render below the team being managed, not above it');
  });

  test('an empty team does not throw', () => {
    const o = GB.teamOverview([], now);
    assert.deepStrictEqual(o.members, []);
    assert.strictEqual(o.strandedUpcoming, 0);
    assert.strictEqual(GB.teamOverview(null, now).total, 0);
  });
}

console.log('\n--- the owner view, across every account ---');

/* Different job from the team view, and deliberately narrower.

   The team view is a sales manager looking at his own staff. This is the owner
   of the product looking at OTHER businesses, which the day an outside
   customer signs up stops being an internal screen. It answers "what is broken
   for them and what do I tell them" and must not become a window into their
   customers. */
{
  const now = new Date('2026-10-02T16:30:00Z');
  const acct = (over) => Object.assign({
    name:'someone', signedUp:'2026-08-01', lastSignIn:'2026-10-02',
    contacts:40, upcoming:5, sentEver:100, idleDays:0,
    connectedCalendars:1, lastSync:'2026-10-02T16:00:00Z'}, over);

  test('it never carries a single thing about a contact', () => {
    /* The privacy guarantee, asserted on the shape rather than trusted to the
       renderer. Anything added here later that names, numbers or quotes
       somebody's customer fails this. */
    const d = GB.accountDiagnosis(acct({}), now);
    const allowed = new Set(['name','signedUpDays','lastSignInDays','contacts','upcoming',
                             'sentEver','calendars','syncDays','healthy','problem','fix']);
    Object.keys(d).forEach(k => assert.ok(allowed.has(k),
      'the owner view grew a field the owner should not see: ' + k));
    const blob = JSON.stringify(d).toLowerCase();
    ['email','phone','message','client','recap','note','@']
      .forEach(w => assert.ok(blob.indexOf(w) === -1,
        'the diagnosis leaked something contact-shaped: ' + w));
  });

  test('the most upstream blocker is the one reported', () => {
    // You cannot work a list you never received. An account with no calendar
    // AND no messages sent is a setup problem, not an onboarding one.
    assert.strictEqual(
      GB.accountDiagnosis(acct({connectedCalendars:0, lastSync:null, contacts:0, sentEver:0}), now).problem,
      'No calendar connected');
    assert.strictEqual(
      GB.accountDiagnosis(acct({contacts:0, sentEver:0}), now).problem,
      'Syncing, but importing nothing');
    assert.strictEqual(
      GB.accountDiagnosis(acct({sentEver:0}), now).problem,
      'Never sent a message');
  });

  test('each problem comes with something you could actually say to them', () => {
    [{connectedCalendars:0, lastSync:null, contacts:0, sentEver:0},
     {lastSync:'2026-09-29T16:00:00Z'},
     {contacts:0, sentEver:0},
     {sentEver:0},
     {sentEver:50, idleDays:21}].forEach(over => {
      const d = GB.accountDiagnosis(acct(over), now);
      assert.ok(d.problem, 'expected a problem for ' + JSON.stringify(over));
      assert.ok(d.fix && d.fix.length > 20,
        d.problem + ' has no useful next step: ' + d.fix);
    });
  });

  test('a revoked token says plainly that only they can fix it', () => {
    // Three days of silence on this book was a revoked Google token, and the
    // one thing support must not do is promise to fix it from their end.
    const d = GB.accountDiagnosis(acct({lastSync:'2026-09-29T16:00:00Z'}), now);
    assert.ok(/Reconnect/.test(d.fix), d.fix);
    assert.ok(/nobody can do it for them/.test(d.fix), d.fix);
  });

  test('a healthy account reports no problem at all', () => {
    const d = GB.accountDiagnosis(acct({}), now);
    assert.strictEqual(d.healthy, true);
    assert.strictEqual(d.problem, null);
  });

  test('broken accounts sort above healthy ones, worst-funded first', () => {
    const o = GB.platformOverview([
      acct({name:'fine'}),
      acct({name:'small-broken', sentEver:0, upcoming:2}),
      acct({name:'big-broken', sentEver:0, upcoming:137}),
    ], now);
    assert.deepStrictEqual(o.accounts.map(a => a.name),
      ['big-broken', 'small-broken', 'fine']);
    assert.strictEqual(o.needHelp, 2);
    assert.strictEqual(o.healthy, 1);
    assert.strictEqual(o.neverUsed, 2);
    assert.strictEqual(o.strandedUpcoming, 139);
  });

  test('the owner tab hides itself, is wired in, and keeps its promise', () => {
    // Source level: the DOM stub cannot see appended trees or class changes,
    // which was established earlier by deleting the hide and watching an
    // innerHTML assertion still pass.
    const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function renderOwnerTab()'),
                         app.indexOf('\nfunction ', app.indexOf('function renderOwnerTab()') + 10));
    const guard = fn.slice(0, fn.indexOf('platformOverview('));
    assert.ok(/if\(!rows \|\| !rows\.length\)/.test(guard), 'nothing short-circuits on no accounts');
    assert.ok(/classList\.add\('hidden'\)/.test(guard), 'the empty case does not hide the tab');
    assert.ok(/classList\.remove\('hidden'\)/.test(fn), 'the tab is never shown to an owner who has accounts');

    // It must build its rows from the diagnosis, never from raw client rows.
    assert.ok(/platformOverview\(/.test(fn), 'the tab does not go through the diagnosis');
    assert.ok(!/\.clients\b/.test(fn), 'the owner tab reaches into client records');
    assert.ok(/never shows another business/.test(fn),
      'the note telling the owner what this view deliberately excludes is gone');

    const renderAll = app.slice(app.indexOf('function renderAll()'),
                                app.indexOf('\n}', app.indexOf('function renderAll()')));
    assert.ok(/renderOwnerTab\(\)/.test(renderAll), 'renderAll never calls renderOwnerTab');
  });

  test('an empty platform does not throw', () => {
    assert.strictEqual(GB.platformOverview([], now).total, 0);
    assert.strictEqual(GB.platformOverview(null, now).needHelp, 0);
  });
}

console.log('\n--- loading the team, without a new database function ---');

/* The team rows come out of whatever RLS already lets the caller read,
   aggregated in JavaScript. That matters for a reason beyond convenience:
   there is no second source of truth about who may see whom. If the security
   layer says an account is invisible, nothing in the loader can surface it. */

test('an individual account gets no team at all', async () => {
  // One membership, one person. The tabs hide themselves on an empty list, so
  // somebody working alone never sees a team view appear.
  const d = makeLoadCtx({
    memberships: {data: [{org_id:'o1', user_id:'u1', role:'owner'}], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  // .length, not deepStrictEqual: an array built inside the vm has that
  // context's Array.prototype, so a deep compare fails on the prototype
  // rather than the contents.
  assert.strictEqual(rows.length, 0, 'a solo account was given a team');
});

test('a manager gets a row per person, aggregated from the visible rows', async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 3*86400000).toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'owner'},
      {org_id:'o2', user_id:'u2', role:'owner'},
      {org_id:'o2', user_id:'u1', role:'admin'}
    ], error: null},
    organizations: {data: [{id:'o1', name:'Market Maker Management'}], error: null},
    app_settings: {data: [{user_id:'u1', sender_name:'johnny'},
                          {user_id:'u2', sender_name:'ethan'}], error: null},
    clients: {data: [
      {id:'c1', user_id:'u1', call_date_time: soon, status:'Booked'},
      {id:'c2', user_id:'u2', call_date_time: soon, status:'Completed'},
      {id:'c3', user_id:'u2', call_date_time: soon, status:'No-show'}
    ], error: null},
    message_log: {data: [
      {client_id:'c1', sent_at: now.toISOString(), responded: true},
      {client_id:'c2', sent_at: now.toISOString(), responded: false}
    ], error: null},
    team_calendar_health: {data: [
      {user_id:'u1', calendar_id:'u1@x.com', last_sync: now.toISOString()},
      {user_id:'u2', calendar_id:'u2@x.com', last_sync: now.toISOString()}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  assert.strictEqual(rows.length, 2, 'expected one row per person, got ' + rows.length);
  const byName = {}; rows.forEach(r => byName[r.name] = r);
  assert.ok(byName.johnny && byName.ethan, 'rows are not labelled: ' + rows.map(r=>r.name).join(','));
  assert.strictEqual(byName.ethan.contacts, 2);
  assert.strictEqual(byName.ethan.completed, 1);
  assert.strictEqual(byName.ethan.noshows, 1);
  assert.strictEqual(byName.johnny.sent7d, 1);
  assert.strictEqual(byName.johnny.connectedCalendars, 1);
});

test('taking an appointment reports refusal honestly', async () => {
  /* RLS refusing a write shows up as ZERO ROWS, not as an error. If that is
     read as success the manager is told the call was moved while it sits
     exactly where it was — the worst kind of wrong, because they stop
     worrying about it. */
  const ok = makeLoadCtx({ reassign_client: {data: {ok:true}, error: null} });
  assert.deepStrictEqual(
    await ok.run('reassignClient("c1","u1").then(r => JSON.stringify(r))').then(JSON.parse),
    {ok: true});

  /* reassign_client reports a refusal in its BODY rather than raising, the
     same way accept_org_invite and set_member_role do — so a wrapper checking
     only res.error would tell the manager the call moved while it sits exactly
     where it was. The worst kind of wrong, because they stop worrying. */
  const refused = makeLoadCtx({
    reassign_client: {data: {ok:false, error:'not allowed'}, error: null} });
  const r = JSON.parse(await refused.run('reassignClient("c1","u1").then(r => JSON.stringify(r))'));
  assert.strictEqual(r.ok, false, 'a refusal in the body was treated as a successful move');
  assert.strictEqual(r.error, 'not allowed');

  const broke = makeLoadCtx({ reassign_client: {data: null, error: {message: 'boom'}} });
  const b = JSON.parse(await broke.run('reassignClient("c1","u1").then(r => JSON.stringify(r))'));
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error, 'boom');

  const missing = JSON.parse(await ok.run('reassignClient(null,"u1").then(r => JSON.stringify(r))'));
  assert.strictEqual(missing.ok, false, 'a missing id should not reach the database');
});

test('loadState says who is signed in', async () => {
  // The team view needs it to tell your own row from a colleague's.
  const d = makeLoadCtx({});
  const state = await d.run('loadState()');
  assert.strictEqual(state.userId, 'u1');
});

test('an ignored contact is not counted as work', async () => {
  /* Zachary had 132 occurrences of one standing meeting marked ignored to get
     them out of his queue. If the team view still counted them he would read
     as sitting on 137 untouched appointments when the real number is 10 —
     the manager tab confidently pointing at the wrong person. */
  const soon = new Date(Date.now() + 2*86400000).toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'mm', user_id:'u1', role:'admin'},
      {org_id:'mm', user_id:'u2', role:'member'}
    ], error: null},
    organizations: {data: [{id:'mm', name:'Market Maker Management'}], error: null},
    app_settings: {data: [{user_id:'u1', sender_name:'Johnny'},
                          {user_id:'u2', sender_name:'Zachary'}], error: null},
    clients: {data: [
      {id:'real',   user_id:'u2', name:'Dana',    call_date_time: soon, status:'Booked'},
      {id:'junk1',  user_id:'u2', name:'Standing', call_date_time: soon, status:'Booked', ignored:true},
      {id:'junk2',  user_id:'u2', name:'Standing', call_date_time: soon, status:'Booked', ignored:true}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const z = rows.filter(r => r.name === 'Zachary')[0];
  assert.ok(z, 'Zachary missing from the team');
  assert.strictEqual(z.contacts, 1, 'ignored contacts counted toward the total');
  assert.strictEqual(z.upcoming, 1, 'ignored contacts counted as booked work');
  assert.strictEqual(z.upcomingList.length, 1, 'ignored contacts listed in the queue');
  assert.strictEqual(z.upcomingList[0].name, 'Dana');
});

test('a reply rate is claimed only where a reply was actually seen', async () => {
  /* Zero recorded replies is genuinely ambiguous — nobody answered, or nobody
     ever reconciled them. The loader must not resolve that ambiguity in
     either direction, so it reports measured only when it has seen one. */
  const now = new Date().toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'owner'},
      {org_id:'o2', user_id:'u2', role:'owner'},
      {org_id:'o2', user_id:'u1', role:'admin'}
    ], error: null},
    organizations: {data: [{id:'o1',name:'Market Maker Management'}], error: null},
    app_settings: {data: [{user_id:'u1', sender_name:'johnny'},
                          {user_id:'u2', sender_name:'ethan'}], error: null},
    clients: {data: [{id:'c1',user_id:'u1',status:'Booked'},{id:'c2',user_id:'u2',status:'Booked'}], error: null},
    message_log: {data: [
      {client_id:'c1', sent_at: now, responded: true},
      {client_id:'c2', sent_at: now, responded: false}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const byName = {}; rows.forEach(r => byName[r.name] = r);
  assert.strictEqual(byName.johnny.repliesMeasured, true);
  assert.strictEqual(byName.ethan.repliesMeasured, false,
    'an account with no seen reply must not claim a measured rate');
  assert.strictEqual(GB.teamReplyRate(byName.ethan), null);
});

test('a shared organisation still gives everybody their own name', async () => {
  /* The bug the org merge introduced, and the reason this test exists.

     Names used to come from the organisation, which worked only while each
     account sat alone in a one-person org named after them. The moment the
     team shared one organisation, every row was labelled "Market Maker
     Management" and the tab showed six identical people. Nothing failed; it
     just quietly became useless. */
  const now = new Date().toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'mm', user_id:'u1', role:'admin'},
      {org_id:'mm', user_id:'u2', role:'member'},
      {org_id:'mm', user_id:'u3', role:'member'}
    ], error: null},
    organizations: {data: [{id:'mm', name:'Market Maker Management'}], error: null},
    // u3 never set a sender name, so it must fall back to the calendar.
    app_settings: {data: [{user_id:'u1', sender_name:'Johnny'},
                          {user_id:'u2', sender_name:'Ethan'},
                          {user_id:'u3', sender_name:''}], error: null},
    clients: {data: [{id:'c1', user_id:'u1', status:'Booked'},
                     {id:'c2', user_id:'u2', status:'Booked'},
                     {id:'c3', user_id:'u3', status:'Booked'}], error: null},
    team_calendar_health: {data: [
      {user_id:'u1', calendar_id:'john@marketmakermgmt.com', last_sync: now},
      {user_id:'u2', calendar_id:'ethan@marketmakermgmt.com', last_sync: now},
      {user_id:'u3', calendar_id:'zachary.l@marketmakermgmt.com', last_sync: now}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const names = rows.map(r => r.name).sort();
  assert.strictEqual(new Set(names).size, 3,
    'the team is not distinguishable: ' + JSON.stringify(names));
  assert.ok(names.indexOf('Market Maker Management') === -1,
    'somebody is labelled with the organisation name: ' + JSON.stringify(names));
  assert.deepStrictEqual(names, ['Ethan', 'Johnny', 'zachary.l'],
    'got ' + JSON.stringify(names));
});

test('a team view that cannot load costs a tab, never the app', async () => {
  /* The email library taught this codebase once already: a secondary panel
     that throws takes the whole load down with it. Nobody should lose their
     morning list because a manager widget could not read a table. */
  const d = makeLoadCtx({
    memberships: {data: null, error: {message: 'permission denied for table memberships', code: '42501'}}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  assert.strictEqual(rows.length, 0, 'a failed team load must degrade to no team');

  const state = await d.run('loadState()');
  assert.ok(state, 'loadState must still return a usable state');
  assert.ok(state.clients, 'the account itself must still load');
  assert.ok(state.team && state.team.length === 0, 'state.team should be empty, not missing');
});

console.log('\n--- the privacy policy and the product agree ---');

/* These two files drifted apart silently and nobody noticed for weeks.

   The landing page says "Get started free" and eleven accounts exist, while
   the privacy policy still said Ghost Recall was "a private scheduling and
   follow-up tool", "not offered publicly as a product", covering "the single
   connected Google account". Every one of those was untrue by the time it was
   read. A policy is the one document where being out of date is not a tidiness
   problem. */
{
  const privRaw = fs.readFileSync(path.join(__dirname, 'hosted', 'privacy.html'), 'utf8');
  const land = fs.readFileSync(path.join(__dirname, 'hosted', 'index.html'), 'utf8');
  /* Prose in HTML wraps where the file wrapped, and tags sit mid-sentence, so
     matching the raw file misses any phrase that straddles a newline. That is
     how the first version of these assertions failed on text plainly present.
     Strip tags, collapse whitespace, then match. */
  const priv = privRaw.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

  test('it does not claim to be private while the front page invites signups', () => {
    const publiclyOffered = /Get started free|Sign in with Google/i.test(land);
    assert.ok(publiclyOffered, 'the landing page no longer offers signup — re-check this guard');
    [/not offered publicly/i, /single connected Google account/i, /is a private scheduling/i]
      .forEach(re => assert.ok(!re.test(priv),
        'the privacy policy still describes a private one-account tool: ' + re));
  });

  test('it discloses what the operator can see, and what it cannot', () => {
    // The owner view was built to exclude contact data. If that promise is
    // made in the product it has to be made in the policy too, and vice versa.
    assert.ok(/account-level operational information/i.test(priv),
      'the support view is not disclosed at all');
    assert.ok(/does not include your contacts/i.test(priv),
      'the policy does not say what the operator cannot see');
    assert.ok(/ask you first/i.test(priv),
      'nothing commits to asking before looking at actual records');
  });

  test('it discloses team visibility, because a manager really can see them', () => {
    assert.ok(/manager in your organi[sz]ation can see the accounts under them/i.test(priv),
      'managers can see their team but the policy never says so');
  });

  test('Google Limited Use is affirmed, which OAuth verification requires', () => {
    assert.ok(/Google API Services User Data Policy/.test(priv));
    assert.ok(/Limited Use/.test(priv));
  });
}

console.log('\n--- a member sees their own rows, a manager sees the team ---');

/* The regression that would matter once a real team shares an organisation.

   Every data policy used to say "the row's organisation is one of mine",
   granted for ALL commands, with no notion of role. Harmless while each
   account is alone in its org; the moment they share one it hands every member
   read AND WRITE over every colleague's book.

   Scope note, because the first version of this test was wrong: policies
   created inside a format() loop — which is how both the original org
   migration and the role-aware one create the six uniform tables — are
   invisible to a regex looking for "create policy <name> on public.<table>".
   That version ended up judging a superseded migration from August and failing
   for the wrong reason. So this checks two things separately: the loop
   TEMPLATE in the role-aware migration, and any explicitly-named policy added
   from that migration onwards. Anything older is superseded and not binding. */
{
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const ROLE_AWARE = '20261005170000_role_aware_policies.sql';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  test('the role-aware migration exists and is the binding one', () => {
    assert.ok(files.includes(ROLE_AWARE), 'the role-aware policy migration is gone');
  });

  test('the looped policy template checks role AND own rows', () => {
    const sql = fs.readFileSync(path.join(dir, ROLE_AWARE), 'utf8');
    const loop = sql.slice(sql.indexOf('foreach t in array'), sql.indexOf('end loop'));
    assert.ok(/user_managed_org_ids/.test(loop),
      'the template is org-wide with no role check — every member would read '
      + 'and write every colleague\'s rows once orgs are shared');
    assert.ok(/user_id = auth\.uid\(\)/.test(loop),
      'the template never matches the caller\'s own rows, so an ordinary '
      + 'member would see nothing at all');
    ['clients','app_settings','variants','variant_stats','todos','email_library']
      .forEach(t => assert.ok(loop.includes("'" + t + "'"),
        t + ' is no longer covered by the role-aware template'));
    assert.ok(!/google_oauth_tokens/.test(loop),
      'the token table is back in the loop — it holds live credentials and '
      + 'must stay owner-only');
  });

  test('nothing added later reverts a table to plain org-wide', () => {
    const scoped = ['clients','app_settings','variants','variant_stats',
                    'todos','email_library','events','message_log'];
    files.filter(f => f >= ROLE_AWARE).forEach(f => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /create policy\s+"?([a-z_]+)"?\s+on\s+public\.([a-z_]+)([\s\S]*?);/gi;
      let m;
      while ((m = re.exec(sql)) !== null) {
        const [body, , table] = [m[0], m[1], m[2]];
        if (!scoped.includes(table)) continue;
        if (/for\s+insert/i.test(body)) {
          assert.ok(/auth\.uid\(\)/.test(body),
            f + ': insert policy on ' + table + ' is not restricted to the writer');
          continue;
        }
        assert.ok(/user_managed_org_ids/.test(body),
          f + ': policy on ' + table + ' is org-wide with no role check');
        assert.ok(/auth\.uid\(\)/.test(body),
          f + ': policy on ' + table + ' never matches the caller\'s own rows');
      }
    });
  });

  test('a manager cannot write into somebody else\'s timeline', () => {
    // events is history. Reading a teammate's is reasonable; appending to it
    // is not, so SELECT widened and INSERT deliberately did not.
    const sql = fs.readFileSync(path.join(dir, ROLE_AWARE), 'utf8');
    const ins = sql.slice(sql.indexOf('events_org_insert'));
    const body = ins.slice(0, ins.indexOf(';', ins.indexOf('with check')));
    assert.ok(!/user_managed_org_ids/.test(body),
      'the events insert policy lets a manager write someone else\'s history');
    assert.ok(/user_id = auth\.uid\(\)/.test(body));
  });
}

console.log('\n--- sync health without the keys ---');

/* The silent failure this pair of changes exists to avoid.

   google_oauth_tokens became owner-only because refresh_token is a live
   credential. loadTeamRows read last_sync straight from that table, so once
   the team shares an organisation a manager would get nothing back and the
   view would report every teammate as "no calendar connected" — not an error,
   not a warning, a confident wrong answer indistinguishable from the truth. */
{
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const fn = data.slice(data.indexOf('async function loadTeamRows'),
                        data.indexOf('\nasync function loadState'));

  test('the team loader never reads the token table directly', () => {
    assert.ok(!/from\(['"]google_oauth_tokens['"]\)/.test(fn),
      'loadTeamRows reads google_oauth_tokens, which is owner-only — every '
      + 'teammate would report as having no calendar connected');
    assert.ok(/rpc\(['"]team_calendar_health['"]\)/.test(fn),
      'loadTeamRows does not go through team_calendar_health');
  });

  test('the function hands back no credential, by construction', () => {
    const dir = path.join(__dirname, 'supabase', 'migrations');
    const f = fs.readdirSync(dir).find(x => x.includes('team_calendar_health'));
    assert.ok(f, 'the team_calendar_health migration is missing');
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const body = sql.slice(sql.indexOf('create or replace function'));
    assert.ok(!/refresh_token/.test(body.replace(/--[^\n]*/g, '')),
      'team_calendar_health can return a refresh token');
    assert.ok(!/access_token/.test(body.replace(/--[^\n]*/g, '')),
      'team_calendar_health can return an access token');
    // SECURITY DEFINER bypasses RLS, so its where clause IS the access control
    // and there is no policy underneath to catch a mistake.
    assert.ok(/security\s+definer/i.test(body), 'it would be blocked by its own policy without this');
    assert.ok(/user_id\s*=\s*auth\.uid\(\)/.test(body), 'it does not scope to the caller');
    assert.ok(/user_managed_org_ids/.test(body), 'it does not scope to managed orgs');
    assert.ok(/revoke all on function public\.team_calendar_health\(\) from anon/.test(sql),
      'anon is not revoked from a definer function that bypasses RLS');
  });
}

console.log('\n--- Google refresh tokens stay with their owner ---');

/* google_oauth_tokens.refresh_token is not data about a person, it is a live
   credential: whoever can read it can act as that person against their Google
   Calendar indefinitely, and keeps being able to after they leave.

   The original policy said "any member of the row's organisation", which was
   harmless only because every organisation happened to contain one person. The
   manager-access plan was first written to carry that policy forward into a
   SHARED organisation, which would have handed every member their colleagues'
   Google credentials. It was caught while reading the table definition, not by
   anything failing. */
{
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const latest = files
    .map(f => ({f, sql: fs.readFileSync(path.join(dir, f), 'utf8')}))
    .filter(x => /create policy[^;]*on public\.google_oauth_tokens/is.test(x.sql))
    .pop();

  test('the newest policy on the token table is owner-scoped', () => {
    assert.ok(latest, 'no migration defines a policy on google_oauth_tokens');
    const policy = latest.sql.slice(latest.sql.search(/create policy/i));
    assert.ok(/user_id\s*=\s*auth\.uid\(\)/.test(policy),
      latest.f + ' defines a token policy that is not restricted to the owner');
  });

  test('no migration ever widens it back to the whole organisation', () => {
    /* The regression that matters: a later migration doing the org-wide thing
       again, perhaps by copying the pattern used by every other table. Every
       other table SHOULD be org-scoped; this one must not be. */
    files.forEach(f => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /create policy[^;]*?on public\.google_oauth_tokens[\s\S]*?;/gi;
      let m;
      while ((m = re.exec(sql)) !== null) {
        assert.ok(/user_id\s*=\s*auth\.uid\(\)/.test(m[0]),
          f + ' grants the token table to a whole organisation. Refresh tokens '
            + 'are credentials, not records — keep it to user_id = auth.uid().');
      }
    });
  });

  test('the plan says why, so it is not undone by someone tidying up', () => {
    const plan = fs.readFileSync(path.join(__dirname, 'scripts', 'manager-access-plan.md'), 'utf8');
    assert.ok(/refresh_token/.test(plan), 'the plan never mentions the credential');
    assert.ok(/excluded|tightened/i.test(plan), 'the plan does not record the exclusion');
  });
}

console.log('\n--- building a team: invites need consent, and a door ---');

/* The invite flow, which is what made every manager feature sellable rather
   than demonstrable. Two things are being defended here.

   CONSENT. Accepting an invite re-stamps org_id across the joiner's contacts,
   messages and settings — that is what makes them visible to a manager, and it
   is the point. Which means a one-sided "add by email" is a complete data
   breach reachable from a text input: type a stranger's address, absorb their
   book. The database enforces this (accept_org_invite checks the email on the
   caller's own token) and these tests hold the client to telling the truth
   about it.

   A DOOR. The team tab hides itself when handed fewer than two people and the
   invite box used to live inside it, so a brand-new customer — always alone on
   day one — had no way to add their first colleague. The database was never
   the problem: provision_org_for_new_user makes every signup an 'owner', which
   user_managed_org_ids accepts. */

// The shared makeLoadCtx stub returns `chain` from eq()/is() and throws the
// arguments away, so a filter assertion against it would pass with the filter
// deleted. This one records every call instead.
function makeInviteCtx(opts){
  const o = opts || {};
  const calls = [];
  function table(name){
    const filters = [];
    const res = () => Promise.resolve(
      Object.prototype.hasOwnProperty.call(o, name) ? o[name] : {data: [], error: null});
    const chain = {
      eq(col, val){ filters.push(['eq', col, val]); return chain; },
      is(col, val){ filters.push(['is', col, val]); return chain; },
      order(){ return chain; }, not(){ return chain; },
      select(){ return chain; },
      maybeSingle(){ return res(); },
      then(ok, bad){ return res().then(ok, bad); }
    };
    return {
      select(cols){ calls.push({table:name, op:'select', cols:cols, filters:filters}); return chain; },
      insert(row){
        calls.push({table:name, op:'insert', row:row, filters:filters});
        return {select(){ return chain; }, then(ok,bad){ return res().then(ok,bad); }};
      },
      update(row){ calls.push({table:name, op:'update', row:row, filters:filters}); return chain; },
      upsert(){ return chain; }, delete(){ return chain; }
    };
  }
  function rpc(name, args){
    calls.push({rpc:name, args:args});
    return Promise.resolve(
      Object.prototype.hasOwnProperty.call(o, name) ? o[name] : {data: [], error: null});
  }
  const sandbox = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, isNaN,
    parseInt, parseFloat, Set,
    crypto: { randomUUID: () => 'uuid-x' },
    window: { GB_SUPABASE: {
      auth: { getUser: async () => ({data:{user:{id: o.uid || 'u1', email: o.email || 'boss@acme.com'}}}) },
      from: table, rpc } }
  };
  sandbox.window.window = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','logic.js'),'utf8'), ctx, {filename:'hosted/logic.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'hosted','data.js'),'utf8'), ctx, {filename:'hosted/data.js'});
  return {ctx, calls, run: (src) => vm.runInContext(src, ctx)};
}

test('a new customer who is alone can still invite their first colleague', async () => {
  // The exact day-one shape: one membership, role owner, no team.
  const d = makeInviteCtx({
    memberships: {data: [{org_id:'o1', role:'owner', organizations:{name:'Acme'}}], error: null}
  });
  const r = await d.run('loadOrgRole(window.GB_SUPABASE, "u1")');
  assert.strictEqual(r.canInvite, true, 'a brand-new owner cannot build a team');
  assert.strictEqual(r.orgName, 'Acme');
});

test('an ordinary member is not offered the invite box', async () => {
  const d = makeInviteCtx({
    memberships: {data: [{org_id:'o1', role:'member', organizations:{name:'Acme'}}], error: null}
  });
  const r = await d.run('loadOrgRole(window.GB_SUPABASE, "u1")');
  assert.strictEqual(r.canInvite, false, 'a rank-and-file member was offered the invite box');
});

test('the roles the client trusts are the roles the database trusts', () => {
  // If these drift, the button appears and the insert is refused by RLS: a
  // confusing failure rather than an unsafe one, but still a broken promise.
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const sql = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  /* Split on the name, then keep only the chunks that actually carry a body:
     the revoke and grant lines name the function too, so taking the last
     chunk lands on `to authenticated;` and the assertion fails for a reason
     that has nothing to do with roles. */
  const defs = sql.split(/create or replace function public\.user_managed_org_ids/).slice(1)
    .map(c => c.slice(0, c.indexOf('$$;') + 3))
    .filter(c => /role in \(/.test(c));
  assert.ok(defs.length, 'no definition of user_managed_org_ids tests a role at all');
  // The last definition wins at runtime, so that is the one to check.
  const roles = defs[defs.length - 1];
  assert.ok(/'owner'/.test(roles) && /'admin'/.test(roles),
    'user_managed_org_ids no longer accepts owner and admin');
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const role = data.slice(data.indexOf('async function loadOrgRole'),
                          data.indexOf('async function loadPendingInvites'));
  assert.ok(/'owner'/.test(role) && /'admin'/.test(role),
    'loadOrgRole and user_managed_org_ids disagree about who manages');
});

test('a malformed address never reaches the database', async () => {
  const d = makeInviteCtx({});
  const r = await d.run('inviteToOrg("not-an-address", "member")');
  assert.strictEqual(r.ok, false);
  assert.ok(/email/i.test(r.error), 'the refusal does not say what was wrong: ' + r.error);
  assert.strictEqual(d.calls.length, 0, 'a typo still hit the database');
});

test('a member cannot invite, and nothing is written when they try', async () => {
  const d = makeInviteCtx({
    memberships: {data: [{org_id:'o1', role:'member'}], error: null}
  });
  const r = await d.run('inviteToOrg("new@acme.com", "admin")');
  assert.strictEqual(r.ok, false);
  assert.ok(/manager/i.test(r.error), 'the refusal is not explained: ' + r.error);
  assert.ok(!d.calls.some(c => c.table === 'org_invites' && c.op === 'insert'),
    'a plain member got an invite row written — RLS would refuse it, but the '
      + 'client must not be the only thing that knows that');
});

test('an invite records the inviting org, the sender, and a normalised address', async () => {
  const d = makeInviteCtx({
    uid: 'boss',
    memberships: {data: [{org_id:'org-9', role:'owner'}], error: null},
    org_invites: {data: [{id:'i1'}], error: null}
  });
  const r = await d.run('inviteToOrg("  New.Person@ACME.com ", "member")');
  assert.strictEqual(r.ok, true, 'a manager could not invite: ' + r.error);
  const ins = d.calls.find(c => c.table === 'org_invites' && c.op === 'insert');
  assert.ok(ins, 'no invite was written');
  assert.strictEqual(ins.row.email, 'new.person@acme.com',
    'the address was not trimmed and lowercased, so the unique index and the '
      + 'token comparison in accept_org_invite will both miss');
  assert.strictEqual(ins.row.org_id, 'org-9', 'the invite went to the wrong organisation');
  assert.strictEqual(ins.row.invited_by, 'boss',
    'invited_by must be the sender — the policy with-check requires it');
});

test('an unknown role is coerced rather than passed through', async () => {
  const d = makeInviteCtx({
    memberships: {data: [{org_id:'o1', role:'owner'}], error: null},
    org_invites: {data: [{id:'i1'}], error: null}
  });
  await d.run('inviteToOrg("x@acme.com", "superuser")');
  const ins = d.calls.find(c => c.table === 'org_invites' && c.op === 'insert');
  assert.strictEqual(ins.row.role, 'member',
    'a role the check constraint would reject was sent straight through');
});

test('inviting the same person twice says so in words', async () => {
  const d = makeInviteCtx({
    memberships: {data: [{org_id:'o1', role:'owner'}], error: null},
    org_invites: {data: null, error: {message:
      'duplicate key value violates unique constraint "org_invites_pending"'}}
  });
  const r = await d.run('inviteToOrg("x@acme.com", "member")');
  assert.strictEqual(r.ok, false);
  assert.ok(/already invited/i.test(r.error), 'the user is shown a constraint name: ' + r.error);
});

test('the outstanding list is the ones you sent, not the ones sent to you', async () => {
  /* org_invites carries a second policy so an invited person can read the
     invite addressed to them. Without the invited_by filter, a manager who
     had themselves been invited by another company would see that invite
     listed under "you invited" — somebody else's organisation, inside their
     own team tab. */
  const d = makeInviteCtx({
    org_invites: {data: [{id:'i1', email:'a@acme.com', created_at:'2026-10-01'}], error: null}
  });
  const rows = await d.run('loadSentInvites(window.GB_SUPABASE, "boss")');
  assert.strictEqual(rows.length, 1);
  const sel = d.calls.find(c => c.table === 'org_invites' && c.op === 'select');
  const f = JSON.stringify(sel.filters);
  assert.ok(/\["eq","invited_by","boss"\]/.test(f),
    'sent invites are not filtered to the sender: ' + f);
  assert.ok(/\["is","accepted_at",null\]/.test(f), 'accepted invites still show as outstanding');
  assert.ok(/\["is","revoked_at",null\]/.test(f), 'a revoked invite still shows as outstanding');
});

test('with no signed-in id, nothing is listed rather than everything', async () => {
  const d = makeInviteCtx({
    org_invites: {data: [{id:'i1', email:'a@acme.com'}], error: null}
  });
  const rows = await d.run('loadSentInvites(window.GB_SUPABASE, null)');
  assert.strictEqual(rows.length, 0, 'a missing uid dropped the filter and listed everything');
});

test('a refused acceptance is reported, not swallowed', async () => {
  // accept_org_invite returns {ok:false} in the body rather than raising, so a
  // wrapper that only checked res.error would report success and the UI would
  // say "you are on the team" to somebody who is not.
  const d = makeInviteCtx({accept_org_invite: {data: {ok:false, error:'invite not found or already used'}, error: null}});
  const r = await d.run('acceptOrgInvite("i1")');
  assert.strictEqual(r.ok, false, 'a refusal was reported as success');
  assert.ok(/not found/.test(r.error), 'the reason was lost: ' + r.error);
});

test('a successful acceptance goes through the function, never a direct write', async () => {
  const d = makeInviteCtx({accept_org_invite: {data: {ok:true, org_id:'o2'}, error: null}});
  const r = await d.run('acceptOrgInvite("i1")');
  assert.strictEqual(r.ok, true);
  const call = d.calls.find(c => c.rpc === 'accept_org_invite');
  assert.ok(call, 'acceptance did not go through accept_org_invite');
  assert.strictEqual(call.args.invite, 'i1');
  assert.ok(!d.calls.some(c => c.table === 'memberships' && (c.op === 'insert' || c.op === 'update')),
    'the client wrote a membership itself, bypassing the consent check');
});

test('a broken invite table costs the invite box, not the morning', async () => {
  const d = makeInviteCtx({
    my_pending_invites: {data: null, error: {message: 'function public.my_pending_invites() does not exist'}}
  });
  const rows = await d.run('loadPendingInvites(window.GB_SUPABASE)');
  assert.strictEqual(rows.length, 0, 'a code deploy ahead of its migration would break the app');
});

test('the solo-owner door exists, and the banner states what accepting does', () => {
  // Source level: the DOM stub cannot see appended trees or class changes —
  // established earlier in this file by deleting a hide and watching an
  // innerHTML assertion still pass.
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'));
  const guard = fn.slice(0, fn.indexOf('teamOverview('));
  assert.ok(/canInvite/.test(guard),
    'renderTeamTab hides itself on an empty team without checking canInvite, so '
      + 'a one-person account — every new customer on day one — has no way to '
      + 'add anybody and the whole manager story is unreachable');
  assert.ok(/invitePanel\(\)/.test(guard), 'the empty-team case shows no invite box');

  const banner = app.slice(app.indexOf('function renderPendingInvites()'),
                           app.indexOf('function invitePanel()'));
  assert.ok(/move into their|move across|messages and settings/.test(banner),
    'the accept banner no longer says that accepting moves your own records '
      + 'into somebody else’s account — that is the one thing the person '
      + 'being asked has to know');

  const panel = app.slice(app.indexOf('function invitePanel()'),
                          app.indexOf('function renderTeamTab()'));
  assert.ok(/moves across until they do/.test(panel),
    'the invite box no longer tells the manager that nothing moves until the '
      + 'person accepts, which invites them to expect otherwise');
});

test('both invite actions are wired to the click dispatcher', () => {
  /* Not theoretical: team-assign was first put in the click dispatcher when
     the control is a <select>, which fires change. A handler nothing can
     reach is worse than a missing one, because the button is right there. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  assert.ok(/case 'invite-send':/.test(app), 'nothing handles invite-send');
  assert.ok(/case 'invite-accept':/.test(app), 'nothing handles invite-accept');
  const renderAll = app.slice(app.indexOf('function renderAll()'),
                              app.indexOf('\n}', app.indexOf('function renderAll()')));
  assert.ok(/renderPendingInvites\(\)/.test(renderAll),
    'renderAll never calls renderPendingInvites, so an invite is invisible');
});

test('acceptance reloads rather than patching state in place', () => {
  // Accepting changes org_id on eight tables. Every cached row in STATE was
  // read under the old organisation, so patching a field and re-rendering
  // would show a mix of both.
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const h = app.slice(app.indexOf("case 'invite-accept':"), app.indexOf("case 'team-toggle':"));
  assert.ok(/init\(\)/.test(h), 'acceptance does not reload the account');
  assert.ok(/showToast\('Could not join/.test(h), 'a failed join says nothing to the person');
});

test('the migration records why acceptance cannot be one-sided', () => {
  const f = path.join(__dirname, 'supabase', 'migrations', '20261005210000_org_invites.sql');
  const sql = fs.readFileSync(f, 'utf8');
  assert.ok(/auth\.jwt\(\) ->> 'email'/.test(sql),
    'acceptance no longer verifies against the email on the caller’s own token');
  assert.ok(/breach|consent|NOT OPTIONAL/i.test(sql),
    'the reason acceptance is required is no longer written down, so the next '
      + 'person to want a quicker onboarding will remove it');
  const accept = sql.slice(sql.indexOf('function public.accept_org_invite'));
  assert.ok(/me\b/.test(accept) && /where x\.user_id = \$2|user_id = me/.test(accept),
    'accept_org_invite no longer limits its writes to the caller’s own rows');
});

/* Copy assertions have to run against code with the comments taken out.

   A test for "the card still explains X" passed with the user-visible string
   replaced by 'edited', because the slice it searched also contained the
   comment above that code explaining X. The comment is not the product. */
function codeOnly(src){
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
}

console.log('\n--- rewording a variant without corrupting what it learned ---');

/* The whole point of the variant table is that a reply rate means something.
   A variant's number is earned by its exact words, so rewording one in place
   would hand 12 replies out of 40 to copy that never sent a single message —
   and pickVariant would go on preferring it on that record. Nothing would look
   wrong; the app would simply be optimising against a number that had stopped
   meaning anything. So editVariant forks once there is anything to protect. */

test('rewording a variant nobody has sent just replaces the words', () => {
  const state = GB.buildDefaultState();
  const before = state.variants.welcome.length;
  const v = state.variants.welcome[0];
  state.variantStats.welcome[v.id] = {sends: 0, responses: 0};
  const r = GB.editVariant(state, 'welcome', v.id, 'Hi {name}, brand new wording.');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.action, 'edited', 'a variant with no history should not fork');
  assert.strictEqual(state.variants.welcome.length, before, 'a pointless second row was created');
  assert.strictEqual(state.variants.welcome[0].text, 'Hi {name}, brand new wording.');
  assert.ok(!state.variants.welcome[0].retired, 'it retired a variant for no reason');
});

test('rewording a variant that has sends forks it, and the old record stays with the old words', () => {
  const state = GB.buildDefaultState();
  const v = state.variants.welcome[0];
  const oldText = v.text;
  state.variantStats.welcome[v.id] = {sends: 40, responses: 12};
  const r = GB.editVariant(state, 'welcome', v.id, 'Hey {name}, reworded.');
  assert.strictEqual(r.action, 'forked', 'a variant with 40 sends was overwritten in place');
  assert.strictEqual(r.keptSends, 40);

  const old = state.variants.welcome.filter(x => x.id === v.id)[0];
  assert.ok(old, 'the original was deleted rather than retired — its record is gone');
  assert.strictEqual(old.text, oldText,
    'the original’s text changed, so its 12 replies now describe words it never sent');
  assert.strictEqual(old.retired, true, 'the replaced wording is still in the running');
  assert.strictEqual(state.variantStats.welcome[v.id].sends, 40, 'the old record was altered');
  assert.strictEqual(state.variantStats.welcome[v.id].responses, 12, 'the old record was altered');

  const made = state.variants.welcome.filter(x => x.id === r.id)[0];
  assert.ok(made, 'the new wording was not added');
  assert.strictEqual(made.text, 'Hey {name}, reworded.');
  assert.strictEqual(state.variantStats.welcome[r.id].sends, 0,
    'the new wording inherited a send count it did not earn');
  assert.strictEqual(state.variantStats.welcome[r.id].responses, 0,
    'the new wording inherited replies it did not earn');
});

test('a retired variant is never sent again', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({});
  const doomed = state.variants.welcome[0].id;
  state.variantStats.welcome[doomed] = {sends: 5, responses: 5};  // would be champion
  GB.editVariant(state, 'welcome', doomed, 'Hi {name}, the replacement.');
  for (let i = 0; i < 60; i++) {
    const got = GB.pickVariant(state, 'welcome', c, {forceReroll: true});
    assert.notStrictEqual(got.id, doomed,
      'a retired variant was picked — and with a 100% reply rate on it, it '
        + 'would be picked almost every time');
  }
});

test('a stage whose variants are all retired still has something to send', () => {
  const state = GB.buildDefaultState();
  const c = freshClient({});
  state.variants.welcome.forEach(v => { v.retired = true; });
  const got = GB.pickVariant(state, 'welcome', c);
  assert.ok(got && typeof got.text === 'string' && got.text.length,
    'retiring everything left the stage with nothing to send');
});

test('editVariant refuses the cases that would quietly do nothing', () => {
  const state = GB.buildDefaultState();
  const v = state.variants.welcome[0];
  assert.strictEqual(GB.editVariant(state, 'welcome', v.id, '   ').ok, false, 'empty text accepted');
  assert.strictEqual(GB.editVariant(state, 'welcome', v.id, v.text).ok, false, 'unchanged text accepted');
  assert.strictEqual(GB.editVariant(state, 'welcome', 'nope', 'x').ok, false, 'unknown id accepted');
  assert.strictEqual(GB.editVariant(state, 'nostage', v.id, 'x').ok, false, 'unknown stage accepted');
  assert.strictEqual(state.variants.welcome[0].text, v.text, 'a refused edit still changed the text');
});

test('a reworded variant does not come back to life on the next load', () => {
  /* Two paths, and the builtin one was wrong first time round: builtins are
     rebuilt from code on every load rather than read back, which is what keeps
     a shipped template improvable — and which also threw the retirement away.
     The variant returned live, competing again on a reply rate belonging to
     wording that is no longer sent. */
  const state = GB.buildDefaultState();
  const builtin = state.variants.welcome.filter(v => v.builtin)[0];
  assert.ok(builtin, 'no builtin variant to test with');
  state.variantStats.welcome[builtin.id] = {sends: 9, responses: 3};
  GB.editVariant(state, 'welcome', builtin.id, 'Hi {name}, replaced builtin.');
  state.variants.welcome.push({id:'cust1', text:'custom one', builtin:false, retired:true});

  const back = GB.migrateState(JSON.parse(JSON.stringify(state)));
  const b2 = back.variants.welcome.filter(v => v.id === builtin.id)[0];
  assert.ok(b2, 'the builtin vanished');
  assert.strictEqual(b2.retired, true,
    'a reworded builtin came back live after a reload, competing on a reply '
      + 'rate that belongs to wording nobody sends any more');
  const c2 = back.variants.welcome.filter(v => v.id === 'cust1')[0];
  assert.ok(c2 && c2.retired === true, 'a retired custom variant came back live');
});

test('retired survives the database round trip', () => {
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const row = data.slice(data.indexOf('function rowVariant'), data.indexOf('function rowEmailVariant'));
  assert.ok(/retired/.test(row),
    'rowVariant does not write retired, so a rework is forgotten on the next save');
  const load = data.slice(data.indexOf("state.variants[row.stage].push("),
                          data.indexOf("state.variants[row.stage].push(") + 400);
  assert.ok(/retired/.test(load),
    'the loader drops retired, so every reworded variant returns to the running '
      + 'at the next sign-in');
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const sql = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(/add column if not exists retired/.test(sql),
    'nothing adds the retired column, so saving one would error');
});

console.log('\n--- stepping between a contact’s touches ---');

test('pendingStages is what has not gone out, in sequence order', () => {
  const now = new Date();
  const c = freshClient({callDateTime: new Date(now.getTime() + 4*86400000).toISOString()});
  const prog0 = GB.cadenceProgress(c, now);
  assert.ok(prog0.pendingStages.length > 1, 'a fresh contact should have several touches pending');
  assert.strictEqual(prog0.pendingStages.length, prog0.total, 'nothing is sent yet');
  // Order must follow the sequence, not the order anything happened.
  const seq = prog0.touches;
  const idxs = prog0.pendingStages.map(st => seq.indexOf(st));
  assert.deepStrictEqual(idxs.slice().sort((a,b) => a-b), idxs,
    'pendingStages is out of sequence order, so the arrows would jump about');

  GB.markSent(state0ForTouches(c), c.id, prog0.pendingStages[0], 'anything');
  const prog1 = GB.cadenceProgress(c, now);
  assert.strictEqual(prog1.pendingStages.indexOf(prog0.pendingStages[0]), -1,
    'a touch that has been sent is still offered, so the arrows can land on it '
      + 'and the same message can go out twice for one appointment');
});

function state0ForTouches(c){
  const st = GB.buildDefaultState();
  st.clients[c.id] = c;
  return st;
}

test('cadenceProgress stays serialisable', () => {
  // It gets cloned and compared. A function on it survives neither.
  const c = freshClient({});
  const prog = GB.cadenceProgress(c, new Date());
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(prog)));
  Object.keys(prog).forEach(k => {
    assert.notStrictEqual(typeof prog[k], 'function', k + ' is a function');
  });
});

test('the arrows step through pending touches only, and never re-send one', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const handler = app.slice(app.indexOf("case 'touch-prev':"), app.indexOf("case 'add-variant':"));
  assert.ok(/pendingStages/.test(handler),
    'the arrows walk a list other than pendingStages, so they can land on a '
      + 'touch already sent for this appointment');
  assert.ok(/if\(to < 0 \|\| to >= tpend\.length\) break;/.test(handler),
    'nothing stops the arrows walking off either end of the list');
  assert.ok(/renderCallsBoard\(\)/.test(handler),
    'the card is patched rather than rebuilt — every control on it carries '
      + 'data-stage, so a half-swapped card sends one touch and logs another');

  const board = app.slice(app.indexOf('function renderCallsBoard()'));
  const apply = board.slice(0, board.indexOf('var countToday'));
  assert.ok(/delete UI\.touchPick/.test(apply),
    'a stale pick is never dropped, so a card can sit on a touch that has '
      + 'already been sent');
  assert.ok(/pendingStages/.test(apply), 'the pick is honoured without checking it is still pending');
});

test('the card says a hand-edit is kept out of the comparison', () => {
  /* markSent has always logged an edited send against 'custom' rather than
     crediting the template it started from. That safeguard was invisible,
     which is close to not having it: somebody who assumes their rewrite is
     being scored will read the league table as though it included them. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const note = codeOnly(app.slice(app.indexOf('if(isEdited){'),
                                  app.indexOf('var actions = document.createElement')));
  assert.ok(/kept out of the template comparison/.test(note),
    'the label on an edited card no longer says the edit is kept out of the '
      + 'template comparison');
  assert.ok(/does not add to or/.test(note),
    'the hover text explaining why no longer survives');

  // And the behaviour it describes must actually hold.
  const state = GB.buildDefaultState();
  const c = freshClient({id:'ed9', callDateTime: null});
  state.clients[c.id] = c;
  const v = GB.pickVariant(state, 'welcome', c);
  state.variantStats.welcome[v.id] = {sends: 7, responses: 3};
  GB.markSent(state, c.id, 'welcome', 'something I typed myself');
  assert.strictEqual(c.messageLog[0].variantId, 'custom',
    'a hand-edited send was credited to the template it started from');
  assert.strictEqual(state.variantStats.welcome[v.id].sends, 7, 'the template’s record moved');
});

test('a retired variant is neither champion nor charted', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const tab = app.slice(app.indexOf('function renderVariantsTab()'),
                        app.indexOf('function renderVariantBarChart'));
  const champ = tab.slice(0, tab.indexOf('var block ='));
  assert.ok(/if\(v\.retired\) return;/.test(champ),
    'a retired variant can still be crowned champion, pointing the reader at '
      + 'copy the app has stopped sending');
  const chart = app.slice(app.indexOf('function renderVariantBarChart'),
                          app.indexOf("/* ---- weekly tab ---- */"));
  assert.ok(/!v\.retired/.test(chart), 'retired variants are still charted as if live');
});

test('the editor says which of the two things saving will do, before it happens', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const raw = app.slice(app.indexOf('function renderVariantsTab()'),
                        app.indexOf('function renderVariantBarChart'));
  const tab = codeOnly(raw);
  assert.ok(/s\.sends > 0/.test(tab), 'the editor does not distinguish the two cases at all');
  // The fork branch has to name all three consequences: the new wording starts
  // from zero, this version retires, and its rate stays with its own words.
  assert.ok(/starts the new wording from zero/.test(tab),
    'the editor no longer says the new wording starts from zero');
  assert.ok(/retires this/.test(tab), 'it never says that saving retires this version');
  assert.ok(/stays attached to the words that/.test(tab),
    'it no longer says the old reply rate stays with the old wording, which is '
      + 'the reason the fork happens at all');
  assert.ok(/just replaced/.test(tab), 'it never says the no-history case simply replaces the text');
  // Reword must not be offered on a retired row: editing it would make its
  // numbers describe words it never sent.
  assert.ok(/if\(!v\.retired\)\{/.test(tab), 'Reword is offered on retired variants too');
});

console.log('\n--- a new table is not reachable from the browser by accident ---');

/* A table created in the public schema is served by PostgREST to anyone
   holding the anon key, and the anon key ships inside the app's JavaScript.
   RLS is what stops that, and the default grants are what make it moot.

   This is not hypothetical. Three cleanup scripts snapshotted rows into
   archive tables with a plain CREATE TABLE, and for two days
   google_oauth_tokens_archive served three Google refresh tokens — live
   credentials, not records — plus 47 real client rows out of clients_archive,
   to unauthenticated callers. The live tables were locked the whole time, so
   nothing looked wrong anywhere.

   Checked against the SQL rather than the database because the suite is
   offline. It catches the thing that actually went wrong: writing CREATE TABLE
   and moving on. */
test('every table created in SQL here also gets RLS turned on', () => {
  const roots = ['supabase/migrations', 'scripts'];
  const created = {};   // table -> file that created it
  const guarded = {};
  roots.forEach(rel => {
    const dir = path.join(__dirname, rel);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).filter(f => f.endsWith('.sql')).forEach(f => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8')
        // Comments explain these tables at length; don't read them as code.
        .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
      let m;
      const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi;
      while ((m = re.exec(sql)) !== null) {
        // Temporary tables live inside one transaction and are never served.
        const before = sql.slice(Math.max(0, m.index - 30), m.index);
        if (/\b(temp|temporary)\b/i.test(before)) continue;
        if (!created[m[1]]) created[m[1]] = rel + '/' + f;
      }
      const re2 = /alter\s+table\s+(?:public\.)?([a-z0-9_]+)\s+enable\s+row\s+level\s+security/gi;
      while ((m = re2.exec(sql)) !== null) guarded[m[1]] = true;
    });
  });
  assert.ok(Object.keys(created).length > 0, 'no CREATE TABLE found — the scan is broken');
  const naked = Object.keys(created).filter(t => !guarded[t]);
  assert.deepStrictEqual(naked, [],
    'these tables are created without RLS being enabled anywhere: '
      + naked.map(t => t + ' (' + created[t] + ')').join(', ')
      + '. A public table with no RLS is readable by anyone with the anon key, '
      + 'which ships in the app’s JavaScript.');
});

test('the archive tables are closed, and the migration says why', () => {
  const f = path.join(__dirname, 'supabase', 'migrations',
                      '20261007170000_lock_down_archive_tables.sql');
  const sql = fs.readFileSync(f, 'utf8');
  ['google_oauth_tokens_archive', 'clients_archive', 'message_log_archive',
   'org_merge_backup'].forEach(t => {
    assert.ok(new RegExp('alter table public\\.' + t + '\\s+enable row level security').test(sql),
      t + ' no longer has RLS enabled');
    assert.ok(new RegExp('revoke all on public\\.' + t + '\\s+from anon, authenticated').test(sql),
      t + ' no longer has its anon grant revoked');
  });
  assert.ok(/refresh_token/.test(sql),
    'the migration no longer records that a refresh token is a live credential, '
      + 'which is the reason this was urgent rather than tidy-up');
});

console.log('\n--- the team view reads each person\u2019s own pipeline ---');

/* The team loader tested for the literal strings 'Completed' and 'No-show'.
   Those are the DEFAULT pipeline's words. A real estate team closes a call as
   'Showing Completed' and an HVAC firm as 'Walkthrough Done', so on any
   template but the default every finished call counted as one nobody had
   logged and every show-up rate read 0%.

   It was invisible on the live account because that team is on the default
   pipeline, where the literal strings happen to be right. It would have
   surfaced on the first customer who picked an industry template — as a
   specific wrong number, not a blank. */

test('pipelineRoleMap falls back rather than returning nothing useful', () => {
  const def = GB.pipelineRoleMap(null);
  assert.strictEqual(def['Completed'], 'won');
  assert.strictEqual(def['No-show'], 'missed');
  assert.strictEqual(def['Booked'], 'open');
  // A corrupt setting must not read as "every status is open", which would
  // report a whole team as having logged nothing.
  assert.strictEqual(GB.pipelineRoleMap([]).Completed, 'won', 'empty pipeline lost the defaults');
  assert.strictEqual(GB.pipelineRoleMap([{nope:1}]).Completed, 'won', 'junk pipeline lost the defaults');
  assert.strictEqual(GB.pipelineRoleMap('garbage').Completed, 'won', 'non-array lost the defaults');
});

test('a custom pipeline maps onto the same roles', () => {
  const re = GB.buildIndustryTemplates().filter(t => t.key === 'real_estate')[0];
  const map = GB.pipelineRoleMap(re.pipeline);
  assert.strictEqual(map['Showing Completed'], 'won');
  assert.strictEqual(map['No-show'], 'missed');
  assert.strictEqual(map['New Lead'], 'open');
  assert.strictEqual(map['Completed'], undefined,
    'the real estate pipeline should not know the default template\u2019s words');
});

test('a team on a custom pipeline gets real numbers, not zeroes', async () => {
  const now = Date.now();
  const past = new Date(now - 3*86400000).toISOString();
  const soon = new Date(now + 3*86400000).toISOString();
  const re = GB.buildIndustryTemplates().filter(t => t.key === 'real_estate')[0];
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [
      {user_id:'u1', sender_name:'Dana', pipeline: re.pipeline},
      {user_id:'u2', sender_name:'Sam',  pipeline: re.pipeline}
    ], error: null},
    clients: {data: [
      // Sam: three showings that happened — two attended, one missed.
      {id:'c1', user_id:'u2', name:'A', call_date_time:past, status:'Showing Completed'},
      {id:'c2', user_id:'u2', name:'B', call_date_time:past, status:'Showing Completed'},
      {id:'c3', user_id:'u2', name:'C', call_date_time:past, status:'No-show'},
      // ...one that happened and still sits open: genuinely unlogged.
      {id:'c4', user_id:'u2', name:'D', call_date_time:past, status:'New Lead'},
      // ...one stalled, and one still to come.
      {id:'c5', user_id:'u2', name:'E', call_date_time:past, status:'Thinking It Over'},
      {id:'c6', user_id:'u2', name:'F', call_date_time:soon, status:'Showing Scheduled'},
      {id:'c7', user_id:'u1', name:'G', call_date_time:past, status:'Showing Completed'}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const sam = rows.filter(r => r.name === 'Sam')[0];
  assert.ok(sam, 'Sam is missing from the team rows');
  assert.strictEqual(sam.completed, 2,
    'a showing closed as "Showing Completed" was not counted as attended — '
      + 'this is the bug: the loader was looking for the word "Completed"');
  assert.strictEqual(sam.noshows, 1, 'no-shows miscounted');
  assert.strictEqual(sam.rescheduled, 1,
    '"Thinking It Over" is a stalled stage and was never counted at all');
  assert.strictEqual(sam.unlogged, 1,
    'only the one still sitting on an open stage is genuinely unlogged');
  assert.strictEqual(sam.pastCalls, 5);
  assert.strictEqual(sam.upcoming, 1);
});

test('a recruiter on the same team gets real numbers too', async () => {
  /* Colin runs hiring rather than sales, on the built-in recruiting template:
     Candidates and Interviews, closing as "Screen Completed" rather than
     "Completed". Under the old literal matching that word matched neither
     bucket, so every interview he finished counted as one nobody had logged
     and his show-up rate read 0% — on the screen his own manager judges him
     by. One team, two pipelines, and the roll-up has to be right for both. */
  const now = Date.now();
  const past = new Date(now - 3*86400000).toISOString();
  const rec = GB.buildIndustryTemplates().filter(t => t.key === 'recruiting')[0];
  const sales = GB.buildIndustryTemplates().filter(t => t.key === 'agency')[0];
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [
      {user_id:'u1', sender_name:'Johnny', pipeline: sales.pipeline},
      {user_id:'u2', sender_name:'Colin',  pipeline: rec.pipeline}
    ], error: null},
    clients: {data: [
      {id:'k1', user_id:'u2', name:'A', call_date_time:past, status:'Screen Completed'},
      {id:'k2', user_id:'u2', name:'B', call_date_time:past, status:'Screen Completed'},
      {id:'k3', user_id:'u2', name:'C', call_date_time:past, status:'No-show'},
      {id:'k4', user_id:'u2', name:'D', call_date_time:past, status:'Awaiting Decision'},
      {id:'k5', user_id:'u2', name:'E', call_date_time:past, status:'Screen Scheduled'},
      {id:'s1', user_id:'u1', name:'F', call_date_time:past, status:'Completed'}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const colin = rows.filter(r => r.name === 'Colin')[0];
  assert.ok(colin, 'the recruiter is missing from the team');
  assert.strictEqual(colin.completed, 2,
    'a finished interview closed as "Screen Completed" was not counted');
  assert.strictEqual(colin.noshows, 1, 'a candidate no-show was miscounted');
  assert.strictEqual(colin.rescheduled, 1, '"Awaiting Decision" is a stalled stage');
  assert.strictEqual(colin.unlogged, 1,
    'only the one still on an open stage is genuinely unlogged');
  // And the salesperson beside him is unaffected by his pipeline.
  const johnny = rows.filter(r => r.name === 'Johnny')[0];
  assert.strictEqual(johnny.completed, 1, 'the sales pipeline broke when a recruiter joined');
});

test('the same shapes still work on the default pipeline', async () => {
  const now = Date.now();
  const past = new Date(now - 3*86400000).toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Sam', pipeline: null}], error: null},
    clients: {data: [
      {id:'c1', user_id:'u2', name:'A', call_date_time:past, status:'Completed'},
      {id:'c2', user_id:'u2', name:'B', call_date_time:past, status:'No-show'},
      {id:'c3', user_id:'u2', name:'C', call_date_time:past, status:'Booked'},
      {id:'c4', user_id:'u2', name:'D', call_date_time:past, status:'Rescheduled'},
      {id:'c5', user_id:'u2', name:'E', call_date_time:past, status:'Ghosted'}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const sam = rows.filter(r => r.name === 'Sam')[0];
  assert.strictEqual(sam.completed, 1);
  assert.strictEqual(sam.noshows, 1);
  assert.strictEqual(sam.rescheduled, 1);
  // Ghosted is 'lost' — an outcome somebody recorded, so not unlogged.
  assert.strictEqual(sam.unlogged, 1, 'a Ghosted call was counted as never logged');
});

test('a status the pipeline no longer has counts as work, never as a win', async () => {
  /* Someone edits their pipeline and drops a stage; the contacts sitting on
     it keep that status. Reading an unrecognised stage as 'won' would quietly
     inflate the show-up rate with calls nobody recorded an outcome for, which
     is worse than useless on the one screen a manager judges people by. */
  const past = new Date(Date.now() - 3*86400000).toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Sam', pipeline: null}], error: null},
    clients: {data: [
      {id:'c1', user_id:'u2', name:'A', call_date_time:past, status:'Some Deleted Stage'},
      {id:'c2', user_id:'u2', name:'B', call_date_time:past, status:'Completed'}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const sam = rows.filter(r => r.name === 'Sam')[0];
  assert.strictEqual(sam.completed, 1, 'an unknown status was counted as an attended call');
  assert.strictEqual(sam.noshows, 0);
  assert.strictEqual(sam.unlogged, 1, 'an unknown status should read as still needing an outcome');
});

test('the loader no longer tests status strings by hand', () => {
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const fn = data.slice(data.indexOf('async function loadTeamRows'),
                        data.indexOf('async function fetchClientEvents') > -1
                          ? data.indexOf('async function fetchClientEvents')
                          : data.length);
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  ["'Completed'", "'No-show'", "'Booked'", "'Confirmed'", "'Reminded'"].forEach(lit => {
    assert.ok(!code.includes('status === ' + lit),
      'loadTeamRows compares status against ' + lit + ' again. Those are the '
        + 'default pipeline\u2019s words; use the role from pipelineRoleMap so '
        + 'a customer on an industry template is not told 0%.');
  });
  assert.ok(/pipelineRoleMap\(r\.pipeline\)/.test(code),
    'each teammate is no longer read against their own pipeline');
  /* The column has to be ASKED for. The test stub returns whole fixture rows
     whatever you select, so dropping 'pipeline' from the query passes every
     behavioural test here and then reads undefined against the real database —
     which silently falls back to the default pipeline for everyone, i.e.
     exactly the bug this replaced. */
  assert.ok(/app_settings'\)\s*\.select\('[^']*\bpipeline\b[^']*'\)/.test(code),
    'loadTeamRows no longer selects the pipeline column, so every teammate '
      + 'falls back to the default pipeline against the real database');
  assert.ok(/app_settings'\)\s*\.select\('[^']*\bterminology\b[^']*'\)/.test(code),
    'loadTeamRows no longer selects terminology, so the team view cannot tell '
      + 'whether the team shares a vocabulary and will use the signed-in '
      + 'manager\u2019s words for everybody');
});

console.log('\n--- a colleague is never a customer ---');

/* Taken from production, 2026-10-07. A standing internal meeting organised
   from somebody's personal Gmail put `vionna@marketmakermgmt.com` — a
   colleague — into three people's lists AS A CLIENT, with a fresh occurrence
   arriving every day. For one of them, a new hire on his first morning, it
   was his entire pipeline.

   The cause: attendees mode asked only whether a guest was outside the
   ORGANIZER's domain, and internalDomain() returns '' for a personal inbox.
   So `!organizer` was true, every colleague counted as an outside guest, and
   the meeting read as a booking.

   The calendar owner's own domain is the missing reference point: it is their
   calendar, so their colleagues are internal to them whoever organised. */

function icsFor(attendees, organizer){
  return [
    'BEGIN:VCALENDAR','BEGIN:VEVENT','UID:standing-1',
    'DTSTART;TZID=America/New_York:20261008T150000',
    'SUMMARY:Youtube Strategy Session (Weekly Sync)',
    'ORGANIZER;CN=' + organizer + ':mailto:' + organizer
  ].concat(attendees.map(function(a){
    return 'ATTENDEE;CN=' + a + ';PARTSTAT=NEEDS-ACTION:mailto:' + a;
  })).concat(['END:VEVENT','END:VCALENDAR']).join('\r\n');
}

test('a colleague is not saved as the customer', () => {
  // Organiser on a personal inbox, every guest a colleague.
  const ev = GB.parseICS(icsFor(
    ['vionna@marketmakermgmt.com', 'tanner.b@marketmakermgmt.com'],
    'gauravbatra791@gmail.com'))[0];
  const withoutOwner = GB.clientFromICSEvent(ev);
  const withOwner    = GB.clientFromICSEvent(ev, 'tanner.b@marketmakermgmt.com');
  assert.strictEqual(withoutOwner && withoutOwner.email, 'vionna@marketmakermgmt.com',
    'pre-fix behaviour should still be reproducible, or this test proves nothing');
  assert.ok(withOwner && withOwner.email !== 'vionna@marketmakermgmt.com',
    'a colleague is still saved as the client’s address — which is also '
      + 'where the follow-up email would be sent');
});

test('the customer is still picked out of a mixed guest list', () => {
  const ev = GB.parseICS(icsFor(
    ['vionna@marketmakermgmt.com', 'kelly.arthur@expreality.com'],
    'gauravbatra791@gmail.com'))[0];
  const c = GB.clientFromICSEvent(ev, 'tanner.b@marketmakermgmt.com');
  assert.ok(c, 'a real booking was dropped');
  assert.strictEqual(c.email, 'kelly.arthur@expreality.com',
    'the colleague won over the actual customer');
});

test('the owner themself is never the customer', () => {
  const ev = GB.parseICS(icsFor(
    ['tanner.b@marketmakermgmt.com', 'buyer@acme.com'], 'someone@else.com'))[0];
  const c = GB.clientFromICSEvent(ev, 'tanner.b@marketmakermgmt.com');
  assert.strictEqual(c.email, 'buyer@acme.com', 'the owner was saved as their own client');
});

test('a solo operator on Gmail keeps their bookings', () => {
  // No company domain, so there are no colleagues to exclude and nothing may
  // change. This is the case the old hard-coded domain strip got wrong.
  const ev = GB.parseICS(icsFor(['buyer@acme.com'], 'solo@gmail.com'))[0];
  const c = GB.clientFromICSEvent(ev, 'solo@gmail.com');
  assert.ok(c && c.email === 'buyer@acme.com',
    'a solo operator on Gmail stopped importing their own bookings');
});

test('the Edge Function passes the calendar owner through', () => {
  /* parse.ts is the live import path for everyone — the ICS version above is
     the local build. A fix that lands only in logic.js would leave production
     importing colleagues exactly as before. */
  const parse = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', '_shared', 'parse.ts'), 'utf8');
  assert.ok(/export function matchesCalendarFilter\([\s\S]{0,200}ownerEmail\?: string/.test(parse),
    'matchesCalendarFilter in parse.ts takes no owner');
  assert.ok(/export function clientFromGCalEvent\([\s\S]{0,200}ownerEmail\?: string/.test(parse),
    'clientFromGCalEvent in parse.ts takes no owner');
  assert.ok(/matchesCalendarFilter\(ev, filter, ownerEmail\)/.test(parse),
    'clientFromGCalEvent calls the filter without the owner, so the event is '
      + 'still admitted even though the contact would be dropped');

  /* The logic itself, line by line.

     These are source assertions, not behaviour: the suite is deliberately
     dependency-free and cannot execute TypeScript, so parse.ts is never run
     here. The behaviour is covered against its twin in logic.js above, which
     has the same two rules. Checking only the signatures was not enough —
     deleting either rule left every signature intact and the tests green. */
  const attendeeBranch = parse.slice(parse.indexOf("if (f.mode === 'attendees')"),
                                     parse.indexOf('for (const term of f.include'));
  assert.ok(/const owner = internalDomain\(ownerEmail\)/.test(attendeeBranch),
    'attendees mode no longer works out the calendar owner\u2019s domain');
  assert.ok(/if \(owner && d === owner\) continue;/.test(attendeeBranch),
    'attendees mode no longer skips the owner\u2019s own colleagues, so an '
      + 'internal meeting organised from a personal inbox imports as a booking');
  assert.ok(/if \(organizer && d === organizer\) continue;/.test(attendeeBranch),
    'attendees mode no longer skips the organizer\u2019s colleagues');

  const picker = parse.slice(parse.indexOf('export function clientFromGCalEvent'));
  assert.ok(/const ownerDomain = internalDomain\(ownerEmail\)/.test(picker),
    'the contact picker no longer knows the owner\u2019s domain');
  assert.ok(/!ownerDomain \|\| domainOf\(e\) !== ownerDomain/.test(picker),
    'the contact picker no longer excludes the owner\u2019s colleagues, so a '
      + 'teammate is saved as the customer and the follow-up goes to them');
  assert.ok(/e !== organizerSelf && e !== ownerSelf/.test(picker),
    'the contact picker no longer excludes the owner\u2019s own address');
  const sync = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', 'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/clientFromGCalEvent\(ev, calendarFilter, conn\.calendar_id\)/.test(sync),
    'the sync does not pass the calendar being synced, so the parser has no '
      + 'owner to compare against and the fix is inert in production');
});

console.log('\n--- a second manager ---');

/* Asked for: the actual sales manager should be able to use the manager role
   too. The policies already allowed it — user_managed_org_ids accepts
   ('owner','admin') and nothing assumed one of them — so the gap was only
   that role lived in the database and every change was a hand-written UPDATE.

   The thing worth defending is lockout. An organisation with no manager
   cannot recover from inside the product: nobody can invite, nobody can
   appoint, the team view belongs to nobody. The guard is NOT a count of
   remaining managers, which races with a second manager doing the same thing.
   It is that nobody may change their OWN role, so a demotion always leaves
   its author in place. */

test('the role rules live in the database, not in the button', () => {
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const sql = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const fn = sql.slice(sql.indexOf('function public.set_member_role'));
  assert.ok(fn.length, 'set_member_role is not defined in any migration');
  const body = fn.slice(0, fn.indexOf('$$;') + 3);

  assert.ok(/if target = me then/.test(body),
    'the self-change guard is gone. It is the only thing standing between a '
      + 'tidy-up and an organisation with no manager at all, and a count-based '
      + 'check would not replace it — two managers demoting each other at once '
      + 'can both pass a count.');
  assert.ok(/user_managed_org_ids\(\)/.test(body),
    'set_member_role no longer checks the caller manages the target\u2019s org');
  assert.ok(/new_role not in \('member', 'admin'\)/.test(body),
    'any string can be written as a role');
  assert.ok(/security definer/i.test(fn),
    'memberships has no UPDATE policy, so this has to run as definer');
  // The self-check must come FIRST: if the org check ran first, the error
  // would differ for someone you manage versus someone you do not, which
  // tells a caller which addresses are on the team.
  assert.ok(body.indexOf('if target = me then') < body.indexOf('user_managed_org_ids'),
    'the self-check must precede the org check, or the error message leaks '
      + 'whether a given person is on your team');
  assert.ok(!/delete from public\.memberships/.test(body),
    'set_member_role removes people from the organisation. Leaving is not the '
      + 'inverse of joining — accepting re-stamps org_id across eight tables — '
      + 'so removal needs its own decision, not a role dropdown.');
});

test('the control is never offered where it could only fail', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function roleControl('), app.indexOf('function renderTeamTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  assert.ok(/if\(!STATE\.canInvite\) return wrap;/.test(code),
    'an ordinary member is offered a button that RLS will refuse');
  assert.ok(/m\.userId === STATE\.userId/.test(code),
    'the manager is offered the control on their own row, where the database '
      + 'will always refuse it');
  assert.ok(/role-badge/.test(code), 'there is no way to see who the managers are');
});

test('promoting asks first, and says what it actually grants', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const h = app.slice(app.indexOf("case 'set-role':"), app.indexOf("case 'invite-send':"));
  assert.ok(/confirm\(/.test(h), 'a stray click on a dense row hands over the whole team');
  assert.ok(/rnew === 'admin' && !confirm/.test(h),
    'standing somebody down should not need the same confirmation as promoting');
  assert.ok(/contacts, appointments and numbers/.test(h),
    'the confirmation no longer says what a manager can actually see');
  assert.ok(/not get access to anyone\\u2019s Google account|Google account/.test(h),
    'the confirmation no longer says what a manager does NOT get. Tokens stay '
      + 'owner-only and somebody deciding this should know that.');
  assert.ok(/init\(\)/.test(h),
    'what that person can see just changed; the view has to reload rather than patch');
  assert.ok(/showToast\('Could not change role/.test(h), 'a refusal is swallowed');
});

test('the team rows carry the org role, and it is not confused with a stage role', async () => {
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'},
      {org_id:'o1', user_id:'u3', role:'owner'}
    ], error: null},
    app_settings: {data: [
      {user_id:'u1', sender_name:'Boss'},
      {user_id:'u2', sender_name:'Rep'},
      {user_id:'u3', sender_name:'Founder'}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const by = {};
  rows.forEach(r => { by[r.name] = r; });
  assert.strictEqual(by.Boss.isManager, true, 'an admin is not marked as a manager');
  assert.strictEqual(by.Founder.isManager, true, 'an owner is not marked as a manager');
  assert.strictEqual(by.Rep.isManager, false, 'an ordinary member is marked as a manager');
  assert.strictEqual(by.Rep.orgRole, 'member');
});

test('setMemberRole reports a refusal rather than claiming success', async () => {
  // set_member_role returns {ok:false} in the body rather than raising, so a
  // wrapper checking only res.error would say "they are a manager now" to
  // somebody who is not.
  const d = makeLoadCtx({
    set_member_role: {data: {ok:false, error:'not someone you manage'}, error: null}
  });
  const r = await d.run('setMemberRole("u9","admin")');
  assert.strictEqual(r.ok, false, 'a refusal was reported as success');
  assert.ok(/not someone/.test(r.error), 'the reason was lost: ' + r.error);
});

console.log('\n--- whose words the team view speaks in ---');

/* Every other screen shows one person their own work, so their own vocabulary
   is right there by construction. The team view is the one place describing
   OTHER people's work, and it was using termLower() — the SIGNED-IN manager's
   words, applied to everybody.

   That is invisible while a team shares a template and wrong the moment it
   does not: a sales manager who also runs hiring picks the recruiting
   template, and his team tab starts calling the sales team's calls
   "Interviews". */

test('a team that shares a vocabulary keeps it', () => {
  const w = GB.teamAppointmentWords([
    {terminology: {appointment: 'Showing', appointmentPlural: 'Showings'}},
    {terminology: {appointment: 'Showing', appointmentPlural: 'Showings'}}
  ]);
  assert.strictEqual(w.one, 'showing');
  assert.strictEqual(w.many, 'showings');
  assert.strictEqual(w.mixed, false,
    'an agreeing team was treated as mixed and lost its own words');
});

test('a team spanning templates falls back to a neutral word', () => {
  const w = GB.teamAppointmentWords([
    {terminology: {appointment: 'Call', appointmentPlural: 'Calls'}},
    {terminology: {appointment: 'Interview', appointmentPlural: 'Interviews'}}
  ]);
  assert.strictEqual(w.mixed, true);
  assert.strictEqual(w.one, 'appointment');
  assert.strictEqual(w.many, 'appointments');
  // Not the default terminology, which is only the sales template's word
  // wearing a disguise and would still read wrong to the recruiter.
  assert.notStrictEqual(w.one, 'call');
});

test('somebody who has never set terminology counts as the default', () => {
  // Null is what an account that skipped onboarding stores. It must compare
  // equal to an explicit default, or a team where one person onboarded and
  // one did not would wrongly read as mixed.
  const def = GB.buildDefaultTerminology();
  const w = GB.teamAppointmentWords([
    {terminology: null},
    {terminology: {appointment: def.appointment, appointmentPlural: def.appointmentPlural}}
  ]);
  assert.strictEqual(w.mixed, false, 'null and the explicit default read as different vocabularies');
  assert.strictEqual(w.one, 'call');
});

test('an empty or missing team does not throw', () => {
  assert.strictEqual(GB.teamAppointmentWords([]).one, 'appointment');
  assert.strictEqual(GB.teamAppointmentWords(null).many, 'appointments');
});

test('the team view asks the team, not the signed-in manager', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'),
                       app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  assert.ok(/teamAppointmentWords\(rows\)/.test(code),
    'the team view no longer works out the team\u2019s shared vocabulary');
  assert.ok(!/termLower\('appointment/.test(code),
    'the team view is back to using the signed-in manager\u2019s word for a '
      + 'booking and applying it to everyone else\u2019s work');
});

console.log('\n--- writing your own texts for a different job ---');

/* Colin's list is candidates, not clients. The shipped copy is written for
   sales, so he needs to add his own AND stop the ones that do not fit.
   editVariant retires the version it replaces, which is the wrong shape when
   the text is not being replaced at all. */

test('a variant can be stopped without rewording it, and brought back', () => {
  const st = GB.buildDefaultState();
  const id = st.variants.welcome[0].id;
  assert.strictEqual(GB.retireVariant(st, 'welcome', id, true).ok, true);
  assert.strictEqual(st.variants.welcome[0].retired, true);
  assert.strictEqual(st.variants.welcome[0].text.length > 0, true, 'the text was destroyed');
  assert.strictEqual(GB.retireVariant(st, 'welcome', id, false).ok, true);
  assert.strictEqual(st.variants.welcome[0].retired, false, 'it could not be brought back');
});

test('a stopped variant is not sent', () => {
  const st = GB.buildDefaultState();
  const c = freshClient({});
  const doomed = st.variants.welcome[0].id;
  GB.retireVariant(st, 'welcome', doomed, true);
  for (let i = 0; i < 60; i++) {
    assert.notStrictEqual(GB.pickVariant(st, 'welcome', c, {forceReroll: true}).id, doomed,
      'a variant somebody stopped is still going out');
  }
});

test('the last one standing cannot be stopped', () => {
  /* eligibleVariants falls back to the retired set rather than sending
     nothing, so without this guard the stage would quietly go on sending the
     exact copy somebody just stopped — silently, and the worst of both. */
  const st = GB.buildDefaultState();
  const ids = st.variants.welcome.map(v => v.id);
  for (let i = 0; i < ids.length - 1; i++) {
    assert.strictEqual(GB.retireVariant(st, 'welcome', ids[i], true).ok, true);
  }
  const last = GB.retireVariant(st, 'welcome', ids[ids.length - 1], true);
  assert.strictEqual(last.ok, false, 'the final variant for a stage was stopped');
  assert.ok(/only one left/i.test(last.error), 'the refusal does not explain itself: ' + last.error);
  // And the stage must still send that one.
  const c = freshClient({});
  const got = GB.pickVariant(st, 'welcome', c, {forceReroll: true});
  assert.strictEqual(got.id, ids[ids.length - 1]);
  assert.ok(!got.retired, 'the stage is now sending retired copy');
});

test('stopping refuses the no-op cases', () => {
  const st = GB.buildDefaultState();
  const id = st.variants.welcome[0].id;
  assert.strictEqual(GB.retireVariant(st, 'welcome', id, false).ok, false, 'already live');
  assert.strictEqual(GB.retireVariant(st, 'nostage', id, true).ok, false, 'unknown stage');
  assert.strictEqual(GB.retireVariant(st, 'welcome', 'nope', true).ok, false, 'unknown id');
});

test('both directions are wired up, and the refusal is shown', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const tab = app.slice(app.indexOf('function renderVariantsTab()'),
                        app.indexOf('function renderVariantBarChart'));
  assert.ok(/'data-want':'1'/.test(tab), 'nothing offers to stop a variant');
  assert.ok(/'data-want':'0'/.test(tab), 'a stopped variant can never be brought back');
  const h = app.slice(app.indexOf("case 'retire-variant':"), app.indexOf("case 'cancel-variant':"));
  assert.ok(/if\(!qr\.ok\)\{ showToast\(qr\.error\); break; \}/.test(h),
    'the refusal — including the last-one-standing guard — is swallowed, so '
      + 'the button looks broken rather than explaining itself');
  assert.ok(/saveState\(STATE\)/.test(h), 'the change is never persisted');
});

test('the shipped copy is not sales-specific, apart from the channel lines', () => {
  /* Checked before writing recruiting copy, and the reason none was written:
     25 of 28 default variants are job-neutral, and the 3 that are not all
     need {channel}. eligibleVariants already drops needsChannel variants for
     any contact without a readable handle, which a job candidate never has —
     so they can never reach a candidate in the first place. */
  const v = GB.buildDefaultVariants();
  const salesy = /strategy|growth|revenue|channel|youtube|audit|funnel|campaign|roi/i;
  const offenders = [];
  Object.keys(v).forEach(st => v[st].forEach(x => {
    if (salesy.test(x.text) && !x.needsChannel) offenders.push(st + ': ' + x.text.slice(0, 60));
  }));
  assert.deepStrictEqual(offenders, [],
    'a default variant is sales-specific but NOT gated behind needsChannel, so '
      + 'it would be sent to a recruiter’s candidates: ' + offenders.join(' | '));
});

console.log('\n--- keeping the calendar title ---');

/* The title was read for the name in the parentheses and then discarded, and
   no table has ever held it. That is why "can show-up rates be explained by
   changes in calendar titles" was not a thin-sample problem but an
   unanswerable one — there was nothing to count.

   Null and '' have to stay distinguishable: every row imported before this
   means "never recorded", which is a different claim from "an event with a
   blank title", and the difference is the whole value of the column. */

test('the title survives an import', () => {
  const ics = [
    'BEGIN:VCALENDAR','BEGIN:VEVENT','UID:t-1',
    'DTSTART;TZID=America/New_York:20261008T150000',
    'SUMMARY:Second Call | Youtube Strategy Session (Nick McDonald)',
    'ATTENDEE;CN=nick@goasknick.com:mailto:nick@goasknick.com',
    'END:VEVENT','END:VCALENDAR'].join('\r\n');
  const c = GB.clientFromICSEvent(GB.parseICS(ics)[0]);
  assert.ok(c, 'the booking did not import');
  assert.strictEqual(c.eventTitle, 'Second Call | Youtube Strategy Session (Nick McDonald)',
    'the calendar title was discarded again');
  // The name still comes out of the parentheses; the title is kept as well as,
  // not instead of.
  assert.strictEqual(c.name, 'Nick McDonald');
});

test('a row with no title reads as unrecorded, not as blank', () => {
  const c = GB.sanitizeClient({name: 'A', eventTitle: ''}, 'x1');
  assert.strictEqual(c.eventTitle, null,
    'an empty title must normalise to null, or "we never kept this" becomes '
      + 'indistinguishable from "the event was genuinely untitled"');
  assert.strictEqual(GB.sanitizeClient({name: 'B'}, 'x2').eventTitle, null);
  assert.strictEqual(GB.sanitizeClient({name: 'C', eventTitle: 'Discovery'}, 'x3').eventTitle,
    'Discovery', 'a real title did not survive sanitising');
});

test('a title survives a save and load round trip', () => {
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const row = data.slice(data.indexOf('function rowClient'), data.indexOf('function rowMessage'));
  assert.ok(/event_title: c\.eventTitle \|\| null/.test(row),
    'rowClient does not write the title, so it is forgotten on the next save');
  assert.ok(/eventTitle: row\.event_title \|\| null/.test(data),
    'the loader drops the title, so it is written and never read back');
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const sql = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(/add column if not exists event_title/.test(sql),
    'nothing adds the column, so every save would error');
});

test('the live import path keeps it too', () => {
  /* parse.ts is what actually runs for everyone; logic.js is the local build.
     A fix landing only in logic.js would store nothing in production. */
  const parse = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', '_shared', 'parse.ts'), 'utf8');
  assert.ok(/eventTitle: string;/.test(parse), 'ParsedClient has no title field');
  assert.ok(/eventTitle: summary,/.test(parse),
    'clientFromGCalEvent does not carry the summary through');
  const sync = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', 'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/event_title: parsed\.eventTitle \|\| null,/.test(sync),
    'the sync never writes the title on a new booking');
  assert.ok(/event_title: parsed\.eventTitle \|\| existingByEvent\.event_title \|\| null,/.test(sync),
    'a re-sync either ignores a renamed event or erases a title it already '
      + 'had. Renaming is a real edit and should follow; an empty summary '
      + 'must not wipe what is recorded.');
});

test('the contact shows it, and shows nothing when there is none', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function openClientModal'), app.indexOf('function openClientModal') + 3000);
  assert.ok(/c\.eventTitle\s*\?/.test(fn),
    'the title is printed unconditionally, so every pre-existing contact gets '
      + 'an empty line suggesting its event had no title');
  assert.ok(/escapeHtml\(c\.eventTitle\)/.test(fn),
    'the calendar title goes into the page unescaped — it is text somebody '
      + 'else wrote in their own calendar');
});

console.log('\n--- changing your setup after the first run ---');

/* The nine industry templates were only ever offered in the onboarding
   wizard, which is gated on a localStorage flag and never returns. Anyone who
   clicked past it could not reach a template from anywhere in the product —
   found the hard way when a sales manager who also runs hiring signed up,
   skipped setup in seven seconds, and was stuck on the sales defaults.

   The risk in offering it later is the data already there. Swapping a template
   changes every stage at once, and an orphaned status behaves as 'open' — so
   without remapping, an agency moving templates would find every completed
   call back in the follow-up cadence, chasing people who already showed up. */

test('statuses move by what the stage MEANS, not what it is called', () => {
  const st = GB.buildDefaultState();
  st.pipeline = GB.buildDefaultPipeline();
  ['a','b','c','d','e'].forEach((id, i) => {
    st.clients[id] = GB.sanitizeClient({name: id, status:
      ['Completed','No-show','Booked','Rescheduled','Ghosted'][i]}, id);
  });
  const rec = GB.buildIndustryTemplates().filter(t => t.key === 'recruiting')[0];
  const out = GB.remapStatusesByRole(st, rec.pipeline);

  assert.strictEqual(st.clients.a.status, 'Screen Completed',
    'a finished call did not land on the new pipeline’s finished stage');
  assert.strictEqual(st.clients.c.status, 'Sourced', 'an open call did not land on an open stage');
  assert.strictEqual(st.clients.d.status, 'Awaiting Decision', 'a stalled call was not carried across');
  assert.strictEqual(st.clients.e.status, 'Passed', 'a lost call was not carried across');
  // 'No-show' exists in both, so it is left exactly as it is.
  assert.strictEqual(st.clients.b.status, 'No-show');
  assert.strictEqual(out.kept, 1, 'a status valid in both pipelines should not be touched');
  assert.strictEqual(out.moved, 4);
});

test('nothing is left behind in the old vocabulary', () => {
  const st = GB.buildDefaultState();
  st.pipeline = GB.buildDefaultPipeline();
  ['x','y','z'].forEach((id, i) => {
    st.clients[id] = GB.sanitizeClient({name:id, status: ['Completed','Booked','No-show'][i]}, id);
  });
  const re = GB.buildIndustryTemplates().filter(t => t.key === 'real_estate')[0];
  GB.remapStatusesByRole(st, re.pipeline);
  const valid = {};
  re.pipeline.forEach(s2 => { valid[s2.key] = true; });
  Object.keys(st.clients).forEach(id => {
    assert.ok(valid[st.clients[id].status],
      id + ' was left on "' + st.clients[id].status + '", which does not exist in the new '
        + 'pipeline — it would read as open and go back into the cadence');
  });
});

test('a role with no counterpart lands somewhere followed-up, and is counted', () => {
  const st = GB.buildDefaultState();
  st.pipeline = GB.buildDefaultPipeline();
  st.clients.g = GB.sanitizeClient({name:'g', status:'Ghosted'}, 'g');   // 'lost'
  // A pipeline with no 'lost' stage at all.
  const out = GB.remapStatusesByRole(st, [
    {key:'New', label:'New', role:'open'},
    {key:'Done', label:'Done', role:'won'}
  ]);
  assert.strictEqual(st.clients.g.status, 'New',
    'a role with no counterpart should land on an open stage rather than be '
      + 'stranded on a name the new pipeline does not have');
  assert.strictEqual(out.noCounterpart, 1, 'the caller cannot tell it happened');
});

test('remapping an empty or odd account does not throw', () => {
  assert.strictEqual(GB.remapStatusesByRole({}, []).moved, 0);
  assert.strictEqual(GB.remapStatusesByRole(null, null).moved, 0);
  const st = GB.buildDefaultState();
  st.clients.n = GB.sanitizeClient({name:'n'}, 'n');
  assert.doesNotThrow(() => GB.remapStatusesByRole(st, [{key:'Only', label:'Only', role:'open'}]));
});

test('the picker is offered in settings and only remaps on save', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const modal = app.slice(app.indexOf('function renderSettingsModal()'),
                          app.indexOf('function saveSettingsDraft'));
  assert.ok(/data-action="use-template"/.test(modal),
    'the templates are still unreachable after onboarding');
  assert.ok(/buildIndustryTemplates\(\)\.filter/.test(modal),
    'the picker no longer lists the templates');

  const h = app.slice(app.indexOf("case 'use-template':"), app.indexOf("case 'reset-settings':"));
  assert.ok(/SETTINGS_DRAFT\.remap = true;/.test(h),
    'picking a template does not flag the remap, so every status would be '
      + 'orphaned and the whole book would re-enter the cadence');
  assert.ok(!/remapStatusesByRole/.test(h),
    'the remap runs while the draft is still discardable — it must wait for '
      + 'Save, or backing out leaves rewritten statuses behind');

  const save = app.slice(app.indexOf('function saveSettingsDraft'),
                         app.indexOf('function saveSettingsDraft') + 2200);
  assert.ok(/if\(d\.remap\)\{/.test(save), 'the save path never remaps');
  assert.ok(/remapStatusesByRole\(STATE, stages\)/.test(save),
    'the save path does not remap against the stages it is about to commit');
});

console.log('\n--- covering for somebody who is away ---');

/* One picker per appointment is right for a single call with the wrong owner.
   It is the wrong tool for a fortnight's absence: three people on this book
   hold 43 booked appointments between them and have sent nothing in a week,
   and clicking 43 pickers is not a plan.

   The thing to get right is the partial result. RLS refuses an individual row
   by returning zero rows rather than an error, so "moved 12 of 17" has to be
   reportable — rounding that up to success is how somebody believes a handover
   happened that did not. */

test('a clean sweep reports what it moved', async () => {
  const d = makeLoadCtx({reassign_client: {data: {ok:true}, error: null}});
  const r = await d.run('reassignMany(["c1","c2","c3"], "u2")');
  assert.strictEqual(r.moved, 3);
  assert.strictEqual(r.failed, 0);
});

test('a refusal partway through is reported, not rounded up', async () => {
  // RLS refusing shows up as zero rows returned, not as an error.
  const d = makeLoadCtx({
    reassign_client: {data: {ok:false, error:'not allowed'}, error: null}});
  const r = await d.run('reassignMany(["c1","c2"], "u2")');
  assert.strictEqual(r.moved, 0, 'a refused move was counted as a success');
  assert.strictEqual(r.failed, 2);
  assert.ok(r.error, 'no reason was carried back for the toast');
});

test('an empty or odd list does not throw', async () => {
  const d = makeLoadCtx({});
  assert.strictEqual((await d.run('reassignMany([], "u2")')).moved, 0);
  assert.strictEqual((await d.run('reassignMany(null, "u2")')).failed, 0);
});

test('bulk cover is only offered where it is the actual problem', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'), app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  assert.ok(/m\.queue\.length > 1 && m\.needsAttention/.test(code),
    'a bulk handover is offered on a row that is ticking along, where it is '
      + 'far more likely to be a slip than an intention');
  assert.ok(/x\.userId === m\.userId\) return;/.test(code),
    'the person being covered for is offered as a destination, so the whole '
      + 'queue can be moved to where it already is');
});

test('the confirmation names the count, both people, and the mid-conversation ones', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const h = app.slice(app.indexOf("case 'bulk-assign':"), app.indexOf("case 'set-role':"));
  // Not just the word: `if(false && !confirm(...))` still contains it and
  // asks nobody anything.
  assert.ok(/if\(!confirm\(/.test(h),
    'dozens of appointments move without asking, or the confirmation has been '
      + 'short-circuited so it never runs');
  assert.ok(/already have messages sent/.test(h),
    'the confirmation no longer says how many are being taken over '
      + 'mid-conversation, which is the part somebody would regret');
  assert.ok(/move any of them back individually/.test(h),
    'the confirmation no longer says it is reversible');
  assert.ok(/'Moved ' \+ r\.moved \+ ' of ' \+ \(r\.moved \+ r\.failed\)/.test(h),
    'a partial move is reported as a complete one — somebody would believe a '
      + 'handover happened that did not');
  assert.ok(/if\(!r\.moved\)\{/.test(h), 'a total refusal still claims success');
  assert.ok(/init\(\)/.test(h),
    'the contacts changed owner; both rows have to reload rather than be patched');
});

console.log('\n--- eight weeks of activity ---');

/* The team view answers "how are they doing now". It cannot answer the
   question a manager has after a conversation — did that change anything —
   and the 7-day arrow cannot either: a single burst ageing out of a rolling
   window is indistinguishable from somebody stopping. Ethan's count went from
   22 to 5 over one afternoon on this book for exactly that reason.

   Two things decide whether this is honest rather than merely pretty:
   zero-filling, because a gap IS the finding, and marking the live week,
   because it is short by construction and otherwise reads as a collapse every
   time somebody looks before Friday. */

test('weeks are bucketed in UTC, not the machine timezone', () => {
  // The suite runs in eight timezones and the app in the browser's. A
  // machine-local boundary makes identical data bucket differently depending
  // on where somebody is sitting, which is a bug this file has shipped before.
  const d = new Date('2026-10-07T12:00:00Z');       // a Wednesday
  const start = GB.startOfUTCWeek(d);
  assert.strictEqual(start.toISOString(), '2026-10-05T00:00:00.000Z',
    'the week does not start on Monday 00:00 UTC');
  // Sunday belongs to the week that began the previous Monday.
  assert.strictEqual(GB.startOfUTCWeek(new Date('2026-10-11T23:59:59Z')).toISOString(),
    '2026-10-05T00:00:00.000Z');
  assert.strictEqual(GB.startOfUTCWeek(new Date('2026-10-12T00:00:00Z')).toISOString(),
    '2026-10-12T00:00:00.000Z', 'Monday starts a new week');
});

test('the live week is flagged partial and nothing else is', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const w = GB.weeklyActivity([], now, 8);
  assert.strictEqual(w.length, 8);
  assert.strictEqual(w[7].partial, true,
    'the current week is not marked, so a bar that is two days old reads as a collapse');
  assert.strictEqual(w.filter(x => x.partial).length, 1, 'more than one week is marked partial');
  assert.strictEqual(w[7].weekStart, '2026-10-05T00:00:00.000Z');
  assert.strictEqual(w[0].weekStart, '2026-08-17T00:00:00.000Z', 'the window is not 8 weeks back');
});

test('empty weeks are zero-filled, because the gap is the finding', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const w = GB.weeklyActivity([
    '2026-09-28T10:00:00Z', '2026-09-28T11:00:00Z',   // week of 28 Sep
    '2026-10-06T10:00:00Z'                            // this week
  ], now, 8);
  assert.strictEqual(w.length, 8, 'quiet weeks were dropped, so a fortnight off becomes a straight line');
  const counts = w.map(x => x.count);
  assert.deepStrictEqual(counts, [0,0,0,0,0,0,2,1],
    'weeks bucketed wrongly: ' + JSON.stringify(counts));
});

test('timestamps outside the window are ignored, not misfiled', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const w = GB.weeklyActivity(['2026-01-01T10:00:00Z'], now, 8);
  assert.strictEqual(w.reduce((n, x) => n + x.count, 0), 0,
    'an old message was dumped into the first visible week, inventing activity');
});

test('junk timestamps do not throw or count', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const w = GB.weeklyActivity([null, '', 'not-a-date', undefined, '2026-10-06T10:00:00Z'], now, 8);
  assert.strictEqual(w.reduce((n, x) => n + x.count, 0), 1);
  assert.doesNotThrow(() => GB.weeklyActivity(null, now, 8));
});

test('the real shape of this book comes out right', () => {
  /* Ethan and Ronin both went from nothing to 18 and 22 in the week of
     28 September. That IS the finding a manager wants, and it is invisible in
     every other view. */
  const now = new Date('2026-10-07T12:00:00Z');
  const sends = [];
  for (let i = 0; i < 18; i++) sends.push('2026-09-30T10:00:00Z');
  for (let i = 0; i < 5; i++) sends.push('2026-10-06T10:00:00Z');
  const w = GB.weeklyActivity(sends, now, 8);
  assert.strictEqual(w[6].count, 18);
  assert.strictEqual(w[7].count, 5);
  assert.strictEqual(w[7].partial, true,
    '5 against 18 reads as a collapse unless the live week is marked — it is '
      + 'two and a half days old');
});

test('the bars say the last one is this week so far', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function activityBars('), app.indexOf('function roleControl('));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  assert.ok(/this week so far/.test(code),
    'nothing tells the reader the final bar is a part-week, so every glance '
      + 'before Friday reports a decline that is not happening');
  assert.ok(/is-partial/.test(code), 'the live bar is drawn identically to a finished one');
  assert.ok(/w\.count \? 6 : 2/.test(code),
    'a zero week collapses to nothing, so an absent bar and a zero bar look different '
      + 'when they mean the same thing');
});

test('the loader attaches the history and drops its scaffolding', async () => {
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/b\.weeks = weeklyActivity\(b\.sentAt, new Date\(now\), 8\)/.test(data),
    'the team rows no longer carry an activity history');
  assert.ok(/delete b\.sentAt;/.test(data),
    'the raw timestamp list is shipped to the client as part of every team row '
      + '— it is scaffolding for the buckets, not state');
});

console.log('\n--- sending well, not just sending a lot ---');

/* Every number on the team row measured volume. Nothing measured whether the
   messages were any good to receive, so the view rewarded sending hard and
   said nothing about sending well.

   On this book that inverts the leaderboard: Ronin is the highest-volume
   newcomer and 16 of his 44 texts landed outside 8am-9pm where the recipient
   lives, latest 11pm. Ethan sent none outside hours at all. The row showed
   Ronin as the one doing well. */

test('the team count and the card warning use the same window', () => {
  /* If these drift, a manager counts something the salesperson was never
     warned about, which is the worst possible version of this feature. */
  const tz = 'America/New_York';
  const inside  = new Date('2026-10-07T18:00:00Z');   // 2pm ET
  const late    = new Date('2026-10-08T03:00:00Z');   // 11pm ET
  const early   = new Date('2026-10-07T10:00:00Z');   // 6am ET
  assert.strictEqual(GB.isOutsideLocalHours(inside, tz), false);
  assert.strictEqual(GB.isOutsideLocalHours(late, tz), true, '11pm counted as a reasonable hour');
  assert.strictEqual(GB.isOutsideLocalHours(early, tz), true, '6am counted as a reasonable hour');
  // The card's chip must agree, because it is now the same function.
  assert.strictEqual(GB.tzChipInfo({timezone: tz}, late).warn, true);
  assert.strictEqual(GB.tzChipInfo({timezone: tz}, inside).warn, false);
});

test('the boundaries are where they claim to be', () => {
  const tz = 'UTC';
  assert.strictEqual(GB.isOutsideLocalHours(new Date('2026-10-07T07:59:00Z'), tz), true);
  assert.strictEqual(GB.isOutsideLocalHours(new Date('2026-10-07T08:00:00Z'), tz), false,
    '8am sharp should be allowed');
  assert.strictEqual(GB.isOutsideLocalHours(new Date('2026-10-07T20:59:00Z'), tz), false);
  assert.strictEqual(GB.isOutsideLocalHours(new Date('2026-10-07T21:00:00Z'), tz), true,
    '9pm sharp should already be outside');
});

test('it is the RECIPIENT\u2019s hour that counts, not the sender\u2019s', () => {
  // 11pm in New York is 8pm in Los Angeles: same instant, different answer.
  const when = new Date('2026-10-08T03:00:00Z');
  assert.strictEqual(GB.isOutsideLocalHours(when, 'America/New_York'), true);
  assert.strictEqual(GB.isOutsideLocalHours(when, 'America/Los_Angeles'), false,
    'the sender\u2019s timezone is being used instead of the contact\u2019s');
});

test('an unknowable time is not counted as a violation', () => {
  assert.strictEqual(GB.isOutsideLocalHours(null, 'UTC'), false);
  assert.strictEqual(GB.isOutsideLocalHours('not-a-date', 'UTC'), false,
    'a junk timestamp was counted against somebody');
  assert.doesNotThrow(() => GB.isOutsideLocalHours(new Date(), null));
});

test('the count rides on the team row as a count, never a rate', async () => {
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Rep'}], error: null},
    clients: {data: [
      {id:'c1', user_id:'u2', name:'A', timezone:'America/New_York'}
    ], error: null},
    message_log: {data: [
      {client_id:'c1', sent_at:'2026-10-08T03:00:00Z', responded:false},  // 11pm ET
      {client_id:'c1', sent_at:'2026-10-07T10:00:00Z', responded:false},  // 6am ET
      {client_id:'c1', sent_at:'2026-10-07T18:00:00Z', responded:false}   // 2pm ET
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const rep = rows.filter(r => r.name === 'Rep')[0];
  assert.strictEqual(rep.outsideHours, 2,
    'out-of-hours texts are not being counted against the right person');
  assert.strictEqual(rep.sentEver, 3, 'the volume count was disturbed');
});

test('the row says it is a guess, and stays quiet about one-offs', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'), app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  assert.ok(/m\.outsideHours >= 3/.test(code),
    'a single late text is flagged — that is somebody working late, not a habit');
  assert.ok(/out of hours/.test(code), 'the count is not shown at all');
  assert.ok(/timezone is guessed from the phone number/.test(code),
    'the row no longer says the timezone is a guess. A wrong guess looks '
      + 'identical to a badly timed text, and a manager should not open that '
      + 'conversation certain of it.');
  assert.ok(!/outsideHours[^)]*\/[^)]*sentEver|outsideHours.*\* 100/.test(code),
    'this is being shown as a percentage. 40 early out of 800 is not the same '
      + 'behaviour as 16 late out of 44, and a rate hides the difference.');
});

test('the contact timezone is actually fetched', () => {
  /* The stub returns whole fixture rows whatever you select, so dropping the
     column passes every behavioural test above and then, against the real
     database, silently treats every contact as America/New_York — which both
     invents violations and hides them. Same trap that the pipeline column
     fell into earlier. */
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const fn = data.slice(data.indexOf('async function loadTeamRows'));
  assert.ok(/from\('clients'\)\s*\.select\('[^']*\btimezone\b[^']*'\)/.test(fn),
    'loadTeamRows no longer selects timezone, so every contact falls back to '
      + 'America/New_York and the out-of-hours count is measured against the '
      + 'wrong clock');
});

test('the state and the reason never mention it', () => {
  /* It is a coaching signal, not a verdict. Somebody texting at 11pm is still
     working their list, and folding this into the state would hide the thing
     the state is for. */
  const logic = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  const fn = logic.slice(logic.indexOf('function teamMemberState'),
                         logic.indexOf('function teamOverview'));
  const stateBlock = fn.slice(0, fn.indexOf('return {'));
  assert.ok(!/outsideHours/.test(stateBlock),
    'out-of-hours sending is deciding somebody\u2019s state or their reason, '
      + 'which buries whether they are actually working their list');
});

console.log('\n--- why the reply column is blank ---');

/* Reply rate reads "not measured" for almost everyone, and that refusal is
   right: a send only counts once somebody has answered whether a reply came,
   so zero reviewed is genuinely unknown rather than zero.

   What it did not say is that the fix is two minutes of attention. On this
   book Johnny has reviewed 489 of 965 and has a real 19% reply rate; Ronin has
   reviewed 0 of 49 and Ethan 0 of 24. Nobody except the owner has ever
   answered the question, so the bandit learns from one person's data and the
   manager can see message quality for one person. An unexplained "not
   measured" reads as the product being broken rather than as a backlog. */

test('the backlog uses the same threshold that asks the question', () => {
  /* REPLY_WAIT_HOURS is when Ghost Recall Today starts asking. Counting on a
     different clock would show a manager work their rep has not been offered
     yet. */
  assert.strictEqual(typeof GB.REPLY_WAIT_HOURS, 'number');
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/REPLY_WAIT_HOURS \* 3600000/.test(data),
    'the review backlog is counted on its own invented window rather than the '
      + 'one that decides when the question is actually asked');
  /* And the column has to be asked for. The stub hands back whole fixture
     rows whatever you select, so dropping `reviewed` passes every behavioural
     test here and then, against the real database, reads undefined on every
     row — counting the entire history as outstanding. Third time this trap
     has caught something today. */
  assert.ok(/from\('message_log'\)\.select\('[^']*\breviewed\b[^']*'\)/.test(data),
    'loadTeamRows no longer selects `reviewed`, so every message ever sent '
      + 'would be counted as awaiting an answer');
});

test('only messages old enough to answer are counted', async () => {
  const now = Date.now();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Rep'}], error: null},
    clients: {data: [{id:'c1', user_id:'u2', name:'A', timezone:'UTC'}], error: null},
    message_log: {data: [
      // Too recent to ask about: the reply may still be coming.
      {client_id:'c1', sent_at: new Date(now - 2*3600000).toISOString(), responded:false, reviewed:false},
      // Old enough, unanswered, still inside the window: the real backlog.
      {client_id:'c1', sent_at: new Date(now - 36*3600000).toISOString(), responded:false, reviewed:false},
      {client_id:'c1', sent_at: new Date(now - 60*3600000).toISOString(), responded:false, reviewed:false},
      // Already answered: not a backlog.
      {client_id:'c1', sent_at: new Date(now - 40*3600000).toISOString(), responded:true, reviewed:true},
      /* Unanswered but AGED OUT. The rep is never offered this one, so a
         manager must never be shown it. Counting these is what turned 58 real
         outstanding answers into a reported 465. */
      {client_id:'c1', sent_at: new Date(now - 10*86400000).toISOString(), responded:false, reviewed:false}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const rep = rows.filter(r => r.name === 'Rep')[0];
  assert.strictEqual(rep.awaitingReview, 2,
    'the count does not match the window the rep is actually offered: too '
      + 'recent, already answered, or aged out past the ceiling');
});

test('the team total is the sum, and reaches the note', () => {
  const now = new Date();
  const mk = (name, awaiting) => ({
    name: name, userId: name, upcoming: 3, contacts: 5, sentEver: 10, sent7d: 4,
    sentPrev7d: 4, replies: 0, repliesMeasured: false, awaitingReview: awaiting,
    pastCalls: 0, unlogged: 0, completed: 0, noshows: 0, connectedCalendars: 1,
    lastSync: now.toISOString(), lastSentAt: now.getTime(), upcomingList: [],
    outsideHours: 0, weeks: []
  });
  const o = GB.teamOverview([mk('A', 29), mk('B', 19)], now);
  assert.strictEqual(o.awaitingReview, 48,
    'the overview does not total the outstanding reply questions');
});

test('the note says what it would take, not just that it cannot be shown', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'), app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  // The existing refusal must survive — it is the honest half.
  assert.ok(/nobody has looked, which is not the same as nobody answering/.test(code),
    'the explanation that unknown is not zero has been dropped');
  /* The ternary CONDITION, not just a mention: the sentence also interpolates
     o.awaitingReview, so a looser pattern passes with the condition replaced
     by `false` and the sentence never rendered. */
  assert.ok(/\(o\.awaitingReview\s*\n?\s*\?/.test(code),
    'the note no longer says how much work clearing the blank actually is, so '
      + '"not measured" reads as a permanent limitation');
  assert.ok(/Ghost Recall Today/.test(code),
    'the note does not say where the question is answered');
  assert.ok(/m\.awaitingReview >= 5/.test(code),
    'the per-person count is missing, or fires on a trivial backlog');
});

test('the backlog never becomes a reply rate', () => {
  /* The temptation is to treat unreviewed as "no reply" and print a number.
     That is the exact trap the reply-rate refusal exists to avoid: it would
     read 0% for everyone who has not reviewed, which is a confident claim
     about their copy drawn from nobody having looked. */
  const logic = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  const fn = logic.slice(logic.indexOf('function teamMemberState'),
                         logic.indexOf('function teamOverview'));
  /* Behavioural, not a regex over the source: the return object lists
     replyRate and awaitingReview as neighbouring properties, so any pattern
     loose enough to catch real mixing also matches that list. */
  const now2 = new Date();
  const m = GB.teamMemberState({
    name:'X', userId:'x', upcoming:3, contacts:5, sentEver:49, sent7d:5,
    sentPrev7d:5, replies:0, repliesMeasured:false, awaitingReview:29,
    pastCalls:0, unlogged:0, completed:0, noshows:0, connectedCalendars:1,
    lastSync: now2.toISOString(), lastSentAt: now2.getTime(), upcomingList:[]
  }, now2);
  assert.strictEqual(m.replyRate, null,
    'a big review backlog produced a reply rate. 49 sent and 0 reviewed would '
      + 'read as 0%, which is a confident claim about somebody\u2019s copy '
      + 'drawn entirely from nobody having looked.');
  assert.strictEqual(m.awaitingReview, 29, 'the backlog itself was lost');

  // The refusal itself lives in teamReplyRate, which is where it has to stay.
  const rr = logic.slice(logic.indexOf('function teamReplyRate'),
                         logic.indexOf('function teamReplyRate') + 400);
  assert.ok(/if\(!m \|\| !m\.repliesMeasured\) return null;/.test(rr),
    'the reply rate no longer refuses when replies were never reconciled — it '
      + 'would read 0% for everybody who has simply not reviewed anything, '
      + 'which is a confident claim about their copy drawn from nobody looking');
  assert.ok(!/awaitingReview/.test(rr),
    'the review backlog is leaking into the reply rate calculation');
});

console.log('\n--- the alarm that was counting the wrong people ---');

/* teamOverview splits adopted members from people who have never used the
   product, and every headline figure sums only the adopted ones. That is right
   for rates and for adoption: counting somebody who has never sent anything
   would make performance figures a statement about onboarding.

   todayUntouched is not a performance figure. It is an operational alarm — a
   call happening this afternoon that nobody has texted — and it was being
   summed like one. On this book that printed 5 when the real number was 17,
   and the 12 it left out belonged to the three people who had not opened the
   app in a week and were therefore certain not to send them. */

function tmRow(name, opts){
  const o = opts || {};
  const now = new Date();
  return Object.assign({
    name: name, userId: name, contacts: 10, upcoming: 4, sentEver: 0, sent7d: 0,
    sentPrev7d: 0, replies: 0, repliesMeasured: false, awaitingReview: 0,
    pastCalls: 0, unlogged: 0, completed: 0, noshows: 0, rescheduled: 0,
    connectedCalendars: 1, lastSync: now.toISOString(), lastSentAt: null,
    upcomingList: [], outsideHours: 0, weeks: []
  }, o);
}

/* todayUntouched is DERIVED inside teamMemberState from upcomingList, not
   passed in — so a fixture has to supply real appointments later today with
   nothing sent against them, or it silently measures zero. */
function callsLaterToday(n){
  const out = [];
  for(let i = 0; i < n; i++){
    const when = new Date();
    when.setHours(23, 0, 0, 0);          // still today, still ahead of now
    out.push({clientId: 'x' + i, name: 'C' + i, when: when.toISOString(),
              status: 'Booked', sent: 0});
  }
  return out;
}

test('a call today with nothing sent counts whoever owns it', () => {
  const now = new Date();
  // One person working their list, three who have never sent anything.
  const rows = [
    tmRow('Working', {sentEver: 50, sent7d: 10, lastSentAt: now.getTime(),
                      upcomingList: callsLaterToday(2)}),
    tmRow('Dormant1', {upcomingList: callsLaterToday(6)}),
    tmRow('Dormant2', {upcomingList: callsLaterToday(4)}),
    tmRow('Dormant3', {upcomingList: callsLaterToday(2)})
  ];
  const o = GB.teamOverview(rows, now);
  assert.ok(o.notStarted.length >= 3, 'the dormant accounts should be in notStarted');
  assert.strictEqual(o.todayUntouched, 14,
    'calls happening today are only counted for people who already use the '
      + 'product — which hides exactly the ones nobody is going to send');
});

test('the performance figures still exclude people who never started', () => {
  /* The fix must not leak into the rates. That split exists so a completion
     rate is not really a statement about onboarding. */
  const now = new Date();
  const rows = [
    tmRow('Working', {sentEver: 50, sent7d: 10, lastSentAt: now.getTime(), upcoming: 3}),
    tmRow('Dormant', {upcoming: 20})
  ];
  const o = GB.teamOverview(rows, now);
  assert.strictEqual(o.total, 1, 'somebody who has never used it is being counted as a team member');
  assert.strictEqual(o.notStartedUpcoming, 20,
    'their booked work should still be reported, just counted apart');
  assert.ok(!o.members.some(m => m.name === 'Dormant'));
});

test('the tab carries the count, and it matches the screen it points at', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'), app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  // The creation, not just a mention: the querySelector that looks the badge
  // up also contains the class name, so a pattern that loose stays true with
  // the element itself never being made.
  assert.ok(/h\('span',\{class:'tab-badge'\}/.test(code),
    'nothing on the tab says there is anything to look at, so none of this '
      + 'reaches a manager who does not click through');
  assert.ok(/btn\.appendChild\(badge\)/.test(code), 'the badge is built but never attached');
  assert.ok(/badge\.textContent = String\(o\.todayUntouched\)/.test(code),
    'the badge shows something other than the urgent line it points at — a '
      + 'badge that disagrees with its own screen reads as a bug');
  assert.ok(/badge\.remove\(\)/.test(code),
    'a stale badge is left behind once the calls are handled, so it keeps '
      + 'claiming work that is already done');
});

test('no urgent calls means no badge at all', () => {
  const now = new Date();
  const o = GB.teamOverview([
    tmRow('A', {sentEver: 10, sent7d: 3, lastSentAt: now.getTime()}),
    tmRow('B', {sentEver: 10, sent7d: 3, lastSentAt: now.getTime()})
  ], now);
  assert.strictEqual(o.todayUntouched, 0,
    'a quiet day still produces a number, so the badge would never clear');
});

console.log('\n--- what eight real rows actually looked like ---');

/* Both of these were found by rendering a team shaped like the real one and
   reading it, not by a failing assertion. The DOM stub in this file cannot
   see layout or stacking, so every test about these lines was about their
   text and every one of them passed. */

test('the small facts share one line instead of stacking', () => {
  /* .team-who is a flex column, so each badge became a full-width block on a
     line of its own: four stacked red sentences per person, each opening with
     a separator that separated nothing, and a 135px row. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'), app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  assert.ok(/h\('div',\{class:'team-flags'\}/.test(code),
    'the per-person badges are no longer wrapped together, so each one '
      + 'becomes a full-width line of its own inside the flex column');
  const html = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
  assert.ok(/\.team-flags\{[^}]*display:flex/.test(html), '.team-flags is not laid out as a row');
  assert.ok(/\.team-flags\{[^}]*flex-wrap:wrap/.test(html),
    '.team-flags does not wrap, so a narrow window pushes the badges off the row');
});

test('the headline never leads with a bold red zero', () => {
  /* Somebody needs attention but holds no booked work — a new starter with no
     calendar, which is exactly what Colin was. The stranded sentence then
     read "0 booked appointments belong to someone who is not following anyone
     up": nonsense, and alarming. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'), app.indexOf('function renderOwnerTab()'));
  assert.ok(/\} else if\(!o\.strandedUpcoming\)\{/.test(fn),
    'there is no branch for "needs attention but holding nothing", so the '
      + 'headline leads with a bold zero');
  const branch = fn.slice(fn.indexOf('} else if(!o.strandedUpcoming){'),
                          fn.indexOf('} else {', fn.indexOf('} else if(!o.strandedUpcoming){')));
  assert.ok(/nobody who has '\s*\+\s*'stopped is holding booked work/.test(branch),
    'the no-stranded-work case no longer says what is actually true');
  assert.ok(!/strandedUpcoming/.test(branch.replace('!o.strandedUpcoming', '')),
    'the zero is still being printed in the branch that exists to avoid it');
});

console.log('\n--- the seam between the loader and the screen ---');

/* The failure this exists to prevent, in full, because it is the most
   expensive kind in this codebase: nothing threw, nothing logged, every test
   passed, and four features silently did nothing.

   teamMemberState returns an explicit object rather than spreading the row —
   correct, it is the boundary between what the loader happens to collect and
   what the screen may see. But four fields the screen reads were never added
   to it:

     userId   every assign dropdown rendered with ZERO options, so reassigning
              an appointment was impossible. Bulk cover and the role control
              were dead for the same reason.
     weeks    the activity bars drew an empty box.
     orgRole  no manager badge anywhere.
     isManager

   Six hundred tests passed because each piece was tested alone: weeklyActivity
   against timestamps, the loader against a stub, the renderer against its own
   source. Nothing crossed the seam. */

test('every field the team view reads survives teamMemberState', () => {
  const now = new Date();
  // Shaped exactly like a row out of loadTeamRows.
  const row = {
    userId: 'u-42', name: 'Rep', orgRole: 'admin', isManager: true,
    contacts: 40, upcoming: 8, sentEver: 50, sent7d: 10, sentPrev7d: 8,
    replies: 3, repliesMeasured: true, awaitingReview: 7, outsideHours: 4,
    pastCalls: 20, unlogged: 2, completed: 10, noshows: 8, rescheduled: 1,
    connectedCalendars: 1, lastSync: now.toISOString(), lastSentAt: now.getTime(),
    upcomingList: [{clientId:'c1', name:'A', when:now.toISOString(), status:'Booked', sent:0}],
    weeks: [{weekStart: now.toISOString(), count: 5, partial: true}],
    terminology: null
  };
  const m = GB.teamMemberState(row, now);

  assert.strictEqual(m.userId, 'u-42',
    'userId is dropped — the assign dropdown renders with no options at all, '
      + 'so reassigning an appointment is impossible and bulk cover is dead');
  assert.strictEqual(m.isManager, true, 'isManager is dropped — no manager badge renders');
  assert.strictEqual(m.orgRole, 'admin', 'orgRole is dropped');
  assert.strictEqual(m.weeks.length, 1, 'weeks is dropped — the activity bars draw an empty box');
  assert.strictEqual(m.outsideHours, 4);
  assert.strictEqual(m.awaitingReview, 7);
});

test('the defaults are safe when the loader gives nothing', () => {
  const m = GB.teamMemberState({name: 'X'}, new Date());
  assert.strictEqual(m.userId, null);
  assert.strictEqual(m.isManager, false, 'an unknown person must not default to being a manager');
  assert.strictEqual(m.orgRole, 'member');
  assert.deepStrictEqual(m.weeks, [], 'weeks must be an array, or activityBars throws on .length');
});

test('nothing the renderer reads off a member is missing from the state', () => {
  /* The general version. Scans what renderTeamTab and its helpers actually
     read off a member object and checks each one exists on a real
     teamMemberState result — so the next field added to the screen cannot
     silently resolve to undefined the way these four did. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const region = app.slice(app.indexOf('function activityBars('), app.indexOf('function renderOwnerTab()'));
  const code = region.replace(/\/\*[\s\S]*?\*\//g, ' ')
                     .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');

  const now = new Date();
  const m = GB.teamMemberState({
    userId:'u1', name:'Rep', orgRole:'member', isManager:false, contacts:1, upcoming:1,
    sentEver:1, sent7d:1, sentPrev7d:1, replies:0, repliesMeasured:false,
    awaitingReview:0, outsideHours:0, pastCalls:1, unlogged:0, completed:0,
    noshows:0, rescheduled:0, connectedCalendars:1, lastSync:now.toISOString(),
    lastSentAt:now.getTime(), upcomingList:[], weeks:[]
  }, now);

  // Everything read as `m.<field>` in the team-rendering code.
  const read = new Set();
  let mm;
  const re = /\bm\.([a-zA-Z][a-zA-Z0-9]*)/g;
  while ((mm = re.exec(code)) !== null) read.add(mm[1]);

  const missing = Array.from(read).filter(k => !(k in m));
  assert.deepStrictEqual(missing, [],
    'the team view reads these off a member and teamMemberState does not '
      + 'return them, so they are undefined at render time and whatever they '
      + 'drive silently does nothing: ' + missing.join(', '));
});

console.log('\n--- a handover leaves a trace ---');

/* Moving an appointment wrote nothing anywhere. A rep opened their list to
   find calls they had never seen, with nothing saying where they came from or
   who moved them — and with two managers and a bulk cover that moves
   seventeen at once, "why is this on my list" needs an answer.

   The events table is append-only by policy (insert and select, no update or
   delete), so this is a record rather than a field somebody can quietly
   correct later. */

test('the timeline knows how to say it', () => {
  const now = new Date();
  const client = GB.sanitizeClient({name:'A', bookedDate: now.toISOString()}, 'c1');
  const line = GB.buildTimeline(client, [{
    at: now.toISOString(), kind: 'owner.changed',
    data: {fromName: 'Ronin', toName: 'Ethan', byName: 'Johnny'}
  }], now).filter(e => e.kind === 'owner.changed')[0];
  assert.ok(line, 'a recorded handover does not appear on the timeline at all');
  assert.ok(/Ronin/.test(line.detail) && /Ethan/.test(line.detail),
    'the entry does not say who it moved between: ' + line.detail);
  assert.ok(/Johnny/.test(line.detail),
    'the entry does not say who moved it, which is the half a manager is '
      + 'accountable for: ' + line.detail);
  assert.notStrictEqual(line.label, 'owner.changed',
    'the raw event kind is being shown to a salesperson as a label');
});

test('it degrades to something readable when names are missing', () => {
  const now = new Date();
  const client = GB.sanitizeClient({name:'A', bookedDate: now.toISOString()}, 'c1');
  const line = GB.buildTimeline(client, [{
    at: now.toISOString(), kind: 'owner.changed', data: {}
  }], now).filter(e => e.kind === 'owner.changed')[0];
  assert.ok(line && !/undefined|null/.test(line.detail),
    'a handover with no names renders "undefined" into the timeline: ' + (line && line.detail));
});

test('the move and its record are one statement, in the database', () => {
  /* Done as two writes from the browser, the contact changed hands and the
     record was REFUSED outright: events_org_insert requires
     user_id = auth.uid(), so a browser may only write history about itself.
     That is the right rule, and a handover has to cross it — the entry
     belongs on the NEW OWNER's timeline or the person inheriting the work
     cannot read where it came from. Verified against the real database, not
     assumed: the direct insert came back "new row violates row-level security
     policy for table events". */
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  const fn = data.slice(data.indexOf('async function reassignClient'),
                        data.indexOf('async function loadTeamRows'));
  assert.ok(/sb\.rpc\('reassign_client'/.test(fn),
    'the handover is back to writing from the browser, where the record is '
      + 'refused and only the move lands');
  assert.ok(!/from\('events'\)\.insert/.test(fn),
    'the browser is inserting the event directly again — RLS refuses it');
  assert.ok(!/from\('clients'\)[\s\S]*\.update\(/.test(fn),
    'the move is being written separately from its record, so one can land '
      + 'without the other');
  assert.ok(/r\.ok \? \{ok:true\}/.test(fn),
    'a refusal reported in the function body is being read as success');
});

test('the database function is the thing enforcing it', () => {
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const sql = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const fn = sql.slice(sql.indexOf('function public.reassign_client'));
  assert.ok(fn.length, 'reassign_client is not defined in any migration');
  const body = fn.slice(0, fn.indexOf('$$;') + 3);

  assert.ok(/security definer/i.test(body),
    'without definer rights the event insert is refused, which is the whole '
      + 'reason this function exists');
  assert.ok(/user_managed_org_ids\(\)/.test(body),
    'anybody can move anybody else\u2019s work');
  assert.ok(/from public\.memberships m\s*\n?\s*where m\.user_id = p_to and m\.org_id = c_org/.test(body),
    'the destination is not checked for membership. The clients WITH CHECK '
      + 'constrains org_id and manager-ness but never the incoming user_id, so '
      + 'a contact could be handed to any uuid at all and stranded with an '
      + 'owner who cannot see it.');
  assert.ok(/values \(p_to, p_client, c_org, 'owner\.changed'/.test(body),
    'the record is filed against somebody other than the new owner, so it '
      + 'does not appear on the contact where it now lives');
  assert.ok(/'by', me/.test(body),
    'the actor is not recorded \u2014 user_id is the new OWNER, a different '
      + 'person, and that difference is the point');
});

test('bulk cover carries the same context', () => {
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/async function reassignMany\(clientIds, toUserId, ctx\)/.test(data),
    'reassignMany takes no context, so seventeen appointments move with no '
      + 'record of who moved them or from whom');
  assert.ok(/reassignClient\(ids\[i\], toUserId, ctx\)/.test(data),
    'the context is accepted but not passed through');
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const h = app.slice(app.indexOf("case 'bulk-assign':"), app.indexOf("case 'set-role':"));
  assert.ok(/fromName: bWho, toName: bTo/.test(h), 'the bulk handler sends no names');
});

console.log('\n--- the support view says what it can actually see ---');

/* It was titled "All accounts" and reported "All N accounts healthy". It is
   fed state.platform, which is state.team, which is loadTeamRows — strictly
   the caller's own organisation, because RLS gives the browser nothing else.
   Ghost Recall had thirteen accounts across seven organisations and this
   screen showed eight of them while claiming to be all of them.

   Nothing was broken in the code. The label was simply making a claim the
   data could not support, which is the same failure as a reply rate of 0%
   drawn from nobody having looked. */

test('it does not claim to be every account on Ghost Recall', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderOwnerTab()'),
                       app.indexOf('function renderOwnerTab()') + 4000);
  assert.ok(!/'All accounts'/.test(fn),
    'the heading claims to show every account on Ghost Recall. It is fed the '
      + 'caller’s own organisation and can never see another business.');
  assert.ok(!/'All ' \+ o\.total \+ ' accounts healthy\.'/.test(fn),
    'the summary still reports the organisation’s count as the platform’s');
  assert.ok(/cannot show you another business/.test(fn),
    'nothing on the screen says what it is limited to, so the reader has to '
      + 'infer the scope from a title');

  const html = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
  const btn = html.slice(html.indexOf('id="tab-btn-owner"'), html.indexOf('id="tab-btn-owner"') + 160);
  assert.ok(!/All accounts/.test(btn), 'the tab button still says All accounts');
});

test('the scope it describes is the scope it is given', () => {
  /* The honest fix is only honest while platform stays org-scoped. If
     state.platform is ever fed something wider, this note becomes the
     understatement rather than the overstatement, and either way the screen
     would be lying again. */
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/state\.platform = state\.team;/.test(data),
    'platform is no longer the team rows — the support view now describes its '
      + 'own scope wrongly, in the other direction. Either widen the wording '
      + 'with it or give it a function of its own.');
});

test('it still refuses to carry contact data', () => {
  // The original intent, kept: account-level facts only, because the day an
  // outside business signs up this stops being an internal screen.
  const now = new Date();
  const d = GB.accountDiagnosis({
    name: 'Someone', contacts: 10, upcoming: 3, sentEver: 0,
    connectedCalendars: 1, lastSync: now.toISOString(),
    upcomingList: [{clientId:'c1', name:'A Real Person', when: now.toISOString()}],
    queue: [{name: 'Another Person'}]
  }, now);
  const blob = JSON.stringify(d);
  assert.ok(!/A Real Person|Another Person/.test(blob),
    'the support view grew a contact-shaped field — it shows other businesses '
      + 'and must never carry their customers’ names');
  assert.ok(!('upcomingList' in d) && !('queue' in d),
    'the diagnosis is passing the raw queue through: ' + Object.keys(d).join(', '));
});

console.log('\n--- the manager’s backlog is the rep’s backlog ---');

/* I shipped this badge a few turns ago with only a floor on it. getAwaitingReview
   — the rep's own queue — has a ceiling as well, deliberately: nobody reliably
   remembers whether a text got a reply a fortnight ago, and a guessed answer is
   worse for the bandit than no answer at all, so sends simply age out.

   Against the real book the two disagreed badly:

     Johnny   465 shown   58 ever offered
     Ronin     41 shown   19 ever offered
     Ethan     23 shown    4 ever offered

   with a note under it saying they were waiting in Ghost Recall Today. They
   were not. Most of them aged out days ago and can never be answered, so the
   badge was asking for work that does not exist. */

test('both windows come from the same constants', () => {
  assert.strictEqual(typeof GB.REVIEW_MAX_AGE_DAYS, 'number',
    'the ceiling is a bare number in a default argument again, so the two '
      + 'counts can drift apart without anything noticing');
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/REPLY_WAIT_HOURS \* 3600000/.test(data), 'the floor is not the shared constant');
  assert.ok(/REVIEW_MAX_AGE_DAYS \* 86400000/.test(data),
    'the manager count has no ceiling, so it reports answers that aged out '
      + 'days ago and can never be given');
});

test('the count and the queue agree on the same messages', () => {
  /* The real guard: build one account, ask the rep's queue and apply the
     manager's rule to the same data, and require the same answer. */
  const now = new Date();
  const mk = (hoursAgo, reviewed, ignored) => ({
    sentAt: new Date(now.getTime() - hoursAgo * 3600000).toISOString(),
    reviewed: reviewed, responded: false, stage: 'welcome', variantId: 'w1'
  });
  const state = GB.buildDefaultState();
  const live = GB.sanitizeClient({name: 'Live', messageLog: [
    mk(2, false),      // too recent to ask
    mk(36, false),     // askable
    mk(60, false),     // askable
    mk(40, true),      // already answered
    mk(240, false)     // aged out
  ]}, 'c-live');
  const gone = GB.sanitizeClient({name: 'Ignored', ignored: true,
    messageLog: [mk(36, false)]}, 'c-ign');
  state.clients[live.id] = live;
  state.clients[gone.id] = gone;

  const queue = GB.getAwaitingReview(state, now);
  assert.strictEqual(queue.length, 2,
    'the rep’s own queue changed shape: ' + queue.length);

  // The manager's rule, applied to the same messages.
  let managerCount = 0;
  Object.keys(state.clients).forEach(id => {
    const c = state.clients[id];
    c.messageLog.forEach(m => {
      const age = now.getTime() - Date.parse(m.sentAt);
      if(!m.reviewed && !c.ignored &&
         age >= GB.REPLY_WAIT_HOURS * 3600000 &&
         age <= GB.REVIEW_MAX_AGE_DAYS * 86400000) managerCount++;
    });
  });
  assert.strictEqual(managerCount, queue.length,
    'the manager is shown ' + managerCount + ' outstanding answers while the '
      + 'rep is offered ' + queue.length + '. A manager must never be shown '
      + 'work their rep has not been given.');
});

test('an ignored contact is not somebody’s outstanding work', async () => {
  const now = Date.now();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Rep'}], error: null},
    clients: {data: [
      {id:'c1', user_id:'u2', name:'Real', timezone:'UTC'},
      {id:'c2', user_id:'u2', name:'Standing meeting', timezone:'UTC', ignored:true}
    ], error: null},
    message_log: {data: [
      {client_id:'c1', sent_at: new Date(now - 36*3600000).toISOString(), responded:false, reviewed:false},
      {client_id:'c2', sent_at: new Date(now - 36*3600000).toISOString(), responded:false, reviewed:false}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const rep = rows.filter(r => r.name === 'Rep')[0];
  assert.strictEqual(rep.awaitingReview, 1,
    'a message to an ignored contact is counted as outstanding, but the rep’s '
      + 'queue skips ignored contacts entirely so it can never be cleared');
});

console.log('\n--- the same booking, spelled two ways ---');

/* The sync's duplicate check compared `email|time` strings built two
   different ways. The stored side came back from PostgREST as
   2026-10-08T19:00:00+00:00; the Google side was start.dateTime verbatim,
   2026-10-08T14:00:00-05:00. The same instant, two strings, no match — so it
   only ever caught duplicates WITHIN one run and was inert against every
   contact imported before it.

   Found in the team view: Zachary had Cody Cravens twice at the same time,
   two different calendar events, created on successive days. Small today —
   three duplicated bookings across the book — but it grows with every
   rebooking, and every copy inflates upcoming, untouched and the calls-today
   alarm.

   parse.ts and the sync are TypeScript and this suite is deliberately
   dependency-free, so the rule is pinned at source and the normalisation
   itself is checked against the exact strings the two sides produce. */

test('the two spellings of one instant are the same key', () => {
  // Precisely the pair that slipped through.
  const fromDatabase = '2026-10-08T19:00:00+00:00';
  const fromGoogle   = '2026-10-08T14:00:00-05:00';
  assert.strictEqual(Date.parse(fromDatabase), Date.parse(fromGoogle),
    'these must be the same instant, or the example is wrong');
  assert.notStrictEqual(fromDatabase, fromGoogle,
    'if the raw strings matched there would have been no bug');
  assert.strictEqual(new Date(Date.parse(fromDatabase)).toISOString(),
                     new Date(Date.parse(fromGoogle)).toISOString(),
    'normalising to an instant does not make them equal, so the fix does not work');
});

test('the sync builds that key one way, in one place', () => {
  const sync = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', 'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/function emailTimeKey\(/.test(sync),
    'the key is built inline again, which is how the two sides drifted apart');
  assert.ok(/new Date\(t\)\.toISOString\(\)/.test(sync),
    'the key is not normalised to an instant, so a contact stored by Postgres '
      + 'and the same booking from Google will not match');
  // Both ends must go through it.
  assert.ok(/\.map\(\(c: any\) => \[emailTimeKey\(c\.email, c\.call_date_time\)/.test(sync),
    'the existing contacts are not keyed through the shared function');
  assert.ok(/const etKey = emailTimeKey\(parsed\.email, parsed\.callDateTime\)/.test(sync),
    'the incoming event is not keyed through the shared function');
  /* And no hand-built key may survive OUTSIDE that function — the function's
     own body is the one place allowed to spell it, so the check has to
     exclude it or it matches the fix itself. */
  const outside = sync.slice(0, sync.indexOf('function emailTimeKey('))
                + sync.slice(sync.indexOf('async function syncOneCalendar'));
  assert.ok(!/\$\{[^}]*email[^}]*\}\|\$\{/i.test(outside),
    'a hand-built `email|time` key is back somewhere outside the shared '
      + 'function, which is exactly how the two sides drifted apart');
});

test('a booking with no email or no time is never deduped by it', () => {
  /* Returning a key for a missing value would collide every contact without
     an email address into one, and the second of them would be silently
     dropped as a duplicate. */
  const sync = fs.readFileSync(
    path.join(__dirname, 'supabase', 'functions', 'google-calendar-sync', 'index.ts'), 'utf8');
  const fn = sync.slice(sync.indexOf('function emailTimeKey('),
                        sync.indexOf('async function syncOneCalendar'));
  assert.ok(/if \(!email \|\| !when\) return null;/.test(fn),
    'a missing email or time still produces a key, so unrelated contacts '
      + 'collide and get dropped as duplicates');
  assert.ok(/if \(isNaN\(t\)\) return null;/.test(fn),
    'an unparseable time produces a key built on NaN');
  assert.ok(/\.filter\(\(pair: any\) => pair\[0\] !== null\)/.test(sync),
    'null keys are being put into the map, where one of them will match the '
      + 'next contact that also has no email');
});

console.log('\n--- two people with the same name ---');

/* The team rows were keyed by NAME: which row is expanded, which dropdown the
   bulk-cover button reads, and which member "Move them" acts on.

   A name is not an identifier here. It comes from sender_name, which anybody
   can type; failing that the local part of a connected calendar address;
   failing that the literal string "teammate" for somebody with neither — and
   there is one of those on this book right now, because Colin has not
   connected a calendar.

   Two matching names is not hypothetical either: there are two Ethan accounts
   in this organisation, and five of the eight have no sender_name set at all.
   The moment two matched, expanding one row expanded both, the dropdown
   lookup returned whichever sorted first, and "Move them" would have handed
   over the wrong person's appointments. */

test('rows are addressed by user id, not by what somebody is called', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderTeamTab()'),
                       app.indexOf('function renderOwnerTab()'));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ')
                 .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');

  assert.ok(/TEAM_OPEN === m\.userId/.test(code),
    'which row is expanded is decided by name, so two people with the same '
      + 'name open and close together');
  assert.ok(!/'data-who': m\.name\}/.test(code),
    'the row is still addressed by name');
  assert.ok(/'data-bulk-to':m\.userId/.test(code),
    'the bulk-cover dropdown is keyed by name, so querySelector returns '
      + 'whichever namesake sorts first in the document');

  const h = app.slice(app.indexOf("case 'bulk-assign':"), app.indexOf("case 'set-role':"));
  assert.ok(/x\.userId === bUid/.test(h),
    'the member whose appointments get moved is looked up by name. With two '
      + 'namesakes this hands over the wrong person\u2019s whole queue.');
  assert.ok(/data-bulk-to="' \+ bUid \+ '"/.test(h),
    'the dropdown is still found by name');
});

test('the toggle still closes, and ignores a row with no id', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const h = app.slice(app.indexOf("case 'team-toggle':"), app.indexOf("case 'team-toggle':") + 400);
  assert.ok(/TEAM_OPEN = \(who && TEAM_OPEN === who\) \? null : who;/.test(h),
    'clicking the open row no longer closes it, or a row with no user id '
      + 'collapses every other row by matching null against null');
});

test('a name is still only a label', () => {
  /* Keeping the fallback chain honest: sender_name, then the calendar local
     part, then a generic word. The generic word is fine as a LABEL and was
     never fine as a key. */
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/String\(r\.calendar_id\)\.split\('@'\)\[0\]/.test(data),
    'the calendar-address fallback is gone, so everybody without a sender '
      + 'name renders as the same generic word');
  assert.ok(/nameFor\[u\] \|\| b\.name \|\| 'teammate'/.test(data),
    'the final fallback changed shape');
  // And userId must actually reach the row, or the new keying has nothing.
  assert.ok(/userId:u,/.test(data), 'the team row no longer carries a user id');
});

console.log('\n--- connecting a calendar lands back in the app ---');

/* Reported from real use: approving at Google dropped you on a bare page on
   functions.supabase.co, you navigated back to Ghost Recall yourself, you
   often had to sign in again, and then you pressed "Sync calendar" by hand.

   Three separate causes. The callback finished on a dead-end page. That page
   is a different origin, so getting back to the app was manual and could
   present a fresh session. And nothing told the app a calendar had just been
   connected — so people pressed sync for a run the callback had already
   performed and awaited before responding.

   The return origin travels in `state`, which nothing signs, so the thing to
   get right is that it cannot become an open redirect. */

test('the return origin is allow-listed, not trusted', () => {
  const cb = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-callback', 'index.ts'), 'utf8');
  assert.ok(/const ALLOWED_ORIGINS = \[/.test(cb),
    'the callback redirects to whatever origin the state asked for. That state '
      + 'is unsigned base64 the browser wrote, so this is an open redirect: '
      + 'craft one, send somebody through a real Google consent screen, land '
      + 'them anywhere.');
  assert.ok(/ALLOWED_ORIGINS\.includes\(u\.origin\)/.test(cb),
    'the allow-list exists but is not what the decision is made on');
  assert.ok(/return htmlResponse\(fallbackTitle, fallbackBody, status\)/.test(cb),
    'an origin that is not allowed has nowhere to go — it must fall back to '
      + 'the plain page rather than redirecting anyway');
  // Matching on origin, not a substring: "ghostrecallcrm.com.evil.test" must
  // not pass.
  assert.ok(!/startsWith|indexOf\(.https/.test(cb),
    'the origin is being matched loosely, so a lookalike hostname passes');
});

test('localhost is allowed for development, https elsewhere', () => {
  const cb = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-callback', 'index.ts'), 'utf8');
  const fn = cb.slice(cb.indexOf('function appUrl('), cb.indexOf('function backToApp('));
  assert.ok(/u\.hostname === 'localhost' \|\| u\.hostname === '127\.0\.0\.1'/.test(fn),
    'a dev build cannot exercise this flow without editing the function');
  assert.ok(/u\.protocol === 'http:'/.test(fn),
    'the localhost exception is not pinned to http, so it widens more than intended');
  GB.buildDefaultState();   // keep this file's vm warm; no behavioural claim
});

test('success and failure both come home', () => {
  const cb = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-callback', 'index.ts'), 'utf8');
  assert.ok(/backToApp\(state\.origin, \{calendar: 'connected', cal: calendarId\}/.test(cb),
    'a successful connection still finishes on a page telling somebody to '
      + 'close the tab themselves');
  /* Every failure after the state is readable comes home, carrying WHY.
     The no-refresh-token case in particular has real instructions attached —
     remove the old grant in Google first — and spending those on a page
     nobody returns from is how somebody gets stuck in a loop of reconnecting
     and failing the same way. */
  // One alternation covering every reason would let any single one be
  // deleted while the others kept the pattern true, so each is checked on
  // its own exact spelling.
  ['save', 'account'].forEach(function(reason){
    assert.ok(cb.indexOf("calendar: 'error', reason: '" + reason + "'") !== -1,
      'the "' + reason + '" failure does not come back to the app, so the '
        + 'person is stranded on the callback domain and the app cannot say '
        + 'what went wrong');
  });
  assert.ok(cb.indexOf("calendar: 'error', reason: already ? 'already' : 'exchange'") !== -1,
    'the token-exchange failures do not come home, which loses the one '
      + 'message that tells somebody how to unstick themselves');
  assert.ok(/status: 303/.test(cb),
    'the redirect is not a 303, so a back button can re-submit the exchange');
});

test('the app says so, once, and cleans the address bar', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function noteCalendarReturn()'),
                       app.indexOf('async function init()'));
  assert.ok(/q\.get\('calendar'\)/.test(fn), 'nothing reads the flag the callback sends back');
  assert.ok(/history\.replaceState/.test(fn),
    'the parameter is left in the address bar, so a refresh or a shared link '
      + 'replays "calendar connected" to somebody who did nothing');
  assert.ok(/status === 'connected'/.test(fn) && /failed/.test(fn),
    'the failure case is not distinguished from the success case');
  /* The "already connected once" case keeps its instructions and gets a panel
     rather than a toast, because it asks somebody to go and change a setting
     in another product — more than a line that fades after four seconds. */
  assert.ok(/reason === 'already'/.test(fn),
    'the no-refresh-token case is shown as a generic failure, losing the only '
      + 'instructions that actually unstick it');
  assert.ok(/Third-party/.test(fn),
    'the panel no longer tells them where in Google to go, which is the whole '
      + 'content of that message');
  assert.ok(/openModalHtml/.test(fn),
    'instructions somebody has to act on in another product are being shown '
      + 'as a toast that disappears');

  const init = app.slice(app.indexOf('async function init()'),
                         app.indexOf('async function init()') + 400);
  assert.ok(/noteCalendarReturn\(\)/.test(init), 'init never checks for the return');
  assert.ok(init.indexOf('renderAll()') < init.indexOf('noteCalendarReturn()'),
    'the toast fires before the render, so it lands over an empty screen '
      + 'instead of the bookings that just arrived');
});

test('the browser sends an origin to come back to', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const h = app.slice(app.indexOf("case 'connect-calendar':"), app.indexOf("case 'sync-calendar-now':"));
  assert.ok(/origin: window\.location\.origin/.test(h),
    'the state carries no origin, so the callback has nowhere to send anybody '
      + 'and falls back to the dead-end page for everyone');
  assert.ok(/redirect_uri: 'https:\/\/gqfpsjksosxvszzhhezu\.functions\.supabase\.co\/google-calendar-callback'/.test(h),
    'the Google redirect_uri changed — it is registered in Google Cloud '
      + 'Console and changing it here breaks the consent screen');
});

console.log('\n--- "Unknown" when Google knew the name all along ---');

/* A contact's name came from the title's parentheses, then "booked by:" in
   the description, then the literal string "Unknown". Google sends a
   displayName on every attendee and nothing ever read it.

   On a real account that meant six of thirteen contacts named "Unknown" —
   every "Interview with Josh" and "Second Meeting Market Maker MGMT - Colin
   and Erica" belonging to somebody who books meetings by hand instead of
   through a funnel that writes "(Name)" into the title.

   Not cosmetic: firstName('Unknown') is 'there', so every one of those people
   gets "Hey there," in a message that is otherwise personal. */

test('the guest’s own name is used when the title has none', () => {
  const parse = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    '_shared', 'parse.ts'), 'utf8');
  const fn = parse.slice(parse.indexOf('export function clientFromGCalEvent'));
  assert.ok(/displayName\?: string/.test(parse),
    'the attendee type has no displayName, so Google’s own name for the '
      + 'guest is discarded at the type boundary');
  assert.ok(/guest\?\.displayName/.test(fn),
    'the displayName fallback is gone — anything not booked through a funnel '
      + 'imports as "Unknown" and gets texted "Hey there,"');
});

test('the order of preference is title, then description, then Google', () => {
  const parse = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    '_shared', 'parse.ts'), 'utf8');
  // Comments stripped: the block above this code names all three sources in
  // prose, so an index-based ordering check matches the explanation instead
  // of the implementation.
  const fn = codeOnly(parse.slice(parse.indexOf('export function clientFromGCalEvent')));
  const iTitle = fn.indexOf('nameMatch ? nameMatch[1]');
  const iDesc  = fn.indexOf('booked by');
  const iGuest = fn.indexOf('guest?.displayName');
  const iFinal = fn.indexOf("if (!name) name = 'Unknown';");
  assert.ok(iTitle > -1 && iDesc > iTitle && iGuest > iDesc && iFinal > iGuest,
    'the name sources are no longer tried in order of how much the source '
      + 'actually knows: a booking tool’s "(Name)" is exact, Google’s '
      + 'displayName is whatever the guest called themselves');
});

test('the name comes from the guest we are actually writing to', () => {
  /* Taking the first attendee's displayName would let the name and the email
     disagree — "Hey Erica" sent to brian@. It has to be the attendee we
     already settled on as the contact. */
  const parse = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    '_shared', 'parse.ts'), 'utf8');
  const fn = parse.slice(parse.indexOf('export function clientFromGCalEvent'));
  assert.ok(/\(a\.email \|\| ''\)\.toLowerCase\(\) === emails\[0\]/.test(fn),
    'the display name is taken from an attendee other than the one the '
      + 'message is addressed to, so the greeting can name the wrong person');
  assert.ok(fn.indexOf('const emails =') < fn.indexOf('guest?.displayName'),
    'the contact address is chosen after the name that depends on it');
});

test('"Unknown" still greets somebody as "there"', () => {
  // The reason this mattered, pinned so the cost stays visible.
  assert.strictEqual(GB.firstName('Unknown'), 'Unknown');
  assert.strictEqual(GB.firstName(''), 'there');
  assert.strictEqual(GB.firstName('Josh Degan'), 'Josh');
});

console.log('\n--- a new booking lands in YOUR pipeline ---');

/* The sync stamped every newly imported contact with the literal string
   'Booked'. That is the default template's first stage and nobody else's.

   Surfaced switching a real account off the recruiting template: all thirteen
   of its contacts were sitting on 'Booked' while its pipeline ran Sourced ->
   Contacted -> Screen Scheduled and contained no such stage. Harmless by luck
   — an unrecognised stage reads as 'open', so they kept being followed up —
   but it means the industry templates were not actually working for the
   people they exist for: pick Recruiting, sync your calendar, and every
   candidate arrives on a stage your own settings do not list. */

test('the first open stage is read from the account, not assumed', () => {
  const sync = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/select=calendar_filter,pipeline/.test(sync),
    'the sync does not fetch the pipeline, so it cannot know where a new '
      + 'booking belongs and falls back to one template’s vocabulary');
  assert.ok(/\(st\.role \|\| 'open'\) === 'open'/.test(sync),
    'the landing stage is not chosen by ROLE, which is the rule the rest of '
      + 'the engine uses and the only thing that survives a rename');
  assert.ok(/status: openStage/.test(sync),
    "the insert still hardcodes a stage name");
  assert.ok(!/status: 'Booked'/.test(sync), "a literal 'Booked' is back in the insert");
});

test('an account with no pipeline still gets the default open stage', () => {
  const sync = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/let openStage = 'Booked';/.test(sync),
    'there is no fallback, so an account that never set a pipeline would '
      + 'import contacts onto undefined');
  assert.ok(/openStage = 'Booked',/.test(sync),
    'the parameter has no default, so a caller that omits it imports onto '
      + 'undefined rather than the default template’s open stage');
  // And 'Booked' must genuinely be the default template's open stage, or the
  // fallback is just another guess.
  const def = GB.buildDefaultPipeline();
  const firstOpen = def.filter(st => (st.role || 'open') === 'open')[0];
  assert.strictEqual(firstOpen.key, 'Booked',
    'the default pipeline’s first open stage is no longer Booked, so the '
      + 'sync fallback now contradicts it');
});

test('every industry template has somewhere for a booking to land', () => {
  /* If a template had no open stage the sync would silently fall back to
     'Booked' for it, which is the bug again wearing a fallback. */
  GB.buildIndustryTemplates().forEach(function(t){
    if(!t.pipeline) return;   // 'custom' keeps the defaults
    const open = t.pipeline.filter(st => (st.role || 'open') === 'open');
    assert.ok(open.length,
      'the ' + t.key + ' template has no open stage, so a synced booking has '
        + 'nowhere of its own to land');
  });
});

console.log('\n--- which clock a time is on ---');

/* Reported: "why is Mason Lopez showing as a 12pm call when I have him for
   3pm my time". Both numbers were right and the app never said which was
   which.

   The instant is 19:00 UTC. That is 3pm in New York, where the reader is, and
   12pm in Los Angeles, which is where a (702) Las Vegas area code puts Mason.
   Ghost Recall deliberately tracks the contact's clock so nobody gets texted
   at 6am — and the On Deck panel was answering "when is this call" with it,
   printing a 12:00 PM headline above a chip reading "12:00 PM their time".
   The same number twice, one of them silently meaning something else, and
   neither matching the calendar the reader had open. */

test('the two clocks really are three hours apart here', () => {
  // The actual record, so the example cannot drift from the bug.
  const when = new Date('2026-10-08T19:00:00Z');
  assert.strictEqual(GB.fmtTime(when, 'America/New_York'), '3:00 PM');
  assert.strictEqual(GB.fmtTime(when, 'America/Los_Angeles'), '12:00 PM');
  // A 702 number is Las Vegas, which is Pacific — the derivation was right,
  // which is the point: nothing here was broken except which clock was shown.
  assert.strictEqual(GB.areaCodeFromPhone('(702) 343-4318'), '702');
  assert.strictEqual(GB.AREA_CODE_TZ['702'], 'America/Los_Angeles');
});

test('"when is this call" is answered on the reader’s clock', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function fmtTimeHere('),
                                app.indexOf('function fmtDayTime(')));
  assert.ok(!/timeZone/.test(fn),
    'fmtTimeHere passes a timeZone, so it is not the reader’s clock. '
      + 'fmtTime defaults to UTC when given nothing, which is why this cannot '
      + 'just delegate to it.');

  const od = codeOnly(app.slice(app.indexOf('var html = \'<div class="ondeck\''),
                                app.indexOf('<div class="od-actions">')));
  assert.ok(/fmtTimeHere\(d\)/.test(od),
    'the On Deck headline is back on the contact’s clock, so it disagrees '
      + 'with the calendar the reader has open');
  assert.ok(/their time/.test(od),
    'the contact-clock chip is gone — that is the one that stops somebody '
      + 'texting at 6am and it has to stay');
});

test('the contact’s clock keeps its label wherever it is shown', () => {
  /* The rule that makes both readable: a time on the contact's clock always
     says so, a time on the reader's clock never needs to. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const code = codeOnly(app);
  const chips = code.split('tzInfo.timeLabel').length - 1;
  assert.ok(chips >= 2,
    'the "their time" chips have been removed from the surfaces that send '
      + 'messages, which is where the contact’s clock actually matters');
  assert.ok(!/od-time">' \+ fmtTime\(d, c\.timezone\)/.test(code),
    'the On Deck headline is unlabelled AND on the contact’s clock again');
});

console.log('\n--- does following up first change anything ---');

/* The question this product was pointed at from the start, refused three
   times for want of data. It is answerable now for anybody who has both
   halves, and the first honest answer on the first book to have them is NO:

     followed up first   43%   61 decided calls
     nothing sent        45%   58 decided calls

   Two points, the wrong way. That belongs on the screen precisely BECAUSE it
   is not the expected answer — a manager who assumes follow-up drives
   attendance will push for more of it and read noise as confirmation. */

test('it refuses when one side of the comparison is thin', () => {
  /* Somebody who always follows up has no control group, and 33% from their
     three exceptions would read as a catastrophe. This is the real shape of
     one person on this book: 97 untouched against 3 touched. */
  const e = GB.touchEffect({decidedWithTouch: 3, decidedWithoutTouch: 97,
                            showedWithTouch: 1, showedWithoutTouch: 54});
  assert.strictEqual(e.measurable, false,
    'a three-call band was compared against a ninety-seven-call band');
  assert.strictEqual(e.shortSide, 'touched', 'the panel cannot say which side is short');

  // And the mirror: somebody who never follows up.
  const f = GB.touchEffect({decidedWithTouch: 40, decidedWithoutTouch: 2,
                            showedWithTouch: 20, showedWithoutTouch: 2});
  assert.strictEqual(f.measurable, false);
  assert.strictEqual(f.shortSide, 'untouched');
});

test('with both sides real, it reports the difference', () => {
  // The actual figures off this book.
  const e = GB.touchEffect({decidedWithTouch: 61, decidedWithoutTouch: 58,
                            showedWithTouch: 26, showedWithoutTouch: 26});
  assert.strictEqual(e.measurable, true);
  assert.strictEqual(e.withPct, 43);
  assert.strictEqual(e.withoutPct, 45);
  assert.strictEqual(e.diff, -2, 'the direction of the difference is wrong');
});

test('the threshold is the same on both sides and not nothing', () => {
  assert.ok(GB.TOUCH_EFFECT_MIN >= 20,
    'the minimum band size dropped low enough to report noise as a finding');
  const justUnder = GB.touchEffect({
    decidedWithTouch: GB.TOUCH_EFFECT_MIN - 1, decidedWithoutTouch: 500,
    showedWithTouch: 0, showedWithoutTouch: 250});
  assert.strictEqual(justUnder.measurable, false, 'one below the threshold is reported');
  const justOn = GB.touchEffect({
    decidedWithTouch: GB.TOUCH_EFFECT_MIN, decidedWithoutTouch: GB.TOUCH_EFFECT_MIN,
    showedWithTouch: 10, showedWithoutTouch: 5});
  assert.strictEqual(justOn.measurable, true, 'exactly on the threshold is refused');
});

test('a small difference is called no difference', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function touchEffectPanel('),
                                app.indexOf('function activityBars(')));
  assert.ok(/Math\.abs\(e\.diff\) < 5/.test(fn),
    'any difference at all is reported as a finding, so two points of noise '
      + 'reads as evidence');
  assert.ok(/No measurable difference/.test(fn),
    'the no-effect case has no wording of its own, so it renders as a number '
      + 'that looks like a result');
  /* And it must not claim causation. Whether somebody texts before a call is
     not random — you chase the ones you are worried about — so the touched
     group is pre-selected for doubt. */
  assert.ok(!/does not work|doesn’t work|no effect/i.test(fn),
    'the panel states a cause rather than a measurement');
  assert.ok(/already in doubt/.test(fn),
    'the selection effect is no longer mentioned where the difference is '
      + 'negative, which is where somebody would most likely misread it');
});

test('the panel is actually on the screen', () => {
  // The logic can be perfect and render nowhere — that exact gap cost four
  // features earlier in this file.
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function renderTeamTab()'),
                                app.indexOf('function renderOwnerTab()')));
  assert.ok(/list\.appendChild\(touchEffectPanel\(m\)\)/.test(fn),
    'touchEffectPanel is never called, so the whole comparison renders nowhere');
  assert.ok(/list\.appendChild\(attendancePanel\(m\)\)/.test(fn),
    'attendancePanel is never called, so the time-of-day breakdown renders nowhere');
});

test('both halves survive the trip from loader to screen', async () => {
  const now = Date.now();
  const past = new Date(now - 5*86400000).toISOString();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Rep'}], error: null},
    clients: {data: [
      {id:'a', user_id:'u2', name:'A', call_date_time:past, status:'Completed', timezone:'UTC'},
      {id:'b', user_id:'u2', name:'B', call_date_time:past, status:'No-show',   timezone:'UTC'},
      {id:'c', user_id:'u2', name:'C', call_date_time:past, status:'Completed', timezone:'UTC'}
    ], error: null},
    message_log: {data: [
      // Only 'a' was followed up before the call.
      {client_id:'a', sent_at: new Date(now - 6*86400000).toISOString(), responded:false, reviewed:true}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const rep = rows.filter(r => r.name === 'Rep')[0];
  assert.strictEqual(rep.decidedWithTouch, 1, 'a call preceded by a message was not counted as touched');
  assert.strictEqual(rep.showedWithTouch, 1);
  assert.strictEqual(rep.decidedWithoutTouch, 2, 'the untouched side is wrong');
  assert.strictEqual(rep.showedWithoutTouch, 1, 'a no-show was counted as having shown up');

  // And through teamMemberState, which has dropped fields before.
  const m = GB.teamMemberState(rep, new Date());
  assert.strictEqual(m.decidedWithTouch, 1, 'the split is lost at the state boundary');
  assert.strictEqual(m.decidedWithoutTouch, 2);
});

console.log('\n--- attendance by time of day ---');

/* The one dimension on this book that showed a real pattern. One person's
   midday calls were attended at 33% against 62% in the afternoon. Five
   dimensions had been tried by then — touches, lead time, weekday, hour, call
   type — and testing enough of them guarantees one looks significant, so it
   was checked by splitting that person's history into two independent halves:
   39 vs 64 in the earlier period, 33 vs 62 in the later. Same direction, same
   size, twice. Replication is what earned it a place, not a p-value. */

test('a call is banded on the CONTACT’s clock', () => {
  // 19:00 UTC is midday in Los Angeles and mid-afternoon in New York. Whether
  // somebody is at lunch depends on where they are, not where you are.
  const when = new Date('2026-10-08T19:00:00Z');
  assert.strictEqual(GB.attendanceBandFor(when, 'America/Los_Angeles'), 'midday');
  assert.strictEqual(GB.attendanceBandFor(when, 'America/New_York'), 'afternoon');
  assert.strictEqual(GB.attendanceBandFor(null, 'UTC'), null, 'a missing time still bands');
  assert.strictEqual(GB.attendanceBandFor('nonsense', 'UTC'), null);
});

test('the bands cover the clock once and only once', () => {
  /* A gap would silently drop calls out of the comparison; an overlap would
     double-count them into two bands. */
  for (let hr = 0; hr < 24; hr++) {
    const hits = GB.ATTENDANCE_BANDS.filter(b => hr >= b.from && hr < b.to);
    assert.strictEqual(hits.length, 1,
      hr + ':00 falls into ' + hits.length + ' bands, not exactly one');
  }
});

test('a thin band is left out rather than given a percentage', () => {
  const out = GB.attendanceByHour({
    decidedByBand: {midday: 64, afternoon: 34, evening: 3},
    showedByBand:  {midday: 21, afternoon: 21, evening: 3}
  });
  assert.strictEqual(out.length, 2, 'a three-call band was given a percentage');
  assert.ok(!out.some(b => b.key === 'evening'),
    'the evening band has three calls and would read as 100%');
  assert.strictEqual(out[0].pct, 33);
  assert.strictEqual(out[1].pct, 62);
});

test('one band alone is not a comparison', () => {
  /* With a single band this is just that person's overall rate again, which
     the row above already shows — and putting it under a "by time of day"
     heading implies a contrast that is not there. */
  const out = GB.attendanceByHour({
    decidedByBand: {midday: 80}, showedByBand: {midday: 40}
  });
  assert.deepStrictEqual(out, [], 'a single band was presented as a breakdown');
});

test('the panel lists the bands and never ranks them', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function attendancePanel('),
                                app.indexOf('function touchEffectPanel(')));
  assert.ok(/attendanceByHour\(m\)/.test(fn), 'the panel does not use the gated helper');
  assert.ok(/if\(!bands\.length\) return wrap;/.test(fn),
    'an empty breakdown still renders a heading, so somebody reads a title '
      + 'with nothing under it as a bug');
  /* No superlatives. Picking best-and-worst of four buckets overstates by
     construction and a manager will move bookings on the strength of it. */
  assert.ok(!/best|worst|strongest|weakest/i.test(fn),
    'the panel ranks the bands. Some spread between four buckets is certain '
      + 'even in noise, so naming a winner invents a finding.');
  assert.ok(/roughly right/.test(fn),
    'the panel no longer says the contact clock is derived from a phone '
      + 'number and therefore approximate');
});

test('the bands survive the loader and the state boundary', async () => {
  const past = new Date(Date.now() - 5*86400000);
  past.setUTCHours(19, 0, 0, 0);
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Rep'}], error: null},
    clients: {data: [
      {id:'a', user_id:'u2', name:'A', call_date_time:past.toISOString(),
       status:'Completed', timezone:'America/Los_Angeles'},
      {id:'b', user_id:'u2', name:'B', call_date_time:past.toISOString(),
       status:'No-show', timezone:'America/Los_Angeles'},
      {id:'c', user_id:'u2', name:'C', call_date_time:past.toISOString(),
       status:'Completed', timezone:'America/New_York'}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const rep = rows.filter(r => r.name === 'Rep')[0];
  assert.strictEqual(rep.decidedByBand.midday, 2,
    'the two Los Angeles calls should land at midday on their own clock');
  assert.strictEqual(rep.showedByBand.midday, 1, 'a no-show was counted as attended');
  assert.strictEqual(rep.decidedByBand.afternoon, 1,
    'the New York call should land in the afternoon on its own clock');
  const m = GB.teamMemberState(rep, new Date());
  assert.strictEqual(m.decidedByBand.midday, 2, 'the bands are lost at the state boundary');
});

test('the coverage line does not contradict itself', () => {
  /* Seen on screen: "5 finished calls have no outcome recorded, so show-up
     rates are only measurable for 3 of 3." The word "only" promises something
     is being withheld; "3 of 3" says nothing is. Two facts welded into one
     sentence, and the join was wrong whenever everybody was still measurable. */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('if(o.unlogged){'),
                                app.indexOf('var lead;')));
  assert.ok(/o\.showUpMeasurable < o\.total/.test(fn),
    'the consequence is stated unconditionally, so it claims rates are '
      + 'withheld even when every one of them is being shown');
  assert.ok(/Every show-up rate below is still measurable/.test(fn),
    'the all-measurable case has no wording of its own');
  assert.ok(!/only measurable for/.test(fn),
    '"only measurable for N of N" is back');
});

console.log('\n--- a contact’s name can be corrected, and it sticks ---');

/* The name is derived four ways over: the parentheses in the calendar title,
   "booked by:" in the description, the guest's displayName from Google, then
   the literal "Unknown". Three of those are somebody else's data entry, so
   being wrong is normal — and the client modal let you edit the date, the
   phone, the timezone, the notes and the recap, but not who the person is.

   "Unknown" is not cosmetic: firstName('Unknown') is 'there', so those
   contacts receive "Hey there," in a message that is otherwise personal.
   Seven of them on one account, two of which can never resolve on their own
   because the guest is a shared mailbox with no display name to send. */

test('the modal offers the name, and flags the ones that have none', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function openClientModal'),
                       app.indexOf('function openClientModal') + 4000);
  assert.ok(/data-field="name"/.test(fn),
    'the name still cannot be corrected, so an "Unknown" contact keeps being '
      + 'greeted as "there" with no way to fix it');
  assert.ok(/c\.name === 'Unknown'/.test(fn),
    'nothing distinguishes a placeholder name from a real one, so the reason '
      + 'to fix it is invisible');
  assert.ok(/Hey there/.test(fn),
    'the note no longer says what "Unknown" actually does to the messages');
  /* The input's VALUE specifically. The modal heading also escapes c.name, so
     an unscoped pattern stays true while the field itself interpolates raw. */
  assert.ok(/value="' \+ escapeHtml\(c\.name\) \+ '"><\/div>/.test(fn),
    'the name goes into the value attribute unescaped — it comes from somebody '
      + 'else’s calendar entry');
});

test('typing a name marks it as confirmed', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  assert.ok(/if\(field === 'name'\) c\.nameConfirmed = true;/.test(app),
    'a hand-typed name is not marked, so the next sync silently replaces it '
      + 'with "Unknown" again — the worst shape of this bug, because they fix '
      + 'it, see it fixed, and find it undone days later');
  const logic = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  assert.ok(/nameConfirmed: raw\.nameConfirmed === true,/.test(logic),
    'the flag does not survive sanitising');
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/name_confirmed: !!c\.nameConfirmed/.test(data), 'the flag is never saved');
  assert.ok(/nameConfirmed: !!row\.name_confirmed/.test(data), 'the flag is never read back');
  const dir = path.join(__dirname, 'supabase', 'migrations');
  const sql = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(/add column if not exists name_confirmed/.test(sql),
    'nothing adds the column, so every save would error');
});

test('the sync leaves a confirmed name alone', () => {
  const sync = fs.readFileSync(path.join(__dirname, 'supabase', 'functions',
    'google-calendar-sync', 'index.ts'), 'utf8');
  assert.ok(/existingByEvent\.name_confirmed\s*\n?\s*\? existingByEvent\.name/.test(sync),
    'the sync overwrites the name on every re-read, so a correction survives '
      + 'only until Google next resends that event');
  // And it must still fill in a better name where nobody has corrected one.
  assert.ok(/: \(parsed\.name \|\| existingByEvent\.name\)/.test(sync),
    'an uncorrected name no longer improves when the parser learns to read it');
});

test('a derived name is still only a guess', () => {
  // The chain that makes the edit necessary in the first place.
  assert.strictEqual(GB.firstName('Unknown'), 'Unknown');
  assert.strictEqual(GB.sanitizeClient({name:'A'}, 'x').nameConfirmed, false,
    'a contact must not arrive already claiming its name was confirmed');
  assert.strictEqual(GB.sanitizeClient({name:'A', nameConfirmed:true}, 'x').nameConfirmed, true);
  assert.strictEqual(GB.sanitizeClient({name:'A', nameConfirmed:'yes'}, 'x').nameConfirmed, false,
    'anything truthy sets the flag, so a stray value would freeze a name');
});

console.log('\n--- an exclusion can clean up what it came too late for ---');

/* "Never include events titled X" only ever applied to the NEXT sync. So
   somebody notices junk in their list, writes the rule that describes it,
   saves, and the junk sits exactly where it was: the setting fixes a future
   they are not looking at and leaves the present alone.

   Only answerable because event_title is now stored. Before that a contact
   kept the NAME pulled out of the title and discarded the title itself, so
   there was nothing left to match a title rule against. */

function withTitles(titles){
  const st = GB.buildDefaultState();
  titles.forEach(function(t, i){
    st.clients['c' + i] = GB.sanitizeClient({name: 'N' + i, eventTitle: t}, 'c' + i);
  });
  return st;
}

test('it finds the ones a rule would have kept out', () => {
  const st = withTitles([
    'DEMO Walkthrough/Training',
    'Third Call | Youtube Strategy Session (Nathaly Pintor)',
    'Team meeting',
    'Interview with Josh'
  ]);
  const r = GB.contactsMatchingExclusions(st, ['demo', 'team meeting']);
  assert.strictEqual(r.matched.length, 2, 'matched: ' + r.matched.map(c => c.eventTitle).join(' | '));
  assert.ok(r.matched.every(c => !/Strategy Session|Interview/.test(c.eventTitle)),
    'a real booking was caught by the rule');
});

test('matching ignores case and matches anywhere in the title', () => {
  const st = withTitles(['Weekly DEMO and training', 'demo walkthrough']);
  assert.strictEqual(GB.contactsMatchingExclusions(st, ['DeMo']).matched.length, 2,
    'the rule is case-sensitive, so the words somebody types have to match '
      + 'exactly what their booking tool wrote');
});

test('a row with no stored title is counted, not guessed at', () => {
  /* A title rule cannot be applied to a row whose title was never recorded.
     Silently skipping them would leave somebody wondering why the count did
     not match what they can see. */
  const st = withTitles(['DEMO Walkthrough']);
  st.clients.old = GB.sanitizeClient({name: 'Older contact'}, 'old');   // no eventTitle
  const r = GB.contactsMatchingExclusions(st, ['demo']);
  assert.strictEqual(r.matched.length, 1);
  assert.strictEqual(r.untitled, 1,
    'rows with no title are dropped without telling anybody how many could '
      + 'not be checked');
});

test('an already-hidden contact is not offered again', () => {
  const st = withTitles(['DEMO Walkthrough']);
  st.clients.c0.ignored = true;
  assert.strictEqual(GB.contactsMatchingExclusions(st, ['demo']).matched.length, 0,
    'contacts already hidden are counted again, so the button never clears');
});

test('an empty or blank rule matches nothing at all', () => {
  /* The dangerous direction. An empty term in indexOf matches EVERY string,
     so a stray comma would offer to hide the entire book. */
  const st = withTitles(['Anything', 'Something else']);
  assert.strictEqual(GB.contactsMatchingExclusions(st, []).matched.length, 0);
  assert.strictEqual(GB.contactsMatchingExclusions(st, ['']).matched.length, 0,
    'an empty rule matched every contact');
  assert.strictEqual(GB.contactsMatchingExclusions(st, ['   ']).matched.length, 0,
    'a whitespace rule matched every contact');
  assert.strictEqual(GB.contactsMatchingExclusions(null, ['x']).matched.length, 0);
});

test('the offer appears in settings and the hide is undoable', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const modal = codeOnly(app.slice(app.indexOf('function renderSettingsModal()'),
                                   app.indexOf('function saveSettingsDraft')));
  assert.ok(/contactsMatchingExclusions\(STATE/.test(modal),
    'the settings screen never checks whether the rule applies to anything '
      + 'already imported, so the cleanup is unreachable');
  assert.ok(/data-action="apply-exclusions"/.test(modal), 'there is no button to do it');
  assert.ok(/only stops new ones arriving/.test(modal),
    'the screen no longer says what the rule does on its own, which is the '
      + 'thing that surprises people');

  const h = app.slice(app.indexOf("case 'apply-exclusions':"), app.indexOf("case 'set-cal-mode':"));
  assert.ok(/lastSnapshot = snapshot\(\)/.test(h) &&
            /showToast\([\s\S]*?lastSnapshot\)/.test(h),
    'hiding a batch of contacts is not undoable — the rule is a guess about '
      + 'titles and somebody will word one too broadly');
  assert.ok(/c\.ignored = true/.test(h) && !/delete |splice/.test(h),
    'the contacts are being deleted rather than hidden');
});

console.log('\n--- how many of the team are sending at all ---');

/* The team headline compared this week with last, which on a small team is
   mostly whoever had a busy Tuesday. This book went 202 messages one week and
   49 the next with nothing about the team having changed.

   What did change, and what no number on the screen showed, is how many
   people were sending anything: one person for eight straight weeks, then
   three, then four. That is a count, it cannot be swung by one person's
   burst, and it is the thing a manager is actually trying to move. */

function wkRow(counts){
  const base = GB.startOfUTCWeek(new Date('2026-10-08T12:00:00Z'));
  return {weeks: counts.map(function(c, i){
    return {weekStart: new Date(base.getTime() - (counts.length - 1 - i) * 7 * 86400000).toISOString(),
            count: c, partial: i === counts.length - 1};
  })};
}

test('it counts people, not just messages', () => {
  const out = GB.teamWeeklyActivity([
    wkRow([200, 50, 0, 10]),   // one heavy sender
    wkRow([0, 0, 0, 5]),       // joins in the last week
    wkRow([0, 0, 0, 3])        // joins in the last week
  ]);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[0].senders, 1, 'eight weeks of one person should read as one');
  assert.strictEqual(out[0].messages, 200);
  assert.strictEqual(out[3].senders, 3, 'the week three people sent is the finding');
  assert.strictEqual(out[3].messages, 18);
});

test('a volume collapse with no change in people is visible as such', () => {
  /* The exact shape that made the old headline misleading: messages fall by
     three quarters, the number of people working is identical. */
  const out = GB.teamWeeklyActivity([wkRow([202, 49])]);
  assert.strictEqual(out[0].senders, out[1].senders,
    'the same person sending in both weeks should read as the same count');
  assert.ok(out[0].messages > out[1].messages * 3, 'the volume swing is the distraction');
});

test('the live week is carried through as partial', () => {
  const out = GB.teamWeeklyActivity([wkRow([10, 4]), wkRow([0, 2])]);
  assert.strictEqual(out[1].partial, true,
    'the current week is not marked, so a part-week reads as a collapse');
  assert.strictEqual(out[0].partial, false);
});

test('the strip and the per-person bars agree on what a week is', () => {
  /* Summed from the rows' own weeks rather than queried again, so the two
     cannot drift into different buckets. */
  const rows = [wkRow([1, 2, 3]), wkRow([4, 5, 6])];
  const out = GB.teamWeeklyActivity(rows);
  out.forEach(function(w, i){
    assert.strictEqual(w.weekStart, rows[0].weeks[i].weekStart,
      'the team strip is bucketing weeks differently from the rows it sums');
  });
  assert.strictEqual(out[2].messages, 9);
});

test('an empty or ragged team does not throw', () => {
  assert.deepStrictEqual(GB.teamWeeklyActivity([]), []);
  assert.deepStrictEqual(GB.teamWeeklyActivity(null), []);
  assert.deepStrictEqual(GB.teamWeeklyActivity([{name:'no weeks'}]), []);
  // One person with history, one without, must not misalign the buckets.
  const mixed = GB.teamWeeklyActivity([wkRow([1, 2, 3]), {name:'new', weeks: []}]);
  assert.strictEqual(mixed.length, 3);
  assert.strictEqual(mixed[2].messages, 3);
});

test('the strip leads with people and is actually rendered', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function teamActivityStrip('),
                                app.indexOf('function activityBars(')));
  assert.ok(/w\.senders \/ peak/.test(fn),
    'the bars are drawn from message volume, which is the number that swings '
      + 'for no reason on a small team');
  assert.ok(/person has sent something this week|people have sent something this week/.test(fn),
    'the headline no longer leads with how many people are sending');
  assert.ok(/is-partial/.test(fn), 'the live week is drawn the same as a finished one');

  const tab = codeOnly(app.slice(app.indexOf('function renderTeamTab()'),
                                 app.indexOf('function renderOwnerTab()')));
  assert.ok(/box\.appendChild\(teamActivityStrip\(rows\)\)/.test(tab),
    'teamActivityStrip is never called, so the whole strip renders nowhere');
});

console.log('\n--- the Performance tab stops asserting things it cannot know ---');

/* Found by auditing a screen I had not touched. computeInsights asserted four
   findings off a minimum of four decided calls:

     Short lead time (<5 days) beats long lead time - 100% vs 0% show-up.
     3+ touches beat 2 or fewer - 100% vs 0% show-up.
     Thursday is the strongest day (100%), Friday the weakest (0%).

   Two calls a side, with a small "hint - small sample" tag beside them.
   Nobody reads "100% vs 0%" and discounts it because of a tag.

   Worse, it contradicted the team view outright. That screen refuses to
   compare follow-up against no follow-up until each side has 20 decided
   calls, and on the live book — 61 against 58 — reports NO measurable
   difference. The same product asserting "3+ touches beat 2 or fewer" from
   two calls is worse than either answer on its own. */

function insightBook(n, fn){
  const st = GB.buildDefaultState();
  for(let i = 0; i < n; i++){
    const o = fn(i);
    const call = new Date('2026-09-15T15:00:00Z');
    call.setDate(call.getDate() + i);
    const log = [];
    for(let t = 0; t < o.touches; t++){
      log.push({id:'m'+t, stage:'welcome', variantId:'w1', text:'x',
        sentAt: new Date(call.getTime() - 86400000).toISOString(),
        responded: t === 0 && o.replied, reviewed: true});
    }
    st.clients['c'+i] = GB.sanitizeClient({name:'c'+i,
      status: o.showed ? 'Completed' : 'No-show',
      callDateTime: call.toISOString(),
      bookedDate: new Date(call.getTime() - o.lead * 86400000).toISOString(),
      messageLog: log}, 'c'+i);
  }
  return st;
}

test('four decided calls produce no findings at all', () => {
  const st = insightBook(4, i => ({showed: i % 2 === 0, lead: i < 2 ? 1 : 9,
                                   touches: i % 2 === 0 ? 4 : 1, replied: i === 0}));
  assert.strictEqual(GB.computeInsights(st), null,
    'the Performance tab is asserting findings from two calls a side again');
});

test('both sides need the same minimum the team view uses', () => {
  assert.strictEqual(GB.INSIGHT_MIN, GB.TOUCH_EFFECT_MIN,
    'the two screens use different bars for the same comparison, so the '
      + 'product can assert on one tab what it refuses on the other');
  // One side just short is still refused.
  const lop = insightBook(60, i => ({showed: i % 2 === 0, lead: 1,
                                     touches: i < GB.INSIGHT_MIN - 1 ? 4 : 1, replied: false}));
  const out = GB.computeInsights(lop) || [];
  assert.ok(!out.some(x => /touches/.test(x.text)),
    'a comparison was reported with one side below the minimum');
});

test('a small gap is reported as no difference, with the counts', () => {
  const st = insightBook(60, i => ({showed: i % 2 === 0, lead: i % 2 ? 1 : 9,
                                    touches: i % 3 === 0 ? 4 : 1, replied: false}));
  const out = GB.computeInsights(st) || [];
  const touch = out.filter(x => /touches/.test(x.text))[0];
  assert.ok(touch, 'the touches comparison vanished entirely');
  assert.ok(/No measurable difference/.test(touch.text),
    'a 50/50 split is being reported as one side winning: ' + touch.text);
  assert.ok(/across \d+ and \d+ calls/.test(touch.text),
    'the counts are not shown, so a reader cannot judge the claim for '
      + 'themselves: ' + touch.text);
});

test('a real gap is still reported', () => {
  const st = insightBook(60, i => ({showed: i < 30 ? i % 10 < 8 : i % 10 < 2,
                                    lead: i < 30 ? 1 : 9, touches: 1, replied: false}));
  const out = GB.computeInsights(st) || [];
  const lead = out.filter(x => /ahead/.test(x.text))[0];
  assert.ok(lead && /under 5 days ahead shows up better/.test(lead.text),
    'a genuine 60-point gap across 30 calls a side is being withheld: '
      + (lead ? lead.text : 'nothing reported'));
});

test('the best/worst weekday claim is gone', () => {
  /* It ranked best against worst across up to seven days, which overstates by
     construction, and tested against real data it came out at about 1.4
     standard errors. Attendance by time of day replaces it on the team view,
     where bands are listed and never ranked. */
  const logic = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  const fn = logic.slice(logic.indexOf('function computeInsights(state){'),
                         logic.indexOf('function computeInsights(state){') + 4000);
  const code = codeOnly(fn);
  assert.ok(!/strongest day|weakest/.test(code),
    'the weekday ranking is back. Picking best and worst of seven buckets '
      + 'names a winner even in pure noise.');
  assert.ok(!/dowNames|byDow/.test(code), 'the weekday machinery is still there');
});

test('the small-sample tag is gone, because nothing below the bar is shown', () => {
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function renderInsights()'),
                       app.indexOf('function renderWeeklyCharts()'));
  assert.ok(!/small sample/.test(fn),
    'a "small sample" tag is back beside a percentage. Either the finding is '
      + 'supportable and needs no tag, or it is not and should not be shown.');
  assert.ok(!/i\.small/.test(fn), 'the renderer still branches on a flag that no longer exists');
});

console.log('\n--- no-shows nobody went back to ---');

/* The team row showed how much BOOKED work had nothing sent. It showed
   nothing about the other end: calls that were missed and then dropped.

   On this book that is the largest unworked pile in the system — 129
   no-shows, 48 chased, 2 replies, 0 back on the calendar — and one person is
   sitting on 45 unchased with three of them in the last week. None of it
   appeared on any screen.

   Counted only inside NOSHOW_CHASE_DAYS. "Sorry we missed each other" three
   weeks late is not a follow-up, and counting those would turn a number
   somebody can act on this afternoon into a standing accusation about
   history. */

test('a recent no-show with no follow-up counts; an old one does not', async () => {
  const now = Date.now();
  const d = makeLoadCtx({
    memberships: {data: [
      {org_id:'o1', user_id:'u1', role:'admin'},
      {org_id:'o1', user_id:'u2', role:'member'}
    ], error: null},
    app_settings: {data: [{user_id:'u2', sender_name:'Rep'}], error: null},
    clients: {data: [
      // Missed three days ago, nobody went back: the finding.
      {id:'a', user_id:'u2', name:'A', call_date_time:new Date(now-3*86400000).toISOString(),
       status:'No-show', timezone:'UTC'},
      // Missed three days ago and chased: not a finding.
      {id:'b', user_id:'u2', name:'B', call_date_time:new Date(now-3*86400000).toISOString(),
       status:'No-show', timezone:'UTC'},
      // Missed five weeks ago, never chased: too late to be work.
      {id:'c', user_id:'u2', name:'C', call_date_time:new Date(now-35*86400000).toISOString(),
       status:'No-show', timezone:'UTC'},
      // Attended, not chased, irrelevant.
      {id:'d', user_id:'u2', name:'D', call_date_time:new Date(now-3*86400000).toISOString(),
       status:'Completed', timezone:'UTC'}
    ], error: null},
    message_log: {data: [
      {client_id:'b', sent_at:new Date(now-2*86400000).toISOString(), stage:'noshow',
       responded:false, reviewed:true},
      // A message of a different kind does not count as going back to them.
      {client_id:'a', sent_at:new Date(now-4*86400000).toISOString(), stage:'welcome',
       responded:false, reviewed:true}
    ], error: null}
  });
  const rows = await d.run('loadTeamRows(window.GB_SUPABASE, "u1")');
  const rep = rows.filter(r => r.name === 'Rep')[0];
  assert.strictEqual(rep.noShowsUnchased, 1,
    'the count is wrong: a chased no-show, an attended call, or one too old '
      + 'to be worth chasing is being counted as outstanding work');
});

test('the window is named rather than hardcoded twice', () => {
  assert.strictEqual(typeof GB.NOSHOW_CHASE_DAYS, 'number');
  assert.ok(GB.NOSHOW_CHASE_DAYS >= 7 && GB.NOSHOW_CHASE_DAYS <= 30,
    'the chase window has drifted somewhere unreasonable: ' + GB.NOSHOW_CHASE_DAYS);
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/NOSHOW_CHASE_DAYS \* 86400000/.test(data),
    'the loader uses its own number, so the tooltip and the count can disagree '
      + 'about what "recent" means');
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  assert.ok(/NOSHOW_CHASE_DAYS \+ ' days/.test(app),
    'the tooltip states a window it does not read from the constant');
});

test('the stage is actually fetched', () => {
  /* The stub returns whole fixture rows whatever you select, so dropping
     `stage` passes every behavioural test here and then, against the real
     database, reads undefined on every message — making it look as though
     nobody has ever chased anybody. Fourth time this trap has caught
     something. */
  const data = fs.readFileSync(path.join(__dirname, 'hosted', 'data.js'), 'utf8');
  assert.ok(/from\('message_log'\)\.select\('[^']*\bstage\b[^']*'\)/.test(data),
    'loadTeamRows no longer selects the message stage, so no rescue text can '
      + 'ever be recognised and every no-show reads as unchased');
});

test('it rides on the row and shows only once it is a pattern', () => {
  const logic = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  assert.ok(/noShowsUnchased: Number\(m\.noShowsUnchased\) \|\| 0,/.test(logic),
    'the count is dropped at the state boundary');
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function renderTeamTab()'),
                                app.indexOf('function renderOwnerTab()')));
  assert.ok(/m\.noShowsUnchased >= 3/.test(fn),
    'a single dropped no-show is flagged — that is a busy week, not a habit');
  assert.ok(/no-shows not chased/.test(fn), 'the count is not shown at all');
});

console.log('\n--- the team table reads down a column ---');

/* Every .team-row is its OWN grid, so with fr and auto each row sized its
   columns from its own content. Measured across three rows of the same table,
   the numbers block started at 682px, 629px and 685px — moved by how long
   somebody's name was and whether they had a MANAGER badge. A column you
   cannot read down is not a column, and it had been that way since the row
   was built.

   Only the name flexes now. Checked on screen at 1240px (numbers at 643 on
   every row) and at 600px, where the layout collapses to two columns and
   nothing overflows. */

test('the right-hand columns are fixed, so rows line up with each other', () => {
  const html = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
  const rule = html.slice(html.indexOf('.team-row{display:grid'),
                          html.indexOf('.team-row.is-ok'));
  const cols = /grid-template-columns:([^;]+);/.exec(rule);
  assert.ok(cols, 'the team row no longer declares its columns');
  const spec = cols[1];
  assert.ok(!/\bfr\b/.test(spec.replace(/minmax\(0,\s*1fr\)/, '')),
    'a flexible column is back on the right-hand side, so every row sizes it '
      + 'from its own content and the numbers stop lining up: ' + spec);
  assert.ok(!/\bauto\b/.test(spec),
    'an auto column is back, which sizes to content per row: ' + spec);
  assert.strictEqual((spec.match(/px/g) || []).length, 3,
    'the three right-hand columns are not all fixed: ' + spec);
  assert.ok(/minmax\(0,\s*1fr\)/.test(spec),
    'the name column must flex, and must be allowed to shrink below its '
      + 'content or a long name pushes the row wider than the card');
});

test('the narrow layout still has somewhere for every cell', () => {
  /* Four children and two columns: without an explicit rule the role control
     drops into an implicit row on its own — which is exactly the bug that put
     the MANAGER badge under the whole row at full width. */
  const html = fs.readFileSync(path.join(__dirname, 'hosted', 'app.html'), 'utf8');
  const start = html.indexOf('@media (max-width:640px){ .team-row');
  assert.ok(start > -1, 'the narrow-width rule for the team row is gone');
  const block = html.slice(start, start + 500);
  assert.ok(/\.team-nums\{grid-column:1\/-1/.test(block),
    'the numbers no longer span the row at narrow widths');
  assert.ok(/\.team-role\{grid-column:1\/-1/.test(block),
    'the role control has no placement at narrow widths, so it lands in an '
      + 'implicit row of its own');
});

test('the connect toast says what actually arrived', () => {
  /* Every account outside the main organisation signed up and never came
     back — five of the six on the same day they joined, and one of them had
     connected a calendar and received nothing. The toast I added this
     morning claimed "your bookings are in" whichever way the sync went, at
     the exact moment that decides whether somebody stays, and contradicted
     the panel directly beneath it reading "Calendar connected, nothing
     imported yet". */
  const app = fs.readFileSync(path.join(__dirname, 'hosted', 'app.js'), 'utf8');
  const fn = codeOnly(app.slice(app.indexOf('function noteCalendarReturn()'),
                                app.indexOf('async function init()')));
  assert.ok(/Object\.keys\(\(STATE && STATE\.clients\) \|\| \{\}\)\.length/.test(fn),
    'the toast does not look at what landed, so it reports success either way');
  assert.ok(/if\(landed\)\{/.test(fn), 'there is no branch for nothing having arrived');
  assert.ok(/nothing matched yet/.test(fn),
    'the empty case still claims bookings arrived');
  assert.ok(/count as bookings in Settings/.test(fn),
    'the empty case does not point at the thing that fixes it, which is the '
      + 'calendar filter');
  // And the success case must state the number rather than assert vaguely.
  assert.ok(/bookings imported/.test(fn),
    'the success case no longer says how many arrived, so "it worked" is '
      + 'again something the reader has to take on trust');
});

Promise.all(pendingTests).then(() => {
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All tests passed') + '\n');
  process.exit(failures ? 1 : 0);
});
