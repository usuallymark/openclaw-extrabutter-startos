#!/usr/bin/env python3
"""Health report for this OpenClaw package, from inside its container.

Runs the same checks as the StartOS health list: gateway, Qdrant, webchat,
vault and every enabled external service, with the same URLs (the package
passes them in OPENCLAW_HEALTH_TARGETS). Adds disk and memory. Read-only and
prints no secrets. For services with an API key (n8n, Trilium) it also makes
one authenticated read request to that service, so a wrong or missing key
shows up here; the key is sent only to that service. Email logs in to the
IMAP and SMTP servers (himalaya account check); a Google account asks
Google to refresh its stored sign-in.

    python3 /opt/skills/health/health.py          # short text report
    python3 /opt/skills/health/health.py --json   # machine-readable

Exit status: 0 = everything OK, 1 = something is down, 2 = cannot run.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ENV_VAR = 'OPENCLAW_HEALTH_TARGETS'
RBW_ENV = {
    'XDG_CONFIG_HOME': '/data/.openclaw/rbw/config',
    'XDG_CACHE_HOME': '/data/.openclaw/rbw/cache',
    'XDG_RUNTIME_DIR': '/data/.openclaw/rbw/runtime',
}
DISK_WARN_PCT = 90
MEM_WARN_MB = 256


def load_targets():
    """Targets from our environment, or from the gateway process when run
    from a plain shell (e.g. a root `start-cli package attach` shell)."""
    raw = os.environ.get(ENV_VAR)
    source = 'environment'
    if not raw:
        for pid in sorted(os.listdir('/proc'), key=lambda p: (not p.isdigit(), p)):
            if not pid.isdigit():
                continue
            try:
                with open(f'/proc/{pid}/environ', 'rb') as f:
                    for item in f.read().split(b'\0'):
                        if item.startswith(ENV_VAR.encode() + b'='):
                            raw = item.split(b'=', 1)[1].decode()
                            source = f'gateway process {pid}'
                            break
            except OSError:
                continue
            if raw:
                break
    if not raw:
        return None, None
    return json.loads(raw), source


def first_line(s):
    for line in (s or '').splitlines():
        if line.strip():
            return line.strip()
    return ''


def check_http(t):
    ok_below = t.get('okBelow', 500)
    try:
        r = subprocess.run(
            ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', t['url']],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        return False, f"timed out at {t['url']}"
    code = int(r.stdout.strip() or 0) if r.stdout.strip().isdigit() else 0
    if r.returncode == 0 and 0 < code < ok_below:
        return True, f'reachable (HTTP {code})'
    if r.returncode == 0:
        return False, f"HTTP {code} at {t['url']}"
    return False, f"unreachable at {t['url']}: {first_line(r.stderr) or f'curl exit {r.returncode}'}"


# Services whose key can be checked with one cheap authenticated GET:
# key -> (credential var, header, prefix, path appended to the target URL).
# The unauthenticated probe above only proves the server answers (Trilium's
# ETAPI answers 401 without a token, which is fine there).
AUTH_CHECKS = {
    'n8n': ('N8N_KEY', 'X-N8N-API-KEY', '', '/api/v1/workflows?limit=1'),
    'trilium': ('TRILIUM_KEY', 'Authorization', '', '/app-info'),
}


def _base_url(t):
    # Targets carry the full probe URL; strip the probe path back off.
    probe = {'n8n': '/healthz', 'trilium': '/app-info'}.get(t['key'], '')
    url = t['url']
    return url[: -len(probe)] if probe and url.endswith(probe) else url.rstrip('/')


def check_auth(t, msg):
    """(ok, message) after an authenticated request, or None to keep the plain result."""
    spec = AUTH_CHECKS.get(t.get('key'))
    if not spec:
        return None
    var, header, prefix, path = spec
    sys.path.insert(0, '/opt/skills/rbw')
    try:
        from creds import CredentialError, auth_headers
        hdrs = auth_headers(header, var, required=False, prefix=prefix)
    except Exception as e:  # vault locked, entry missing, ...
        return False, f'{msg}, but its API key could not be read ({first_line(str(e))})'
    if not hdrs:
        return True, f'{msg}; no API key configured (agents cannot use it)'
    import urllib.error
    import urllib.request
    req = urllib.request.Request(_base_url(t) + path, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            code = r.status
            body = r.read(4096)
    except urllib.error.HTTPError as e:
        code, body = e.code, b''
    except (urllib.error.URLError, OSError) as e:
        return False, f'{msg}, but the authenticated request failed ({getattr(e, "reason", e)})'
    if 200 <= code < 300:
        extra = ''
        if t['key'] == 'trilium':
            try:
                extra = f", Trilium {json.loads(body).get('appVersion')}"
            except ValueError:
                pass
        return True, f'reachable, API key accepted (HTTP {code}{extra})'
    if code in (401, 403):
        return False, f'reachable, but the API key was rejected (HTTP {code}): check it in Configure External Services / Vaultwarden'
    return False, f'reachable, but the authenticated request answered HTTP {code}'


def check_tcp(t):
    try:
        r = subprocess.run(
            ['bash', '-c', 'timeout 5 bash -c "</dev/tcp/$H/$P" 2>&1'],
            env={**os.environ, 'H': t['host'], 'P': str(t['port'])},
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        return False, f"timed out at {t['host']}:{t['port']}"
    if r.returncode == 0:
        return True, f"reachable ({t['host']}:{t['port']})"
    why = '(timed out)' if r.returncode == 124 else (first_line(r.stdout) or f'exit {r.returncode}')
    return False, f"unreachable at {t['host']}:{t['port']} {why}"


def check_vault(_t):
    # `rbw unlocked` only asks the agent. A locked vault unlocks itself on the
    # next `rbw get`, so that is reported but rarely fatal. Then `rbw sync`:
    # rbw keeps answering from its local copy when Vaultwarden refuses it, so
    # a failed sync means vault edits no longer reach OpenClaw.
    env = {**os.environ, **RBW_ENV}

    def rbw(*args):
        cmd = ['rbw', *args]
        if os.geteuid() == 0:
            cmd = ['runuser', '-u', 'node', '--', 'env'] + [f'{k}={v}' for k, v in RBW_ENV.items()] + cmd
        return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)

    try:
        r = rbw('unlocked')
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, f'check error: {e.__class__.__name__}'
    if r.returncode != 0:
        return False, 'locked (the next credential lookup will try to unlock it; if that fails, check the Vaultwarden settings)'
    try:
        s = rbw('sync')
    except subprocess.TimeoutExpired:
        return False, 'unlocked, but the sync with Vaultwarden did not finish within 60 s'
    if s.returncode == 0:
        return True, 'unlocked, synced with Vaultwarden'
    why = first_line(s.stderr) or f'exit {s.returncode}'
    return False, (f'unlocked, but the sync with Vaultwarden fails ({why}): changes made in '
                   'Vaultwarden do not reach OpenClaw. If Vaultwarden is running, ask the user '
                   'to restart OpenClaw, which signs in to Vaultwarden again')


def check_memory(_t):
    # Plain `openclaw memory status` reads the index state without calling the
    # embedding provider (no cost). It tells whether vector search works.
    env = {**os.environ, 'HOME': '/data', 'OPENCLAW_STATE_DIR': '/data/.openclaw', 'NO_COLOR': '1'}
    cmd = ['openclaw', 'memory', 'status', '--agent', 'main']
    if os.geteuid() == 0:
        cmd = ['runuser', '-u', 'node', '--', 'env', 'HOME=/data', 'OPENCLAW_STATE_DIR=/data/.openclaw',
               'NO_COLOR=1'] + cmd
    try:
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=90)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, f'could not read memory status ({e.__class__.__name__})'
    out = r.stdout + r.stderr
    def field(name):
        for line in out.splitlines():
            line = line.strip()
            if line.startswith(name + ':'):
                return line.split(':', 1)[1].strip()
        return ''
    provider, model, vector = field('Provider'), field('Model'), field('Vector search')
    if r.returncode != 0 and not provider:
        return False, f'memory status failed: {first_line(out) or f"exit {r.returncode}"}'
    if provider.startswith('none') or 'requested: none' in provider:
        return True, 'keyword search only (no embeddings, as configured)'
    if vector.startswith('paused') or field('Index identity'):
        return False, (f'vector search paused ({provider}, {model or "?"}): the index was built for another '
                       'model or without embeddings. Rebuild once: openclaw memory status --index --agent main')
    return True, f'embeddings via {provider}' + (f', {model}' if model else '')


def _service_env(keys):
    """Our environment plus the given variables from the gateway process
    (a root attach shell has none of the service settings)."""
    env = dict(os.environ)
    missing = [k for k in keys if k not in env]
    if missing:
        sys.path.insert(0, '/opt/skills/rbw')
        try:
            from creds import gateway_environ
            gw = gateway_environ()
        except Exception:
            gw = {}
        for k in missing:
            if k in gw:
                env[k] = gw[k]
    return env


def _as_node(cmd, env, keys):
    """Run as the gateway user when we are root (the files belong to node)."""
    if os.geteuid() == 0:
        return ['runuser', '-u', 'node', '--', 'env', 'HOME=/data'] + \
            [f'{k}={env[k]}' for k in keys if k in env] + cmd
    return cmd


def check_email_login(t, msg):
    """IMAP server reachable: also log in to IMAP and SMTP (himalaya account
    check). himalaya fetches the password through getcred; it is never shown."""
    keys = ['HIMALAYA_CONFIG', 'EMAIL_PASS', 'EMAIL_PASS_FROM_VAULT',
            'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']
    env = _service_env(keys)
    env.setdefault('HIMALAYA_CONFIG', '/data/.openclaw/himalaya/config.toml')

    def account_check(extra, timeout):
        """{'imap': 'OK'|'FAIL (…)', 'smtp': …}, or a string saying why it could not run."""
        try:
            r = subprocess.run(_as_node(['himalaya', 'account', 'check'] + extra, env, keys),
                               env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return f'no answer within {timeout} s'
        except FileNotFoundError as e:
            return f'could not run ({e.__class__.__name__})'
        # `account check` exits 0 even when a backend fails; read its lines.
        status = {}
        for line in (r.stdout + r.stderr).splitlines():
            line = line.strip()
            for proto in ('imap', 'smtp'):
                if line.startswith(proto + ':'):
                    status[proto] = line.split(':', 1)[1].strip()
        return status or (first_line(r.stderr) or first_line(r.stdout) or f'exit {r.returncode}')

    # IMAP alone first: quick, and a wrong password fails here (both servers
    # share it). Some SMTP servers keep the connection open after refusing a
    # login, so SMTP is checked only after IMAP passed, with its own limit.
    imap = account_check(['-b', 'imap'], 30)
    if isinstance(imap, str):
        return False, f'{msg}, but the IMAP login check failed: {imap}'
    if not imap.get('imap', '').startswith('OK'):
        return False, f'{msg}, but: IMAP {imap.get("imap", "?")}'
    full = account_check([], 45)
    if isinstance(full, str):
        return False, f'{msg}; IMAP login OK, but the SMTP check failed: {full}'
    smtp = full.get('smtp', '')
    if smtp.startswith('OK'):
        return True, f'{msg}; IMAP and SMTP logins OK'
    return False, f'{msg}; IMAP login OK, but: SMTP {smtp or "not checked"}'


def check_google(t):
    """Google account: ask Google to refresh the stored sign-in (gog auth list --check)."""
    keys = ['GOG_HOME', 'GOG_KEYRING_BACKEND', 'GOG_KEYRING_PASSWORD', 'GOG_ACCOUNT']
    env = _service_env(keys)
    if 'GOG_KEYRING_PASSWORD' not in env:
        return False, 'the Google sign-in settings are not available here (is OpenClaw running?)'
    try:
        r = subprocess.run(_as_node(['gog', 'auth', 'list', '--check', '--json', '--no-input'], env, keys),
                           env=env, capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, f'the Google sign-in check could not run ({e.__class__.__name__})'
    try:
        accounts = json.loads(r.stdout or '{}').get('accounts', [])
    except ValueError:
        accounts = None
    if accounts is None or (not accounts and r.returncode != 0):
        return False, f'the Google sign-in could not be read: {first_line(r.stderr) or f"exit {r.returncode}"}'
    want = (t.get('address') or '').lower()
    acct = next((a for a in accounts if str(a.get('email', '')).lower() == want), None)
    if not acct:
        return False, (f'not signed in as {t.get("address")}: add the OAuth client and sign-in token in '
                       'Configure External Services → Email')
    services = ', '.join(acct.get('services') or [])
    if acct.get('valid'):
        return True, (f'signed in as {acct["email"]}' + (f' ({services})' if services else '')
                      + ', token accepted by Google')
    return False, (f'the sign-in for {acct["email"]} was refused: {first_line(str(acct.get("error", "")))}. '
                   'Renew it in Configure External Services → Email')


CHECKS = {'http': check_http, 'tcp': check_tcp, 'vault': check_vault, 'memory': check_memory,
          'google': check_google}


def run_check(t):
    start = time.monotonic()
    try:
        ok, msg = CHECKS[t['kind']](t)
        if ok and t['kind'] == 'http':
            authed = check_auth(t, msg)
            if authed:
                ok, msg = authed
        if ok and t['kind'] == 'tcp' and t['key'] == 'email':
            ok, msg = check_email_login(t, msg)
    except Exception as e:  # never crash the report over one check
        ok, msg = False, f'check error: {e.__class__.__name__}: {first_line(str(e))}'
    return {'key': t['key'], 'label': t['label'], 'ok': ok, 'message': msg,
            'ms': int((time.monotonic() - start) * 1000)}


def resources():
    out = []
    try:
        du = shutil.disk_usage('/data')
        pct = round(du.used * 100 / du.total)
        out.append({'key': 'disk', 'label': 'Disk /data', 'ok': pct < DISK_WARN_PCT,
                    'message': f'{pct}% used, {du.free // 2**30} GiB free of {du.total // 2**30} GiB'})
    except OSError as e:
        out.append({'key': 'disk', 'label': 'Disk /data', 'ok': False, 'message': f'error: {e}'})
    try:
        info = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, v = line.split(':', 1)
                info[k] = int(v.split()[0])
        avail = info.get('MemAvailable', 0) // 1024
        total = info.get('MemTotal', 0) // 1024
        out.append({'key': 'memory', 'label': 'Memory', 'ok': avail >= MEM_WARN_MB,
                    'message': f'{avail} MiB available of {total} MiB'})
    except (OSError, ValueError) as e:
        out.append({'key': 'memory', 'label': 'Memory', 'ok': False, 'message': f'error: {e}'})
    tess = shutil.which('tesseract')
    if not tess:
        out.append({'key': 'pdf', 'label': 'PDF/OCR tools', 'ok': False, 'message': 'tesseract not found'})
    else:
        try:
            r = subprocess.run([tess, '--list-langs'], capture_output=True, text=True, timeout=15)
            langs = {ln.strip() for ln in (r.stdout + r.stderr).splitlines()[1:]}
            ok = 'eng' in langs
            out.append({'key': 'pdf', 'label': 'PDF/OCR tools', 'ok': ok,
                        'message': 'Tesseract with English' if ok else 'Tesseract has no English data'})
        except (subprocess.TimeoutExpired, OSError) as e:
            out.append({'key': 'pdf', 'label': 'PDF/OCR tools', 'ok': False, 'message': f'error: {e}'})
    return out


def main():
    as_json = '--json' in sys.argv[1:]
    targets, source = load_targets()
    if targets is None:
        msg = (f'{ENV_VAR} is not set and no gateway process was found. '
               'Run this inside the openclaw container while the service is running.')
        print(json.dumps({'ok': False, 'error': msg}) if as_json else f'health: {msg}', file=sys.stdout if as_json else sys.stderr)
        return 2
    if shutil.which('openclaw'):
        targets = targets + [{'key': 'memory', 'label': 'Memory search', 'kind': 'memory'}]
    with ThreadPoolExecutor(max_workers=max(1, len(targets))) as pool:
        results = list(pool.map(run_check, targets))
    results += resources()
    ok = all(r['ok'] for r in results)
    report = {'ok': ok, 'checked_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'source': source, 'checks': results}
    if as_json:
        print(json.dumps(report, indent=2))
    else:
        down = [r for r in results if not r['ok']]
        print(f"OpenClaw health: {'all OK' if ok else f'{len(down)} problem(s)'} ({report['checked_at']})")
        for r in results:
            print(f"  [{'OK ' if r['ok'] else 'BAD'}] {r['label']}: {r['message']}")
        print('Service logs and restarts are not visible from here: ask the user '
              '(StartOS UI → OpenClaw Extra Butter, or `sudo start-cli package logs openclaw-extrabutter -l 200` on the Start9).')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
