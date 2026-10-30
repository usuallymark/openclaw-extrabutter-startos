#!/usr/bin/env python3
"""OpenClaw Extra Butter mail service.

Runs as its own Linux user (openclaw-mail) and is the only thing that talks
to the mailbox. Started by launch.py, which hands it the settings and the
password on stdin and is then gone. Agents reach it as the MCP server
"mail" (tools mail__*) through front.py, which stays up while this worker
restarts and passes tool calls to it over a Unix socket in the state
folder. The rules below are enforced here, for every caller.

- Reading never marks mail as read and returns plain text only, wrapped as
  untrusted content, with the receiving server's sender checks.
- Attachments stay in the mailbox. Their text can be read; files are
  released to the workspace only for a trusted sender with passing checks.
- Organising: mark read, flag, move, archive. Never delete, never move to
  Trash or Spam.
- Drafts are saved to the Drafts folder. Sending follows the owner's rules
  (outbox.py): refused, sent, or held until the owner approves it in
  StartOS. Only drafts made by this service can be sent.
- The password lives in this process's memory only. When the mailbox
  refuses it, the service exits so the launcher fetches it again; a
  password already refused is never tried twice (lockout guard).
"""

import sys

sys.path.insert(0, '/opt/openclaw-mail')

import email  # noqa: E402
import hashlib  # noqa: E402
import mimetypes  # noqa: E402
import smtplib  # noqa: E402
import imaplib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import secrets  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from datetime import datetime  # noqa: E402
from email import policy  # noqa: E402
from email.message import EmailMessage  # noqa: E402
from email.utils import formataddr, getaddresses, make_msgid, formatdate  # noqa: E402

import mcp  # noqa: E402
import svcutil  # noqa: E402
import message as M  # noqa: E402
from mcp import TOOLS, MAX_LIST, MAX_UIDS  # noqa: E402
from extract import attachment_text  # noqa: E402
from imapmail import AuthRefused, MailError, Mailbox  # noqa: E402
from outbox import Outbox, SmtpRefused, recipients  # noqa: E402
from sanitize import clean_line, clean_text, wrap_untrusted  # noqa: E402

VERSION = mcp.VERSION
EXIT_RELOAD = 75          # password refused: launcher fetches it again
WAIT_REFUSED_S = 600      # re-check Vaultwarden every 10 minutes
WAIT_UNAVAILABLE_S = 120  # password could not be fetched: retry sooner
MAX_FETCH_BYTES = 30 * 1024 * 1024
CALLS_PER_MINUTE = 120
LOG_MAX_BYTES = 5 * 1024 * 1024
MAX_ATTACH_FILES = 10
MAX_ATTACH_BYTES = 18 * 1024 * 1024   # stays under 25 MB once encoded
QUEUE_POLL_S = 10


# ── State ───────────────────────────────────────────────────────────────────

class Service:
    def __init__(self, cfg, password, reason):
        self.cfg = cfg
        self.state_dir = cfg['stateDir']
        self.state = 'starting'
        self.reason = ''
        self.since = _now()
        self.trusted = [t.lower() for t in cfg.get('trustedSenders') or []]
        self.box = Mailbox(cfg, password) if password else None
        self.outbox = Outbox(self, cfg, password) if password else None
        self._fp = self._fingerprint(password) if password else None
        self._calls = []
        self._calls_lock = threading.Lock()
        self._log = svcutil.ActivityLog(os.path.join(self.state_dir, 'activity.jsonl'), LOG_MAX_BYTES)
        if not password:
            self.set_state('unavailable', reason or 'no password was available')

    # state and lockout guard

    def set_state(self, state, reason=''):
        if state != self.state or reason != self.reason:
            self.since = _now()
        self.state, self.reason = state, reason
        self.log({'event': 'state', 'state': state, 'reason': reason})

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
        _write_private(p, s)
        return s

    def _fingerprint(self, password):
        return hashlib.sha256(self._salt() + password.encode()).hexdigest()

    def _refused_path(self):
        return os.path.join(self.state_dir, 'refused.json')

    def refused_record(self):
        try:
            with open(self._refused_path()) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def record_refusal(self, why):
        rec = self.refused_record()
        since = rec['since'] if rec and rec.get('fp') == self._fp else _now()
        _write_private(self._refused_path(), json.dumps({'fp': self._fp, 'since': since, 'why': clean_line(why, 200)}).encode())

    def startup(self):
        """Decide the state at start. Returns the seconds after which to exit
        and be relaunched, or None to keep running."""
        if self.box is None:
            return WAIT_UNAVAILABLE_S
        rec = self.refused_record()
        if rec and rec.get('fp') == self._fp:
            self.state = 'refused'
            self.reason = (f'the mailbox refused the password stored in Vaultwarden (since {rec.get("since")}); '
                           'update the Vaultwarden item "email"' if self.cfg.get('passwordSource') == 'vault' else
                           f'the mailbox refused the saved password (since {rec.get("since")}); '
                           'enter the new one in Configure Email')
            self.since = rec.get('since') or _now()
            self.log({'event': 'state', 'state': 'refused', 'reason': 'same password as last refused; not trying it again'})
            return WAIT_REFUSED_S
        try:
            self.box.login_check()
        except AuthRefused as e:
            self.record_refusal(str(e))
            self.log({'event': 'auth_refused', 'detail': clean_line(str(e), 200)})
            self.set_state('reloading', 'the mailbox refused the password; fetching it again')
            return 0
        except MailError as e:
            self.set_state('unreachable', str(e))
            return None
        try:
            os.unlink(self._refused_path())
        except OSError:
            pass
        self.set_state('ok')
        return None

    # activity log (no message bodies)

    def log(self, entry):
        self._log(entry)

    def rate_ok(self):
        now = time.time()
        with self._calls_lock:
            self._calls = [t for t in self._calls if now - t < 60]
            if len(self._calls) >= CALLS_PER_MINUTE:
                return False
            self._calls.append(now)
            return True

    def health(self):
        h = {
            'state': self.state, 'since': self.since, 'reason': self.reason,
            'address': self.cfg.get('address'), 'sending': 'drafts', 'others': 'ask',
            'passwordSource': self.cfg.get('passwordSource'),
            'trustedSenders': len(self.trusted), 'version': VERSION,
            'note': self.cfg.get('note') or '',
            'queue': [],
        }
        if self.outbox:
            r = self.outbox.rules()
            h['sending'], h['others'] = r['level'], r['others']
            # Summary only (no message text): the package raises a StartOS
            # task and a phone alert from it.
            h['queue'] = [{'id': q['id'], 'to': q.get('to', ''), 'subject': q.get('subject', ''),
                           'rule': q.get('rule', '')} for q in self.outbox.pending()]
        return h


