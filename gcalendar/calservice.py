#!/usr/bin/env python3
"""OpenClaw Extra Butter calendar service.

Runs as its own Linux user (openclaw-calendar) and is the only thing that
talks to Google Calendar and reads the owner's calendar links (secret iCal
addresses, since :24; links.py and ical.py). Links are read only, and they
work with or without a Google sign-in. Started by launch.py, which hands it the settings
and the Google sign-in on stdin and is then gone. Agents reach it as the
MCP server "calendar" (tools calendar__*) through front.py, which stays up
while this worker restarts. The rules below are enforced here, for every
caller.

- Reading never changes anything. Writing (write mode, writes.py) touches
  only the assistant's own Google calendar, under the owner's rules; calendar
  links are never written.
- Everything an organizer wrote (title, description, location, attendee
  names) is outsider text: cleaned, descriptions converted from HTML with
  hidden text removed, wrapped as untrusted content, with heuristic flags.
- Organizer checks are facts, not verification: whether the organizer is
  this account, on the owner's trusted list, or someone else, and whether
  the event came from an emailed invitation (whose organizer is only
  claimed). Calendar has nothing like the mail sender checks.
- The sign-in lives in this process's memory only. When Google refuses it,
  the service waits and exits every 10 minutes, so the launcher fetches it
  again (a new sign-in saved in Vaultwarden is picked up by itself); the
  same refused sign-in is not sent to Google again.
"""

import sys

sys.path.insert(0, '/opt/openclaw-calendar')

import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import secrets  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.parse  # noqa: E402
from datetime import date, datetime, timedelta, timezone  # noqa: E402

import mcp  # noqa: E402
import svcutil  # noqa: E402
from gapi import READ_SCOPES, WRITE_SCOPES, ApiError, Google, SignInRefused, Unreachable  # noqa: E402
from mcp import MAX_EVENTS  # noqa: E402
from links import LINK_PREFIX, Links  # noqa: E402
from writes import Writer  # noqa: E402
from sanitize import clean_line, content_flags, hidden_flags, html_parts, wrap_untrusted  # noqa: E402

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError  # noqa: E402
except ImportError:  # pragma: no cover
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

VERSION = mcp.VERSION
WAIT_REFUSED_S = 600
WAIT_UNAVAILABLE_S = 120
CALLS_PER_MINUTE = 120
LOG_MAX_BYTES = 5 * 1024 * 1024
CAL_CACHE_S = 300
RETRY_S = 60
ToolError = mcp.ToolError
_now = svcutil.now_text


