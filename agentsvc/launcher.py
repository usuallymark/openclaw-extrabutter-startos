"""Shared steps for the launchers of the package's isolated services.

A launcher starts as root (its StartOS daemon), checks the service folder
is the package's own, sets owners and modes, fetches the credentials,
opens any workspace folders the service needs (as descriptors: the service
user cannot pass through the gateway's private folders), then becomes the
service user and replaces itself with the worker, handing it everything on
stdin. Nothing privileged keeps running and no secret is written to disk.

Copied into each service's folder in the image.
"""

import json
import os
import stat
import sys


class Launcher:
    def __init__(self, label):
        self.label = label

    def say(self, msg):
        print(f'{self.label}: {msg}', flush=True)

    def fail(self, msg):
        self.say(msg)
        sys.exit(1)

    def own_dir(self, path, uid, gid, mode):
        """Make path a real directory with this owner and mode (never a link)."""
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            os.mkdir(path, mode)
            st = os.lstat(path)
        if not stat.S_ISDIR(st.st_mode):
            self.fail(f'{path} is not a directory (a link or file is in its place); refusing to start')
        os.chown(path, uid, gid, follow_symlinks=False)
        os.chmod(path, mode)

    @staticmethod
    def open_dir_fd(path, uid, gid):
        """Open a folder as root, component by component, following no link
        on the way, check its owner, and return an inheritable descriptor
        for the service (which then uses dir_fd only, never the path)."""
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.strip('/').split('/'):
                nfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nfd
            st = os.fstat(fd)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_gid != gid:
                raise OSError(f'{path} does not have the expected owner')
        except BaseException:
            os.close(fd)
            raise
        os.set_inheritable(fd, True)
        return fd

    def package_root(self, root, node_uid, owner_env, missing_hint, foreign_hint):
        """Check root is the package's own folder: a real directory owned by
        root, or by the uid the package passed in owner_env (in case the
        package runtime is not uid 0), never by the gateway user. Returns
        the owner uid."""
        try:
            st = os.lstat(root)
        except FileNotFoundError:
            self.fail(f'{root} does not exist; {missing_hint}')
        expected = {0}
        if (os.environ.get(owner_env) or '').isdigit():
            expected.add(int(os.environ[owner_env]))
        expected.discard(node_uid)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid not in expected:
            self.fail(f'{root} is not the package\'s own folder (owner uid {st.st_uid}); refusing to start. '
                      f'{foreign_hint}')
        return st.st_uid

    def exec_service(self, user, script, payload, state_dir, too_large):
        """Become user and replace this process with script, the payload
        (a dict, may hold secrets) on stdin. Never returns."""
        data = json.dumps(payload).encode()
        payload.clear()
        r, w = os.pipe()
        if len(data) > 60000:
            self.fail(too_large)
        os.write(w, data)
        os.close(w)
        del data
        os.dup2(r, 0)
        os.close(r)

        os.setgroups([])
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
        if os.getuid() == 0 or os.geteuid() == 0:
            self.fail('could not drop root')
        env = {'PATH': '/usr/bin:/bin', 'HOME': state_dir, 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        os.chdir(state_dir)
        os.execve('/usr/bin/python3', ['python3', '-I', script], env)
