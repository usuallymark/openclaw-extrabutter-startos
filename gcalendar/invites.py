"""Invitations by mail (since 2026.10.1:28): calendar writes without Google.

Configure Calendar "Read + invitations by mail" (no Google sign-in): the
calendar agent's create_event, change_event and cancel_event send standard
invitations to the guests instead of writing a calendar. The mail service
builds and sends them (mail/invite.py) under the owner's sending rules;
this service never has the mail password. It asks over a Unix socket that
only the mail service answers (both ends check each other's user id).

What is kept here (state/invitations.json): each invitation this service
sent, by its own event id: UID, SEQUENCE, title, times, guests, and the
mail service's answer. Only those can be changed or cancelled. A change
goes to the remaining guests as an update (same UID, SEQUENCE + 1); guests
taken off get a cancellation.

The same rules as writing on Google: guests only from the owner's allowed
list, at most MAX_GUESTS, at most MAX_WRITES_PER_DAY changes a day, no
times in the past. "Hold every new event" makes the mail wait for approval.
Approvals are the mail service's (Review Agent Actions shows the mail).
"""

import json
import os
import pwd
import secrets
import threading
from datetime import datetime

from mcp import ToolError
from sanitize import clean_line, clean_text
from writes import Writer, MAX_GUESTS  # noqa: F401  (limits shared with Google writes)

import svcutil

MAIL_USER = 'openclaw-mail'
SOCKET_NAME = '\0openclaw-mail-invite'
MAX_KEPT = 500


def _mail_call(request):
    """One request to the mail service (the calendar's side of mail/invite.py)."""
    import socket
    import struct
    try:
        mail_uid = pwd.getpwnam(MAIL_USER).pw_uid
    except KeyError:
        return {'result': 'failed', 'detail': f'the user {MAIL_USER} is missing from this image'}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(150)
    buf = b''
    try:
        try:
            s.connect(SOCKET_NAME)
        except OSError:
            return {'result': 'failed', 'detail': 'the mail service is not answering (is Email set up in Configure '
                                                  'Email, and is its Email Service line green?)'}
        creds = s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        if struct.unpack('3i', creds)[1] != mail_uid:
            return {'result': 'failed', 'detail': 'something other than the mail service is listening; refused'}
        s.sendall(json.dumps(request).encode() + b'\n')
        while not buf.endswith(b'\n'):
            part = s.recv(65536)
            if not part:
                break
            buf += part
            if len(buf) > 1024 * 1024:
                return {'result': 'failed', 'detail': 'the mail service answered too much'}
    except socket.timeout:
        return {'result': 'failed', 'detail': 'the mail service did not answer in time; the invitation may still '
                                              'have been saved or sent: check status before asking again'}
    finally:
        s.close()
    try:
        out = json.loads(buf)
    except ValueError:
        out = None
    return out if isinstance(out, dict) else {'result': 'failed', 'detail': 'the mail service gave no answer'}


