#!/usr/bin/env python3
"""Import a vCard file for the contacts service (run as root by Configure
Contacts, never by an agent).

    importvcf.py NAME [--keep]

Reads NAME from the workspace folder contacts-import (opened one folder at
a time without following links: the gateway user owns the workspace),
checks it is a readable vCard file, and writes it as the service's
/data/.openclaw-contacts/contacts.vcf (owner: the folder's owner, group
openclaw-contacts, 0640). Unless --keep, the workspace copy is removed
afterwards, so the agents no longer have it. Prints one JSON line: the
number of contacts, or the error.
"""

import sys

sys.path.insert(0, '/opt/openclaw-contacts')

import json  # noqa: E402
import os  # noqa: E402
import pwd  # noqa: E402
import stat  # noqa: E402

import vcard  # noqa: E402
from launcher import Launcher  # noqa: E402

IMPORT_DIR = '/data/.openclaw/workspace/contacts-import'
ROOT = '/data/.openclaw-contacts'
TARGET = 'contacts.vcf'
MAX_FILE = 64 * 1024 * 1024


def out(**kw):
    print(json.dumps(kw))
    sys.exit(0 if kw.get('ok') else 1)


def main(argv):
    if len(argv) < 2 or os.geteuid() != 0:
        out(ok=False, error='usage: importvcf.py NAME [--keep] (as root)')
    name = argv[1]
    keep = '--keep' in argv[2:]
    if not name or '/' in name or name.startswith('.') or '\x00' in name or len(name) > 200:
        out(ok=False, error='give a file name directly in the workspace folder contacts-import')
    try:
        group = pwd.getpwnam('openclaw-contacts').pw_gid
    except KeyError:
        out(ok=False, error='the user openclaw-contacts is missing from the image')
    try:
        src_dir = Launcher.walk(IMPORT_DIR)
    except OSError as e:
        out(ok=False, error=f'the workspace folder contacts-import cannot be opened ({e.strerror}); create it and put '
                            'the file there')
    try:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=src_dir)
        except OSError as e:
            out(ok=False, error=f'cannot open "{name}" in contacts-import ({e.strerror})')
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                out(ok=False, error=f'"{name}" is not a regular file')
            if st.st_size > MAX_FILE:
                out(ok=False, error=f'"{name}" is larger than {MAX_FILE // (1024 * 1024)} MB')
            with os.fdopen(os.dup(fd), 'rb') as f:
                raw = f.read(MAX_FILE + 1)
        finally:
            os.close(fd)
        text = raw.decode('utf-16', 'replace') if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else raw.decode('utf-8', 'replace')
        try:
            contacts, problems = vcard.parse(text)
        except ValueError as e:
            out(ok=False, error=f'"{name}": {e}')
        if not contacts:
            out(ok=False, error=f'"{name}" has no contacts in it')
        try:
            root_fd = Launcher.walk(ROOT)
        except OSError as e:
            out(ok=False, error=f'{ROOT} cannot be opened without following a link ({e.strerror})')
        try:
            owner = os.fstat(root_fd).st_uid
            tmp = TARGET + '.new'
            try:
                os.unlink(tmp, dir_fd=root_fd)
            except FileNotFoundError:
                pass
            wfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
            try:
                view = memoryview(text.encode('utf-8'))
                while view:
                    n = os.write(wfd, view)
                    view = view[n:]
                os.fchown(wfd, owner, group)
                os.fchmod(wfd, 0o640)
            finally:
                os.close(wfd)
            os.replace(tmp, TARGET, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        finally:
            os.close(root_fd)
        removed = False
        if not keep:
            try:
                os.unlink(name, dir_fd=src_dir)
                removed = True
            except OSError:
                pass
    finally:
        os.close(src_dir)
    out(ok=True, count=len(contacts), problems=problems[:5], removed=removed)


if __name__ == '__main__':
    main(sys.argv)
