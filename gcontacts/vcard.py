"""vCard files (RFC 2426 / 6350, and the 2.1 that old phones export),
standard library only. parse() gives a list of contacts as plain dicts.

Handled: line folding, QUOTED-PRINTABLE and CHARSET (2.1), BEGIN/END
nesting (AGENT), grouped properties (item1.EMAIL), FN, N, NICKNAME, EMAIL,
TEL, ADR, BDAY (with or without year), ORG, TITLE, NOTE, CATEGORIES, UID,
URL. Photos and keys are skipped.
"""

import hashlib
import quopri
import re

MAX_CONTACTS = 50000
MAX_VALUE = 4000


def _unfold(text):
    out = []
    for line in re.split(r'\r\n|\n|\r', text):
        if line[:1] in (' ', '\t') and out:
            out[-1] += line[1:]
        elif out and out[-1].endswith('=') and 'QUOTED-PRINTABLE' in out[-1].upper().split(':', 1)[0]:
            out[-1] = out[-1][:-1] + line  # 2.1 soft line break
        else:
            out.append(line)
    return [ln for ln in out if ln.strip()]


def _split(line):
    i, q = 0, False
    while i < len(line):
        if line[i] == '"':
            q = not q
        elif line[i] == ':' and not q:
            break
        i += 1
    head, value = line[:i], line[i + 1:]
    parts = head.split(';')
    name = parts[0].strip()
    if '.' in name:
        name = name.split('.', 1)[1]  # item1.EMAIL
    params = {}
    types = []
    for p in parts[1:]:
        k, eq, v = p.partition('=')
        k, v = k.strip().upper(), v.strip().strip('"')
        if not eq:  # 2.1: ;HOME;VOICE
            types.append(k.lower())
        elif k == 'TYPE':
            types += [t.strip().lower() for t in v.split(',') if t.strip()]
        else:
            params[k] = v
    return name.upper(), params, types, value


def _decode(value, params):
    if params.get('ENCODING', '').upper() in ('QUOTED-PRINTABLE', 'QP'):
        raw = quopri.decodestring(value.encode('latin-1', 'replace'))
        cs = params.get('CHARSET') or 'utf-8'
        try:
            return raw.decode(cs, 'replace')
        except LookupError:
            return raw.decode('utf-8', 'replace')
    return value


def _unesc(s):
    return (s.replace('\\n', '\n').replace('\\N', '\n').replace('\\,', ',')
            .replace('\\;', ';').replace('\\:', ':').replace('\\\\', '\\'))


def _components(value):
    out, cur, i = [], '', 0
    while i < len(value):
        c = value[i]
        if c == '\\' and i + 1 < len(value):
            cur += c + value[i + 1]
            i += 2
            continue
        if c == ';':
            out.append(_unesc(cur))
            cur = ''
        else:
            cur += c
        i += 1
    out.append(_unesc(cur))
    return out


def _bday(v):
    v = v.strip()
    m = re.fullmatch(r'(\d{4}|--)-?(\d{2})-?(\d{2})(?:T.*)?', v)
    if not m:
        return None
    y = None if m.group(1) == '--' or m.group(1) in ('1604', '0000') else m.group(1)
    return f'{y}-{m.group(2)}-{m.group(3)}' if y else f'--{m.group(2)}-{m.group(3)}'


def _clean(s):
    s = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', str(s)).strip()
    return s[:MAX_VALUE]


