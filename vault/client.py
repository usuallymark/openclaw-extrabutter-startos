"""Client for the vault service (since 2026.10.1:27).

The vault (rbw, its unlocked keys and the master password) belongs to the
user openclaw-vault; nobody else can read it. Everything else asks the vault
service over its Unix socket, one JSON line each way:

    {"op": "get", "item": "nas", "field": "password"}   → {"ok": true, "value": "..."}
    {"op": "list"}                                       → {"ok": true, "items": [{"name": ..., ...}]}
    {"op": "sync"} / {"op": "status"} / {"op": "check"}

The service tells callers apart by their user id (the kernel's SO_PEERCRED),
and this client checks the same of the service, so a stand-in on the socket
path gets no request from root. Used by getcred, the rbw command the agents
see, the mail and calendar launchers and the package's health check.
"""

import json
import os
import pwd
import socket
import struct

SOCKET = '/data/.openclaw-vault/run/vault.sock'
VAULT_USER = 'openclaw-vault'


class VaultError(RuntimeError):
    """The vault service refused or could not answer; the text says why
    (never a secret)."""


def _peer_uid(sock):
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    return struct.unpack('3i', creds)[1]


def call(request, timeout=150):
    """One request; the answer as a dict. Raises VaultError."""
    try:
        want = pwd.getpwnam(VAULT_USER).pw_uid
    except KeyError:
        raise VaultError(f'the user {VAULT_USER} is missing from this image') from None
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        try:
            s.connect(SOCKET)
        except OSError as e:
            raise VaultError(f'the vault service is not answering ({e.strerror or e}); '
                             'is OpenClaw starting? The Vault line in StartOS says why') from None
        if _peer_uid(s) != want:
            raise VaultError('something other than the vault service is listening on its socket; refused')
        s.sendall(json.dumps(request).encode() + b'\n')
        buf = b''
        while not buf.endswith(b'\n'):
            part = s.recv(65536)
            if not part:
                break
            buf += part
            if len(buf) > 4 * 1024 * 1024:
                raise VaultError('the vault service answered too much')
    except socket.timeout:
        raise VaultError('the vault service did not answer in time') from None
    finally:
        s.close()
    try:
        answer = json.loads(buf)
    except ValueError:
        raise VaultError('the vault service gave no answer') from None
    if not isinstance(answer, dict):
        raise VaultError('the vault service gave an unreadable answer')
    if not answer.get('ok'):
        raise VaultError(str(answer.get('error') or 'refused'))
    return answer


def get(item, field='password', sync=False):
    """The value of one field of one Vaultwarden item. sync: sync with
    Vaultwarden first (root only; the launchers use it)."""
    return call({'op': 'get', 'item': item, 'field': field, 'sync': bool(sync)})['value']


def main(argv):
    """vault-client get ITEM [FIELD] | list | sync | status | check

    get prints the value without a newline (for getcred). Errors go to
    stderr, never a value."""
    import sys
    try:
        if len(argv) in (2, 3) and argv[0] == 'get':
            sys.stdout.write(get(argv[1], argv[2] if len(argv) == 3 else 'password'))
            return 0
        if argv == ['list']:
            for it in call({'op': 'list'})['items']:
                print(it['name'])
            return 0
        if len(argv) == 1 and argv[0] in ('sync', 'status', 'check'):
            a = call({'op': argv[0]})
            print(json.dumps({k: v for k, v in a.items() if k != 'ok'}))
            return 0
    except VaultError as e:
        print(f'vault: {e}', file=sys.stderr)
        return 1
    print(main.__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == '__main__':
    import sys
    sys.exit(main(sys.argv[1:]))
