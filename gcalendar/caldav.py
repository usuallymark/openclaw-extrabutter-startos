"""CalDAV accounts for the calendar service (since 2026.10.1:37).

A calendar account at iCloud, Fastmail, Nextcloud or any other CalDAV
server (RFC 4791), read like the calendar links and, in write mode, with
one calendar of the assistant's own on it (davwrites.py).

Finding the server (RFC 6764, without DNS SRV, which Python's standard
library cannot look up): the server address from Configure Calendar, or
from the account's address: iCloud, Fastmail and Yahoo by name, else
https://<domain>/.well-known/caldav, then https://caldav.<domain>/....
Then, with the password: the account's principal, its calendar home and
the calendars in it (name, whether it may be written, its change tag).

Rules, on top of the calendar links' network checks (links.py: the
address actually connected to is checked, never this machine or special
addresses, the owner's own network only when the server itself is there,
TIMEOUT_S for a whole exchange however slowly the server sends, no proxy):
- HTTPS only: the password would otherwise travel in clear.
- No redirect is followed with the password to another host than the
  server's; while finding the server, redirects are followed without it.
- Server answers are refused when they carry a DOCTYPE (no entity tricks),
  and are size-limited.
- The password stays in this process's memory; it never appears in an
  answer, the health line or the log. A password the server refused is not
  sent again (the launcher fetches it again every 10 minutes).

Run as "caldav.py lookup" (Look Up Calendar Server, as openclaw-calendar):
JSON {target, username, password} on stdin, JSON out; nothing is saved.
"""

import sys

sys.path.insert(0, '/opt/openclaw-calendar')

import base64  # noqa: E402
import hashlib  # noqa: E402
import http.client  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import socket  # noqa: E402
import ssl  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.parse  # noqa: E402
import xml.etree.ElementTree as ET  # noqa: E402

import ical  # noqa: E402
import links as L  # noqa: E402

DAV_PREFIX = 'dav:'
CACHE_S = 120
TIMEOUT_S = 30
MAX_XML = 2 * 1024 * 1024
MAX_CALENDAR = 16 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_CALENDARS = 50

NS = {'d': 'DAV:', 'c': 'urn:ietf:params:xml:ns:caldav', 'cs': 'http://calendarserver.org/ns/'}

# Providers whose CalDAV server is not found from their mail domain.
KNOWN = {
    'icloud.com': 'https://caldav.icloud.com/',
    'me.com': 'https://caldav.icloud.com/',
    'mac.com': 'https://caldav.icloud.com/',
    'fastmail.com': 'https://caldav.fastmail.com/',
    'fastmail.fm': 'https://caldav.fastmail.com/',
    'yahoo.com': 'https://caldav.calendar.yahoo.com/',
    'ymail.com': 'https://caldav.calendar.yahoo.com/',
}
GOOGLE = ('gmail.com', 'googlemail.com', 'google.com')
MICROSOFT = re.compile(r'^(outlook|hotmail|live|msn)\.[a-z.]+$')


class DavError(Exception):
    """A problem to show as is (never contains the password)."""


class DavRefused(DavError):
    """The server refused the user name or password."""


class DavUnreachable(DavError):
    """The server could not be reached or did not answer in time."""


class Conflict(DavError):
    """If-Match / If-None-Match failed: changed since it was read."""


# ── HTTP ───────────────────────────────────────────────────────────────────

def _origin(url):
    u = urllib.parse.urlsplit(url)
    return (u.scheme.lower(), (u.hostname or '').lower(), u.port or 443)


def https_url(url):
    """The URL if it is https:// with a host, else None."""
    u = (url or '').strip()
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return None
    if p.scheme.lower() != 'https' or not p.hostname or any(c.isspace() for c in u):
        return None
    if p.username or p.password:
        return None  # never a password inside the address
    return urllib.parse.urlunsplit(('https', p.netloc, p.path or '/', p.query, ''))


