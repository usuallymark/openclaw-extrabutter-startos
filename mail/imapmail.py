"""The mailbox connection: one IMAP session, used under a lock.

Only what the mail tools need: list folders, search, fetch (always PEEK, so
reading never marks mail as read), set flags, move, append drafts and sent
copies. There is no EXPUNGE of anything but the exact UIDs just moved, or
the one draft just sent (in the Drafts folder, checked by its Message-ID),
and no other delete.
"""

import base64
import imaplib
import re
import socket
import ssl
import threading
import time

TIMEOUT = 30


class AuthRefused(Exception):
    """The mailbox refused the password (not a network problem)."""


class MailError(Exception):
    """A problem to report to the caller in plain words."""


# ── Folder names: IMAP's modified UTF-7 (RFC 3501 5.1.3) ────────────────────

def mutf7_encode(s):
    out, buf = [], []

    def flush():
        if buf:
            b = base64.b64encode(''.join(buf).encode('utf-16-be')).decode().rstrip('=')
            out.append('&' + b.replace('/', ',') + '-')
            buf.clear()

    for ch in s:
        if 0x20 <= ord(ch) <= 0x7e:
            flush()
            out.append('&-' if ch == '&' else ch)
        else:
            buf.append(ch)
    flush()
    return ''.join(out)


def mutf7_decode(s):
    def rep(m):
        b = m.group(1)
        if not b:
            return '&'
        b = b.replace(',', '/')
        b += '=' * (-len(b) % 4)
        try:
            return base64.b64decode(b).decode('utf-16-be')
        except Exception:
            return m.group(0)
    return re.sub(r'&([A-Za-z0-9+,]*)-', rep, s)


def quote(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


_LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\) (?P<delim>"[^"]*"|NIL) (?P<name>.+)$')


def _parse_list_line(line):
    if isinstance(line, tuple):  # literal folder name
        head, lit = line
        head = head.decode('utf-8', 'replace')
        m = re.match(r'^\((?P<flags>[^)]*)\) (?P<delim>"[^"]*"|NIL) ', head)
        if not m:
            return None
        return m.group('flags').split(), lit.decode('utf-8', 'replace')
    line = line.decode('utf-8', 'replace') if isinstance(line, bytes) else line
    m = _LIST_RE.match(line)
    if not m:
        return None
    name = m.group('name')
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1].replace('\\"', '"').replace('\\\\', '\\')
    return m.group('flags').split(), name