class Service:
    def __init__(self, cfg, token, reason):
        self.cfg = cfg
        self.state_dir = cfg['stateDir']
        self.state = 'starting'
        self.reason = ''
        self.since = _now()
        self.trusted = [t.strip().lower() for t in cfg.get('trustedOrganizers') or [] if t.strip()]
        self.google = Google(token, cfg.get('endpoints')) if token else None
        self.account = (token or {}).get('account') or cfg.get('account') or ''
        self._fp = self._fingerprint(token['refresh_token']) if token else None
        self._log = svcutil.ActivityLog(os.path.join(self.state_dir, 'activity.jsonl'), LOG_MAX_BYTES)
        self._calls = []
        self._calls_lock = threading.Lock()
        self.writer = Writer(self, cfg) if cfg.get('mode') == 'write' and token else None
        self.links = Links(cfg.get('links'))
        # A Google sign-in that was wanted but could not be had, while the
        # calendar links still work: a warning, not a stopped service.
        self.google_problem = ''
        if not token:
            if self.links:
                if cfg.get('tokenSource') != 'none':
                    self.google_problem = reason or 'no Google sign-in was available'
            else:
                self.set_state('unavailable', reason or 'no Calendar sign-in was available')

    def log(self, entry):
        self._log(entry)

    def set_state(self, state, reason=''):
        if state != self.state or reason != self.reason:
            self.since = _now()
        self.state, self.reason = state, reason
        self.log({'event': 'state', 'state': state, 'reason': reason})

    # The refused-sign-in guard: a salted fingerprint, never the token.

    def _salt(self):
        p = os.path.join(self.state_dir, 'salt')
        try:
            with open(p, 'rb') as f:
                s = f.read()
            if len(s) == 16:
                return s
        except OSError:
            pass
        s = secrets.token_bytes(16)
        svcutil.write_private(p, s)
        return s

    def _fingerprint(self, refresh_token):
        return hashlib.sha256(self._salt() + refresh_token.encode()).hexdigest()

    def _refused_path(self):
        return os.path.join(self.state_dir, 'refused.json')

    def refused_record(self):
        try:
            with open(self._refused_path()) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def refused(self, why):
        rec = self.refused_record()
        since = rec['since'] if rec and rec.get('fp') == self._fp else _now()
        svcutil.write_private(self._refused_path(), json.dumps(
            {'fp': self._fp, 'since': since, 'why': clean_line(why, 300)}).encode())
        self.since = since
        self.state = 'refused'
        self.reason = self._refused_text(why)
        self.log({'event': 'sign_in_refused', 'detail': clean_line(why, 300)})
        svcutil.schedule_exit(0, WAIT_REFUSED_S)

    def _refused_text(self, why):
        where = ('save a new sign-in in Vaultwarden item "google-calendar"' if self.cfg.get('tokenSource') == 'vault'
                 else 'paste a new sign-in in Configure Calendar')
        return f'{why}; {where}'

    def startup(self):
        """Seconds after which to exit and be relaunched, or None."""
        if self.google is None:
            if self.links:
                self.set_state('ok')
                # Try a wanted but missing sign-in again later.
                return WAIT_REFUSED_S if self.google_problem else None
            return WAIT_UNAVAILABLE_S
        rec = self.refused_record()
        if rec and rec.get('fp') == self._fp:
            self.state, self.since = 'refused', rec.get('since') or _now()
            self.reason = self._refused_text(rec.get('why') or 'Google refused this sign-in')
            self.log({'event': 'state', 'state': 'refused', 'reason': 'same sign-in as last refused; not sending it again'})
            return WAIT_REFUSED_S
        try:
            self.google.refresh()
        except SignInRefused as e:
            self.refused(str(e))
            return None  # refused() scheduled the exit
        except Unreachable as e:
            self.set_state('unreachable', str(e))
            return None
        try:
            os.unlink(self._refused_path())
        except OSError:
            pass
        self.set_state('ok')
        return None

    def rate_ok(self):
        now = time.time()
        with self._calls_lock:
            self._calls = [t for t in self._calls if now - t < 60]
            if len(self._calls) >= CALLS_PER_MINUTE:
                return False
            self._calls.append(now)
            return True

    def scope_notes(self):
        sc = set(self.google.scopes) if self.google else set()
        notes = []
        if self.google_problem:
            notes.append(f'Google calendars are not read: {self.google_problem}')
        if self.cfg.get('mode') == 'write' and not self.google:
            notes.append('write mode needs a Google sign-in; without one the calendar is read only')
        for x in self.links.items:
            if x.error:
                old = f' (showing the copy from {x.fetched_ok})' if x.feed is not None and x.fetched_ok else ''
                notes.append(f'calendar link "{x.name}": {x.error}{old}')
        if self.writer and not self.writer.ready and self.writer.reason:
            notes.append(self.writer.reason)
        if sc and not (sc & READ_SCOPES):
            notes.append('the sign-in does not allow reading calendars (calendar.readonly is missing)')
        broad = sorted((sc & WRITE_SCOPES) - {'calendar.app.created'})
        if broad:
            notes.append('the sign-in also allows changes (' + ', '.join(broad) + '); this service never makes any, '
                         'but a read-only sign-in (calendar.readonly) is safer')
        return notes

    def health(self):
        return {
            'state': self.state, 'since': self.since, 'reason': self.reason,
            'account': self.account, 'mode': self.cfg.get('mode') or 'read',
            'writing': bool(self.writer and self.writer.ready),
            'writingProblem': (self.writer.reason if self.writer and not self.writer.ready else ''),
            'calendarName': self.writer.name if self.writer else '',
            'scopes': self.google.scopes if self.google else [],
            'warnings': self.scope_notes() if self.state == 'ok' else [],
            'tokenSource': self.cfg.get('tokenSource'),
            'google': bool(self.google),
            'links': self.links.health(),
            'trustedOrganizers': len(self.trusted), 'version': VERSION,
            'note': self.cfg.get('note') or '',
            # Summary only (no event text beyond the title): the package
            # raises the Review Agent Actions task from it.
            'queue': self.writer.pending_summary() if self.writer else [],
        }


