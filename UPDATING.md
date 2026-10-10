# Updating the upstream version

OpenClaw is installed into the image at build time by the official `openclaw.bot` installer, with the version pinned by the `OPENCLAW_VERSION` build ARG in `Dockerfile`. There is no `dockerTag` in the manifest. The image also bundles the GitHub CLI (`gh`, pinned by `GH_VERSION`) into the in-container workspace, where the OpenClaw agent relies on it.

**Treat `gh` as part of the OpenClaw update, not a separate pin.** Whenever you update OpenClaw, check `gh` in the same pass and bump it too if a newer stable release exists. The two ARGs move together.

## Determining the upstream version

- **OpenClaw** — canonical home: [openclaw/openclaw](https://github.com/openclaw/openclaw) (the `upstreamRepo`). Ask npm, not GitHub: the installer resolves the version through npm, and upstream maintains several release lines at once (`extended-stable` on the older series, `beta` on the next one), so the newest GitHub tag by date is routinely _not_ the one to pin.

  ```
  curl -s https://registry.npmjs.org/openclaw | jq -r '."dist-tags".latest'
  ```

  Pin that value verbatim in `Dockerfile` as `OPENCLAW_VERSION`. Never pin a `beta`/`alpha` dist-tag.

  Two more pins move with it. Upstream drops Node lines between releases, so check the floor against the base image (`FROM node:<major>-bookworm-slim` in `Dockerfile`):

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

## File models and the SDK (start-sdk 3)

Every file-model shape is built with `z.looseObject` at every level. Since start-sdk 3, a `z.object` shape deletes every key it does not declare on the next `merge()`/`write()`, and `openclaw.json` is co-owned with OpenClaw, which writes far more than the package models. Never add a `z.object` (or `z\n  .object`) to `startos/fileModels/`. `npm run check` runs the same gate as the build: TypeScript, the SDK's lint and the SDK's Prettier config (`npm run format` writes).

After editing, confirm with `grep -rn '<OLD_VERSION>' --include='*.ts' --include=Dockerfile` that no stale references remain, then update `releaseNotes` in `startos/versions/current.ts` per the package's versioning conventions.

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