def _ctx():
    return ssl.create_default_context()


class Response:
    def __init__(self, status, headers, body, url):
        self.status, self.headers, self.body, self.url = status, headers, body, url


def _one(url, method, body, headers, limit, first):
    """One HTTPS exchange, no redirects. Returns (Response, first-hop kind)."""
    p = urllib.parse.urlsplit(url)
    path = (p.path or '/') + (f'?{p.query}' if p.query else '')
    watch = {'socks': [], 'killed': False}
    L._hop.first, L._hop.watch = first, watch
    timer = threading.Timer(TIMEOUT_S, L._kill, [watch])
    timer.daemon = True
    timer.start()
    conn = L._HTTPSConnection(p.hostname, p.port or 443, timeout=TIMEOUT_S, context=_ctx())
    try:
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        chunks, size = [], 0
        while True:
            part = r.read(65536)
            if not part:
                break
            size += len(part)
            if size > limit:
                raise DavError(f'the server answered more than {limit // (1024 * 1024)} MB; refused')
            chunks.append(part)
        if watch['killed']:
            raise TimeoutError('timed out')
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        return Response(r.status, hdrs, b''.join(chunks), url), L._hop.first
    except L.AddressRefused as e:
        raise DavError(str(e).replace('calendar link', 'calendar server')) from None
    except ssl.SSLError as e:
        raise DavUnreachable(f'the calendar server\'s certificate was not accepted ({e.reason or "TLS error"})') from None
    except (TimeoutError, socket.timeout):
        raise DavUnreachable(f'the calendar server did not answer within {TIMEOUT_S} s') from None
    except (OSError, http.client.HTTPException) as e:
        if watch['killed']:
            raise DavUnreachable(f'the calendar server did not answer within {TIMEOUT_S} s') from None
        raise DavUnreachable(f'the calendar server could not be reached ({e.__class__.__name__})') from None
    finally:
        timer.cancel()
        L._hop.watch = None
        conn.close()


def request(url, method='GET', body=None, headers=None, auth=None, auth_origin=None, limit=MAX_XML):
    """An exchange with redirects followed (https only, at most
    MAX_REDIRECTS). The password (auth) goes only to auth_origin; a redirect
    elsewhere is refused while it is set."""
    if isinstance(body, str):
        body = body.encode('utf-8')
    first = None
    for _ in range(MAX_REDIRECTS + 1):
        if not https_url(url):
            raise DavError('the calendar server must be an https:// address')
        h = {'User-Agent': 'OpenClaw-calendar/1', **(headers or {})}
        if auth:
            if _origin(url) != auth_origin:
                raise DavError('the calendar server pointed to another host; refused (the password is only '
                               'sent to the server itself)')
            h['Authorization'] = auth
        r, first = _one(url, method, body, h, limit, first)
        if r.status in (301, 302, 303, 307, 308) and r.headers.get('location'):
            url = urllib.parse.urljoin(url, r.headers['location'])
            if r.status == 303:
                method, body = 'GET', None
            continue
        return r
    raise DavError('the calendar server redirected too many times')


# ── XML ────────────────────────────────────────────────────────────────────

def _xml(body):
    low = body.lower()
    if b'<!doctype' in low or b'<!entity' in low:
        raise DavError('the calendar server\'s answer declared a DOCTYPE; refused')
    try:
        return ET.fromstring(body)
    except ET.ParseError:
        raise DavError('the calendar server gave an answer that could not be read') from None


def _q(tag):
    p, _, n = tag.partition(':')
    return f'{{{NS[p]}}}{n}'


def propfind(props):
    inner = ''.join(f'<{p}/>' for p in props)
    return (f'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" '
            f'xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">'
            f'<d:prop>{inner}</d:prop></d:propfind>')


