#!/usr/bin/env python3
"""The mail service's front door: the MCP endpoint OpenClaw connects to.

It never restarts with the mailbox side. OpenClaw stops using an MCP server
for 30 s to 10 min after a failed connection, so the endpoint must stay up
while the worker (mailservice.py) reloads its password. This process holds
no settings and no password: it answers the MCP handshake and the tool list
itself and passes each tool call to the worker over a Unix socket that only
the openclaw-mail user can open. While the worker is away, a call gets "mail
service reloading, try again shortly" as an ordinary tool error.

Started as root by the StartOS daemon "mail-front"; it becomes openclaw-mail
before listening.
"""

import sys

sys.path.insert(0, '/opt/openclaw-mail')

import http.client  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import pwd  # noqa: E402
import socket  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

import mcp  # noqa: E402

SOCKET = os.environ.get('MAIL_SOCKET') or '/data/.openclaw-mail/state/worker.sock'
UNAVAILABLE = ('mail service reloading or starting, try again shortly '
               '(if this lasts, the Mail Service line in StartOS says why)')


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def worker(method, path, body=None, timeout=150):
    """(status, json) from the worker, or None when it is not there."""
    c = UnixHTTPConnection(SOCKET, timeout)
    try:
        c.request(method, path, body=body, headers={'Content-Type': 'application/json'} if body else {})
        r = c.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None)
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        c.close()


def call_tool(rid, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': 'tools/call', 'params': params}).encode()
    res = worker('POST', '/mcp', body)
    if res is None or res[1] is None:
        return mcp.tool_error(rid, UNAVAILABLE)
    return res[1]


def health():
    res = worker('GET', '/healthz', timeout=8)
    if res is None or not isinstance(res[1], dict):
        return {'state': 'starting', 'reason': 'the mailbox side is starting or reloading'}
    return res[1]


def drop_privileges():
    if os.geteuid() != 0:
        return
    u = pwd.getpwnam('openclaw-mail')
    os.setgroups([])
    os.setgid(u.pw_gid)
    os.setuid(u.pw_uid)
    if os.geteuid() == 0:
        raise SystemExit('mail front: could not drop root')


def main():
    port = int(os.environ.get('MAIL_PORT') or 18805)
    drop_privileges()
    os.environ.clear()
    srv = ThreadingHTTPServer(('127.0.0.1', port), mcp.make_handler(call_tool, health))
    srv.daemon_threads = True
    print(f'mail front: MCP on 127.0.0.1:{port}/mcp', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
