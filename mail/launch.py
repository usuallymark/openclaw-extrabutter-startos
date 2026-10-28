#!/usr/bin/env python3
"""Start the mail service (the StartOS daemon "mail" runs this as root).

1. Check the mail folder is the package's own (owned by root, not a link),
   and set the owners and modes the service relies on.
   The package writes the sending rules (rules.json) and the owner's
   approvals (decisions/) here; the service can read them, not write them.
2. Get the password: the manual one from the settings, or from Vaultwarden
   through the gateway user's rbw (sync first, so a password changed in
   Vaultwarden is seen), exactly as getcred does for the skills.
3. Become the openclaw-mail user and replace this process with the service
   (the worker), handing it the settings and password on stdin. No password
   file is written and nothing privileged keeps running. The worker serves
   front.py (daemon "mail-front", the MCP endpoint) over a Unix socket.

The service exits when the mailbox refuses the password (and every few
minutes while it waits for a new one); StartOS then runs this again.
"""

import json
import os
import pwd
import stat
import subprocess
import sys

MAIL_ROOT = '/data/.openclaw-mail'
SETTINGS = f'{MAIL_ROOT}/settings.json'
STATE = f'{MAIL_ROOT}/state'
WORKSPACE = '/data/.openclaw/workspace'
INBOX = f'{WORKSPACE}/mail-inbox'
OUTBOX = f'{WORKSPACE}/mail-outbox'
RULES = f'{MAIL_ROOT}/rules.json'
DECISIONS = f'{MAIL_ROOT}/decisions'
SERVICE = '/opt/openclaw-mail/mailservice.py'
MAIL_USER = 'openclaw-mail'
RBW_ENV = {
    'XDG_CONFIG_HOME': '/data/.openclaw/rbw/config',
    'XDG_CACHE_HOME': '/data/.openclaw/rbw/cache',
    'XDG_RUNTIME_DIR': '/data/.openclaw/rbw/runtime',
    'HOME': '/data',
    'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
}
GMAIL = {'imap': {'host': 'imap.gmail.com', 'port': 993, 'security': 'tls'},
         'smtp': {'host': 'smtp.gmail.com', 'port': 465, 'security': 'tls'}}


def say(msg):
    print(f'mail launcher: {msg}', flush=True)


def fail(msg):
    say(msg)
    sys.exit(1)


def own_dir(path, uid, gid, mode):
    """Make path a real directory with this owner and mode (never a link)."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        os.mkdir(path, mode)
        st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        fail(f'{path} is not a directory (a link or file is in its place); refusing to start')
    os.chown(path, uid, gid, follow_symlinks=False)
    os.chmod(path, mode)


def first_line(s):
    return next((ln.strip() for ln in (s or '').splitlines() if ln.strip()), '')


def vault_password(node):
    """(password, error, note) from Vaultwarden item "email", as node."""
    run = dict(user=node.pw_uid, group=node.pw_gid, extra_groups=[], capture_output=True,
               text=True, cwd='/data')
    note = ''
    try:
        r = subprocess.run(['rbw', 'sync'], env=RBW_ENV, timeout=90, **run)
        if r.returncode != 0:
            note = f'rbw sync failed ({first_line(r.stderr) or "exit " + str(r.returncode)}), so a password changed in Vaultwarden may not be seen yet'
    except subprocess.TimeoutExpired:
        note = 'rbw sync did not answer within 90 s, so a password changed in Vaultwarden may not be seen yet'
    env = {**RBW_ENV, 'EMAIL_PASS_FROM_VAULT': 'email:password'}
    try:
        r = subprocess.run(['/usr/local/bin/getcred', 'EMAIL_PASS'], env=env, timeout=90, **run)
    except subprocess.TimeoutExpired:
        return None, 'Vaultwarden did not answer within 90 s', note
    if r.returncode != 0 or not r.stdout:
        why = first_line(r.stderr).replace('getcred: ', '') or 'no answer'
        return None, f'the password could not be fetched from Vaultwarden: {why}', note
    return r.stdout, '', note


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
    # place was not, and is not trusted.
    try:
        st = os.lstat(MAIL_ROOT)
    except FileNotFoundError:
        fail(f'{MAIL_ROOT} does not exist; open Configure Email and save')
    # The package creates it as root; main passes the owner it saw (in case
    # the package runtime is not uid 0 here). The gateway user never counts.
    expected = {0}
    if (os.environ.get('MAIL_ROOT_UID') or '').isdigit():
        expected.add(int(os.environ['MAIL_ROOT_UID']))
    expected.discard(node.pw_uid)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid not in expected:
        fail(f'{MAIL_ROOT} is not the package\'s own folder (owner uid {st.st_uid}); refusing to start. '
             'Remove it and save Configure Email again.')
    owner = st.st_uid
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
    inbox_ok = False
    try:
        if os.path.isdir(WORKSPACE) and not os.path.islink(WORKSPACE):
            own_dir(INBOX, node.pw_uid, mail.pw_gid, 0o2775)
            inbox_ok = True
    except (OSError, SystemExit) as e:
        say(f'the workspace folder mail-inbox could not be prepared ({e}); attachments cannot be released')
    # Files the main agent wants attached to a draft. The service only reads
    # them (group openclaw-mail; new files inherit the group).
    outbox_ok = False
    try:
        if os.path.isdir(WORKSPACE) and not os.path.islink(WORKSPACE):
            own_dir(OUTBOX, node.pw_uid, mail.pw_gid, 0o2770)
            for n in os.listdir(OUTBOX):
                p = os.path.join(OUTBOX, n)
                st2 = os.lstat(p)
                if stat.S_ISREG(st2.st_mode):
                    os.chown(p, st2.st_uid, mail.pw_gid, follow_symlinks=False)
                    os.chmod(p, (st2.st_mode & 0o7777) | 0o040)
            outbox_ok = True
    except (OSError, SystemExit) as e:
        say(f'the workspace folder mail-outbox could not be prepared ({e}); drafts cannot have attachments')

    pw = acct.get('password') or {}
    note = ''
    if pw.get('source') == 'manual':
        password = pw.get('value') or None
        error = '' if password else 'no password is saved in Configure Email'
        source = 'manual'
    else:
        password, error, note = vault_password(node)
        source = 'vault'
    if password and mode == 'gmail':
        # Google shows app passwords in groups of four; the spaces are display only.
        password = password.replace(' ', '')
    if note:
        say(note)
    if error:
        say(error)

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
        'inboxDir': INBOX if inbox_ok else '',
        'outboxDir': OUTBOX if outbox_ok else '',
        'rulesPath': RULES,
        'decisionsDir': DECISIONS,
        'passwordSource': source,
        'password': password,
        'passwordError': error,
        'note': note,
    }
    data = json.dumps(payload).encode()
    del password, payload
    r, w = os.pipe()
    if len(data) > 60000:
        fail('the email settings are too large')
    os.write(w, data)
    os.close(w)
    del data
    os.dup2(r, 0)
    os.close(r)

    os.setgroups([])
    os.setgid(mail.pw_gid)
    os.setuid(mail.pw_uid)
    if os.getuid() == 0 or os.geteuid() == 0:
        fail('could not drop root')
    env = {'PATH': '/usr/bin:/bin', 'HOME': STATE, 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
    os.chdir(STATE)
    os.execve('/usr/bin/python3', ['python3', '-I', SERVICE], env)


if __name__ == '__main__':
    main()
