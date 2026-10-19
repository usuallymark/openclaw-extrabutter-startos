<p align="center">
  <img src="icon.png" alt="OpenClaw Logo" width="21%">
</p>

# OpenClaw Extra Butter (OpenClaw on StartOS)

> Everything not listed in this document should behave the same as upstream
> OpenClaw. If a feature, setting, or behavior is not mentioned here, the
> upstream documentation is accurate and fully applicable — see the
> Documentation section of `instructions.md` for links.

[OpenClaw](https://github.com/openclaw/openclaw) is a self-hosted AI agent gateway: a web chat and control panel in front of an LLM, reachable from messaging channels, with a workspace and memory of its own. This package runs the gateway, wires it to either a cloud provider or a local model server on the same box, and can — if you ask it to — give the agent administrative control of StartOS itself.

**This is a fork of the community package** ([Start9-Community/openclaw-startos](https://github.com/Start9-Community/openclaw-startos)) with its own package id, `openclaw-extrabutter`, shown in StartOS as **OpenClaw Extra Butter**. It installs alongside the community OpenClaw package and never replaces it; each has its own volumes, Qdrant and addresses. Don't connect both to the same Telegram bot or WhatsApp number. On top of the community package it adds:

- a bundled **Qdrant** vector database (its own volume) and a skill for it;
- **helper agents** the main agent can spawn, managed from an action (Configure Agents) or by the agent itself;
- a built-in **rbw** vault client (rbw 1.15.0, Bitwarden-compatible, installed for x86_64 and aarch64): point it at your Vaultwarden once and the package logs in and unlocks the vault at every start, keeps it unlocked, and lets the other services fetch their credentials from it instead of storing them in plain config;
- **Configure External Services**: optional skills for services you already run (Vaultwarden, Ollama, an SMB NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy and Gitea), plus host mappings and a custom CA for internal HTTPS services;
- **email**: Gmail with an app password or any IMAP/SMTP provider (himalaya 2.2.1), or a Google account with Gmail, Calendar and Drive (gog 0.44.0); every credential can live in Vaultwarden;
- a **mobile webchat** with one profile per person (optional);
- a built-in **pdf** skill (text extraction and OCR of scanned pages) and a **health** skill;
- **memory embeddings** settings and a daily server snapshot in the agent's memory.

- **Upstream repo:** <https://github.com/openclaw/openclaw>
- **This package:** <https://github.com/usuallymark/openclaw-extrabutter-startos> (releases carry the `.s9pk` files for sideloading: StartOS → System → Sideload a Service)

## Screenshots

The service dashboard, with a health check for every external service you enable:

![OpenClaw Extra Butter service dashboard with health checks](docs/screenshots/dashboard-health.png)

More: [Actions & Config](docs/screenshots/actions.png), Configure External Services ([part 1](docs/screenshots/external-services-1.png), [part 2](docs/screenshots/external-services-2.png)), or all of it as a [three-page PDF tour](docs/OpenClaw-Extra-Butter-tour.pdf). The screenshots are StartOS's own interface showing this package's real actions and forms, filled in with example values.

---

## Table of Contents

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [File Models](#file-models)
- [Dependencies](#dependencies)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Actions](#actions)
- [Tasks](#tasks)
- [Health Checks](#health-checks)
- [Backups and Restore](#backups-and-restore)
- [Limitations and Differences](#limitations-and-differences)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

---

## Image and Container Runtime

One image, built here.

| Property      | Value                               |
| ------------- | ----------------------------------- |
| Image         | Built from this repo's `Dockerfile` |
| Architectures | x86_64, aarch64                     |
| Command       | The gateway, bound to the LAN       |

| Subcontainer   | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `openclaw-sub` | The gateway, the webchat and the oneshots — the one to `attach` to |
| `qdrant-sub`   | Qdrant, from the official image                                    |

**The image also installs `start-cli`**, pinned to a version by a build argument. That binary is what lets the agent administer the server when you grant it access, and it is why the container needs StartOS's root certificate. It also carries the skills (`/opt/skills`), the GitHub CLI, `rbw`, Python libraries for the skills (`/opt/python-libs`, hash-pinned in `skills/requirements.txt`) and Tesseract for OCR.

Daemons: `qdrant`, `primary` (the gateway), and `webchat` while it is enabled.

Seven oneshots run before the gateway, and three after it:

| Oneshot                 | When   | Purpose                                                                                            |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `install-root-ca`       | Before | Installs StartOS's root CA so the container trusts the OS                                          |
| `chown`                 | Before | Hands `/data` to the unprivileged user the gateway runs as                                         |
| `network-setup`         | Before | Writes custom host mappings to `/etc/hosts` and installs a custom CA (Configure External Services) |
| `state-migrate`         | Before | Once per OpenClaw version: `openclaw doctor --non-interactive` to migrate the agent databases      |
| `setup-vault`           | Before | Logs `rbw` in to Vaultwarden, unlocks and syncs it; signs in again if Vaultwarden refuses the sync |
| `google-sign-in`        | Before | Google account kept in Vaultwarden: loads the OAuth client and sign-in token into gog              |
| `git-setup`             | Before | Writes git's system config: sign-in to Gitea and its address mapping (Configure External Services) |
| `check-login`           | After  | Raises a task if `start-cli` is not authenticated                                                  |
| `check-simplex-plugin`  | After  | Brings the SimpleX plugin up to the pinned version                                                 |
| `server-state-snapshot` | After  | Writes a server inventory (or, when not logged in, a health report) into `MEMORY.md`               |

**The first start after an OpenClaw update takes 1–2 minutes longer**, once: newer OpenClaw releases refuse to open agent databases written by older ones until `doctor` has migrated them with the gateway stopped. A marker (`/data/.startos/openclaw-doctor-version`) is written only on success; a failure is logged and retried at the next start and never blocks it.

**The gateway starts unconfigured on purpose.** It is launched with the flag that allows that, so the interface comes up and shows you what is missing rather than refusing to start.

## Volume and Data Layout

Two volumes.

| Volume   | Mount Point       | Purpose                     |
| -------- | ----------------- | --------------------------- |
| `main`   | `/data`           | The agent's entire home     |
| `qdrant` | `/qdrant/storage` | Qdrant's vector collections |

| Path                               | Written by  | Holds                                                    |
| ---------------------------------- | ----------- | -------------------------------------------------------- |
| `.openclaw/openclaw.json`          | Actions     | The gateway and agent configuration                      |
| `.openclaw/workspace/`             | Both        | The agent's identity, memory, and files                  |
| `.openclaw/agents/<id>/`           | OpenClaw    | Per-agent state database (sessions, auth, memory index)  |
| `.openclaw/external-services.json` | An action   | Configure External Services settings                     |
| `.openclaw/rbw/`                   | The package | `rbw` config, cache and the saved master password (0600) |
| `.openclaw/webchat/`               | Both        | Webchat profiles, its state and file hand-offs           |
| `.startos/auth-profiles.json`      | An action   | Provider API keys                                        |
| `.startos/embeddings.json`         | An action   | Memory-embeddings provider choice                        |
| `.startos/config.yaml`             | The package | Where `start-cli` points                                 |
| `.startos/openclaw-doctor-version` | The package | Last OpenClaw version `state-migrate` ran for            |
| `simplex.json`                     | An action   | Whether SimpleX file exchange is on                      |

**`SOUL.md`, `IDENTITY.md` and `MEMORY.md` are seeded once** from the image when missing, and then belong to you: updates never replace them (they may live in your own git repository).

**Every start rewrites one section of `MEMORY.md`** (`## Server State Snapshot`) with `refresh-snapshot`: when `start-cli` is logged in, the server's metrics, packages, notifications, gateways, disks and backup targets; otherwise the health report. It is how the agent knows what it is running on — and it means the memory file can contain an inventory of your server. **A daily heartbeat runs the same command.** Its instructions are the heartbeat prompt in the configuration (`agents.defaults.heartbeat`), rewritten by init on every install and update and delivered nowhere (`target: none`).

## File Models

Seven models, each owning a different boundary.

| File                     | Format | Written by                         |
| ------------------------ | ------ | ---------------------------------- |
| `openclaw.json`          | JSON   | Actions, init, and OpenClaw itself |
| `auth-profiles.json`     | JSON   | Configure AI Provider              |
| `embeddings.json`        | JSON   | Configure AI Provider              |
| `external-services.json` | JSON   | Configure External Services        |
| `webchat/config.json`    | JSON   | Configure Webchat                  |
| `config.yaml`            | YAML   | `main` and init                    |
| `simplex.json`           | JSON   | Configure SimpleX                  |

**The main configuration is shared with the application, not owned by the package.** OpenClaw edits it too — changing the model from inside the chat writes to the same file — which is why the dependency declaration reads it reactively rather than trusting the action to be the only writer.

Two gateway settings are **pinned** with `z.literal(true)`: the control UI being enabled, and the host-header origin fallback. The reason is structural: **StartOS fronts the gateway with its own reverse proxy on addresses that OpenClaw's origin check rejects.** With the fallback off, the interface simply refuses to connect. `main` also writes `gateway.trustedProxies` every start, set to the bridge address the proxy connects from — without it OpenClaw answers every proxied request with `403 proxy_attribution_required`. What remains in front of the gateway is its password and a one-time approval per browser — see [Network Access and Interfaces](#network-access-and-interfaces).

**API keys are stored in one place and consumed in another.** The action writes them into the auth-profiles file; OpenClaw reads them from the environment. `main` bridges the two at start, so a key added by the action reaches the gateway on the restart that follows. The file is the package's, which is why it lives under `.startos/` and not in OpenClaw's agent directory: a file of that name there is a retired credential source that OpenClaw's doctor archives and that makes the gateway refuse an agent whose own credential store is empty.

The `start-cli` configuration is rewritten at every start with the server's current address, so the agent's administrative tooling follows the box rather than a value recorded at install.

## Dependencies

All optional, and **each declared only while it is selected**. (Qdrant is bundled, not a dependency. External services set to *At an address* are reached by URL and are not dependencies; those set to *On this server* are.)

| Dependency               | Required             | Kind      | Why                           |
| ------------------------ | -------------------- | --------- | ----------------------------- |
| Ollama                   | No — only if chosen  | `running` | Local inference backend       |
| vLLM                     | No — only if chosen  | `running` | Local inference backend       |
| llama.cpp                | No — only if chosen  | `running` | Local inference backend       |
| SimpleX Websocket Bridge | No — only if enabled | `running` | Exchanging files over SimpleX |
| Vaultwarden, n8n, Trilium, SearXNG, Crawl4AI, ntfy, Gitea | No — only while *On this server* | `running` | Configure External Services (Ollama too, besides the AI backend) |

**The inference dependency follows the model you are actually using.** The declaration is derived from the primary model and its fallbacks, so selecting a local backend adds it and switching to a cloud provider drops it — including when the switch is made from inside the chat rather than through the action. Each is required to be running _and_ passing its own health check, since an unhealthy model server is the same as an absent one.

**A cloud provider needs no dependency at all**, only an API key and internet.

Local backends are reached over the internal bridge, and their API key is read directly out of the backend's own published volume rather than being asked for again.

SimpleX is different in kind: enabling it mounts the bridge's file-exchange directories into this container so the two can hand files to each other, and resolves the bridge's control socket over the bridge network.

## Network Access and Interfaces

Up to two interfaces.

| Interface | Id        | Type | Port  | Description                                       |
| --------- | --------- | ---- | ----- | ------------------------------------------------- |
| Web UI    | `ui`      | ui   | 18789 | The chat and the control panel                    |
| Webchat   | `webchat` | ui   | 18800 | Mobile webchat; exported only while it is enabled |

The Web UI is bound on the `ui-multi` MultiHost over HTTP and not masked. Qdrant (6333) is bound to the internal bridge only and never exported.

**The gateway password is the gate, and each browser is approved once.** OpenClaw's origin checking is relaxed for the reason given under [File Models](#file-models); its device pairing is not, and cannot be. A browser that passes the password is held at "Approve this browser" until the Approve Browser Pairing action admits it, and it then keeps a per-device credential until it is removed in the Web UI's device list. So anyone who can reach this address, knows the password, and can run that action has the agent — and, if StartOS access has been granted, the server. A `critical` task blocks the service from starting until that password is set, so there is no window where it is reachable without one.

Outbound, the gateway talks to whichever provider is configured, to any messaging channel you connect, to the external services you enable, and — for local backends and SimpleX — to the sibling service over the internal bridge.

**The webchat has its own gate**: anyone who can reach its address can open a profile that has no PIN. Give each profile a PIN if the address is reachable by others.

## Installation and First-Run Flow

Install creates the agent's directory structure, seeds its workspace from the image, points `start-cli` at the server, and pins the gateway settings. It then raises **two `critical` tasks**: set a gateway password, and configure an AI provider. Nothing in Configure External Services is required: with none of it set up, the agent still has the pdf, health, qdrant, agents and start-cli skills.

The first visit to the Web UI from any browser ends at "Approve this browser" after the password; running **Approve Browser Pairing** admits it and the page connects on its own.

**Neither can be skipped** — `critical` blocks startup, and an agent with no model and no password is not a usable state.

Once running, the gateway comes up on its interface and two more things happen automatically: it checks whether `start-cli` is authenticated and raises a task if not, and it writes the server snapshot into the agent's memory.

**Granting StartOS access is opt-in and deliberately not a critical task.** It is offered only after the gateway is up and only because the agent could not authenticate — see the action below before running it.

**Updating migrates OpenClaw's state** through the `state-migrate` oneshot (above), before the gateway starts. If vector memory search is paused afterwards, it also rebuilds the main agent's memory index (this needs a reachable embedding provider; without one, keyword memory search still works). The Repair OpenClaw action is the manual route for anything doctor cannot fix on its own. **Make a StartOS backup before updating**: the migration cannot be undone.

## Actions

Twelve actions.

### Set Gateway Password

Generates the password for the web interface and shows it once.

- **What it changes:** the password in the configuration.
- **Cost:** the service restarts.
- **Repeat safety:** each run generates a **new** password and invalidates the old one.

### Configure AI Provider

Chooses the backend — a cloud provider with an API key, or a local model server — plus the model and an optional fallback.

- **What it changes:** the API key in the auth-profiles file, the model selection in the configuration, and for a local backend, a provider entry pointing at that service's endpoint on the internal bridge.
- **Cost:** the service restarts, and the dependency set changes to match.
- **Repeat safety:** idempotent, pre-filled with the current selection.
- **Choosing a local backend makes that package a required dependency**; choosing a cloud provider removes it.
- **Memory Embeddings** chooses the provider for the agent's vector memory search (an Ollama server, OpenAI or Gemini). Left unset, OpenClaw falls back to keyword search.
- **Local Chat Models for Agents** offers the tool-capable models on an Ollama server to helper agents.

### Configure Agents

Adds, changes or removes the helper agents the main agent can spawn: model (cloud, or a model on your Ollama server), tool profile, skills, and who may start them. The agent can do the same through its `agents` skill. A spawned agent sees only its own `AGENTS.md`.

- **Cost:** none; changes apply without a restart.
- **Note:** OpenClaw cuts a spawned agent's final reply to 4,096 characters. Agents that produce long results should write them to a file and reply with the path (the starter `AGENTS.md` says so).

### Configure External Services

Connects the agent to email and self-hosted tools, each optional and independent: Vaultwarden (through the built-in `rbw` client; other services can then fetch their credentials from it), Email (below), Ollama, an SMB NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy and Gitea. Also: custom host mappings (StartOS never resolves `.local` names inside a service) and a custom CA certificate for internal HTTPS.

- **What it changes:** `external-services.json`; each enabled service loads its skill and gets a health check.
- **On this server / At an address** (Vaultwarden, Ollama, n8n, Trilium, SearXNG, Crawl4AI, ntfy, Gitea): *On this server* stores `location: "local"`; at every start `startos/localServices.ts` asks StartOS for the service's bridge address (`sdk.host.getBridgeAddress`, plain HTTP inside the server) from one table of package id, host id and port, and puts it in `url`, so the skill environment, rbw's `base_url` and the health checks need nothing else. The service becomes an optional dependency (`kind: running`) only while chosen. Not installed → the health check says so. Older settings have no `location` and stay *At an address*; the stored URL is kept while *On this server* is chosen. rbw keys its local vault copy by server URL, so a new address simply signs in again. Adding a service = one table row (a `urlSuffix` for a path the URL carries: Trilium's `/etapi`).
- **Gitea and git** (`startos/gitea.ts`): besides `GITEA_URL` and the token for the `gitea` skill, the `git-setup` oneshot writes git's *system* config (`/etc/gitconfig` in the container, rewritten at every start, so `~/.gitconfig` stays the user's): `credential.<Gitea URL>.helper` → `/usr/local/bin/git-credential-openclaw`, which asks `getcred GITEA_KEY` at every push/pull (Gitea signs in as the token's owner whatever the username; git never stores it), and, *On this server*, `url.<bridge>.insteadOf` for every address Gitea publishes for its `http` interface (`sdk.host.get` on Gitea's `main` host, `nonLocal` URLs), so remotes using them reach it over the bridge; and, in both modes, `url.<Gitea URL>.insteadOf gitea:`, the placeholder new remotes are written with (`gitea:OWNER/REPO.git`), which always means Gitea's current address. Gitea builds API clone and web URLs from the address a request arrived at (`PUBLIC_URL_DETECTION = auto`), i.e. the bridge, so `gitea.py` never uses them as remotes; for links shown to people the package passes `GITEA_WEB_URL`, the best published address (https, then domain > LAN IPv4 > `.local`). `gitea.py check [--fix]` reports the set-up, strips tokens written into Gitea remote URLs and changes bridge-address remotes to `gitea:`.
- **Cost:** the service restarts.
- **Email** has one choice with three backends; only one email skill loads:
  - *Gmail (app password)* and *Other IMAP/SMTP provider* use `himalaya` 2.x. The package writes `/data/.openclaw/himalaya/config.toml` at every start (`HIMALAYA_CONFIG`); the password is never in it: himalaya runs `getcred EMAIL_PASS` (manual value, or Vaultwarden item `email`, its login password). Skill: `email`.
  - *Google account (Gmail, Calendar, Drive)* uses `gog`. The OAuth client and the sign-in token (made once with `gog auth add` on a computer with a browser, then `gog auth tokens export`) are either fetched from Vaultwarden item `google` (fields `client_json`, `token_json`) by the `google-sign-in` oneshot at every start, or pasted once. gog keeps them in an encrypted file keyring under `/data/.openclaw/gog`; the keyring password is generated once (`/data/.startos/gog-keyring-password`). The Vaultwarden pointers are not in the agent's environment. Skill: `google`.
  - OpenClaw's own bundled `himalaya` and `gog` skills are kept disabled (`skills.entries`): the bundled himalaya one documents the 1.x CLI, and both tell the agent to set up credentials itself.

### Configure Webchat

Turns the mobile webchat on or off and manages one profile per person (name, color, greeting, preset conversations, optional PIN).

- **Cost:** the service restarts; the Webchat interface appears or disappears.

### Connect Telegram

Enables the Telegram channel with a bot token and a policy for who may direct-message the agent.

### Connect WhatsApp

Enables the WhatsApp channel with a DM policy and an allow-list of numbers.

- **Requires the service to be running**, since pairing happens against the live gateway.

### Configure SimpleX

Enables the SimpleX channel and its DM policy, and turns file exchange with the bridge on or off.

- **What it changes:** the channel configuration, the plugin policy, and whether the bridge's directories are mounted.
- It repairs the plugin's enablement and allow-list entries when it skips an install because the plugin is already current — an installed plugin still has to be enabled and named to load.

### Approve Browser Pairing

Admits every browser waiting at "Approve this browser" on the Web UI.

- **Requires the service to be running**, since the pending requests live in the gateway.
- **What it changes:** each pending pairing request becomes an approved operator device with a durable per-device credential. Remove one from the Web UI's device list.
- **Repeat safety:** approves whatever is pending at that moment — nothing, if nobody is waiting — so run it right after your own login attempt, not on a schedule.

### Login to StartOS

Authenticates the agent's `start-cli` against this server, using your StartOS master password.

- **This grants the agent root-equivalent control of the server.** It can then start and stop packages, read logs, change network settings, and run backups. The action's own warning says to do it only on a server designated for development, and that warning should be taken literally.
- **What it changes:** a `start-cli` session stored on the volume.
- Everything that reaches the chat can then reach the server, which makes the gateway password and the channel DM policies load-bearing for the whole box.

### Revoke StartOS Access

Removes that session.

- **What it changes:** the stored authentication, deleted.
- The agent keeps working; it just cannot administer the server until you log in again.

### Repair OpenClaw

Runs one of OpenClaw's own maintenance commands against the stopped service and returns its output and exit code.

- **Requires the service to be stopped.** Doctor takes ownership of the state database.
- **Two commands, each with a report-only default:** `doctor --lint` reports, `doctor --fix --non-interactive` repairs config, plugin policy and state; `doctor --session-sqlite dry-run` counts importable legacy session history, `--session-sqlite import` imports it.
- **What it changes:** with a toggle on, whatever doctor decides to repair — config normalization, state-database migrations, legacy file imports. Back up first; the action's warning says so.
- The package update already runs the repairing forms for you (see [Installation and First-Run Flow](#installation-and-first-run-flow)); this action is for a gateway that still refuses to start afterwards, or for reading doctor's report.

## Tasks

Three, two of them blocking (a SimpleX plugin task may also appear when the bundled OpenClaw needs a newer plugin).

| Task                  | Severity    | Raised when                                       | Cleared when    |
| --------------------- | ----------- | ------------------------------------------------- | --------------- |
| Set Gateway Password  | `critical`  | Any init that finds no password                   | The action runs |
| Configure AI Provider | `critical`  | Install with no credentials stored                | The action runs |
| Login to StartOS      | `important` | A start-up that finds `start-cli` unauthenticated | The action runs |

`critical` blocks the service from starting, so a fresh install shows the two setup tasks and nothing else. `important` is advisory — the login task appears every start until it is either done or ignored, and ignoring it is a legitimate choice.

## Health Checks

| Check           | Displayed as             | Method                                                         |
| --------------- | ------------------------ | -------------------------------------------------------------- |
| `primary`       | "Web Interface"          | The gateway's `/healthz` on its own bridge address (40s grace) |
| `qdrant`        | "Qdrant Vector Database" | Port open, then Qdrant's `/readyz`                             |
| `webchat`       | "Webchat"                | Its `/healthz`, while enabled                                  |
| `vault`         | "Vault (rbw)"            | An unlock and a sync every 5 minutes, while Vaultwarden is enabled |
| `ext-<service>` | The service's name       | Reachability every minute, for each enabled external service   |
| `ext-email`     | "Email (IMAP)" / "Google account" | IMAP server reachable; for Google, a stored sign-in for the address (local, no network) |

The external checks test reachability only; the `health` skill (`/opt/skills/health/health.py`) also tests the n8n, Trilium and Gitea API keys (Gitea: names the token's account), the IMAP and SMTP logins, the Google sign-in (Google refreshes the token) and memory search. **None of them says anything about the model**: a wrong API key, a rate limit, or a local backend that is running but not loaded all show green checks and an error in the chat.

## Backups and Restore

Both volumes are copied wholesale — `sdk.Backups.ofVolumes('main', 'qdrant')`. That is the whole agent: configuration, provider API keys, the gateway password, channel tokens, the workspace, the accumulated memory, and the vector collections.

**The backup contains every credential the agent holds**, in recoverable form: provider keys, the Telegram bot token, the saved Vaultwarden master password and any manually entered service keys, and — if StartOS access was granted — the session that administers your server. Treat it accordingly.

It also contains the server snapshot written into memory, which is an inventory of what is installed on this box.

A restored instance comes back configured and remembers what it knew. The `start-cli` address is rewritten to the new server on the first start, but the **session is not** — an agent restored onto a different server has to be logged in again before it can administer that one.

## Limitations and Differences

1. **Granting StartOS access gives the agent root-equivalent control of the server.** It is optional and revocable, and it is the single most consequential thing this package can do.
2. **Origin checking is relaxed and the reverse proxy is trusted**, because StartOS's addresses do not satisfy OpenClaw's checks. The gateway password and a one-time approval per browser are the gate.
3. **The backup holds every credential**, including the server session.
4. **The configuration is co-owned with the application**, which edits it at runtime — a change made in the chat is as real as one made through an action.
5. **The agent's memory contains a server inventory**, rewritten every start.
6. **Local backends must be running and healthy**, or the gateway has no model.
7. **A cloud provider sends your conversations to that provider.** Only a local backend keeps them on the box.
8. **The heartbeat prompt is rewritten on every init**; edits to it do not survive. Put your own heartbeat checklist in the monitor scratch (`openclaw cron scratch`), which is appended to the prompt and left alone.
9. **Spawned agents' final replies are capped at 4,096 characters** by OpenClaw.
10. **Separate from the community package**: a different package id, so there is no update path between the two. Moving from one to the other is a fresh install; StartOS backups restore only into the same package id.

---

## Quick Reference for AI Consumers

```yaml
package_id: openclaw-extrabutter # title: OpenClaw Extra Butter
image: built from ./Dockerfile # also installs pinned start-cli, rbw, himalaya and gog binaries
architectures:
  - x86_64
  - aarch64
subcontainers:
  - openclaw-sub # gateway + webchat run as `node` (HOME=/data); oneshots that chown run as root
  - qdrant-sub
volumes:
  main: /data # HOME and OPENCLAW_STATE_DIR both live here
  qdrant: /qdrant/storage
file_models:
  - .openclaw/openclaw.json # gateway + agent config; OpenClaw writes it too
  - .openclaw/external-services.json
  - .openclaw/webchat/config.json
  - .startos/auth-profiles.json # provider API keys; package-owned, not OpenClaw's agent dir
  - .startos/embeddings.json
  - .startos/config.yaml # start-cli host, rewritten each start
  - simplex.json # whether SimpleX file exchange is enabled
  - .openclaw/himalaya/config.toml # email (IMAP choices), rewritten each start; no password in it
helpers_in_container:
  - gateway-env CMD # run CMD with the running gateway's environment, as node
  - refresh-snapshot # rewrite MEMORY.md's server snapshot
  - getcred VAR # print a configured credential (manual value or Vaultwarden via rbw), e.g. getcred NAS_PASS
  - git-credential-openclaw # git's sign-in to Gitea, named in /etc/gitconfig (git-setup oneshot)
startos_managed_env_vars:
  - HOME
  - OPENCLAW_STATE_DIR
  - NODE_EXTRA_CA_CERTS
  - ANTHROPIC_API_KEY # bridged from auth-profiles.json when present
  - OPENAI_API_KEY
  - GEMINI_API_KEY
  - XAI_API_KEY
  - EMAIL_MODE / EMAIL_ADDRESS # while Email is enabled
  - HIMALAYA_CONFIG, EMAIL_PASS or EMAIL_PASS_FROM_VAULT # IMAP choices
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
actions:
  - set-password
  - configure-api-credentials
  - configure-agents
  - configure-external-services
  - configure-webchat
  - connect-telegram
  - connect-whatsapp # only-running
  - configure-simplex
  - approve-devices # only-running; admits browsers waiting to pair with the Web UI
  - login-to-os # grants root-equivalent StartOS control
  - revoke-startos-access
  - repair-openclaw # only-stopped; runs `openclaw doctor`
tasks:
  - { action: set-password, severity: critical } # reactive
  - { action: configure-api-credentials, severity: critical } # install
  - { action: login-to-os, severity: important } # raised at start when unauthenticated
health_checks:
  - primary # checkWebUrl against the service's own bridge address; says nothing about the model
  - qdrant
  - webchat # while enabled
  - vault # while Vaultwarden is enabled
  - ext-* # one per enabled external service, reachability only
  - ext-email # IMAP server reachable, or a stored Google sign-in for the address
```