def parse(text):
    """The contacts in a vCard file (a list of dicts). Raises ValueError
    when the text has no vCard at all."""
    lines = _unfold(text)
    contacts, cur, depth, problems = [], None, 0, []
    for line in lines:
        name, params, types, value = _split(line)
        if name == 'BEGIN' and value.strip().upper() == 'VCARD':
            depth += 1
            if depth == 1:
                cur = {'names': [], 'fn': '', 'n': '', 'nicknames': [], 'emails': [], 'phones': [],
                       'addresses': [], 'birthday': None, 'org': '', 'title': '', 'note': '',
                       'categories': [], 'uid': '', 'urls': []}
            continue
        if name == 'END' and value.strip().upper() == 'VCARD':
            depth -= 1
            if depth == 0 and cur is not None:
                if len(contacts) < MAX_CONTACTS:
                    contacts.append(_finish(cur))
                elif len(contacts) == MAX_CONTACTS:
                    problems.append(f'more than {MAX_CONTACTS} contacts; the rest were skipped')
                cur = None
            continue
        if cur is None or depth != 1:
            continue
        if name in ('PHOTO', 'LOGO', 'SOUND', 'KEY'):
            continue
        v = _decode(value, params)
        if name == 'FN':
            cur['fn'] = _clean(_unesc(v))
        elif name == 'N':
            c = _components(v) + [''] * 5
            family, given, middle, prefix, suffix = (_clean(x) for x in c[:5])
            cur['n'] = ' '.join(x for x in (prefix, given, middle, family, suffix) if x)
        elif name == 'NICKNAME':
            cur['nicknames'] += [_clean(x) for x in _unesc(v).split(',') if x.strip()]
        elif name == 'EMAIL':
            a = _clean(_unesc(v)).lower()
            if a.startswith('mailto:'):
                a = a[7:]
            if '@' in a:
                cur['emails'].append({'address': a, 'type': ','.join(t for t in types if t not in ('internet', 'pref'))})
        elif name == 'TEL':
            t = _clean(_unesc(v))
            if t.lower().startswith('tel:'):
                t = t[4:]
            if t:
                cur['phones'].append({'number': t, 'type': ','.join(x for x in types if x not in ('voice', 'pref'))})
        elif name == 'ADR':
            c = [_clean(x) for x in _components(v)] + [''] * 7
            pobox, ext, street, city, region, code, country = c[:7]
            text_ = ', '.join(x for x in (pobox, ext, street, city, ' '.join(y for y in (region, code) if y), country) if x)
            if text_:
                cur['addresses'].append({'address': text_, 'type': ','.join(x for x in types if x != 'pref')})
        elif name == 'BDAY':
            cur['birthday'] = _bday(v) or cur['birthday']
        elif name == 'ORG':
            cur['org'] = ' / '.join(x for x in (_clean(y) for y in _components(v)) if x)
        elif name == 'TITLE':
            cur['title'] = _clean(_unesc(v))
        elif name == 'NOTE':
            cur['note'] = _clean(_unesc(v))
        elif name == 'CATEGORIES':
            cur['categories'] += [_clean(x) for x in _unesc(v).split(',') if x.strip()]
        elif name == 'UID':
            cur['uid'] = _clean(v)[:200]
        elif name == 'URL':
            cur['urls'].append(_clean(_unesc(v))[:300])
    if not contacts and not any(ln.upper().startswith('BEGIN:VCARD') for ln in lines[:50]):
        raise ValueError('the file has no vCard in it (no BEGIN:VCARD)')
    return contacts, problems


def _finish(c):
    name = c['fn'] or c['n'] or (c['org'] if c['org'] else '') or (c['emails'][0]['address'] if c['emails'] else '')
    seed = c['uid'] or (name + '|' + ','.join(e['address'] for e in c['emails']) + '|' +
                        ','.join(p['number'] for p in c['phones']))
    return {
        'id': 'v' + hashlib.sha256(seed.encode('utf-8', 'replace')).hexdigest()[:16],
        'name': name or '(no name)', 'other_names': sorted({x for x in [c['n']] + c['nicknames'] if x and x != name}),
        'emails': c['emails'][:20], 'phones': c['phones'][:20], 'addresses': c['addresses'][:10],
        'birthday': c['birthday'], 'organization': c['org'], 'title': c['title'],
        'groups': c['categories'][:20], 'note': c['note'], 'urls': c['urls'][:10],
    }
