# OpenClaw Setup Guide

OpenClaw is a self-hosted AI agent gateway. It works with Anthropic (Claude),
OpenAI, Google Gemini, xAI, or a local model server (Ollama, vLLM, llama.cpp).
This package includes OpenClaw plus a built-in Qdrant vector database for
long-term memory, and optional integrations with your own self-hosted services
(Vaultwarden via rbw, Ollama, a NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy).

---

## Quick Start

### 1. Set a Gateway Password

Run the **Set Password** action. This is the password you'll use to log into
the OpenClaw web interface. Choose something you'll remember — it protects
access to your AI agent.

### 2. Configure an AI Provider

Run the **Configure AI Provider** action and enter your API key for your
chosen provider (Anthropic Claude, OpenAI, etc.). Without this, OpenClaw
cannot process any requests.

### 3. Configure External Services (Optional but Recommended)

Run the **Configure External Services** action to connect OpenClaw to your
self-hosted tools. Each service can be independently enabled or disabled:

| Service | What it enables |
|---|---|
| **Vaultwarden** | Secure credential storage — enable this first if you use it |
| **Ollama** | Local AI models for embeddings and vision analysis |
| **NAS** | Read/write files on your network storage |
| **n8n** | Trigger automated workflows |
| **Trilium Notes** | Create and organize research notes |
| **SearXNG** | Privacy-respecting web search |
| **Crawl4AI** | Fetch web pages in a real browser and return clean Markdown |
| **ntfy** | Send push notifications to your phone |

Reading PDFs (text, OCR of scanned pages in English, ingest into Qdrant)
is built in and needs no external service.

**Configure Vaultwarden first** if you use it — once it's enabled, credential
fields for other services will automatically offer to fetch from Vaultwarden
instead of requiring manual entry.

### 4. Open the Web Interface

Find the OpenClaw interface address under **Interfaces** in the StartOS UI.
Log in with the gateway password you set in Step 1. The page then waits at
"Approve this browser": run the **Approve Browser Pairing** action once, and
the page connects on its own.

### 5. Memory search (optional)

In **Configure AI Provider → Memory Embeddings**, choose where the agent's
memory embeddings come from (an Ollama server, OpenAI or Gemini). Without it,
the agent's memory search uses keywords only.

### 6. Giving the agent control of StartOS (optional, think first)

**Login to StartOS** lets the agent run `start-cli` against this server:
start and stop services, read logs, change settings. That is root-equivalent
control, reachable by anything that can talk to the agent. It is off unless
you run the action, and **Revoke StartOS Access** turns it off again.

---

## Vaultwarden Setup

Vaultwarden stores all your service credentials securely. OpenClaw fetches
them automatically at startup, so you never need to enter passwords directly
into skill files.

**To set up Vaultwarden integration:**

In Configure External Services, enable Vaultwarden and enter:
- Your Vaultwarden server URL
- Your account email
- Your master password — paste it exactly. It is stored byte-for-byte in a
  private file and never shown again; leave the field blank later to keep it.

Login uses the master password only (rbw does not support API-key login).
The vault unlocks at startup and re-unlocks automatically when a skill needs it.

**If Vaultwarden has a `.local` name or an internal certificate**, also fill in:
- **Custom Host Mappings** — e.g. `vaultwarden.home.local` → `192.168.1.50`.
  StartOS treats `.local` as mDNS-only and never forwards it to your DNS
  server, so these names cannot resolve from inside a service otherwise.
- **Custom CA Certificate** — paste the PEM of the CA that signed the
  certificate, so HTTPS to it is trusted.

**Vaultwarden entry naming convention:**

OpenClaw looks up credentials by entry name and field. Use these exact names:

| Service | Entry Name | Field |
|---|---|---|
| n8n | `n8n` | `API_Key` |
| Trilium | `Trilium` | `API_Key` |
| NAS username | `NAS` | `username` |
| NAS password | `NAS` | `Password` |
| Crawl4AI | `Crawl4AI` | `API_Key` |
| ntfy | `ntfy` | `API_Key` |

---

## Restoring a Custom Workspace

If you have an existing OpenClaw workspace in a git repository (Gitea,
GitHub, etc.), you can restore it after installation:

