"""Calendar links: reading iCalendar feeds (RFC 5545), standard library only.

A calendar link is a calendar's secret address in iCal format (Google's
"Secret address in iCal format", an iCloud public calendar, an Outlook ICS
link, Nextcloud, Fastmail, ...). parse() turns the feed text into a Feed;
Feed.instances() gives the events in a time range with recurring events
expanded (RRULE, RDATE, EXDATE, and changed or cancelled single instances
via RECURRENCE-ID).

Supported recurrence: FREQ DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL,
COUNT, UNTIL, BYDAY (with positions), BYMONTHDAY, BYMONTH, BYYEARDAY,
BYSETPOS, BYHOUR, BYMINUTE and WKST. Rules this does not understand
(BYWEEKNO, FREQ below a day) give the first instance only, and the feed
says so in its problems. Times are expanded in the event's own time zone,
so a weekly 9:00 meeting stays at 9:00 across daylight-saving changes.
"""

import calendar as _cal
import hashlib
import re
from datetime import date, datetime, time, timedelta, timezone

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

MAX_EVENTS = 20000          # VEVENTs read from one feed
MAX_PERIODS = 20000         # recurrence periods looked at for one event
MAX_INSTANCES = 5000        # instances of one event in one range
# Recurrence work for one query (candidate times looked at, all events
# together, about 7 µs each): a feed whose rules repeat absurdly often
# (COUNT, BYHOUR×BYMINUTE from 1970 …) cannot keep the service busy for
# minutes per question. A year of hundreds of daily events stays well below.
MAX_WORK = 1_000_000
MAX_WORK_FIND = 200_000
WORK_PROBLEM = 'recurring events repeat too often to work out in full; some times may be missing'
MAX_PROBLEMS = 20

UTC = timezone.utc
_WEEKDAYS = {'MO': 0, 'TU': 1, 'WE': 2, 'TH': 3, 'FR': 4, 'SA': 5, 'SU': 6}

# Windows time zone names (Outlook, Exchange) for the common zones.
WINDOWS_ZONES = {
    'Dateline Standard Time': 'Etc/GMT+12', 'Hawaiian Standard Time': 'Pacific/Honolulu',
    'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles',
    'Pacific Standard Time (Mexico)': 'America/Tijuana', 'US Mountain Standard Time': 'America/Phoenix',
    'Mountain Standard Time': 'America/Denver', 'Mountain Standard Time (Mexico)': 'America/Mazatlan',
    'Central America Standard Time': 'America/Guatemala', 'Central Standard Time': 'America/Chicago',
    'Central Standard Time (Mexico)': 'America/Mexico_City', 'Canada Central Standard Time': 'America/Regina',
    'SA Pacific Standard Time': 'America/Bogota', 'Eastern Standard Time': 'America/New_York',
    'US Eastern Standard Time': 'America/Indiana/Indianapolis', 'Atlantic Standard Time': 'America/Halifax',
    'Newfoundland Standard Time': 'America/St_Johns', 'E. South America Standard Time': 'America/Sao_Paulo',
    'Argentina Standard Time': 'America/Buenos_Aires', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
    'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
    'Romance Standard Time': 'Europe/Paris', 'Central European Standard Time': 'Europe/Warsaw',
    'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
    'GTB Standard Time': 'Europe/Bucharest', 'Turkey Standard Time': 'Europe/Istanbul',
    'Israel Standard Time': 'Asia/Jerusalem', 'South Africa Standard Time': 'Africa/Johannesburg',
    'Russian Standard Time': 'Europe/Moscow', 'Arabian Standard Time': 'Asia/Dubai',
    'Arab Standard Time': 'Asia/Riyadh', 'India Standard Time': 'Asia/Kolkata',
    'SE Asia Standard Time': 'Asia/Bangkok', 'Singapore Standard Time': 'Asia/Singapore',
    'China Standard Time': 'Asia/Shanghai', 'Taipei Standard Time': 'Asia/Taipei',
    'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
    'W. Australia Standard Time': 'Australia/Perth', 'Cen. Australia Standard Time': 'Australia/Adelaide',
    'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
    'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland',
}