# ── Helpers ────────────────────────────────────────────────────────────────

_DATE = re.compile(r'\d{4}-\d{2}-\d{2}')


def _zone(name):
    if ZoneInfo and name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    return timezone.utc


def _bound(value, name, tz, default, end=False):
    """An RFC 3339 time for the API from YYYY-MM-DD or a date-time."""
    if value in (None, ''):
        return default
    s = str(value).strip()
    try:
        if _DATE.fullmatch(s):
            d = date.fromisoformat(s)
            if end:
                d += timedelta(days=1)
            return datetime(d.year, d.month, d.day, tzinfo=tz)
        t = datetime.fromisoformat(s.replace('Z', '+00:00'))
        return t if t.tzinfo else t.replace(tzinfo=tz)
    except ValueError:
        raise ToolError(f'{name}: use YYYY-MM-DD or a date-time like 2026-11-02T09:00') from None


def _limit(a, default):
    v = a.get('limit', default)
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ToolError('limit: a whole number from 1')
    return min(v, MAX_EVENTS)


def _when(t):
    if not isinstance(t, dict):
        return '', False
    if t.get('date'):
        return str(t['date']), True
    return str(t.get('dateTime') or ''), False


def _addr(p):
    return str((p or {}).get('email') or '').strip().lower()


def _fmt(t, tz):
    """An instance time as the Google path gives it: date, or offset date-time."""
    if isinstance(t, datetime):
        return t.astimezone(tz).isoformat()
    return t.isoformat()


def _ical_time(v):
    """'20261101T120000Z' → RFC 3339, or '' (CREATED / LAST-MODIFIED)."""
    m = re.fullmatch(r'(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?', (v or '').strip())
    return f'{m[1]}-{m[2]}-{m[3]}T{m[4]}:{m[5]}:{m[6]}Z' if m else ''


_RESPONSES = {'accepted': 'accepted', 'declined': 'declined', 'tentative': 'tentative',
              'needs-action': 'needsAction', 'delegated': 'needsAction'}


