"""Sending: the rules, the approval queue and SMTP.

Every send request is judged here, on all recipients (To, Cc, Bcc), by the
rules the owner set in Configure Email (rules.json, written by the package
as root; this service can read it, not change it):

- level off or drafts: refused.
- any recipient on "Never send to": refused.
- a forward, any attachment, too many recipients, or over the hourly or
  daily limit: held for approval.
- every recipient on "Send automatically to": sent.
- anyone else: per "Anyone else" (ask: held; block: refused; auto: sent).

Held messages wait in the service's approval queue (approvals.py, shared
with the package's other services: state/queue/, which only this user can
write) with the exact bytes that will be sent. The owner decides in StartOS
(Review Agent Actions); the package writes the decision into decisions/,
which only root can write. Undecided messages expire after 3 days.
"""

import base64
import email
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
from email import policy
from email.utils import getaddresses

from approvals import ApprovalQueue
from sanitize import clean_line, clean_text

EXPIRE_S = 3 * 24 * 3600
MARKER = 'X-OpenClaw-Draft'
DEFAULT_RULES = {
    'level': 'drafts', 'autoTo': [], 'neverTo': [], 'others': 'ask',
    'perHour': 10, 'perDay': 30, 'maxRecipients': 10,
}


class SmtpRefused(Exception):
    """The SMTP server refused the password (535)."""


def _norm(addr):
    return (addr or '').strip().lower()


def matches(addr, entries):
    """Exact address, or "@domain" for that domain only (no subdomains)."""
    addr = _norm(addr)
    dom = addr.rsplit('@', 1)[-1] if '@' in addr else ''
    for e in entries:
        e = _norm(e)
        if not e:
            continue
        if e.startswith('@'):
            if dom and dom == e[1:]:
                return True
        elif addr == e:
            return True
    return False


def _short(s, n):
    t = ' '.join(str(s or '').split())
    return t[:n - 1] + '…' if len(t) > n else t


def recipients(msg):
    vals = []
    for h in ('To', 'Cc', 'Bcc'):
        vals += [str(v) for v in (msg.get_all(h) or []) if str(v).strip()]
    return [_norm(a) for _, a in getaddresses(vals) if a.strip()]