def multistatus(r):
    """[(absolute url, {tag: element})] for the 200 propstats."""
    if r.status != 207:
        raise DavError(f'the calendar server answered HTTP {r.status}')
    root = _xml(r.body)
    out = []
    for resp in root.findall('d:response', NS):
        href = (resp.findtext('d:href', '', NS) or '').strip()
        if not href:
            continue
        props = {}
        for ps in resp.findall('d:propstat', NS):
            st = ps.findtext('d:status', '', NS) or ''
            if ' 200 ' not in f'{st} ':
                continue
            prop = ps.find('d:prop', NS)
            for el in list(prop) if prop is not None else []:
                props[el.tag] = el
        out.append((urllib.parse.urljoin(r.url, href), props))
    return out


def _href(el):
    if el is None:
        return ''
    h = el.find('d:href', NS)
    return (h.text or '').strip() if h is not None and h.text else ''


# ── finding the server ─────────────────────────────────────────────────────

def candidates(target):
    """(urls to try, label) for a server address or an email address."""
    t = (target or '').strip()
    if '://' in t:
        u = https_url(t)
        if not u:
            raise DavError('the calendar server must be an https:// address (the password would otherwise travel in clear)')
        return [u], 'the server address given'
    if '@' not in t:
        raise DavError('give the calendar server\'s address (https://…) or the account\'s email address')
    domain = t.rsplit('@', 1)[1].lower().strip('.')
    if domain in GOOGLE:
        raise DavError('Google calendars use the Google sign-in (Configure Calendar → Google), not CalDAV')
    if MICROSOFT.match(domain):
        raise DavError('Outlook.com and Microsoft 365 do not offer CalDAV; use a calendar link from Outlook instead')
    if domain in KNOWN:
        return [KNOWN[domain]], f'the known server for {domain}'
    return ([f'https://{domain}/.well-known/caldav', f'https://caldav.{domain}/.well-known/caldav'],
            f'{domain}/.well-known/caldav')


def find_server(target):
    """(base url, how it was found), without the password."""
    urls, label = candidates(target)
    if len(urls) == 1 and not urls[0].endswith('/.well-known/caldav'):
        return urls[0], label
    tried = []
    for u in urls:
        tried.append(urllib.parse.urlsplit(u).hostname)
        try:
            r = request(u, 'PROPFIND', propfind(['d:current-user-principal']),
                        {'Depth': '0', 'Content-Type': 'application/xml; charset=utf-8'})
        except (DavUnreachable, DavError):
            continue
        if r.status in (207, 401, 403):
            return r.url, f'{urllib.parse.urlsplit(r.url).hostname} (from {label})'
    raise DavError(f'no CalDAV server was found (tried {", ".join(tried)}); give the server address from your '
                   'provider\'s help pages')


# ── the account ────────────────────────────────────────────────────────────

def _slug(name):
    s = re.sub(r'[^a-z0-9]+', '-', (name or '').lower()).strip('-')
    return s[:40] or 'calendar'


