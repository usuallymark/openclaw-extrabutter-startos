"""Calendar invitations by mail (since 2026.10.1:28).

When Configure Calendar is set to "Read + invitations by mail" (no Google
sign-in), the calendar service adds, changes and cancels events by sending
standard invitations (iCalendar, RFC 5545/5546: METHOD:REQUEST or CANCEL)
through this mail service. The calendar service never gets the mail
password: it sends a request with the event's facts over a Unix socket
that only it may use, and the mail service builds the message itself and
treats it like any other outgoing mail (a marked draft in Drafts, then the
owner's sending rules: Never Send To, Send Automatically To, the limits,
Review Agent Actions). The invitation's own .ics is not counted as an
attachment.

Replies to the assistant's invitations (METHOD:REPLY, the guests' accept
or decline answers) are moved out of the Inbox into the folder
REPLY_FOLDER, so the email agent's Inbox stays clean; nothing acts on them.

The socket is in the abstract namespace (the mail and calendar services run
in one container). Both ends check the other's user id (SO_PEERCRED): the
mail service answers only openclaw-calendar, and the calendar's client
(gcalendar/invites.py) talks only to openclaw-mail, so nobody else can send
through it or pose as it.
"""

import json
import os
import re
import socket
import socketserver
import struct
import threading
import time
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from sanitize import clean_line, clean_text

SOCKET_NAME = '\0openclaw-mail-invite'
REPLY_FOLDER = 'Calendar Replies'
PRODID = '-//OpenClaw Extra Butter//calendar invitations//EN'
ICS_NAME = 'invite.ics'
MAX_REQUEST = 64 * 1024
MAX_GUESTS = 10
REPLY_SCAN_S = 300
REPLY_MAX_BYTES = 512 * 1024
REPLY_BATCH = 30

_UID = re.compile(r'[A-Za-z0-9._@-]{8,200}')
_ADDR = re.compile(r'[^@\s<>,;"()\[\]\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}')


class InviteRefused(ValueError):
    """The request is not a valid invitation; the text says why."""


# ── iCalendar text ─────────────────────────────────────────────────────────

def _esc(s):
    """TEXT value escaping (RFC 5545 3.3.11); no raw line breaks survive."""
    s = str(s).replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,')
    return s.replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\\n')


def _fold(line):
    """Fold a content line at 75 octets without splitting a character."""
    out, cur, n = [], '', 0
    for ch in line:
        b = len(ch.encode('utf-8'))
        if n + b > (75 if not out else 74):
            out.append(cur)
            cur, n = '', 0
        cur += ch
        n += b
    out.append(cur)
    return '\r\n '.join(out)


def _utc(t):
    return t.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def _parse_time(v, what):
    s = str(v or '').strip()
    try:
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', s):
            return date.fromisoformat(s)
        t = datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        raise InviteRefused(f'{what}: not a date or date-time') from None
    if t.tzinfo is None:
        raise InviteRefused(f'{what}: a date-time needs its offset')
    return t


def check_request(req):
    """The calendar service's request, checked and normalized. The mail
    service trusts none of it: every value is checked again here."""
    if not isinstance(req, dict):
        raise InviteRefused('bad request')
    action = req.get('action')
    if action not in ('request', 'cancel'):
        raise InviteRefused('action: request or cancel')
    uid = str(req.get('uid') or '')
    if not _UID.fullmatch(uid):
        raise InviteRefused('uid: 8 to 200 letters, digits or ._@-')
    seq = req.get('sequence')
    if not isinstance(seq, int) or isinstance(seq, bool) or not 0 <= seq <= 10000:
        raise InviteRefused('sequence: 0 to 10000')
    title = clean_line(req.get('title') or '', 200)
    if not title:
        raise InviteRefused('title: required')
    start = _parse_time(req.get('start'), 'start')
    end = _parse_time(req.get('end'), 'end')
    if type(start) is not type(end):
        raise InviteRefused('start and end: both dates or both date-times')
    if end <= start:
        raise InviteRefused('end: must be after start')
    if (end - start) > timedelta(days=31):
        raise InviteRefused('the event is longer than 31 days')
    guests = []
    for g in req.get('guests') or []:
        a = str(g or '').strip().lower()
        if not _ADDR.fullmatch(a):
            raise InviteRefused(f'guests: "{clean_line(a, 80)}" is not an email address')
        if a not in guests:
            guests.append(a)
    if not guests:
        raise InviteRefused('guests: at least one (an invitation goes to its guests)')
    if len(guests) > MAX_GUESTS:
        raise InviteRefused(f'guests: at most {MAX_GUESTS}')
    tzname = clean_line(req.get('timeZone') or '', 60)
    return {
        'action': action, 'uid': uid, 'sequence': seq, 'title': title, 'start': start, 'end': end,
        'all_day': not isinstance(start, datetime), 'guests': guests,
        'location': clean_line(req.get('location') or '', 300),
        'description': clean_text(str(req.get('description') or ''))[:4000],
        'timeZone': tzname, 'hold': clean_line(req.get('hold') or '', 120),
    }


