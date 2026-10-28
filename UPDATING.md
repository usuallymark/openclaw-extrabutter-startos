# Updating the upstream version

OpenClaw is installed into the image at build time by the official `openclaw.bot` installer, with the version pinned by the `OPENCLAW_VERSION` build ARG in `Dockerfile`. There is no `dockerTag` in the manifest. The image also bundles the GitHub CLI (`gh`, pinned by `GH_VERSION`) into the in-container workspace, where the OpenClaw agent relies on it.

**Treat `gh` as part of the OpenClaw update, not a separate pin.** Whenever you update OpenClaw, check `gh` in the same pass and bump it too if a newer stable release exists. The two ARGs move together.

## Determining the upstream version

- **OpenClaw** — canonical home: [openclaw/openclaw](https://github.com/openclaw/openclaw) (the `upstreamRepo`). Ask npm, not GitHub: the installer resolves the version through npm, and upstream maintains several release lines at once (`extended-stable` on the older series, `beta` on the next one), so the newest GitHub tag by date is routinely _not_ the one to pin.

  ```
  curl -s https://registry.npmjs.org/openclaw | jq -r '."dist-tags".latest'
  ```

  Pin that value verbatim in `Dockerfile` as `OPENCLAW_VERSION`. Never pin a `beta`/`alpha` dist-tag.

  Two more pins move with it. Upstream drops Node lines between releases, so check the floor against the base image (`FROM node:<version>-bookworm-slim` in `Dockerfile`):

  ```
  npm view openclaw@<version> engines.node
  ```

  And the SimpleX plugin declares which OpenClaw it loads on, so raise `MIN_PLUGIN_VERSION` in `startos/actions/configureSimplex.ts` to the plugin release whose peer range admits the new OpenClaw (a startup task then asks users to re-submit Configure SimpleX):

  ```
  npm view @dangoldbj/openclaw-simplex version peerDependencies.openclaw
  ```

  > [!WARNING]
  > **A `-N` suffix is a post-release correction upstream, but a _pre_-release to ExVer — never let it into the package version.**
  > Upstream ships fixes to an already-released version as `X.Y.Z-1`, `X.Y.Z-2`, … and moves the npm `latest` dist-tag onto them. ExVer reads that suffix as a prerelease and orders it _below_ plain `X.Y.Z`, so a package version of `2026.7.1-2:0` sorts under the published `2026.7.1:6` and StartOS would never offer it as an update.
  >
  > So the two version strings deliberately diverge: `OPENCLAW_VERSION` carries the full correction tag, while `startos/versions/current.ts` stays on the base upstream version and takes a downstream bump (`2026.7.1:6` → `2026.7.1:7`). Only a new _base_ version (`2026.8.1`) resets the downstream revision to `:0`.

- **GitHub CLI (`gh`)** — canonical home: [cli/cli](https://github.com/cli/cli).
  ```
  gh release view -R cli/cli --json tagName -q .tagName
  ```
  Strip the leading `v` for the pin. Pin lives in `Dockerfile` as `GH_VERSION`.

## Applying the bump

- **OpenClaw** — edit `Dockerfile` and update the `OPENCLAW_VERSION` ARG default to the npm `latest` value (no `v` prefix), keeping any `-N` correction suffix. Then set `startos/versions/current.ts` per the warning above — base version only, downstream bumped. If the new OpenClaw gates startup on a state migration of its own (`gateway.maintenance_required`, exit 78), run it from `migrations.up`; the packaging guide's versions page says when that earns `current.ts` its own file.
- **GitHub CLI** — edit `Dockerfile` and update the `GH_VERSION` ARG default to the new version (no `v` prefix).

Two more things move with `OPENCLAW_VERSION`:

- **The webchat's gateway client.** `webchat/package.json` pins `@openclaw/gateway-client` and `@openclaw/gateway-protocol` to the exact OpenClaw version. Bump both and refresh the lock file (`cd webchat && npm install --package-lock-only`).
- **State migrations.** Newer OpenClaw releases refuse to open agent databases written by older ones until `openclaw doctor` has migrated them with the gateway stopped (2026.9.4 → 2026.9.8: the gateway starts but logs "agent database uses schema version 19 … run openclaw doctor --fix" and never opens its port). The `state-migrate` oneshot in `startos/main.ts` runs `openclaw doctor --non-interactive` once per OpenClaw version before the gateway starts, so nothing needs doing per bump; but test the upgrade on a state directory written by the previous version (run the old gateway on a copy of a real config, stop it, then run the oneshot's script and the new gateway) and mention the backup in the release notes.
- **The pre-download alert.** `preDownloadAlert` in `startos/manifest/index.ts` asks for a backup before StartOS downloads an update. Set its `when.sourceVersion` to `<` the first package version that bundles the new OpenClaw (e.g. `<2026.10.1:0`), so everyone updating from an older OpenClaw sees it and nobody else does.

## Email: gog (`GOG_VERSION`) and the mail service

- **gog** ([openclaw/gogcli](https://github.com/openclaw/gogcli), formerly steipete/gogcli), for Configure Email → Google account: a static binary pinned in `Dockerfile` by version **and** a sha256 per architecture. Assets `gogcli_<ver>_linux_amd64.tar.gz` / `_arm64.tar.gz`; take the pins from the release's `checksums.txt`. After a bump, check that `gog auth credentials -`, `gog auth tokens import -` (stdin) and `gog auth list --json` / `--check --json` still behave as `startos/email.ts` and `health.py` expect, and dry-run the commands in `skills/google/SKILL.md` (`gog --dry-run --no-input …`).
- **The mail service** (`mail/`) uses only the Python standard library of the image's `python3` (Debian's 3.11), plus pypdfium2 from `/opt/python-libs` for PDF text. It formats every IMAP command itself (`Mailbox._cmd`), because imaplib's own quoting changed between Python releases. When the image's Python changes, run it against a test IMAP server (Dovecot with a self-signed CA works): list, search (also non-ASCII), read of an HTML message with hidden text, attachment_text of a PDF, move/archive, draft, a wrong password (exactly one failed login, then state `refused`). For sending, add an SMTP test server (aiosmtpd with implicit TLS and AUTH PLAIN works; return `AuthResult(success=False, handled=False)` for a refusal) and check: a send to the automatic list arrives with no `X-OpenClaw-Draft` and no `Bcc` header but every Bcc recipient in the envelope, and the draft leaves Drafts; Never Send To refuses (also in Bcc); a forward and an attachment are queued; approve/reject via `mailctl.py`; a draft deleted before approval is cancelled; a draft appended from outside (no marker or a forged one) is refused. `email.utils.getaddresses` became strict in later Pythons (an empty string spoils the whole list), so empty header values are skipped before parsing.
- **When OpenClaw is bumped**, re-check what the email isolation relies on (`startos/mailService.ts`): `agents.entries.<id>.tools.allow/deny` with MCP globs (`mail__*`), per-agent `tools.codeMode`, `mcp.servers.<name>` with `transport: "streamable-http"`, that `sessions_spawn` still passes the spawner's denied tools to the child (the reason the main agent uses `sessions_send`), and that `sessions_send` still runs the target under its own tool policy. Then run `python3 /opt/skills/health/health.py` (Mail Service line) and ask the main agent to summarise the inbox.

OpenClaw ships its own `himalaya` and `gog` skills; `main.ts` keeps them disabled (`skills.entries`).

## "On this server" services (`startos/localServices.ts`)

Each row (package id, MultiHost id, internal port, health check id, first
0.4 version) is copied from that service's own `-startos` repo
(`startos/utils.ts`, `interfaces.ts`, `main.ts`, `versions/`). Re-check the
rows when a service's package changes its host id or port: a wrong row shows
as "not installed" while the service is running. To add a service: a row
there, a `localService(...)` in `dependencies.ts`, and `placedService(...)`
for its form section.

Gitea has one more tie to its package: `startos/gitea.ts` reads the
addresses Gitea publishes from its interface id `http` (gitea-startos
`startos/utils.ts`, `httpInterfaceId`) to map them onto the bridge for git.
Re-check that id along with the row.

## File models and the SDK (start-sdk 3)

Every file-model shape is built with `z.looseObject` at every level. Since start-sdk 3, a `z.object` shape deletes every key it does not declare on the next `merge()`/`write()`, and `openclaw.json` is co-owned with OpenClaw, which writes far more than the package models. Never add a `z.object` (or `z\n  .object`) to `startos/fileModels/`. `npm run check` runs the same gate as the build: TypeScript, the SDK's lint and the SDK's Prettier config (`npm run format` writes).

After editing, confirm with `grep -rn '<OLD_VERSION>' --include='*.ts' --include=Dockerfile` that no stale references remain, then update `releaseNotes` in `startos/versions/current.ts` per the package's versioning conventions.

## The Node base image

`Dockerfile` pins Node to an exact release (`FROM node:26.12.1-bookworm-slim`), not `node:26-bookworm-slim`. With the floating tag, the Node in a release was whatever Docker Hub served on build day, and nobody could tell from the repository whether a release had a given security fix (2026.10.1:6 turned out to carry 26.12.0, one release short of the October 2026 security fixes). The gateway, the webchat and every skill written in JavaScript run on this one Node.

Bump it when Node publishes a security release for the line in use (https://nodejs.org/en/blog/vulnerability), and with each OpenClaw bump (check `engines.node` as above). The tag must exist on Docker Hub before the build, or the build fails at `FROM`. To see which Node a built package carries without installing it:

```
LC_ALL=C grep -a -o -m1 -E 'NODE_VERSION=[0-9.]+' openclaw-extrabutter_x86_64.s9pk
```

On a running server: `node --version` inside the container.

## The baked `start-cli` (`START_CLI_VERSION`)

Separate from OpenClaw and `gh`, the `Dockerfile` downloads a `start-cli` binary for the **Login to StartOS** action, pinned by `START_CLI_VERSION` in `startos/utils.ts` and passed through the manifest's `buildArgs`. It tracks the `start-cli` release line in the [`Start9Labs/start-technologies`](https://github.com/Start9Labs/start-technologies) monorepo — not OpenClaw, and not StartOS itself. It moves on its own schedule, so check it whenever you touch this file.

> [!WARNING]
> **Do not use a bare `gh release view` on that repo.** The monorepo publishes releases for several products under per-product tag prefixes (`start-cli/`, `start-sdk/`, `start-wrt/`, …), so "Latest" may refer to a different product.

Find the latest `start-cli` tag specifically:

```bash
gh release list -R Start9Labs/start-technologies -L 60 --json tagName \
  -q '[.[] | select(.tagName | startswith("start-cli/"))][0].tagName'
```

Set `START_CLI_VERSION` to the version without the `start-cli/v` prefix. The `Dockerfile` builds the product-scoped tag back as `start-cli%2Fv${START_CLI_VERSION}` — the `%2F` is load-bearing, since the tag contains a slash.

The release must publish both Linux architectures this package builds. Verify before pinning:

```bash
gh release view "start-cli/v<version>" -R Start9Labs/start-technologies \
  --json assets -q '.assets[].name' \
  | grep -E '^start-cli_(x86_64|aarch64)-linux$'
```

Finally, check whether the new CLI needs a newer StartOS than the package itself does — **the two floors are independent.** `start-cli` 1.1.0 replaced cookie auth with per-device signing keys, so its `auth login` only works against a StartOS that speaks signature auth, which first shipped in `start-os/v0.4.0`. The package's own floor is the manifest `osVersion`, which start-sdk 2.0 sets to `0.4.0-beta.10` — a version that was never released, since the beta line ends at `beta.9`. So every host that can install this package already clears the CLI's floor, but that is a coincidence of the two numbers, not a rule. Re-derive it on the next CLI bump rather than assuming the SDK's floor covers it.

2.2.0 (from 1.1.0) was checked by capturing the requests both versions send for every command the package runs (`auth login`, `auth session list`, `server metrics`, `package list`, `notification list`): identical RPC methods, parameters and `x-start-auth-sig` header, same `~/.startos/config.yaml` and `id.key.pem`. So 2.2.0 works wherever 1.1.0 did. Its breaking changes (`server experimental governor` → `server governor`, one-argument `server set-hostname`, `setup execute` without `--name`, stable disk paths for `setup install-os`) only touch commands the package doesn't run; `skills/start-cli/SKILL.md` documents the 2.2.0 forms. Repeat that capture on the next bump.

## Running the OpenClaw CLI from actions

Actions that run `openclaw` (or `skills/agents/agents.py`, which calls it) go through `inOpenclawContainer()` in `startos/gatewayContainer.ts`, never a bare `SubContainer.withTemp`. OpenClaw checks whether the gateway that owns its state is alive by PID, and a temporary subcontainer has its own PID namespace. With 2026.9.9, a command that writes state from there while the gateway runs took the gateway for dead and removed its lock files in `/data/.openclaw/tmp/openclaw-<uid>/`; the gateway then refused every state write until restarted. 2026.10.1 records the gateway's PID namespace and refuses such a command instead (`GatewayLockNamespaceError`, shown only with `OPENCLAW_DEBUG=1`; otherwise just "The CLI command failed."). The same commands in the gateway's own subcontainer are fine. When the service is stopped, `inOpenclawContainer()` falls back to a temporary subcontainer; a clean stop removes the lock files, and on 2026.10.1 even a crashed gateway's locks did not block it. Re-test on every OpenClaw bump: from the UI, add and then remove an agent, and check that `ls /data/.openclaw/tmp/openclaw-1000` still lists `gateway.state.lock`; then stop the service and run Configure Agents once.

## The SimpleX plugin across OpenClaw bumps

OpenClaw can drop plugin SDK subpaths between releases (2026.10.1 removed `plugin-sdk/infra-runtime`). A plugin that imports a removed one makes `openclaw doctor` exit 1 ("finished with plugin load errors") and every CLI command that loads plugins fail, `agents add` and `config patch` included; the gateway itself still starts. On each bump, check that every `openclaw/plugin-sdk/*` import in the plugin version you pin is in the new OpenClaw's `package.json` `exports`. The `state-migrate` oneshot upgrades an installed plugin older than `MIN_PLUGIN_VERSION` before running doctor, and `requestSimplexPluginUpgrade` raises the Configure SimpleX task if that did not happen.
