---
name: health
description: "Use this skill to check whether this OpenClaw service and the services it depends on are working. Triggers: 'is everything OK?', a tool or service seems down, before blaming a service in a diagnosis, or a health/status report."
---

# Health — service status from inside the container

## Run it

```bash
python3 /opt/skills/health/health.py          # short report
python3 /opt/skills/health/health.py --json   # for scripts
```

It runs the same checks as the health list in the StartOS UI, with the
same addresses, so its answer matches what the user sees there:

- **Web Interface** (the OpenClaw gateway), **Qdrant**, **Webchat** (if
  enabled)
- **Vault (rbw)**: whether the vault is unlocked (a locked vault unlocks
  itself on the next credential lookup) and whether a sync with Vaultwarden
  works. rbw keeps answering from its local copy when the sync fails, so a
  failed sync means changes made in Vaultwarden are not reaching OpenClaw;
  if Vaultwarden is running, a restart of OpenClaw signs in again.
- each **enabled external service**: Vaultwarden, Ollama, NAS (SMB),
  n8n, Trilium, SearXNG, Crawl4AI, ntfy. For **n8n and Trilium** it also
  makes one authenticated read request, so it says whether the API key is
  accepted, rejected or not configured (Trilium also reports its version).
- **Email (IMAP)**: the IMAP server answers, and the IMAP and SMTP logins
  work (a wrong or missing password shows here). **Google account**: the
  stored sign-in is valid (Google is asked to refresh it), and which
  services it covers.
- **PDF/OCR tools**: Tesseract with English, for the pdf skill
- **Disk** (`/data`) and **memory**
- **Memory search**: whether OpenClaw's memory search has working
  embeddings (Configure AI Provider → Memory Embeddings) or is paused and
  needs its index rebuilt once

Exit status: `0` all OK, `1` something is down, `2` could not run.

It prints no secrets; an API key is sent only to its own service. For the
plain reachability probe, a service that answers "401/403" counts as
reachable (it is up and wants a login), exactly as in the StartOS checks.

The memory-search check takes several seconds: that is the `openclaw` CLI
starting up and opening the agent database, not the embedding server.

## Server State Snapshot in MEMORY.md

The `## Server State Snapshot` section of MEMORY.md is written by
`refresh-snapshot` (at every start and by the daily heartbeat): server
details when start-cli is logged in to StartOS, otherwise this health
report. Never edit that section or write scripts to update it; run
`refresh-snapshot` if it needs refreshing.

## What it cannot see

This runs inside the package's own container. There is no `sudo`, no
`podman` and no access to other containers or to StartOS itself, so it
cannot show service logs, restart anything, or report on other packages.
For those, ask the user: StartOS UI → openclaw, or on the Start9
`sudo start-cli package logs openclaw-extrabutter -l 200`.

Do not try `podman`, `docker`, `systemctl` or `sudo`: they do not exist
here.

## Reading the result

- One external service down, the rest fine: that service (or the network
  path to it) is the problem, not OpenClaw. Say which, with the message.
- Everything external down at once: likely the LAN, DNS host mappings or
  the server hosting those services; tell the user.
- Vault locked and a credential lookup also fails: the master password or
  Vaultwarden settings (Configure External Services) need the user.
- Disk above 90 % or memory below 256 MiB is reported as a problem.
- Memory search paused: tell the user; the fix is in the message (a
  one-time index rebuild, free with Ollama, a small cost with a paid API).

Report the lines that are not OK, verbatim; don't guess beyond them.
