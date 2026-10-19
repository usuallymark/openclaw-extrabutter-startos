#!/usr/bin/env python3
"""Gitea helper for OpenClaw: repositories on the user's own Gitea.

    python3 /opt/skills/gitea/gitea.py whoami
    python3 /opt/skills/gitea/gitea.py repos [--json]
    python3 /opt/skills/gitea/gitea.py create NAME [--description TEXT] [--public] [--org ORG]
    python3 /opt/skills/gitea/gitea.py remote OWNER/REPO
    python3 /opt/skills/gitea/gitea.py identity [--force]
    python3 /opt/skills/gitea/gitea.py check [--fix]

Settings come from Configure External Services → Gitea (GITEA_URL and the
access token via getcred). git signs in to Gitea by itself (the package's
credential helper); nothing here prints or stores the token. Run as root (a
`start-cli package attach` shell), it re-runs itself as the agent's user
(node, HOME=/data), so it sees and changes the same git setup as the agent.

Exit status: 0 OK, 1 Gitea refused or failed, 2 not configured or bad arguments.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, '/opt/skills/rbw')
from creds import CredentialError, auth_headers, not_configured, use_gateway_env  # noqa: E402

SCAN_ROOT = os.environ.get('GITEA_SCAN_ROOT', '/data')
SCAN_DEPTH = 6
SKIP_DIRS = {'node_modules', '.cache', '.npm', 'rbw', 'gog', '.venv', 'venv', '__pycache__'}


class GiteaError(RuntimeError):
    pass


class NotConfigured(GiteaError):
    pass


def as_agent_user():
    """Re-run this script as node with HOME=/data when started as root."""
    if os.geteuid() != 0:
        return
    os.execvp('runuser', ['runuser', '-u', 'node', '--', 'env', 'HOME=/data',
                          sys.executable, os.path.abspath(__file__), *sys.argv[1:]])


def base_url():
    use_gateway_env('GITEA_URL')
    url = os.environ.get('GITEA_URL', '').strip().rstrip('/')
    if not url:
        raise NotConfigured(not_configured('GITEA_URL', 'Gitea'))
    return url


def api(method, path, data=None, timeout=30):
    try:
        hdrs = auth_headers('Authorization', 'GITEA_KEY', prefix='token ')
    except CredentialError as e:
        raise GiteaError(f'the Gitea access token could not be read: {e}') from None
    hdrs['Accept'] = 'application/json'
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'{base_url()}/api/v1{path}', data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = r.read()
            return json.loads(out) if out else None
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read() or b'{}').get('message') or ''
        except ValueError:
            msg = ''
        hint = ''
        if e.code == 401:
            hint = ': the access token was refused (wrong or deleted token)'
        elif e.code == 403 and 'scope' in msg:
            hint = ('. The token lacks a permission: create one with "repository: Read and Write" '
                    'and "user: Read and Write" in Gitea → Settings → Applications')
        raise GiteaError(f'Gitea answered HTTP {e.code} to {method} {path}'
                         + (f' ({msg})' if msg else '') + hint) from None
    except (urllib.error.URLError, OSError) as e:
        raise GiteaError(f'Gitea unreachable at {base_url()}: {getattr(e, "reason", e)}') from None


def git(*args, cwd=None, check=False):
    """Run git (read-only calls never stop at "dubious ownership")."""
    r = subprocess.run(['git', '-c', 'safe.directory=*', *args], cwd=cwd,
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        raise GiteaError(f'git {" ".join(args)} failed: {r.stderr.strip()}')
    return r


def rewrites():
    """{original prefix: replacement} from git's url.<x>.insteadOf settings."""
    out = {}
    r = git('config', '--get-regexp', r'^url\..*\.insteadof$')
    for line in r.stdout.splitlines():
        key, _, value = line.partition(' ')
        out[value] = key[len('url.'):-len('.insteadof')]
    return out


REMOTE_PREFIX = 'gitea:'


def web_url(url):
    """A link for people: the internal (bridge) address swapped for
    GITEA_WEB_URL, a published address of Gitea on this server."""
    base = base_url()
    web = os.environ.get('GITEA_WEB_URL', '').strip().rstrip('/')
    if url and web and url.startswith(base + '/'):
        return web + url[len(base):]
    return url


def placeholder_mapped():
    return any(v.rstrip('/') == base_url() for k, v in rewrites().items() if k == REMOTE_PREFIX)


def remote_for(repo):
    """The remote URL to use for a repository (JSON from the API):
    gitea:OWNER/REPO.git. The package maps gitea: to Gitea's current address
    at every start, so the remote never goes stale. (Gitea's own clone URL is
    built from the address the request arrived at: for OpenClaw on this
    server the internal one, which changes when Gitea is reinstalled.)"""
    if placeholder_mapped():
        return f'{REMOTE_PREFIX}{repo["full_name"]}.git'
    return f'{base_url()}/{repo["full_name"]}.git'  # no mapping: restart OpenClaw


