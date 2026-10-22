#!/usr/bin/env python3
"""Ghost Recall Messages agent.

Reads this Mac's Messages database and pushes CLIENT conversations into Ghost
Recall, so texts you send and receive from your own number show up as threads
in the app instead of living only on your phone.

Apple provides no way to read iMessage except from a Mac signed into that
Apple ID, which is why this runs here rather than on a server.

--------------------------------------------------------------------------
What leaves this machine
--------------------------------------------------------------------------
Only messages with phone numbers that are already clients in Ghost Recall.

That is not a filter applied after uploading -- the agent asks the server which
numbers are clients, and everything else never travels. On the machine this was
written against the database held 56,000 messages, overwhelmingly personal, and
none of those belong in a CRM. Conversations with family, friends, group chats
and anybody who is not a client are never read past their phone number.

Nothing is ever written back to Messages. This only reads.

--------------------------------------------------------------------------
Setup
--------------------------------------------------------------------------
1. Grant Full Disk Access to Terminal (System Settings -> Privacy & Security
   -> Full Disk Access). Without it macOS blocks reading the Messages
   database, and the agent will say so rather than silently syncing nothing.
2. Get a device token from Ghost Recall: Menu -> Business settings -> Connect
   this Mac. It is shown once.
3. Save it:   python3 tools/imessage-agent.py --set-token
   It asks you to paste it and stores it in ~/.ghost-recall-token, mode 0600.
   Deliberately not a command-line argument: a command containing a secret
   lands in shell history, and a command containing a placeholder gets run
   verbatim.
4. See what it would do:  python3 tools/imessage-agent.py --dry-run
   Then for real:         python3 tools/imessage-agent.py
   Or leave it running:   python3 tools/imessage-agent.py --watch

No packages to install. Standard library only.
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.request

ENDPOINT = os.environ.get(
    'GR_ENDPOINT',
    'https://gqfpsjksosxvszzhhezu.supabase.co/functions/v1/imessage-sync')
CHAT_DB = os.path.expanduser('~/Library/Messages/chat.db')
STATE_PATH = os.path.expanduser('~/.ghost-recall-agent.json')
# The token lives in a file rather than being pasted on the command line.
#
# A command containing a placeholder is a command somebody runs verbatim --
# it has already happened in this project, with an API key set to the literal
# string "re_yourNewKeyHere". A token on the command line also ends up in
# shell history, which is a poor home for a long-lived credential.
TOKEN_PATH = os.path.expanduser('~/.ghost-recall-token')

# Apple stores dates as nanoseconds since 2001-01-01 UTC.
APPLE_EPOCH = 978307200

# U+FFFC OBJECT REPLACEMENT CHARACTER: where an attachment sits in the text.
OBJ_PLACEHOLDER = '\ufffc'


def _typedstream_len(b, i):
    """A typedstream length at `i`, as (value, index after it).

    Short lengths are one byte. Longer ones are a marker byte followed by a
    little-endian integer of 2, 4 or 8 bytes.
    """
    n = b[i]
    if n == 0x81:
        return int.from_bytes(b[i + 1:i + 3], 'little'), i + 3
    if n == 0x82:
        return int.from_bytes(b[i + 1:i + 5], 'little'), i + 5
    if n == 0x83:
        return int.from_bytes(b[i + 1:i + 9], 'little'), i + 9
    return n, i + 1


def message_body(text, blob):
    """The words of a message, wherever macOS decided to keep them.

    About a third of the messages on a real Mac have an EMPTY `text` column
    and their body in the `attributedBody` BLOB instead, an old NSArchiver
    "typedstream". This agent used to exclude those rows in SQL with
    `coalesce(m.text, '') <> ''`, which silently dropped a third of every
    conversation: a third of the replies, so reply rates read low and clients
    who had answered looked unresponsive, and a third of the outgoing
    messages, so those sends could never be matched and stayed "not
    confirmed" forever. The log said "up to date - nothing new to sync"
    throughout, so there was nothing to notice.

    That is how a client believed never to have received her day-of reminder
    turned out to have been sent two, replied to both, and cancelled: four of
    the six messages in the thread were in blobs.

    Checked against the two thirds of messages that have a `text` AND a blob,
    which makes `text` a second source for the decoder: 8,000 of them across
    the whole history -- multi-line, emoji, and one 2,620 characters long --
    decode to exactly their `text`, with no mismatches.

    An attachment's body starts with U+FFFC where the picture goes. A caption
    after it is worth keeping; a bare image decodes to the placeholder alone
    and comes back empty so the caller skips it.
    """
    if text and text.strip():
        return text
    if not blob:
        return ''
    b = bytes(blob)
    for marker in (b'NSMutableString', b'NSString'):
        start = b.find(marker)
        if start < 0:
            continue
        # A short run of framing bytes follows the class name, then '+'
        # introduces the payload.
        head = start + len(marker)
        plus = b.find(b'+', head, head + 12)
        if plus < 0:
            continue
        length, j = _typedstream_len(b, plus + 1)
        if length <= 0 or j + length > len(b):
            continue
        body = b[j:j + length].decode('utf-8', 'replace')
        return body.replace(OBJ_PLACEHOLDER, '').strip()
    return ''


def post(token, payload):
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + token},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        raise SystemExit('Server refused the request (%s): %s' % (e.code, detail))
    except urllib.error.URLError as e:
        raise SystemExit('Could not reach Ghost Recall: %s' % e.reason)


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)


def say(msg):
    """Print with a timestamp.

    Untimestamped output in a log file is indistinguishable from stale output,
    and that is not hypothetical: a frozen log was read as a live failure and
    acted on twice.
    """
    print('%s  %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg), flush=True)


def up_to_date_line(watched):
    """What a quiet sync should say.

    "Nothing new. (0 messages scanned)" is indistinguishable from a broken
    agent, which is why it got run five times in a row to check. The steady
    state deserves to look like success, with the time of the last real sync
    as the evidence.
    """
    state = load_state()
    last = state.get('lastSyncAt')
    when = ''
    if last:
        try:
            t = time.mktime(time.strptime(last[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone
            mins = int((time.time() - t) / 60)
            when = (' Last new message synced %s.'
                    % ('just now' if mins < 2 else
                       '%d minutes ago' % mins if mins < 90 else
                       '%d hours ago' % (mins // 60) if mins < 2880 else
                       '%d days ago' % (mins // 1440)))
        except Exception:
            pass
    return 'Up to date - nothing new to sync.%s Watching %d client numbers.' % (when, watched)


def read_token():
    """GR_TOKEN if set, otherwise the saved file."""
    env = os.environ.get('GR_TOKEN', '').strip()
    if env:
        return env
    try:
        with open(TOKEN_PATH) as f:
            return f.read().strip()
    except Exception:
        return ''


def save_token():
    """Ask for the token and store it readable only by this user."""
    import getpass
    tok = getpass.getpass('Paste the device token from Ghost Recall (it will not echo): ').strip()
    if not tok:
        raise SystemExit('Nothing pasted; no token saved.')
    old = os.umask(0o077)          # 0600 before the file exists, not after
    try:
        with open(TOKEN_PATH, 'w') as f:
            f.write(tok + '\n')
    finally:
        os.umask(old)
    os.chmod(TOKEN_PATH, 0o600)
    print('Saved to %s (readable only by you).' % TOKEN_PATH)
    print('Now run:  python3 tools/imessage-agent.py --dry-run')


SERVICE_LABEL = 'com.ghostrecall.imessage-agent'
SERVICE_PLIST = os.path.expanduser(
    '~/Library/LaunchAgents/%s.plist' % SERVICE_LABEL)
SERVICE_LOG = os.path.expanduser('~/Library/Logs/ghost-recall-agent.log')


def install_service():
    """Run on login, in the background, with no terminal window.

    A sync that lives in a terminal tab is a sync that stops the first time
    the window is closed or the Mac restarts -- and then quietly shows stale
    threads, which is worse than showing none. launchd restarts it and starts
    it at login.
    """
    script = os.path.abspath(__file__)
    # The REAL interpreter, not /usr/bin/python3.
    #
    # macOS grants Full Disk Access to the binary that actually executes, and
    # /usr/bin/python3 is a shim ending at python3.9 inside Command Line Tools.
    # Point launchd at the shim and the permission granted never matches the
    # process that runs: the service starts, looks healthy in launchctl, and is
    # refused by the Messages database every cycle. That is exactly what
    # happened. Resolving it here means the path added to Full Disk Access and
    # the path launchd runs are the same string.
    interpreter = os.path.realpath(sys.executable)
    plist = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%(label)s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%(python)s</string>
    <!-- -u: unbuffered.

         launchd sends stdout to a file, so Python switches from line
         buffering to block buffering and nothing reaches the log until
         several kilobytes accumulate. The log then sits frozen for hours
         while the agent is running normally -- which had me reading
         five-hour-old errors and reporting them as current. -->
    <string>-u</string>
    <string>%(script)s</string>
    <string>--watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>%(log)s</string>
  <key>StandardErrorPath</key><string>%(log)s</string>
</dict>
</plist>
""" % {'label': SERVICE_LABEL, 'script': script, 'log': SERVICE_LOG,
       'python': interpreter}

    os.makedirs(os.path.dirname(SERVICE_PLIST), exist_ok=True)
    with open(SERVICE_PLIST, 'w') as f:
        f.write(plist)
    os.system('launchctl unload %s 2>/dev/null' % SERVICE_PLIST)
    rc = os.system('launchctl load %s' % SERVICE_PLIST)
    if rc != 0:
        raise SystemExit('launchctl could not load the service. The file is at\n  %s'
                         % SERVICE_PLIST)
    print('Running in the background, and will start again at login.')
    print('\nIMPORTANT: give Full Disk Access to this exact binary, or macOS')
    print('blocks it from reading Messages and the service syncs nothing:')
    print('  %s' % interpreter)
    print('System Settings -> Privacy & Security -> Full Disk Access -> +')
    print('then Cmd+Shift+G and paste that path. Afterwards:')
    print('  launchctl kickstart -k gui/$(id -u)/%s' % SERVICE_LABEL)
    print('  log:     %s' % SERVICE_LOG)
    print('  stop it: python3 tools/imessage-agent.py --uninstall-service')
    print('\nClose any terminal tabs still running --watch; this replaces them.')


