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

## How the vault works here

The vault (rbw, its keys and the Vaultwarden master password) belongs to the
**vault service**, not to you: you cannot read its files or run rbw itself.
The `rbw` command you have asks that service, and so do `getcred` and
`creds.py`. It keeps the everyday commands:

```bash
rbw get [--field FIELD] NAME    # a field of an item (default: the password)
rbw list                        # item names
rbw sync                        # sync with Vaultwarden (at most every 30 s)
rbw unlocked                    # exit 0 when the vault is unlocked
```

Adding, editing or removing items happens in Vaultwarden itself (ask the
user), then `rbw sync`.

**Items that belong to a service are refused**, by design: the email
password (`email`), the Calendar sign-in (`google-calendar`) and the
calendar links' items go only to the mail and calendar services, so their
rules and the owner's approvals cannot be stepped around. For mail or
calendar work, ask the apps agent (or the email/calendar agent) as your
email and calendar skills say. Do not look for another way to those items.

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

The vault service answers from its local copy of the vault and syncs once
on a miss, so an item added or corrected in Vaultwarden is found without a
manual sync.

Do not assign a credential to a variable whose name ends in `KEY`,
`TOKEN`, `SECRET` or `PASSWORD`, or to `password`/`api_key`-style names.
OpenClaw masks the right-hand side of such assignments in tool output, so
code you read back or copy from output arrives broken (the call is replaced
by `***`). Pass the value straight into a header or function call instead.

## Fetching a Credential

```bash
python3 -c "
import subprocess, sys

def rbw_get(entry, field='password'):
    r = subprocess.run(['rbw', 'get', '--field', field, entry], capture_output=True, text=True)
    if r.returncode != 0:
        print(f'ERROR: {entry}/{field}: {r.stderr.strip()}', file=sys.stderr)
        return None
    return r.stdout.rstrip('\\n')

# Example: pass the value straight on; never print it.
headers = {'X-N8N-API-KEY': rbw_get('n8n', 'api_key')}
"
```

## Naming Standard

One Vaultwarden item per service, named after the service in lowercase:
- Logins (`email`, `nas`, …): the item's own `username` and `password`.
- API keys: a hidden custom field `api_key`.
- Names are matched without regard to case, so older items such as `NAS`
  or a field `API_Key` still work. An exact name wins; otherwise the one
  item whose name contains it.

| Service | Item | Field |
|---|---|---|
| Email | `email` | `password` (the mail service's: refused to agents while it is on) |
| NAS | `nas` | `username`, `password` |
| n8n | `n8n` | `api_key` |
| Trilium | `trilium` | `api_key` |
| Crawl4AI | `crawl4ai` | `api_key` |
| ntfy | `ntfy` | `api_key` |
| Gitea | `gitea` | `api_key` (git signs in with it by itself; see the gitea skill) |
| Google account | `google` | `client_json`, `token_json` (read only by the package at start) |

Services the package configures are read for you through `getcred`; use
`rbw_get` only for items the user set up for your own scripts, following
the same standard.

## Checking Vault Status

```bash
rbw unlocked && echo "UNLOCKED" || echo "LOCKED"
rbw sync && echo "SYNCED" || echo "SYNC FAILED"
```

If a lookup fails with the vault locked or "the vault service is not
answering", the master password is missing or wrong, or Vaultwarden is
down: the **Vault** line in StartOS says which. If the sync fails, lookups
still answer from the local copy, but items added or renamed in Vaultwarden
since then are missing; ask the user to restart OpenClaw, which signs in to
Vaultwarden again.