def cmd_whoami(_a):
    u = api('GET', '/user')
    print(f'Gitea account: {u.get("login")} ({u.get("full_name") or "no full name"}, {u.get("email") or "no email"}) at {base_url()}')


def all_repos():
    repos, page = [], 1
    while True:
        batch = api('GET', f'/user/repos?limit=50&page={page}') or []
        repos += batch
        if len(batch) < 50:
            return repos
        page += 1


def cmd_repos(a):
    repos = all_repos()
    if a.json:
        print(json.dumps([{'full_name': r['full_name'], 'private': r.get('private'),
                           'description': r.get('description'), 'remote': remote_for(r),
                           'web': web_url(r.get('html_url') or ''), 'updated': r.get('updated_at')} for r in repos], indent=2))
        return
    if not repos:
        print('No repositories yet.')
    for r in repos:
        print(f'{r["full_name"]}  ({"private" if r.get("private") else "public"})  {remote_for(r)}')


def cmd_create(a):
    body = {'name': a.name, 'private': not a.public, 'auto_init': False}
    if a.description:
        body['description'] = a.description
    path = f'/orgs/{urllib.parse.quote(a.org)}/repos' if a.org else '/user/repos'
    r = api('POST', path, body)
    print(f'Created {r["full_name"]} ({"public" if not r.get("private") else "private"}).')
    print(f'remote: {remote_for(r)}')
    print(f'web: {web_url(r.get("html_url") or "")}')


def cmd_remote(a):
    if '/' not in a.repo:
        raise GiteaError('give the repository as OWNER/REPO')
    owner, name = a.repo.split('/', 1)
    r = api('GET', f'/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name.removesuffix(".git"))}')
    print(remote_for(r))


def cmd_identity(a):
    name = git('config', '--global', 'user.name').stdout.strip()
    email = git('config', '--global', 'user.email').stdout.strip()
    if name and email and not a.force:
        print(f'git already commits as {name} <{email}>; left unchanged (--force to replace it with the Gitea account).')
        return
    u = api('GET', '/user')
    new_name = u.get('full_name') or u.get('login')
    new_email = u.get('email')
    if not new_email:
        raise GiteaError('the Gitea account has no email address to commit with; set one in Gitea or run git config yourself')
    git('config', '--global', 'user.name', new_name, check=True)
    git('config', '--global', 'user.email', new_email, check=True)
    print(f'git now commits as {new_name} <{new_email}> (the Gitea account {u.get("login")}).')


def find_repos(root=SCAN_ROOT, depth=SCAN_DEPTH):
    found = []
    root_depth = root.rstrip('/').count('/')
    for d, dirs, _files in os.walk(root):
        if '.git' in dirs:
            found.append(d)
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and x != '.git'
                   and d.count('/') - root_depth < depth]
    return sorted(found)


def strip_userinfo(url):
    p = urllib.parse.urlsplit(url)
    if not p.password:  # a bare user name (https://user@host/...) is no secret
        return None
    host = p.hostname or ''
    if p.port:
        host += f':{p.port}'
    return urllib.parse.urlunsplit((p.scheme, host, p.path, p.query, p.fragment))