def uninstall_service():
    os.system('launchctl unload %s 2>/dev/null' % SERVICE_PLIST)
    if os.path.exists(SERVICE_PLIST):
        os.remove(SERVICE_PLIST)
    print('Background sync stopped and removed. Threads already in Ghost Recall stay.')


def open_db():
    """Work on a copy.

    Messages holds the live database open in WAL mode; querying it directly
    can fail or read a torn view mid-write. Copying the db plus its -wal and
    -shm sidecars gives a consistent snapshot, and guarantees this process
    cannot modify what Messages is using.
    """
    if not os.path.exists(CHAT_DB):
        raise SystemExit('No Messages database at %s -- is this a Mac with '
                         'Messages set up?' % CHAT_DB)
    tmpdir = tempfile.mkdtemp(prefix='gr-imsg-')
    dest = os.path.join(tmpdir, 'chat.db')
    try:
        shutil.copy2(CHAT_DB, dest)
        for ext in ('-wal', '-shm'):
            if os.path.exists(CHAT_DB + ext):
                shutil.copy2(CHAT_DB + ext, dest + ext)
    except PermissionError:
        raise SystemExit(
            'macOS blocked reading the Messages database.\n'
            'Give Full Disk Access to the app running this (usually Terminal):\n'
            '  System Settings -> Privacy & Security -> Full Disk Access\n'
            'then quit and reopen it and run this again.')
    return sqlite3.connect(dest), tmpdir