class Tools:
    def __init__(self, svc):
        self.svc = svc
        self._cals = None
        self._cals_at = 0
        self._gerr = ''

    def call(self, name, args):
        fn = getattr(self, f't_{name}', None) if isinstance(name, str) and name.isidentifier() else None
        if fn is None:
            raise ToolError(f'unknown tool {name}')
        self._gerr = ''
        if name != 'status' and self.svc.state not in ('ok', 'unreachable') and not self.svc.links:
            raise ToolError(self._unavailable())
        if not self.svc.rate_ok():
            raise ToolError(f'too many calendar requests (more than {CALLS_PER_MINUTE} a minute); wait a minute')
        try:
            out = fn(args)
        except SignInRefused as e:
            self.svc.refused(str(e))
            raise ToolError('the calendar sign-in was refused by Google; the Calendar Service line in StartOS says what to do') from None
        except Unreachable as e:
            self.svc.set_state('unreachable', str(e))
            raise ToolError(str(e)) from None
        except ApiError as e:
            raise ToolError(str(e)) from None
        if self.svc.state == 'unreachable' and not self._gerr and self._google_usable():
            self.svc.set_state('ok')  # Google answered again
        return out

    def _unavailable(self):
        s = self.svc
        return f'calendar service {s.state}: {s.reason}' if s.reason else f'calendar service {s.state}'

    # calendars

    def _google_usable(self):
        return self.svc.google is not None and self.svc.state in ('ok', 'unreachable')

    def _calendars(self):
        """Google's calendar list plus the calendar links. With links, a
        Google problem is reported (self._gerr) instead of stopping reads."""
        cals = []
        if self._google_usable():
            try:
                cals = self._google_calendars()
            except (Unreachable, ApiError, SignInRefused) as e:
                if not self.svc.links:
                    raise
                if isinstance(e, SignInRefused):
                    self.svc.refused(str(e))
                elif isinstance(e, Unreachable):
                    self.svc.set_state('unreachable', str(e))
                self._gerr = f'Google calendars: {e}'
                cals = list(self._cals or [])
        elif self.svc.google is not None:
            self._gerr = f'Google calendars: {self._unavailable()}'
        return cals + self._link_cals()

    def _link_cals(self):
        out = []
        for x in self.svc.links.items:
            out.append({'id': x.id, 'summary': x.name, 'accessRole': 'reader', 'selected': True,
                        'timeZone': (x.feed.zone_name if x.feed else '') or None, '_link': x})
        return out

    def _google_calendars(self):
        if self._cals is None or time.time() - self._cals_at > CAL_CACHE_S:
            items, page = [], None
            for _ in range(10):
                d = self.svc.google.get('/users/me/calendarList', {'maxResults': 250, 'pageToken': page})
                items += d.get('items') or []
                page = d.get('nextPageToken')
                if not page:
                    break
            self._cals = items
            self._cals_at = time.time()
        return self._cals

    def _primary_zone(self):
        for c in self._calendars():
            if c.get('primary'):
                return _zone(c.get('timeZone'))
        # No Google account: the first calendar link that names its zone.
        for x in self.svc.links.items:
            f = x.get(timezone.utc)
            if f is not None and f.zone_name:
                return f.tz
        return timezone.utc

    def _targets(self, a):
        want = str(a.get('calendar') or 'all').strip()
        cals = self._calendars()
        if want.lower() == 'all':
            shown = [c for c in cals if c.get('selected', True) and not c.get('hidden')]
            return shown or cals
        for c in cals:
            if c.get('id') == want:
                return [c]
        if want.lower() == 'primary':
            return [c for c in cals if c.get('primary')][:1] or [{'id': 'primary'}]
        raise ToolError(f'no calendar with id {clean_line(want, 100)}; the calendars tool lists them')

    @staticmethod
    def _cal_name(c):
        return clean_line(c.get('summaryOverride') or c.get('summary') or c.get('id') or '', 120)

    def t_status(self, a):
        h = self.svc.health()
        out = {k: h[k] for k in ('state', 'reason', 'since', 'account', 'mode', 'scopes', 'warnings', 'trustedOrganizers')}
        if self.svc.writer:
            out.update(self.svc.writer.status())
        return out

    def _writer(self):
        if not self.svc.writer:
            raise ToolError('the calendar is read only (Configure Calendar); nothing can be added, changed or cancelled')
        return self.svc.writer

    def _tz(self):
        tz = self._primary_zone()
        return tz, str(getattr(tz, 'key', 'UTC'))

    def t_create_event(self, a):
        return self._writer().create(a, *self._tz())

    def t_change_event(self, a):
        return self._writer().change(a, *self._tz())

    def t_cancel_event(self, a):
        return self._writer().cancel(a)

    def t_calendars(self, a):
        out, errors = [], []
        for c in self._calendars():
            row = {
                'id': c.get('id'), 'name': self._cal_name(c), 'primary': bool(c.get('primary')),
                'access': c.get('accessRole'), 'time_zone': c.get('timeZone'),
                'shown': bool(c.get('selected', True)) and not c.get('hidden'),
            }
            link = c.get('_link')
            if link is not None:
                f = link.get(self._primary_zone())
                row.update({'access': 'reader (calendar link, read only)', 'link': True,
                            'time_zone': (f.zone_name if f else '') or None})
                if link.error:
                    errors.append(f'{link.name}: {link.error}')
            out.append(row)
        if self._gerr:
            errors.insert(0, self._gerr)
        self.svc.log({'event': 'calendars', 'count': len(out)})
        return {'calendars': out, **({'errors': errors} if errors else {})}

    # events

    def _organizer(self, e):
        org, creator = e.get('organizer') or {}, e.get('creator') or {}
        addr = _addr(org)
        flags = []
        if org.get('self') or (not addr and creator.get('self')):
            flags.append('organizer_self')
        elif addr and addr in self.svc.trusted:
            flags.append('organizer_trusted')
        else:
            flags.append('external_organizer')
        uid = str(e.get('iCalUID') or '')
        if e.get('eventType') == 'fromGmail':
            flags.append('from_gmail')
        elif uid and not uid.endswith('@google.com') and 'organizer_self' not in flags:
            # Made outside Google and sent as an emailed invitation: the
            # organizer address is only what the invitation claims.
            flags.append('organizer_unverifiable')
        # Someone else put it there. Not for events whose organizer is the
        # calendar itself (the agent's own calendar names itself as the
        # organizer and the account as the creator), nor when the creator
        # is this account.
        cre = _addr(creator)
        if (cre and cre != addr and not creator.get('self') and not org.get('self')
                and cre != (self.svc.account or '').lower()):
            flags.append('creator_differs')
        name = clean_line(org.get('displayName') or '', 80)
        return (f'{name} <{addr}>' if name and addr else addr or name or 'unknown'), flags

    def _brief(self, e, cal):
        start, all_day = _when(e.get('start'))
        end, _ = _when(e.get('end'))
        organizer, flags = self._organizer(e)
        title = clean_line(e.get('summary') or '(no title)', 200)
        flags += [f for f in content_flags(title) if f not in flags]
        me = next((x for x in e.get('attendees') or [] if x.get('self')), None)
        return {
            'id': e.get('id'), 'calendar': cal.get('id'), 'calendar_name': self._cal_name(cal),
            'start': start, 'end': end, 'all_day': all_day, 'title': title,
            'status': e.get('status'), 'organizer': organizer,
            'my_response': (me or {}).get('responseStatus'),
            'attendees': len(e.get('attendees') or []),
            'recurring': bool(e.get('recurringEventId')),
            'flags': flags,
        }

    def _events(self, a, text=None, back_days=0, ahead_days=7, default_limit=50):
        tz = self._primary_zone()
        now = datetime.now(tz)
        start = _bound(a.get('from'), 'from', tz, now - timedelta(days=back_days))
        end = _bound(a.get('to'), 'to', tz, start + timedelta(days=ahead_days), end=True)
        if end <= start:
            raise ToolError('to: must be after from')
        if end - start > timedelta(days=400):
            raise ToolError('the range is too long (more than 400 days); ask for a shorter one')
        limit = _limit(a, default_limit)
        events, errors = [], []
        for cal in self._targets(a):
            if cal.get('_link') is not None:
                events += self._link_events(cal['_link'], cal, start, end, text, tz, errors)
                continue
            if not self._google_usable():
                errors.append(f'{self._cal_name(cal)}: {self._unavailable()}')
                continue
            try:
                d = self.svc.google.get(f'/calendars/{urllib.parse.quote(cal["id"], safe="")}/events', {
                    'timeMin': start.isoformat(), 'timeMax': end.isoformat(), 'singleEvents': 'true',
                    'orderBy': 'startTime', 'maxResults': limit, 'q': text,
                    'timeZone': str(getattr(tz, 'key', 'UTC')),
                })
            except ApiError as e:
                errors.append(f'{self._cal_name(cal)}: {e}')
                continue
            events += [self._brief(e, cal) for e in d.get('items') or [] if e.get('status') != 'cancelled']
        if self._gerr:
            errors.insert(0, self._gerr)
        events.sort(key=lambda x: (_sort_key(x['start']), x['title']))
        out = {'from': start.isoformat(), 'to': end.isoformat(), 'events': events[:limit],
               'more': len(events) > limit}
        if errors:
            out['errors'] = errors
        return out

    # calendar links

    def _link_feed(self, link, tz, errors):
        f = link.get(tz)
        if link.error:
            old = f' (showing the copy from {link.fetched_ok})' if f is not None and link.fetched_ok else ''
            errors.append(f'{link.name}: {link.error}{old}')
        return f

    def _link_events(self, link, cal, start, end, text, tz, errors):
        f = self._link_feed(link, tz, errors)
        if f is None:
            return []
        words = text.lower().split() if text else []
        out = []
        for inst in f.instances(start, end, tz):
            ev = inst['event']
            if words:
                hay = ' '.join([ev['summary'], ev['description'], ev['location'],
                                ev['organizer'].get('email', ''), ev['organizer'].get('name', '')]
                               + [f"{x['name']} {x['email']}" for x in ev['attendees']]).lower()
                if not all(w in hay for w in words):
                    continue
            out.append(self._link_brief(inst, cal, link, f, tz))
        return out

    def _link_organizer(self, ev, feed):
        org = ev['organizer'] or {}
        addr = str(org.get('email') or '').lower()
        acct = (self.svc.account or '').lower()
        flags = ['from_link']
        if not addr:
            flags.append('no_organizer')
        elif acct and addr == acct:
            flags.append('organizer_self')
        elif addr in self.svc.trusted:
            flags.append('organizer_trusted')
        else:
            flags.append('external_organizer')
        # A feed shows what the calendar holds; only events made in Google
        # (in a Google feed) are known not to be emailed invitations.
        if addr and 'organizer_self' not in flags and not (feed.from_google and ev['uid'].endswith('@google.com')):
            flags.append('organizer_unverifiable')
        name = clean_line(org.get('name') or '', 80)
        return (f'{name} <{addr}>' if name and addr else addr or name or 'none named'), flags

    def _link_brief(self, inst, cal, link, feed, tz):
        ev = inst['event']
        organizer, flags = self._link_organizer(ev, feed)
        title = clean_line(ev['summary'] or '(no title)', 200)
        flags += [f for f in content_flags(title) if f not in flags]
        acct = (self.svc.account or '').lower()
        me = next((x for x in ev['attendees'] if acct and x['email'] == acct), None)
        return {
            'id': inst['id'], 'calendar': cal['id'], 'calendar_name': clean_line(link.name, 120),
            'start': _fmt(inst['start'], tz), 'end': _fmt(inst['end'], tz), 'all_day': inst['all_day'],
            'title': title, 'status': ev['status'].lower() or 'confirmed', 'organizer': organizer,
            'my_response': _RESPONSES.get(me['response']) if me else None,
            'attendees': len(ev['attendees']),
            'recurring': bool(ev['rrule'] or ev['rdates'] or ev['recurrence_id'] is not None),
            'flags': flags,
        }

    def t_list(self, a):
        out = self._events(a)
        self.svc.log({'event': 'list', 'count': len(out['events'])})
        return out

    def t_search(self, a):
        text = clean_line(a.get('text') or '', 200)
        if not text:
            raise ToolError('text: give the words to find')
        out = self._events(a, text=text, back_days=30, ahead_days=210, default_limit=25)
        self.svc.log({'event': 'search', 'count': len(out['events'])})
        return out

    def t_read(self, a):
        cal_id = str(a.get('calendar') or '').strip()
        ev_id = str(a.get('event_id') or '').strip()
        if not cal_id or not ev_id or len(ev_id) > 1024:
            raise ToolError('give calendar and event_id from list or search')
        if cal_id.startswith(LINK_PREFIX):
            return self._read_link(cal_id, ev_id)
        if not self._google_usable():
            raise ToolError(self._unavailable())
        cal = next((c for c in self._calendars() if c.get('id') == cal_id), {'id': cal_id})
        e = self.svc.google.get(f'/calendars/{urllib.parse.quote(cal_id, safe="")}/events/{urllib.parse.quote(ev_id, safe="")}')
        brief = self._brief(e, cal)
        attendees = [{'email': _addr(x), 'name': clean_line(x.get('displayName') or '', 80),
                      'response': x.get('responseStatus'), 'organizer': bool(x.get('organizer')),
                      'optional': bool(x.get('optional')), 'self': bool(x.get('self'))}
                     for x in (e.get('attendees') or [])[:100]]
        return self._full(cal_id, brief, str(e.get('description') or ''), e.get('location') or '',
                          [x.get('title') or '' for x in (e.get('attachments') or [])],
                          bool(e.get('hangoutLink') or e.get('conferenceData')), attendees,
                          e.get('visibility') or 'default', e.get('created'), e.get('updated'))

    def _read_link(self, cal_id, ev_id):
        link = self.svc.links.by_id(cal_id)
        if link is None:
            raise ToolError(f'no calendar with id {clean_line(cal_id, 100)}; the calendars tool lists them')
        tz = self._primary_zone()
        errors = []
        f = self._link_feed(link, tz, errors)
        if f is None:
            raise ToolError(errors[0] if errors else f'{link.name}: the calendar link could not be read')
        inst = f.find(ev_id, tz)
        if inst is None:
            raise ToolError('not found (wrong event id, or it is no longer on that calendar)')
        ev = inst['event']
        brief = self._link_brief(inst, {'id': cal_id}, link, f, tz)
        org = (ev['organizer'] or {}).get('email') or ''
        acct = (self.svc.account or '').lower()
        attendees = [{'email': x['email'], 'name': clean_line(x['name'], 80),
                      'response': _RESPONSES.get(x['response'], x['response']), 'organizer': bool(org) and x['email'] == org,
                      'optional': x['optional'], 'self': bool(acct) and x['email'] == acct}
                     for x in ev['attendees'][:100]]
        out = self._full(cal_id, brief, ev['description'], ev['location'],
                         ['attachment'] * min(ev['attachments'], 20), ev['conference'] or bool(ev['url']), attendees,
                         {'PRIVATE': 'private', 'CONFIDENTIAL': 'confidential', 'PUBLIC': 'public'}.get(ev['class'], 'default'),
                         _ical_time(ev['created']), _ical_time(ev['updated']))
        if errors:
            out['warnings'].append(errors[0])
        return out

    def _full(self, cal_id, brief, desc_html, location, attachment_titles, video, attendees,
              visibility, created, updated):
        """One event in full (read), the same for Google and calendar links."""
        if '<' in desc_html and '>' in desc_html:
            desc, hidden, links, hidden_text = html_parts(desc_html)
        else:
            desc, hidden, links, hidden_text = desc_html, 0, len(re.findall(r'https?://', desc_html)), ''
        location = clean_line(location or '', 500)
        flags = brief['flags']
        for f in content_flags(desc) + content_flags(location):
            if f not in flags:
                flags.append(f)
        warnings = []
        flags += [f for f in hidden_flags(hidden, hidden_text) if f not in flags]
        if hidden:
            warnings.append(f'{hidden} characters of hidden text were removed from the description')
        if links or video:
            flags.append('links_present')
        if attachment_titles:
            flags.append('attachments_present')
        if 'organizer_unverifiable' in flags:
            warnings.append('the organizer address is only what the calendar link says (the event may come from an emailed invitation)'
                            if 'from_link' in flags else
                            'this event came from an emailed invitation: the organizer address is only what the invitation claims')
        content = []
        if desc.strip():
            content.append('Description:\n' + desc.strip())
        if location:
            content.append('Location: ' + location)
        for x in attachment_titles[:20]:
            content.append('Attachment: ' + clean_line(x or '', 120))
        out = {**brief, 'flags': flags, 'warnings': warnings, 'attendees': attendees,
               'visibility': visibility, 'created': created,
               'updated': updated, 'has_video_link': bool(video),
               'content': 'between the UNTRUSTED markers below' if content else 'none'}
        if content:
            wrapped, truncated = wrap_untrusted('\n\n'.join(content), 'CALENDAR EVENT CONTENT', 12000)
            out['_untrusted'] = wrapped
            if truncated:
                warnings.append('the description was cut (too long)')
        self.svc.log({'event': 'read', 'calendar': cal_id[:200], 'flags': flags})
        return out