class Account:
    def __init__(self, server, address, username, password, log=None):
        self.target = server or address
        self.address = (address or '').strip().lower()
        self.username = (username or '').strip() or self.address
        self._auth = ('Basic ' + base64.b64encode(f'{self.username}:{password or ""}'.encode()).decode()) \
            if password else None
        self.fp_seed = f'{self.username}\0{password or ""}'
        self.log = log or (lambda e: None)
        self.base = ''
        self.found = ''
        self.origin = None
        self.home = ''
        self.addresses = []
        self.scheduling = False
        self.calendars = []
        self.connected = False
        self.refused = False
        self.error = ''
        self._lock = threading.RLock()

    # requests with the password, to the server's own host only

    def call(self, url, method, body=None, headers=None, limit=MAX_XML):
        if not self._auth:
            raise DavRefused('no password is available for the calendar account')
        if self.refused:
            # Never send a refused password again (some providers lock the
            # account after repeated failures).
            raise DavRefused(self.error or 'the calendar server refused the user name or password')
        r = request(url, method, body, headers, self._auth, self.origin, limit)
        if r.status == 401:
            self.refused, self.connected = True, False
            self.error = 'the calendar server refused the user name or password'
            self.log({'event': 'caldav_refused'})
            raise DavRefused(self.error)
        return r

    def _propfind(self, url, props, depth='0'):
        r = self.call(url, 'PROPFIND', propfind(props), {'Depth': depth, 'Content-Type': 'application/xml; charset=utf-8'})
        if r.status == 403:
            raise DavError('the calendar server refused access (HTTP 403)')
        return multistatus(r)

    def connect(self):
        """Find the server, the principal, the calendar home and the
        calendars. Raises DavError (DavRefused, DavUnreachable)."""
        with self._lock:
            if not self.base:
                self.base, self.found = find_server(self.target)
                self.origin = _origin(self.base)
            rows = self._propfind(self.base, ['d:current-user-principal'])
            principal = next((_href(p.get(_q('d:current-user-principal'))) for _, p in rows
                              if p.get(_q('d:current-user-principal')) is not None), '') or ''
            principal = urllib.parse.urljoin(self.base, principal) if principal else self.base
            rows = self._propfind(principal, ['c:calendar-home-set', 'c:calendar-user-address-set'])
            home, addrs = '', []
            for _, p in rows:
                home = home or _href(p.get(_q('c:calendar-home-set')))
                us = p.get(_q('c:calendar-user-address-set'))
                for h in (us.findall('d:href', NS) if us is not None else []):
                    v = (h.text or '').strip()
                    if v.lower().startswith('mailto:'):
                        addrs.append(v[7:].lower())
            self.home = urllib.parse.urljoin(principal, home) if home else principal
            if _origin(self.home) != self.origin:
                # iCloud keeps calendars on a per-account host (pNN-caldav.icloud.com):
                # the same provider, found with the password over HTTPS.
                if not _same_provider(self.home, self.base):
                    raise DavError('the calendar home is on another host; refused')
                self.origin = _origin(self.home)
            self.addresses = addrs
            if not self.address and addrs:
                self.address = addrs[0]
            try:
                r = self.call(self.home, 'OPTIONS')
                self.scheduling = 'calendar-auto-schedule' in (r.headers.get('dav') or '').lower()
            except DavError:
                self.scheduling = False
            self.calendars = self._list_calendars(self.calendars)
            self.connected, self.error = True, ''
            self.log({'event': 'caldav_connected', 'calendars': len(self.calendars),
                      'server': urllib.parse.urlsplit(self.base).hostname})
            return self.calendars

    def _list_calendars(self, old):
        rows = self._propfind(self.home, ['d:resourcetype', 'd:displayname', 'c:supported-calendar-component-set',
                                          'd:current-user-privilege-set', 'cs:getctag', 'd:sync-token'], depth='1')
        by_href = {c.href: c for c in old or []}
        out, used = [], set()
        for url, p in rows:
            rt = p.get(_q('d:resourcetype'))
            if rt is None or rt.find('c:calendar', NS) is None:
                continue
            comps = p.get(_q('c:supported-calendar-component-set'))
            if comps is not None and not any((c.get('name') or '').upper() == 'VEVENT'
                                             for c in comps.findall('c:comp', NS)):
                continue
            if _origin(url) != self.origin:
                continue
            name = ' '.join((p.get(_q('d:displayname')).text or '').split()) if p.get(_q('d:displayname')) is not None else ''
            name = (name or urllib.parse.unquote(url.rstrip('/').rsplit('/', 1)[-1]))[:80] or 'Calendar'
            privs = p.get(_q('d:current-user-privilege-set'))
            names = {el.tag for el in privs.iter()} if privs is not None else set()
            writable = (privs is None or bool(names & {_q('d:write'), _q('d:write-content'), _q('d:all')}))
            cal = by_href.get(url) or Calendar(self, url)
            cal.name, cal.writable = name, writable
            base = DAV_PREFIX + _slug(name)
            cid, n = base, 2
            while cid in used:
                cid, n = f'{base}-{n}', n + 1
            used.add(cid)
            cal.id = cid
            out.append(cal)
            if len(out) >= MAX_CALENDARS:
                break
        return out

    def by_id(self, cal_id):
        return next((c for c in self.calendars if c.id == cal_id), None)

    def by_href(self, href):
        return next((c for c in self.calendars if c.href == href), None)

    def mkcalendar(self, name):
        """A new calendar for the assistant; its URL, or None when the server
        does not let apps make calendars."""
        url = urllib.parse.urljoin(self.home if self.home.endswith('/') else self.home + '/',
                                   f'openclaw-{hashlib.sha256(name.encode()).hexdigest()[:8]}-{int(time.time())}/')
        body = ('<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" '
                'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>'
                f'<d:displayname>{_xml_text(name)}</d:displayname>'
                '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'
                '</d:prop></d:set></c:mkcalendar>')
        r = self.call(url, 'MKCALENDAR', body, {'Content-Type': 'application/xml; charset=utf-8'})
        if r.status in (200, 201):
            return url
        if r.status in (403, 405, 409, 501):
            return None
        raise DavError(f'the calendar could not be made (HTTP {r.status})')

    def refresh_list(self):
        with self._lock:
            self.calendars = self._list_calendars(self.calendars)
            return self.calendars

    def health(self):
        return {'server': urllib.parse.urlsplit(self.base).hostname if self.base else '',
                'found': self.found, 'connected': self.connected, 'error': self.error,
                'address': self.address, 'scheduling': self.scheduling,
                'calendars': [c.health() for c in self.calendars]}


