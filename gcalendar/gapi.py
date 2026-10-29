"""Google sign-in (OAuth refresh) and the Calendar API, standard library only.

The sign-in is a refresh token made once on the owner's computer
(tools/google-signin.py) and handed to the worker on stdin. Access tokens
live in memory only and are refreshed shortly before they expire.
"""

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = 'https://oauth2.googleapis.com/token'
API_BASE = 'https://www.googleapis.com/calendar/v3'
TIMEOUT_S = 30
MAX_RESPONSE = 8 * 1024 * 1024

SCOPE_PREFIX = 'https://www.googleapis.com/auth/'
# Scopes that let a token change calendars. Read-only mode never uses
# them, and says so when the sign-in has them.
WRITE_SCOPES = {'calendar', 'calendar.events', 'calendar.events.owned', 'calendar.app.created',
                'calendar.calendars', 'calendar.calendarlist', 'calendar.acls'}
READ_SCOPES = {'calendar.readonly', 'calendar.events.readonly', 'calendar'}


class SignInRefused(Exception):
    """Google refused the sign-in (revoked, expired, or the client is gone)."""


class Unreachable(Exception):
    """Google could not be reached."""


class ApiError(Exception):
    """The Calendar API answered with an error, in plain words."""

    def __init__(self, status, text):
        super().__init__(text)
        self.status = status


def short_scope(s):
    return s[len(SCOPE_PREFIX):] if s.startswith(SCOPE_PREFIX) else s


def _read(resp):
    data = resp.read(MAX_RESPONSE + 1)
    if len(data) > MAX_RESPONSE:
        raise ApiError(502, 'the answer from Google was too large')
    return data


class Google:
    def __init__(self, token, endpoints=None):
        self.client_id = token['client_id']
        self.client_secret = token.get('client_secret') or ''
        self.refresh_token = token['refresh_token']
        ep = endpoints or {}
        self.token_url = ep.get('token') or TOKEN_URL
        self.api_base = (ep.get('api') or API_BASE).rstrip('/')
        self.scopes = []
        self._access = None
        self._expires = 0
        self._lock = threading.Lock()

    # ── sign-in ────────────────────────────────────────────────────────────

    def refresh(self):
        """Get a new access token. Raises SignInRefused or Unreachable."""
        body = urllib.parse.urlencode({
            'grant_type': 'refresh_token', 'refresh_token': self.refresh_token,
            'client_id': self.client_id, 'client_secret': self.client_secret,
        }).encode()
        req = urllib.request.Request(self.token_url, body, {'Content-Type': 'application/x-www-form-urlencoded'})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                d = json.loads(_read(r))
        except urllib.error.HTTPError as e:
            try:
                d = json.loads(e.read(65536))
            except ValueError:
                d = {}
            err = str(d.get('error') or '')
            if e.code in (400, 401) and err in ('invalid_grant', 'invalid_client', 'unauthorized_client'):
                raise SignInRefused(_refusal_text(err, str(d.get('error_description') or ''))) from None
            raise Unreachable(f'Google sign-in answered HTTP {e.code} {err}'.strip()) from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise Unreachable(f'cannot reach Google ({getattr(e, "reason", None) or e})') from None
        if not d.get('access_token'):
            raise Unreachable('Google sign-in gave no access token')
        self._access = d['access_token']
        self._expires = time.time() + int(d.get('expires_in') or 3600)
        if d.get('scope'):
            self.scopes = sorted(short_scope(s) for s in str(d['scope']).split())
        return self.scopes

    def _token(self):
        with self._lock:
            if not self._access or time.time() > self._expires - 60:
                self.refresh()
            return self._access

    # ── API ────────────────────────────────────────────────────────────────

    def get(self, path, params=None, _retry=True):
        """GET an API path (already quoted) and return the JSON."""
        url = f'{self.api_base}{path}'
        if params:
            url += '?' + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {self._token()}',
                                                   'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                return json.loads(_read(r))
        except urllib.error.HTTPError as e:
            if e.code == 401 and _retry:
                with self._lock:
                    self._access = None
                return self.get(path, params, _retry=False)
            raise ApiError(e.code, _api_error_text(e)) from None
        except (urllib.error.URLError, OSError) as e:
            raise Unreachable(f'cannot reach Google Calendar ({getattr(e, "reason", None) or e})') from None
        except ValueError:
            raise ApiError(502, 'Google Calendar answered something that is not JSON') from None


def _refusal_text(err, desc):
    if err == 'invalid_grant':
        return ('Google refused the Calendar sign-in (expired or revoked). If the Google Cloud app is in '
                '"Testing", sign-ins expire after 7 days: set it to "In production" and sign in again')
    if err in ('invalid_client', 'unauthorized_client'):
        return 'Google refused the OAuth client of the Calendar sign-in (deleted or changed); sign in again'
    return f'Google refused the Calendar sign-in ({err} {desc})'.strip()


def _api_error_text(e):
    try:
        d = json.loads(e.read(65536))
        err = d.get('error') or {}
        msg = str(err.get('message') or '')
        reason = ''
        for x in err.get('errors') or []:
            reason = str(x.get('reason') or reason)
    except (ValueError, AttributeError, OSError):
        msg, reason = '', ''
    if e.code == 403 and reason in ('insufficientPermissions', 'forbidden', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'):
        return 'the Calendar sign-in does not allow this (missing permission)'
    if e.code == 404:
        return 'not found (wrong calendar or event id, or not shared with this account)'
    if e.code == 429 or (e.code == 403 and 'ratelimit' in reason.lower()):
        return 'Google Calendar is limiting requests; try again in a minute'
    return f'Google Calendar answered HTTP {e.code}' + (f': {msg[:200]}' if msg else '')
