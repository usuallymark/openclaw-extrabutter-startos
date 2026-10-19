---
name: gitea
description: "Use this skill for git repositories on the user's own Gitea server: creating a repository, adding it as a remote, committing and pushing, listing repositories. Triggers: anything that should be under version control without going to GitHub or another public site (the workspace, scripts, projects), or the user mentions Gitea or a repository."
---

# Gitea — Your Own Git Repositories

Gitea is the user's private git server. Use it for anything that should be
versioned but stay off public sites. Don't push to GitHub or any other host
unless the user asks for that host by name.

## git signs in by itself

The package sets git up (in `/etc/gitconfig`, rewritten at every start):

- Pushes and pulls to Gitea sign in with the access token from Configure
  External Services, fetched at that moment. **Never put a token or password
  in a remote URL, `~/.git-credentials`, a script or a file**, and don't
  write your own credential helper: it is all handled.
- **Gitea remotes are written `gitea:OWNER/REPO.git`** (what `gitea.py`
  prints). `gitea:` is a placeholder git maps to Gitea's current address at
  every start, so these remotes never go stale. Clone the same way:
  `git clone gitea:OWNER/REPO.git`. Never write a remote with the internal
  `10.0.3.1:…` address, even where Gitea's API shows it: it changes when
  Gitea is reinstalled. Links for the user (`web:`) use a published
  address they can open.
- If `GITEA_URL` is unset, Gitea is not configured: tell the user to enable
  it in Configure External Services.

## Helper

```bash
G="python3 /opt/skills/gitea/gitea.py"
$G whoami                      # the Gitea account you push as
$G repos                       # repositories you can use, with their remote URLs
$G create NAME --description "What it is"   # private; --public / --org ORG if asked
$G remote OWNER/REPO           # the remote URL to use for an existing repository
$G identity                    # commit as the Gitea account, if no name/email is set
$G check                       # set-up report (token, sign-in, repositories found)
```

Exit status: `0` OK, `1` Gitea refused or failed (message says why), `2`
not configured or bad arguments.

## New repository, start to first push

```bash
G="python3 /opt/skills/gitea/gitea.py"
$G create nas-scripts --description "Scripts for the NAS"   # prints "remote: <URL>"
cd /data/nas-scripts            # an existing folder, or mkdir it
git init -b main
$G identity                     # once; a no-op when a name/email is already set
git add -A && git commit -m "Initial commit"
git remote add origin <URL printed by create>
git push -u origin main
```

- Repositories are **private** unless the user asks for public.
- Before the first commit, check what is about to be added (`git status`)
  and add a `.gitignore` for secrets, `.env` files, caches, virtualenvs,
  `node_modules` and large data. Never commit credentials.
- For a folder that already has a remote, keep it; `$G check` shows where
  each repository's remote points.

## Rules

- Deleting a repository, force-pushing (`--force`), rewriting published
  history, or making a private repository public: ask the user first, every
  time. Do them in Gitea's web page, not with the API.
- Don't change git's sign-in settings (`credential.*`, `url.*.insteadOf`)
  or `/etc/gitconfig`.
- Commit messages: one short line saying what changed and why; a body for
  anything not obvious.

## If it fails

- `Authentication failed` / HTTP 401: the token is wrong or was deleted.
  Ask the user to create a new one (below) and update it in Vaultwarden
  (item `gitea`, field `api_key`) or Configure External Services.
- HTTP 403 mentioning a scope: the token lacks a permission. It needs
  "repository: Read and Write" and "user: Read and Write" (Gitea →
  Settings → Applications → Generate New Token).
- `unreachable`: run `python3 /opt/skills/health/health.py`; the Gitea line
  shows whether the server answers and whether the token works.
- `$G check` reports a token stored in a remote URL or
  `~/.git-credentials`, or a remote written with the internal address: tell
  the user. `$G check --fix` removes tokens from Gitea remote URLs (git
  signs in without them) and changes internal-address remotes to `gitea:`;
  run it only with the user's OK.
- `ssh: Could not resolve hostname gitea`: a `gitea:` remote while Gitea is
  not enabled in Configure External Services (the placeholder is only
  mapped while it is).
