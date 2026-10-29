#!/usr/bin/env python3
"""Owner-side helper for the package's isolated services, run as root by
the package's StartOS actions (never by an agent: the gateway user cannot
enter the services' folders).

    agentctl.py queue                       everything waiting for approval,
                                            from every service, as JSON
    agentctl.py decide SERVICE ID approve   record the owner's decision
                                            (or reject)
    agentctl.py activity SERVICE [N]        the last N activity entries

Each service polls its decisions/ and acts within seconds. Queue items are
written by the services (approvals.py); what this shows is the common part
only, never the service's private fields (for mail: the message bytes).
"""

import json
import os
import re
import sys
from email.utils import getaddresses

# The services with an approval queue. A service whose folder does not
# exist (not set up) simply has nothing waiting.
SERVICES = {
    'mail': {'root': '/data/.openclaw-mail', 'label': 'Email'},
    'calendar': {'root': '/data/.openclaw-calendar', 'label': 'Calendar'},
}
ID = re.compile(r'[0-9]{14}-[0-9a-f]{6}')
PUBLIC = ('id', 'action', 'summary', 'details', 'rule', 'requester', 'created', 'expires', 'recipients')


def _paths(service):
    root = SERVICES[service]['root']
    return {'queue': f'{root}/state/queue', 'decisions': f'{root}/decisions',
            'activity': f'{root}/state/activity.jsonl', 'results': f'{root}/state/results.jsonl'}


def _short(s, n):
    t = ' '.join(str(s or '').split())
    return t[:n - 1] + '…' if len(t) > n else t


def _mail_legacy(q):
    """An email queued by 2026.10.1:13 or earlier, before items carried what
    Review Agent Actions shows."""
    rcpts = sorted({a.strip().lower() for _, a in getaddresses(
        [str(q[k]) for k in ('to', 'cc', 'bcc') if str(q.get(k) or '').strip()]) if '@' in a})
    kind = str(q.get('kind') or '')
    return {
        'action': 'send',
        'summary': f'Email to {_short(", ".join(rcpts) or q.get("to"), 60)}: {_short(q.get("subject"), 50) or "(no subject)"}',
        'details': [
            f'To: {q.get("to") or "—"}',
            *([f'Cc: {q["cc"]}'] if q.get('cc') else []),
            *([f'Bcc: {q["bcc"]}'] if q.get('bcc') else []),
            f'Subject: {q.get("subject") or "(none)"}',
            f'Kind: {"forward" if kind == "forward" else "reply" if kind.startswith("reply") else "new message"}',
            f'Attachments: {", ".join(q.get("attachments") or []) or "none"}',
            f'Opening lines: {_short(q.get("opening"), 400) or "(empty)"}',
        ],
        'recipients': rcpts,
    }


def _items(service):
    p = _paths(service)
    items = []
    try:
        names = sorted(os.listdir(p['queue']))
    except OSError:
        names = []
    for n in names:
        if not n.endswith('.json') or not ID.fullmatch(n[:-5]):
            continue
        try:
            with open(os.path.join(p['queue'], n)) as f:
                q = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(q, dict) or q.get('id') != n[:-5]:
            continue
        if service == 'mail' and not q.get('details'):
            q = {**q, **_mail_legacy(q)}
        out = {k: q[k] for k in PUBLIC if k in q}
        out['details'] = [str(x) for x in out.get('details') or []]
        out['service'] = service
        out['label'] = SERVICES[service]['label']
        out['decided'] = os.path.exists(os.path.join(p['decisions'], n))
        items.append(out)
    # Decisions the service has acted on are no longer needed.
    live = {q['id'] for q in items}
    try:
        for n in os.listdir(p['decisions']):
            if n.endswith('.json') and n[:-5] not in live:
                os.unlink(os.path.join(p['decisions'], n))
    except OSError:
        pass
    return items


def queue():
    items = []
    for s in SERVICES:
        items += _items(s)
    items.sort(key=lambda q: (q.get('created') or 0, q['id']))
    return items


def decide(service, qid, decision):
    if service not in SERVICES or not ID.fullmatch(qid) or decision not in ('approve', 'reject'):
        raise SystemExit('usage: agentctl.py decide SERVICE ID approve|reject')
    p = _paths(service)
    if not os.path.exists(os.path.join(p['queue'], f'{qid}.json')):
        print(json.dumps({'ok': False, 'error': 'that request is no longer waiting (done, rejected or expired)'}))
        return
    os.makedirs(p['decisions'], exist_ok=True)
    path = os.path.join(p['decisions'], f'{qid}.json')
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'decision': decision}, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    print(json.dumps({'ok': True}))


def tail(path, n):
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            lines = f.read().decode('utf-8', 'replace').splitlines()[-n:]
    except OSError:
        return []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


def results(n):
    out = []
    for s in SERVICES:
        out += [{**r, 'service': s} for r in tail(_paths(s)['results'], n) if isinstance(r, dict)]
    out.sort(key=lambda r: r.get('ts') or 0)
    return out[-n:]


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'queue':
        print(json.dumps({'queue': queue(), 'results': results(20)}))
    elif cmd == 'decide' and len(argv) == 5:
        decide(argv[2], argv[3], argv[4])
    elif cmd == 'activity' and len(argv) in (3, 4) and argv[2] in SERVICES:
        n = int(argv[3]) if len(argv) > 3 and argv[3].isdigit() else 50
        print(json.dumps({'activity': tail(_paths(argv[2])['activity'], min(n, 500))}))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
