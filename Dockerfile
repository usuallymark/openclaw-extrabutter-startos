# Node is pinned to an exact release, never a floating tag (UPDATING.md,
# "The Node base image"). 26.12.1 is the October 2026 security release.
FROM node:26.12.1-bookworm-slim

ARG START_CLI_VERSION
ARG GH_VERSION=2.102.0
ARG OPENCLAW_VERSION=2026.10.1

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    procps \
    python3 \
    ripgrep \
    tmux \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (direct binary)
RUN ARCH="$(dpkg --print-architecture)" && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local

# Install uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Install openclaw using the official install script (non-interactive)
# HOME is set to /data (the runtime volume path) so openclaw installs there.
# This matches where the package mounts the main volume at runtime.
ENV HOME=/data
RUN mkdir -p /data && \
    curl -fsSL https://openclaw.bot/install.sh | bash -s -- --no-prompt --no-onboard --version "${OPENCLAW_VERSION}"

# Install start-cli from its product-scoped release in the start-technologies
# monorepo (see UPDATING.md). Authenticated at runtime by "Login to StartOS".
RUN curl -fsSL "https://github.com/Start9Labs/start-technologies/releases/download/start-cli%2Fv${START_CLI_VERSION}/start-cli_$(uname -m)-linux" -o /usr/local/bin/start-cli \
    && chmod +x /usr/local/bin/start-cli

