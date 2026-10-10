---
name: ntfy
description: "Use this skill to send a push notification to the user's phone through their ntfy server. Triggers: the user asked to be notified, a long task finished or failed, something changed that the user wants reported, or a scheduled job has a result."
---

# ntfy — Push Notifications

## Send one

```bash
notify "Workspace changes committed and pushed"
notify --title "Backup" --priority high --tags warning "Disk /data is 92% full"
echo "multi-line report" | notify --title "Daily check" -
```

From Python:

```python
import sys; sys.path.insert(0, '/opt/skills/ntfy')
import ntfy
ntfy.send('Workspace changes committed and pushed', title='Git', tags=['white_check_mark'])
```

- The topic, server and access token come from Configure External
  Services; you never handle the token. `--topic` / `topic=` overrides the
  default topic.
- `--priority`: `min`, `low`, `default`, `high`, `urgent` (or 1–5).
  Use `high`/`urgent` only for problems that need action soon.
- `--tags`: comma-separated ntfy tags; emoji short names become icons
  (`warning`, `white_check_mark`, `rotating_light`, `floppy_disk`).
- `--click URL` opens a page when the notification is tapped.

Exit status: `0` sent, `1` sending failed (message says why), `2` ntfy not
configured or bad arguments. In scripts and git hooks, never let a failed
notification fail the real work: `notify "…" || true`.

## Good notifications

- One short line the user can act on from the lock screen; details go in
  the body or a link, not in the title.
- Say what happened and where: "Committed 3 files to workspace (a1b2c3d)",
  not "Done".
- Never put credentials, tokens, private file contents or personal data in
  a notification: it is shown on the phone's lock screen and stored on the
  ntfy server.
- Don't notify for every small step. Batch, or report the result.

## If it fails

- "not configured": ask the user to enable ntfy in Configure External
  Services.
- "refused the access token": the token is wrong or its user may not write
  to the topic.
- "unreachable": run `python3 /opt/skills/health/health.py`; the ntfy line
  shows whether the server answers.
