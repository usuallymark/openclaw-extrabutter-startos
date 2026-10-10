#!/usr/bin/env python3
"""Rewrite the "## Server State Snapshot" section of the workspace MEMORY.md.

    refresh-snapshot [--reason startup|heartbeat]

Run by the package at every start and by the daily heartbeat, so the agent
never edits that section by hand. When start-cli is logged in to StartOS
("Login to StartOS"), the section holds server metrics, packages,
notifications, gateways, disks and backup targets. When it is not, it holds
this container's health report instead (health.py), with a note that logging
in adds the server details.

Only the snapshot section is replaced: everything above it, and any later
"## " section, is kept. "## " lines inside ``` fences don't end the section.
Prints one line saying what it wrote. Exit status 0, or 1 if MEMORY.md could
not be written.
"""
import argparse
import os
import pwd
import subprocess
import sys
import time

MEMORY = '/data/.openclaw/workspace/MEMORY.md'
HEADING = '## Server State Snapshot'
HEALTH = '/opt/skills/health/health.py'
COMMANDS = [
    ('Server Metrics', ['server', 'metrics']),
    ('Server Time', ['server', 'time']),
    ('Package List', ['package', 'list']),
    ('Package Stats', ['package', 'stats']),
    ('Notifications', ['notification', 'list']),
    ('Network Gateways', ['net', 'gateway', 'list']),
    ('Disk List', ['disk', 'list']),
    ('Backup Targets', ['backup', 'target', 'list']),
]


def _env():
    return {**os.environ, 'HOME': '/data', 'NO_COLOR': '1'}


def _run(cmd, timeout=60):
    # No stdin and a new session (no controlling terminal): start-cli >= 2.1
    # asks for the StartOS password at a terminal when it is not logged in,
    # and that prompt must never block a heartbeat or a startup.
    try:
        r = subprocess.run(cmd, env=_env(), capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, start_new_session=True)
        return r.returncode, r.stdout, r.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 124, '', f'{e.__class__.__name__}'


def logged_in():
    code, _, _ = _run(['start-cli', 'auth', 'session', 'list'], timeout=30)
    return code == 0


def fence(text):
    # Keep command output from closing our fence early.
    return '```\n' + text.replace('```', "'''").strip() + '\n```'


def server_sections():
    out = []
    for label, args in COMMANDS:
        code, so, se = _run(['start-cli'] + args)
        body = (so.strip() or '_No output_') if code == 0 else f'_Command failed (exit {code}): {se.strip()}_'
        out.append(f'### {label}\n\n' + (fence(body) if code == 0 and so.strip() else body))
    return out


def health_sections():
    code, so, se = _run([sys.executable, HEALTH], timeout=120)
    lines = [l for l in (so or se).splitlines() if l.strip() and not l.startswith('Service logs')]
    report = '\n'.join(lines) or f'_health.py gave no output (exit {code})_'
    return [
        '### Health\n\n' + fence(report),
        '_start-cli is not logged in to StartOS, so server metrics, packages and '
        'notifications are not shown. "Login to StartOS" in the service\'s actions adds them._',
    ]


def replace_snapshot(existing, block):
    """Same rules as the package's original replaceSnapshot (memorySnapshot.ts)."""
    import re
    m = re.search(r'^## Server State Snapshot[ \t]*$', existing, re.M)
    new_block = block.rstrip() + '\n'
    if not m:
        before = existing.rstrip()
        return before + '\n\n' + new_block if before else new_block
    start = m.start()
    pos = start + len(HEADING)
    end = -1
    h2 = re.compile(r'^## ', re.M)
    while pos <= len(existing):
        f = existing.find('\n```', pos)
        hm = h2.search(existing, pos)
        if not hm:
            break
        if 0 <= f < hm.start():
            close = existing.find('\n```', f + 4)
            if close < 0:
                break
            pos = close + 4
            continue
        end = hm.start()
        break
    before = existing[:start].rstrip()
    after = existing[end:].lstrip() if end >= 0 else ''
    return (before + '\n\n' if before else '') + new_block + ('\n' + after if after else '')


def main(argv=None):
    ap = argparse.ArgumentParser(prog='refresh-snapshot')
    ap.add_argument('--reason', default='manual', help='startup, heartbeat or manual (shown in the section)')
    ap.add_argument('--file', default=MEMORY, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    auth = logged_in()
    sections = server_sections() if auth else health_sections()
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    block = (f'{HEADING}\n\n'
             '_Written by the package (refresh-snapshot) at every start and by the daily heartbeat. '
             'Do not edit this section; keep notes above it or under their own `## ` heading._\n\n'
             f'_Captured at {a.reason}: {stamp}_\n\n' + '\n\n'.join(sections) + '\n')
    try:
        with open(a.file, encoding='utf-8') as f:
            existing = f.read()
    except FileNotFoundError:
        existing = ''
    try:
        tmp = a.file + '.snapshot-tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(replace_snapshot(existing, block))
        if os.geteuid() == 0:
            try:
                pw = pwd.getpwnam('node')
                os.chown(tmp, pw.pw_uid, pw.pw_gid)
            except (KeyError, OSError):
                pass
        os.replace(tmp, a.file)
    except OSError as e:
        print(f'refresh-snapshot: cannot write {a.file}: {e}', file=sys.stderr)
        return 1
    print(f"refresh-snapshot: wrote {'server state (start-cli)' if auth else 'health report (start-cli not logged in)'} "
          f'to {a.file} ({a.reason})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
