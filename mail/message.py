"""Parse a raw message into what the email agent may see.

Never returns HTML, raw MIME or attachment bytes. Sender checks come from
the receiving server's Authentication-Results header only (the topmost one,
and for Gmail only the one written by mx.google.com): a sender can put any
header in their own message, but cannot place one above the receiving
server's.
"""

import email
import re
from email import policy
from email.utils import getaddresses, parseaddr

from sanitize import clean_line, clean_text, content_flags, html_to_text

MAX_PARTS = 200


def parse(raw):
    return email.message_from_bytes(raw, policy=policy.default)


def _header(msg, name):
    try:
        v = msg.get(name)
    except Exception:  # undecodable header: fall back to the raw value
        v = msg.get_all(name, failobj=[None])[0] if hasattr(msg, 'get_all') else None
    return clean_line(str(v)) if v is not None else ''


def addresses(msg, name):
    try:
        vals = [str(v) for v in (msg.get_all(name) or [])]
    except Exception:
        vals = []
    out = []
    for disp, addr in getaddresses(vals):
        addr = clean_line(addr, 254).lower()
        if addr:
            out.append({'name': clean_line(disp, 120), 'address': addr})
    return out


def _domain(addr):
    return addr.rsplit('@', 1)[-1].lower().strip('>. ') if '@' in (addr or '') else ''


def _org(domain):
    """Organisational domain, roughly (last two labels; three for co.uk-like)."""
    parts = [p for p in domain.split('.') if p]
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in (
            'co', 'com', 'org', 'net', 'ac', 'gov', 'edu'):
        return '.'.join(parts[-3:])
    return '.'.join(parts[-2:])


def _aligned(d1, d2):
    return bool(d1) and bool(d2) and _org(d1) == _org(d2)


# ── Authentication-Results (RFC 8601) ───────────────────────────────────────

def _auth_header(msg, authserv_id):
    """The receiving server's Authentication-Results value, or None."""
    try:
        vals = [str(v) for v in (msg.get_all('Authentication-Results') or [])]
    except Exception:
        vals = []
    if not vals:
        return None, 'none'
    top = vals[0]
    server = top.split(';', 1)[0].strip().split()[0].lower() if top.strip() else ''
    if authserv_id:
        for v in vals:
            s = v.split(';', 1)[0].strip().split()
            if s and s[0].lower() == authserv_id.lower():
                return v, 'receiving server'
        return None, f'none from {authserv_id}'
    return top, f'topmost header ({server or "unnamed"})'


def _results(value):
    out = {}
    for m in re.finditer(r'\b(spf|dkim|dmarc|arc)\s*=\s*([a-z]+)([^;]*)', value or '', re.I):
        method, res, rest = m.group(1).lower(), m.group(2).lower(), m.group(3)
        props = dict((k.lower(), v.strip('"').lower())
                     for k, v in re.findall(r'([a-z.]+)\s*=\s*("?[^\s;"]+"?)', rest, re.I))
        out.setdefault(method, []).append({'result': res, **props})
    return out


def authentication(msg, from_addr, authserv_id):
    value, source = _auth_header(msg, authserv_id)
    res = _results(value) if value else {}
    fdom = _domain(from_addr)

    def best(method):
        lst = res.get(method) or []
        for r in lst:
            if r['result'] == 'pass':
                return r
        return lst[0] if lst else None

    spf, dkim, dmarc = best('spf'), best('dkim'), best('dmarc')
    verified = 'unknown'
    if value:
        verified = False
        if dmarc and dmarc['result'] == 'pass':
            hf = dmarc.get('header.from', fdom)
            verified = _aligned(hf, fdom)
        elif any(r['result'] == 'pass' and _aligned(r.get('header.d') or _domain(r.get('header.i', '')), fdom)
                 for r in res.get('dkim') or []):
            verified = True
    return {
        'source': source,
        'spf': spf['result'] if spf else 'none',
        'dkim': dkim['result'] if dkim else 'none',
        'dmarc': dmarc['result'] if dmarc else 'none',
    }, verified


# ── Body and attachments ────────────────────────────────────────────────────

def _walk(msg):
    n = 0
    for part in msg.walk():
        n += 1
        if n > MAX_PARTS:
            break
        yield part