def zone(name):
    """A tzinfo for a time zone name (IANA or Windows), or None."""
    if not name or ZoneInfo is None:
        return None
    name = str(name).strip().strip('"')
    for cand in (name, WINDOWS_ZONES.get(name), name.rsplit('/', 3)[-2] + '/' + name.rsplit('/', 1)[-1]
                 if name.startswith('/') and name.count('/') >= 3 else None):
        if not cand:
            continue
        if cand.upper() in ('UTC', 'GMT', 'Z', 'ETC/UTC'):
            return UTC
        try:
            return ZoneInfo(cand)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            continue
    return None


# ── Content lines ──────────────────────────────────────────────────────────

def _unfold(text):
    out = []
    for line in re.split(r'\r\n|\n|\r', text):
        if line[:1] in (' ', '\t') and out:
            out[-1] += line[1:]
        elif line:
            out.append(line)
    return out


def _split_line(line):
    """'NAME;P=v;Q="a:b":value' → (NAME, {P: v, Q: a:b}, value)."""
    i, quoted, n = 0, False, len(line)
    while i < n:
        c = line[i]
        if c == '"':
            quoted = not quoted
        elif c == ':' and not quoted:
            break
        i += 1
    head, value = line[:i], line[i + 1:]
    parts, cur, quoted = [], '', False
    for c in head:
        if c == '"':
            quoted = not quoted
            cur += c
        elif c == ';' and not quoted:
            parts.append(cur)
            cur = ''
        else:
            cur += c
    parts.append(cur)
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition('=')
        params[k.strip().upper()] = v.strip().strip('"')
    return parts[0].strip().upper(), params, value


