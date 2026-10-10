---
name: rbw
description: "Use this skill to fetch credentials from Vaultwarden via rbw. Triggers: any time you need a password, API key, token, or secret that is stored in Vaultwarden. Do not call rbw unless Vaultwarden is configured."
---

# rbw — Vaultwarden Credential Fetching

## Purpose

Fetch credentials from Vaultwarden at runtime using the rbw CLI. This avoids
hardcoding any secrets in skills, workspace files, or code. All credentials
used by other skills should be fetched via this skill rather than stored
elsewhere.

## When to Use

Call this skill whenever you need a credential that is stored in Vaultwarden:
- API keys for external services
- Passwords for NAS, databases, or services
- Tokens for Trilium, n8n, Gitea, etc.

Do NOT call rbw if Vaultwarden is not configured — check the environment first.

## Environment

rbw is installed at `/usr/bin/rbw`. Configuration and cache are stored at:
- Config: `/data/.openclaw/rbw/config/rbw/config.json`
- Cache: `/data/.openclaw/rbw/cache/`
- Runtime: `/data/.openclaw/rbw/runtime/`

The vault is unlocked automatically at startup if Vaultwarden is configured.
rbw uses a non-interactive pinentry, so if the vault has locked (timeout or
agent restart), the next `rbw get` unlocks it again on its own.

## Credentials of configured services: use auth_headers / getcred

For credentials set in Configure External Services (`NAS_USER`, `NAS_PASS`,
`N8N_KEY`, `TRILIUM_KEY`, `CRAWL4AI_KEY`, `NTFY_KEY`), never call rbw yourself. These
helpers work whether the user chose "Enter manually" or "Fetch from
Vaultwarden" (the `<VAR>_FROM_VAULT` pointers are resolved for you):

```python
import sys; sys.path.insert(0, '/opt/skills/rbw')
from creds import auth_headers, getcred
hdrs = auth_headers('X-N8N-API-KEY', 'N8N_KEY')                  # raises if not configured
hdrs = auth_headers('Authorization', 'NTFY_KEY', required=False, prefix='Bearer ')  # {} if not configured
getcred('N8N_KEY')                                                # raw value, if a header won't do
```

From a shell: `getcred N8N_KEY` (prints without a newline; exit 1 if not
configured).

These settings live in the environment of the gateway and of the commands
it runs for you. In a shell that was not started by the gateway (a root
debug shell, a git hook), `getcred`, `creds.setting('N8N_URL')` and the
nas/crawl4ai/ntfy helpers read them from the running gateway process
instead. To run any command exactly as the gateway would (its environment,
as user node): `gateway-env python3 script.py`.

rbw answers from a local copy of the vault. If a lookup fails or comes back
empty, getcred runs `rbw sync` once and tries again, so an entry added or
corrected in Vaultwarden is found without a manual sync. When calling rbw
directly and an entry seems missing, run `rbw sync` first.

Do not assign a credential to a variable whose name ends in `KEY`,
`TOKEN`, `SECRET` or `PASSWORD`, or to `password`/`api_key`-style names.
OpenClaw masks the right-hand side of such assignments in tool output, so
code you read back or copy from output arrives broken (the call is replaced
by `***`). Pass the value straight into a header or function call instead.

## Fetching a Credential

```bash
python3 -c "
import subprocess, sys

def rbw_get(entry, field=None):
    cmd = ['rbw', 'get', entry] if not field else ['rbw', 'get', '--field', field, entry]
    env = {
        'XDG_CONFIG_HOME': '/data/.openclaw/rbw/config',
        'XDG_CACHE_HOME': '/data/.openclaw/rbw/cache',
        'XDG_RUNTIME_DIR': '/data/.openclaw/rbw/runtime',
        'PATH': '/usr/bin:/usr/local/bin',
        'HOME': '/data',
    }
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        print(f'ERROR: rbw failed for {entry}/{field}: {result.stderr.strip()}', file=sys.stderr)
        return None
    return result.stdout.strip()

# Examples:
value = rbw_get('n8n', 'API_Key')
print(value)
"
```

## Entry Naming Convention

All Vaultwarden entries used by OpenClaw follow this convention:
- Entry name: the service name exactly as listed (e.g. `n8n`, `Trilium`, `NAS`, `Qdrant`)
- Field name: `API_Key` for API keys, `Password` for passwords, `username` for usernames

Example entries:
| Service | Entry Name | Field |
|---|---|---|
| n8n | `n8n` | `API_Key` |
| Trilium | `Trilium` | `API_Key` |
| NAS username | `NAS` | `username` |
| NAS password | `NAS` | `Password` |
| Qdrant | `Qdrant` | `API_Key` |
| Gitea | `Gitea` | `API_Key` |
| Anthropic | `Anthropic` | `API_Key` |

## Checking Vault Status

```bash
rbw unlocked && echo "UNLOCKED" || echo "LOCKED"
```

If a `rbw get` still fails with the vault locked, the master password is
missing or wrong — check the `setup-vault` lines in the service logs.
