"""The front door of an isolated service: the MCP endpoint OpenClaw connects to.

It never restarts with the worker. OpenClaw stops using an MCP server for
30 s to 10 min after a failed connection, so the endpoint must stay up
while the worker reloads its credentials. This process holds no settings
and no secrets: it answers the MCP handshake and the tool list itself and
passes each tool call to the worker over a Unix socket that only the
service user can open. While the worker is away, a call gets an ordinary
tool error saying so.

Started as root by the service's StartOS daemon; it becomes the service
user before listening. Copied into each service's folder in the image; the
service's own front.py calls serve().
"""

import http.client
import json
import os
import pwd
import socket
from http.server import ThreadingHTTPServer

import mcpserver


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def worker(sock_path, method, path, body=None, timeout=150):
    """(status, json) from the worker, or None when it is not there."""
    c = UnixHTTPConnection(sock_path, timeout)
    try:
        c.request(method, path, body=body, headers={'Content-Type': 'application/json'} if body else {})
        r = c.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None)
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        c.close()


def drop_privileges(user, label):
    if os.geteuid() != 0:
        return
    u = pwd.getpwnam(user)
    os.setgroups([])
    os.setgid(u.pw_gid)
    os.setuid(u.pw_uid)
    if os.geteuid() == 0:
        raise SystemExit(f'{label}: could not drop root')


def serve(*, label, user, sock_path, port, server, unavailable, starting_reason):
    """Run the front door until the process is stopped.

    label: log prefix ("mail front"); user: the service user; sock_path:
    the worker's socket; server: the service's mcpserver.Server;
    unavailable: the tool error while the worker is away; starting_reason:
    the health reason while it is away."""

    def call_tool(rid, params):
        body = json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': 'tools/call', 'params': params}).encode()
        res = worker(sock_path, 'POST', '/mcp', body)
        if res is None or res[1] is None:
            return mcpserver.tool_error(rid, unavailable)
        return res[1]

    def health():
        res = worker(sock_path, 'GET', '/healthz', timeout=8)
        if res is None or not isinstance(res[1], dict):
            return {'state': 'starting', 'reason': starting_reason}
        return res[1]

    drop_privileges(user, label)
    os.environ.clear()
    srv = ThreadingHTTPServer(('127.0.0.1', port), server.make_handler(call_tool, health))
    srv.daemon_threads = True
    print(f'{label}: MCP on 127.0.0.1:{port}/mcp', flush=True)
    srv.serve_forever()
