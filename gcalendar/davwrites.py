"""Calendar writes on a CalDAV account (since 2026.10.1:37), only on the
assistant's own calendar.

The same rules as writes.py (Google), which this extends: guests only from
the owner's allowed list, anything with guests (and with "Hold every new
event", everything) waits for the owner's approval, at most
MAX_WRITES_PER_DAY changes a day, only events on the own calendar.

The own calendar is made on the account at the first start (MKCALENDAR);
when the server does not let apps make calendars, a calendar the owner
made with the Own Calendar Name is used. Its address is kept in
state/own_caldav.json, and every write goes to an address inside it.
Events made here are <random>.ics with that random UID.

Changes are made only on the version last seen: a change or cancel sends
If-Match with the event's ETag (also when the owner approves it days
later), a new event If-None-Match: *. If the event was changed elsewhere
in between (on a phone), the server refuses and nothing is overwritten.

Guests: the server sends the invitations itself (CalDAV scheduling,
RFC 6638), as Google does. A server that does not (it does not announce
calendar-auto-schedule) takes no guests: they would never hear of it.
"""

import json
import os
import re
import secrets
import urllib.parse
from datetime import date, datetime, timedelta, timezone

import ical
import svcutil
from caldav import Conflict, DavError, DavRefused
from mcp import ToolError
from sanitize import clean_line, clean_text
from writes import Writer

_UTC = timezone.utc


def _esc(s):
    return (str(s or '').replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,')
            .replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\\n'))


def _fold(line):
    """RFC 5545 folding at 75 octets, never inside a UTF-8 character."""
    raw = line.encode('utf-8')
    if len(raw) <= 75:
        return line
    out, cur, size = [], '', 0
    for ch in line:
        n = len(ch.encode('utf-8'))
        if size + n > (75 if not out else 74):
            out.append(cur)
            cur, size = '', 0
        cur += ch
        size += n
    out.append(cur)
    return '\r\n '.join(out)


def _dt(g):
    """Google-shaped start/end → (property params, value)."""
    if 'date' in g:
        return ';VALUE=DATE', g['date'].replace('-', '')
    t = datetime.fromisoformat(g['dateTime'])
    return '', t.astimezone(_UTC).strftime('%Y%m%dT%H%M%SZ')


def build_ics(uid, seq, body, organizer, guests):
    """One VEVENT (UTC times, no zone component needed)."""
    now = datetime.now(_UTC).strftime('%Y%m%dT%H%M%SZ')
    sp, sv = _dt(body['start'])
    ep, ev = _dt(body['end'])
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenClaw Extra Butter//calendar agent//EN',
             'BEGIN:VEVENT', f'UID:{uid}', f'DTSTAMP:{now}', f'DTSTART{sp}:{sv}', f'DTEND{ep}:{ev}',
             f'SEQUENCE:{seq}', f'SUMMARY:{_esc(body.get("summary"))}']
    if body.get('description'):
        lines.append(f'DESCRIPTION:{_esc(body["description"])}')
    if body.get('location'):
        lines.append(f'LOCATION:{_esc(body["location"])}')
    if guests:
        lines.append(f'ORGANIZER:mailto:{organizer}')
        lines += [f'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{g}' for g in guests]
    lines += ['X-OPENCLAW:calendar-agent', 'END:VEVENT', 'END:VCALENDAR']
    return '\r\n'.join(_fold(x) for x in lines) + '\r\n'


def _as_g(t, tz, tz_name):
    """An ical start/end back into the Google shape writes.py speaks."""
    if isinstance(t, datetime):
        return {'dateTime': t.astimezone(tz).isoformat(), 'timeZone': tz_name}
    return {'date': t.isoformat()}


