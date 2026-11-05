#!/usr/bin/env python3
"""OpenClaw Extra Butter contacts service (since 2026.10.1:31), read only.

Runs as its own Linux user (openclaw-contacts) and is the only thing that
reads the owner's contacts: a vCard file the owner imported (Configure
Contacts copies it into this service's folder, out of the agents' reach),
or the assistant's Google account through the People API. Started by
launch.py, which hands it the settings and any Google sign-in on stdin.
Agents reach it as the MCP server "contacts" (tools contacts__*) through
front.py; only the contacts agent has those tools.

- Read only: no tool adds, changes, merges or deletes a contact.
- Contact fields can hold anything (an imported note, a name typed by
  someone else): they are cleaned, and the note is wrapped as untrusted
  content with heuristic flags.
- The activity log has counts only: never a name, address or number.
- Since :33 the mail and calendar services ask whether an address is in
  the contacts (knowncontact.py, a socket only their users may use): the
  answer is yes or no for each address, nothing else.
"""

import sys

sys.path.insert(0, '/opt/openclaw-contacts')

import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from datetime import date, datetime, timedelta  # noqa: E402

import knowncontact  # noqa: E402
import mcp  # noqa: E402
import svcutil  # noqa: E402
import vcard  # noqa: E402
from mcp import MAX_RESULTS  # noqa: E402
from people import ApiError, People, SignInRefused, Unreachable, to_contact  # noqa: E402
from sanitize import clean_line, content_flags, wrap_untrusted  # noqa: E402

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

ToolError = mcp.ToolError
CALLS_PER_MINUTE = 120
LOG_MAX_BYTES = 2 * 1024 * 1024
GOOGLE_CACHE_S = 900
# A contacts check that finds the Google copy stale waits this long for the
# refresh (the client gives up after knowncontact.TIMEOUT_S).
KNOWN_WAIT_S = 3
RETRY_S = 60
MAX_FILE = 64 * 1024 * 1024
WAIT_REFUSED_S = 600
_now = svcutil.now_text


def _digits(s):
    d = re.sub(r'\D', '', str(s or ''))
    return d[-10:] if len(d) >= 10 else d


def _clean(s):
    return clean_line(s, 300)