# Python libraries for the skills, hash-pinned in skills/requirements.txt
# (generated from skills/requirements.in) and installed in the image so
# nothing depends on files in the data volume:
# - NAS skill: Samba's smbclient (lists shares) + smbprotocol (file access)
# - PDF skill: OCRmyPDF + Tesseract with English (and OSD for page
#   rotation). No Ghostscript: OCRmyPDF 17 rasterizes with pypdfium2 and
#   the skill writes plain PDFs.
# - cryptography: also imported directly by workspace scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
        smbclient tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd \
    && rm -rf /var/lib/apt/lists/*
COPY skills/requirements.txt /tmp/python-requirements.txt
RUN uv pip install --python /usr/bin/python3 --target /opt/python-libs \
        --require-hashes --only-binary :all: --no-cache \
        -r /tmp/python-requirements.txt \
    && rm /tmp/python-requirements.txt \
    && PYTHONPATH=/opt/python-libs python3 -c 'import smbclient, cryptography, ocrmypdf, pypdfium2' \
    && PYTHONPATH=/opt/python-libs python3 -m ocrmypdf --version \
    && tesseract --list-langs \
    && smbclient --version
ENV PYTHONPATH=/opt/python-libs

# Install pinentry-curses (required by rbw)
RUN apt-get update && apt-get install -y --no-install-recommends pinentry-curses && rm -rf /var/lib/apt/lists/*

# Install rbw (Vaultwarden CLI) for credential retrieval at runtime.
# rbw is used by the agent's skills to fetch secrets from Vaultwarden.
# Configuration and XDG dirs are set up at runtime via the setup-vault oneshot.
# - amd64: install from official .deb release
# - arm64: prebuilt binaries from this repo's rbw-arm64-1.15.0 release
#   (built once by .github/workflows/build-rbw-arm64.yml; sha256-pinned)
RUN ARCH="$(dpkg --print-architecture)" && \
    if [ "$ARCH" = "amd64" ]; then \
        curl -fsSL "https://git.tozt.net/rbw/releases/deb/rbw_1.15.0_amd64.deb" -o /tmp/rbw.deb && \
        dpkg -i /tmp/rbw.deb && \
        rm /tmp/rbw.deb; \
    elif [ "$ARCH" = "arm64" ]; then \
        RBW_URL="https://github.com/usuallymark/openclaw-extrabutter-startos/releases/download/rbw-arm64-1.15.0" && \
        curl -fsSL "$RBW_URL/rbw" -o /usr/local/bin/rbw && \
        curl -fsSL "$RBW_URL/rbw-agent" -o /usr/local/bin/rbw-agent && \
        echo "11e2fc0effa04148388fa03c71e39edb3a191ea9a7909d81d3d330ee99de05c6  /usr/local/bin/rbw" | sha256sum -c - && \
        echo "4854370cc9fb74af3ed5c82159ddebbe5c63e6e9cc70176f6ea417b25be1d3c5  /usr/local/bin/rbw-agent" | sha256sum -c - && \
        chmod 755 /usr/local/bin/rbw /usr/local/bin/rbw-agent; \
    else \
        echo "Unsupported arch: $ARCH" && exit 1; \
    fi

# Google account email option (Configure Email): gog, the Google Workspace
# CLI (Gmail, Calendar, Drive …). Static binary, sha256-pinned per
# architecture; the pins match upstream's checksums.txt (see UPDATING.md).
# Gmail and IMAP need no client program: the mail service below talks IMAP
# itself (Python standard library).
ARG GOG_VERSION=0.44.0
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in \
      amd64) GSHA=9e40b7e51be9162e5ab92d255376257e4d594e9e64dc360fffccd85ba4e1c0c0 ;; \
      arm64) GSHA=0346149cac6630996c69911ac7366c3c1a36d8835b23e985e90c3f8d25c7ab65 ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/gog.tgz && \
    echo "$GSHA  /tmp/gog.tgz" | sha256sum -c - && \
    tar -xzf /tmp/gog.tgz -C /usr/local/bin ./gog && \
    chmod 755 /usr/local/bin/gog && \
    rm /tmp/gog.tgz && \
    gog --version

# Mail service (Configure Email → Gmail or IMAP): its own user, which the
# agents (user node) cannot become, and code only root can change. Two
# daemons start as root and become openclaw-mail: front.py (the MCP
# endpoint, no secrets) and launch.py → mailservice.py (the mailbox side).
# See startos/mailService.ts. agent/ holds the email agent's starting
# instructions.
RUN useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin openclaw-mail
COPY mail/launch.py mail/front.py mail/mcp.py mail/mailservice.py mail/imapmail.py mail/message.py mail/sanitize.py mail/extract.py /opt/openclaw-mail/
COPY mail/agent/AGENTS.md mail/agent/SOUL.md mail/agent/IDENTITY.md /opt/openclaw-mail/agent/
RUN chmod 755 /opt/openclaw-mail /opt/openclaw-mail/agent && chmod 644 /opt/openclaw-mail/*.py /opt/openclaw-mail/agent/* \
    && python3 -m compileall -q /opt/openclaw-mail \
    && cd /tmp && python3 -I -c 'import sys; sys.path.insert(0, "/opt/openclaw-mail"); import mailservice, launch, front'

# Stage skill files (loaded via extraDirs in openclaw.json)
# start-cli skill (always loaded)
COPY skills/start-cli/SKILL.md /opt/skills/start-cli/SKILL.md
# External service skills (loaded when service is enabled via Configure External Services)
COPY skills/rbw/SKILL.md skills/rbw/creds.py /opt/skills/rbw/
COPY skills/rbw/getcred skills/rbw/gateway-env /usr/local/bin/
RUN chmod 755 /usr/local/bin/getcred /usr/local/bin/gateway-env
COPY skills/qdrant/SKILL.md skills/qdrant/qdrant.py /opt/skills/qdrant/
COPY skills/health/SKILL.md skills/health/health.py skills/health/snapshot.py /opt/skills/health/
RUN ln -s /opt/skills/health/snapshot.py /usr/local/bin/refresh-snapshot && chmod 755 /opt/skills/health/snapshot.py
COPY skills/pdf/SKILL.md skills/pdf/pdf.py /opt/skills/pdf/
COPY skills/agents/SKILL.md skills/agents/agents.py /opt/skills/agents/
COPY skills/ollama/SKILL.md /opt/skills/ollama/SKILL.md
COPY skills/nas/SKILL.md skills/nas/nas.py /opt/skills/nas/
COPY skills/n8n/SKILL.md /opt/skills/n8n/SKILL.md
COPY skills/trilium/SKILL.md /opt/skills/trilium/SKILL.md
COPY skills/searxng/SKILL.md /opt/skills/searxng/SKILL.md
COPY skills/crawl4ai/SKILL.md skills/crawl4ai/crawl4ai.py /opt/skills/crawl4ai/
COPY skills/ntfy/SKILL.md skills/ntfy/ntfy.py /opt/skills/ntfy/
COPY skills/ntfy/notify /usr/local/bin/notify
RUN chmod 755 /usr/local/bin/notify
COPY skills/gitea/SKILL.md skills/gitea/gitea.py /opt/skills/gitea/
# git's sign-in to Gitea; named in /etc/gitconfig by the git-setup oneshot.
COPY skills/gitea/git-credential-openclaw /usr/local/bin/git-credential-openclaw
RUN chmod 755 /usr/local/bin/git-credential-openclaw
COPY skills/webchat-present/SKILL.md /opt/skills/webchat-present/SKILL.md
COPY skills/email/SKILL.md /opt/skills/email/SKILL.md
COPY skills/google/SKILL.md /opt/skills/google/SKILL.md

# Webchat (optional; started only when enabled via Configure Webchat).
# Dependencies are pinned in webchat/package-lock.json.
COPY webchat/package.json webchat/package-lock.json /opt/webchat/
RUN cd /opt/webchat && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY webchat/server.mjs webchat/present.mjs /opt/webchat/
COPY webchat/ui /opt/webchat/ui
COPY webchat/assets /opt/webchat/assets

# Stage workspace bootstrap files
COPY workspace/SOUL.md /opt/workspace/SOUL.md
COPY workspace/IDENTITY.md /opt/workspace/IDENTITY.md
COPY workspace/MEMORY.md /opt/workspace/MEMORY.md

# Set runtime environment variables
# HOME and OPENCLAW_STATE_DIR point to /data — the persistent volume mount point.
# All openclaw state, workspace, and rbw config lives under /data/.openclaw/
ENV NODE_ENV=production
ENV HOME=/data
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Include openclaw binary paths
ENV PATH="/data/.openclaw/bin:/usr/local/lib/node_modules/openclaw/bin:/usr/local/bin:$PATH"

WORKDIR /data

# The entrypoint will be provided by the StartOS daemon configuration
CMD ["openclaw", "gateway", "--port", "18789", "--bind", "lan"]