def unescape(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            nxt = s[i + 1]
            out.append('\n' if nxt in 'nN' else nxt)
            i += 2
            continue
        out.append(c)
        i += 1
    return ''.join(out)


# ── Values ─────────────────────────────────────────────────────────────────

_DT = re.compile(r'(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$')


class Feed:
    def __init__(self):
        self.prodid = ''
        self.name = ''
        self.zone_name = ''
        self.tz = None
        self.events = []        # masters and single events
        self.overrides = {}     # uid → {recurrence key: event}
        self.problems = []
        self._unknown_zones = set()
        self._vtimezones = {}

    def problem(self, text):
        if text not in self.problems and len(self.problems) < MAX_PROBLEMS:
            self.problems.append(text)

    @property
    def from_google(self):
        return 'google' in self.prodid.lower()

    def tz_for(self, params, fallback):
        tzid = params.get('TZID')
        if not tzid:
            return None
        z = zone(tzid) or self._vtimezones.get(tzid)
        if z is None:
            if tzid not in self._unknown_zones:
                self._unknown_zones.add(tzid)
                self.problem(f'unknown time zone "{tzid[:60]}"; its times are read as '
                             f'{getattr(fallback, "key", "UTC")}')
            return fallback
        return z

    def value_time(self, value, params, fallback_tz):
        """DATE → date; DATE-TIME → aware datetime (floating: fallback_tz)."""
        m = _DT.match(value.strip())
        if not m:
            raise ValueError(f'not a date: {value[:40]}')
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if m.group(4) is None or params.get('VALUE', '').upper() == 'DATE':
            return date(y, mo, d)
        t = datetime(y, mo, d, int(m.group(4)), int(m.group(5)), int(m.group(6) or 0))
        if m.group(7):
            return t.replace(tzinfo=UTC)
        return t.replace(tzinfo=self.tz_for(params, fallback_tz) or fallback_tz)

    def instances(self, start, end, display_tz):
        """Every instance overlapping [start, end) (aware datetimes)."""
        out = []
        budget = [MAX_WORK]
        for ev in self.events:
            if ev['status'] == 'CANCELLED':
                continue
            over = self.overrides.get(ev['uid'], {})
            if ev.get('rrule') or ev.get('rdates'):
                for inst in _expand(ev, start, end, display_tz, self, budget):
                    if inst['key'] in over or inst['key'] in ev['exdates']:
                        continue
                    out.append(inst)
            elif _overlaps(ev['start'], ev['end'], start, end, display_tz):
                out.append(_instance(ev, ev['start'], ev['end'], None))
        for uid, ovs in self.overrides.items():
            for key, ov in ovs.items():
                if ov['status'] == 'CANCELLED':
                    continue
                if _overlaps(ov['start'], ov['end'], start, end, display_tz):
                    out.append(_instance(ov, ov['start'], ov['end'], key))
        return out

    def find(self, event_id, display_tz):
        """The instance with this id (from instances()), or None."""
        base, _, key = event_id.partition('_')
        for uid, ovs in self.overrides.items():
            if _uid_hash(uid) == base and key in ovs:
                ov = ovs[key]
                return None if ov['status'] == 'CANCELLED' else _instance(ov, ov['start'], ov['end'], key)
        for ev in self.events:
            if _uid_hash(ev['uid']) != base or ev['status'] == 'CANCELLED':
                continue
            if not key:
                return _instance(ev, ev['start'], ev['end'], None)
            if key in ev['exdates']:
                return None
            t = _key_time(key)
            if t is None:
                return None
            for inst in _expand(ev, t - timedelta(days=2), t + timedelta(days=2), display_tz, self, [MAX_WORK_FIND]):
                if inst['key'] == key:
                    return inst
        return None


def _uid_hash(uid):
    return hashlib.sha256(uid.encode('utf-8', 'replace')).hexdigest()[:24]


def recurrence_key(t):
    if isinstance(t, datetime):
        return t.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')
    return t.strftime('%Y%m%d')


def _key_time(key):
    try:
        if 'T' in key:
            return datetime.strptime(key, '%Y%m%dT%H%M%SZ').replace(tzinfo=UTC)
        d = datetime.strptime(key, '%Y%m%d')
        return d.replace(tzinfo=UTC)
    except ValueError:
        return None


def _as_dt(t, tz):
    if isinstance(t, datetime):
        return t
    return datetime(t.year, t.month, t.day, tzinfo=tz)


def _overlaps(s, e, start, end, tz):
    s, e = _as_dt(s, tz), _as_dt(e, tz)
    if e <= s:
        return start <= s < end
    return s < end and e > start


def _instance(ev, s, e, key):
    return {'event': ev, 'start': s, 'end': e, 'all_day': not isinstance(s, datetime),
            'key': key, 'id': _uid_hash(ev['uid']) + (f'_{key}' if key else '')}


# ── Parsing ────────────────────────────────────────────────────────────────

def parse(text, default_tz=UTC):
    """Feed text → Feed. Raises ValueError when it is not a calendar."""
    lines = _unfold(text)
    if not lines or not any(ln.upper().startswith('BEGIN:VCALENDAR') for ln in lines[:5]):
        raise ValueError('the link did not give a calendar (no BEGIN:VCALENDAR); check that it is the iCal address')
    feed = Feed()
    stack, cur, tzcur = [], None, None
    raw_events = []
    for line in lines:
        name, params, value = _split_line(line)
        if name == 'BEGIN':
            comp = value.strip().upper()
            stack.append(comp)
            if comp == 'VEVENT' and len(stack) == 2:
                cur = []
            elif comp == 'VTIMEZONE':
                tzcur = {'tzid': '', 'loc': ''}
            continue
        if name == 'END':
            comp = value.strip().upper()
            if stack and stack[-1] == comp:
                stack.pop()
            if comp == 'VEVENT' and cur is not None and len(stack) == 1:
                if len(raw_events) < MAX_EVENTS:
                    raw_events.append(cur)
                elif len(raw_events) == MAX_EVENTS:
                    feed.problem(f'more than {MAX_EVENTS} events; the rest were skipped')
                cur = None
            elif comp == 'VTIMEZONE' and tzcur is not None:
                z = zone(tzcur['loc']) or zone(tzcur['tzid'])
                if tzcur['tzid'] and z is not None:
                    feed._vtimezones[tzcur['tzid']] = z
                tzcur = None
            continue
        if cur is not None and stack[-1:] == ['VEVENT']:
            cur.append((name, params, value))
        elif tzcur is not None and stack[-1:] == ['VTIMEZONE']:
            if name == 'TZID':
                tzcur['tzid'] = value.strip()
            elif name == 'X-LIC-LOCATION':
                tzcur['loc'] = value.strip()
        elif len(stack) == 1:
            if name == 'PRODID':
                feed.prodid = value[:200]
            elif name == 'X-WR-CALNAME':
                feed.name = unescape(value)[:200]
            elif name == 'X-WR-TIMEZONE':
                feed.zone_name = value.strip()[:80]
    feed.tz = zone(feed.zone_name) or default_tz
    for props in raw_events:
        try:
            ev = _event(props, feed)
        except ValueError as e:
            feed.problem(f'an event was skipped ({e})')
            continue
        if ev is None:
            continue
        if ev['recurrence_id'] is not None:
            feed.overrides.setdefault(ev['uid'], {})[recurrence_key(ev['recurrence_id'])] = ev
        else:
            feed.events.append(ev)
    return feed


def _addr(value):
    v = value.strip()
    if v.lower().startswith('mailto:'):
        v = v[7:]
    return v.strip().lower() if '@' in v else ''


def _event(props, feed):
    ev = {'uid': '', 'summary': '', 'description': '', 'location': '', 'status': 'CONFIRMED',
          'organizer': {}, 'attendees': [], 'created': '', 'updated': '', 'url': '', 'attachments': 0,
          'conference': False, 'class': '', 'rrule': None, 'rdates': [], 'exdates': set(),
          'recurrence_id': None, 'start': None, 'end': None, 'duration': None}
    tz = feed.tz
    for name, params, value in props:
        if name == 'UID':
            ev['uid'] = value.strip()[:1000]
        elif name == 'SUMMARY':
            ev['summary'] = unescape(value)
        elif name == 'DESCRIPTION':
            ev['description'] = unescape(value)
        elif name == 'X-ALT-DESC' and 'html' in params.get('FMTTYPE', '').lower() and not ev['description']:
            ev['description'] = unescape(value)
        elif name == 'LOCATION':
            ev['location'] = unescape(value)
        elif name == 'STATUS':
            ev['status'] = value.strip().upper()
        elif name == 'CLASS':
            ev['class'] = value.strip().upper()
        elif name == 'ORGANIZER':
            ev['organizer'] = {'email': _addr(value), 'name': params.get('CN', '')}
        elif name == 'ATTENDEE' and len(ev['attendees']) < 200:
            ev['attendees'].append({'email': _addr(value), 'name': params.get('CN', ''),
                                    'response': params.get('PARTSTAT', 'NEEDS-ACTION').lower(),
                                    'optional': params.get('ROLE', '').upper() == 'OPT-PARTICIPANT'})
        elif name == 'CREATED':
            ev['created'] = value.strip()
        elif name in ('LAST-MODIFIED', 'DTSTAMP') and (name == 'LAST-MODIFIED' or not ev['updated']):
            ev['updated'] = value.strip()
        elif name == 'URL':
            ev['url'] = value.strip()
        elif name == 'ATTACH':
            ev['attachments'] += 1
        elif name in ('X-GOOGLE-CONFERENCE', 'X-MICROSOFT-SKYPETEAMSMEETINGURL', 'CONFERENCE'):
            ev['conference'] = True
        elif name == 'DTSTART':
            ev['start'] = feed.value_time(value, params, tz)
        elif name == 'DTEND':
            ev['end'] = feed.value_time(value, params, tz)
        elif name == 'DURATION':
            ev['duration'] = _duration(value)
        elif name == 'RECURRENCE-ID':
            ev['recurrence_id'] = feed.value_time(value, params, tz)
        elif name == 'RRULE':
            ev['rrule'] = _rrule(value, feed)
        elif name in ('RDATE', 'EXDATE'):
            for v in value.split(','):
                v = v.split('/')[0].strip()
                if not v:
                    continue
                try:
                    t = feed.value_time(v, params, tz)
                except ValueError:
                    continue
                if name == 'RDATE':
                    ev['rdates'].append(t)
                else:
                    ev['exdates'].add(recurrence_key(t))
    if ev['start'] is None:
        return None
    if not ev['uid']:
        ev['uid'] = 'no-uid-' + hashlib.sha256((ev['summary'] + recurrence_key(ev['start'])).encode()).hexdigest()[:16]
    s = ev['start']
    if ev['end'] is None or type(ev['end']) is not type(s):
        if ev['duration'] is not None:
            ev['end'] = s + ev['duration']
        else:
            ev['end'] = s + timedelta(days=1) if not isinstance(s, datetime) else s
    if ev['end'] < s:
        ev['end'] = s
    if isinstance(s, datetime):
        # Wall-clock length, so every instance keeps it across DST.
        ev['length'] = ev['end'].replace(tzinfo=None) - s.replace(tzinfo=None) \
            if ev['end'].tzinfo == s.tzinfo else ev['end'] - s
    else:
        ev['length'] = ev['end'] - s
    return ev


_DUR = re.compile(r'([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$')


def _duration(v):
    m = _DUR.match(v.strip())
    if not m:
        return None
    w, d, h, mi, s = (int(x or 0) for x in m.groups()[1:])
    td = timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)
    return -td if m.group(1) == '-' else td