def _same_provider(a, b):
    """iCloud (and the other known providers) keep an account's calendars on
    a host of their own: allowed only within that provider's domain."""
    ha, hb = (urllib.parse.urlsplit(a).hostname or '').lower(), (urllib.parse.urlsplit(b).hostname or '').lower()
    if urllib.parse.urlsplit(a).scheme != 'https':
        return False
    for dom in ('icloud.com', 'fastmail.com', 'yahoo.com'):
        if (hb == dom or hb.endswith('.' + dom)) and (ha == dom or ha.endswith('.' + dom)):
            return True
    return False


def _xml_text(s):
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


_QUERY = ('<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" '
          'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>'
          '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>'
          '</c:calendar-query>')


def _inner(text):
    """The components of one resource's VCALENDAR, without its wrapper."""
    lines = re.split(r'\r\n|\n|\r', text)
    try:
        a = next(i for i, ln in enumerate(lines) if ln.strip().upper() == 'BEGIN:VCALENDAR')
        b = max(i for i, ln in enumerate(lines) if ln.strip().upper() == 'END:VCALENDAR')
    except (StopIteration, ValueError):
        return []
    out, depth = [], 0
    for ln in lines[a + 1:b]:
        if ln[:1] in (' ', '\t'):       # a folded line belongs to the one before
            if depth > 0:
                out.append(ln)
            continue
        u = ln.strip().upper()
        if u.startswith('BEGIN:'):
            depth += 1
        if depth > 0:
            out.append(ln)              # components only, not the wrapper's own lines
        if u.startswith('END:'):
            depth = max(0, depth - 1)
    return out


def _uid_of(text):
    for line in ical._unfold(text):
        name, _, value = ical._split_line(line)
        if name == 'UID':
            return value.strip()[:1000]
    return ''


