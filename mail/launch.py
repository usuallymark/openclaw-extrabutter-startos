#!/usr/bin/env python3
"""Start the mail service (the StartOS daemon "mail" runs this as root).

1. Check the mail folder is the package's own (owned by root, not a link),
   and set the owners and modes the service relies on.
   The package writes the sending rules (rules.json) and the owner's
   approvals (decisions/) here; the service can read them, not write them.
2. Get the password: the manual one from the settings, or from Vaultwarden
   through the vault service (as root, after a sync, so a password changed
   in Vaultwarden is seen; since 2026.10.1:27 the agents cannot read it).
3. Become the openclaw-mail user and replace this process with the service
   (the worker), handing it the settings and password on stdin. No password
   file is written and nothing privileged keeps running. The worker serves
   front.py (daemon "mail-front", the MCP endpoint) over a Unix socket.

The service exits when the mailbox refuses the password (and every few
minutes while it waits for a new one); StartOS then runs this again.
"""

import sys

sys.path.insert(0, '/opt/openclaw-mail')

import json  # noqa: E402
import os  # noqa: E402
import pwd  # noqa: E402
import stat  # noqa: E402

from launcher import Launcher, vault_field  # noqa: E402

MAIL_ROOT = '/data/.openclaw-mail'
SETTINGS = f'{MAIL_ROOT}/settings.json'
STATE = f'{MAIL_ROOT}/state'
WORKSPACE = '/data/.openclaw/workspace'
INBOX = f'{WORKSPACE}/mail-inbox'
OUTBOX = f'{WORKSPACE}/mail-outbox'
RULES = f'{MAIL_ROOT}/rules.json'
DECISIONS = f'{MAIL_ROOT}/decisions'
SERVICE = '/opt/openclaw-mail/mailservice.py'
CAL_SETTINGS = '/data/.openclaw-calendar/settings.json'
CAL_USER = 'openclaw-calendar'
MAIL_USER = 'openclaw-mail'
GMAIL = {'imap': {'host': 'imap.gmail.com', 'port': 993, 'security': 'tls'},
         'smtp': {'host': 'smtp.gmail.com', 'port': 465, 'security': 'tls'}}


L = Launcher('mail launcher')
say, fail, own_dir, open_dir_fd = L.say, L.fail, L.own_dir, L.open_dir_fd