def cmd_check(a):
    """Set-up report: token, git sign-in, identity, stored credentials and the
    repositories found under /data. --fix removes tokens written into Gitea
    remote URLs (git signs in by itself)."""
    problems = 0
    base = base_url()
    print(f'Gitea: {base}')
    try:
        u = api('GET', '/user')
        print(f'  [OK ] token accepted: account {u.get("login")}')
        token_ok = True
    except GiteaError as e:
        print(f'  [BAD] {e}')
        problems += 1
        token_ok = False

    helper = git('config', '--get-urlmatch', 'credential.helper', base + '/').stdout.strip()
    if helper.endswith('git-credential-openclaw'):
        print('  [OK ] git signs in to Gitea by itself (no token in repositories)')
    else:
        print(f'  [BAD] git has no OpenClaw sign-in for {base} (restart OpenClaw to rewrite /etc/gitconfig)')
        problems += 1
    mapped = {k: v for k, v in rewrites().items() if v.rstrip('/') == base}
    if REMOTE_PREFIX in mapped:
        print(f'  [OK ] remotes written as {REMOTE_PREFIX}OWNER/REPO.git go to Gitea at its current address')
    else:
        print(f'  [BAD] {REMOTE_PREFIX} remotes are not mapped to Gitea (restart OpenClaw to rewrite /etc/gitconfig)')
        problems += 1
    others = sorted(k.rstrip('/') for k in mapped if k != REMOTE_PREFIX)
    if others:
        print(f'  [OK ] remotes using {", ".join(others)} go to Gitea over the internal network')

    name = git('config', '--global', 'user.name').stdout.strip()
    email = git('config', '--global', 'user.email').stdout.strip()
    if name and email:
        print(f'  [OK ] commits are made as {name} <{email}>')
    else:
        print('  [!! ] no commit name/email set: run `gitea.py identity` to use the Gitea account\'s')

    home = os.path.expanduser('~')
    store = os.path.join(home, '.git-credentials')
    if os.path.exists(store):
        print(f'  [!! ] {store} holds passwords or tokens in plain text. Gitea no longer needs it: move any token to Vaultwarden (item gitea, field api_key) and delete the file.')
    helpers = git('config', '--global', '--get-regexp', r'^credential\..*helper$').stdout.splitlines()
    for line in helpers:
        key, _, value = line.partition(' ')
        ctx = key[len('credential.'):-len('.helper')].rstrip('/')
        if value == 'store':
            print(f'  [!! ] git is set to save passwords in plain text (git config --global --unset {key})')
        elif ctx and any(k.rstrip('/') == ctx for k in mapped):
            print(f'  [ i ] your own helper for {ctx} ({value}) is no longer used for Gitea: those remotes now go '
                  f'through the internal address. Remove it when convenient: git config --global --unset \'{key}\'')

    print(f'Repositories under {SCAN_ROOT}:')
    repos = find_repos()
    if not repos:
        print('  none')
    for path in repos:
        names = git('remote', cwd=path).stdout.split()
        if not names:
            print(f'  {path}: no remote')
            continue
        for rn in names:
            # As written in .git/config (`git remote get-url` applies insteadOf).
            url = git('config', '--get', f'remote.{rn}.url', cwd=path).stdout.strip()
            clean = strip_userinfo(url)
            # Where git really goes (insteadOf applied), judged without the
            # credentials, which stop the rewrite from matching.
            effective = git('ls-remote', '--get-url', clean or url, cwd=path).stdout.strip()
            to_gitea = effective.startswith(base + '/')
            shown = clean + ' (with credentials in the URL)' if clean else url
            where = 'Gitea' if to_gitea else 'another server'
            print(f'  {path}: {rn} {shown} → {where}')
            if not to_gitea:
                continue
            # Without credentials; a remote written with the internal (bridge)
            # address, which changes when Gitea is reinstalled, becomes gitea:.
            target = clean or url
            if target.startswith(base + '/') and REMOTE_PREFIX in mapped:
                target = REMOTE_PREFIX + target[len(base) + 1:]
            if clean:
                if a.fix and token_ok:
                    git('remote', 'set-url', rn, target, cwd=path, check=True)
                    print(f'      fixed: credentials removed from the URL (now {target}); git signs in by itself')
                elif a.fix:
                    print('      not fixed: the token above does not work yet, so git could not sign in without them')
                    problems += 1
                else:
                    print('      a token or password is stored in this URL: run `gitea.py check --fix` to remove it')
                    problems += 1
            elif target != url:
                if a.fix:
                    git('remote', 'set-url', rn, target, cwd=path, check=True)
                    print(f'      fixed: now {target}')
                else:
                    print('      uses the internal address, which changes when Gitea is reinstalled: '
                          f'`gitea.py check --fix` changes it to {target}')
                    problems += 1
    return 1 if problems else 0


def main():
    as_agent_user()
    ap = argparse.ArgumentParser(description='Repositories on Gitea (Configure External Services → Gitea).')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('whoami', help='the Gitea account the token belongs to')
    p = sub.add_parser('repos', help='repositories the account can use')
    p.add_argument('--json', action='store_true')
    p = sub.add_parser('create', help='create a repository (private unless --public)')
    p.add_argument('name')
    p.add_argument('--description')
    p.add_argument('--public', action='store_true')
    p.add_argument('--org', help='create it in this organization instead of the account')
    p = sub.add_parser('remote', help='the remote URL to use for OWNER/REPO')
    p.add_argument('repo')
    p = sub.add_parser('identity', help="commit as the Gitea account's name and email (if none is set)")
    p.add_argument('--force', action='store_true')
    p = sub.add_parser('check', help='set-up report; --fix removes tokens from Gitea remote URLs')
    p.add_argument('--fix', action='store_true')
    a = ap.parse_args()
    try:
        rc = globals()[f'cmd_{a.cmd}'](a)
        return rc or 0
    except NotConfigured as e:
        print(f'gitea: {e}', file=sys.stderr)
        return 2
    except GiteaError as e:
        print(f'gitea: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