_now = svcutil.now_text
_write_all = svcutil.write_all
_write_private = svcutil.write_private
_schedule_exit = svcutil.schedule_exit


# ── Tools ───────────────────────────────────────────────────────────────────

_FORBIDDEN_DEST = re.compile(r'(trash|bin|deleted|junk|spam|papierkorb|corbeille|papelera)', re.I)
_ADDR = re.compile(r'^[^@\s<>",;:()\[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$')


ToolError = mcp.ToolError


def _int_list(v, name='uids'):
    if not isinstance(v, list) or not v:
        raise ToolError(f'{name}: give a list of message ids')
    if len(v) > MAX_UIDS:
        raise ToolError(f'{name}: at most {MAX_UIDS} at a time')
    out = []
    for x in v:
        if not isinstance(x, int) or isinstance(x, bool) or x <= 0:
            raise ToolError(f'{name}: ids are positive whole numbers')
        out.append(x)
    return out


def _uid(args):
    v = args.get('uid')
    if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
        raise ToolError('uid: give the message id from list or search')
    return v


def _imap_date(s, name):
    try:
        d = datetime.strptime(str(s).strip(), '%Y-%m-%d')
    except ValueError:
        raise ToolError(f'{name}: use YYYY-MM-DD') from None
    return d.strftime('%d-%b-%Y')