def collect(conn, since_map, since_rowid, limit):
    """Messages newer than the last sync, for client numbers only.

    Three filters, and the last two were added after the first real run put
    somebody's 2023 group chat into the CRM:

    ONE-TO-ONE CHATS ONLY. In the Messages database a group message is
    attributed to whoever sent it, not to the group. So a single participant
    whose number happens to match a client pulls that entire group thread in
    -- which is how "good shit on the likes boys" ended up filed against a
    client. Restricting to chats with exactly one participant is the fix;
    group chats are not client conversations and never were.

    NOT BEFORE THEY WERE A CLIENT. Each number carries the date its contact
    was created in Ghost Recall, and anything older is personal history that
    happens to share a phone number. A booking made this year says nothing
    about a conversation from 2023.

    CLIENT NUMBERS ONLY, applied in SQL, so non-client conversations are never
    loaded into this process at all.
    """
    cur = conn.cursor()
    rows = cur.execute("""
        select m.ROWID, m.guid, h.id, m.is_from_me, m.service,
               m.date/1000000000 + ? as epoch,
               coalesce(m.text, ''),
               case when trim(coalesce(m.text, '')) <> '' then null
                    else m.attributedBody end
          from message m
          join handle h on h.ROWID = m.handle_id
          join chat_message_join cmj on cmj.message_id = m.ROWID
          join chat ch on ch.ROWID = cmj.chat_id
         where m.ROWID > ?
           and m.associated_message_type = 0
           and ch.style = 45
           and (select count(*) from chat_handle_join chj
                 where chj.chat_id = ch.ROWID) = 1
         group by m.ROWID
         order by m.ROWID asc
         limit ?
    """, (APPLE_EPOCH, since_rowid, limit)).fetchall()

    out, top = [], since_rowid
    for rowid, guid, handle, from_me, service, epoch, text, blob in rows:
        top = max(top, rowid)         # before any skip, or these rescan forever
        text = message_body(text, blob)
        if not text:
            continue          # a bare image, or a body we could not read
        digits = ''.join(ch for ch in (handle or '') if ch.isdigit())
        key = digits[-10:] if len(digits) > 10 else digits
        if len(key) != 10 or key not in since_map:
            continue          # not a client: nothing about it leaves this Mac
        if not epoch or epoch < 0:
            continue
        if epoch < since_map[key]:
            continue          # predates the client relationship
        out.append({
            'guid': guid,
            'phone': handle,
            'fromMe': bool(from_me),
            'service': service,
            'at': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(epoch)) + 'Z',
            'text': text,
        })
    return out, top, len(rows)


