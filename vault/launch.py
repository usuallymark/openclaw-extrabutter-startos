#!/usr/bin/env python3
"""Start the vault service (the StartOS daemon "vault" runs this as root).

1. Check /data/.openclaw-vault is the package's own folder (owned by root,
   not a link, in a /data the gateway user cannot rename things in), and
   set the owners and modes the service relies on:

       /data/.openclaw-vault            root, 0711 (anyone may pass, nobody may list or add)
         settings.json                  root 0600: Vaultwarden address and sign-in email (the package's)
         owners.json                    root 0644: which items belong to which service (the package's)
         credentials                    openclaw-vault 0600: the master password
         rbw/                           openclaw-vault 0700: rbw's settings, local vault copy, agent socket
         state/                         openclaw-vault 0700: activity log
         run/vault.sock                 openclaw-vault, 0666 (who gets what: broker.py)

2. Move the master password out of the gateway user's folder, where it
   lived until 2026.10.1:26 (/data/.openclaw/rbw/.credentials), and remove
   rbw's old files there (its sign-in and local copy of the vault).
3. Write rbw's settings and become openclaw-vault, replacing this process
   with the service (broker.py). Nothing privileged keeps running.
"""

import sys

sys.path.insert(0, '/opt/openclaw-vault')

import json  # noqa: E402
import os  # noqa: E402
import pwd  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402

from launcher import Launcher  # noqa: E402

ROOT = '/data/.openclaw-vault'
SETTINGS = f'{ROOT}/settings.json'
CREDENTIALS = f'{ROOT}/credentials'
RBW_HOME = f'{ROOT}/rbw'
STATE = f'{ROOT}/state'
RUN = f'{ROOT}/run'
SERVICE = '/opt/openclaw-vault/broker.py'
PINENTRY = '/opt/openclaw-vault/pinentry'
VAULT_USER = 'openclaw-vault'

OLD_RBW = '/data/.openclaw/rbw'
OLD_GONE = [f'{OLD_RBW}/.credentials', f'{OLD_RBW}/pinentry-file.sh', f'{OLD_RBW}/config/rbw',
            f'{OLD_RBW}/cache/rbw', f'{OLD_RBW}/runtime/rbw', '/data/.local/share/rbw']

L = Launcher('vault launcher')


def read_regular(path, max_bytes, owners=None):
    """Bytes of a regular file opened without following a link (anywhere
    on the way), or None if there is none. owners: allowed uids."""
    try:
        dfd = L.walk(os.path.dirname(path))
    except OSError:
        return None
    try:
        try:
            fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        except OSError:
            return None
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes or (owners and st.st_uid not in owners):
                return None
            return os.read(fd, max_bytes + 1)
        finally:
            os.close(fd)
    finally:
        os.close(dfd)


def write_owned(path, data, uid, gid, mode):
    """Replace path (in a folder only root and the service can write) with
    data, owned uid:gid, never through a link."""
    dfd = L.walk(os.path.dirname(path))
    name = os.path.basename(path)
    tmp = f'.{name}.tmp{os.getpid()}'
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
        os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    finally:
        os.close(dfd)


def remove_old(path):
    """Remove one of rbw's old files or folders in the gateway user's
    folder (rmtree on Linux works by descriptor and follows no link)."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError:
        return False
    try:
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(path)
        else:
            os.unlink(path)
        return True
    except OSError as e:
        L.say(f'could not remove the old {path} ({e.strerror}); it holds no usable secret without the master password')
        return False


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        L.fail('must start as root')
    try:
        vu = pwd.getpwnam(VAULT_USER)
        node = pwd.getpwnam('node')
    except KeyError as e:
        L.fail(f'user {e} is missing from the image')

    owner = L.package_root(ROOT, node.pw_uid, 'VAULT_ROOT_UID', 'restart OpenClaw',
                           'Remove it and restart OpenClaw.')
    rfd = L.walk(ROOT)
    try:
        os.fchown(rfd, owner, vu.pw_gid)
        os.fchmod(rfd, 0o711)
    finally:
        os.close(rfd)
    for d, mode in ((RBW_HOME, 0o700), (STATE, 0o700), (RUN, 0o755)):
        L.own_dir(d, vu.pw_uid, vu.pw_gid, mode)
    for sub in ('config', 'config/rbw', 'cache', 'data', 'runtime'):
        L.own_dir(f'{RBW_HOME}/{sub}', vu.pw_uid, vu.pw_gid, 0o700)

    # Settings: the package's own file (root, in this folder), never the
    # gateway user's: an agent that could change the Vaultwarden address
    # could have the master password's sign-in sent to a server of its own.
    raw = read_regular(SETTINGS, 64 * 1024, owners={owner})
    try:
        settings = json.loads(raw) if raw is not None else {}
    except ValueError:
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    url = str(settings.get('url') or '').strip().rstrip('/')
    email = str(settings.get('email') or '').strip()

    # The master password: here, or moved from the gateway user's folder.
    have = read_regular(CREDENTIALS, 4096, owners={owner, vu.pw_uid})
    if have is None:
        old = read_regular(f'{OLD_RBW}/.credentials', 4096, owners={node.pw_uid, owner})
        if old is not None:
            write_owned(CREDENTIALS, old, vu.pw_uid, vu.pw_gid, 0o600)
            L.say('moved the Vaultwarden master password into the vault service\'s folder')
            have = old
        del old
    else:
        write_owned(CREDENTIALS, have, vu.pw_uid, vu.pw_gid, 0o600)
    removed = [p for p in OLD_GONE if remove_old(p)]
    if removed:
        L.say(f'removed rbw\'s old files from the gateway user\'s folders ({len(removed)})')

    enabled, why = True, ''
    if not settings.get('enabled'):
        enabled, why = False, 'Vaultwarden is not set up in Configure External Services'
    elif not url or not email:
        enabled, why = False, 'Configure External Services has no Vaultwarden address or email'
    elif not have:
        enabled, why = False, 'no Vaultwarden master password is saved: enter it in Configure External Services'
    del have
    if why:
        L.say(why)
    if enabled:
        write_owned(f'{RBW_HOME}/config/rbw/config.json',
                    json.dumps({'email': email, 'base_url': url, 'lock_timeout': 3600,
                                'pinentry': PINENTRY}).encode(),
                    vu.pw_uid, vu.pw_gid, 0o600)

    payload = {
        'enabled': enabled,
        'offReason': why,
        'url': url,
        'nodeUid': node.pw_uid,
        'ownersPath': f'{ROOT}/owners.json',
        'socket': f'{RUN}/vault.sock',
        'stateDir': STATE,
        'env': {
            'HOME': RBW_HOME,
            'XDG_CONFIG_HOME': f'{RBW_HOME}/config',
            'XDG_CACHE_HOME': f'{RBW_HOME}/cache',
            'XDG_DATA_HOME': f'{RBW_HOME}/data',
            'XDG_RUNTIME_DIR': f'{RBW_HOME}/runtime',
            'RBW_AGENT': '/usr/libexec/openclaw-vault/rbw-agent',
            'PATH': '/usr/libexec/openclaw-vault:/usr/bin:/bin',
            'LANG': 'C.UTF-8',
        },
    }
    L.exec_service(vu, SERVICE, payload, STATE, 'the vault settings are too large')


if __name__ == '__main__':
    main()