def ics(ev, organizer, organizer_name=''):
    """The iCalendar text (CRLF) for a checked request."""
    method = 'REQUEST' if ev['action'] == 'request' else 'CANCEL'
    now = datetime.now(timezone.utc)
    if ev['all_day']:
        dts = [f'DTSTART;VALUE=DATE:{ev["start"].strftime("%Y%m%d")}',
               f'DTEND;VALUE=DATE:{ev["end"].strftime("%Y%m%d")}']
    else:
        # UTC times: every calendar app reads them, no VTIMEZONE needed.
        dts = [f'DTSTART:{_utc(ev["start"])}', f'DTEND:{_utc(ev["end"])}']
    cn = f';CN={_param(organizer_name)}' if organizer_name else ''
    lines = [
        'BEGIN:VCALENDAR', f'PRODID:{PRODID}', 'VERSION:2.0', 'CALSCALE:GREGORIAN', f'METHOD:{method}',
        'BEGIN:VEVENT', f'UID:{ev["uid"]}', f'SEQUENCE:{ev["sequence"]}', f'DTSTAMP:{_utc(now)}',
        *dts, f'SUMMARY:{_esc(ev["title"])}',
        *([f'LOCATION:{_esc(ev["location"])}'] if ev['location'] else []),
        *([f'DESCRIPTION:{_esc(ev["description"])}'] if ev['description'] else []),
        f'ORGANIZER{cn}:mailto:{organizer}',
        *[f'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{g}'
          for g in ev['guests']],
        f'STATUS:{"CONFIRMED" if method == "REQUEST" else "CANCELLED"}', 'TRANSP:OPAQUE',
        'END:VEVENT', 'END:VCALENDAR',
    ]
    return '\r\n'.join(_fold(ln) for ln in lines) + '\r\n'


def _param(s):
    """A quoted parameter value (no quotes, control characters or ;:,)."""
    v = re.sub(r'[\x00-\x1f\x7f"]', '', str(s))[:80]
    return f'"{v}"' if re.search(r'[;:,]', v) else v


def when_text(ev):
    if ev['all_day']:
        last = ev['end'] - timedelta(days=1)
        return (f'{ev["start"].isoformat()} (all day)' if last == ev['start']
                else f'{ev["start"].isoformat()} to {last.isoformat()} (all day)')
    s, e = ev['start'], ev['end']
    zone = f' ({ev["timeZone"]})' if ev['timeZone'] else ''
    if s.date() == e.date():
        return f'{s.strftime("%Y-%m-%d %H:%M")} to {e.strftime("%H:%M")}{zone}'
    return f'{s.strftime("%Y-%m-%d %H:%M")} to {e.strftime("%Y-%m-%d %H:%M")}{zone}'


def build(cfg, ev):
    """The invitation mail (an EmailMessage, not yet marked)."""
    addr = cfg['address']
    name = cfg.get('displayName') or ''
    m = EmailMessage()
    m['From'] = formataddr((name, addr))
    m['To'] = ', '.join(ev['guests'])
    m['Date'] = formatdate(localtime=True)
    m['Message-ID'] = make_msgid(domain=addr.split('@')[-1])
    when = when_text(ev)
    if ev['action'] == 'request':
        m['Subject'] = (f'Invitation: {ev["title"]} @ {when}' if ev['sequence'] == 0
                        else f'Updated invitation: {ev["title"]} @ {when}')
        text = [f'{name or addr} invites you to:', '', ev['title'], f'When: {when}']
    else:
        m['Subject'] = f'Cancelled: {ev["title"]} @ {when}'
        text = [f'{name or addr} cancelled:', '', ev['title'], f'When: {when}']
    if ev['location']:
        text.append(f'Where: {ev["location"]}')
    text.append(f'Guests: {", ".join(ev["guests"])}')
    if ev['description']:
        text += ['', ev['description']]
    text += ['', 'Your calendar app shows this as an invitation (the attached invite.ics).']
    method = 'REQUEST' if ev['action'] == 'request' else 'CANCEL'
    cal = ics(ev, addr, name)
    m.set_content('\n'.join(text))
    m.add_alternative(cal, subtype='calendar', params={'method': method})
    m.add_attachment(cal.encode('utf-8'), maintype='application', subtype='ics', filename=ICS_NAME)
    return m