def fetch_since_map(token):
    """{phone key: earliest epoch worth syncing} from the server.

    The cut-off travels with each number rather than being one global date,
    because a contact added last week and one from a year ago have different
    answers, and a single "last N days" rule would either lose real history or
    sweep in personal history.
    """
    res = post(token, {'action': 'numbers'})
    out = {}
    for row in (res.get('numbers') or []):
        if isinstance(row, dict):
            key, since = row.get('key'), row.get('since')
        else:
            key, since = row, None
        if not key:
            continue
        epoch = 0
        if since:
            try:
                epoch = int(time.mktime(time.strptime(since[:19], '%Y-%m-%dT%H:%M:%S'))
                            - time.timezone)
            except Exception:
                epoch = 0
        out[key] = epoch
    return out


def scan_all(conn, numbers, since, page=5000, on_batch=None):
    """Walk forward from `since` to the end of the database.

    One pass per run, not one page per run. The first sync has to cross the
    whole history -- 56,000 messages on the machine this was written against,
    whose oldest rows predate every client by years -- and a version that
    stopped after one page would have reported "0 messages" 27 times before
    reaching anything that mattered. That is exactly what the first run of
    this did.
    """
    found, scanned, top = [], 0, since
    while True:
        batch, top, n = collect(conn, numbers, top, page)
        scanned += n
        if batch:
            found.extend(batch)
            if on_batch:
                on_batch(batch)
                found = []          # caller took them; do not hold the lot in memory
        if n < page:
            break
    return found, top, scanned