1. Connect to your Start9 server via SSH
2. Attach to the OpenClaw container:
   ```
   sudo start-cli package attach openclaw-extrabutter
   ```
3. Clone your workspace:
   ```
   cd /data/.openclaw/workspace
   git init
   git remote add origin https://YOUR-GITEA-URL/YOUR-REPO.git
   git fetch origin master
   cp /data/.openclaw/openclaw.json /data/.openclaw/openclaw.json.bak
   git reset --hard origin/master
   cp /data/.openclaw/openclaw.json.bak /data/.openclaw/openclaw.json
   ```

This preserves the package-managed `openclaw.json` while restoring all your
custom workspace files (AGENTS.md, skills, workspaces, etc.).

---

## Updating

When a new version of this package is available, download the `.s9pk` file
and sideload it via **StartOS → System → Sideload a Service**. Your data
and configuration are preserved automatically.

---

## Webchat (optional)

A mobile-friendly chat app with one profile per person. It is **off by
default**.

1. Run **Configure Webchat**, choose **Enabled**, and add a profile for each
   person: a short ID (e.g. `alex`), a display name, a color, and optionally a
   greeting prompt, preset conversations (one per line) and a PIN.
2. Save. OpenClaw restarts and a **Webchat** address appears under
   **Interfaces**.
3. Open that address on each phone. With more than one profile you'll see a
   picker; each profile lives at `/u/<id>/`. Use **Add to Home Screen** to
   install it as an app.

**Privacy:** anyone who can reach the Webchat address can open profiles that
have no PIN. Each profile only sees its own conversations. A PIN is asked once
per device and remembered for the period you choose; setting a new PIN signs
out every device for that profile. On iPhone, the home-screen app asks once
more after installing because it keeps its own storage.

**Avatar:** a default avatar is included. To use your own, paste it into
**Avatar image** in Configure Webchat as base64 text (PNG, JPEG or WebP, up to
1 MB). On a Mac: `base64 -i picture.jpg | pbcopy`, then paste. A square image
of 512×512 or larger looks best as a home-screen icon. To give one profile its
own picture, place `avatars/<id>.png` (or `.jpg`/`.webp`) in
`/data/.openclaw/webchat/`.

**Topics:** each conversation tells the agent its topic when it starts:
the greeting prompt is sent with "This conversation is about: <name>" added
(or wherever you put `{topic}` in the greeting). This happens before the first
message even if someone types right away, and only once per conversation.
General has no topic.

**Files:** while the webchat is on, the agent can send files as download
buttons (links expire after 24 hours).

Deleting a conversation (×) archives it in OpenClaw rather than erasing it.
General and preset conversations can't be deleted, only cleared (⟲): the old
conversation is archived and an empty one takes its place. To remove a preset,
delete its line in Configure Webchat.

---

## Troubleshooting

**Health check shows "not ready":**
Check the service logs (StartOS → OpenClaw → Logs) for error messages.
Common causes: missing AI provider key, Qdrant startup delay (allow 30s).

**Vaultwarden credentials not loading:**
Check the logs for the `setup-vault` step. "error sending request" usually
means a `.local` name without a Custom Host Mapping, or an internal HTTPS
certificate without the Custom CA Certificate. An authentication error means
the master password is wrong — re-enter it exactly in Configure External
Services.

**Health checks:**
The service page shows a check for each enabled external service and, if
Vaultwarden is enabled, for the vault. External checks only test that the
service is reachable from OpenClaw (every minute); they do not test stored
API keys. A red check names the address that failed. "Could not resolve host"
usually means a `.local` name without a Custom Host Mapping; a certificate
error means the Custom CA Certificate is missing. The vault check performs a
full unlock every 5 minutes, so a wrong master password shows up quickly.

**Webchat shows "Reconnecting…":**
The webchat is running but cannot reach the OpenClaw gateway. Check the
**Webchat** health check and the service logs (lines start with `[webchat]`).

**Skills not working after enabling a service:**
OpenClaw must be restarted after configuring external services. The restart
happens automatically when you save the Configure External Services action.

**Workspace files lost after update:**
Updates preserve the `/data` volume. If files are missing, your workspace
may not have been restored from git. Follow the "Restoring a Custom Workspace"
steps above.
