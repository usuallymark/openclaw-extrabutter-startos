"""The approval queue of an isolated service (worker side).

An action the owner's rules hold (an email to send; later a calendar
invitation) waits in state/queue/<id>.json, which only the service user can
write. The owner decides in StartOS (Review Agent Actions); the package
writes the decision into decisions/<id>.json as root, and the service
can read it but not write it. Undecided items expire.

Every item carries the fields Review Agent Actions shows, whatever the
service: id, created, expires, action (what will happen, e.g. "send"),
summary (one line) and details (lines, no secrets, no hidden text). The
rest of the item is the service's own (for mail: the exact bytes to send).

Outcomes go to state/results.jsonl. Copied into each service's folder in
the image; agentctl.py (root) reads the same files.
"""

import json
import os
import re
import secrets
import time

ID = re.compile(r'[0-9]{14}-[0-9a-f]{6}')


class ApprovalQueue:
    def __init__(self, state_dir, decisions_dir, expire_s):
        self.queue_dir = os.path.join(state_dir, 'queue')
        self.results_path = os.path.join(state_dir, 'results.jsonl')
        self.decisions_dir = decisions_dir or ''
        self.expire_s = expire_s
        os.makedirs(self.queue_dir, mode=0o700, exist_ok=True)

    @staticmethod
    def new_id():
        return time.strftime('%Y%m%d%H%M%S') + '-' + secrets.token_hex(3)

    def add(self, item):
        """Write a new item (it must have id, action, summary, details).
        created and expires are filled in. Returns the id."""
        qid = item['id']
        if not ID.fullmatch(qid):
            raise ValueError('bad queue id')
        now = time.time()
        item = {'created': now, 'expires': now + self.expire_s, **item}
        tmp = os.path.join(self.queue_dir, f'.{qid}.tmp')
        with open(tmp, 'w') as f:
            json.dump(item, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, os.path.join(self.queue_dir, f'{qid}.json'))
        return qid

    def pending(self):
        out = []
        try:
            names = sorted(os.listdir(self.queue_dir))
        except OSError:
            return out
        for n in names:
            if not n.endswith('.json'):
                continue
            try:
                with open(os.path.join(self.queue_dir, n)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                continue
        return out

    def decision(self, qid):
        """'approve', 'reject' or None (not decided yet)."""
        if not self.decisions_dir or not ID.fullmatch(qid):
            return None
        try:
            with open(os.path.join(self.decisions_dir, f'{qid}.json')) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return None
        return d.get('decision') if d.get('decision') in ('approve', 'reject') else None

    def resolve(self, item, outcome, detail='', **extra):
        """Record the outcome and remove the item from the queue."""
        rec = {'id': item['id'], 'outcome': outcome, **extra, 'detail': detail, 'ts': time.time()}
        with open(self.results_path, 'a') as f:
            f.write(json.dumps(rec) + '\n')
        try:
            os.unlink(os.path.join(self.queue_dir, f'{item["id"]}.json'))
        except OSError:
            pass

    def results(self, limit=10):
        try:
            with open(self.results_path) as f:
                lines = f.readlines()[-limit:]
        except OSError:
            return []
        out = []
        for ln in lines:
            try:
                out.append(json.loads(ln))
            except ValueError:
                pass
        return out
