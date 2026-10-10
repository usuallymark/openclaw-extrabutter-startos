---
name: trilium
description: "Use this skill to create, read, and organize notes in Trilium Notes. Triggers: any time you need to save research, create a structured note, or retrieve information from Trilium."
---

# Trilium Notes

## Purpose

Trilium Notes is a hierarchical note-taking application. Use it to create
and organize research notes, summaries, and structured information that
should persist outside of AI memory.

## Connection

- Base URL: `TRILIUM_URL` (environment; ends in `/etapi`). If it is unset,
  Trilium is not configured: tell the user to enable it in Configure
  External Services.
- Every call needs the ETAPI token header. Build it with `auth_headers`,
  which works for both "Enter manually" and "Fetch from Vaultwarden" and
  keeps the token out of your code. Never print or store the token.

## Helper

```python
import json, os, urllib.parse, urllib.request
import sys; sys.path.insert(0, '/opt/skills/rbw')
from creds import auth_headers

base = os.environ['TRILIUM_URL']

def etapi(method, path, data=None, raw=False):
    hdrs = auth_headers('Authorization', 'TRILIUM_KEY')
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'{base}{path}', data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = resp.read()
        if raw:
            return out.decode()
        return json.loads(out) if out else None
```

## Create a Note

```python
result = etapi('POST', '/create-note', {
    'parentNoteId': 'root',
    'title': 'Research Note',
    'type': 'text',
    'content': '<p>Content here</p>',
})
print(result['note']['noteId'])
```

## Search Notes

```python
found = etapi('GET', '/notes?search=' + urllib.parse.quote('photo pipeline'))
for n in found.get('results', []):
    print(n['noteId'], n['title'])
```

## Get Note Content

```python
html = etapi('GET', f'/notes/{note_id}/content', raw=True)
```

## Notes

- Content is HTML for text notes; use plain `<p>` tags for simple notes.
- `root` is the top-level parent note ID.
- Find note IDs in Trilium via the note's menu → Note Info.
- Deleting or overwriting notes: confirm with the user first.
- For long code, write a script file and run it rather than a long
  `python3 -c` one-liner.
