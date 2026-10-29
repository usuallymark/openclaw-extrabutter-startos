"""Small helpers shared by the package's isolated service workers.

Private files, the activity log, a delayed exit for the launcher to run the
worker again, and the worker's Unix-socket endpoint for the front door.
Copied into each service's folder in the image.
"""

import json
import os
import socketserver
import sys
import threading
from datetime import datetime, timezone


def now_text():
    return datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M %Z')


def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def write_private(path, data):
    """Replace path with data, mode 0600, never through a link."""
    tmp = f'{path}.tmp{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        write_all(fd, data)
    finally:
        os.close(fd)
    os.replace(tmp, path)


class ActivityLog:
    """Append-only JSON lines (never message or event bodies), rotated to
    .1 above max_bytes. Errors are swallowed: logging never breaks a call."""

    def __init__(self, path, max_bytes=5 * 1024 * 1024):
        self.path = path
        self.max_bytes = max_bytes
        self._lock = threading.Lock()

    def __call__(self, entry):
        entry = {'ts': now_text(), **entry}
        line = (json.dumps(entry, ensure_ascii=False) + '\n').encode()
        with self._lock:
            try:
                if os.path.exists(self.path) and os.path.getsize(self.path) > self.max_bytes:
                    os.replace(self.path, self.path + '.1')
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    write_all(fd, line)
                finally:
                    os.close(fd)
            except OSError:
                pass


def schedule_exit(code, delay):
    """Exit after delay seconds (the launcher then runs the worker again)."""
    def go():
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)
    t = threading.Timer(delay, go)
    t.daemon = True
    t.start()


class _UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def serve_unix(path, handler):
    """The worker's endpoint for the front door: a Unix socket in the state
    folder, mode 0600 (only the service user can open it)."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    srv = _UnixServer(path, handler)
    os.chmod(path, 0o600)
    return srv