class Service:
    def __init__(self, cfg, token, reason):
        self.cfg = cfg
        self.source = cfg.get('source')
        self.state = 'starting'
        self.reason = ''
        self.since = _now()
        self.contacts = []
        self.emails = frozenset()
        self.known_check = 'starting'
        self._refresh = None
        self.loaded = ''
        self.problems = []
        self._mtime = None
        self._loaded_at = 0
        self._lock = threading.Lock()
        self._calls = []
        self._log = svcutil.ActivityLog(os.path.join(cfg['stateDir'], 'activity.jsonl'), LOG_MAX_BYTES)
        self.google = People(token, cfg.get('endpoints')) if token else None
        self.account = (token or {}).get('account') or cfg.get('account') or ''
        if self.source == 'google' and not token:
            self.set_state('unavailable', reason or 'no Contacts sign-in was available')

    def log(self, entry):
        self._log(entry)

    def set_state(self, state, reason=''):
        if state != self.state or reason != self.reason:
            self.since = _now()
            self.state, self.reason = state, reason
            self.log({'event': 'state', 'state': state, 'reason': reason})

    def rate_ok(self):
        now = time.time()
        with self._lock:
            self._calls = [t for t in self._calls if now - t < 60]
            if len(self._calls) >= CALLS_PER_MINUTE:
                return False
            self._calls.append(now)
            return True

    # ── loading ─────────────────────────────────────────────────────────────

    def load(self, force=False):
        """Read the source again when it changed (vCard) or is old (Google)."""
        with self._lock:
            if self.source == 'vcard':
                self._load_vcard(force)
            elif self.source == 'google':
                self._load_google(force)

    def _load_vcard(self, force):
        path = self.cfg.get('vcardPath') or ''
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            self._set_contacts([])
            self.set_state('unavailable', 'no contacts file yet; import one in Configure Contacts')
            return
        try:
            st = os.fstat(fd)
            if self._mtime == (st.st_mtime_ns, st.st_size) and not force:
                return
            if st.st_size > MAX_FILE:
                self.set_state('unavailable', f'the contacts file is larger than {MAX_FILE // (1024 * 1024)} MB')
                return
            with os.fdopen(os.dup(fd), 'rb') as f:
                raw = f.read(MAX_FILE + 1)
        finally:
            os.close(fd)
        text = raw.decode('utf-8', 'replace') if not raw.startswith(b'\xff\xfe') else raw.decode('utf-16', 'replace')
        try:
            contacts, problems = vcard.parse(text)
        except ValueError as e:
            self.set_state('unavailable', str(e))
            return
        self._set_contacts(contacts)
        self.problems = problems
        self._mtime = (st.st_mtime_ns, st.st_size)
        self.loaded = _now()
        self.set_state('ok')
        self.log({'event': 'loaded', 'source': 'vcard', 'count': len(contacts)})

    def _load_google(self, force):
        if self.google is None:
            return
        if not force and self.contacts and time.time() - self._loaded_at < GOOGLE_CACHE_S:
            return
        try:
            people = self.google.connections()
        except SignInRefused as e:
            self.set_state('refused', f'{e}; save a new sign-in in Vaultwarden item "google-contacts"'
                                      if self.cfg.get('tokenSource') == 'vault' else f'{e}; paste a new sign-in in Configure Contacts')
            svcutil.schedule_exit(0, WAIT_REFUSED_S)
            return
        except Unreachable as e:
            self.set_state('unreachable', str(e))
            return
        except ApiError as e:
            self.set_state('error', str(e))
            return
        self._set_contacts([to_contact(p, _clean) for p in people])
        self.problems = []
        self._loaded_at = time.time()
        self.loaded = _now()
        self.set_state('ok')
        self.log({'event': 'loaded', 'source': 'google', 'count': len(self.contacts)})

    def _set_contacts(self, contacts):
        self.contacts = contacts
        self.emails = frozenset(e['address'] for c in contacts for e in c['emails'] if e.get('address'))

    # ── "is this address known?" for the mail and calendar services ───────

    def known(self, addresses):
        """Yes/no for each (normalized) address. The Google copy is kept
        fresh by refresh_loop; one found stale anyway is refreshed, and the
        answer waits up to KNOWN_WAIT_S for it (since :34: until then a check
        answered from the old copy, so a contact added since was not known
        while the contacts agent, a moment later, found it)."""
        if self.source == 'vcard':
            self.load()
        else:
            t = self._refresh_soon()
            if t is not None:
                t.join(KNOWN_WAIT_S)
        if self.state != 'ok' and not self.contacts:
            raise knowncontact.Unavailable(f'contacts service {self.state}: {self.reason}'.rstrip(': '))
        emails = self.emails
        return [bool(a) and a in emails for a in addresses]

    def _refresh_soon(self):
        """The thread refreshing a stale Google copy (a running one, or one
        started now), or None when the copy is fresh."""
        with self._lock:
            if self._refresh is not None and self._refresh.is_alive():
                return self._refresh
            if self.google is None or time.time() - self._loaded_at < GOOGLE_CACHE_S:
                return None
            self._refresh = threading.Thread(target=self.load, daemon=True)
            self._refresh.start()
            return self._refresh

    def refresh_loop(self):
        """Google source: read the contacts again every GOOGLE_CACHE_S
        whether or not anyone asks (since :34), so a check is never answered
        from a copy older than that; after a failed read, again in RETRY_S.
        Stops once Google refused the sign-in (the service then exits and
        the launcher fetches it again; a refused one is not sent twice)."""
        while self.state != 'refused':
            age = time.time() - self._loaded_at
            if age < GOOGLE_CACHE_S:
                time.sleep(GOOGLE_CACHE_S - age)
                continue
            t = self._refresh_soon()
            if t is not None:
                t.join()
            if time.time() - self._loaded_at >= GOOGLE_CACHE_S and self.state != 'refused':
                time.sleep(RETRY_S)

    def health(self):
        return {'state': self.state, 'since': self.since, 'reason': self.reason, 'source': self.source,
                'account': self.account, 'count': len(self.contacts), 'loaded': self.loaded,
                'known_check': self.known_check,
                'problems': self.problems[:5], 'scopes': self.google.scopes if self.google else [],
                'version': mcp.VERSION}


