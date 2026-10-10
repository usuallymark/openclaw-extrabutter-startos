---
name: nas
description: "Use this skill to read and write files on the NAS (Network Attached Storage) via SMB. Triggers: any time you need to access files, photos, documents, or other content stored on the NAS, or to find out which NAS shares exist."
---

# NAS — Network Attached Storage

## Purpose

Read and write files on the NAS over SMB. The NAS account configured in
Configure External Services decides which shares and folders are reachable;
any share that account can open is fair game. If an operation is refused,
the account lacks permission there: say so rather than trying to work
around it.

## Setup facts

- Host: `NAS_HOST`. Credentials: `getcred NAS_USER` / `getcred NAS_PASS`
  (works for both "Enter manually" and "Fetch from Vaultwarden").
  Never print, log, or store the credentials.
- `NAS_SHARES` (comma-separated, may be empty) lists the shares the user
  named as the usual places to look. It is a hint, not a limit.
- Use the helper module below. It handles credentials, sessions, and paths.
  Do not hardcode hosts, shares, or passwords.

## Helper

```python
import sys; sys.path.insert(0, '/opt/skills/nas')
import nas

nas.preferred_shares()             # ['Docs', ...] from the config (may be [])
nas.shares()                       # [{'name': 'Photos', 'comment': '...'}, ...] the account can see
nas.listdir('Photos', '2024/June') # names in a folder ('' = share root)
nas.scandir('Photos', '2024')      # [(name, is_dir, size), ...]
nas.exists('Docs', 'notes/todo.txt')
nas.read_text('Docs', 'notes/todo.txt')
nas.read_bytes('Photos', '2024/June/IMG_0001.jpg')
nas.write_text('Docs', 'notes/out.txt', 'hello')     # creates folders as needed
nas.write_bytes('Docs', 'reports/q3.pdf', data)
nas.makedirs('Docs', 'reports/2026')
```

Paths are relative to the share root; `/` or `\` both work; `..` is
rejected. Errors raise `nas.NasError` (configuration, credentials, share
listing) or the usual `OSError` subclasses from `smbclient`
(`FileNotFoundError`, `PermissionError`).

For anything not covered, `nas.unc(share, path)` returns the UNC path and
the `smbclient` module (smbprotocol) is importable after `import nas`, e.g.
`smbclient.remove(nas.unc('Docs', 'tmp/old.txt'))`, `smbclient.rename(...)`,
`smbclient.stat(...)`.

## Finding the right share

1. If the user named a share, use it.
2. Otherwise try `nas.preferred_shares()` first.
3. Otherwise call `nas.shares()` and pick by name/comment, or ask the user.

## Images for vision analysis

```python
import base64, sys; sys.path.insert(0, '/opt/skills/nas')
import nas
img_b64 = base64.b64encode(nas.read_bytes('Photos', '2024/June/IMG_0001.jpg')).decode()
# pass img_b64 to the Ollama vision model (see the ollama skill)
```

## Quick check

`python3 /opt/skills/nas/nas.py [share]` prints the host, preferred shares,
visible shares, and the first entries of one share. Use it to diagnose
connection or permission problems.

## Notes

- Deleting or overwriting files on the NAS: confirm with the user first
  unless they asked for exactly that.
- Large files: read/write in binary mode; for very large files open
  `smbclient.open_file(nas.unc(...), 'rb')` and stream in chunks.
- The SMB tooling ships in the image (`/opt/python-libs`, Samba `smbclient`).
  Older notes that point at `/data/.openclaw/python-libs` are out of date.
