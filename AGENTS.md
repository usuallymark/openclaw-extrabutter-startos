# AGENTS.md

This is a StartOS service-package repository — it builds a `.s9pk` for StartOS.

Develop it inside a StartOS packaging workspace created by `start-cli s9pk init-workspace`,
which provides the packaging guide and agent context one level up. If you're reading this in a
bare clone with no workspace, the full guide is at <https://docs.start9.com/packaging>.

**Start every task at the recipe index** — `../start-technologies/projects/start-sdk/docs/src/recipes.md`
(or <https://docs.start9.com/packaging/recipes.html>). It maps an intent ("prompt the user to create
admin credentials", "expose a web UI") to the constructs, the reference pages, and a named production
package to copy. Find the recipe before you read this package's neighbours: a package you reach by
grepping may be non-conformant, and the recipe outranks it.

Freshly scaffolded? Work the
[New Package Checklist](../start-technologies/projects/start-sdk/docs/src/new-package-checklist.md)
(or <https://docs.start9.com/packaging/new-package-checklist.html>) from top to bottom. It is a
guide page, not a file in this repo — read it, don't copy it in.

Keep `README.md` (technical reference for an AI support or administering agent; how things work now, no release history) and
`instructions.md` (end-user docs) in sync with your changes. What changed in a release goes in its release notes (`startos/versions/`) and, for the record, `docs/HISTORY.md`.

**Bugs and feature requests are GitHub issues on this repo** — file them as you find them.
Don't record work in the repo instead: no `TODO.md`, no `NOTES.md`, no `PLAN.md`. What you
verified, tried, and decided belongs in the commit message and the PR body.

## This repo

- **`openclaw.json` is co-owned with the application.** OpenClaw rewrites it at runtime — `/model` in chat changes `agents.defaults.model`. That is why `dependencies.ts` reads the model with `.const()` instead of trusting the action to be the only writer; keep any state derived from that file reactive.
- **`auth-profiles.json` is the package's, under `.startos/` — never move it into `.openclaw/agents/<id>/agent/`.** OpenClaw treats a file of that name there as a retired credential source: doctor archives it, and the gateway refuses an agent whose SQLite store is empty while it exists.
- **Browser device pairing cannot be disabled** — `dangerouslyDisableDeviceAuth` and `allowInsecureAuth` are retired upstream and doctor strips them. `approve-devices` is how a browser gets past "Approve this browser"; don't reintroduce the flags.
- **`gateway.trustedProxies` is written from the bridge address in `main.ts` every start.** StartOS's proxy connects from it, and OpenClaw answers unattributed forwarded headers with `403 proxy_attribution_required` — the whole UI. Keep it derived, not hard-coded.
- **The health check resolves the service's own bridge address via `sdk.host.getOwn`.** The retired `<pkg>.startos` DNS name no longer resolves between containers; same for reaching sibling services (`simplex.ts`, local backends).
- **`/data` is `root:node` 1775, and the package never writes through a link in the gateway user's folders** (since 2026.10.1:26). The gateway user (and an agent with a shell) owned `/data` and could swap the services' root-owned folders, and could point a package-written file at them with a symlink. Keep the sticky `/data` in `CHOWN_SCRIPT`; wrap a new file model under `.openclaw/` or `.startos/` in `linkSafe` and call `clearLinks` before any other write there (`noLinks.ts`); a root step that touches a folder the gateway user owns works by descriptor (`launcher.py` `walk`/`own_dir`).
- **The vault is the vault service's, and agents never run rbw** (since 2026.10.1:27). rbw, its files and the master password belong to `openclaw-vault` (`vault/`, `startos/vaultService.ts`); everything else asks it over `/data/.openclaw-vault/run/vault.sock`, and it decides by the caller's uid (root: anything; node: items no service owns). A new isolated service that needs a vault item claims it in `writeVaultFiles` (owners.json) and fetches it as root from its launcher (`agentsvc/launcher.py` `vault_field`). Never pass a caller's item text to rbw (it also matches ids and URLs): resolve it in the broker and fetch by id. Settings the vault (or a root step) trusts live in root-only folders (`.openclaw-package/`, `.openclaw-vault/`), never in the gateway user's.
- **`login-to-os` grants root-equivalent server control**, which is why no task ever asks for it: signed out is the safe state, the Server Access line shows the state, and the action sits under Maintenance. Never raise a task for it or run it at install.
- **`--allow-unconfigured` keeps the gateway starting before a provider exists**, so the UI can show what is missing. Don't remove it to "fail fast".
- **`configureSynapse.ts` is commented out of `actions/index.ts`** — it is unfinished, not shipped. Don't document it or re-enable it without testing.