def _is_attachment(part):
    if part.is_multipart():
        return False
    disp = (part.get_content_disposition() or '').lower()
    fname = part.get_filename()
    if disp == 'attachment':
        return True
    if fname and part.get_content_maintype() not in ('text',):
        return True
    if fname and disp == 'inline' and part.get_content_type() not in ('text/plain', 'text/html'):
        return True
    return part.get_content_type() == 'message/rfc822'


def safe_filename(name, index):
    name = clean_line(name or '', 120)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', name).strip(' .')
    return name or f'attachment-{index}'


def attachments(msg):
    out = []
    for part in _walk(msg):
        if not _is_attachment(part):
            continue
        try:
            payload = part.get_payload(decode=True) or b''
        except Exception:
            payload = b''
        idx = len(out) + 1
        out.append({
            'index': idx,
            'filename': safe_filename(part.get_filename(), idx),
            'type': part.get_content_type(),
            'size': len(payload),
            '_part': part,
        })
    return out


def _part_text(part):
    try:
        return part.get_content()
    except Exception:
        try:
            raw = part.get_payload(decode=True) or b''
            return raw.decode(part.get_content_charset() or 'utf-8', 'replace')
        except Exception:
            return ''


def body_text(msg):
    """(text, info). Prefers the HTML part (what a person sees in a mail
    client); plain text when there is no HTML."""
    html_part = plain_part = None
    for part in _walk(msg):
        if part.is_multipart() or _is_attachment(part):
            continue
        ct = part.get_content_type()
        if ct == 'text/html' and html_part is None:
            html_part = part
        elif ct == 'text/plain' and plain_part is None:
            plain_part = part
    info = {'hidden_text_removed': 0, 'links': 0, 'format': 'none'}
    if html_part is not None:
        text, hidden, links = html_to_text(_part_text(html_part))
        info.update(hidden_text_removed=hidden, links=links, format='html')
        if not text.strip() and plain_part is not None:
            text = clean_text(_part_text(plain_part))
            info['format'] = 'plain (html part was empty)'
        return text, info
    if plain_part is not None:
        text = clean_text(_part_text(plain_part))
        info['format'] = 'plain'
        info['links'] = len(re.findall(r'https?://', text))
        return text, info
    return '', info


def summary_headers(msg):
    frm = addresses(msg, 'From')
    return {
        'from': frm[0] if frm else {'name': '', 'address': ''},
        'to': addresses(msg, 'To'),
        'cc': addresses(msg, 'Cc'),
        'subject': _header(msg, 'Subject'),
        'date': _header(msg, 'Date'),
    }


def warnings_for(msg, frm, trusted):
    """Sender mismatches a person should know about."""
    warn = []
    faddr = frm.get('address', '')
    fdom = _domain(faddr)
    rt = addresses(msg, 'Reply-To')
    if rt and any(not _aligned(_domain(r['address']), fdom) for r in rt):
        warn.append(f'Reply-To ({", ".join(r["address"] for r in rt)}) is a different domain from From ({faddr})')
    rp = parseaddr(_header(msg, 'Return-Path'))[1].lower()
    if rp and fdom and not _aligned(_domain(rp), fdom):
        warn.append(f'Return-Path ({rp}) is a different domain from From (common for mailing services)')
    name = frm.get('name', '')
    m = re.search(r'[\w.+-]+@[\w-]+(\.[\w-]+)+', name)
    if m and m.group(0).lower() != faddr:
        warn.append(f'the display name shows the address {m.group(0)}, but the mail is from {faddr}')
    for t in trusted:
        local = t.split('@')[0]
        if faddr != t and name and (t in name.lower() or (len(local) > 2 and name.lower().replace(' ', '') == local)):
            warn.append(f'the display name looks like trusted sender {t}, but the mail is from {faddr}')
    if len(addresses(msg, 'From')) > 1:
        warn.append('the message has more than one From address')
    return warn


def flags_for(text, subject, has_links, has_attachments, verified):
    flags = content_flags(subject + '\n' + text)
    if has_links:
        flags.append('links_present')
    if has_attachments:
        flags.append('attachments_present')
    if verified is not True:
        flags.append('sender_not_verified')
    return flags