def _sort_key(s):
    try:
        if _DATE.fullmatch(s or ''):
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()
        return datetime.fromisoformat((s or '').replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0


# ── Start ──────────────────────────────────────────────────────────────────

def _retry_loop(svc):
    """While Google cannot be reached, try the sign-in again every minute,
    so the health line recovers without a tool call."""
    while True:
        time.sleep(RETRY_S)
        if svc.state != 'unreachable' or svc.google is None:
            continue
        try:
            svc.google.refresh()
            svc.set_state('ok')
            _setup_writer(svc, None)
        except SignInRefused as e:
            svc.refused(str(e))
        except Unreachable as e:
            svc.reason = str(e)


def _setup_writer(svc, tools):
    if not svc.writer or svc.writer.ready or svc.state != 'ok':
        return
    tools = tools or getattr(svc, 'tools', None) or Tools(svc)
    try:
        tz = tools._primary_zone()
    except Exception:
        tz = timezone.utc
    svc.writer.setup(str(getattr(tz, 'key', 'UTC')))
    tools._cals = None  # the own calendar may be new: list it from now on


def serve_worker(svc, tools, path):
    def call_tool(rid, params):
        return mcp.run_tool(rid, params, tools.call, svc.log)
    return svcutil.serve_unix(path, mcp.make_handler(call_tool, svc.health))


def parse_token(raw):
    """The sign-in JSON (tools/google-signin.py) → dict, or (None, why)."""
    if not raw:
        return None, ''
    try:
        t = json.loads(raw)
    except ValueError:
        return None, 'the Calendar sign-in is not valid JSON (paste the whole output of google-signin.py)'
    if not isinstance(t, dict) or not t.get('refresh_token') or not t.get('client_id'):
        return None, 'the Calendar sign-in has no refresh_token or client_id (paste the whole output of google-signin.py)'
    return t, ''


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(256 * 1024)
    try:
        payload = json.loads(raw)
    except ValueError:
        print('calendar service: no settings on stdin; start it with launch.py', file=sys.stderr)
        return 2
    token_raw = payload.pop('token', None) or ''
    reason = payload.pop('tokenError', '') or ''
    del raw
    token, why = parse_token(token_raw)
    del token_raw
    cfg = payload
    os.makedirs(cfg['stateDir'], mode=0o700, exist_ok=True)
    svc = Service(cfg, token, reason or why)
    del token
    tools = Tools(svc)
    svc.tools = tools
    exit_after = svc.startup()
    srv = serve_worker(svc, tools, cfg.get('socket') or os.path.join(cfg['stateDir'], 'worker.sock'))
    threading.Thread(target=_retry_loop, args=(svc,), daemon=True).start()
    if svc.links:
        # Fetch the calendar links once now, so the health line can say
        # whether they work before anyone asks.
        threading.Thread(target=lambda: svc.links.warm(tools._primary_zone() if svc.google is None
                                                       else timezone.utc), daemon=True).start()
    if svc.writer:
        _setup_writer(svc, tools)
        threading.Thread(target=svc.writer.loop, daemon=True).start()
    if exit_after:
        svcutil.schedule_exit(0, exit_after)
        print(f'calendar service: {svc.state}: {svc.reason or svc.google_problem}; checking again in {exit_after // 60} min', flush=True)
    else:
        print(f'calendar service: {svc.state}{": " + svc.reason if svc.reason else ""}; '
              f'serving {svc.account or "the calendar"}'
              f'{f" and {len(svc.links.items)} calendar link(s)" if svc.links else ""} to the front door', flush=True)
    srv.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
