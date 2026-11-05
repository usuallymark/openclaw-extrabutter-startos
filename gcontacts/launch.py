#!/usr/bin/env python3
"""Start the contacts service (the StartOS daemon "contacts" runs this as root).

1. Check the contacts folder is the package's own (owned by root, not a
   link), and set the owners and modes the service relies on: the folder
   root:openclaw-contacts 0710, the imported vCard file root, group
   openclaw-contacts, 0640 (the service reads it, nobody else can).
2. For the Google source, get the sign-in: pasted in Configure Contacts, or
   from Vaultwarden item "google-contacts" (field "token") through the
   vault service, as root (the agents cannot read that item).
3. Become the openclaw-contacts user and replace this process with the
   worker, handing it the settings and sign-in on stdin.
"""

import sys

sys.path.insert(0, '/opt/openclaw-contacts')

import json  # noqa: E402
import os  # noqa: E402
import pwd  # noqa: E402
import stat  # noqa: E402

from launcher import Launcher, vault_field  # noqa: E402

ROOT = '/data/.openclaw-contacts'
SETTINGS = f'{ROOT}/settings.json'
STATE = f'{ROOT}/state'
VCARD = f'{ROOT}/contacts.vcf'
CAL_SETTINGS = '/data/.openclaw-calendar/settings.json'
SERVICE = '/opt/openclaw-contacts/contactsservice.py'
USER = 'openclaw-contacts'
VAULT_POINTER = 'google-contacts:token'

L = Launcher('contacts launcher')


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        L.fail('must start as root')
    try:
        svc_user = pwd.getpwnam(USER)
        node = pwd.getpwnam('node')
    except KeyError as e:
        L.fail(f'user {e} is missing from the image')
    owner = L.package_root(ROOT, node.pw_uid, 'CONTACTS_ROOT_UID', 'open Configure Contacts and save',
                           'Remove it and save Configure Contacts again.')
    os.chown(ROOT, owner, svc_user.pw_gid)
    os.chmod(ROOT, 0o710)
    L.own_dir(STATE, svc_user.pw_uid, svc_user.pw_gid, 0o700)
    L.own_tree(STATE, svc_user.pw_uid, svc_user.pw_gid)
    try:
        sst = os.lstat(SETTINGS)
        if not stat.S_ISREG(sst.st_mode) or sst.st_uid != owner:
            L.fail(f'{SETTINGS} is not the package\'s own file; refusing to start')
        os.chmod(SETTINGS, 0o600)
        with open(SETTINGS) as f:
            settings = json.load(f)
    except FileNotFoundError:
        L.fail('no contacts settings; open Configure Contacts')
    except ValueError as e:
        L.fail(f'the contacts settings cannot be read: {e}')

    source = settings.get('source')
    if source not in ('vcard', 'google'):
        L.fail('Contacts is off in Configure Contacts; nothing to run')

    # The imported file: the package's, readable by the service's group only.
    try:
        fd = os.open(VCARD, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            st = os.fstat(fd)
            if stat.S_ISREG(st.st_mode) and st.st_uid == owner:
                os.fchown(fd, owner, svc_user.pw_gid)
                os.fchmod(fd, 0o640)
            else:
                L.say(f'{VCARD} is not the package\'s own file; it is not read')
        finally:
            os.close(fd)
    except OSError:
        pass  # none imported yet

    token, error, note, tsource = None, '', '', 'none'
    if source == 'google':
        tok = settings.get('token') or {}
        if tok.get('source') == 'manual':
            token = tok.get('value') or None
            error = '' if token else 'no Contacts sign-in is saved in Configure Contacts'
            tsource = 'manual'
        else:
            token, error, note = vault_field(VAULT_POINTER)
            if error:
                error = f'the Contacts sign-in (Vaultwarden item "google-contacts", field "token"): {error}'
            tsource = 'vault'
        if note:
            L.say(note)
        if error:
            L.say(error)

    zone = ''
    try:
        with open(CAL_SETTINGS) as f:
            zone = str((json.load(f) or {}).get('timeZone') or '')
    except (OSError, ValueError, AttributeError):
        pass

    endpoints = None
    test = os.environ.get('CONTACTS_TEST_ENDPOINTS') or ''
    if test:
        # Local test rigs only: a stand-in for Google. Never set by the package.
        try:
            endpoints = json.loads(test)
        except ValueError:
            L.fail('CONTACTS_TEST_ENDPOINTS is not JSON')

    payload = {
        'source': source,
        'account': str(settings.get('account') or ''),
        'stateDir': STATE,
        'socket': f'{STATE}/worker.sock',
        'vcardPath': VCARD,
        'timeZone': zone,
        'tokenSource': tsource,
        'token': token,
        'tokenError': error,
        'endpoints': endpoints,
    }
    del token
    L.exec_service(svc_user, SERVICE, payload, STATE, 'the contacts settings are too large')


if __name__ == '__main__':
    main()
