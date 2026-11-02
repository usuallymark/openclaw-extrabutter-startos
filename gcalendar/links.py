"""Calendar links: fetching the owner's iCal addresses for the calendar service.

Each link is a name and a secret address (from Configure Calendar or
Vaultwarden, handed over by the launcher). The address is a password in
all but name: it stays in this process's memory, and it never appears in
a tool answer, the health line or the activity log. Only the name does.

Feeds are fetched when a tool needs them, at most every CACHE_S seconds
per link (with If-None-Match / If-Modified-Since). When a fetch fails, the
last good copy keeps answering and the error is reported with it.
"""

import re
import threading
import time
import urllib.error
import urllib.request

import ical

CACHE_S = 300
TIMEOUT_S = 30
MAX_FEED = 16 * 1024 * 1024
MAX_REDIRECTS = 5
LINK_PREFIX = 'link:'


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to http(s), and only a few."""
    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith(('https://', 'http://')):
            raise urllib.error.URLError('the link redirected to something that is not a web address')
        if req.full_url.lower().startswith('https://') and newurl.lower().startswith('http://'):
            raise urllib.error.URLError('the link redirected from https to plain http')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_Redirects)


def normalize_url(url):
    """webcal:// → https://; anything but http(s) → None."""
    u = (url or '').strip()
    if u.lower().startswith('webcals://'):
        u = 'https://' + u[10:]
    elif u.lower().startswith('webcal://'):
        u = 'https://' + u[9:]
    if not re.match(r'(?i)https?://[^/\s]+', u) or any(c.isspace() for c in u):
        return None
    return u


def slug(name):
    s = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return s[:40] or 'calendar'


class Link:
    def __init__(self, name, url, error=''):
        self.name = name
        self.url = normalize_url(url) if url else None
        self.error = error or ('' if self.url else 'no usable address (it must start with https://, http:// or webcal://)')
        self.id = ''
        self.feed = None
        self._text = None       # the last good download, to read again
        self._tz = None         # the zone its floating times were read in
        self.fetched = 0.0      # last attempt
        self.fetched_ok = ''    # time text of the last good fetch
        self._etag = ''
        self._modified = ''
        self._lock = threading.Lock()

    def get(self, default_tz, force=False):
        """The parsed feed (maybe an older copy), or None; self.error says why.
        default_tz is the zone for times the feed gives without one (the
        owner's zone); the feed is read again when it changes."""
        if not self.url:
            return None
        with self._lock:
            if self.feed is not None and not force and time.time() - self.fetched < CACHE_S:
                if self._tz != default_tz:
                    self._parse(self._text, default_tz)
                return self.feed
            self.fetched = time.time()
            try:
                text = self._download()
                if text is None:  # not modified
                    text = self._text
                if text is not None and (text is not self._text or self._tz != default_tz):
                    self._parse(text, default_tz)
                self.error = ''
                self.fetched_ok = time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())
            except (urllib.error.URLError, OSError, ValueError, UnicodeError) as e:
                self.error = _why(e)
            return self.feed

    def _parse(self, text, default_tz):
        self.feed, self._text, self._tz = ical.parse(text, default_tz), text, default_tz

    def _download(self):
        headers = {'Accept': 'text/calendar, */*;q=0.5', 'User-Agent': 'OpenClaw-calendar-links/1'}
        if self.feed is not None and self._etag:
            headers['If-None-Match'] = self._etag
        if self.feed is not None and self._modified:
            headers['If-Modified-Since'] = self._modified
        req = urllib.request.Request(self.url, headers=headers)
        try:
            with _OPENER.open(req, timeout=TIMEOUT_S) as r:
                data = r.read(MAX_FEED + 1)
                if len(data) > MAX_FEED:
                    raise ValueError(f'the calendar is larger than {MAX_FEED // (1024 * 1024)} MB')
                self._etag = r.headers.get('ETag') or ''
                self._modified = r.headers.get('Last-Modified') or ''
                charset = r.headers.get_content_charset() or 'utf-8'
        except urllib.error.HTTPError as e:
            if e.code == 304 and self.feed is not None:
                return None
            raise
        try:
            return data.decode(charset, 'replace')
        except LookupError:
            return data.decode('utf-8', 'replace')


def _why(e):
    """A reason that never contains the address."""
    if isinstance(e, urllib.error.HTTPError):
        if e.code in (401, 403, 404, 410):
            return (f'the calendar link was refused (HTTP {e.code}); it may have been reset or made private, '
                    'so copy the current secret address again')
        return f'the calendar link answered HTTP {e.code}'
    if isinstance(e, urllib.error.URLError):
        r = e.reason
        if isinstance(r, str) and 'redirect' in r:
            return r
        return f'the calendar link could not be reached ({r.__class__.__name__ if not isinstance(r, str) else "network error"})'
    if isinstance(e, TimeoutError) or 'timed out' in str(e):
        return f'the calendar link did not answer within {TIMEOUT_S} s'
    if isinstance(e, ValueError):
        return str(e)[:200]
    return f'the calendar link could not be read ({e.__class__.__name__})'


class Links:
    def __init__(self, items):
        self.items = []
        used = set()
        for it in items or []:
            name = str(it.get('name') or '').strip()[:80] or 'Calendar'
            link = Link(name, it.get('url') or '', str(it.get('error') or ''))
            base = LINK_PREFIX + slug(name)
            lid, n = base, 2
            while lid in used:
                lid, n = f'{base}-{n}', n + 1
            used.add(lid)
            link.id = lid
            self.items.append(link)

    def __bool__(self):
        return bool(self.items)

    def by_id(self, cal_id):
        return next((x for x in self.items if x.id == cal_id), None)

    def warm(self, default_tz):
        for x in self.items:
            x.get(default_tz)

    def health(self):
        out = []
        for x in self.items:
            f = x.feed
            out.append({
                'name': x.name, 'id': x.id, 'ok': f is not None and not x.error,
                'error': x.error, 'last_good': x.fetched_ok,
                'events': len(f.events) if f else 0, 'problems': list(f.problems) if f else [],
            })
        return out
