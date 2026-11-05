"""Is this address in the owner's contacts? (since 2026.10.1:33)

The mail and calendar services mark a sender or organizer found in the
contacts as known_contact (weaker than trusted: "in the address book", not
"verified"). They never get the address book: they ask the contacts
service over a Unix socket, one batch of addresses at a time, and the
answer is only yes or no for each. No name, number or other address leaves
the contacts service.

The socket is in the abstract namespace (the services run in one
container). Both ends check the other's user id (SO_PEERCRED), as for the
invitation socket (mail/invite.py): the contacts service answers only the
mail and calendar services' users, and the client talks only to the
contacts service's user. An agent (user node) can neither ask nor pose as
the contacts service; if it took the socket name first, the client refuses
it and the contacts service says so in its log and status.

Addresses are compared exactly, in lower case (the same rule as the contacts
tool lookup). Copied into the mail, calendar and contacts services' folders
in the image.
"""

import json
import os
import pwd
import socket
import socketserver
import stat
import struct
import threading
import time

SOCKET_NAME = '\0openclaw-contacts-known'
CONTACTS_USER = 'openclaw-contacts'
CALLER_USERS = ('openclaw-mail', 'openclaw-calendar')
CONTACTS_SETTINGS = '/data/.openclaw-contacts/settings.json'
MAX_ADDRESSES = 100
MAX_REQUEST = 64 * 1024
REQUESTS_PER_MINUTE = 120
TIMEOUT_S = 5


def normalize(addr):
    """The form addresses are compared in, or '' when it is not one."""
    a = str(addr or '').strip().lower()
    if a.startswith('mailto:'):
        a = a[7:]
    if '@' not in a or len(a) > 254 or any(c.isspace() for c in a):
        return ''
    return a


def contacts_on(owner, node_uid):
    """For a launcher (as root): whether Configure Contacts has a source.
    Only the package's own settings file counts (not a link, not the
    gateway user's)."""
    try:
        st = os.lstat(CONTACTS_SETTINGS)
        if not stat.S_ISREG(st.st_mode) or st.st_uid not in (0, owner) or st.st_uid == node_uid:
            return False
        with open(CONTACTS_SETTINGS) as f:
            return (json.load(f) or {}).get('source') in ('vcard', 'google')
    except (OSError, ValueError, AttributeError):
        return False


def _peer_uid(sock):
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    return struct.unpack('3i', creds)[1]


# ── the mail and calendar services' side ───────────────────────────────────

class Checker:
    """known(addresses) → {address: True/False}, or None when the contacts
    service cannot answer. Off (always None, nothing asked) unless the
    launcher found Contacts on. state is for the status tool."""

    def __init__(self, enabled, log=None):
        self.enabled = bool(enabled)
        self.state = 'answering' if self.enabled else 'off'
        self._log = log or (lambda entry: None)
        try:
            self._uid = pwd.getpwnam(CONTACTS_USER).pw_uid
        except KeyError:
            self._uid = None

    def status(self):
        return self.state

    def known(self, addresses):
        if not self.enabled:
            return None
        asked = sorted({a for a in (normalize(x) for x in addresses) if a})
        if not asked:
            return {}
        if self._uid is None:
            self.state = f'not answering (the user {CONTACTS_USER} is missing from this image)'
            return None
        out = {}
        for i in range(0, len(asked), MAX_ADDRESSES):
            part = asked[i:i + MAX_ADDRESSES]
            ans = self._ask(part)
            if ans is None:
                return None
            out.update(zip(part, ans))
        self.state = 'answering'
        return out

    def _ask(self, addresses):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(TIMEOUT_S)
        buf = b''
        try:
            try:
                s.connect(SOCKET_NAME)
            except OSError:
                return self._fail('not answering (is the Contacts Service line green?)')
            if _peer_uid(s) != self._uid:
                self._log({'event': 'contacts_check_refused', 'detail': 'something other than the contacts service '
                                                                        'holds its socket name'})
                return self._fail('refused: something other than the contacts service is listening')
            s.sendall(json.dumps({'addresses': addresses}).encode() + b'\n')
            while not buf.endswith(b'\n'):
                part = s.recv(65536)
                if not part:
                    break
                buf += part
                if len(buf) > MAX_REQUEST:
                    return self._fail('not answering (the answer was too large)')
        except OSError:
            return self._fail('not answering (no answer in time)')
        finally:
            s.close()
        try:
            res = json.loads(buf)
        except ValueError:
            res = None
        if not isinstance(res, dict):
            return self._fail('not answering (no answer)')
        if res.get('result') != 'ok':
            return self._fail(f'{res.get("result") or "failed"}: {str(res.get("detail") or "")[:200]}')
        known = res.get('known')
        if not isinstance(known, list) or len(known) != len(addresses) or not all(isinstance(k, bool) for k in known):
            return self._fail('not answering (an answer of the wrong shape)')
        return known

    def _fail(self, state):
        self.state = state
        return None


