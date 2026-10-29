"""Calendar writes (since 2026.10.1:16), only on the assistant's own
calendar.

The sign-in for writing has calendar.app.created, which lets this service
make secondary calendars and change events on those only: Google itself
refuses (404) any write to the account's main calendar or to calendars
shared with it. On top of that, every write here goes through one path
that names the service's own calendar id, so nothing else is ever
addressed.

Rules (Configure Calendar; the service reads them at start):
- Guests: only addresses on the allowed list (Trusted Organizers, and
  Email's Trusted Senders when that switch is on). Anyone else: refused.
- An event with guests (new, changed or cancelled) waits for the owner's
  approval in Review Agent Actions before Google emails anyone. With "Hold
  every new event" on, every write waits.
- At most MAX_WRITES_PER_DAY writes a day; at most MAX_GUESTS guests.
- Only events on the service's own calendar can be changed or cancelled.

Held requests live in the approval queue (approvals.py) with the exact
Google request; the owner's decision comes from decisions/ (root writes
it). Undecided requests expire after 3 days, or when the event's start has
passed.
"""

import json
import os
import threading
import time
import urllib.parse
from datetime import date, datetime, timedelta

from approvals import ApprovalQueue
from gapi import ApiError
from mcp import ToolError
from sanitize import clean_line, clean_text

import svcutil

EXPIRE_S = 3 * 24 * 3600
MAX_WRITES_PER_DAY = 30
MAX_GUESTS = 10
POLL_S = 10
MARK = {'private': {'openclaw': 'calendar-agent'}}


def _q(s):
    return urllib.parse.quote(s, safe='')


def _short(s, n):
    t = ' '.join(str(s or '').split())
    return t[:n - 1] + '…' if len(t) > n else t