class Calendar:
    """One calendar of the account, read like a calendar link (the same
    interface for the calendar service: name, id, feed, error, get)."""

    kind = 'caldav'

    def __init__(self, account, href):
        self.account = account
        self.href = href
        self.name = ''
        self.id = ''
        self.writable = False
        self.feed = None
        self.error = ''
        self.fetched = 0.0
        self.fetched_ok = ''
        self.resources = {}   # uid hash → (uid, href, etag)
        self._token = None
        self._tz = None
        self._text = None
        self._lock = threading.Lock()

    def get(self, default_tz, force=False):
        with self._lock:
            if self.feed is not None and not force and time.time() - self.fetched < CACHE_S:
                if self._tz != default_tz:
                    self._parse(self._text, default_tz)
                return self.feed
            self.fetched = time.time()
            try:
                if not self.account.connected:
                    self.account.connect()
                token = self._change_token()
                if self.feed is not None and token and token == self._token and not force:
                    if self._tz != default_tz:
                        self._parse(self._text, default_tz)
                else:
                    self._download(default_tz)
                    self._token = token
                self.error = ''
                self.fetched_ok = time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())
            except DavRefused as e:
                self.account.connected = False
                self.error = self.account.error = str(e)
            except (DavError, ValueError) as e:
                self.error = str(e)[:300]
            return self.feed

    def _change_token(self):
        try:
            rows = self.account._propfind(self.href, ['cs:getctag', 'd:sync-token'])
        except DavRefused:
            raise
        except DavError:
            return None
        for _, p in rows:
            for tag in (_q('cs:getctag'), _q('d:sync-token')):
                el = p.get(tag)
                if el is not None and (el.text or '').strip():
                    return (el.text or '').strip()
        return None

    def _download(self, default_tz):
        r = self.account.call(self.href, 'REPORT', _QUERY, {'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8'},
                              limit=MAX_CALENDAR)
        rows = multistatus(r)
        parts, resources = [], {}
        for url, p in rows:
            data = p.get(_q('c:calendar-data'))
            if data is None or not (data.text or '').strip():
                continue
            text = data.text
            uid = _uid_of(text)
            if uid:
                etag = (p.get(_q('d:getetag')).text or '').strip() if p.get(_q('d:getetag')) is not None else ''
                resources[ical._uid_hash(uid)] = (uid, url, etag)
            parts += _inner(text)
        joined = '\r\n'.join(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenClaw//caldav//EN', *parts,
                              'END:VCALENDAR', ''])
        self._parse(joined, default_tz)
        self.resources = resources

    def _parse(self, text, default_tz):
        self.feed, self._text, self._tz = ical.parse(text, default_tz), text, default_tz

    def invalidate(self):
        self.fetched = 0.0
        self._token = None

    def health(self):
        f = self.feed
        return {'name': self.name, 'id': self.id, 'writable': self.writable,
                'ok': f is not None and not self.error, 'error': self.error, 'last_good': self.fetched_ok,
                'events': len(f.events) if f else 0}


# ── Look Up Calendar Server ────────────────────────────────────────────────

def lookup(target, username, password):
    out = {'target': target}
    try:
        base, found = find_server(target)
        out.update(server=urllib.parse.urlsplit(base).hostname, url=base, found=found)
        if not password:
            out['note'] = 'no password given: the calendars are not listed'
            return out
        acct = Account(base, target if '@' in target else '', username, password)
        acct.base, acct.found, acct.origin = base, found, _origin(base)
        cals = acct.connect()
        out.update(address=acct.address, scheduling=acct.scheduling,
                   calendars=[{'name': c.name, 'writable': c.writable} for c in cals])
    except DavError as e:
        out['error'] = str(e)
    return out


def main():
    if sys.argv[1:] != ['lookup']:
        print('usage: caldav.py lookup  (JSON {target, username, password} on stdin)', file=sys.stderr)
        return 2
    try:
        req = json.loads(sys.stdin.read(64 * 1024) or '{}')
    except ValueError:
        req = {}
    out = lookup(str(req.get('target') or ''), str(req.get('username') or ''), str(req.get('password') or ''))
    print(json.dumps(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