def _ints(v, lo, hi):
    out = []
    for x in v.split(','):
        try:
            n = int(x)
        except ValueError:
            continue
        if lo <= abs(n) <= hi and n != 0 or (lo == 0 and n == 0):
            out.append(n)
    return out


def _rrule(value, feed):
    r = {}
    for part in value.split(';'):
        k, _, v = part.partition('=')
        r[k.strip().upper()] = v.strip()
    rule = {'freq': r.get('FREQ', '').upper(), 'interval': max(1, int(r.get('INTERVAL') or 1)
                                                               if (r.get('INTERVAL') or '1').isdigit() else 1)}
    if r.get('COUNT', '').isdigit():
        rule['count'] = int(r['COUNT'])
    if r.get('UNTIL'):
        try:
            rule['until'] = feed.value_time(r['UNTIL'], {}, feed.tz)
        except ValueError:
            pass
    byday = []
    for x in r.get('BYDAY', '').split(','):
        m = re.fullmatch(r'([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)', x.strip().upper())
        if m:
            byday.append((int(m.group(1)) if m.group(1) else 0, _WEEKDAYS[m.group(2)]))
    rule['byday'] = byday
    rule['bymonthday'] = _ints(r.get('BYMONTHDAY', ''), 1, 31)
    rule['bymonth'] = [x for x in _ints(r.get('BYMONTH', ''), 1, 12) if x > 0]
    rule['byyearday'] = _ints(r.get('BYYEARDAY', ''), 1, 366)
    rule['bysetpos'] = _ints(r.get('BYSETPOS', ''), 1, 366)
    rule['byhour'] = sorted(x for x in _ints(r.get('BYHOUR', ''), 0, 23) if x >= 0)
    rule['byminute'] = sorted(x for x in _ints(r.get('BYMINUTE', ''), 0, 59) if x >= 0)
    rule['wkst'] = _WEEKDAYS.get(r.get('WKST', 'MO').upper(), 0)
    supported = rule['freq'] in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') and not r.get('BYWEEKNO')
    if not supported:
        feed.problem(f'a recurrence rule this reader does not expand ({value[:60]}); only its first time is listed')
        rule['unsupported'] = True
    return rule


