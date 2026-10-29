#!/usr/bin/env python3
"""Start the calendar service (the StartOS daemon "calendar" runs this as root).

1. Check the calendar folder is the package's own (owned by root, not a
   link), and set the owners and modes the service relies on.
2. Get the Google sign-in: the one pasted in Configure Calendar, or from
   Vaultwarden item "google-calendar" (field "token") through the gateway
   user's rbw, exactly as getcred does for the skills.
3. Become the openclaw-calendar user and replace this process with the
   worker, handing it the settings and sign-in on stdin. No sign-in file is
   written and nothing privileged keeps running.

The shared steps are in launcher.py (agentsvc/, copied next to this file).
"""

import sys

sys.path.insert(0, '/opt/openclaw-calendar')

import json  # noqa: E402
import os  # noqa: E402
import pwd  # noqa: E402
import stat  # noqa: E402

from launcher import Launcher, vault_field  # noqa: E402

CAL_ROOT = '/data/.openclaw-calendar'
SETTINGS = f'{CAL_ROOT}/settings.json'
STATE = f'{CAL_ROOT}/state'
SERVICE = '/opt/openclaw-calendar/calservice.py'
CAL_USER = 'openclaw-calendar'
VAULT_POINTER = 'google-calendar:token'

L = Launcher('calendar launcher')


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        L.fail('must start as root')
    try:
        cal = pwd.getpwnam(CAL_USER)
        node = pwd.getpwnam('node')
    except KeyError as e:
        L.fail(f'user {e} is missing from the image')

    owner = L.package_root(CAL_ROOT, node.pw_uid, 'CALENDAR_ROOT_UID', 'open Configure Calendar and save',
                           'Remove it and save Configure Calendar again.')
    os.chown(CAL_ROOT, owner, cal.pw_gid)
    os.chmod(CAL_ROOT, 0o710)
    L.own_dir(STATE, cal.pw_uid, cal.pw_gid, 0o700)

    try:
        sst = os.lstat(SETTINGS)
        if not stat.S_ISREG(sst.st_mode) or sst.st_uid != owner:
            L.fail(f'{SETTINGS} is not the package\'s own file; refusing to start')
        os.chmod(SETTINGS, 0o600)
        with open(SETTINGS) as f:
            settings = json.load(f)
    except FileNotFoundError:
        L.fail('no calendar settings; open Configure Calendar')
    except ValueError as e:
        L.fail(f'the calendar settings cannot be read: {e}')

    if settings.get('mode') != 'read':
        L.fail('Calendar is off in Configure Calendar; nothing to run')

    tok = settings.get('token') or {}
    note = ''
    if tok.get('source') == 'manual':
        token = tok.get('value') or None
        error = '' if token else 'no Calendar sign-in is saved in Configure Calendar'
        source = 'manual'
    else:
        token, error, note = vault_field(node, 'CAL_TOKEN', VAULT_POINTER)
        if error:
            error = f'the Calendar sign-in (Vaultwarden item "google-calendar", field "token"): {error}'
        source = 'vault'
    if note:
        L.say(note)
    if error:
        L.say(error)

    endpoints = None
    test = os.environ.get('CALENDAR_TEST_ENDPOINTS') or ''
    if test:
        # Local test rigs only: a stand-in for Google. Never set by the package.
        try:
            endpoints = json.loads(test)
        except ValueError:
            L.fail('CALENDAR_TEST_ENDPOINTS is not JSON')

    payload = {
        'mode': 'read',
        'account': str(settings.get('account') or ''),
        'trustedOrganizers': [str(t).strip().lower() for t in settings.get('trustedOrganizers') or [] if str(t).strip()],
        'stateDir': STATE,
        'socket': f'{STATE}/worker.sock',
        'tokenSource': source,
        'token': token,
        'tokenError': error,
        'note': note,
        'endpoints': endpoints,
    }
    del token
    L.exec_service(cal, SERVICE, payload, STATE, 'the calendar settings are too large')


if __name__ == '__main__':
    main()
