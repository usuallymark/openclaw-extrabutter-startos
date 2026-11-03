"""The vault service (since 2026.10.1:27): the only holder of the vault.

Runs as openclaw-vault (vault/launch.py starts it as root and drops to that
user). It signs in to Vaultwarden with rbw, keeps rbw's agent unlocked and
answers requests on a Unix socket (client.py has the protocol). rbw's files
and the master password are this user's alone, so the gateway user (every
OpenClaw agent and its shell) can no longer read them.

Who gets what, by the caller's user id (SO_PEERCRED, from the kernel):

- root: the package (the mail and calendar launchers, the health check) —
  any item.
- node: OpenClaw (every agent and skill) — any item no service owns.
  Items a service owns (owners.json, written by the package from Configure
  Email and Configure Calendar) are refused: the email password, the
  Calendar sign-in and the calendar links' secret addresses go only to
  their service, so an agent cannot use them to step around that service's
  rules and approvals.
- anyone else: nothing.

The caller names an item; this service finds it itself (exact name, any
case; else the one item whose name contains it, as rbw does) and asks rbw
for it by its id. A caller's text never reaches rbw, which would also match
it as an id or a web address and so reach an owned item another way.
"""

import json
import os
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import svcutil  # noqa: E402

RBW = '/usr/libexec/openclaw-vault/rbw'
START_SCRIPT = '/opt/openclaw-vault/start.sh'
NODE_SYNC_EVERY_S = 30
MAX_REQUEST = 64 * 1024


def first_line(s):
    return next((ln.strip() for ln in (s or '').splitlines() if ln.strip()), '')


def _clean_name(v, what, limit=200):
    if not isinstance(v, str):
        raise Refused(f'{what}: a name')
    v = v.strip()
    if not v or len(v) > limit or any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise Refused(f'{what}: a name of 1–{limit} characters')
    return v


class Refused(Exception):
    """A refusal or problem, in words the caller can show."""


class Vault:
    def __init__(self, cfg):
        self.cfg = cfg
        self.enabled = bool(cfg.get('enabled'))
        self.why_off = cfg.get('offReason') or 'Vaultwarden is not set up in Configure External Services'
        self.node_uid = int(cfg['nodeUid'])
        self.owners_path = cfg['ownersPath']
        self.env = dict(cfg['env'])
        self.lock = threading.RLock()
        self.log = svcutil.ActivityLog(os.path.join(cfg['stateDir'], 'activity.jsonl'))
        self.last_sync = 0.0
        self.sync_ok = None
        self.sync_error = ''
        self.starting = self.enabled

    # ── rbw ────────────────────────────────────────────────────────────────

    def rbw(self, *args, timeout=120):
        with self.lock:
            return subprocess.run([RBW, *args], env=self.env, capture_output=True, text=True,
                                  timeout=timeout, cwd=self.env['HOME'])

    def start(self):
        """Sign in, unlock and sync (start.sh: signs in again when
        Vaultwarden refuses the stored sign-in). Never raises."""
        if not self.enabled:
            print(f'vault: {self.why_off}; answering with that until it is', flush=True)
            return
        with self.lock:
            try:
                self._start()
            finally:
                self.starting = False

    def _start(self):
        try:
            r = subprocess.run(['sh', START_SCRIPT], env={**self.env, 'VW_URL': self.cfg['url']},
                               capture_output=True, text=True, timeout=600, cwd=self.env['HOME'])
            for line in (r.stdout + r.stderr).splitlines():
                if line.strip():
                    print(f'vault: {line.strip()}', flush=True)
            self.sync_ok = 'Vault synced' in r.stdout or 'vault synced' in r.stdout
            self.last_sync = time.time()
            if not self.sync_ok:
                self.sync_error = first_line(r.stderr) or 'see the service log'
        except (subprocess.TimeoutExpired, OSError) as e:
            self.sync_ok, self.sync_error = False, f'signing in did not finish ({type(e).__name__})'
            print(f'vault: {self.sync_error}', flush=True)

    def sync(self):
        try:
            r = self.rbw('sync', timeout=120)
            ok, err = r.returncode == 0, first_line(r.stderr)
        except subprocess.TimeoutExpired:
            ok, err = False, 'no answer from Vaultwarden within 120 s'
        self.last_sync, self.sync_ok, self.sync_error = time.time(), ok, '' if ok else (err or 'sync failed')
        return ok

    def unlocked(self):
        try:
            return self.rbw('unlocked', timeout=30).returncode == 0
        except subprocess.TimeoutExpired:
            return False

    # ── items ──────────────────────────────────────────────────────────────

    def owners(self):
        """{item name (lower case): service}, or None when the package's list
        cannot be read (then agents get nothing: fail closed)."""
        try:
            with open(self.owners_path) as f:
                d = json.load(f)
            items = d['items']
            if not isinstance(items, dict):
                return None
            return {str(k).strip().lower(): str(v) for k, v in items.items() if str(k).strip()}
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def entries(self):
        r = self.rbw('list', '--raw', timeout=60)
        if r.returncode != 0:
            raise Refused(f'the vault cannot be read ({first_line(r.stderr) or "rbw list failed"})')
        try:
            items = json.loads(r.stdout or '[]')
        except ValueError:
            raise Refused('the vault list could not be read') from None
        return [it for it in items if isinstance(it, dict) and it.get('id') and isinstance(it.get('name'), str)]

    @staticmethod
    def resolve(entries, needle):
        """The one item for this name: exact (any case), preferring items
        outside folders; else the one whose name contains it."""
        n = needle.lower()
        exact = [e for e in entries if e['name'].lower() == n]
        if len(exact) > 1:
            exact = [e for e in exact if not e.get('folder')] or exact
        if len(exact) == 1:
            return exact[0]
        if exact:
            raise Refused(f'several Vaultwarden items are named "{needle}"; give each a different name')
        part = [e for e in entries if n in e['name'].lower()]
        if len(part) == 1:
            return part[0]
        if part:
            raise Refused(f'no Vaultwarden item is named exactly "{needle}" and several names contain it')
        return None

    def get(self, caller, item, field, sync_first=False):
        item = _clean_name(item, 'item')
        field = _clean_name(field or 'password', 'field', 100)
        if not self.enabled:
            raise Refused(self.why_off)
        owners = self.owners()
        if caller == 'agent' and owners is None:
            raise Refused('the vault service cannot read which items belong to a service, so it gives agents '
                          'nothing; restart OpenClaw')
        if sync_first and caller == 'package':
            self.sync()
        for attempt in (1, 2):
            e = self.resolve(self.entries(), item)
            if e is not None:
                owner = (owners or {}).get(e['name'].strip().lower())
                if caller == 'agent' and owner:
                    raise Refused(f'the Vaultwarden item "{e["name"]}" belongs to the {owner} service, which '
                                  'alone may read it; agents cannot. Ask that service\'s agent for what you need')
                r = self.rbw('get', '--field', field, e['id'], timeout=60)
                value = (r.stdout or '').rstrip('\n') if r.returncode == 0 else None
                if value:
                    return e['name'], value
                why = (f'field "{field}" is empty' if r.returncode == 0
                       else first_line(r.stderr) or 'rbw get failed')
            else:
                why = 'no such item'
            if attempt == 1 and self.may_sync(caller):
                self.sync()
                continue
            note = ('' if self.sync_ok is not False else
                    f'; syncing with Vaultwarden also fails ({self.sync_error}), so recent Vaultwarden '
                    'changes are not here yet: if Vaultwarden is running, restart OpenClaw to sign in again')
            raise Refused(f'Vaultwarden item "{item}", field "{field}": {why}{note}')

    def may_sync(self, caller):
        return caller == 'package' or time.time() - self.last_sync >= NODE_SYNC_EVERY_S

    # ── requests ───────────────────────────────────────────────────────────

    def handle(self, caller, req):
        op = req.get('op')
        if op == 'get':
            name, value = self.get(caller, req.get('item'), req.get('field'), bool(req.get('sync')))
            self.log({'event': 'get', 'caller': caller, 'item': name, 'field': str(req.get('field') or 'password')[:100]})
            return {'value': value}
        if op == 'list':
            if not self.enabled:
                raise Refused(self.why_off)
            owners = self.owners() or {}
            return {'items': [{'name': e['name'], 'folder': e.get('folder') or '',
                               **({'service': owners[e['name'].strip().lower()]}
                                  if e['name'].strip().lower() in owners else {})}
                              for e in self.entries()]}
        if op == 'sync':
            if not self.enabled:
                raise Refused(self.why_off)
            if self.may_sync(caller):
                self.sync()
            return self.status_fields()
        if op == 'status':
            if self.starting:
                return {**self.status_fields(), 'starting': True, 'unlocked': False}
            return {**self.status_fields(), 'unlocked': self.enabled and self.unlocked()}
        if op == 'check' and caller == 'package':
            if not self.enabled:
                return {'enabled': False, 'reason': self.why_off}
            unlocked = self.unlocked()
            if not unlocked:
                # A get unlocks; try once through a plain list.
                try:
                    self.entries()
                except Refused:
                    pass
                unlocked = self.unlocked()
            self.sync()
            return {**self.status_fields(), 'unlocked': unlocked}
        raise Refused('unknown request')

    def status_fields(self):
        return {'enabled': self.enabled, 'starting': self.starting, 'sync_ok': self.sync_ok,
                'sync_error': self.sync_error, 'last_sync': self.last_sync}


