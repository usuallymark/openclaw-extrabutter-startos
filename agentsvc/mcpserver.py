"""MCP for the package's isolated services (mail now; others later).

Streamable HTTP with plain JSON responses (no event stream), Python
standard library only. Each service builds one Server with its name, tool
list and instructions; the same Server answers in the front door (TCP, for
OpenClaw) and in the worker (Unix socket, for the front door).

Copied into each service's folder in the image (/opt/openclaw-<service>/),
next to that service's own code.
"""

import json
import re
import secrets
from http.server import BaseHTTPRequestHandler

PROTOCOLS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')


def tool_error(rid, text):
    return {'jsonrpc': '2.0', 'id': rid, 'result': {'content': [{'type': 'text', 'text': text}], 'isError': True}}


class ToolError(Exception):
    """A refusal or problem to report to the agent in plain words."""


def run_tool(rid, params, call, log, label='service'):
    """Run one tools/call with call(name, args); never leak a traceback.
    A dict result may carry '_untrusted': text sent as a second content
    block, after the JSON."""
    name = params.get('name')
    args = params.get('arguments') or {}
    if not isinstance(args, dict):
        args = {}
    try:
        out = call(name, args)
    except ToolError as e:
        return tool_error(rid, str(e))
    except Exception as e:  # never return content in a traceback
        log({'event': 'error', 'tool': str(name), 'type': type(e).__name__})
        return tool_error(rid, f'internal error in the {label} ({type(e).__name__})')
    untrusted = out.pop('_untrusted', None) if isinstance(out, dict) else None
    content = [{'type': 'text', 'text': json.dumps(out, ensure_ascii=False)}]
    if untrusted:
        content.append({'type': 'text', 'text': untrusted})
    return {'jsonrpc': '2.0', 'id': rid, 'result': {'content': content, 'isError': False}}


class Server:
    """One MCP server: identity, tools and the HTTP handler."""

    def __init__(self, name, version, tools, instructions):
        self.name = name
        self.version = version
        self.tools = tools
        self.instructions = instructions

    def handle(self, req, call_tool):
        """One JSON-RPC message in, one response (None for notifications)."""
        if not isinstance(req, dict) or req.get('jsonrpc') != '2.0':
            return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'invalid request'}}
        rid = req.get('id')
        method = req.get('method')
        if rid is None:
            return None  # notification (initialized, cancelled …)
        params = req.get('params') or {}
        if not isinstance(params, dict):
            params = {}
        if method == 'initialize':
            asked = str(params.get('protocolVersion') or '')
            version = asked if re.fullmatch(r'\d{4}-\d{2}-\d{2}', asked) else PROTOCOLS[0]
            return {'jsonrpc': '2.0', 'id': rid, 'result': {
                'protocolVersion': version,
                'capabilities': {'tools': {'listChanged': False}},
                'serverInfo': {'name': self.name, 'version': self.version},
                'instructions': self.instructions,
            }}
        if method == 'ping':
            return {'jsonrpc': '2.0', 'id': rid, 'result': {}}
        if method == 'tools/list':
            return {'jsonrpc': '2.0', 'id': rid, 'result': {'tools': self.tools}}
        if method == 'tools/call':
            return call_tool(rid, params)
        return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32601, 'message': f'unknown method {method}'}}

    def make_handler(self, call_tool, health):
        server = self

        class Handler(BaseHTTPRequestHandler):
            server_version = server.name
            sys_version = ''

            def log_message(self, fmt, *args):  # no request log (no content)
                pass

            def _send(self, code, obj=None, extra=None):
                body = b'' if obj is None else json.dumps(obj).encode()
                self.send_response(code)
                if obj is not None:
                    self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def do_GET(self):
                if self.path == '/healthz':
                    return self._send(200, health())
                # No server-to-client event stream.
                self._send(405, None, {'Allow': 'POST, DELETE'})

            def do_DELETE(self):
                self._send(200 if self.path == '/mcp' else 404)

            def do_POST(self):
                if self.path != '/mcp':
                    return self._send(404)
                if self.headers.get('Origin'):
                    return self._send(403, {'error': 'browser requests are not accepted'})
                n = int(self.headers.get('Content-Length') or 0)
                if n <= 0 or n > 1024 * 1024:
                    return self._send(413 if n > 0 else 400)
                try:
                    req = json.loads(self.rfile.read(n))
                except ValueError:
                    return self._send(400, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})
                if isinstance(req, list):
                    out = [r for r in (server.handle(x, call_tool) for x in req[:50]) if r is not None]
                    return self._send(200, out) if out else self._send(202)
                resp = server.handle(req, call_tool)
                if resp is None:
                    return self._send(202)
                extra = {}
                if isinstance(req, dict) and req.get('method') == 'initialize':
                    extra['Mcp-Session-Id'] = secrets.token_hex(16)
                self._send(200, resp, extra)

        return Handler