class Outbox:
    def __init__(self, svc, cfg, password):
        self.svc = svc
        self.cfg = cfg
        self._password = password
        st = cfg['stateDir']
        self.sent_path = os.path.join(st, 'sent.jsonl')
        self.rules_path = cfg.get('rulesPath') or ''
        self.q = ApprovalQueue(st, cfg.get('decisionsDir'), EXPIRE_S)
        self._key = self._draft_key()
        self.lock = threading.RLock()
        self._failures = {}

    # ── rules ───────────────────────────────────────────────────────────────

    def rules(self):
        """The owner's rules. Unreadable or missing: drafts only (safe)."""
        try:
            with open(self.rules_path) as f:
                r = json.load(f)
        except (OSError, ValueError):
            return dict(DEFAULT_RULES)
        out = dict(DEFAULT_RULES)
        if r.get('level') in ('off', 'drafts', 'rules'):
            out['level'] = r['level']
        if r.get('others') in ('ask', 'block', 'auto'):
            out['others'] = r['others']
        for k in ('autoTo', 'neverTo'):
            if isinstance(r.get(k), list):
                out[k] = [str(x) for x in r[k] if str(x).strip()]
        for k in ('perHour', 'perDay', 'maxRecipients'):
            try:
                out[k] = max(1, int(r.get(k, out[k])))
            except (TypeError, ValueError):
                pass
        return out

    def level_text(self, r=None):
        r = r or self.rules()
        return {'off': 'Off (read only)', 'drafts': 'Drafts only',
                'rules': 'Send by rules'}[r['level']]

    def _sent_counts(self, now):
        hour = day = 0
        try:
            with open(self.sent_path) as f:
                for line in f:
                    try:
                        t = json.loads(line).get('t', 0)
                    except ValueError:
                        continue
                    if now - t < 3600:
                        hour += 1
                    if now - t < 86400:
                        day += 1
        except OSError:
            pass
        return hour, day

    def judge(self, rcpts, kind, n_attachments, now=None):
        """('send' | 'queue' | 'refuse', rule text)."""
        r = self.rules()
        now = now or time.time()
        if r['level'] == 'off':
            return 'refuse', 'Mail sending is Off (read only)'
        if r['level'] == 'drafts':
            return 'refuse', 'Mail sending is Drafts only'
        if not rcpts:
            return 'refuse', 'the draft has no recipients'
        never = [a for a in rcpts if matches(a, r['neverTo'])]
        if never:
            return 'refuse', f'Never send to: {", ".join(never)}'
        if kind == 'forward':
            return 'queue', 'forwards always need approval'
        if n_attachments:
            return 'queue', 'attachments always need approval'
        if len(rcpts) > r['maxRecipients']:
            return 'queue', f'more than {r["maxRecipients"]} recipients'
        hour, day = self._sent_counts(now)
        if hour >= r['perHour']:
            return 'queue', f'more than {r["perHour"]} sent in the last hour'
        if day >= r['perDay']:
            return 'queue', f'more than {r["perDay"]} sent today'
        others = [a for a in rcpts if not matches(a, r['autoTo'])]
        if not others:
            return 'send', 'all recipients on Send automatically to'
        if r['others'] == 'block':
            return 'refuse', f'Anyone else: Block ({", ".join(others)})'
        if r['others'] == 'auto':
            return 'send', 'Anyone else: Send automatically'
        return 'queue', f'Anyone else: Ask me ({", ".join(others)})'

    # ── draft marker ────────────────────────────────────────────────────────

    def _draft_key(self):
        p = os.path.join(self.cfg['stateDir'], 'draftkey')
        try:
            with open(p, 'rb') as f:
                k = f.read()
            if len(k) == 32:
                return k
        except OSError:
            pass
        k = secrets.token_bytes(32)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, k)
        finally:
            os.close(fd)
        return k

    def mark(self, msg, kind):
        """Mark a draft as made here, with its kind (new/reply/forward)."""
        mid = str(msg['Message-ID'] or '')
        sig = hmac.new(self._key, f'{kind}|{mid}'.encode(), hashlib.sha256).hexdigest()[:32]
        msg[MARKER] = f'{kind}; {sig}'

    def marked_kind(self, msg):
        """The kind of a draft made here, or None (a draft from elsewhere)."""
        v = str(msg.get(MARKER) or '')
        m = re.fullmatch(r'\s*(new|reply|reply_all|forward);\s*([0-9a-f]{32})\s*', v)
        if not m:
            return None
        mid = str(msg['Message-ID'] or '')
        want = hmac.new(self._key, f'{m.group(1)}|{mid}'.encode(), hashlib.sha256).hexdigest()[:32]
        return m.group(1) if hmac.compare_digest(want, m.group(2)) else None

    # ── SMTP ────────────────────────────────────────────────────────────────

    def smtp_send(self, raw):
        """Send raw message bytes; returns the message as sent (marker removed).
        Raises SmtpRefused, OSError or SMTPException."""
        msg = email.message_from_bytes(raw, policy=policy.SMTP)
        del msg[MARKER]
        for h in list(msg.keys()):
            if h.lower().startswith('resent-'):
                del msg[h]
        rcpts = recipients(msg)
        if not rcpts:
            raise smtplib.SMTPException('no recipients')
        smtp = self.cfg['smtp']
        ctx = ssl.create_default_context()
        if smtp.get('security', 'tls') == 'tls':
            s = smtplib.SMTP_SSL(smtp['host'], int(smtp['port']), context=ctx, timeout=60)
        else:
            s = smtplib.SMTP(smtp['host'], int(smtp['port']), timeout=60)
            s.starttls(context=ctx)
        try:
            try:
                s.login(self.cfg['login'], self._password)
            except smtplib.SMTPAuthenticationError as e:
                err = e.smtp_error.decode('utf-8', 'replace') if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
                raise SmtpRefused(f'{e.smtp_code} {clean_line(err, 150)}') from None
            # Exactly the recipients judged by the rules. send_message
            # leaves Bcc out of what is transmitted.
            s.send_message(msg, from_addr=self.cfg['address'], to_addrs=rcpts)
        finally:
            try:
                s.quit()
            except Exception:
                pass
        self._record_sent()
        return msg

    def _record_sent(self):
        with open(self.sent_path, 'a') as f:
            f.write(json.dumps({'t': time.time()}) + '\n')

    # ── queue ───────────────────────────────────────────────────────────────

    def enqueue(self, raw, msg, kind, rule, draft_uid, draft_folder, attachment_names):
        qid = self.q.new_id()
        body = ''
        try:
            part = msg.get_body(preferencelist=('plain',))
            body = part.get_content() if part is not None else ''
        except Exception:
            pass
        to, cc, bcc = (str(msg[h] or '') for h in ('To', 'Cc', 'Bcc'))
        subject = clean_line(str(msg['Subject'] or ''), 200)
        opening = clean_text(body)[:600]
        rcpts = sorted(set(recipients(msg)))
        item = {
            'id': qid, 'action': 'send', 'rule': rule, 'requester': 'email agent',
            # What Review Agent Actions shows.
            'summary': f'Email to {_short(", ".join(rcpts) or to, 60)}: {_short(subject, 50) or "(no subject)"}',
            'details': [
                f'To: {to or "—"}',
                *([f'Cc: {cc}'] if cc else []),
                *([f'Bcc: {bcc}'] if bcc else []),
                f'Subject: {subject or "(none)"}',
                f'Kind: {"forward" if kind == "forward" else "reply" if kind.startswith("reply") else "new message"}',
                f'Attachments: {", ".join(attachment_names) if attachment_names else "none"}',
                f'Opening lines: {_short(opening, 400) or "(empty)"}',
            ],
            'recipients': rcpts,
            # The mail service's own.
            'kind': kind, 'draftUid': draft_uid, 'draftFolder': draft_folder,
            'messageId': str(msg['Message-ID'] or '').strip(),
            'from': str(msg['From'] or ''), 'to': to, 'cc': cc, 'bcc': bcc,
            'subject': subject, 'opening': opening, 'attachments': attachment_names,
            'raw': base64.b64encode(raw).decode(),
        }
        return self.q.add(item)

    def pending(self):
        return self.q.pending()

    def _result(self, item, outcome, detail=''):
        self.q.resolve(item, outcome, detail, to=item.get('to'), subject=item.get('subject'))
        self.svc.log({'event': f'send_{outcome}', 'queue_id': item['id'], 'to': item.get('to'),
                      'cc': item.get('cc'), 'bcc': item.get('bcc'), 'subject': item.get('subject'),
                      'detail': detail})

    def results(self, limit=10):
        return self.q.results(limit)

    def decision(self, qid):
        return self.q.decision(qid)

    def process(self, hooks):
        """Act on owner decisions and expire old items. hooks.draft_present(item)
        tells whether the draft is still in Drafts unchanged; hooks.after_send(item,
        msg) removes it and files the sent copy."""
        with self.lock:
            now = time.time()
            for item in self.pending():
                d = self.decision(item['id'])
                if d == 'reject':
                    self._result(item, 'rejected', 'rejected in Review Agent Actions')
                elif d == 'approve':
                    self._approved(item, hooks, now)
                elif now > item.get('expires', 0):
                    self._result(item, 'expired', 'not decided within 3 days; the draft stays in Drafts')

    def _approved(self, item, hooks, now):
        qid = item['id']
        count, next_at = self._failures.get(qid, (0, 0))
        if now < next_at:
            return
        raw = base64.b64decode(item['raw'])
        rcpts = recipients(email.message_from_bytes(raw, policy=policy.SMTP))
        never = [a for a in rcpts if matches(a, self.rules()['neverTo'])]
        if never:
            self._result(item, 'refused', f'Never send to: {", ".join(never)} (changed after the request)')
            return
        if not hooks.draft_present(item):
            self._result(item, 'cancelled', 'the draft was no longer in Drafts as requested (sent, edited or deleted in the mail app)')
            return
        try:
            msg = self.smtp_send(raw)
        except (SmtpRefused, OSError, smtplib.SMTPException) as e:
            count += 1
            detail = clean_line(str(e), 200)
            if count >= 3:
                self._failures.pop(qid, None)
                self._result(item, 'failed', f'sending failed 3 times ({detail}); the draft stays in Drafts')
            else:
                self._failures[qid] = (count, now + 300 * count)
                self.svc.log({'event': 'send_retry', 'queue_id': qid, 'detail': detail})
            return
        self._failures.pop(qid, None)
        self._result(item, 'sent', 'approved in Review Agent Actions')
        try:
            hooks.after_send(item, msg)
        except Exception as e:
            self.svc.log({'event': 'draft_cleanup_failed', 'queue_id': qid, 'type': type(e).__name__,
                          'detail': clean_line(str(e), 200)})