class _Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def serve(vault, path):
    class Handler(socketserver.StreamRequestHandler):
        timeout = 30

        def handle(self):
            sock = self.request
            creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            _, uid, _ = struct.unpack('3i', creds)
            caller = 'package' if uid == 0 else 'agent' if uid == vault.node_uid else None
            req = {}
            try:
                line = self.rfile.readline(MAX_REQUEST + 1)
                if caller is None:
                    raise Refused('this user may not use the vault')
                if len(line) > MAX_REQUEST:
                    raise Refused('request too large')
                req = json.loads(line or b'{}')
                if not isinstance(req, dict):
                    raise Refused('bad request')
                out = {'ok': True, **vault.handle(caller, req)}
            except Refused as e:
                out = {'ok': False, 'error': str(e)}
                if caller:
                    vault.log({'event': 'refused', 'caller': caller,
                               'item': str((req if isinstance(req, dict) else {}).get('item') or '')[:200],
                               'detail': str(e)[:300]})
            except (ValueError, OSError):
                out = {'ok': False, 'error': 'bad request'}
            except subprocess.TimeoutExpired:
                out = {'ok': False, 'error': 'rbw did not answer in time'}
            except Exception as e:  # never a traceback (or a value) to the caller
                out = {'ok': False, 'error': f'internal error in the vault service ({type(e).__name__})'}
            try:
                self.wfile.write(json.dumps(out).encode() + b'\n')
            except OSError:
                pass

    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    old = os.umask(0o111)
    try:
        srv = _Server(path, Handler)
    finally:
        os.umask(old)
    os.chmod(path, 0o666)  # anyone may connect; who gets what is decided above
    return srv


def main():
    cfg = json.loads(sys.stdin.read())
    os.close(0)
    vault = Vault(cfg)
    srv = serve(vault, cfg['socket'])
    threading.Thread(target=vault.start, daemon=True).start()
    print(f'vault: serving {cfg["socket"]}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
