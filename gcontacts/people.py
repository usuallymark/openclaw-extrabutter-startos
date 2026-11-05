"""Google People API (read only): the assistant account's own contacts.

The sign-in is made once with tools/google-signin.py --scopes
contacts.readonly as the assistant's Google account, kept in Vaultwarden
(item "google-contacts", field "token") or pasted in Configure Contacts,
and handed to the worker on stdin. Access tokens live in memory only.
Only people/me/connections is read ("Other contacts" are not).
"""

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = 'https://oauth2.googleapis.com/token'
API_BASE = 'https://people.googleapis.com/v1'
FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,addresses,birthdays,organizations,biographies,memberships,urls'
TIMEOUT_S = 30
MAX_RESPONSE = 16 * 1024 * 1024
MAX_PAGES = 60


class SignInRefused(Exception):
    pass


class Unreachable(Exception):
    pass


class ApiError(Exception):
    def __init__(self, status, text):
        super().__init__(text)
        self.status = status


def _read(r):
    data = r.read(MAX_RESPONSE + 1)
    if len(data) > MAX_RESPONSE:
        raise ApiError(502, 'the answer from Google was too large')
    return data


class People:
    def __init__(self, token, endpoints=None):
        self.client_id = token['client_id']
        self.client_secret = token.get('client_secret') or ''
        self.refresh_token = token['refresh_token']
        ep = endpoints or {}
        self.token_url = ep.get('token') or TOKEN_URL
        self.api = (ep.get('api') or API_BASE).rstrip('/')
        self.scopes = []
        self._access, self._expires = None, 0
        self._lock = threading.Lock()

    def refresh(self):
        body = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': self.refresh_token,
                                       'client_id': self.client_id, 'client_secret': self.client_secret}).encode()
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
                raise SignInRefused('Google refused the Contacts sign-in (expired, revoked, or the OAuth client changed); '
                                    'sign in again with google-signin.py') from None
            raise Unreachable(f'Google sign-in answered HTTP {e.code} {err}'.strip()) from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise Unreachable(f'cannot reach Google ({getattr(e, "reason", None) or e})') from None
        if not d.get('access_token'):
            raise Unreachable('Google sign-in gave no access token')
        self._access = d['access_token']
        self._expires = time.time() + int(d.get('expires_in') or 3600)
        if d.get('scope'):
            p = 'https://www.googleapis.com/auth/'
            self.scopes = sorted(s[len(p):] if s.startswith(p) else s for s in str(d['scope']).split())
        return self.scopes

    def _token(self):
        with self._lock:
            if not self._access or time.time() > self._expires - 60:
                self.refresh()
            return self._access

    def _get(self, path, params, retry=True):
        url = f'{self.api}{path}?' + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {self._token()}', 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                return json.loads(_read(r) or b'{}')
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                with self._lock:
                    self._access = None
                return self._get(path, params, retry=False)
            if e.code == 403:
                raise ApiError(403, 'Google refused (is the People API enabled in the Google Cloud project, and does '
                                    'the sign-in include contacts.readonly?)') from None
            if e.code == 429:
                raise ApiError(429, 'Google is limiting requests; try again in a minute') from None
            raise ApiError(e.code, f'the People API answered HTTP {e.code}') from None
        except (urllib.error.URLError, OSError) as e:
            raise Unreachable(f'cannot reach Google ({getattr(e, "reason", None) or e})') from None
        except ValueError:
            raise ApiError(502, 'the People API answered something that is not JSON') from None

    def connections(self):
        """Every contact of the account, as raw People API person objects."""
        out, page = [], None
        for _ in range(MAX_PAGES):
            d = self._get('/people/me/connections', {'personFields': FIELDS, 'pageSize': 1000, 'pageToken': page,
                                                     'sortOrder': 'LAST_NAME_ASCENDING'})
            out += d.get('connections') or []
            page = d.get('nextPageToken')
            if not page:
                break
        return out


def _first(xs, key):
    for x in xs or []:
        if (x.get('metadata') or {}).get('primary') and x.get(key):
            return x[key]
    for x in xs or []:
        if x.get(key):
            return x[key]
    return ''


def to_contact(p, clean):
    """A People API person → the same dict shape as vcard.parse gives."""
    rid = str(p.get('resourceName') or '')
    name = _first(p.get('names'), 'displayName')
    names = sorted(({clean(n.get('displayName') or '') for n in p.get('names') or []} |
                    {clean(n.get('value') or '') for n in p.get('nicknames') or []}) - {'', clean(name)})
    bday = None
    for b in p.get('birthdays') or []:
        d = b.get('date') or {}
        if d.get('month') and d.get('day'):
            bday = (f'{d["year"]:04d}-' if d.get('year') else '--') + f'{d["month"]:02d}-{d["day"]:02d}'
            break
    org = ''
    title = ''
    for o in p.get('organizations') or []:
        org = org or clean(o.get('name') or '')
        title = title or clean(o.get('title') or '')
    groups = [str((m.get('contactGroupMembership') or {}).get('contactGroupResourceName') or '').replace('contactGroups/', '')
              for m in p.get('memberships') or []]
    emails = [{'address': clean(e.get('value') or '').lower(), 'type': clean(e.get('type') or '')}
              for e in p.get('emailAddresses') or [] if '@' in str(e.get('value') or '')]
    return {
        'id': 'g' + rid.replace('people/', '')[:40],
        'name': clean(name) or (emails[0]['address'] if emails else '(no name)'),
        'other_names': [x for x in names if x][:10],
        'emails': emails[:20],
        'phones': [{'number': clean(t.get('value') or ''), 'type': clean(t.get('type') or '')}
                   for t in p.get('phoneNumbers') or [] if t.get('value')][:20],
        'addresses': [{'address': clean((a.get('formattedValue') or '').replace('\n', ', ')), 'type': clean(a.get('type') or '')}
                      for a in p.get('addresses') or [] if a.get('formattedValue')][:10],
        'birthday': bday, 'organization': org, 'title': title,
        'groups': [g for g in groups if g and g != 'myContacts'][:20],
        'note': clean(_first(p.get('biographies'), 'value')),
        'urls': [clean(u.get('value') or '')[:300] for u in p.get('urls') or [] if u.get('value')][:10],
    }