def is_own_ics(part):
    """The invitation's own calendar file (not counted as an attachment)."""
    return (part.get_filename() == ICS_NAME and part.get_content_type() == 'application/ics')


def review_lines(msg):
    """What Review Agent Actions shows for an invitation: the event."""
    for part in msg.walk():
        if part.get_content_type() != 'text/calendar':
            continue
        try:
            text = part.get_content()
        except Exception:
            return []
        out = []
        method = re.search(r'^METHOD:(\S+)', text, re.M)
        out.append('Kind: calendar invitation' + (' (cancellation)' if method and method.group(1) == 'CANCEL'
                                                   else ' (update)' if re.search(r'^SEQUENCE:[1-9]', text, re.M)
                                                   else ''))
        return out
    return []


# ── the socket for the calendar service ────────────────────────────────────

class _Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def serve(handle_request, allowed_uid, log):
    """Listen for the calendar service. handle_request(dict) → dict."""
    class Handler(socketserver.StreamRequestHandler):
        timeout = 120

        def handle(self):
            creds = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            _, uid, _ = struct.unpack('3i', creds)
            try:
                if uid != allowed_uid:
                    out = {'result': 'refused', 'rule': 'only the calendar service may send invitations'}
                    log({'event': 'invite_refused', 'detail': f'caller uid {uid} is not the calendar service'})
                else:
                    line = self.rfile.readline(MAX_REQUEST + 1)
                    if len(line) > MAX_REQUEST:
                        out = {'result': 'refused', 'rule': 'request too large'}
                    else:
                        try:
                            req = json.loads(line or b'{}')
                        except ValueError:
                            req = None
                        out = handle_request(req)
            except Exception as e:  # never a traceback to the caller
                out = {'result': 'failed', 'detail': f'internal error in the mail service ({type(e).__name__})'}
            try:
                self.wfile.write(json.dumps(out).encode() + b'\n')
            except OSError:
                pass

    srv = _Server(SOCKET_NAME, Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ── replies ────────────────────────────────────────────────────────────────

class SentInvites:
    """The UIDs of invitations sent from here (state/invites.json), so only
    replies to those are filed away."""

    def __init__(self, state_dir):
        self.path = os.path.join(state_dir, 'invites.json')
        self.lock = threading.Lock()

    def _load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def add(self, uid, guests):
        with self.lock:
            d = self._load()
            cut = time.time() - 400 * 86400
            d = {k: v for k, v in d.items() if isinstance(v, dict) and v.get('t', 0) > cut}
            d[uid] = {'t': time.time(), 'guests': sorted(set(guests) | set((d.get(uid) or {}).get('guests') or []))}
            tmp = self.path + '.tmp'
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(d, f)
            os.replace(tmp, self.path)

    def guests_of(self, uid):
        rec = self._load().get(uid)
        return set(rec.get('guests') or []) if isinstance(rec, dict) else None


def reply_of(msg):
    """(uid, attendee address) when msg is an iCalendar REPLY, else None."""
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype not in ('text/calendar', 'application/ics'):
            continue
        try:
            payload = part.get_payload(decode=True) or b''
        except Exception:
            continue
        text = re.sub(r'\r?\n[ \t]', '', payload[:200_000].decode('utf-8', 'replace'))
        if not re.search(r'^METHOD:REPLY\s*$', text, re.M | re.I):
            continue
        uid = re.search(r'^UID:(\S+)\s*$', text, re.M)
        att = re.search(r'^ATTENDEE[^:\r\n]*:mailto:([^\s]+)\s*$', text, re.M | re.I)
        if uid:
            return uid.group(1), (att.group(1).lower() if att else '')
    return None