class Mailbox:
    def __init__(self, cfg, password):
        self.cfg = cfg
        self._password = password
        self.lock = threading.Lock()
        self.conn = None
        self.selected = None
        self._folders = None
        self._folders_at = 0
        self.capabilities = set()

    # ── connection ──────────────────────────────────────────────────────────

    def _open(self):
        imap = self.cfg['imap']
        ctx = ssl.create_default_context()
        try:
            if imap.get('security', 'tls') == 'tls':
                c = imaplib.IMAP4_SSL(imap['host'], int(imap['port']), ssl_context=ctx, timeout=TIMEOUT)
            else:
                c = imaplib.IMAP4(imap['host'], int(imap['port']), timeout=TIMEOUT)
                c.starttls(ssl_context=ctx)
        except (OSError, imaplib.IMAP4.error) as e:
            raise MailError(f'cannot reach the IMAP server {imap["host"]}:{imap["port"]}: {e}') from None
        try:
            c.login(self.cfg['login'], self._password)
        except imaplib.IMAP4.abort as e:
            raise MailError(f'the IMAP server dropped the connection during login: {e}') from None
        except imaplib.IMAP4.error as e:
            try:
                c.shutdown()
            except Exception:
                pass
            detail = e.args[0] if e.args else ''
            raise AuthRefused(detail.decode('utf-8', 'replace') if isinstance(detail, bytes) else str(detail)) from None
        except OSError as e:
            raise MailError(f'network error during login: {e}') from None
        # Servers announce more after login (MOVE, UIDPLUS …) than before.
        try:
            typ, dat = c.capability()
            caps = dat[0].decode('ascii', 'replace').split() if typ == 'OK' and dat and dat[0] else []
        except Exception:
            caps = []
        self.capabilities = {x.upper() for x in list(c.capabilities) + caps}
        self.conn = c
        self.selected = None

    def login_check(self):
        """Log in once (startup). Raises AuthRefused or MailError."""
        with self.lock:
            self._close()
            self._open()

    def _close(self):
        if self.conn is not None:
            try:
                self.conn.logout()
            except Exception:
                pass
        self.conn = None
        self.selected = None

    def run(self, fn):
        """Run fn() under the lock with a live connection; reconnect once."""
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.conn is None:
                        self._open()
                    elif attempt == 1:
                        try:
                            self.conn.noop()
                        except (imaplib.IMAP4.abort, OSError, socket.timeout):
                            self._close()
                            self._open()
                    return fn()
                except (imaplib.IMAP4.abort, OSError, socket.timeout) as e:
                    self._close()
                    if attempt == 2:
                        raise MailError(f'the connection to the mailbox failed: {e}') from None

    def _cmd(self, name, *args, resp=None):
        """Send one command with arguments formatted here. imaplib's own
        quoting differs between Python versions (3.11 sends mailbox names as
        given; later releases quote them), so every command goes through its
        low-level sender with our own quoting."""
        for a in args:
            if isinstance(a, str) and re.search(r'[\x00\r\n]', a):
                raise MailError('invalid characters in a command argument')
        typ, dat = self.conn._simple_command(name, *args)
        if resp is None:
            return typ, dat
        return self.conn._untagged_response(typ, dat, resp)

    # ── folders ─────────────────────────────────────────────────────────────

    def folders(self):
        if self._folders is not None and time.time() - self._folders_at < 600:
            return self._folders
        typ, data = self._cmd('LIST', '""', '"*"', resp='LIST')
        if typ != 'OK':
            raise MailError('the server did not list its folders')
        out = []
        for line in data or []:
            if line is None:
                continue
            p = _parse_list_line(line)
            if not p:
                continue
            flags, raw = p
            out.append({'name': mutf7_decode(raw), 'raw': raw, 'flags': [f.lower() for f in flags]})
        self._folders, self._folders_at = out, time.time()
        return out

    def special(self, use):
        """Folder with a special-use flag (e.g. '\\drafts'), or None."""
        for f in self.folders():
            if use in f['flags']:
                return f
        return None

    def resolve(self, name):
        """A folder by its display name (case-insensitive for INBOX)."""
        name = (name or 'INBOX').strip()
        if name.upper() == 'INBOX':
            return {'name': 'INBOX', 'raw': 'INBOX', 'flags': []}
        for f in self.folders():
            if f['name'] == name:
                return f
        for f in self.folders():
            if f['name'].lower() == name.lower():
                return f
        raise MailError(f'no folder "{name}" (see the folders tool)')

    def select(self, folder, readonly=True):
        key = (folder['raw'], readonly)
        if self.selected == key:
            return
        self.conn.untagged_responses = {}
        typ, data = self._cmd('EXAMINE' if readonly else 'SELECT', quote(folder['raw']))
        if typ != 'OK':
            raise MailError(f'cannot open folder "{folder["name"]}": {data[0].decode(errors="replace") if data and data[0] else ""}')
        # What imaplib's select() would record.
        self.conn.state = 'SELECTED'
        self.conn.is_readonly = readonly
        self.selected = key

    # ── search and fetch ────────────────────────────────────────────────────

    def uid_search(self, criteria, literal=None):
        if literal is not None:
            self.conn.literal = literal
            typ, data = self._cmd('UID', 'SEARCH', 'CHARSET', 'UTF-8', *criteria, resp='SEARCH')
        else:
            typ, data = self._cmd('UID', 'SEARCH', *criteria, resp='SEARCH')
        if typ != 'OK':
            raise MailError(f'search failed: {data[0].decode(errors="replace") if data and data[0] else ""}')
        return [int(x) for x in (data[0] or b'').split() if x.isdigit()]

    def fetch(self, uids, items):
        """{uid: {item: value}} for a UID FETCH."""
        if not uids:
            return {}
        typ, data = self._cmd('UID', 'FETCH', ','.join(str(u) for u in uids), items, resp='FETCH')
        if typ != 'OK':
            raise MailError('fetch failed')
        out = {}
        for entry in data or []:
            if not isinstance(entry, tuple):
                continue
            head, payload = entry
            head = head.decode('utf-8', 'replace')
            m = re.search(r'UID (\d+)', head)
            if not m:
                continue
            uid = int(m.group(1))
            rec = out.setdefault(uid, {})
            fm = re.search(r'FLAGS \(([^)]*)\)', head)
            if fm:
                rec['flags'] = fm.group(1).split()
            im = re.search(r'INTERNALDATE "([^"]+)"', head)
            if im:
                rec['internaldate'] = im.group(1)
            sm = re.search(r'RFC822\.SIZE (\d+)', head)
            if sm:
                rec['size'] = int(sm.group(1))
            rec['data'] = payload
        # FLAGS sometimes arrive in a trailing bytes line after the literal.
        for entry in data or []:
            if isinstance(entry, bytes):
                s = entry.decode('utf-8', 'replace')
                m, fm = re.search(r'UID (\d+)', s), re.search(r'FLAGS \(([^)]*)\)', s)
                if m and fm and int(m.group(1)) in out:
                    out[int(m.group(1))].setdefault('flags', fm.group(1).split())
        return out

    def size_of(self, uid):
        typ, data = self._cmd('UID', 'FETCH', str(uid), '(RFC822.SIZE FLAGS)', resp='FETCH')
        if typ != 'OK' or not data or data[0] is None:
            raise MailError(f'no message with id {uid} in this folder')
        s = data[0].decode('utf-8', 'replace') if isinstance(data[0], bytes) else str(data[0])
        m = re.search(r'RFC822\.SIZE (\d+)', s)
        fm = re.search(r'FLAGS \(([^)]*)\)', s)
        return (int(m.group(1)) if m else 0), (fm.group(1).split() if fm else [])

    # ── changes ─────────────────────────────────────────────────────────────

    def store(self, uids, op, flag):
        typ, data = self._cmd('UID', 'STORE', ','.join(str(u) for u in uids), op, f'({flag})')
        if typ != 'OK':
            raise MailError('the server refused the change')

    def move(self, uids, dest):
        seq = ','.join(str(u) for u in uids)
        if 'MOVE' in self.capabilities:
            typ, data = self._cmd('UID', 'MOVE', seq, quote(dest['raw']))
            if typ != 'OK':
                raise MailError(f'the server refused the move: {data[0].decode(errors="replace") if data and data[0] else ""}')
            return
        if 'UIDPLUS' not in self.capabilities:
            raise MailError('this mail server supports neither MOVE nor UIDPLUS, so messages cannot be moved safely from here')
        typ, _ = self._cmd('UID', 'COPY', seq, quote(dest['raw']))
        if typ != 'OK':
            raise MailError('the server refused to copy the messages')
        self.store(uids, '+FLAGS.SILENT', '\\Deleted')
        # UID EXPUNGE removes only these UIDs (the copies now exist in dest).
        typ, _ = self._cmd('UID', 'EXPUNGE', seq)
        if typ != 'OK':
            raise MailError('the copy was made, but the originals could not be removed from the source folder')

    def append(self, folder, flags, raw):
        self.conn.literal = imaplib.MapCRLF.sub(imaplib.CRLF, raw)
        typ, data = self._cmd('APPEND', quote(folder['raw']), flags, imaplib.Time2Internaldate(time.time()))
        if typ != 'OK':
            raise MailError(f'saving the message in {folder["name"]} failed: {data[0].decode(errors="replace") if data and data[0] else ""}')
        resp = (data[0] or b'').decode('utf-8', 'replace') if data else ''
        m = re.search(r'APPENDUID \d+ (\d+)', resp)
        self.selected = None
        return int(m.group(1)) if m else None

    def message_id_of(self, uid):
        """The Message-ID of uid in the selected folder, or None if it is gone."""
        rec = self.fetch([uid], '(UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])').get(uid)
        if not rec:
            return None
        m = re.search(rb'(?im)^message-id:\s*(<[^>\r\n]*>)', rec.get('data') or b'')
        return m.group(1).decode('utf-8', 'replace') if m else ''

    def remove_sent_draft(self, folder, uid, message_id):
        """Remove a draft that has just been sent: only in the Drafts folder,
        only that UID, and only when it still carries the same Message-ID.
        Without UIDPLUS it is only marked deleted (the mail app clears it)."""
        if '\\drafts' not in folder['flags'] and folder['name'].lower() not in ('drafts', 'draft'):
            raise MailError('refusing to remove a message outside the Drafts folder')
        self.select(folder, readonly=False)
        if not message_id or self.message_id_of(uid) != message_id:
            return False
        self.store([uid], '+FLAGS.SILENT', '\\Deleted')
        if 'UIDPLUS' in self.capabilities:
            typ, _ = self._cmd('UID', 'EXPUNGE', str(uid))
            if typ != 'OK':
                raise MailError('the sent draft could not be removed from Drafts')
        self.selected = None
        return True
