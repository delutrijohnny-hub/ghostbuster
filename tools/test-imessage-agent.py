#!/usr/bin/env python3
"""Tests for the Mac agent. Standard library only, like the agent itself.

    python3 tools/test-imessage-agent.py

These cover `message_body`, which reads a message out of the `attributedBody`
BLOB when the `text` column is empty -- about a third of the messages on a
real Mac. The decoder was first checked against 8,000 messages that have BOTH
a `text` and a blob, which makes `text` an independent second source. That
check cannot run anywhere else, because it needs a populated chat.db, so the
cases below rebuild Apple's byte layout from scratch and keep it honest here.

The fixtures are faithful to real blobs. A short one on this machine reads:

    \\x04\\x0bstreamtyped\\x81\\xe8\\x03\\x84\\x01@\\x84\\x84\\x84\\x12NSAttributedString\\x00
    \\x84\\x84\\x08NSObject\\x00\\x85\\x92\\x84\\x84\\x84\\x08NSString\\x01\\x94\\x84\\x01+\\x02Ok...

and a 310-character one carries \\x81\\x36\\x01 after the '+', which is 310 as a
two-byte little-endian length.
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    'agent', os.path.join(HERE, 'imessage-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

message_body = agent.message_body
OBJ = '￼'

PASS = []
FAIL = []


def check(name, got, want):
    if got == want:
        PASS.append(name)
    else:
        FAIL.append('%s\n    expected %r\n    got      %r' % (name, want, got))


HEADER = (b'\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12'
          b'NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84')
TRAILER = b'\x86\x84\x02iI\x01\x02\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x01\x92\x84\x96\x96'


def blob(text, marker=b'\x08NSString', framing=b'\x01\x94\x84\x01+'):
    """A typedstream blob holding `text`, laid out the way Messages does."""
    raw = text.encode('utf-8')
    n = len(raw)
    if n < 0x81:
        length = bytes([n])
    elif n <= 0xffff:
        length = b'\x81' + n.to_bytes(2, 'little')
    else:
        length = b'\x82' + n.to_bytes(4, 'little')
    return HEADER + marker + framing + length + raw + TRAILER


# --- the text column wins when it has something in it ---------------------
check('text column is used as-is',
      message_body('Hey, confirming 1pm', None), 'Hey, confirming 1pm')
check('text column beats the blob',
      message_body('from text', blob('from blob')), 'from text')
check('trailing whitespace in text is left alone',
      message_body('I ate already  ', None), 'I ate already  ')

# --- falling through to the blob ------------------------------------------
check('empty text falls through to the blob',
      message_body('', blob('Ok')), 'Ok')
check('None text falls through to the blob',
      message_body(None, blob('Ok')), 'Ok')
check('whitespace-only text falls through to the blob',
      message_body('   ', blob('real body')), 'real body')

# --- lengths: the single-byte and multi-byte paths ------------------------
check('one-byte length', message_body('', blob('a' * 0x80)), 'a' * 0x80)
check('two-byte length boundary at 129',
      message_body('', blob('b' * 129)), 'b' * 129)
check('two-byte length, 310 chars like the real sample',
      message_body('', blob('c' * 310)), 'c' * 310)
check('two-byte length, 2620 chars (longest seen on this Mac)',
      message_body('', blob('d' * 2620)), 'd' * 2620)
check('four-byte length path',
      message_body('', blob('e' * 70000)), 'e' * 70000)

# --- real-world content ---------------------------------------------------
check('multi-line body survives',
      message_body('', blob('line one\nline two\n\nline four')),
      'line one\nline two\n\nline four')
check('emoji survive (4-byte utf-8)',
      message_body('', blob('just keep dialing bro \U0001f525\U0001f4aa')),
      'just keep dialing bro \U0001f525\U0001f4aa')
check('curly quotes survive',
      message_body('', blob('Liked “full on text chats”')),
      'Liked “full on text chats”')
check('NSMutableString is read too',
      message_body('', blob('mutable one', marker=b'\x0fNSMutableString')),
      'mutable one')
check('different framing byte still parses',
      message_body('', blob('framed', framing=b'\x01\x95\x84\x01+')), 'framed')

# --- attachments ----------------------------------------------------------
check('an attachment caption keeps its words, not the placeholder',
      message_body('', blob(OBJ + 'Hey Moraima, got you locked in for Oct 27')),
      'Hey Moraima, got you locked in for Oct 27')
check('a bare image comes back empty so the caller skips it',
      message_body('', blob(OBJ)), '')
check('several placeholders and no words is still empty',
      message_body('', blob(OBJ * 3)), '')
check('placeholder mid-body is removed, words either side kept',
      message_body('', blob('before' + OBJ + 'after')), 'beforeafter')

# --- nothing to read ------------------------------------------------------
check('no text and no blob', message_body('', None), '')
check('no text and empty blob', message_body('', b''), '')
check('blob with no string marker', message_body('', HEADER + TRAILER), '')
check('truncated blob does not crash',
      message_body('', blob('hello')[:len(HEADER) + 12]), '')
check('length running past the end of the blob is refused',
      message_body('', HEADER + b'\x08NSString\x01\x94\x84\x01+\x40short'), '')
check('zero length is refused',
      message_body('', HEADER + b'\x08NSString\x01\x94\x84\x01+\x00' + TRAILER), '')
check('garbage bytes do not crash', message_body('', b'\x00\xff\xfe\x01\x02'), '')

# --- cases that pin guards a mutation run found nothing testing -----------
# Without these three, the stripping, the zero-length check and the 12-byte
# window could all be deleted and every other test here would still pass.
check('whitespace around a decoded body is trimmed',
      message_body('', blob('  padded out  ')), 'padded out')
check('placeholder plus a newline leaves no leading blank',
      message_body('', blob(OBJ + '\ncaption under a picture')),
      'caption under a picture')

# A zero-length string on the first marker must be stepped over, not treated
# as the answer -- otherwise a later marker holding the real body is lost.
_two_markers = (HEADER + b'\x0fNSMutableString' + b'\x01\x94\x84\x01+\x00'
                + b'\x08NSString' + b'\x01\x94\x84\x01+\x05hello' + TRAILER)
check('zero-length first marker falls through to the next one',
      message_body('', _two_markers), 'hello')

# The payload marker sits within a few bytes of the class name. Searching the
# whole blob for '+' would find one inside unrelated bytes and read rubbish
# off the back of it -- and '+' is common in real messages, being how every
# international phone number starts.
_far_plus = HEADER + b'\x08NSString' + (b'\x00' * 20) + b'+\x05hello' + TRAILER
check('a + far from the marker is not mistaken for the payload',
      message_body('', _far_plus), '')

# --- the length reader on its own -----------------------------------------
check('_typedstream_len single byte', agent._typedstream_len(b'\x05', 0), (5, 1))
check('_typedstream_len two byte',
      agent._typedstream_len(b'\x81\x36\x01', 0), (310, 3))
check('_typedstream_len four byte',
      agent._typedstream_len(b'\x82\x10\x27\x00\x00', 0), (10000, 5))


print('%d passed' % len(PASS))
for f in FAIL:
    print('FAIL: %s' % f)
if FAIL:
    print('\n%d FAILED' % len(FAIL))
    sys.exit(1)
