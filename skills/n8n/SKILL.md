---
name: n8n
description: "Use this skill to trigger and monitor n8n workflows. Triggers: any time you need to run an automated workflow, send data to n8n, or check the status of a running workflow."
---

# n8n — Workflow Automation

## Purpose

n8n is an open-source workflow automation tool. Use it to trigger automated
workflows, pass data between systems, and monitor background processes.

## Connection

- Base URL: `N8N_URL` (environment). If it is unset, n8n is not configured:
  tell the user to enable it in Configure External Services.
- REST API calls need the API key header. Build it with `auth_headers`,
  which works for both "Enter manually" and "Fetch from Vaultwarden" and
  keeps the key out of your code. Never print or store the key.
- Webhooks need no key.

## Trigger a Workflow via Webhook

```python
import json, os, urllib.request

base = os.environ['N8N_URL']

def trigger_webhook(webhook_path, data):
    req = urllib.request.Request(
        f'{base}/webhook/{webhook_path}',
        data=json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

result = trigger_webhook('my-webhook-path', {'hello': 'world'})
```

## REST API

```python
import json, os, urllib.request
import sys; sys.path.insert(0, '/opt/skills/rbw')
from creds import auth_headers

base = os.environ['N8N_URL']

def n8n_api(method, path, data=None):
    hdrs = auth_headers('X-N8N-API-KEY', 'N8N_KEY')
    hdrs['Accept'] = 'application/json'
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'{base}/api/v1{path}', data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None

for wf in n8n_api('GET', '/workflows').get('data', []):
    print(f"{wf['id']}: {wf['name']} ({'active' if wf['active'] else 'inactive'})")
```

Other calls use the same helper, e.g. `n8n_api('GET', '/executions?limit=10')`.

## Notes

- Activating, deactivating, editing or deleting workflows changes the
  user's automations: only do it when the user asked for that specific
  change, and say exactly what you changed.
- For long code, write a script file and run it rather than a long
  `python3 -c` one-liner.
- HTTPS to internal hosts works when the internal CA was added in Configure
  External Services; on a certificate error, report it rather than turning
  verification off or switching to http://.
- Find a webhook path in n8n → Workflow → Webhook node.
