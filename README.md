<p align="center">
  <img src="icon.png" alt="OpenClaw Logo" width="21%">
</p>

# OpenClaw Extra Butter (OpenClaw on StartOS)

> Everything not listed in this document should behave the same as upstream
> OpenClaw. If a feature, setting, or behavior is not mentioned here, the
> upstream documentation is accurate and fully applicable — see the
> Documentation section of `instructions.md` for links.

[OpenClaw](https://github.com/openclaw/openclaw) is a self-hosted AI agent gateway: a web chat and control panel in front of an LLM, reachable from messaging channels, with a workspace and memory of its own. This package runs the gateway, wires it to either a cloud provider or a local model server on the same box, and can — if you ask it to — give the agent administrative control of StartOS itself.

This file is the technical reference (for an AI support or administering agent, and for anyone who wants to know how the package works). The setup guide for users is `instructions.md`; what changed in each release is [docs/HISTORY.md](docs/HISTORY.md); how to update the bundled software is `UPDATING.md`.

**This is a fork of the community package** ([Start9-Community/openclaw-startos](https://github.com/Start9-Community/openclaw-startos)) with its own package id, `openclaw-extrabutter`, shown in StartOS as **OpenClaw Extra Butter**. It installs alongside the community OpenClaw package and never replaces it; each has its own volumes, Qdrant and addresses. Don't connect both to the same Telegram bot or WhatsApp number. On top of the community package it adds:

- a bundled **Qdrant** vector database (its own volume) and a skill for it;
- **helper agents** the main agent can spawn, managed from an action (Configure Agents) or by the agent itself;
- a **vault service** around the built-in **rbw** client (Bitwarden-compatible): point it at your Vaultwarden once and every other part of the package fetches its credentials from it; agents never get the master password or the items the services own;
- **Configure External Services**: optional skills for services you already run (Vaultwarden, Ollama, an SMB NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy and Gitea), plus host mappings and a custom CA for internal HTTPS services;
- **email, calendar and contacts** through isolated services, each with its own agent that has only its own tools; the main agent asks them through an **apps agent** and never reads mail or invitations itself; outgoing mail and invitations follow your rules, with anything else waiting for your approval;
- **cost reports**: Usage and Cost, a Spending health line and a daily Spending Alert;
- a **mobile webchat** with one PIN-protected profile per person (optional);
- built-in **pdf** (text extraction and OCR) and **health** skills, memory-embeddings settings, and a daily server snapshot in the agent's memory.

- **Upstream repo:** <https://github.com/openclaw/openclaw>
- **This package:** <https://github.com/usuallymark/openclaw-extrabutter-startos> (releases carry the `.s9pk` files for x86_64 and aarch64, signed by one release key shown on each release page)

## Screenshots

The service dashboard, with a health check for every external service you enable:

![OpenClaw Extra Butter service dashboard with health checks](docs/screenshots/dashboard-health.png)

More: [Actions & Config](docs/screenshots/actions.png), Configure External Services ([part 1](docs/screenshots/external-services-1.png), [part 2](docs/screenshots/external-services-2.png)), or all of it as a [three-page PDF tour](docs/OpenClaw-Extra-Butter-tour.pdf). The screenshots are StartOS's own interface showing this package's real actions and forms, filled in with example values.

---

## Table of Contents

- [Installing and Updating](#installing-and-updating)
- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [File Models](#file-models)
- [Dependencies](#dependencies)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [First Run](#first-run)
- [The Isolated Services](#the-isolated-services)
- [Actions](#actions)
- [Tasks](#tasks)
- [Health Checks](#health-checks)
- [Backups and Restore](#backups-and-restore)
- [Limitations and Differences](#limitations-and-differences)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

---

## Installing and Updating

The package is sideloaded: download the `.s9pk` for your server from the release page, then StartOS → System → Sideload a Service. It runs on StartOS 0.4.0.2 and later, 0.4.1 included; no release requires a StartOS update.

- **Trust the release key once** (StartOS 0.4.1 and later): System → Trusted Keys → Add key, with the key from the release page, Packages on. Without it, every sideload asks "Install untrusted software?".
- **If the browser upload breaks off** (StartOS logs "Connection closed or timed out before full file received" and nothing installs), install from the server itself over SSH: download the file there and run `sudo start-cli package install --sideload <file>`. It checks the signature against the same trusted keys.
- **Make a StartOS backup before updating**: the update migrates OpenClaw's databases, which cannot be undone.
- **The first start after an OpenClaw update takes 1–2 minutes longer**, once: newer OpenClaw releases open agent databases written by older ones only after `openclaw doctor` has migrated them with the gateway stopped (the `state-migrate` oneshot). A marker (`/data/.startos/openclaw-doctor-version`) is written only on success; a failure is logged and retried at the next start and never blocks it. If vector memory search is paused afterwards, the main agent's memory index is rebuilt (this needs a reachable embedding provider; without one, keyword search still works).

## Image and Container Runtime

One image, built from this repo's `Dockerfile`, for x86_64 and aarch64. Node and OpenClaw are pinned to exact releases; `UPDATING.md` lists every pinned piece and how to move it.

| Subcontainer   | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `openclaw-sub` | The gateway, the webchat, the isolated services and the oneshots — the one to `attach` to |
| `qdrant-sub`   | Qdrant, from the official image                                    |

**The image also installs `start-cli`**, pinned to the release that matches the package's minimum StartOS (so it works on every supported server; `UPDATING.md`, "Compatibility"). That binary is what lets the agent administer the server when you grant it access, and it is why the container needs StartOS's root certificate. The image also carries the skills (`/opt/skills`), the GitHub CLI, `rbw`, `gog`, Python libraries for the skills (`/opt/python-libs`, hash-pinned in `skills/requirements.txt`), Tesseract for OCR, and the isolated services (`/opt/openclaw-*`).

**Users.** The gateway, the webchat and every agent run as `node` (HOME `/data`). The isolated services each run as their own user with a fixed number: `openclaw-mail` 999, `openclaw-calendar` 998, `openclaw-vault` 997, `openclaw-contacts` 995 (the Dockerfile checks them). A new service gets the next free number; numbers are never changed or reused, because the services' files on the volume carry them.

**Daemons.** `14-qdrant`; `vault-service` (always); `11-gateway`; `12-webchat` while enabled; `mail-front` + `mail` while Configure Email uses Gmail or IMAP; `calendar-front` + `calendar` while Calendar is on; `contacts-front` + `contacts` while Contacts has a source.

**Health checks have a time limit.** Every check runs through `startos/stopLog.ts`: a run that has not answered in 120 s, or 20 s after a stop began, counts as a failure and is let go, because the SDK's `exec` waits for the subcontainer before its own timeout starts and that wait has no limit. It also logs `[stop]` lines in the package log when a stop begins (which checks are mid-run, every 15 s which are still running), for an update that stalls with the old version never stopping.

Six oneshots run before the gateway, and two after it:

| Oneshot                 | When   | Purpose                                                                                            |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `install-root-ca`       | Before | Installs StartOS's root CA so the container trusts the OS                                          |
| `chown`                 | Before | Hands everything in `/data` to `node`, except the services' folders (`.openclaw-mail`, `.openclaw-calendar`, `.openclaw-contacts`, `.openclaw-vault`) and `.openclaw-package`; `/data` itself is `root:node` 1775 (sticky), so `node` cannot rename or replace the services' folders, and the service launchers refuse to start otherwise |
| `network-setup`         | Before | Writes custom host mappings to `/etc/hosts` and installs a custom CA (Configure External Services) |
| `state-migrate`         | Before | Once per OpenClaw version: `openclaw doctor --non-interactive` to migrate the agent databases      |
| `google-sign-in`        | Before | Google account kept in Vaultwarden: loads the OAuth client and sign-in token into gog              |
| `git-setup`             | Before | Writes git's system config: sign-in to Gitea and its address mapping (Configure External Services) |
| `check-simplex-plugin`  | After  | Brings the SimpleX plugin up to the pinned version                                                 |
| `server-state-snapshot` | After  | Writes a server inventory (or, when not signed in, a health report) into `MEMORY.md`               |

**The gateway starts unconfigured on purpose.** It is launched with `--allow-unconfigured`, so the interface comes up and shows you what is missing rather than refusing to start.

## Volume and Data Layout

Two volumes.

| Volume   | Mount Point       | Purpose                     |
| -------- | ----------------- | --------------------------- |
| `main`   | `/data`           | The agent's entire home     |
| `qdrant` | `/qdrant/storage` | Qdrant's vector collections |

| Path (under `/data`)               | Written by  | Holds                                                    |
| ---------------------------------- | ----------- | -------------------------------------------------------- |
| `.openclaw/openclaw.json`          | Actions and OpenClaw | The gateway and agent configuration             |
| `.openclaw/workspace/`             | Both        | The agent's identity, memory, and files                  |
| `.openclaw/workspace/workspaces/<agent>/` | Package | The isolated agents' `AGENTS.md` (rewritten every start), `SOUL.md`, `IDENTITY.md` (created once, then yours) |
| `.openclaw/workspace/mail-inbox/`, `mail-outbox/` | Mail service / agents | Attachments released from trusted, verified senders; files to attach to drafts |
| `.openclaw/workspace/contacts-import/` | You     | A `.vcf` to import into the contacts service             |
| `.openclaw/agents/<id>/agent/openclaw-agent.sqlite` | OpenClaw | Per-agent state (sessions, transcripts, memory index) |
| `.openclaw/state/openclaw.sqlite`  | OpenClaw    | Gateway state, including scheduled jobs                  |
| `.openclaw/webchat/`               | Both        | Webchat profiles, its state and file hand-offs           |
| `.openclaw-package/`               | The package | Root-only settings the package trusts: `external-services.json`, `usage.json` (Spending Alert), `agent-actions.json` (how many items wait) |
| `.openclaw-mail/`                  | Package and mail service | `settings.json` (root 0600), `rules.json` (sending rules), `decisions/` (your approvals), `state/` (activity log without bodies, approval queue, send counts, refused-password fingerprint) |
| `.openclaw-calendar/`              | Package and calendar service | The same layout for the calendar: settings (with a pasted sign-in), decisions, `state/` (activity log without event text, own calendar id, queue, write counts) |
| `.openclaw-contacts/`              | Package and contacts service | `settings.json`, `contacts.vcf` (an imported file), `state/` |
| `.openclaw-vault/`                 | Package and vault service | `settings.json` (Vaultwarden address and email, root 0600), `owners.json` (items a service owns), `credentials` (the master password, `openclaw-vault` 0600), `rbw/`, `state/activity.jsonl`, `run/vault.sock`; the folder is root 0711 |
| `.startos/auth-profiles.json`      | An action   | Provider API keys                                        |
| `.startos/embeddings.json`, `apps-agent.json` | Actions | Memory-embeddings choice; Configure Apps Agent     |
| `.startos/config.yaml`             | The package | Where `start-cli` points (rewritten every start with the server's current address) |
| `.startos/gateway-secrets.env`     | The package | The gateway's secrets (0600), sourced by its start command |
| `simplex.json`                     | An action   | Whether SimpleX file exchange is on                      |

**`SOUL.md`, `IDENTITY.md` and `MEMORY.md` are seeded once** from the image when missing, and then belong to you: updates never replace them (they may live in your own git repository).

**Every start rewrites one section of `MEMORY.md`** (`## Server State Snapshot`) with `refresh-snapshot`: when `start-cli` is signed in, the server's metrics, packages, notifications, gateways, disks and backup targets; otherwise the health report. It is how the agent knows what it is running on — and it means the memory file can contain an inventory of your server. **A daily heartbeat runs the same command.** Its instructions are the heartbeat prompt in the configuration (`agents.defaults.heartbeat`), rewritten by init on every install and update and delivered nowhere (`target: none`).

## File Models

| File                     | Format | Written by                         |
| ------------------------ | ------ | ---------------------------------- |
| `openclaw.json`          | JSON   | Actions, init, and OpenClaw itself |
| `auth-profiles.json`, `embeddings.json` | JSON | Configure AI Provider    |
| `external-services.json` | JSON   | Configure External Services        |
| `.openclaw-mail/settings.json`, `.openclaw-calendar/settings.json`, `.openclaw-contacts/settings.json` | JSON | Configure Email, Calendar, Contacts |
| `webchat/config.json`    | JSON   | Configure Webchat                  |
| `config.yaml`            | YAML   | `main` and init                    |
| `simplex.json`           | JSON   | Configure SimpleX                  |

**The main configuration is shared with the application, not owned by the package.** OpenClaw edits it too — changing the model from inside the chat writes to the same file — which is why the dependency declaration reads it reactively rather than trusting the action to be the only writer.

Two gateway settings are **pinned** with `z.literal(true)`: the control UI being enabled, and the host-header origin fallback, because **StartOS fronts the gateway with its own reverse proxy on addresses that OpenClaw's origin check rejects**. `main` also writes `gateway.trustedProxies` every start, set to the bridge address the proxy connects from; without it OpenClaw answers every proxied request with `403 proxy_attribution_required`.

**API keys are stored in one place and consumed in another.** The action writes them into `auth-profiles.json`; OpenClaw reads them from the environment. `main` writes the keys and the other service secrets to `/data/.startos/gateway-secrets.env` (0600), and the gateway starts as `sh -c '. that file; exec "$@"' openclaw gateway …` (`startos/secretEnv.ts`), because StartOS passes a daemon's environment as command-line arguments, which every process on the server can read. The `google-sign-in` oneshot starts the same way; gog's keyring password and Login to StartOS's password go in on standard input. The file lives under `.startos/`, not OpenClaw's agent directory: a file of that name there is a retired credential source that OpenClaw's doctor archives.

**No package write goes through a link in `node`'s folders.** A file model under `.openclaw/` or `.startos/` is wrapped in `linkSafe` (`startos/noLinks.ts`), and root steps that touch `node`'s folders work by descriptor (`agentsvc/launcher.py` `walk`/`own_dir`), so an agent cannot point a package-written file at the services' folders with a symlink.

## Dependencies

All optional, and **each declared only while it is selected**. (Qdrant is bundled, not a dependency. External services set to *At an address* are reached by URL and are not dependencies; those set to *On this server* are.)

| Dependency               | Required             | Kind      | Why                           |
| ------------------------ | -------------------- | --------- | ----------------------------- |
| Ollama, vLLM, llama.cpp  | No — only if chosen  | `running` | Local inference backend       |
| SimpleX Websocket Bridge | No — only if enabled | `running` | Exchanging files over SimpleX |
| Vaultwarden, n8n, Trilium, SearXNG, Crawl4AI, ntfy, Gitea | No — only while *On this server* | `running` | Configure External Services (Ollama too, besides the AI backend) |

**The inference dependency follows the model you are actually using.** The declaration is derived from the primary model and its fallbacks, so selecting a local backend adds it and switching to a cloud provider drops it — including when the switch is made from inside the chat. Each is required to be running _and_ passing its own health check. A cloud provider needs no dependency, only an API key and internet. Local backends are reached over the internal bridge, and their API key is read from the backend's own published volume.

SimpleX is different in kind: enabling file exchange mounts the bridge's file-exchange directories into this container, and resolves the bridge's control socket over the bridge network.

## Network Access and Interfaces

| Interface | Id        | Type | Port  | Description                                       |
| --------- | --------- | ---- | ----- | ------------------------------------------------- |
| Web UI    | `ui`      | ui   | 18789 | The chat and the control panel                    |
| Webchat   | `webchat` | ui   | 18800 | Mobile webchat; exported only while it is enabled |

The Web UI is bound on the `ui-multi` MultiHost over HTTP and not masked. Qdrant (6333) and the isolated services' MCP ports (18805–18807, on 127.0.0.1) are never exported.

**The gateway password is the gate, and each browser is approved once.** OpenClaw's origin checking is relaxed (above); its device pairing is not, and cannot be. A browser that passes the password is held at "Approve this browser" until the Approve Browser Pairing action admits it, and then keeps a per-device credential until it is removed in the Web UI's device list. So anyone who can reach this address, knows the password, and can run that action has the agent — and, if StartOS access has been granted, the server.

**The webchat has its own gate: a PIN on every profile.** The webchat holds its own operator connection, so browser pairing does not apply to it, and it drives the main agent with all its tools. A profile without a PIN is never served; PINs are 6–12 digits. Wrong PINs lock an address for 5 minutes and up, and a profile for 15 minutes after 20 in 10 minutes; a profile lock, or a second lock of one address, is pushed to the owner through ntfy when it is set up. The client address is the last `X-Forwarded-For` entry. Profiles separate conversations, not permissions: every profile has the same agent.

Outbound, the gateway talks to whichever provider is configured, to any messaging channel you connect, to the external services you enable, and to sibling services over the internal bridge.

## First Run

Install creates the agent's directory structure, seeds its workspace from the image, points `start-cli` at the server, and pins the gateway settings. It then raises **two `critical` tasks**: set a gateway password, and configure an AI provider. `critical` blocks startup, so there is no window where the gateway is reachable without a password. Nothing else is required: with no external services, email or calendar set up, the agent still has the pdf, health, qdrant, agents and start-cli skills.

The first visit to the Web UI from any browser ends at "Approve this browser" after the password; running **Approve Browser Pairing** admits it and the page connects on its own.

**Granting StartOS access is opt-in and never asked for.** No task raises it; the action is under Maintenance, and the Server Access health line shows the current state — see Login to StartOS below before running it.

## The Isolated Services

Mail, invitations and contact notes are written by strangers and can try to instruct whatever AI reads them. So the package keeps them away from the main agent: each app is a service of its own, run as its own user, the only holder of its password or sign-in, reached by one agent that has that service's tools and nothing else. The services enforce the owner's rules themselves; the agents' instructions are a second layer, not the guard.

```
main agent ──sessions_send──▶ apps agent ──sessions_send──▶ email / calendar / contacts agent ──MCP──▶ service ──▶ mailbox, calendar, address book
```

**Shared structure** (`agentsvc/`). Each service has two daemons. The **front** (`front.py` on `agentsvc/frontdoor.py`) is the MCP endpoint on `127.0.0.1` (mail 18805, calendar 18806, contacts 18807): no settings, no secrets, never restarted with the worker (OpenClaw stops using an MCP server for minutes after a failed connection); it answers the handshake and tool list itself and passes tool calls to the worker over a Unix socket only the service user can open, and while the worker is away a call gets "reloading or starting" as an ordinary tool error. The **worker** starts as root in `launch.py` (shared steps in `agentsvc/launcher.py`): it checks the service's folder belongs to the package (owner root or the uid `main` passes, never `node`), sets its modes (`root:<service> 0710`, `state/` `<service> 0700`), fetches the secret from the vault service as root, opens any workspace folder it needs component by component without following links and passes it as a descriptor, then drops to the service user and execs the worker with settings and secret on standard input. No password file, nothing privileged left running. Each worker allows 120 tool calls a minute and keeps an activity log without message or event text.

**Agent-facing text from outsiders** (mail bodies, event descriptions, contact notes) is converted to plain text with hidden text removed (display:none, zero size or opacity, text coloured like its background, `hidden`, mso-hide), invisible characters stripped, nothing fetched, size-capped, and wrapped in randomly tagged `UNTRUSTED` markers. The tools set flags the agents must copy and never drop: `injection_suspected`, `financial_or_credential_request`, `hidden_text_removed`, `hidden_injection` (the removed text tries to instruct an AI), `links_present`, `attachments_present`.

**A refused password or sign-in is never sent again.** The worker records a salted fingerprint of it and exits; the launcher fetches the secret again, and the service signs in only with a different one. It checks again every 10 minutes. The health line says so, one notification and one ntfy message are sent, and a fix-it task opens the right form (see Tasks). An unreachable server is retried and raises no task.

**The agents.** `agents.entries.email`, `.calendar`, `.contacts` and `.apps` are rewritten at every start (`startos/isolatedAgents.ts`): tools profile `full` with `allow` only for their own tools (`mail__*`, `calendar__*`, `contacts__*`; the apps agent: `sessions_send`), a deny list of every other tool group plus `gateway`, `cron`, `openclaw`, `browser`, `transcripts`, `tts`; code mode and elevated off; no skills; they spawn nobody and nobody spawns them (a spawned agent inherits its spawner's denied tools). Every other agent has `mail__*`, `calendar__*` and `contacts__*` denied. They are not rows in Configure Agents, and Configure Agents and the `agents` skill refuse to change them or give anyone their tools. With these agents present, `agents.defaults.systemAgent.agentId` and `heartbeat.agentId` are `main` and `agents.ownership` is `explicit` where unset.

**The apps agent** (`startos/appsAgent.ts`, `startos/appsAgentFiles.ts`) exists while any of the three is set up. The main agent has one skill for all of it, `apps`, and no mail, calendar or contacts tools. The apps agent passes each job to the right agent with `sessions_send` and answers `{email, calendar, contacts, notes}` with their JSON reports unchanged. OpenClaw cannot limit which agent may message which, so the path is kept by instructions: the email, calendar and contacts agents act only on requests whose first line is `[via apps]`, which only the apps agent's instructions contain, and answer anything else with an empty report. That keeps the main agent on its path; it is not a lock (the main agent has a shell), and the services' rules and approvals stay the guards. Each of these agents keeps one conversation, which the package clears (gateway `sessions.reset`) after 15 minutes without requests. Long reports: the apps agent asks for compact ones (at most 30 items) because a reply of more than about 12,000 characters can be cut off on its way to the main agent, and the `apps` skill tells the main agent to ask again for a narrower job instead of guessing the rest.

**Service-to-service sockets** are abstract-namespace Unix sockets with `SO_PEERCRED` checked on both ends: `\0openclaw-mail-invite` (calendar → mail, invitations) and `\0openclaw-contacts-known` (mail and calendar → contacts, "is this address in the contacts?", yes/no only, at most 100 addresses a request and 120 requests a minute per caller).

**Outgoing network from the services** (calendar links, CalDAV): the address actually connected to is checked (never loopback, link-local or other special addresses; a private LAN address only when the configured address is on the LAN, never by a redirect from outside), a hard time limit per exchange, no proxy; passwords only over HTTPS and only to the configured server's own origin.

### The vault service

`vault-service` (`startos/vaultService.ts`, `vault/`) runs `vault/launch.py` as root: it checks `/data/.openclaw-vault` is the package's, sets its modes, writes rbw's config from `settings.json`, and execs `vault/broker.py` as `openclaw-vault`. The broker signs in, unlocks and syncs (`vault/start.sh`; it signs in again when Vaultwarden refuses the stored sign-in), then answers one JSON line per request on `run/vault.sock` (`vault/client.py`: `get`, `list`, `sync`, `status`, `check`).

- **Who gets what**, by the caller's uid (`SO_PEERCRED`): root (the launchers, the health check) any item; `node` (every agent and skill) any item no service owns; anyone else nothing. `owners.json`, written by `main` at every start, lists the owned items: `email` while the mail service is on; `google-calendar`, `caldav` and every calendar link's item while Calendar is on; `google-contacts` while Contacts reads the Google account. Missing or unreadable → agents get nothing.
- **Never caller text to rbw.** rbw also matches ids, URLs and substrings, so the broker resolves the name itself (exact, any case, outside folders first; else the one name containing it) and asks rbw by the item's id.
- rbw's binaries are in `/usr/libexec/openclaw-vault`; the agents' `rbw` is a read-only wrapper (`get`, `list`, `sync`, `unlocked`), and `getcred` asks through `vault-client`. Each request is logged (item, field, caller; never a value) and shown in Agent Activity.
- The Vaultwarden address and email come only from the package's root-only `settings.json`, so an agent cannot point the sign-in at a server of its own.

### The mail service

Configure Email with *Gmail (app password)* or an IMAP provider (`startos/mailService.ts`, `mail/`; user `openclaw-mail`).

- **Tools** (`mail__*`): `status`, `folders`, `list`, `search`, `read`, `attachments`, `attachment_text`, `save_attachments`, `mark_read`, `flag`, `move`, `archive`, `draft`, `send`. Never delete, never Trash or Spam. Reading uses `BODY.PEEK` (nothing is marked read) and returns plain text only.
- **Sender checks** come only from the receiving server's Authentication-Results (for Gmail only `mx.google.com`'s): `from_verified`, `sender_not_verified`, warnings for Reply-To/Return-Path domains and display-name spoofing; `known_contact` / `contact_not_verified` when the contacts service has the address.
- **Attachments** stay in the mailbox; `attachment_text` extracts text (PDF, .docx, text, HTML, attached mail); `save_attachments` copies files to `workspace/mail-inbox/` only for a Trusted Sender with a verified sender.
- **Drafts** go to Drafts with an HMAC marker header (`X-OpenClaw-Draft`) and may take attachments, an HTML body and a text body from `workspace/mail-outbox/` (read without following links; at most 10 files / 18 MB). HTML is checked by `mail/htmlout.py`: no scripts, event handlers, forms, frames, objects, `<base>`, `<meta http-equiv>`, `<link>`, CSS imports, escapes or outside URLs, no hidden text that tries to instruct an AI, images only from mail-outbox, embedded with `cid:`.
- **Sending** (`mail/outbox.py`) sends only marked drafts and judges every To/Cc/Bcc address: on **Never Send To** (also its `+tag` forms, Gmail's dotted and googlemail forms, a trailing dot; `@domain` blocks subdomains) → refused; a forward, any attachment, HTML, too many recipients, or the hourly/daily limit reached → waits for approval; all on **Send Automatically To** (plus the Trusted Senders, while that switch is on) → sent; otherwise **Anyone Else** (`ask`, `block` or `auto`). Sending is SMTP with the same password, exactly to the judged recipients (Bcc stripped from the sent copy); then the draft is removed and, except for Gmail, a copy goes to Sent.
- **Routine mailings** (`rules.json` `mailings`): exact recipients, a subject prefix, at most N per calendar month (UTC), allowed attachment types and link domains. A draft that matches, after an earlier issue with the same recipients and prefix was sent, is sent without asking and announced (notification + ntfy). "Approve, and make this a routine mailing" in Review Agent Actions creates one from a waiting item.
- **Waiting items** are kept with their exact bytes in `state/queue/`; Review Agent Actions writes the decision as root (`agentsvc/agentctl.py decide`) to `decisions/`; the worker re-checks Never Send To and that the draft is unchanged, then sends (3 attempts, 5 and 10 minutes apart). Undecided items expire after 5 days, with a reminder 24 hours before.
- **Invitations by mail** (`mail/invite.py`): from the calendar service only, as marked drafts judged like any mail; replies to them are moved to a "Calendar Replies" folder.

*Google account* mode uses `gog` and is **not isolated**: the main agent uses it directly (Gmail, Calendar, Drive). The sign-in is fetched from Vaultwarden item `google` (fields `client_json`, `token_json`) by the `google-sign-in` oneshot, or pasted once; gog keeps it in an encrypted file keyring under `/data/.openclaw/gog`. OpenClaw's own `himalaya` and `gog` skills and its built-in mail watching stay off.

### The calendar service

Configure Calendar (`startos/calendarService.ts`, `gcalendar/`; user `openclaw-calendar`). Sources: secret **calendar links** (iCal addresses), a **Google** account, or a **CalDAV** account; any of them with links.

- **Tools** (`calendar__*`): `status`, `calendars`, `list` (default the next 7 days, recurring events expanded, at most 100, range at most 400 days), `search` (30 days back to 210 ahead), `read` (the description with hidden text removed, untrusted-wrapped); in write and invitation modes also `create_event`, `change_event`, `cancel_event`. Times in the owner's time zone.
- **One copy per event.** When a link and an account calendar show the same calendar, `list` and `search` keep the account's copy (same iCal UID and start) and name the links in `also_in`.
- **Google** (`gcalendar/gapi.py`): the sign-in is the one-line JSON printed by `tools/google-signin.py` (loopback OAuth with PKCE against a *Desktop app* client in your own Google Cloud project), from Vaultwarden item `google-calendar` (hidden field `token`) or pasted. Read mode needs `calendar.readonly`; write mode also `calendar.app.created`, under which Google refuses any write outside calendars this client created. The worker keeps access tokens in memory only. The health line warns when the sign-in allows more than it needs.
- **Calendar links** (`gcalendar/links.py`, `gcalendar/ical.py`): name + secret address (pasted, or Vaultwarden field `url`), read only, fetched at most every 5 minutes, 30 s and 16 MB per fetch, `webcal://` read as `https://`, a failed fetch keeps the last good copy and says so. The address never leaves the worker's memory: answers and logs carry only the name and the id `link:<name>`. `ical.py` parses RFC 5545 and expands recurrence in the event's own zone (all common RRULE parts, RDATE, EXDATE, changed and cancelled instances, IANA and common Windows zone names), with a budget of 1,000,000 candidate times per query.
- **CalDAV** (`gcalendar/caldav.py`, `gcalendar/davwrites.py`): password from Vaultwarden item `caldav` or pasted. The server comes from the Server field, else from the account address (iCloud, Fastmail and Yahoo by name; Google and Microsoft refused with the reason; otherwise `/.well-known/caldav` on the domain or `caldav.<domain>`). Calendars are read whole by REPORT, at most every 2 minutes and only when `getctag`/`sync-token` changed. HTTPS only, no automatic redirects, DOCTYPE/ENTITY answers refused, 2 MB per XML answer and 16 MB per calendar; a 401 is a refused password (above). In write mode the own calendar is made with MKCALENDAR (else a writable calendar named like Own Calendar Name); events are `<32 hex>.ics` in UTC, written with `If-None-Match`/`If-Match`, so nothing is ever overwritten; guests only when the server schedules invitations itself. **Look Up Calendar Server** tries the lookup and sign-in without saving anything. Tested against Radicale and a hostile test server, not yet against a real provider.
- **Writes** (`gcalendar/writes.py`) only on the own calendar (**Own Calendar Name**, made by the service; recreated if deleted). Guests only from the allowed list (Trusted Organizers plus, while that switch is on, Configure Email's Trusted Senders; the switch's footnote shows the merged list as saved); anything touching guests waits for approval (Google then sends the invitations), and **Hold Every New Event for My Approval** holds every write. At most 10 guests and 30 writes a day; not in the past, at most 2 years ahead. Waiting items expire after 5 days or once the event has started.
- **Invitations by mail** (*Read + invitations by mail*, no calendar account; `gcalendar/invites.py`): RFC 5545/5546 invitations (REQUEST, CANCEL) built and sent by the mail service under its rules, so Configure Email must be set to send by rules (the choice is greyed out with the reason until it is). The same guest rules apply; at least one guest.
- **Organizer flags:** `organizer_self` (the account itself, or a calendar it owns), `organizer_is_calendar` (made on a shared calendar by its owner), `organizer_trusted`, `known_contact`, `external_organizer`, `organizer_unverifiable` (came by an emailed invitation, so the organizer is only what it claims), `contact_not_verified`, `from_gmail`, `creator_differs`, `from_link`, `no_organizer`. Never "verified": Calendar has no such check.

### The contacts service

Configure Contacts (`startos/contactsService.ts`, `gcontacts/`; user `openclaw-contacts`), read only.

- **Sources:** a **vCard file** (put a `.vcf` in the workspace folder `contacts-import`; root imports it as `contacts.vcf` and removes the workspace copy unless kept; vCard 2.1, 3.0 and 4.0), or the assistant's **Google account** through the People API (`people/me/connections`, your real contacts only, not "Other contacts"), with its own sign-in (`google-signin.py --scopes contacts.readonly`, Vaultwarden item `google-contacts` or pasted), read again every 15 minutes.
- **Tools** (`contacts__*`): `status`, `search`, `lookup` (exact email, or phone in any format), `read` (one contact; its note untrusted-wrapped), `birthdays`. The agent passes on only the fields a job asks for. Logs hold counts only.
- **Known contacts for mail and calendar:** the mail and calendar services ask over `\0openclaw-contacts-known` (above). Mail: a contact the receiving server verified gets `known_contact`, one it did not `contact_not_verified`. Calendar: an outside organizer in the contacts becomes `known_contact` when Google made the event, and gets `contact_not_verified` otherwise. The order the agents use is trusted, then known contact, then external. For the Google source the copy is at most 15 minutes old; an older one is refreshed before answering.

## Actions

Twenty-two actions in five groups (`startos/actions/groups.ts`; StartOS shows the groups in the order of `actions/index.ts`).

**Daily**

- **Review Agent Actions** — what an isolated agent wanted to do that your rules hold: mail to send, calendar events with guests. One choice per waiting item, each with only the decisions that apply (mail: approve, reject, approve and always allow these recipients, approve and make this a routine mailing — the last greyed out with the reason for replies, forwards, invitations and mail without a subject; calendar: approve, reject), **no decision preselected**, the item's details in the field's footnote. Greyed out while nothing waits (`.openclaw-package/agent-actions.json`, written by the health checks). Decisions are written as root through `agentctl.py`, and the service acts within 10 s. No restart.
- **Agent Activity** — the services' activity logs (`agentctl.py activity`, the last 500 entries of each): a form chooses the service, the period (24 hours, 7 days, 30 days, everything) and changes only. The result starts with a one-line count per service, then collapsible sections (email sending, calendar changes, contacts reads, vault refusals, everything newest first) and the whole report to copy or download. No message bodies, event text or secrets are logged.
- **Usage and Cost** — the model cost from OpenClaw's own records (`agentctl.py usage 30`): every model call's `usage.cost.total` (provider prices) in each agent's `transcript_events`, opened read only. OpenClaw stores events of 1 KB or more zstd-compressed (`event_zstd`), with the usage only inside; `agentsvc/usagezstd.js` reads those with Node's zstd and SQLite (the image's Python has no zstd) and hands back the usage objects only; when it cannot, the report says some records could not be read. Shown: a one-line summary, then per agent (today, 7 and 30 days, calls, tokens; the package's helper agents marked), each agent's model and the form that sets it, per day for 14 days, and how often each scheduled job ran (names and schedules, never prompts). Days in Configure Calendar's time zone, else UTC.
- **Spending Alert** — a daily limit in dollars (`.openclaw-package/usage.json`). The **Spending** health line then fails above it and sends one notification (and ntfy) that day.

**Email, Calendar, Contacts**

- **Configure Email** — the account: *Gmail (app password)*, *Other provider (find servers automatically)*, *Other IMAP/SMTP provider*, or *Google account* (gog, not isolated); the password from Vaultwarden item `email` or the form. Then the email agent's model, Trusted Senders, sending level (`off` / `drafts` / `rules`), Send Automatically To, Never Send To, Anyone Else, limits per hour, per day and per message, and routine mailings (their To and Bcc are pick lists of the addresses entered anywhere in the package, plus an "other" list). Restart.
- **Look Up Mail Servers** — what *find servers automatically* would use, saving nothing (`startos/mailDiscovery.ts`): Thunderbird's order (the domain's autoconfig, its well-known file, the Thunderbird ISPDB, the ISPDB entry of the MX host's domain, then SRV records), HTTPS only, IMAP and SMTP with SSL or STARTTLS and password login only. Google addresses become *Gmail (app password)*; Microsoft is refused with the reason (it no longer accepts passwords).
- **Configure Calendar** — Calendar: *Off*, *Read only*, *Read + write on its own calendar*, *Read + invitations by mail*, each choice with only its own fields; the Calendar Account (*No account (calendar links only)*, *CalDAV account*, *Google: fetch the sign-in from Vaultwarden*, *Google: paste the sign-in*); time zone; Own Calendar Name; Hold Every New Event; Also Trust Email's Trusted Senders (its footnote lists who is trusted now); Account; Calendar Links (saved addresses are never shown; blank keeps them); Trusted Organizers; the calendar agent's model and extra instructions. Restart.
- **Look Up Calendar Server** — finds the CalDAV server for an address and tries the sign-in, saving nothing (the typed password is used once).
- **Configure Contacts** — the source (*Off*, *vCard file*, *Google account*), the sign-in, the contacts agent's model and extra instructions. Restart.
- **Configure Apps Agent** — the apps agent's name, model and extra instructions (`.startos/apps-agent.json`). A persona goes in its own `SOUL.md`/`IDENTITY.md`; its reports stay JSON. Restart.

**Setup**

- **Set Password** (Reset Password once set) — generates the web interface password and shows it once; each run makes a new one. Restart.
- **Configure AI Provider** — a cloud provider with an API key, or a local model server, plus the model and an optional fallback; **Memory Embeddings** (an Ollama server, OpenAI or Gemini; unset: keyword search); **Local Chat Models for Agents** (the tool-capable models on an Ollama server, offered to helper agents). A local backend becomes a required dependency. Restart.
- **Configure Agents** — the helper agents the main agent can spawn: model, tool profile, extra and blocked tools, skills, who may start them; the agent can do the same with its `agents` skill. Also **Self-learning**: OpenClaw's `skills.workshop.autonomous.mode`, *Propose, I approve* (recommended), *Automatic* (OpenClaw's default) or *Off*; skills in the workspace's `skills/` folder take precedence over Workshop skills and are never changed by it. No restart. OpenClaw cuts a spawned agent's final reply to 4,096 characters, so agents with long results should write them to a file.
- **Configure External Services** — Vaultwarden, Ollama, an SMB NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy and Gitea, each optional, each with its skill and a health check; host mappings (StartOS never resolves `.local` names inside a service) and a custom CA. Most services offer *On this server* (installed on this StartOS: found over the internal network at every start by `startos/localServices.ts`, declared as a dependency, only credentials asked for) or *At an address*. Credentials can come from Vaultwarden once it is set up. **Gitea and git** (`startos/gitea.ts`): the `git-setup` oneshot writes git's system config so every push and pull signs in with the token (`git-credential-openclaw`, never stored by git), remotes written as `gitea:OWNER/REPO.git` always mean Gitea's current address, and Gitea's published addresses are mapped to the bridge; `gitea.py check [--fix]` reports and repairs remotes. Restart.
- **Approve Browser Pairing** — admits every browser waiting at "Approve this browser"; run it right after your own login attempt. Needs the service running.

**Channels**

- **Configure Webchat** — on or off, one profile per person (name, color, greeting, preset conversations, PIN). Restart; the Webchat interface appears or disappears.
- **Connect Telegram** — a bot token and who may direct-message the agent.
- **Connect WhatsApp** — a DM policy and an allow-list of numbers; pairing happens against the running gateway.
- **Configure SimpleX** — the channel, its DM policy, and file exchange with the bridge (mounts its directories). It also repairs the plugin's enablement and allow-list when the installed plugin is already current.

**Maintenance**

- **Login to StartOS** — signs the agent's `start-cli` in to this server with your StartOS master password. **This grants the agent root-equivalent control of the server**: it can start and stop packages, read logs, change network settings, run backups, and with `start-cli package attach` get root inside this package too, so the isolated services' users, rules and approvals no longer hold against it. Everything that reaches the chat can then reach the server. The Server Access line turns orange while signed in. Do it only on a server meant for that.
- **Repair OpenClaw** — runs `openclaw doctor` against the stopped service: `--lint` (report) or `--fix --non-interactive` (repair), and the legacy session import (`--session-sqlite dry-run` / `import`). The update already runs the repairing form; this is for a gateway that still refuses to start, or for reading doctor's report. Back up first.
- **Revoke StartOS Access** — deletes start-cli's stored key. Never greyed out: a safety switch should not depend on a check that may be minutes old. On StartOS 0.4.1 and later also check System → Active Sessions (see Limitations).

## Tasks

| Task                  | Severity    | Raised when                                       | Cleared when    |
| --------------------- | ----------- | ------------------------------------------------- | --------------- |
| Set Password          | `critical`  | Any init that finds no password                   | The action runs |
| Configure AI Provider | `critical`  | Install with no credentials stored                | The action runs |
| Review Agent Actions  | `important` | Anything waits for approval in any service (replay id `agent-actions`) | Nothing waits |
| Configure Email / Calendar / Contacts | `important` | That service's password or sign-in was refused (replay ids `fix-mail`, `fix-calendar`, `fix-contacts`; raised again every 10 minutes while it lasts) | The service signs in, or is turned off |

`critical` blocks the service from starting, so a fresh install shows the two setup tasks and nothing else. A SimpleX plugin task may also appear when the bundled OpenClaw needs a newer plugin. The approval and fix-it tasks are raised from the health checks as side jobs the check never waits for (each step time-limited), because StartOS stops a service only after every health check finishes its current run. Each new waiting item also sends one StartOS notification and one ntfy message.

## Health Checks

StartOS lists the checks sorted by id, not in the order they are defined, so the ids carry a number that sets the order: 1x the core, 2x the isolated services, 3x spending and server access, 40 the external services. While the service starts, lines appear as they first report until the page is reloaded.

| Check              | Displayed as             | Method                                                         |
| ------------------ | ------------------------ | -------------------------------------------------------------- |
| `11-gateway`       | "Web Interface"          | The gateway's `/healthz` on its own bridge address (40 s grace) |
| `12-webchat`       | "Webchat"                | Its `/healthz`, while enabled                                  |
| `13-vault`         | "Vault (rbw)"            | An unlock and a sync every 5 minutes, asked of the vault service as root, while Vaultwarden is enabled |
| `14-qdrant`        | "Qdrant Vector Database" | Port open, then Qdrant's `/readyz`                             |
| `21-mail`          | "Mail Service"           | The mail service's `/healthz` every minute: signed in, password refused (since when, why), Vaultwarden unavailable, server unreachable; the sending level, a warning for Anyone Else: send automatically, items waiting |
| `22-calendar`      | "Calendar Service"       | The calendar service's `/healthz` every minute: the account and mode, scope warnings, sign-in refused, unreachable; how many calendar links are readable (each failing one as a warning) |
| `23-contacts`      | "Contacts Service"       | How many contacts from which source, when read; no file yet, sign-in refused, unreachable; fails when the known-contact check for mail and calendar could not start |
| `31-spending`      | "Spending"               | Today's and the last 7 days' model cost, every 10 minutes; fails above the Spending Alert limit |
| `32-server-access` | "Server Access"          | Whether `start-cli` is signed in: no stored key → signed out; with a key, `start-cli server time` → signed in, or "Unauthorized" → signed out (stale key); anything else → failure ("may still have root"). Signed out shows as *disabled* (grey dash: a deliberate off state); signed in as a *failure* (orange, the service shows a warning) |
| `40-ext-<service>` | The service's name       | Reachability every minute, for each enabled external service; `40-ext-email`: the Google account (gog) sign-in is stored |

Hidden readiness daemons (`vault-service`, `mail`, `mail-front`, `calendar`, `calendar-front`, `contacts`, `contacts-front`) are ready once they answer.

The external checks test reachability only; the `health` skill (`/opt/skills/health/health.py`) also tests the n8n, Trilium and Gitea API keys, the isolated services' state and the isolation in `openclaw.json` (each isolated agent limited to its own tools, every other agent denied them), the Google sign-in and memory search. **None of them says anything about the model**: a wrong API key, a rate limit, or a local backend that is running but not loaded all show green checks and an error in the chat.

## Backups and Restore

Both volumes are copied wholesale — `sdk.Backups.ofVolumes('main', 'qdrant')`. That is the whole agent: configuration, provider API keys, the gateway password, channel tokens, the workspace, the accumulated memory, the services' settings and queues, and the vector collections.

**The backup contains every credential the agent holds**, in recoverable form: provider keys, the Telegram bot token, the Vaultwarden master password, pasted sign-ins and service keys, and — if StartOS access was granted — the key that administers your server. It also contains the server snapshot in memory. Treat it accordingly.

A restored instance comes back configured and remembers what it knew. The `start-cli` address is rewritten to the new server on the first start, but the **sign-in is not** — an agent restored onto a different server has to be signed in again before it can administer that one.

## Limitations and Differences

1. **Granting StartOS access gives the agent root-equivalent control of the server.** It is optional and revocable, and it is the single most consequential thing this package can do.
2. **StartOS 0.4.1 API tokens survive Revoke StartOS Access.** While signed in, the agent could create a bearer token through the API (start-cli 2.2.0 has no command for it); Revoke removes start-cli's key, not tokens. Check System → Active Sessions after revoking.
3. **Origin checking is relaxed and the reverse proxy is trusted**, because StartOS's addresses do not satisfy OpenClaw's checks. The gateway password and a one-time approval per browser are the gate.
4. **The backup holds every credential**, including the server key.
5. **The configuration is co-owned with the application**, which edits it at runtime — a change made in the chat is as real as one made through an action.
6. **The agent's memory contains a server inventory**, rewritten every start.
7. **Local backends must be running and healthy**, or the gateway has no model. **A cloud provider sends your conversations to that provider**; only a local backend keeps them on the box.
8. **The heartbeat prompt is rewritten on every init**; put your own heartbeat checklist in the monitor scratch (`openclaw cron scratch`), which is appended to the prompt and left alone.
9. **Spawned agents' final replies are capped at 4,096 characters** by OpenClaw.
10. **Agents in one gateway run as one user.** OpenClaw cannot separate agents in the same process, and the gateway environment (secrets from Configure External Services) is readable by every agent. The isolated services exist for that reason.
11. **The MCP fronts accept any caller inside the container**, so a main agent deliberately misusing its shell could call a service directly; the service's own rules and approvals still apply to every caller.
12. **The incoming-mail cleaner misses some hiding tricks**; the email agent's narrow tools are the guard.
13. **Google account mode (gog) is not isolated**: the main agent reads that mail and calendar directly.
14. **Separate from the community package**: a different package id, so there is no update path between the two. Moving from one to the other is a fresh install; StartOS backups restore only into the same package id.

---

## Quick Reference for AI Consumers

```yaml
package_id: openclaw-extrabutter # title: OpenClaw Extra Butter
image: built from ./Dockerfile # also installs pinned start-cli (2.2.0), rbw and gog, and the mail, calendar, contacts and vault services (/opt/openclaw-*)
architectures:
  - x86_64
  - aarch64
min_startos: 0.4.0.2 # start-sdk 3.x; no release may raise it
subcontainers:
  - openclaw-sub # gateway + webchat + agents as `node` (HOME=/data); services as openclaw-mail (999), openclaw-calendar (998), openclaw-vault (997), openclaw-contacts (995)
  - qdrant-sub
volumes:
  main: /data # HOME and OPENCLAW_STATE_DIR both live here
  qdrant: /qdrant/storage
file_models:
  - .openclaw/openclaw.json # gateway + agent config; OpenClaw writes it too
  - .openclaw-package/external-services.json # root only
  - .openclaw/webchat/config.json
  - .startos/auth-profiles.json # provider API keys; package-owned, not OpenClaw's agent dir
  - .startos/embeddings.json
  - .startos/config.yaml # start-cli host, rewritten each start
  - .startos/apps-agent.json # Configure Apps Agent
  - simplex.json # whether SimpleX file exchange is enabled
  - .openclaw-mail/settings.json # Configure Email; root-only, in a folder node cannot enter
  - .openclaw-calendar/settings.json # Configure Calendar; root-only
  - .openclaw-contacts/settings.json # Configure Contacts; root-only
  - .openclaw-package/usage.json # Spending Alert; root-only
  - .openclaw-package/agent-actions.json # how many agent actions wait (greys out Review Agent Actions); root-only
services: # isolated; MCP fronts on 127.0.0.1, rules enforced in the service
  mail: { port: 18805, tools: "mail__*", agent: email, owns_vault_items: [email] }
  calendar: { port: 18806, tools: "calendar__*", agent: calendar, owns_vault_items: [google-calendar, caldav, calendar-link items] }
  contacts: { port: 18807, tools: "contacts__*", agent: contacts, owns_vault_items: [google-contacts] }
  vault: { socket: /data/.openclaw-vault/run/vault.sock } # root: any item; node: items no service owns
  apps_agent: apps # the main agent's only path to the three (skill `apps`, sessions_send)
helpers_in_container:
  - python3 /opt/openclaw-services/agentctl.py queue|decide|usage|activity # root; the package's actions use it
  - gateway-env CMD # run CMD with the running gateway's environment, as node
  - refresh-snapshot # rewrite MEMORY.md's server snapshot
  - getcred VAR # print a configured credential (manual value or Vaultwarden through the vault service), e.g. getcred NAS_PASS
  - git-credential-openclaw # git's sign-in to Gitea, named in /etc/gitconfig (git-setup oneshot)
startos_managed_env_vars:
  - HOME
  - OPENCLAW_STATE_DIR
  - NODE_EXTRA_CA_CERTS
  - ANTHROPIC_API_KEY # bridged from auth-profiles.json when present (through .startos/gateway-secrets.env)
  - OPENAI_API_KEY
  - GEMINI_API_KEY
  - XAI_API_KEY
  - EMAIL_MODE / EMAIL_ADDRESS # while Email is enabled
  - GOG_HOME, GOG_KEYRING_BACKEND, GOG_KEYRING_PASSWORD, GOG_ACCOUNT # Google account
dependencies:
  - ollama # optional, kind: running + primary health check, only while selected
  - vllm # same
  - llama-cpp # same
  - simplex-websocket-bridge # optional, only while file exchange is enabled
  - vaultwarden, n8n, trilium, searxng, crawl4ai, ntfy, gitea # optional, only while "On this server" in Configure External Services
interfaces:
  ui: { type: ui, port: 18789 } # gateway password + one-time browser approval (approve-devices)
  webchat: { type: ui, port: 18800 } # only while enabled; per-profile PIN
actions: # grouped (startos/actions/groups.ts); all allowedStatuses any unless noted
  # Daily
  - review-agent-actions # greyed out while nothing waits
  - agent-activity
  - usage-and-cost
  - spending-alert
  # Email, Calendar, Contacts
  - configure-email
  - look-up-mail-servers # saves nothing
  - configure-calendar
  - look-up-calendar-server # saves nothing
  - configure-contacts
  - configure-apps-agent
  # Setup
  - set-password
  - configure-api-credentials # "Configure AI Provider"
  - configure-agents
  - configure-external-services
  - approve-devices # only-running; admits browsers waiting to pair with the Web UI
  # Channels
  - configure-webchat
  - connect-telegram
  - connect-whatsapp # only-running
  - configure-simplex
  # Maintenance
  - login-to-os # grants root-equivalent StartOS control
  - repair-openclaw # only-stopped; runs `openclaw doctor`
  - revoke-startos-access # never greyed out
tasks:
  - { action: set-password, severity: critical } # reactive
  - { action: configure-api-credentials, severity: critical } # install
  - { action: review-agent-actions, severity: important, replayId: agent-actions } # while anything waits
  - { action: configure-email|configure-calendar|configure-contacts, severity: important, replayId: fix-mail|fix-calendar|fix-contacts } # while that sign-in is refused
health_checks: # StartOS sorts by id; the numbers set the order
  - 11-gateway # "Web Interface": checkWebUrl on the bridge address; says nothing about the model
  - 12-webchat # while enabled
  - 13-vault # while Vaultwarden is enabled
  - 14-qdrant
  - 21-mail # the mail service's state (Gmail/IMAP); raises the approval and fix-it tasks
  - 22-calendar # while Calendar is on
  - 23-contacts # while Contacts is on
  - 31-spending
  - 32-server-access # whether start-cli is signed in; signed out = disabled (grey), signed in = failure (orange)
  - 40-ext-* # one per enabled external service, reachability only; 40-ext-email: Google account (gog) sign-in stored
```