def sync_once(token, verbose=True, reset=False, max_messages=0):
    numbers = fetch_since_map(token)
    if not numbers:
        print('No client phone numbers to look for yet. Nothing to sync.')
        return 0

    state = {} if reset else load_state()
    since = int(state.get('lastRowId', 0))
    totals = {'sent': 0, 'inbound': 0, 'outbound': 0, 'linked': 0, 'skipped': 0, 'failed': 0}

    def push(batch):
        # A ceiling for a first cautious run. Without it the opening sync of a
        # long history writes a couple of thousand rows before anybody has
        # seen one, and the only honest way to check the matching is right is
        # to look at a handful first.
        if max_messages and totals['sent'] >= max_messages:
            return
        if max_messages:
            batch = batch[:max_messages - totals['sent']]
        for i in range(0, len(batch), 200):
            chunk = batch[i:i + 200]
            res = post(token, {'action': 'push', 'messages': chunk})
            totals['sent'] += len(chunk)
            for k in ('inbound', 'outbound', 'linked', 'skipped', 'failed'):
                totals[k] += res.get(k, 0)
            # Loudly. A sync that reports a tidy total while the server
            # rejected every row is the worst possible outcome, and is
            # exactly what happened the first time this ran.
            if res.get('failed'):
                print('  !! %d of %d rejected by the server: %s'
                      % (res['failed'], len(chunk), res.get('error', 'no reason given')))

    conn, tmpdir = open_db()
    try:
        _, top, scanned = scan_all(conn, numbers, since, on_batch=push)
    finally:
        conn.close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    state['lastRowId'] = top
    state['lastSyncAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    save_state(state)

    if verbose:
        if totals['sent']:
            say('Synced %d messages: %d replies, %d texts you sent, '
                '%d matched to sends already logged, %d skipped, %d REJECTED.'
                  % (totals['sent'], totals['inbound'], totals['outbound'],
                     totals['linked'], totals['skipped'], totals['failed']))
        else:
            say(up_to_date_line(len(numbers)))
    return totals['sent']


def main():
    ap = argparse.ArgumentParser(description='Sync client text threads into Ghost Recall.')
    ap.add_argument('--watch', action='store_true', help='keep running, sync every few minutes')
    ap.add_argument('--interval', type=int, default=120, help='seconds between syncs with --watch')
    ap.add_argument('--reset', action='store_true',
                    help='forget the sync position and re-scan from the beginning')
    ap.add_argument('--dry-run', action='store_true',
                    help='report what would be sent without sending anything')
    ap.add_argument('--max', type=int, default=0, dest='max_messages',
                    help='stop after this many messages (for a first cautious run)')
    ap.add_argument('--set-token', action='store_true',
                    help='paste the device token once and save it to ~/.ghost-recall-token')
    ap.add_argument('--install-service', action='store_true',
                    help='run in the background from now on, and at every login')
    ap.add_argument('--uninstall-service', action='store_true',
                    help='stop the background sync')
    args = ap.parse_args()

    if args.set_token:
        save_token()
        return

    if args.uninstall_service:
        uninstall_service()
        return

    if args.install_service:
        if not read_token():
            raise SystemExit('Save a device token first:  '
                             'python3 tools/imessage-agent.py --set-token')
        install_service()
        return

    token = read_token()
    if not token:
        raise SystemExit(
            'No device token yet.\n'
            'In Ghost Recall: Menu -> Business settings -> Connect this Mac,\n'
            'then save the token with:\n'
            '    python3 tools/imessage-agent.py --set-token\n'
            'It will ask you to paste it, and nothing is written to your shell history.')

    if args.dry_run:
        numbers = fetch_since_map(token)
        state = {} if args.reset else load_state()
        conn, tmpdir = open_db()
        try:
            batch, top, scanned = scan_all(conn, numbers, int(state.get('lastRowId', 0)))
        finally:
            conn.close()
            shutil.rmtree(tmpdir, ignore_errors=True)
        ins = sum(1 for m in batch if not m['fromMe'])
        if batch:
            print('Would send %d messages (%d replies, %d sent by you) across %d client numbers.'
                  % (len(batch), ins, len(batch) - ins, len({m['phone'] for m in batch})))
            print('Scanned %d new messages; everything else stays on this Mac.' % scanned)
        else:
            # "0 messages" on its own reads as a failure, and it is the
            # opposite: it is the steady state once the first sync has caught
            # up. Saying so plainly is the difference between trusting this
            # and running it five more times to check.
            say(up_to_date_line(len(numbers)))
        return

    if args.watch:
        print('Watching Messages. Ctrl-C to stop.')
        while True:
            try:
                sync_once(token, reset=args.reset, max_messages=args.max_messages)
                args.reset = False
            except SystemExit as e:
                say('sync failed: %s' % e)
            except Exception as e:                    # keep the watcher alive
                say('sync failed: %r' % e)
            time.sleep(max(30, args.interval))
    else:
        sync_once(token, reset=args.reset, max_messages=args.max_messages)


if __name__ == '__main__':
    main()