class CalDavWriter(Writer):
    def __init__(self, svc, cfg):
        super().__init__(svc, cfg)
        self.own_path = os.path.join(cfg['stateDir'], 'own_caldav.json')
        self.own = None          # caldav.Calendar

    # ── the own calendar ───────────────────────────────────────────────────

    def setup(self, tz_name):
        """Find or make the own calendar. Never raises; sets ready/reason."""
        acct = self.svc.dav
        try:
            if not acct.connected:
                acct.connect()
            try:
                with open(self.own_path) as f:
                    saved = json.load(f).get('href')
            except (OSError, ValueError, AttributeError):
                saved = None
            own = acct.by_href(saved) if saved else None
            if saved and own is None:
                self.svc.log({'event': 'own_calendar_gone', 'detail': 'making it again'})
            if own is None:
                # One this service made before (its state folder was lost):
                # the same name, at an address it gives its own calendars.
                own = next((c for c in acct.calendars if c.writable and c.name.lower() == self.name.lower()
                            and c.href.rstrip('/').rsplit('/', 1)[-1].startswith('openclaw-')), None)
            if own is None:
                href = acct.mkcalendar(self.name)
                if href:
                    acct.refresh_list()
                    own = acct.by_href(href)
                    self.svc.log({'event': 'own_calendar_created', 'name': self.name})
                else:
                    own = next((c for c in acct.calendars if c.writable and c.name.lower() == self.name.lower()), None)
                    if own is None:
                        self.ready = False
                        self.reason = (f'the calendar server does not let apps make calendars: make one named '
                                       f'"{self.name}" in your calendar app (or on the provider\'s website) and '
                                       'restart OpenClaw')
                        return
            if not own.writable:
                self.ready = False
                self.reason = f'the calendar "{own.name}" cannot be written with this account'
                return
            svcutil.write_private(self.own_path, json.dumps({'href': own.href, 'name': self.name}).encode())
            self.own, self.own_id = own, own.id
            self.ready, self.reason = True, ''
        except DavError as e:
            self.ready = False
            self.reason = f'the calendar "{self.name}" could not be set up: {e}'

    def _need_ready(self):
        if self.svc.cfg.get('mode') != 'write':
            raise ToolError('the calendar is read only (Configure Calendar); nothing can be added, changed or cancelled')
        if not self.ready or self.own is None:
            raise ToolError(f'writing is not available: {self.reason}')

    def _inside(self, href):
        """Only addresses inside the own calendar, never another one."""
        own = self.own.href
        h = urllib.parse.urljoin(own, href)
        p = urllib.parse.urlsplit(h)
        if (p.scheme, p.netloc) != urllib.parse.urlsplit(own)[:2] or not h.startswith(own) or '/../' in h \
                or '/./' in h or h == own or '/' in h[len(own):].rstrip('/'):
            raise ToolError('refused: not an event on the assistant\'s own calendar')
        return h

    # ── guests and the organizer ───────────────────────────────────────────

    def _guests(self, raw):
        out = super()._guests(raw)
        if out and not self.svc.dav.scheduling:
            raise ToolError('refused: this calendar server does not send invitations itself, so guests would never '
                            'hear of the event; add it without guests (or the owner can invite them in their '
                            'calendar app)')
        if out and not self._organizer():
            raise ToolError('refused: the account\'s own address is not known (Configure Calendar → Account), so '
                            'nobody can be invited')
        return out

    def _organizer(self):
        return (self.svc.dav.address or self.svc.account or '').lower()

    # ── tools ──────────────────────────────────────────────────────────────

    def create(self, a, tz, tz_name):
        self._need_ready()
        title = clean_line(a.get('title') or '', 200)
        if not title:
            raise ToolError('title: required')
        start, end = self._when(a, tz, tz_name)
        guests = self._guests(a.get('guests')) or []
        body = {'summary': title, 'start': start, 'end': end}
        if a.get('description'):
            body['description'] = clean_text(str(a['description']))[:4000]
        if a.get('location'):
            body['location'] = clean_line(a['location'], 300)
        uid = secrets.token_hex(16)
        href = self._inside(f'{uid}.ics')
        hold = ('guests are invited (the calendar server emails them)' if guests
                else 'every new event waits (Configure Calendar)' if self.hold_all else '')
        req = {'op': 'put', 'href': href, 'etag': None, 'uid': uid,
               'ics': build_ics(uid, 0, body, self._organizer(), guests), 'body': body}
        return self._do_or_hold(req, 'add event', title, self._when_text(start, end), body, guests, hold)

    def _own_event(self, event_id, tz=None, tz_name='UTC'):
        """(uid, href, etag, current fields) of an event on the own calendar."""
        eid = str(event_id or '').strip()
        if not re.fullmatch(r'[0-9a-f]{24}', eid):
            raise ToolError('event_id: the id of a whole event on the calendar "' + self.name + '" (from create, '
                            'list or search; one date of a repeating event cannot be changed here)')
        own = self.own
        hit = own.resources.get(eid)
        if hit is None:
            own.get(tz or _UTC, force=True)
            hit = own.resources.get(eid)
        if hit is None:
            raise ToolError(f'no event {eid} on the calendar "{self.name}"; only events there can be changed or '
                            'cancelled (never the owner\'s or anyone else\'s)')
        uid, href, _ = hit
        href = self._inside(href)
        try:
            r = self.svc.dav.call(href, 'GET')
        except DavError as e:
            raise ToolError(str(e)) from None
        if r.status == 404:
            raise ToolError('that event is no longer on the calendar')
        if r.status != 200:
            raise ToolError(f'the event could not be read (HTTP {r.status})')
        etag = r.headers.get('etag') or hit[2]
        feed = ical.parse(r.body.decode('utf-8', 'replace'), tz or _UTC)
        ev = next((e for e in feed.events if e['uid'] == uid), None)
        if ev is None or feed.overrides.get(uid) or ev.get('rrule'):
            raise ToolError('only single events made by the assistant can be changed here')
        seq = re.search(r'^SEQUENCE:(\d+)', r.body.decode('utf-8', 'replace'), re.M)
        cur = {'summary': ev['summary'], 'description': ev['description'], 'location': ev['location'],
               'start': _as_g(ev['start'], tz or _UTC, tz_name), 'end': _as_g(ev['end'], tz or _UTC, tz_name),
               'guests': [x['email'] for x in ev['attendees'] if x['email'] and x['email'] != self._organizer()],
               'seq': int(seq.group(1)) if seq else 0}
        return uid, href, etag, cur

    def change(self, a, tz, tz_name):
        self._need_ready()
        uid, href, etag, cur = self._own_event(a.get('event_id'), tz, tz_name)
        body = {k: cur[k] for k in ('summary', 'description', 'location', 'start', 'end')}
        changed = {}
        if a.get('title'):
            changed['summary'] = clean_line(a['title'], 200)
        if 'description' in a and a['description'] is not None:
            changed['description'] = clean_text(str(a['description']))[:4000]
        if 'location' in a and a['location'] is not None:
            changed['location'] = clean_line(a['location'], 300)
        when = self._when(a, tz, tz_name, current=cur)
        if when:
            changed['start'], changed['end'] = when
        new_guests = self._guests(a.get('guests'))
        if not changed and new_guests is None:
            raise ToolError('nothing to change: give title, start/end, description, location or guests')
        body.update(changed)
        guests_now = cur['guests'] if new_guests is None else new_guests
        told = sorted(set(cur['guests']) | set(guests_now))
        hold = ('guests are told about the change' if told
                else 'every change waits (Configure Calendar)' if self.hold_all else '')
        req = {'op': 'put', 'href': href, 'etag': etag, 'uid': uid,
               'ics': build_ics(uid, cur['seq'] + 1, body, self._organizer(), guests_now), 'body': body}
        return self._do_or_hold(req, 'change event', body['summary'], self._when_text(body['start'], body['end']),
                                changed, told, hold)

    def cancel(self, a):
        self._need_ready()
        try:
            tz, tz_name = self.svc.tools._tz()
        except Exception:  # times then shown in UTC
            tz, tz_name = _UTC, 'UTC'
        uid, href, etag, cur = self._own_event(a.get('event_id'), tz, tz_name)
        hold = ('guests are told it is cancelled' if cur['guests']
                else 'every change waits (Configure Calendar)' if self.hold_all else '')
        body = {k: cur[k] for k in ('summary', 'start', 'end')}
        req = {'op': 'delete', 'href': href, 'etag': etag, 'uid': uid, 'body': body}
        return self._do_or_hold(req, 'cancel event', cur['summary'], self._when_text(cur['start'], cur['end']),
                                {}, cur['guests'], hold)

    # ── doing it ───────────────────────────────────────────────────────────

    def _apply(self, req):
        href = self._inside(req['href'])
        acct = self.svc.dav
        try:
            if req['op'] == 'put':
                h = {'Content-Type': 'text/calendar; charset=utf-8'}
                if req.get('etag'):
                    h['If-Match'] = req['etag']
                else:
                    h['If-None-Match'] = '*'
                r = acct.call(href, 'PUT', req['ics'], h)
                ok = r.status in (200, 201, 204)
            elif req['op'] == 'delete':
                r = acct.call(href, 'DELETE', None, {'If-Match': req['etag']} if req.get('etag') else {})
                ok = r.status in (200, 204, 404)
            else:
                raise ToolError('unknown request')
        except DavRefused:
            raise
        except DavError as e:
            raise ToolError(str(e)) from None
        if r.status == 412:
            raise Conflict('the event was changed in the calendar since it was read (on another device?); '
                           'nothing was overwritten: read it again and ask again')
        if not ok:
            raise ToolError(f'the calendar server refused the change (HTTP {r.status})')
        self.own.invalidate()
        self._count_write()
        return {'id': ical._uid_hash(req['uid']), **{k: v for k, v in (req.get('body') or {}).items()
                                                     if k in ('start', 'end')}}

    def _do_or_hold(self, req, what, title, when, body, guests, hold):
        # The same request already waiting (a new event gets a new random
        # UID each time, so compare what it does, not its bytes).
        key = (req['op'], req['href'] if req.get('etag') else None, req.get('body'), sorted(guests))
        for q in self.q.pending():
            r = q.get('request') or {}
            if (r.get('op'), r.get('href') if r.get('etag') else None, r.get('body'),
                    sorted(q.get('recipients') or [])) == key:
                return {'result': 'already waiting for approval', 'request_id': q['id'],
                        'detail': 'Do not ask again; the owner decides in StartOS (Review Agent Actions).'}
        try:
            return super()._do_or_hold(req, what, title, when, body, guests, hold)
        except Conflict as e:
            raise ToolError(str(e)) from None

    def _approved(self, item):
        req = item.get('request') or {}
        bad = [a for a in item.get('recipients') or [] if a not in self.allowed]
        if bad:
            return self._result(item, 'refused', 'no longer on the allowed list: ' + ', '.join(bad))
        if not self.ready:
            return  # waits until writing works again (or expires)
        try:
            self._apply(req)
        except Conflict:
            return self._result(item, 'failed', 'the event was changed in the calendar since it was asked; nothing '
                                                'was overwritten (ask again)')
        except (ToolError, DavError) as e:
            return self._result(item, 'failed', str(e))
        self._result(item, 'done', 'approved in Review Agent Actions')
