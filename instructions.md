# OpenClaw Setup Guide

OpenClaw is a self-hosted AI agent gateway. It works with Anthropic (Claude),
OpenAI, Google Gemini, xAI, or a local model server (Ollama, vLLM, llama.cpp).
This package includes OpenClaw plus a built-in Qdrant vector database for
long-term memory, the built-in rbw client for fetching credentials from a
vault, and optional integrations with your own self-hosted services
(Vaultwarden, Ollama, a NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy, Gitea).

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
| **Vaultwarden** | Secure credential storage through the built-in rbw client — enable this first if you use it |
| **Email** | Read, search and send email (Gmail, any IMAP/SMTP provider), or a Google account with Calendar and Drive — see [Email Setup](#email-setup) |
| **Ollama** | Local AI models for embeddings and vision analysis |
| **NAS** | Read/write files on your network storage |
| **n8n** | Trigger automated workflows |
| **Trilium Notes** | Create and organize research notes |
| **SearXNG** | Privacy-respecting web search |
| **Crawl4AI** | Fetch web pages in a real browser and return clean Markdown |
| **ntfy** | Send push notifications to your phone |
| **Gitea** | Your own git repositories: the agent creates, commits to and pushes repositories for its workspace and scripts — see [Gitea Setup](#gitea-setup) |

Built in, with nothing extra to install: reading PDFs (text, OCR of scanned
pages in English, ingest into Qdrant), and the rbw vault client that the
Vaultwarden option uses.

**Configure Vaultwarden first** if you use it — once it's enabled, credential
fields for other services will automatically offer to fetch from Vaultwarden
instead of requiring manual entry.

**Services on this server.** Vaultwarden, Ollama, n8n, Trilium, SearXNG,
Crawl4AI, ntfy and Gitea each offer three choices: *Disabled*, *On this server* and *At an
address*.

- **On this server**: the service is installed on this StartOS server from
  the Marketplace. OpenClaw finds it by itself over the server's internal
  network: no URL, host mapping or certificate. Only the credentials are
  asked for. The service shows up as a dependency on OpenClaw's page, and
  StartOS tells you if it isn't installed or isn't running. If it is
  reinstalled and its internal address changes, OpenClaw restarts on its own
  to pick up the new one.
- **At an address**: the service runs somewhere else (another computer, a
  NAS, the cloud); enter its URL as before.

Moving a service onto this server is just a change of choice; the URL you
had stays saved for switching back. The NAS and email are always
"at an address". If you use SearXNG on this server, leave its access
password off (the search skill doesn't send one). Ollama on this server here
covers vision and the Ollama skill; the embeddings address is set separately
in **Configure AI Provider → Memory Embeddings**.

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

The client side is part of this package: rbw 1.15.0, a Bitwarden-compatible
command-line client, is installed in the image for both x86_64 and aarch64,
and the package sets it up for you. It logs in and unlocks the vault at every
start, re-checks it every 5 minutes, and re-unlocks on its own when a skill
needs a credential. All you provide is your Vaultwarden server and account.

**To set up Vaultwarden integration:**

In Configure External Services, enable Vaultwarden and enter:
- Your Vaultwarden server URL
- Your account email
- Your master password — paste it exactly. It is stored byte-for-byte in a
  private file and never shown again; leave the field blank later to keep it.

Login uses the master password only (rbw does not support API-key login).

**If Vaultwarden has a `.local` name or an internal certificate**, also fill in:
- **Custom Host Mappings** — e.g. `vaultwarden.home.local` → `192.168.1.50`.
  StartOS treats `.local` as mDNS-only and never forwards it to your DNS
  server, so these names cannot resolve from inside a service otherwise.
- **Custom CA Certificate** — paste the PEM of the CA that signed the
  certificate, so HTTPS to it is trusted.

**Vaultwarden naming standard:**

One item per service, named after the service in lowercase:

| Service | Item | What OpenClaw reads |
|---|---|---|
| Email (Gmail app password or IMAP) | `email` | the login's **password** |
| NAS | `nas` | the login's **username** and **password** |
| n8n | `n8n` | hidden custom field `api_key` |
| Trilium | `trilium` | hidden custom field `api_key` |
| Crawl4AI | `crawl4ai` | hidden custom field `api_key` |
| ntfy | `ntfy` | hidden custom field `api_key` |
| Gitea | `gitea` | hidden custom field `api_key` |
| Google account | `google` | hidden custom fields `client_json` and `token_json` |

- For `email` and `nas`, create a normal **Login** item and fill in its own
  username/password; no custom fields needed.
- For keys, add a **hidden** custom field named `api_key` to the item.
- The two Google fields hold the whole contents of the two JSON files (see
  [Email Setup](#email-setup)).
- Names are matched without regard to upper/lower case, so an existing
  `NAS` item or `API_Key` field keeps working; the lowercase names above
  are the standard to use for new items.

---

## Email Setup

In **Configure External Services → Email**, pick one:

### Gmail (app password) — the simple way, mail only

1. Turn on 2-Step Verification for the Google account, if it isn't already:
   <https://myaccount.google.com/signinoptions/twosv>.
2. Create an app password at <https://myaccount.google.com/apppasswords>
   (name it "OpenClaw"). Google shows 16 letters once, in groups of four;
   the spaces between them don't matter.
3. In the form, enter the Gmail address and the app password (or choose
   **Fetch from Vaultwarden** and save it as the password of a Login item
   named `email`). Gmail's servers are filled in for you.

The agent can then read, search, send, reply and file mail. Calendar and
Drive need the Google account option below.

### Other IMAP/SMTP provider

Enter the address, the IMAP and SMTP servers with their ports and
encryption from your provider's help pages (typically IMAP 993 SSL/TLS and
SMTP 587 STARTTLS), and the password. Many providers (iCloud, Fastmail,
Yahoo, Outlook with two-factor sign-in) require an app-specific password
here. A server with a `.local` name or a private certificate needs a
**Custom Host Mapping** and the **Custom CA Certificate**, as for other
services.

### Google account (Gmail, Calendar, Drive)

This uses Google's own sign-in, which needs a browser, so you do it once
on your computer with the `gog` tool and bring the result to the server.
About 15 minutes the first time.

**1. Create your own Google Cloud app (once).**

1. Create a project at <https://console.cloud.google.com/projectcreate>.
2. Enable the Gmail, Google Calendar and Google Drive APIs (and any others
   you want) in the [API Library](https://console.cloud.google.com/apis/library).
3. Set up the [OAuth consent screen](https://console.cloud.google.com/auth/branding):
   "External", your own email address.
4. Under [Audience](https://console.cloud.google.com/auth/audience), click
   **Publish app** → **Confirm**. Without this the sign-in expires every 7
   days. (A personal app doesn't need Google's verification; you'll see an
   "unverified app" warning at sign-in, which is expected.)
5. Under [Clients](https://console.cloud.google.com/auth/clients), create an
   OAuth client of type **Desktop app** and download its JSON
   (`client_secret_….json`).

**2. Sign in on your computer (once).** Install gog
(<https://gogcli.sh>; on a Mac, `brew install gogcli`), then:

```
gog auth credentials ~/Downloads/client_secret_*.json
gog auth add you@gmail.com --services gmail,calendar,drive
gog auth tokens export you@gmail.com --out ~/Desktop/token.json
```

The second command opens your browser to approve access. `--services`
decides what the agent may use; add `contacts`, `docs` or `sheets` if you
want those too.

**3. Give both files to the server.** Either:

- **Fetch from Vaultwarden** (recommended): create a Vaultwarden item named
  `google` with two hidden custom fields, `client_json` and `token_json`,
  holding the contents of `client_secret_….json` and `token.json`. The
  package loads them at every start. Vaultwarden must be enabled.
- **Paste here**: paste both files' contents into the form once.

Either way the server keeps an encrypted copy for gog. Delete `token.json`
from your computer afterwards. The dashboard's **Google account** check
shows "Signed in as …" when it worked.

To renew or change the sign-in later (new services, revoked access), repeat
step 2 and update the Vaultwarden fields or paste the new token.

---

## Gitea Setup

With **Configure External Services → Gitea** enabled, the agent keeps its
work in your own git repositories: it creates a repository, commits and
pushes, without your help and without anything going to a public site.

1. **An account for the agent (recommended).** In Gitea, create a user just
   for the agent and give it access to the repositories it should use (or
   let it create its own). Its pushes then show under its own name, and its
   token reaches only those repositories. Your own account works too.
2. **A token.** Signed in to Gitea as that account: **Settings →
   Applications → Generate New Token**, with **repository: Read and Write**
   and **user: Read and Write**. Both are needed to create repositories;
   with repository alone the agent can only push to existing ones.
3. **Store it.** In Vaultwarden, item `gitea`, hidden custom field
   `api_key` (and keep "Fetch from Vaultwarden"), or paste it under
   *Enter manually*.
4. **Choose where Gitea runs.** *On this server* if Gitea is installed on
   this StartOS server, otherwise *At an address* with its URL.

What the package sets up, at every start:

- **git signs in by itself.** Every push and pull to Gitea uses the token,
  fetched at that moment. Nothing is written into repositories, remote URLs
  or `~/.git-credentials`.
- **Remotes keep working when addresses change.** With Gitea on this
  server, a remote written with any address Gitea shows (its clone URL, a
  LAN address and port, a private domain) is reached over the server's
  internal network instead. It no longer depends on that address, DNS or
  the certificate, and the same URL keeps working on your other computers.
- **Commit name and email** are left as they are. If none is set, the
  agent uses the Gitea account's (`gitea.py identity`).

**Already using Gitea with the agent?** Existing remotes need no change. To
see the set-up and find tokens stored in plain text (in a remote URL or
`~/.git-credentials`), ask the agent to run its Gitea check, or run it
yourself:

```
sudo start-cli package attach openclaw-extrabutter --name openclaw-sub
python3 /opt/skills/gitea/gitea.py check
exit
```

`check --fix` removes tokens from Gitea remote URLs. A credential helper
of your own for a Gitea address is no longer used for those remotes; the
check says how to remove it.

---

## Restoring a Custom Workspace

If you have an existing OpenClaw workspace in a git repository (Gitea,
GitHub, etc.), you can restore it after installation:

1. Connect to your Start9 server via SSH
2. Attach to the OpenClaw container:
   ```
   sudo start-cli package attach openclaw-extrabutter --name openclaw-sub
   ```
   Without `--name`, start-cli asks which container to use and shows a
   "multiple subcontainers found" message above the list. That message is
   the question, not an error: choose `openclaw-sub`.
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
