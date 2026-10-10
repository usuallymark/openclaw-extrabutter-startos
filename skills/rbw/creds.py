"""Credential lookup for OpenClaw skills.

    import sys; sys.path.insert(0, '/opt/skills/rbw')
    from creds import auth_headers, getcred
    hdrs = auth_headers('X-N8N-API-KEY', 'N8N_KEY')                # raises if not configured
    hdrs = auth_headers('Authorization', 'TRILIUM_KEY', required=False)  # {} if not configured
    getcred('N8N_KEY')                       # the raw value, if a header won't do

Works for both "Enter manually" (plain env var) and "Fetch from Vaultwarden"
(<VAR>_FROM_VAULT pointer, resolved with rbw by /usr/local/bin/getcred).
Never print or store the returned value. Don't assign it to a variable whose
name ends in KEY, TOKEN, SECRET or PASSWORD in code you show or copy: OpenClaw
redacts such lines in tool output, which breaks code copied from it.

Service settings (N8N_URL, NAS_HOST, ...) and the credential pointers live
in the environment of the OpenClaw gateway and of everything it starts.
A shell opened another way (a root `start-cli package attach` shell, a git
hook) lacks them; use_gateway_env() / setting() then read them from the
running gateway process, so helpers behave the same there.
"""

import os
import subprocess

_GETCRED = '/usr/local/bin/getcred' if os.path.exists('/usr/local/bin/getcred') else 'getcred'


class CredentialError(RuntimeError):
    pass


# The gateway is the process started with OPENCLAW_HEALTH_TARGETS (main.ts).
_MARKER = b'OPENCLAW_HEALTH_TARGETS='
_gateway_cache = None


def gateway_environ():
    """Environment of the running OpenClaw gateway as a dict ({} if not found)."""
    global _gateway_cache
    if _gateway_cache is not None:
        return _gateway_cache
    found = {}
    me = os.getpid()
    pids = sorted(int(p) for p in os.listdir('/proc') if p.isdigit())
    for pid in pids:
        if pid == me:
            continue
        try:
            with open(f'/proc/{pid}/environ', 'rb') as f:
                raw = f.read()
        except OSError:
            continue
        items = raw.split(b'\0')
        if not any(i.startswith(_MARKER) for i in items):
            continue
        for item in items:
            k, sep, v = item.partition(b'=')
            if sep:
                found[k.decode(errors='replace')] = v.decode(errors='replace')
        break
    _gateway_cache = found
    return found


def use_gateway_env(primary, prefix=None):
    """If `primary` (e.g. 'CRAWL4AI_URL') is not set here, copy every variable
    starting with `prefix` (default: up to and including the first '_', e.g.
    'CRAWL4AI_') from the gateway process into os.environ. Variables already
    set here are kept. Returns True if `primary` is now set."""
    if os.environ.get(primary):
        return True
    prefix = prefix or primary.split('_', 1)[0] + '_'
    for k, v in gateway_environ().items():
        if k.startswith(prefix) and not os.environ.get(k):
            os.environ[k] = v
    return bool(os.environ.get(primary))


def setting(name, default=''):
    """A setting from this process's environment, else from the gateway's."""
    return os.environ.get(name) or gateway_environ().get(name) or default


def not_configured(var, service):
    """Error text for a missing setting that says where it was looked for."""
    gw = ('the gateway process' if gateway_environ()
          else 'a running gateway (none this user can read: is OpenClaw running?)')
    return (f'{var} is not set in this process or in {gw}, so {service} is not configured: '
            f'enable it in Configure External Services.')


def auth_headers(header, var, required=True, prefix=''):
    """{header: prefix + credential}, or {} if optional and not configured.

    Lets skill code send a credential without ever naming it in a variable.
    """
    value = getcred(var, required=required)
    return {header: prefix + value} if value else {}


def getcred(var, required=True):
    r = subprocess.run([_GETCRED, var], capture_output=True, text=True)
    if r.returncode != 0:
        if not required and 'is not configured' in r.stderr:
            return ''
        raise CredentialError(r.stderr.strip() or f'{var} is not available')
    return r.stdout