class Writer:
    def __init__(self, svc, cfg):
        self.svc = svc
        self.cfg = cfg
        self.name = clean_line(cfg.get('calendarName') or 'Assistant', 60) or 'Assistant'
        self.allowed = {a.strip().lower() for a in cfg.get('allowedGuests') or [] if a.strip()}
        self.hold_all = bool(cfg.get('holdAll'))
        st = cfg['stateDir']
        self.own_path = os.path.join(st, 'own_calendar.json')
        self.writes_path = os.path.join(st, 'writes.jsonl')
        self.q = ApprovalQueue(st, cfg.get('decisionsDir'), EXPIRE_S)
        self.own_id = None
        self.ready = False
        self.reason = 'not set up yet'
        self.lock = threading.RLock()

    # ── the own calendar ───────────────────────────────────────────────────

    def setup(self, tz_name):
        """Find or make the own calendar. Never raises; sets ready/reason."""
        g = self.svc.google
        if 'calendar.app.created' not in set(g.scopes):
            self.ready = False
            self.reason = ('writing needs a sign-in with calendar.app.created; run google-signin.py with '
                           '--scopes calendar.readonly,calendar.app.created and save the new sign-in')
            return
        try:
            saved = json.load(open(self.own_path)).get('id')
        except (OSError, ValueError, AttributeError):
            saved = None
        try:
            if saved:
                try:
                    g.call('GET', f'/calendars/{_q(saved)}')
                    self.own_id = saved
                except ApiError as e:
                    if e.status != 404:
                        raise
                    self.svc.log({'event': 'own_calendar_gone', 'detail': 'recreating it'})
            if not self.own_id:
                d = g.call('POST', '/calendars', body={
                    'summary': self.name, 'timeZone': tz_name or 'UTC',
                    'description': 'Events made by the OpenClaw calendar agent. Shared with nobody unless you share it.'})
                self.own_id = d['id']
                svcutil.write_private(self.own_path, json.dumps({'id': self.own_id, 'name': self.name}).encode())
                self.svc.log({'event': 'own_calendar_created', 'name': self.name})
            self.ready = True
            self.reason = ''
        except ApiError as e:
            self.ready = False
            self.reason = f'the calendar "{self.name}" could not be set up: {e}'

    def _events_path(self, event_id=None):
        # The one path every write takes: the own calendar and nothing else.
        if not self.own_id:
            raise ToolError(self.reason or 'writing is not set up')
        p = f'/calendars/{_q(self.own_id)}/events'
        return p + (f'/{_q(event_id)}' if event_id else '')

    def _need_ready(self):
        if self.svc.cfg.get('mode') != 'write':
            raise ToolError('the calendar is read only (Configure Calendar); nothing can be added, changed or cancelled')
        if not self.ready:
            raise ToolError(f'writing is not available: {self.reason}')

    # ── limits ─────────────────────────────────────────────────────────────

    def _writes_today(self):
        now = time.time()
        try:
            with open(self.writes_path) as f:
                ts = [json.loads(ln).get('t', 0) for ln in f if ln.strip()]
        except (OSError, ValueError):
            ts = []
        return sum(1 for t in ts if now - t < 86400)

    def _count_write(self):
        with open(self.writes_path, 'a') as f:
            f.write(json.dumps({'t': time.time()}) + '\n')
        try:
            with open(self.writes_path) as f:
                lines = f.readlines()
            if len(lines) > 1000:
                svcutil.write_private(self.writes_path, ''.join(lines[-200:]).encode())
        except OSError:
            pass

    def _check_rate(self):
        if self._writes_today() >= MAX_WRITES_PER_DAY:
            raise ToolError(f'more than {MAX_WRITES_PER_DAY} calendar changes in 24 hours; refused (the limit is the owner\'s)')

    # ── input ──────────────────────────────────────────────────────────────

    def _guests(self, raw):
        if raw is None:
            return None
        if not isinstance(raw, list):
            raise ToolError('guests: a list of email addresses')
        out = []
        for g in raw:
            a = str(g or '').strip().lower()
            if not a:
                continue
            if '@' not in a or len(a) > 200 or any(c in a for c in ' <>,;"'):
                raise ToolError(f'guests: {clean_line(a, 80)} is not an email address')
            if a not in out:
                out.append(a)
        if len(out) > MAX_GUESTS:
            raise ToolError(f'guests: at most {MAX_GUESTS}')
        bad = [a for a in out if a not in self.allowed]
        if bad:
            raise ToolError('refused: ' + ', '.join(bad) + ' may not be invited (only the owner\'s allowed list in '
                            'Configure Calendar); do not try another way')
        return out

    def _when(self, a, tz, tz_name, current=None):
        """Google start/end from start, end, all_day, duration_minutes."""
        start_s = str(a.get('start') or '').strip()
        if not start_s:
            if current:
                return None
            raise ToolError('start: give YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:MM in the calendar\'s time zone')
        all_day = bool(a.get('all_day')) or (len(start_s) == 10 and 'T' not in start_s)
        now = datetime.now(tz)
        try:
            if all_day:
                d1 = date.fromisoformat(start_s[:10])
                end_s = str(a.get('end') or '').strip()
                d2 = date.fromisoformat(end_s[:10]) if end_s else d1  # last day, inclusive
                if d2 < d1:
                    raise ToolError('end: must not be before start')
                start, end = {'date': d1.isoformat()}, {'date': (d2 + timedelta(days=1)).isoformat()}
                first = datetime(d1.year, d1.month, d1.day, tzinfo=tz)
            else:
                t1 = datetime.fromisoformat(start_s.replace('Z', '+00:00'))
                t1 = t1 if t1.tzinfo else t1.replace(tzinfo=tz)
                end_s = str(a.get('end') or '').strip()
                if end_s:
                    t2 = datetime.fromisoformat(end_s.replace('Z', '+00:00'))
                    t2 = t2 if t2.tzinfo else t2.replace(tzinfo=tz)
                else:
                    mins = a.get('duration_minutes', 60)
                    if not isinstance(mins, int) or isinstance(mins, bool) or not 5 <= mins <= 24 * 60:
                        raise ToolError('duration_minutes: 5 to 1440')
                    t2 = t1 + timedelta(minutes=mins)
                if t2 <= t1:
                    raise ToolError('end: must be after start')
                start = {'dateTime': t1.isoformat(), 'timeZone': tz_name}
                end = {'dateTime': t2.isoformat(), 'timeZone': tz_name}
                first = t1
        except ValueError:
            raise ToolError('start/end: use YYYY-MM-DD or YYYY-MM-DDTHH:MM') from None
        if first < now - timedelta(days=1):
            raise ToolError('start: that is in the past')
        if first > now + timedelta(days=730):
            raise ToolError('start: more than two years ahead')
        return start, end

    @staticmethod
    def _when_text(start, end):
        if 'date' in start:
            last = (date.fromisoformat(end['date']) - timedelta(days=1)).isoformat()
            return f'{start["date"]} (all day)' if last == start['date'] else f'{start["date"]} to {last} (all day)'
        return f'{start["dateTime"]} to {end["dateTime"][11:16]} ({start.get("timeZone") or ""})'.strip()

    # ── tools ──────────────────────────────────────────────────────────────

    def create(self, a, tz, tz_name):
        self._need_ready()
        title = clean_line(a.get('title') or '', 200)
        if not title:
            raise ToolError('title: required')
        start, end = self._when(a, tz, tz_name)
        guests = self._guests(a.get('guests')) or []
        body = {'summary': title, 'start': start, 'end': end, 'extendedProperties': MARK}
        if a.get('description'):
            body['description'] = clean_text(str(a['description']))[:4000]
        if a.get('location'):
            body['location'] = clean_line(a['location'], 300)
        if guests:
            body['attendees'] = [{'email': g} for g in guests]
        hold = 'guests are invited (Google emails them)' if guests else ('every new event waits (Configure Calendar)'
                                                                         if self.hold_all else '')
        req = {'op': 'insert', 'body': body, 'sendUpdates': 'all' if guests else 'none'}
        return self._do_or_hold(req, 'add event', title, self._when_text(start, end), body, guests, hold)

    def _own_event(self, event_id):
        eid = str(event_id or '').strip()
        if not eid or len(eid) > 1024:
            raise ToolError('event_id: the id from create, list or search (on the calendar "' + self.name + '")')
        try:
            return self.svc.google.call('GET', self._events_path(eid))
        except ApiError as e:
            if e.status == 404:
                raise ToolError(f'no event {clean_line(eid, 80)} on the calendar "{self.name}"; only events there can be '
                                'changed or cancelled (never the owner\'s or anyone else\'s)') from None
            raise

    def change(self, a, tz, tz_name):
        self._need_ready()
        ev = self._own_event(a.get('event_id'))
        if ev.get('status') == 'cancelled':
            raise ToolError('that event is cancelled')
        patch = {}
        if a.get('title'):
            patch['summary'] = clean_line(a['title'], 200)
        if 'description' in a and a['description'] is not None:
            patch['description'] = clean_text(str(a['description']))[:4000]
        if 'location' in a and a['location'] is not None:
            patch['location'] = clean_line(a['location'], 300)
        when = self._when(a, tz, tz_name, current=ev)
        if when:
            patch['start'], patch['end'] = when
        old_guests = [str(x.get('email') or '').lower() for x in ev.get('attendees') or [] if not x.get('self')]
        new_guests = self._guests(a.get('guests'))
        if new_guests is not None:
            patch['attendees'] = [{'email': g} for g in new_guests]
        if not patch:
            raise ToolError('nothing to change: give title, start/end, description, location or guests')
        guests = sorted(set(old_guests) | set(new_guests or []))
        title = patch.get('summary') or clean_line(ev.get('summary') or '', 200)
        start = patch.get('start') or ev.get('start') or {}
        end = patch.get('end') or ev.get('end') or {}
        hold = 'guests are told about the change' if guests else (
            'every change waits (Configure Calendar)' if self.hold_all else '')
        req = {'op': 'patch', 'event_id': ev['id'], 'body': patch, 'sendUpdates': 'all' if guests else 'none'}
        return self._do_or_hold(req, 'change event', title, self._when_text(start, end) if start else '', patch,
                                guests, hold)

    def cancel(self, a):
        self._need_ready()
        ev = self._own_event(a.get('event_id'))
        if ev.get('status') == 'cancelled':
            raise ToolError('that event is already cancelled')
        guests = [str(x.get('email') or '').lower() for x in ev.get('attendees') or [] if not x.get('self')]
        hold = 'guests are told it is cancelled' if guests else (
            'every change waits (Configure Calendar)' if self.hold_all else '')
        req = {'op': 'delete', 'event_id': ev['id'], 'sendUpdates': 'all' if guests else 'none'}
        title = clean_line(ev.get('summary') or '', 200)
        return self._do_or_hold(req, 'cancel event', title,
                                self._when_text(ev.get('start') or {}, ev.get('end') or {}) if ev.get('start') else '',
                                {}, guests, hold)

    def _do_or_hold(self, req, what, title, when, body, guests, hold):
        with self.lock:
            self._check_rate()
            for q in self.q.pending():
                if q.get('request') == req:
                    return {'result': 'already waiting for approval', 'request_id': q['id'],
                            'detail': 'Do not ask again; the owner decides in StartOS (Review Agent Actions).'}
            if hold:
                qid = self.q.new_id()
                item = {
                    'id': qid, 'action': what, 'rule': hold, 'requester': 'calendar agent',
                    'summary': f'{what.capitalize()}: {_short(title, 60)}' + (f', {when[:16]}' if when else '')
                               + (f', guests {", ".join(guests)}' if guests else ''),
                    'details': [
                        f'What: {what} on the calendar "{self.name}"',
                        f'Title: {title or "(none)"}',
                        *([f'When: {when}'] if when else []),
                        *([f'Where: {body["location"]}'] if body.get('location') else []),
                        f'Guests: {", ".join(guests) if guests else "none"}',
                        *([f'Description: {_short(body["description"], 400)}'] if body.get('description') else []),
                    ],
                    'recipients': guests, 'request': req,
                    'start': (req.get('body') or {}).get('start') or {},
                }
                self.q.add(item)
                self.svc.log({'event': 'write_queued', 'request_id': qid, 'action': what, 'guests': guests,
                              'rule': hold})
                return {'result': 'waiting for approval', 'request_id': qid, 'rule': hold,
                        **_times(req.get('body') or {}, when),
                        'detail': ('Not done yet. The owner approves or rejects it in StartOS (Review Agent Actions); '
                                   'do not ask again. The status tool shows the outcome.')}
            ev = self._apply(req)
            self.svc.log({'event': 'write_done', 'action': what, 'guests': guests})
            out = {'result': 'done', 'action': what, 'calendar': self.name}
            if ev.get('id'):
                out['event_id'] = ev['id']
            out.update(_times(ev if ev.get('start') else (req.get('body') or {}), when))
            return out

    def _apply(self, req):
        g = self.svc.google
        params = {'sendUpdates': req.get('sendUpdates') or 'none'}
        op = req['op']
        if op == 'insert':
            ev = g.call('POST', self._events_path(), params, req['body'])
        elif op == 'patch':
            ev = g.call('PATCH', self._events_path(req['event_id']), params, req['body'])
        elif op == 'delete':
            g.call('DELETE', self._events_path(req['event_id']), params)
            ev = {'id': req['event_id']}
        else:
            raise ToolError('unknown request')
        self._count_write()
        return ev

    # ── the owner's decisions ──────────────────────────────────────────────

    def _result(self, item, outcome, detail=''):
        self.q.resolve(item, outcome, detail, summary=item.get('summary'))
        self.svc.log({'event': f'write_{outcome}', 'request_id': item['id'], 'action': item.get('action'),
                      'guests': item.get('recipients'), 'detail': detail})

    def process(self):
        with self.lock:
            now = time.time()
            for item in self.q.pending():
                d = self.q.decision(item['id'])
                if d == 'reject':
                    self._result(item, 'rejected', 'rejected in Review Agent Actions')
                elif d == 'approve':
                    self._approved(item)
                elif now > item.get('expires', 0) or _started(item.get('start')):
                    self._result(item, 'expired', 'not decided in time (3 days, or the event has started)')

    def _approved(self, item):
        req = item.get('request') or {}
        bad = [a for a in item.get('recipients') or [] if a not in self.allowed]
        if bad:
            return self._result(item, 'refused', 'no longer on the allowed list: ' + ', '.join(bad))
        if not self.ready:
            return  # waits until writing works again (or expires)
        try:
            if req.get('op') in ('patch', 'delete'):
                self.svc.google.call('GET', self._events_path(req['event_id']))
            self._apply(req)
        except ApiError as e:
            return self._result(item, 'failed', str(e))
        self._result(item, 'done', 'approved in Review Agent Actions')

    def loop(self):
        while True:
            time.sleep(POLL_S)
            if self.svc.state != 'ok' or not self.ready:
                continue
            try:
                self.process()
            except Exception as e:  # never stop the loop
                self.svc.log({'event': 'queue_error', 'type': type(e).__name__, 'detail': clean_line(str(e), 200)})

    def pending_summary(self):
        return [{'id': q['id'], 'summary': q.get('summary', ''), 'rule': q.get('rule', '')} for q in self.q.pending()]

    def status(self):
        return {'calendar': self.name if self.ready else None, 'writing': self.ready,
                'writing_problem': self.reason or None, 'hold_every_event': self.hold_all,
                'allowed_guests': sorted(self.allowed),
                'waiting_for_approval': self.pending_summary(),
                'recent_outcomes': [{k: r.get(k) for k in ('id', 'outcome', 'summary', 'detail')}
                                    for r in self.q.results(10)]}


def _times(ev, when=''):
    """The saved (or requested) start and end, with the time zone, so the
    agent can report them exactly."""
    s, e = ev.get('start') or {}, ev.get('end') or {}
    out = {}
    if s.get('dateTime'):
        out.update(start=s['dateTime'], end=e.get('dateTime'), time_zone=s.get('timeZone') or '')
    elif s.get('date'):
        last = (date.fromisoformat(e['date']) - timedelta(days=1)).isoformat() if e.get('date') else s['date']
        out.update(start=s['date'], end=last, all_day=True)
    elif when:
        out['when'] = when
    return out


def _started(start):
    try:
        if not start:
            return False
        if 'dateTime' in start:
            return datetime.fromisoformat(start['dateTime']).timestamp() < time.time()
        return date.fromisoformat(start['date']) < date.today()
    except (ValueError, TypeError):
        return False