# ── Recurrence ─────────────────────────────────────────────────────────────

def _month_days(y, m):
    return _cal.monthrange(y, m)[1]


def _in_month(y, m, rule, d0):
    """Candidate days of one month for MONTHLY (or YEARLY with months)."""
    n = _month_days(y, m)
    days = None
    if rule['bymonthday']:
        days = {(x if x > 0 else n + 1 + x) for x in rule['bymonthday']}
        days = {x for x in days if 1 <= x <= n}
    if rule['byday']:
        wd = set()
        for pos, w in rule['byday']:
            hits = [x for x in range(1, n + 1) if date(y, m, x).weekday() == w]
            if pos == 0:
                wd.update(hits)
            elif -len(hits) <= pos <= len(hits) and pos != 0:
                wd.add(hits[pos - 1] if pos > 0 else hits[pos])
        days = wd if days is None else days & wd
    if days is None:
        days = {d0.day} if d0.day <= n else set()
    return [date(y, m, x) for x in sorted(days)]


def _in_year(y, rule, d0):
    if rule['bymonth']:
        out = []
        for m in sorted(rule['bymonth']):
            if not rule['bymonthday'] and not rule['byday']:
                if d0.day <= _month_days(y, m):
                    out.append(date(y, m, d0.day))
            else:
                out += _in_month(y, m, rule, d0)
        return out
    if rule['byyearday']:
        n = 366 if _cal.isleap(y) else 365
        out = []
        for x in rule['byyearday']:
            k = x if x > 0 else n + 1 + x
            if 1 <= k <= n:
                out.append(date(y, 1, 1) + timedelta(days=k - 1))
        return sorted(out)
    if rule['byday'] and not rule['bymonthday']:
        n = 366 if _cal.isleap(y) else 365
        out = set()
        for pos, w in rule['byday']:
            hits = [date(y, 1, 1) + timedelta(days=k) for k in range(n)
                    if (date(y, 1, 1) + timedelta(days=k)).weekday() == w]
            if pos == 0:
                out.update(hits)
            elif -len(hits) <= pos <= len(hits):
                out.add(hits[pos - 1] if pos > 0 else hits[pos])
        return sorted(out)
    if rule['bymonthday']:
        out = []
        for m in range(1, 13):
            out += _in_month(y, m, {**rule, 'byday': []}, d0)
        return out
    if d0.month == 2 and d0.day == 29 and not _cal.isleap(y):
        return []
    return [date(y, d0.month, d0.day)]


