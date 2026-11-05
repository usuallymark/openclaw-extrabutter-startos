#!/usr/bin/env python3
"""Owner-side helper for the package's isolated services, run as root by
the package's StartOS actions (never by an agent: the gateway user cannot
enter the services' folders).

    agentctl.py queue                       everything waiting for approval,
                                            from every service, as JSON
    agentctl.py decide SERVICE ID approve   record the owner's decision
                                            (or reject)
    agentctl.py decide mail ID approve MAILING
                                            approve, and send it as an issue
                                            of routine mailing MAILING (the
                                            package wrote its definition)
    agentctl.py activity SERVICE [N]        the last N activity entries
    agentctl.py usage [DAYS]                model cost and tokens per agent
                                            and per day (since :30), from
                                            OpenClaw's own records; numbers
                                            only, never message text

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
    # No approvals either (read only, since :31); its log has counts only.
    'contacts': {'root': '/data/.openclaw-contacts', 'label': 'Contacts'},
    # No approvals; its activity log (since :27) says which items the
    # agents asked for and which were refused.
    'vault': {'root': '/data/.openclaw-vault', 'label': 'Vault'},
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


def _addr_list(v):
    return sorted({a.strip().lower() for _, a in getaddresses([str(v or '')]) if '@' in a})


def _mailing_seed(q):
    """What "Approve and make this a routine mailing" needs from a mail
    item: its recipients, subject and attachment types (no message text)."""
    exts = sorted({str(n).rsplit('.', 1)[-1].lower() for n in (q.get('attachments') or []) if '.' in str(n)})
    return {'kind': str(q.get('kind') or ''), 'to': _addr_list(q.get('to')), 'cc': _addr_list(q.get('cc')),
            'bcc': _addr_list(q.get('bcc')), 'subject': _short(q.get('subject'), 200), 'attachmentTypes': exts,
            'name': _short(q.get('mailingRequested'), 80), 'mailing': str(q.get('mailing') or '')}


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
        if service == 'mail':
            out['mailingSeed'] = _mailing_seed(q)
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


def decide(service, qid, decision, mailing=None):
    if service not in SERVICES or not ID.fullmatch(qid) or decision not in ('approve', 'reject'):
        raise SystemExit('usage: agentctl.py decide SERVICE ID approve|reject')
    if mailing is not None and (service != 'mail' or decision != 'approve'
                                or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,59}', mailing)):
        raise SystemExit('usage: agentctl.py decide mail ID approve MAILING-ID')
    p = _paths(service)
    if not os.path.exists(os.path.join(p['queue'], f'{qid}.json')):
        print(json.dumps({'ok': False, 'error': 'that request is no longer waiting (done, rejected or expired)'}))
        return
    os.makedirs(p['decisions'], exist_ok=True)
    path = os.path.join(p['decisions'], f'{qid}.json')
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'decision': decision, **({'mailing': mailing} if mailing else {})}, f)
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


# ── usage and cost (since :30) ─────────────────────────────────────────────
#
# OpenClaw stores every model call's usage with its cost (provider prices)
# in each agent's database, table transcript_events (checked on the box
# against the provider's own figure: 19.04 vs 19.28 dollars a week). Only
# the numbers in "usage" objects are read; the databases are opened read
# only. Days are counted in the owner's zone (Configure Calendar's Time
# Zone, else UTC).

AGENT_DBS = '/data/.openclaw/agents/*/agent/openclaw-agent.sqlite'
STATE_DB = '/data/.openclaw/state/openclaw.sqlite'
OPENCLAW_JSON = '/data/.openclaw/openclaw.json'
HELPER_AGENTS = ('email', 'calendar', 'apps')


def _zone():
    try:
        from zoneinfo import ZoneInfo
        with open('/data/.openclaw-calendar/settings.json') as f:
            name = (json.load(f) or {}).get('timeZone') or ''
        return ZoneInfo(name), name if name else None
    except Exception:
        return None, None


def _walk_usage(o):
    if isinstance(o, dict):
        u = o.get('usage')
        if isinstance(u, dict):
            yield u
        for k, v in o.items():
            if k != 'usage' and isinstance(v, (dict, list)):
                yield from _walk_usage(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk_usage(v)


def _n(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def _ts(v):
    from datetime import datetime
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def _since_value(sample, cut):
    """created_at >= ? for the column's own format (ms, s, or ISO text)."""
    from datetime import datetime, timezone
    if isinstance(sample, (int, float)):
        return cut * 1000 if sample > 1e11 else cut
    return datetime.fromtimestamp(cut, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')


def usage(days=30):
    import glob
    import sqlite3
    import time
    from datetime import datetime, timezone
    tz, zone_name = _zone()
    tz = tz or timezone.utc
    now = time.time()
    cut = now - days * 86400
    today = datetime.fromtimestamp(now, tz).date()
    agents, per_day, problems = {}, {}, []
    for db in sorted(glob.glob(AGENT_DBS)):
        agent = os.path.basename(os.path.dirname(os.path.dirname(db)))
        try:
            c = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
        except sqlite3.Error:
            problems.append(f'{agent}: database cannot be opened')
            continue
        try:
            cols = [r[1] for r in c.execute('pragma table_info(transcript_events)')]
            if 'created_at' not in cols:
                continue
            row = c.execute('select created_at from transcript_events order by rowid desc limit 1').fetchone()
            if not row:
                continue
            since = _since_value(row[0], cut)
            a = agents.setdefault(agent, {})
            for r in c.execute('select * from transcript_events where created_at >= ?', (since,)):
                t = _ts(r[cols.index('created_at')])
                if t is None or t < cut:
                    continue
                for v in r:
                    if isinstance(v, (bytes, bytearray)):
                        try:
                            v = v.decode()
                        except UnicodeDecodeError:
                            continue
                    if not (isinstance(v, str) and v[:1] in '{[' and '"usage"' in v):
                        continue
                    try:
                        d = json.loads(v)
                    except ValueError:
                        continue
                    for u in _walk_usage(d):
                        cost = u.get('cost')
                        if not isinstance(cost, dict) or not isinstance(cost.get('total'), (int, float)):
                            continue
                        day = datetime.fromtimestamp(t, tz).date()
                        age = (today - day).days
                        rec = [_n(cost['total']), 1, _n(u.get('input')), _n(u.get('output')),
                               _n(u.get('cacheRead')), _n(u.get('cacheWrite'))]
                        for window, limit in (('today', 0), ('d7', 6), ('d30', 29)):
                            if age <= limit:
                                w = a.setdefault(window, [0] * 6)
                                for i, x in enumerate(rec):
                                    w[i] += x
                        if age <= 13:
                            k = day.isoformat()
                            dd = per_day.setdefault(k, [0, 0])
                            dd[0] += rec[0]
                            dd[1] += 1
        except sqlite3.Error as e:
            problems.append(f'{agent}: {type(e).__name__}')
        finally:
            c.close()
    models = {}
    try:
        with open(OPENCLAW_JSON) as f:
            cfg = json.load(f)
        ag = cfg.get('agents') or {}
        default = ((ag.get('defaults') or {}).get('model') or {}).get('primary') or ''
        for k, e in (ag.get('entries') or {}).items():
            if isinstance(e, dict):
                m = e.get('model')
                models[k] = (m.get('primary') if isinstance(m, dict) else m) or default
        models.setdefault('main', default)
    except (OSError, ValueError):
        pass
    keys = ('cost', 'calls', 'input', 'output', 'cacheRead', 'cacheWrite')
    out_agents = []
    for agent, w in agents.items():
        if not w:
            continue
        out_agents.append({'agent': agent, 'model': models.get(agent, ''), 'helper': agent in HELPER_AGENTS,
                           **{win: dict(zip(keys, w.get(win, [0] * 6))) for win in ('today', 'd7', 'd30')}})
    out_agents.sort(key=lambda x: -x['d7']['cost'])
    total = {win: round(sum(x[win]['cost'] for x in out_agents), 4) for win in ('today', 'd7', 'd30')}
    days_out = []
    for i in range(13, -1, -1):
        from datetime import timedelta
        k = (today - timedelta(days=i)).isoformat()
        v = per_day.get(k, [0, 0])
        days_out.append({'date': k, 'cost': round(v[0], 4), 'calls': v[1]})
    return {'zone': zone_name or 'UTC', 'today': today.isoformat(), 'total': total, 'agents': out_agents,
            'days': days_out, 'jobs': _jobs(), 'problems': problems}


def _jobs():
    """Scheduled jobs: names, schedules, agents and run counts (no prompts)."""
    import sqlite3
    import time
    out = []
    try:
        c = sqlite3.connect(f'file:{STATE_DB}?mode=ro', uri=True, timeout=5)
    except sqlite3.Error:
        return out
    try:
        cols = [r[1] for r in c.execute('pragma table_info(cron_jobs)')]
        want = {}
        for col in cols:
            lc = col.lower()
            if any(w in lc for w in ('prompt', 'message', 'text', 'payload', 'body', 'instruction', 'token')):
                continue
            if lc in ('id', 'job_id') and 'id' not in want:
                want['id'] = col
            elif 'name' in lc and 'name' not in want:
                want['name'] = col
            elif ('schedule' in lc or lc in ('cron', 'expr', 'every')) and 'schedule' not in want \
                    and lc != 'schedule_identity':
                want['schedule'] = col
            elif lc == 'job_json':
                # Holds the job's prompt too: only its "schedule" is read.
                want['job'] = col
            elif lc == 'agent_id':
                want['agent'] = col
            elif 'enabled' in lc and 'enabled' not in want:
                want['enabled'] = col
        if 'id' not in want:
            return out
        sel = ', '.join(f'"{want[k]}"' for k in want)
        runs = {}
        rc = [r[1] for r in c.execute('pragma table_info(cron_run_receipts)')]
        jcol = next((x for x in rc if x.lower() in ('job_id', 'cron_job_id')), None)
        tcol = next((x for x in rc if 'created' in x.lower() or 'started' in x.lower()), None)
        if jcol and tcol:
            sample = c.execute(f'select "{tcol}" from cron_run_receipts order by rowid desc limit 1').fetchone()
            if sample:
                since = _since_value(sample[0], time.time() - 7 * 86400)
                for j, n in c.execute(f'select "{jcol}", count(*) from cron_run_receipts where "{tcol}" >= ? group by "{jcol}"', (since,)):
                    runs[str(j)] = n
        for row in c.execute(f'select {sel} from cron_jobs'):
            d = dict(zip(want.keys(), row))
            sched = d.get('schedule')
            if not sched and isinstance(d.get('job'), str):
                try:
                    sched = json.dumps((json.loads(d['job']) or {}).get('schedule') or '')
                except (ValueError, AttributeError):
                    sched = None
            d.pop('job', None)
            if isinstance(sched, str) and sched[:1] == '{':
                try:
                    sj = json.loads(sched)
                    if isinstance(sj, dict):
                        sched = (sj.get('expr') or sj.get('cron')
                                 or (f'every {int(sj["everyMs"]) // 60000} min' if sj.get('everyMs') else None)
                                 or (f'once at {sj.get("at")}' if sj.get('at') else sj.get('kind')))
                        if sj.get('tz') and (sj.get('expr') or sj.get('cron')):
                            sched = f'{sched} ({sj["tz"]})'
                    else:
                        sched = str(sj or '')
                except (ValueError, TypeError):
                    pass
            out.append({'name': _short(d.get('name') or d.get('id'), 60), 'schedule': _short(sched, 40),
                        'agent': _short(d.get('agent'), 30) or 'default (main)', 'enabled': d.get('enabled'),
                        'runs7d': runs.get(str(d.get('id')), 0)})
    except sqlite3.Error:
        pass
    finally:
        c.close()
    out.sort(key=lambda x: -x['runs7d'])
    return out


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'queue':
        print(json.dumps({'queue': queue(), 'results': results(20)}))
    elif cmd == 'decide' and len(argv) in (5, 6):
        decide(argv[2], argv[3], argv[4], argv[5] if len(argv) == 6 else None)
    elif cmd == 'usage' and len(argv) in (2, 3):
        print(json.dumps(usage(int(argv[2]) if len(argv) == 3 and argv[2].isdigit() else 30)))
    elif cmd == 'activity' and len(argv) in (3, 4) and argv[2] in SERVICES:
        n = int(argv[3]) if len(argv) > 3 and argv[3].isdigit() else 50
        print(json.dumps({'activity': tail(_paths(argv[2])['activity'], min(n, 500))}))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
