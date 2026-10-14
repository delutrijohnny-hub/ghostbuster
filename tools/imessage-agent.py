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
3. Run:   GR_TOKEN=<token> python3 tools/imessage-agent.py
   Add --watch to keep it running and sync every couple of minutes.

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

# Apple stores dates as nanoseconds since 2001-01-01 UTC.
APPLE_EPOCH = 978307200


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
               coalesce(m.text, '')
          from message m
          join handle h on h.ROWID = m.handle_id
          join chat_message_join cmj on cmj.message_id = m.ROWID
          join chat ch on ch.ROWID = cmj.chat_id
         where m.ROWID > ?
           and coalesce(m.text, '') <> ''
           and m.associated_message_type = 0
           and ch.style = 45
           and (select count(*) from chat_handle_join chj
                 where chj.chat_id = ch.ROWID) = 1
         group by m.ROWID
         order by m.ROWID asc
         limit ?
    """, (APPLE_EPOCH, since_rowid, limit)).fetchall()

    out, top = [], since_rowid
    for rowid, guid, handle, from_me, service, epoch, text in rows:
        top = max(top, rowid)
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
            print('Synced %d messages: %d replies, %d texts you sent, '
                  '%d matched to sends already logged, %d skipped, %d REJECTED.'
                  % (totals['sent'], totals['inbound'], totals['outbound'],
                     totals['linked'], totals['skipped'], totals['failed']))
        else:
            print('Nothing new. (%d messages scanned, %d client numbers watched)'
                  % (scanned, len(numbers)))
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
    args = ap.parse_args()

    token = os.environ.get('GR_TOKEN', '').strip()
    if not token:
        raise SystemExit('Set GR_TOKEN to the device token from Ghost Recall '
                         '(Business settings -> Connect this Mac).')

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
        print('Would send %d messages (%d replies, %d sent by you) across %d client numbers.'
              % (len(batch), ins, len(batch) - ins, len({m['phone'] for m in batch})))
        print('Scanned %d messages; everything else stays on this Mac.' % scanned)
        return

    if args.watch:
        print('Watching Messages. Ctrl-C to stop.')
        while True:
            try:
                sync_once(token, reset=args.reset, max_messages=args.max_messages)
                args.reset = False
            except SystemExit as e:
                print('sync failed: %s' % e)
            except Exception as e:                    # keep the watcher alive
                print('sync failed: %r' % e)
            time.sleep(max(30, args.interval))
    else:
        sync_once(token, reset=args.reset, max_messages=args.max_messages)


if __name__ == '__main__':
    main()