# ── the contacts service's side ────────────────────────────────────────────

class Unavailable(Exception):
    """The contacts are not loaded (no file yet, Google refused …)."""


class _Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def allowed_callers():
    """{uid: name} of the services that may ask."""
    out = {}
    for name in CALLER_USERS:
        try:
            out[pwd.getpwnam(name).pw_uid] = name.removeprefix('openclaw-')
        except KeyError:
            pass
    return out


def serve(lookup, callers, log):
    """Answer the mail and calendar services. lookup(list of normalized
    addresses) → list of bools (raises Unavailable). callers: {uid: name}.
    Returns the server, or None with the reason when the name is taken."""
    calls = {}
    lock = threading.Lock()

    def rate_ok(uid):
        now = time.time()
        with lock:
            lst = [t for t in calls.get(uid, []) if now - t < 60]
            if len(lst) >= REQUESTS_PER_MINUTE:
                calls[uid] = lst
                return False
            lst.append(now)
            calls[uid] = lst
            return True

    class Handler(socketserver.StreamRequestHandler):
        timeout = 10

        def handle(self):
            uid = _peer_uid(self.request)
            try:
                if uid not in callers:
                    out = {'result': 'refused', 'detail': 'only the mail and calendar services may ask'}
                    log({'event': 'known_check_refused', 'caller_uid': uid})
                elif not rate_ok(uid):
                    out = {'result': 'refused', 'detail': f'more than {REQUESTS_PER_MINUTE} checks a minute'}
                else:
                    out = self._answer(callers[uid])
            except Exception as e:  # never a traceback to the caller
                out = {'result': 'failed', 'detail': f'internal error in the contacts service ({type(e).__name__})'}
            try:
                self.wfile.write(json.dumps(out).encode() + b'\n')
            except OSError:
                pass

        def _answer(self, caller):
            line = self.rfile.readline(MAX_REQUEST + 1)
            if len(line) > MAX_REQUEST:
                return {'result': 'refused', 'detail': 'request too large'}
            try:
                req = json.loads(line or b'{}')
            except ValueError:
                req = None
            addrs = req.get('addresses') if isinstance(req, dict) else None
            if not isinstance(addrs, list) or len(addrs) > MAX_ADDRESSES or not all(isinstance(a, str) for a in addrs):
                return {'result': 'refused', 'detail': f'give "addresses": a list of at most {MAX_ADDRESSES}'}
            try:
                known = lookup([normalize(a) for a in addrs])
            except Unavailable as e:
                return {'result': 'unavailable', 'detail': str(e)[:200]}
            # Counts only: never an address.
            log({'event': 'known_check', 'caller': caller, 'asked': len(addrs), 'known': sum(known)})
            return {'result': 'ok', 'known': known}

    try:
        srv = _Server(SOCKET_NAME, Handler)
    except OSError as e:
        return None, f'the contacts check socket is taken by another process ({e.strerror or e})'
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, ''