def _quote_search(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


class Tools:
    def __init__(self, svc):
        self.svc = svc

    @property
    def box(self):
        return self.svc.box

    def call(self, name, args):
        fn = getattr(self, 't_' + name, None)
        if fn is None or name not in {t['name'] for t in TOOLS}:
            raise ToolError(f'unknown tool {name}')
        if name != 'status' and self.svc.state not in ('ok', 'unreachable'):
            raise ToolError(self._unavailable())
        if name != 'status' and not self.svc.rate_ok():
            raise ToolError(f'too many mail requests (more than {CALLS_PER_MINUTE} a minute); wait a minute')
        try:
            out = fn(args or {})
            if self.svc.state == 'unreachable' and name != 'status':
                self.svc.set_state('ok')
            return out
        except AuthRefused as e:
            self.svc.record_refusal(str(e))
            self.svc.log({'event': 'auth_refused', 'detail': clean_line(str(e), 200)})
            self.svc.set_state('reloading', 'the mailbox refused the password; fetching it again')
            _schedule_exit(EXIT_RELOAD, 0.5)
            raise ToolError('mail service reloading (the mailbox refused the password); try again in a minute') from None
        except MailError as e:
            raise ToolError(str(e)) from None
        except imaplib.IMAP4.error as e:
            raise ToolError(f'the mail server answered: {clean_line(str(e), 200)}') from None
        except OSError as e:
            raise ToolError(f'{name} failed: {e.strerror or type(e).__name__}') from None

    def _unavailable(self):
        s = self.svc
        if s.state == 'reloading':
            return 'mail service reloading, try again shortly'
        if s.state == 'refused':
            return f'mail is unavailable: {s.reason}'
        if s.state == 'unavailable':
            return f'mail is unavailable: {s.reason} (retrying every few minutes)'
        return f'mail service is {s.state}'

    # status / folders

    def t_status(self, a):
        h = self.svc.health()
        ob = self.svc.outbox
        if ob:
            r = ob.rules()
            h['sending'] = {
                'off': 'Off: read only, no drafts are sent',
                'drafts': 'Drafts only: drafts are saved, nothing is sent',
                'rules': ('Send by rules: send to the automatic list; '
                          + {'ask': 'anyone else waits for the owner\'s approval',
                             'block': 'anyone else is refused',
                             'auto': 'anyone else is sent too'}[r['others']]
                          + '; forwards and attachments always wait for approval'),
            }[r['level']]
            h['waiting_for_approval'] = h.pop('queue')
            h['recent_outcomes'] = [{k: x.get(k) for k in ('id', 'outcome', 'to', 'subject', 'detail')}
                                    for x in ob.results(10)]
        return h

    def _role(self, f):
        for flag, role in (('\\drafts', 'drafts'), ('\\sent', 'sent'), ('\\trash', 'trash'),
                           ('\\junk', 'spam'), ('\\all', 'all mail / archive'),
                           ('\\archive', 'archive'), ('\\flagged', 'starred'), ('\\important', 'important')):
            if flag in f['flags']:
                return role
        return 'inbox' if f['name'].upper() == 'INBOX' else ''

    def t_folders(self, a):
        def go():
            return [{'name': f['name'], 'role': self._role(f)} for f in self.box.folders()
                    if '\\noselect' not in f['flags'] and '\\nonexistent' not in f['flags']]
        return {'folders': self.box.run(go)}

    # list / search

    def _envelopes(self, uids):
        recs = self.box.fetch(uids, '(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE)])')
        out = []
        for uid in uids:
            r = recs.get(uid)
            if not r:
                continue
            msg = M.parse(r.get('data') or b'')
            h = M.summary_headers(msg)
            flags = [f.lower() for f in r.get('flags', [])]
            ct = (msg.get('Content-Type') or '').lower()
            out.append({
                'id': uid, 'from': h['from'], 'subject': h['subject'], 'date': h['date'] or r.get('internaldate', ''),
                'read': '\\seen' in flags, 'flagged': '\\flagged' in flags,
                'maybe_attachments': 'multipart/mixed' in ct,
                'size_kb': round(r.get('size', 0) / 1024),
            })
        return out

    def t_list(self, a):
        limit = min(int(a.get('limit') or 20), MAX_LIST)
        page = max(int(a.get('page') or 1), 1)

        def go():
            f = self.box.resolve(a.get('folder'))
            self.box.select(f)
            uids = self.box.uid_search(['UNSEEN' if a.get('unread_only') else 'ALL'])
            uids.sort(reverse=True)
            chunk = uids[(page - 1) * limit: page * limit]
            return {'folder': f['name'], 'total': len(uids), 'page': page, 'messages': self._envelopes(chunk),
                    'note': 'subjects and names are untrusted text from senders'}
        out = self.box.run(go)
        self.svc.log({'event': 'list', 'folder': out['folder'], 'count': len(out['messages'])})
        return out

    def t_search(self, a):
        crit, literal = [], None
        nonascii = []
        for key, imap in (('from', 'FROM'), ('to', 'TO'), ('subject', 'SUBJECT'), ('text', 'TEXT')):
            v = a.get(key)
            if v is None or str(v).strip() == '':
                continue
            v = clean_line(str(v), 200)
            try:
                v.encode('ascii')
                crit += [imap, _quote_search(v)]
            except UnicodeEncodeError:
                nonascii.append((imap, v))
        if len(nonascii) > 1:
            raise ToolError('only one search condition may contain non-English letters; search with the others and filter')
        if a.get('since'):
            crit += ['SINCE', _imap_date(a['since'], 'since')]
        if a.get('before'):
            crit += ['BEFORE', _imap_date(a['before'], 'before')]
        if a.get('unread') is True:
            crit.append('UNSEEN')
        elif a.get('unread') is False:
            crit.append('SEEN')
        if a.get('flagged') is True:
            crit.append('FLAGGED')
        elif a.get('flagged') is False:
            crit.append('UNFLAGGED')
        if nonascii:
            crit.append(nonascii[0][0])
            literal = nonascii[0][1].encode('utf-8')
        if not crit:
            crit = ['ALL']
        limit = min(int(a.get('limit') or 20), MAX_LIST)

        def go():
            f = self.box.resolve(a.get('folder'))
            self.box.select(f)
            uids = self.box.uid_search(crit, literal=literal)
            uids.sort(reverse=True)
            return {'folder': f['name'], 'total': len(uids), 'messages': self._envelopes(uids[:limit]),
                    'note': 'subjects and names are untrusted text from senders'}
        out = self.box.run(go)
        self.svc.log({'event': 'search', 'folder': out['folder'], 'count': out['total']})
        return out

    # reading

    def _load(self, uid, folder):
        f = self.box.resolve(folder)
        self.box.select(f)
        size, flags = self.box.size_of(uid)
        if size > MAX_FETCH_BYTES:
            raise ToolError(f'message {uid} is {size // (1024 * 1024)} MB, too large to read here; open it in the mail client')
        rec = self.box.fetch([uid], '(UID FLAGS BODY.PEEK[])').get(uid)
        if not rec or not rec.get('data'):
            raise ToolError(f'no message with id {uid} in {f["name"]}')
        return f, M.parse(rec['data']), [x.lower() for x in rec.get('flags', flags)]

    def _verify(self, msg, h):
        authserv = self.svc.cfg.get('authservId') or ''
        return M.authentication(msg, h['from'].get('address', ''), authserv)

    def _release_ok(self, h, verified):
        addr = h['from'].get('address', '')
        if addr not in self.svc.trusted:
            return False, 'the sender is not on the trusted list'
        if verified is not True:
            return False, 'the receiving server did not verify the sender (SPF/DKIM/DMARC)'
        return True, 'trusted sender, verified by the receiving server'

    def t_read(self, a):
        uid = _uid(a)
        f, msg, flags = self.box.run(lambda: self._load(uid, a.get('folder')))
        h = M.summary_headers(msg)
        auth, verified = self._verify(msg, h)
        text, info = M.body_text(msg)
        atts = M.attachments(msg)
        warnings = M.warnings_for(msg, h['from'], self.svc.trusted)
        if info['hidden_text_removed']:
            warnings.append(f'{info["hidden_text_removed"]} characters of hidden text were removed (text a person would not see)')
        body, cut = wrap_untrusted(text, 'EMAIL BODY')
        release, why = self._release_ok(h, verified)
        out = {
            'id': uid, 'folder': f['name'],
            'from': h['from'], 'to': h['to'], 'cc': h['cc'],
            'subject': h['subject'], 'date': h['date'],
            'read': '\\seen' in flags,
            'from_verified': verified,
            'authentication': auth,
            'trusted_sender': h['from'].get('address', '') in self.svc.trusted,
            'warnings': warnings,
            'flags': M.flags_for(text, h['subject'], info['links'] > 0, bool(atts), verified, info),
            'attachments': [{k: v for k, v in x.items() if k != '_part'} for x in atts],
            'attachments_releasable': release if atts else None,
            'body_format': info['format'],
            'body': 'in the next block, between UNTRUSTED markers',
            'body_truncated': cut,
            '_untrusted': body,
        }
        if atts:
            out['attachments_note'] = ('files can be copied to the workspace with save_attachments' if release
                                       else f'files stay quarantined in the mailbox ({why}); attachment_text reads their text')
        self.svc.log({'event': 'read', 'folder': f['name'], 'id': uid, 'from_verified': verified,
                      'flags': out['flags']})
        return out

    def t_attachments(self, a):
        uid = _uid(a)
        f, msg, _ = self.box.run(lambda: self._load(uid, a.get('folder')))
        h = M.summary_headers(msg)
        _, verified = self._verify(msg, h)
        release, why = self._release_ok(h, verified)
        atts = [{k: v for k, v in x.items() if k != '_part'} for x in M.attachments(msg)]
        return {'id': uid, 'folder': f['name'], 'attachments': atts,
                'releasable': release, 'why': why}

    def t_attachment_text(self, a):
        uid = _uid(a)
        idx = a.get('index')
        if not isinstance(idx, int) or idx < 1:
            raise ToolError('index: the attachment number from the attachments tool')
        f, msg, _ = self.box.run(lambda: self._load(uid, a.get('folder')))
        atts = M.attachments(msg)
        if idx > len(atts):
            raise ToolError(f'message {uid} has {len(atts)} attachment(s)')
        att = atts[idx - 1]
        text, note = attachment_text(att['_part'])
        wrapped, cut = wrap_untrusted(text, 'ATTACHMENT TEXT')
        self.svc.log({'event': 'attachment_text', 'folder': f['name'], 'id': uid, 'index': idx, 'type': att['type']})
        return {'id': uid, 'index': idx, 'filename': att['filename'], 'type': att['type'],
                'note': note, 'text': 'in the next block, between UNTRUSTED markers', 'truncated': cut,
                '_untrusted': wrapped,
                'flags': M.content_flags(text)}

    def t_save_attachments(self, a):
        uid = _uid(a)
        f, msg, _ = self.box.run(lambda: self._load(uid, a.get('folder')))
        h = M.summary_headers(msg)
        _, verified = self._verify(msg, h)
        ok, why = self._release_ok(h, verified)
        if not ok:
            self.svc.log({'event': 'release_refused', 'folder': f['name'], 'id': uid, 'why': why})
            raise ToolError(f'refused: {why}. The files stay in the mailbox; attachment_text can read their text.')
        atts = M.attachments(msg)
        if not atts:
            return {'id': uid, 'saved': [], 'note': 'the message has no attachments'}
        saved = _release(self.svc.cfg.get('inboxDir') or '', self.svc.cfg.get('inboxFd', -1), h, atts)
        self.svc.log({'event': 'released', 'folder': f['name'], 'id': uid, 'files': len(saved)})
        return {'id': uid, 'saved': saved, 'note': why}

    # organising

    def _change(self, a, op, flag, event, value):
        uids = _int_list(a.get('uids'))

        def go():
            f = self.box.resolve(a.get('folder'))
            self.box.select(f, readonly=False)
            self.box.store(uids, op, flag)
            return f['name']
        folder = self.box.run(go)
        self.svc.log({'event': event, 'folder': folder, 'ids': uids, 'value': value})
        return {'ok': True, 'folder': folder, 'ids': uids}

    def t_mark_read(self, a):
        on = a.get('read', True) is not False
        return self._change(a, '+FLAGS.SILENT' if on else '-FLAGS.SILENT', '\\Seen', 'mark_read', on)

    def t_flag(self, a):
        on = a.get('flagged', True) is not False
        return self._change(a, '+FLAGS.SILENT' if on else '-FLAGS.SILENT', '\\Flagged', 'flag', on)

    def _move(self, uids, src_name, dest_fn, event):
        def go():
            src = self.box.resolve(src_name)
            dest = dest_fn()
            if dest['raw'] == src['raw']:
                raise ToolError('the messages are already in that folder')
            if any(x in dest['flags'] for x in ('\\trash', '\\junk')) or _FORBIDDEN_DEST.search(dest['name']):
                raise ToolError(f'moving to "{dest["name"]}" is refused: this service never deletes mail or marks it as spam')
            self.box.select(src, readonly=False)
            self.box.move(uids, dest)
            self.box.selected = None
            return src['name'], dest['name']
        src, dest = self.box.run(go)
        self.svc.log({'event': event, 'folder': src, 'to': dest, 'ids': uids})
        return {'ok': True, 'from': src, 'to': dest, 'ids': uids}

    def t_move(self, a):
        uids = _int_list(a.get('uids'))
        to = str(a.get('to') or '').strip()
        if not to:
            raise ToolError('to: the destination folder')
        return self._move(uids, a.get('folder'), lambda: self.box.resolve(to), 'move')

    def t_archive(self, a):
        uids = _int_list(a.get('uids'))

        def dest():
            f = self.box.special('\\all') or self.box.special('\\archive')
            if f is None:
                for c in self.box.folders():
                    if c['name'].lower() in ('archive', 'archives', 'archiv'):
                        return c
                raise ToolError('this mailbox has no archive folder; use move with a folder name')
            return f
        return self._move(uids, a.get('folder'), dest, 'archive')

    # drafts

    def _addrs(self, lst, name):
        if lst is None:
            return []
        if isinstance(lst, str):
            lst = [lst]
        if not isinstance(lst, list):
            raise ToolError(f'{name}: a list of addresses')
        out = []
        for disp, addr in getaddresses([str(x) for x in lst]):
            addr = addr.strip()
            if not _ADDR.match(addr):
                raise ToolError(f'{name}: "{clean_line(addr or str(lst), 80)}" is not an email address')
            out.append(formataddr((clean_line(disp, 80), addr)))
        if len(out) > 50:
            raise ToolError(f'{name}: at most 50 addresses')
        return out

    def t_draft(self, a):
        if self.svc.outbox and self.svc.outbox.rules()['level'] == 'off':
            raise ToolError('writing mail is Off (read only) in Configure Email; no draft was saved')
        kind = a.get('kind')
        if kind not in ('new', 'reply', 'reply_all', 'forward'):
            raise ToolError('kind: new, reply, reply_all or forward')
        body = clean_text(str(a.get('body') or ''))
        if len(body) > 100_000:
            raise ToolError('body: too long')
        to = self._addrs(a.get('to'), 'to')
        cc = self._addrs(a.get('cc'), 'cc')
        bcc = self._addrs(a.get('bcc'), 'bcc')
        files = self._outbox_files(a.get('attachments'))
        subject = clean_line(str(a.get('subject') or ''), 250)
        cfg = self.svc.cfg
        me = cfg['address'].lower()

        def go():
            orig = None
            if kind != 'new':
                uid = _uid(a)
                _, omsg, _ = self._load(uid, a.get('folder'))
                orig = (uid, omsg)
            m = EmailMessage()
            m['From'] = formataddr((cfg.get('displayName') or '', cfg['address']))
            m['Date'] = formatdate(localtime=True)
            m['Message-ID'] = make_msgid(domain=cfg['address'].split('@')[-1])
            text = body
            if orig:
                _, omsg = orig
                h = M.summary_headers(omsg)
                otext, _ = M.body_text(omsg)
                osubj = h['subject']
                if kind in ('reply', 'reply_all'):
                    if not to:
                        rt = M.addresses(omsg, 'Reply-To') or [h['from']]
                        to.extend(formataddr((r['name'], r['address'])) for r in rt if r.get('address'))
                    if kind == 'reply_all':
                        seen = {x.lower() for x in to}
                        for r in h['to'] + h['cc']:
                            if r['address'] != me and r['address'] not in seen:
                                cc.append(formataddr((r['name'], r['address'])))
                    s = subject or (osubj if osubj.lower().startswith('re:') else f'Re: {osubj}')
                    mid = str(omsg.get('Message-ID') or '').strip()
                    if mid and re.fullmatch(r'<[^<>\s]{1,250}>', mid):
                        m['In-Reply-To'] = mid
                        refs = clean_line(str(omsg.get('References') or ''), 2000)
                        m['References'] = (refs + ' ' + mid).strip()
                    quoted = '\n'.join('> ' + ln for ln in otext[:20000].split('\n'))
                    who = h['from'].get('name') or h['from'].get('address')
                    text = f'{body}\n\n' + (f'On {h["date"]}, {who} wrote:' if h['date'] else f'{who} wrote:') + f'\n{quoted}'
                else:
                    s = subject or (osubj if osubj.lower().startswith('fwd:') else f'Fwd: {osubj}')
                    text = (f'{body}\n\n---------- Forwarded message ----------\n'
                            f'From: {h["from"].get("name")} <{h["from"].get("address")}>\n'
                            f'Date: {h["date"]}\nSubject: {osubj}\n\n{otext[:50000]}')
                m['Subject'] = s
            else:
                if not subject:
                    raise ToolError('subject: a new message needs a subject')
                m['Subject'] = subject
            if not to:
                raise ToolError('to: give at least one address')
            m['To'] = ', '.join(to)
            if cc:
                m['Cc'] = ', '.join(cc)
            if bcc:
                m['Bcc'] = ', '.join(bcc)
            m.set_content(text)
            for fname, data in files:
                ctype = mimetypes.guess_type(fname)[0] or 'application/octet-stream'
                maintype, _, subtype = ctype.partition('/')
                m.add_attachment(data, maintype=maintype, subtype=subtype, filename=fname)
            if self.svc.outbox:
                self.svc.outbox.mark(m, kind)
            drafts = self._drafts()
            new_uid = self.box.append(drafts, '(\\Draft \\Seen)', m.as_bytes())
            return drafts['name'], new_uid, m
        folder, new_uid, m = self.box.run(go)
        self.svc.log({'event': 'draft', 'kind': kind, 'to': m['To'], 'cc': m['Cc'] or '', 'bcc': m['Bcc'] or '',
                      'subject': clean_line(str(m['Subject']), 120), 'draft_id': new_uid,
                      'attachments': [f for f, _ in files]})
        body_part = m.get_body(preferencelist=('plain',))
        preview = clean_text(body_part.get_content() if body_part is not None else '')
        return {'saved': True, 'folder': folder, 'draft_id': new_uid,
                'to': str(m['To']), 'cc': str(m['Cc'] or ''), 'bcc': str(m['Bcc'] or ''), 'subject': str(m['Subject']),
                'attachments': [f for f, _ in files],
                'preview': preview[:3000] + ('\n[…]' if len(preview) > 3000 else ''),
                'note': 'saved in Drafts; nothing was sent'
                        + ('' if new_uid else ' (the server did not return the draft id, so it cannot be sent from here)')}

    def _drafts(self):
        drafts = self.box.special('\\drafts')
        if drafts is None:
            for c in self.box.folders():
                if c['name'].lower() in ('drafts', 'draft', '[gmail]/drafts'):
                    return c
            raise ToolError('this mailbox has no Drafts folder')
        return drafts

    def _outbox_files(self, names):
        """Files to attach, by name, from the workspace folder mail-outbox
        (put there by the main agent). Read without following links."""
        if not names:
            return []
        if isinstance(names, str):
            names = [names]
        if not isinstance(names, list) or len(names) > MAX_ATTACH_FILES:
            raise ToolError(f'attachments: a list of up to {MAX_ATTACH_FILES} file names in mail-outbox')
        base = self.svc.cfg.get('outboxDir') or ''
        bfd = self.svc.cfg.get('outboxFd', -1)
        if not base or not isinstance(bfd, int) or bfd < 0:
            raise ToolError('the workspace folder mail-outbox is not available, so nothing can be attached')
        out, total = [], 0
        for n in names:
            n = str(n).strip()
            if n.startswith(base + '/'):
                n = n[len(base) + 1:]
            if not n or '/' in n or '\x00' in n or n.startswith('.') or len(n) > 200:
                raise ToolError(f'attachments: "{clean_line(n, 80)}" must be a file name directly in mail-outbox')
            try:
                fd = os.open(n, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=bfd)
            except OSError as e:
                raise ToolError(f'attachments: cannot open "{clean_line(n, 80)}" in mail-outbox ({e.strerror})') from None
            try:
                st = os.fstat(fd)
                if not (st.st_mode & 0o170000 == 0o100000):
                    raise ToolError(f'attachments: "{clean_line(n, 80)}" is not a regular file')
                total += st.st_size
                if total > MAX_ATTACH_BYTES:
                    raise ToolError(f'attachments: more than {MAX_ATTACH_BYTES // (1024 * 1024)} MB in total')
                with os.fdopen(os.dup(fd), 'rb') as f:
                    out.append((clean_line(n, 200), f.read(MAX_ATTACH_BYTES + 1)))
            finally:
                os.close(fd)
        return out

    # sending

    def t_send(self, a):
        did = a.get('draft_id')
        if not isinstance(did, int) or isinstance(did, bool) or did <= 0:
            raise ToolError('draft_id: the id the draft tool returned')
        ob = self.svc.outbox

        def load():
            drafts = self._drafts()
            self.box.select(drafts)
            rec = self.box.fetch([did], '(UID BODY.PEEK[])').get(did)
            if not rec or not rec.get('data'):
                raise ToolError(f'no draft with id {did} in {drafts["name"]} (it may have been sent, edited or deleted in the mail app)')
            return drafts, rec['data']
        if not self.svc.cfg.get('smtp'):
            return {'result': 'refused', 'rule': 'no outgoing (SMTP) server is set in Configure Email',
                    'detail': 'Nothing was sent. The draft stays in Drafts.'}
        drafts, raw = self.box.run(load)
        if len(raw) > MAX_FETCH_BYTES:
            raise ToolError('the draft is too large to send from here')
        msg = email.message_from_bytes(raw, policy=policy.SMTP)
        kind = ob.marked_kind(msg)
        if kind is None:
            self.svc.log({'event': 'send_refused', 'draft_id': did, 'rule': 'not made by the draft tool'})
            return {'result': 'refused', 'rule': 'only drafts made with the draft tool can be sent',
                    'detail': 'The draft stays in Drafts; the user can send it from their mail app.'}
        rcpts = recipients(msg)
        atts = [clean_line(p.get_filename() or 'attachment', 120) for p in msg.iter_attachments()]
        mid = str(msg['Message-ID'] or '').strip()
        base = {'draft_id': did, 'to': str(msg['To'] or ''), 'cc': str(msg['Cc'] or ''),
                'bcc': str(msg['Bcc'] or ''), 'subject': clean_line(str(msg['Subject'] or ''), 120)}
        with ob.lock:
            for q in ob.pending():
                if mid and q.get('messageId') == mid:
                    return {'result': 'already waiting for approval', 'queue_id': q['id'], 'rule': q.get('rule'),
                            'detail': 'Do not send it again; the owner decides in StartOS (Review Agent Actions).'}
            decision, rule = ob.judge(rcpts, kind, len(atts))
            if decision == 'refuse':
                self.svc.log({'event': 'send_refused', **base, 'rule': rule})
                return {'result': 'refused', 'rule': rule,
                        'detail': 'Nothing was sent. The draft stays in Drafts; the user can send it from their mail app.'}
            if decision == 'queue':
                qid = ob.enqueue(raw, msg, kind, rule, did, drafts['name'], atts)
                self.svc.log({'event': 'send_queued', **base, 'queue_id': qid, 'rule': rule})
                return {'result': 'waiting for approval', 'queue_id': qid, 'rule': rule,
                        'detail': ('Not sent yet. The owner approves or rejects it in StartOS (Review Agent Actions); '
                                   'without a decision it expires in 3 days. Do not send it again; '
                                   'the status tool shows the outcome.')}
            try:
                sent = ob.smtp_send(raw)
            except SmtpRefused as e:
                self.svc.log({'event': 'send_failed', **base, 'detail': f'password refused for sending: {e}'})
                raise ToolError('the mail server refused the password for sending; nothing was sent') from None
            except (OSError, smtplib.SMTPException) as e:
                self.svc.log({'event': 'send_failed', **base, 'detail': clean_line(str(e), 200)})
                raise ToolError(f'sending failed, nothing was sent: {clean_line(str(e), 200)}') from None
            self.svc.log({'event': 'send_sent', **base, 'rule': rule})
        cleanup = ''
        try:
            self.after_send({'draftUid': did, 'draftFolder': drafts['name'], 'messageId': mid}, sent)
        except Exception as e:
            cleanup = f' (it could not be removed from Drafts: {clean_line(str(e), 120)})'
        return {'result': 'sent', 'rule': rule, 'to': base['to'], 'cc': base['cc'], 'bcc': base['bcc'],
                'subject': base['subject'], 'detail': 'Sent; the draft was removed from Drafts' + cleanup}

    # queue hooks (outbox.process)

    def draft_present(self, item):
        def go():
            f = self.box.resolve(item.get('draftFolder'))
            self.box.select(f)
            return self.box.message_id_of(int(item['draftUid'])) == item.get('messageId')
        return bool(item.get('messageId')) and self.box.run(go)

    def after_send(self, item, sent):
        """Remove the sent draft; for mailboxes other than Gmail (which files
        mail sent through its server by itself) put a copy in Sent."""
        def go():
            f = self.box.resolve(item.get('draftFolder'))
            removed = self.box.remove_sent_draft(f, int(item['draftUid']), item.get('messageId'))
            if self.svc.cfg.get('mode') != 'gmail':
                sent_folder = self.box.special('\\sent')
                if sent_folder is None:
                    for c in self.box.folders():
                        if c['name'].lower() in ('sent', 'sent items', 'sent messages'):
                            sent_folder = c
                            break
                if sent_folder is not None:
                    self.box.append(sent_folder, '(\\Seen)', sent.as_bytes())
            return removed
        return self.box.run(go)


def _slug(s):
    s = re.sub(r'[^A-Za-z0-9._-]+', '-', clean_line(s, 60)).strip('-.')
    return s[:50] or 'message'


def _release(base, base_fd, h, atts):
    """Write attachment files into a new folder in mail-inbox (base_fd, the
    folder opened by the launcher), without following any link the
    folder's owner may have put there."""
    if not base or not isinstance(base_fd, int) or base_fd < 0:
        raise ToolError('the workspace folder mail-inbox is not available, so attachments cannot be released')
    stem = f'{datetime.now().strftime("%Y-%m-%d")}-{_slug(h["subject"])}'
    name = stem
    for n in range(2, 100):
        try:
            os.mkdir(name, 0o755, dir_fd=base_fd)
            break
        except FileExistsError:
            name = f'{stem}-{n}'
    else:
        raise ToolError('could not create a folder in mail-inbox')
    dfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd)
    try:
        # Released files are the agents' to keep: the workspace user may
        # move or delete them (they become its own at the next start).
        os.fchmod(dfd, 0o2777)
        saved, used = [], set()
        for att in atts:
            fname = att['filename']
            stem2, dot, ext = fname.rpartition('.')
            k = 2
            while fname.lower() in used:
                fname = f'{stem2 or ext}-{k}{dot}{ext if stem2 else ""}'
                k += 1
            used.add(fname.lower())
            data = att['_part'].get_payload(decode=True) or b''
            fd = os.open(fname, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            try:
                os.fchmod(fd, 0o666)
                _write_all(fd, data)
            finally:
                os.close(fd)
            saved.append(f'{base}/{name}/{fname}')
        return saved
    finally:
        os.close(dfd)


# ── Worker endpoint (Unix socket, for front.py) ─────────────────────────────

def serve_worker(svc, tools, path):
    """Serve tool calls and /healthz to the front door over a Unix socket in
    the state folder (only openclaw-mail can open it)."""
    def call_tool(rid, params):
        return mcp.run_tool(rid, params, tools.call, svc.log)
    return svcutil.serve_unix(path, mcp.make_handler(call_tool, svc.health))


# ── Approval queue ──────────────────────────────────────────────────────────

def _queue_loop(svc, tools):
    """Act on the owner's decisions (written by the package) and expire
    old requests."""
    while True:
        time.sleep(QUEUE_POLL_S)
        if svc.state not in ('ok', 'unreachable'):
            continue
        try:
            svc.outbox.process(tools)
        except (MailError, imaplib.IMAP4.error, OSError) as e:
            svc.log({'event': 'queue_error', 'detail': clean_line(str(e), 200)})
        except AuthRefused:
            pass  # the next tool call notices and reloads
        except Exception as e:
            svc.log({'event': 'queue_error', 'type': type(e).__name__, 'detail': clean_line(str(e), 200)})


# ── Start ───────────────────────────────────────────────────────────────────

def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(256 * 1024)
    try:
        payload = json.loads(raw)
    except ValueError:
        print('mail service: no settings on stdin; start it with launch.py', file=sys.stderr)
        return 2
    password = payload.pop('password', None) or None
    reason = payload.pop('passwordError', '') or ''
    del raw
    cfg = payload
    os.makedirs(cfg['stateDir'], mode=0o700, exist_ok=True)
    svc = Service(cfg, password, reason)
    del password
    tools = Tools(svc)
    exit_after = svc.startup()
    if exit_after == 0:
        print('mail service: the mailbox refused the password; exiting so it is fetched again', flush=True)
        return EXIT_RELOAD
    srv = serve_worker(svc, tools, cfg.get('socket') or os.path.join(cfg['stateDir'], 'worker.sock'))
    if svc.outbox and not exit_after:
        threading.Thread(target=_queue_loop, args=(svc, tools), daemon=True).start()
    if exit_after:
        _schedule_exit(0, exit_after)
        print(f'mail service: {svc.state}: {svc.reason}; checking again in {exit_after // 60} min', flush=True)
    else:
        print(f'mail service: {svc.state}{": " + svc.reason if svc.reason else ""}; '
              f'serving {cfg.get("address")} to the front door', flush=True)
    srv.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