class InviteWriter(Writer):
    """Writer's checks (guests, times, limits); sending by invitation."""

    mail_call = staticmethod(_mail_call)

    def __init__(self, svc, cfg):
        super().__init__(svc, cfg)
        self.name = 'invitations by mail'
        self.path = os.path.join(cfg['stateDir'], 'invitations.json')
        self.ready = True
        self.reason = ''
        self._lock = threading.RLock()

    # Nothing to set up and no queue of its own (the mail service has it).
    def setup(self, tz_name):
        self.ready, self.reason = True, ''

    def loop(self):
        return

    def process(self):
        return

    def pending_summary(self):
        return []

    def _need_ready(self):
        if self.svc.cfg.get('mode') != 'invite':
            raise ToolError('the calendar is read only (Configure Calendar); nothing can be added, changed or cancelled')

    # ── what was sent ──────────────────────────────────────────────────────

    def _load(self):
        try:
            with open(self.path) as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, d):
        if len(d) > MAX_KEPT:
            for k in sorted(d, key=lambda k: d[k].get('t', 0))[:len(d) - MAX_KEPT]:
                del d[k]
        svcutil.write_private(self.path, json.dumps(d).encode())

    def _record(self, event_id):
        eid = str(event_id or '').strip()
        if not eid.startswith('inv') or not eid.isalnum() or len(eid) > 40:
            raise ToolError('event_id: the id create_event gave for an invitation (only invitations sent from here '
                            'can be changed or cancelled, never the owner\'s or anyone else\'s events)')
        rec = self._load().get(eid)
        if not isinstance(rec, dict):
            raise ToolError(f'no invitation {clean_line(eid, 40)} was sent from here; only those can be changed or '
                            'cancelled')
        if rec.get('status') == 'cancelled':
            raise ToolError('that invitation is already cancelled')
        return eid, rec

    # ── times as plain values for the mail service ─────────────────────────

    @staticmethod
    def _plain(start, end):
        """Google-style start/end (from Writer._when) → ISO values."""
        if 'date' in start:
            return start['date'], end['date'], True
        return start['dateTime'], end['dateTime'], False

    def _send(self, action, rec, guests, hold):
        req = {'action': action, 'uid': rec['uid'], 'sequence': rec['sequence'], 'title': rec['title'],
               'start': rec['start'], 'end': rec['end'], 'location': rec.get('location') or '',
               'description': rec.get('description') or '', 'guests': guests,
               'timeZone': rec.get('timeZone') or '', 'hold': hold}
        out = self.mail_call(req)
        return out if isinstance(out, dict) else {'result': 'failed', 'detail': 'no answer'}

    def _hold(self):
        return 'every new event waits (Configure Calendar)' if self.hold_all else ''

    @staticmethod
    def _answer(out, what, eid, rec):
        r = out.get('result')
        res = {'result': {'sent': 'invitation sent', 'waiting for approval': 'invitation waiting for approval'}.get(r, r),
               'action': what, 'event_id': eid if r in ('sent', 'waiting for approval') else None,
               'guests': out.get('guests') or rec.get('guests'), 'title': rec['title'],
               'start': rec['start'], 'end': rec['end'], **({'all_day': True} if rec.get('all_day') else {}),
               **({'time_zone': rec['timeZone']} if rec.get('timeZone') and not rec.get('all_day') else {})}
        if r == 'sent':
            res['detail'] = ('Sent by mail. It appears on each guest\'s calendar when their calendar app takes it '
                             '(some add invitations at once, some only once accepted).')
        elif r == 'waiting for approval':
            res['detail'] = ('The invitation mail waits for the owner\'s approval in StartOS (Review Agent Actions): '
                             f'{out.get("rule") or ""}. Do not ask again.')
        else:
            res['detail'] = out.get('rule') or out.get('detail') or 'not sent'
        return {k: v for k, v in res.items() if v is not None}

    # ── tools ──────────────────────────────────────────────────────────────

    def create(self, a, tz, tz_name):
        self._need_ready()
        title = clean_line(a.get('title') or '', 200)
        if not title:
            raise ToolError('title: required')
        start, end = self._when(a, tz, tz_name)
        guests = self._guests(a.get('guests')) or []
        if not guests:
            raise ToolError('guests: an invitation needs at least one guest. To put something on the owner\'s '
                            'calendar, invite the owner (an address on the allowed list)')
        s, e, all_day = self._plain(start, end)
        with self._lock:
            self._check_rate()
            eid = 'inv' + secrets.token_hex(8)
            rec = {'uid': f'{eid}-{secrets.token_hex(6)}@openclaw', 'sequence': 0, 'title': title, 'start': s,
                   'end': e, 'all_day': all_day, 'timeZone': tz_name,
                   'location': clean_line(a.get('location') or '', 300),
                   'description': clean_text(str(a.get('description') or ''))[:4000], 'guests': guests}
            out = self._send('request', rec, guests, self._hold())
            if out.get('result') in ('sent', 'waiting for approval'):
                self._count_write()
                d = self._load()
                d[eid] = {**rec, 'status': out['result'], 't': datetime.now().timestamp()}
                self._save(d)
            self.svc.log({'event': 'invite_' + _word(out), 'action': 'add event', 'guests': guests})
            return self._answer(out, 'add event', eid, rec)

    def change(self, a, tz, tz_name):
        self._need_ready()
        with self._lock:
            eid, rec = self._record(a.get('event_id'))
            new = dict(rec)
            if a.get('title'):
                new['title'] = clean_line(a['title'], 200)
            if 'location' in a and a['location'] is not None:
                new['location'] = clean_line(a['location'], 300)
            if 'description' in a and a['description'] is not None:
                new['description'] = clean_text(str(a['description']))[:4000]
            when = self._when(a, tz, tz_name, current=rec)
            if when:
                new['start'], new['end'], new['all_day'] = self._plain(*when)
                new['timeZone'] = tz_name
            guests = self._guests(a.get('guests'))
            if guests is not None:
                if not guests:
                    raise ToolError('guests: at least one; to call it off, use cancel_event')
                new['guests'] = guests
            if new == rec:
                raise ToolError('nothing to change: give title, start/end, description, location or guests')
            self._check_rate()
            new['sequence'] = int(rec.get('sequence') or 0) + 1
            out = self._send('request', new, new['guests'], self._hold())
            removed = [g for g in rec.get('guests') or [] if g not in new['guests']]
            notes = []
            if out.get('result') in ('sent', 'waiting for approval') and removed:
                # Guests taken off are told it is cancelled for them.
                gone = self._send('cancel', {**rec, 'sequence': new['sequence']}, removed, self._hold())
                notes.append(f'cancellation to {", ".join(removed)}: {gone.get("result")}')
            if out.get('result') in ('sent', 'waiting for approval'):
                self._count_write()
                d = self._load()
                d[eid] = {**new, 'status': out['result'], 't': datetime.now().timestamp()}
                self._save(d)
            self.svc.log({'event': 'invite_' + _word(out), 'action': 'change event', 'guests': new['guests']})
            res = self._answer(out, 'change event', eid, new)
            if notes:
                res['notes'] = notes
            return res

    def cancel(self, a):
        self._need_ready()
        with self._lock:
            eid, rec = self._record(a.get('event_id'))
            self._check_rate()
            new = {**rec, 'sequence': int(rec.get('sequence') or 0) + 1}
            out = self._send('cancel', new, rec.get('guests') or [], self._hold())
            if out.get('result') in ('sent', 'waiting for approval'):
                self._count_write()
                d = self._load()
                d[eid] = {**new, 'status': 'cancelled' if out['result'] == 'sent' else 'cancel waiting for approval',
                          't': datetime.now().timestamp()}
                self._save(d)
            self.svc.log({'event': 'invite_' + _word(out), 'action': 'cancel event', 'guests': rec.get('guests')})
            res = self._answer(out, 'cancel event', eid, new)
            if out.get('result') == 'sent':
                res['result'] = 'cancellation sent'
            return res

    def status(self):
        d = self._load()
        recent = sorted(d.items(), key=lambda kv: kv[1].get('t', 0), reverse=True)[:15]
        upcoming = []
        for eid, r in recent:
            upcoming.append({'event_id': eid, 'title': r.get('title'), 'start': r.get('start'), 'end': r.get('end'),
                             'guests': r.get('guests'), 'status': r.get('status')})
        return {'writing': 'invitations by mail', 'hold_every_event': self.hold_all,
                'allowed_guests': sorted(self.allowed), 'invitations_sent': upcoming,
                'note': 'Approvals are the mail service\'s: what waits, and decisions, are in Review Agent Actions.'}


def _word(out):
    return {'sent': 'sent', 'waiting for approval': 'queued', 'refused': 'refused'}.get(out.get('result'), 'failed')