# ── tools ──────────────────────────────────────────────────────────────────

def _brief(c):
    return {'id': c['id'], 'name': c['name'], 'emails': [e['address'] for e in c['emails']][:5],
            'phones': [p['number'] for p in c['phones']][:5], 'organization': c['organization'] or None}


def _full(c):
    out = {k: v for k, v in c.items() if k != 'note'}
    flags = content_flags(c['name'] + ' ' + ' '.join(c['other_names']))
    if c['note']:
        wrapped, _ = wrap_untrusted(c['note'], 'CONTACT NOTE', 4000)
        out['note'] = 'between the UNTRUSTED markers below'
        out['_untrusted'] = wrapped
        flags += [f for f in content_flags(c['note']) if f not in flags]
    out['flags'] = flags
    return out


class Tools:
    def __init__(self, svc):
        self.svc = svc

    def call(self, name, args):
        fn = getattr(self, f't_{name}', None) if isinstance(name, str) and name.isidentifier() else None
        if fn is None:
            raise ToolError(f'unknown tool {name}')
        if not self.svc.rate_ok():
            raise ToolError(f'too many contacts requests (more than {CALLS_PER_MINUTE} a minute); wait a minute')
        if name != 'status':
            self.svc.load()
            if self.svc.state not in ('ok',) and not self.svc.contacts:
                raise ToolError(f'contacts service {self.svc.state}: {self.svc.reason}'.rstrip(': '))
        return fn(args or {})

    def t_status(self, a):
        self.svc.load()
        h = self.svc.health()
        return {k: h[k] for k in ('state', 'reason', 'source', 'account', 'count', 'loaded', 'problems', 'known_check')}

    def t_search(self, a):
        text = clean_line(a.get('text') or '', 200).lower()
        if not text:
            raise ToolError('text: give the words to find')
        limit = a.get('limit', 20)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ToolError('limit: a whole number from 1')
        limit = min(limit, MAX_RESULTS)
        words = text.split()
        digits = _digits(text) if len(re.sub(r'\D', '', text)) >= 4 else ''
        hits = []
        for c in self.svc.contacts:
            hay = ' '.join([c['name'], *c['other_names'], *(e['address'] for e in c['emails']),
                            c['organization'], c['title'], *c['groups']]).lower()
            if all(w in hay for w in words) or (digits and any(digits in re.sub(r'\D', '', p['number'])
                                                               for p in c['phones'])):
                hits.append(c)
        self.svc.log({'event': 'search', 'count': len(hits)})
        return {'contacts': [_brief(c) for c in hits[:limit]], 'total': len(hits), 'more': len(hits) > limit}

    def t_lookup(self, a):
        email = clean_line(a.get('email') or '', 200).lower().removeprefix('mailto:')
        phone = _digits(a.get('phone'))
        if not email and len(phone) < 7:
            raise ToolError('give an email address or a phone number (at least 7 digits)')
        hits = [c for c in self.svc.contacts
                if (email and any(e['address'] == email for e in c['emails']))
                or (len(phone) >= 7 and any(_digits(p['number']) == phone for p in c['phones']))]
        self.svc.log({'event': 'lookup', 'count': len(hits)})
        return {'contacts': [_full(c) for c in hits[:10]], 'total': len(hits)}

    def t_read(self, a):
        cid = str(a.get('id') or '').strip()
        c = next((x for x in self.svc.contacts if x['id'] == cid), None)
        if c is None:
            raise ToolError('no contact with that id (search or lookup give the ids)')
        self.svc.log({'event': 'read', 'count': 1})
        return _full(c)

    def t_birthdays(self, a):
        tz = None
        if ZoneInfo and self.svc.cfg.get('timeZone'):
            try:
                tz = ZoneInfo(self.svc.cfg['timeZone'])
            except Exception:
                tz = None
        today = datetime.now(tz).date() if tz else date.today()
        start = today
        if a.get('from'):
            try:
                start = date.fromisoformat(str(a['from'])[:10])
            except ValueError:
                raise ToolError('from: YYYY-MM-DD') from None
        days = a.get('days', 30)
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 366:
            raise ToolError('days: 1 to 366')
        end = start + timedelta(days=days)
        out = []
        for c in self.svc.contacts:
            b = c.get('birthday')
            if not b:
                continue
            m = re.fullmatch(r'(\d{4}|-)-(\d{2})-(\d{2})', b)
            if not m:
                continue
            year = int(m.group(1)) if m.group(1) != '-' else None
            mo, dy = int(m.group(2)), int(m.group(3))
            for y in (start.year, start.year + 1):
                try:
                    d = date(y, mo, dy)
                except ValueError:  # 29 February in a common year
                    d = date(y, 3, 1)
                if start <= d < end:
                    out.append({'id': c['id'], 'name': c['name'], 'date': d.isoformat(),
                                **({'turns': y - year} if year else {})})
                    break
        out.sort(key=lambda x: x['date'])
        self.svc.log({'event': 'birthdays', 'count': len(out)})
        return {'from': start.isoformat(), 'to': (end - timedelta(days=1)).isoformat(), 'birthdays': out[:MAX_RESULTS]}


