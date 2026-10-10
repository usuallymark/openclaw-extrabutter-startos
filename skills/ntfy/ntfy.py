#!/usr/bin/env python3
"""ntfy helper for OpenClaw: send a push notification.

From Python:
    import sys; sys.path.insert(0, '/opt/skills/ntfy')
    import ntfy
    ntfy.send('Backup finished', title='Workspace', tags=['white_check_mark'])
    ntfy.send('Disk almost full', priority='high', topic='other-topic')

From a shell (also used by git hooks and scheduled jobs):
    notify "Backup finished"
    notify --title Workspace --priority high --tags warning "Disk almost full"
    echo "long text" | notify --title Report -

Settings come from Configure External Services (NTFY_URL, NTFY_TOPIC and the
access token via getcred). Run from a shell without them (e.g. a root attach
shell or a git hook started by hand), they are read from the gateway process.
Exit status: 0 sent, 1 send failed, 2 not configured or bad arguments.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, '/opt/skills/rbw')
from creds import CredentialError, auth_headers, not_configured, use_gateway_env  # noqa: E402

PRIORITIES = {'min': 1, 'low': 2, 'default': 3, 'high': 4, 'urgent': 5, 'max': 5}


class NtfyError(RuntimeError):
    pass


def _load_settings():
    """Copy the NTFY_* settings from the gateway process if we lack them."""
    use_gateway_env('NTFY_URL')


def _priority(p):
    if p is None or p == '':
        return None
    if isinstance(p, int) or str(p).isdigit():
        n = int(p)
    else:
        n = PRIORITIES.get(str(p).lower())
    if n is None or not 1 <= n <= 5:
        raise NtfyError(f'priority must be 1-5 or one of {", ".join(PRIORITIES)}, not {p!r}')
    return n


def send(message, title=None, priority=None, tags=None, topic=None, click=None,
         markdown=False, timeout=15):
    """Publish one notification. Returns ntfy's message id."""
    _load_settings()
    base = os.environ.get('NTFY_URL', '').strip().rstrip('/')
    if not base:
        raise NtfyError(not_configured('NTFY_URL', 'ntfy'))
    topic = (topic or os.environ.get('NTFY_TOPIC', '')).strip()
    if not topic:
        raise NtfyError('No topic: set a Default Topic in Configure External Services or pass one.')
    body = {'topic': topic, 'message': str(message)}
    if title:
        body['title'] = str(title)
    p = _priority(priority)
    if p:
        body['priority'] = p
    if tags:
        body['tags'] = [t.strip() for t in (tags.split(',') if isinstance(tags, str) else tags) if t.strip()]
    if click:
        body['click'] = str(click)
    if markdown:
        body['markdown'] = True
    try:
        hdrs = auth_headers('Authorization', 'NTFY_KEY', required=False, prefix='Bearer ')
    except CredentialError as e:
        raise NtfyError(str(e)) from None
    hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(base + '/', data=json.dumps(body).encode(), headers=hdrs, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise NtfyError(f'ntfy refused the access token for topic "{topic}" (HTTP {e.code}). '
                            'Check the token and that its user may write to this topic.') from None
        raise NtfyError(f'ntfy returned HTTP {e.code} for topic "{topic}".') from None
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, 'reason', e)
        raise NtfyError(f'ntfy unreachable at {base}: {reason}') from None
    return data.get('id', '')


def main(argv=None):
    ap = argparse.ArgumentParser(prog='notify', description='Send a push notification via ntfy.')
    ap.add_argument('message', nargs='+', help='message text, or "-" to read it from stdin')
    ap.add_argument('--title', '-t')
    ap.add_argument('--priority', '-p', help='1-5 or min/low/default/high/urgent')
    ap.add_argument('--tags', help='comma-separated, e.g. warning,floppy_disk')
    ap.add_argument('--topic', help='default: the topic set in Configure External Services')
    ap.add_argument('--click', help='URL to open when the notification is tapped')
    ap.add_argument('--markdown', action='store_true')
    args = ap.parse_args(argv)
    message = sys.stdin.read().strip() if args.message == ['-'] else ' '.join(args.message)
    if not message:
        print('notify: empty message', file=sys.stderr)
        return 2
    try:
        send(message, title=args.title, priority=args.priority, tags=args.tags,
             topic=args.topic, click=args.click, markdown=args.markdown)
    except NtfyError as e:
        print(f'notify: {e}', file=sys.stderr)
        return 2 if 'not configured' in str(e) or 'No topic' in str(e) or 'priority must' in str(e) else 1
    return 0


if __name__ == '__main__':
    if os.geteuid() == 0 and os.path.isdir('/data'):
        # Credentials come from rbw, which must run as the gateway user (node);
        # as root it would leave root-owned files in the vault cache.
        os.execvp('runuser', ['runuser', '-u', 'node', '--', 'env', 'HOME=/data',
                              sys.executable, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit(main())