def _period(rule, d0, k):
    """(first day of period k, candidate days in it)."""
    f, iv = rule['freq'], rule['interval']
    if f == 'DAILY':
        d = d0 + timedelta(days=k * iv)
        cands = [d]
        if rule['byday']:
            cands = [x for x in cands if x.weekday() in {w for _, w in rule['byday']}]
        if rule['bymonthday']:
            n = _month_days(d.year, d.month)
            md = {(x if x > 0 else n + 1 + x) for x in rule['bymonthday']}
            cands = [x for x in cands if x.day in md]
        return d, cands
    if f == 'WEEKLY':
        ws0 = d0 - timedelta(days=(d0.weekday() - rule['wkst']) % 7)
        ws = ws0 + timedelta(days=7 * iv * k)
        wds = {w for _, w in rule['byday']} or {d0.weekday()}
        return ws, [ws + timedelta(days=i) for i in range(7) if (ws + timedelta(days=i)).weekday() in wds]
    if f == 'MONTHLY':
        mi = d0.month - 1 + k * iv
        y, m = d0.year + mi // 12, mi % 12 + 1
        return date(y, m, 1), _in_month(y, m, rule, d0)
    y = d0.year + k * iv
    return date(y, 1, 1), _in_year(y, rule, d0)


def _skip_periods(rule, d0, target):
    """A period index safely before the one holding target (no COUNT)."""
    days = (target - d0).days
    if days <= 0:
        return 0
    f, iv = rule['freq'], rule['interval']
    if f == 'DAILY':
        n = days // iv
    elif f == 'WEEKLY':
        n = days // (7 * iv)
    elif f == 'MONTHLY':
        n = ((target.year - d0.year) * 12 + target.month - d0.month) // iv
    else:
        n = (target.year - d0.year) // iv
    return max(0, n - 2)