# ── start ──────────────────────────────────────────────────────────────────

def parse_token(raw):
    if not raw:
        return None, ''
    try:
        t = json.loads(raw)
    except ValueError:
        return None, 'the Contacts sign-in is not valid JSON (paste the whole output of google-signin.py)'
    if not isinstance(t, dict) or not t.get('refresh_token') or not t.get('client_id'):
        return None, 'the Contacts sign-in has no refresh_token or client_id'
    return t, ''


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(256 * 1024)
    try:
        payload = json.loads(raw)
    except ValueError:
        print('contacts service: no settings on stdin; start it with launch.py', file=sys.stderr)
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
    svc.load(force=True)
    if cfg.get('source') == 'google' and svc.google is not None:
        threading.Thread(target=svc.refresh_loop, daemon=True).start()
    callers = {int(k): str(v) for k, v in (cfg.get('knownCallers') or {}).items()}
    if callers:
        ksrv, why = knowncontact.serve(svc.known, callers, svc.log)
        svc.known_check = f'answering {", ".join(sorted(callers.values()))}' if ksrv else why
        if not ksrv:
            print(f'contacts service: {why}', file=sys.stderr, flush=True)
            svc.log({'event': 'known_check_off', 'detail': why})
    else:
        svc.known_check = 'off (no mail or calendar service user in this image)'
    srv = svcutil.serve_unix(cfg.get('socket') or os.path.join(cfg['stateDir'], 'worker.sock'),
                             mcp.make_handler(lambda rid, params: mcp.run_tool(rid, params, tools.call, svc.log),
                                              svc.health))
    if svc.state in ('unavailable', 'refused') and cfg.get('source') == 'google':
        svcutil.schedule_exit(0, WAIT_REFUSED_S)
    print(f'contacts service: {svc.state}{": " + svc.reason if svc.reason else ""}; '
          f'{len(svc.contacts)} contacts from {cfg.get("source")}', flush=True)
    srv.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