def vault_password():
    """(password, error, note) from Vaultwarden item "email", field
    "password", through the vault service (as root; agents cannot read it)."""
    password, error, note = vault_field('email:password')
    if error:
        error = error.replace('it could not be fetched', 'the password could not be fetched', 1)
    return password, error, note


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        fail('must start as root')
    try:
        mail = pwd.getpwnam(MAIL_USER)
        node = pwd.getpwnam('node')
    except KeyError as e:
        fail(f'user {e} is missing from the image')

    # The folder is created by the package (as root). Anything else in its
    # place was not, and is not trusted. main passes the owner it saw (in
    # case the package runtime is not uid 0 here).
    owner = L.package_root(MAIL_ROOT, node.pw_uid, 'MAIL_ROOT_UID', 'open Configure Email and save',
                           'Remove it and save Configure Email again.')
    os.chown(MAIL_ROOT, owner, mail.pw_gid)
    os.chmod(MAIL_ROOT, 0o710)
    own_dir(STATE, mail.pw_uid, mail.pw_gid, 0o700)
    # Sending rules and the owner's approvals: written by the package (as
    # root), readable by the service, never writable by it.
    own_dir(DECISIONS, owner, mail.pw_gid, 0o750)
    try:
        rst = os.lstat(RULES)
        if stat.S_ISREG(rst.st_mode) and rst.st_uid == owner:
            os.chown(RULES, owner, mail.pw_gid, follow_symlinks=False)
            os.chmod(RULES, 0o640)
        else:
            say(f'{RULES} is not the package\'s own file; sending stays at Drafts only')
            os.unlink(RULES)
    except FileNotFoundError:
        pass

    try:
        sst = os.lstat(SETTINGS)
        if not stat.S_ISREG(sst.st_mode) or sst.st_uid != owner:
            fail(f'{SETTINGS} is not the package\'s own file; refusing to start')
        os.chmod(SETTINGS, 0o600)
        with open(SETTINGS) as f:
            settings = json.load(f)
    except FileNotFoundError:
        fail('no email settings; open Configure Email')
    except ValueError as e:
        fail(f'the email settings cannot be read: {e}')

    acct = settings.get('account') or {}
    mode = acct.get('mode')
    if mode not in ('gmail', 'imap') or not acct.get('address'):
        fail('email is not set to Gmail or IMAP in Configure Email; nothing to run')
    imap = GMAIL['imap'] if mode == 'gmail' else acct.get('imap') or {}
    if not imap.get('host'):
        fail('no IMAP server is set in Configure Email')
    smtp = GMAIL['smtp'] if mode == 'gmail' else acct.get('smtp') or {}

    # Where released attachments go: a workspace folder the agents can read.
    inbox_fd = -1
    try:
        if os.path.isdir(WORKSPACE) and not os.path.islink(WORKSPACE):
            own_dir(INBOX, node.pw_uid, mail.pw_gid, 0o2775)
            inbox_fd = open_dir_fd(INBOX, node.pw_uid, mail.pw_gid)
    except (OSError, SystemExit) as e:
        say(f'the workspace folder mail-inbox could not be prepared ({e}); attachments cannot be released')
    # Files the main agent wants attached to a draft. The service only reads
    # them (group openclaw-mail; new files inherit the group).
    outbox_fd = -1
    try:
        if os.path.isdir(WORKSPACE) and not os.path.islink(WORKSPACE):
            own_dir(OUTBOX, node.pw_uid, mail.pw_gid, 0o2770)
            outbox_fd = open_dir_fd(OUTBOX, node.pw_uid, mail.pw_gid)
            # Files already there: group openclaw-mail, group-readable. Each
            # is changed through its own descriptor (opened without following
            # a link), never by path, and keeps no setuid/setgid bit: the
            # gateway user owns this folder and could swap a file for a link.
            for n in os.listdir(outbox_fd):
                try:
                    fd = os.open(n, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY, dir_fd=outbox_fd)
                except OSError:
                    continue  # a link, or gone
                try:
                    st2 = os.fstat(fd)
                    if stat.S_ISREG(st2.st_mode):
                        os.fchown(fd, st2.st_uid, mail.pw_gid)
                        os.fchmod(fd, (st2.st_mode & 0o777) | 0o040)
                finally:
                    os.close(fd)
    except (OSError, SystemExit) as e:
        say(f'the workspace folder mail-outbox could not be prepared ({e}); drafts cannot have attachments')

    pw = acct.get('password') or {}
    note = ''
    if pw.get('source') == 'manual':
        password = pw.get('value') or None
        error = '' if password else 'no password is saved in Configure Email'
        source = 'manual'
    else:
        password, error, note = vault_password()
        source = 'vault'
    if password and mode == 'gmail':
        # Google shows app passwords in groups of four; the spaces are display only.
        password = password.replace(' ', '')
    if note:
        say(note)
    if error:
        say(error)

    # Invitations by mail (since :28): only while Configure Calendar is set to
    # "Read + invitations by mail"; then only the calendar service's user may
    # ask for one (read as root; that file is the package's).
    invites, cal_uid = False, None
    try:
        cst = os.lstat(CAL_SETTINGS)
        if stat.S_ISREG(cst.st_mode) and cst.st_uid in (0, owner) and cst.st_uid != node.pw_uid:
            with open(CAL_SETTINGS) as f:
                invites = (json.load(f) or {}).get('mode') == 'invite'
    except (OSError, ValueError, AttributeError):
        invites = False
    if invites:
        try:
            cal_uid = pwd.getpwnam(CAL_USER).pw_uid
        except KeyError:
            invites = False
            say(f'user {CAL_USER} is missing from the image; invitations by mail are off')

    agent = settings.get('agent') or {}
    payload = {
        'mode': mode,
        'address': acct['address'],
        'displayName': acct.get('displayName') or '',
        'login': (acct.get('username') or '').strip() or acct['address'],
        'imap': {'host': imap['host'], 'port': int(imap.get('port') or 993), 'security': imap.get('security') or 'tls'},
        'smtp': ({'host': smtp['host'], 'port': int(smtp.get('port') or 465), 'security': smtp.get('security') or 'tls'}
                 if smtp.get('host') else None),
        'authservId': 'mx.google.com' if mode == 'gmail' else '',
        'trustedSenders': [str(t).strip().lower() for t in agent.get('trustedSenders') or [] if str(t).strip()],
        'stateDir': STATE,
        'socket': f'{STATE}/worker.sock',
        # Paths for messages; the service reaches them through the open
        # descriptors only.
        'inboxDir': INBOX if inbox_fd >= 0 else '',
        'inboxFd': inbox_fd,
        'outboxDir': OUTBOX if outbox_fd >= 0 else '',
        'outboxFd': outbox_fd,
        'rulesPath': RULES,
        'decisionsDir': DECISIONS,
        'invites': invites,
        'inviteCallerUid': cal_uid,
        'passwordSource': source,
        'password': password,
        'passwordError': error,
        'note': note,
    }
    del password
    L.exec_service(mail, SERVICE, payload, STATE, 'the email settings are too large')

if __name__ == '__main__':
    main()