def _localize(d, t, tz):
    if tz is None:
        return d
    return datetime.combine(d, t).replace(tzinfo=tz)


def _expand(ev, start, end, display_tz, feed, budget=None):
    """Instances of a recurring event overlapping [start, end). budget: a
    one-item list, the work left for this query (shared by all events)."""
    if budget is None:
        budget = [MAX_WORK]
    s0 = ev['start']
    timed = isinstance(s0, datetime)
    tz = s0.tzinfo if timed else None
    d0 = s0.date() if timed else s0
    t0 = s0.timetz().replace(tzinfo=None) if timed else time(0)
    rule = ev['rrule']
    length = ev['length']

    def make(t):
        if timed:
            if isinstance(length, timedelta) and ev['end'].tzinfo == s0.tzinfo:
                e = (t.replace(tzinfo=None) + length).replace(tzinfo=t.tzinfo)
            else:
                e = t + length
        else:
            e = t + length
        return _instance(ev, t, e, recurrence_key(t))

    out, seen = [], set()

    def add(t):
        key = recurrence_key(t)
        if key in seen:
            return
        seen.add(key)
        inst = make(t)
        if _overlaps(inst['start'], inst['end'], start, end, display_tz):
            out.append(inst)

    add(s0)
    for rd in ev['rdates']:
        if isinstance(rd, datetime) != timed:
            continue
        add(rd)
    if not rule or rule.get('unsupported'):
        return out[:MAX_INSTANCES]
    if budget[0] <= 0:
        return out

    times = [t0]
    if timed and (rule['byhour'] or rule['byminute']):
        times = [time(h, mi, t0.second) for h in (rule['byhour'] or [t0.hour])
                 for mi in (rule['byminute'] or [t0.minute])]
    until = rule.get('until')
    if until is not None:
        if timed and not isinstance(until, datetime):
            # A date UNTIL on a timed event: through the end of that day.
            until = _as_dt(until + timedelta(days=1), tz or display_tz) - timedelta(seconds=1)
        elif not timed and isinstance(until, datetime):
            until = until.astimezone(display_tz).date()
    count = rule.get('count')
    # Earliest point an instance could still reach the range.
    reach = start - (length if isinstance(length, timedelta) else timedelta(0)) - timedelta(days=2)
    k = 0 if count else _skip_periods(rule, d0, reach.astimezone(display_tz).date())
    emitted = 1  # DTSTART is the first instance
    end_day = end.astimezone(display_tz).date() + timedelta(days=2)
    for _ in range(MAX_PERIODS):
        first, days = _period(rule, d0, k)
        k += 1
        if first > end_day:
            break
        if rule['bymonth'] and rule['freq'] != 'YEARLY':
            days = [d for d in days if d.month in rule['bymonth']]
        budget[0] -= 1 + len(days) * len(times)
        if budget[0] < 0:
            feed.problem(WORK_PROBLEM)
            break
        cands = sorted(_localize(d, t, tz) if timed else d for d in days for t in times)
        if rule['bysetpos']:
            n = len(cands)
            cands = sorted({cands[p - 1] if p > 0 else cands[p] for p in rule['bysetpos'] if 0 < abs(p) <= n})
        stop = False
        for c in cands:
            if c <= s0:
                continue
            if until is not None and c > until:
                stop = True
                break
            if count and emitted >= count:
                stop = True
                break
            emitted += 1
            if (c if timed else _as_dt(c, display_tz)) >= end:
                stop = True
                break
            add(c)
            if len(out) >= MAX_INSTANCES:
                stop = True
                break
        if stop:
            break
    else:
        feed.problem('a recurring event repeats too often to expand fully; some times may be missing')
    return out
