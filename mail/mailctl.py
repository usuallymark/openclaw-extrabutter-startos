#!/usr/bin/env python3
"""Owner-side helper for the mail service, run as root by the package's
StartOS actions (never by an agent: the gateway user cannot enter the mail
folder).

    mailctl.py queue              messages waiting for approval, as JSON
    mailctl.py decide ID approve  record the owner's decision (or reject)
    mailctl.py activity [N]       the last N activity entries, as JSON

The mail service polls decisions/ and acts within seconds.
"""

import json
import os
import re
import sys
from email.utils import getaddresses

MAIL_ROOT = '/data/.openclaw-mail'
QUEUE = f'{MAIL_ROOT}/state/queue'
DECISIONS = f'{MAIL_ROOT}/decisions'
ACTIVITY = f'{MAIL_ROOT}/state/activity.jsonl'
RESULTS = f'{MAIL_ROOT}/state/results.jsonl'
ID = re.compile(r'[0-9]{14}-[0-9a-f]{6}')


def queue():
    items = []
    try:
        names = sorted(os.listdir(QUEUE))
    except OSError:
        names = []
    for n in names:
        if not n.endswith('.json') or not ID.fullmatch(n[:-5]):
            continue
        try:
            with open(os.path.join(QUEUE, n)) as f:
                q = json.load(f)
        except (OSError, ValueError):
            continue
        q.pop('raw', None)
        q['recipients'] = sorted({a.strip().lower() for _, a in getaddresses(
            [str(q[k]) for k in ('to', 'cc', 'bcc') if str(q.get(k) or '').strip()]) if '@' in a})
        q['decided'] = os.path.exists(os.path.join(DECISIONS, n))
        items.append(q)
    # Decisions the service has acted on are no longer needed.
    live = {q['id'] for q in items}
    try:
        for n in os.listdir(DECISIONS):
            if n.endswith('.json') and n[:-5] not in live:
                os.unlink(os.path.join(DECISIONS, n))
    except OSError:
        pass
    return items


def decide(qid, decision):
    if not ID.fullmatch(qid) or decision not in ('approve', 'reject'):
        raise SystemExit('usage: mailctl.py decide ID approve|reject')
    if not os.path.exists(os.path.join(QUEUE, f'{qid}.json')):
        print(json.dumps({'ok': False, 'error': 'that message is no longer waiting (sent, rejected or expired)'}))
        return
    os.makedirs(DECISIONS, exist_ok=True)
    p = os.path.join(DECISIONS, f'{qid}.json')
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'decision': decision}, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, p)
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


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'queue':
        print(json.dumps({'queue': queue(), 'results': tail(RESULTS, 20)}))
    elif cmd == 'decide' and len(argv) == 4:
        decide(argv[2], argv[3])
    elif cmd == 'activity':
        n = int(argv[2]) if len(argv) > 2 and argv[2].isdigit() else 50
        print(json.dumps({'activity': tail(ACTIVITY, min(n, 500))}))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
