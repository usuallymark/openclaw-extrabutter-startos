import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { sdk } from './sdk'

// ── Paths (inside the openclaw subcontainer; /data = main volume) ───────────
export const RBW_DIR = '/data/.openclaw/rbw'
export const RBW_CREDENTIALS = `${RBW_DIR}/.credentials`
export const RBW_PINENTRY = `${RBW_DIR}/pinentry-file.sh`
export const RBW_CONFIG = `${RBW_DIR}/config/rbw/config.json`

// Same file, as seen from the package runtime (actions / setupMain).
export const credentialsVolumePath = sdk.volumes.main.subpath(
  '.openclaw/rbw/.credentials',
)

// rbw XDG environment — every rbw invocation (startup and skills) uses these.
export const RBW_ENV = {
  XDG_CONFIG_HOME: `${RBW_DIR}/config`,
  XDG_CACHE_HOME: `${RBW_DIR}/cache`,
  XDG_RUNTIME_DIR: `${RBW_DIR}/runtime`,
  HOME: '/data',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
}

/**
 * Write the Vaultwarden master password byte-exact for the file pinentry.
 * Only a trailing line ending (from a paste) is stripped — nothing else.
 */
export async function writeMasterPassword(password: string) {
  const exact = password.replace(/\r?\n$/, '')
  await mkdir(dirname(credentialsVolumePath), { recursive: true })
  await writeFile(credentialsVolumePath, exact, { mode: 0o600 })
}

/**
 * Non-interactive pinentry: answers GETPIN with the contents of .credentials.
 * Assuan requires '%' to be escaped; printf avoids dash's echo mangling '\'.
 */
export const PINENTRY_SCRIPT = `#!/bin/sh
CREDS=${RBW_CREDENTIALS}
echo 'OK Pleased to meet you'
while read -r line; do
  case "$line" in
    GETPIN*) printf 'D %s\\n' "$(sed 's/%/%25/g' "$CREDS")"; echo OK ;;
    BYE*) echo OK; exit 0 ;;
    *) echo OK ;;
  esac
done
`

/**
 * setup-vault: sign in, unlock and sync. rbw keeps working from its local
 * copy of the vault when a sync fails, so a refused sign-in went unnoticed
 * (vault edits silently stopped reaching OpenClaw). Here a failed sync is
 * logged, and when Vaultwarden itself is up (GET $VW_URL/alive answers) the
 * stored sign-in is dropped (rbw purge) and made again from the saved master
 * password. If that fails too, the previous local copy is put back, so
 * lookups keep working as before. Output goes to the service log.
 */
export const VAULT_START_SCRIPT = `
set -u
cache="$XDG_CACHE_HOME/rbw"
backup="$XDG_CACHE_HOME/rbw.before-relogin"
rbw stop-agent >/dev/null 2>&1 || true
sleep 1
timeout 90 rbw login || echo "rbw login: exit $?" >&2
timeout 90 rbw unlock || echo "rbw unlock: exit $?" >&2
if err=$(timeout 120 rbw sync 2>&1 >/dev/null); then
  echo "Vault synced"
else
  echo "rbw sync failed: $(printf '%s' "\${err:-timed out}" | head -n 1)" >&2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$VW_URL/alive" 2>/dev/null || true)
  case $code in
    2??)
      echo "Vaultwarden is up but the sync failed: signing in to Vaultwarden again" >&2
      rm -rf "$backup"
      cp -a "$cache" "$backup" 2>/dev/null || true
      rbw purge >/dev/null 2>&1 || true
      if timeout 90 rbw login && timeout 90 rbw unlock && err=$(timeout 120 rbw sync 2>&1 >/dev/null); then
        echo "Signed in to Vaultwarden again; vault synced"
        rm -rf "$backup"
      else
        echo "Signing in again did not help ($(printf '%s' "\${err:-see above}" | head -n 1)); keeping the previous local copy of the vault" >&2
        rbw stop-agent >/dev/null 2>&1 || true
        if [ -d "$backup" ]; then rm -rf "$cache"; mv "$backup" "$cache"; fi
        timeout 90 rbw unlock || true
      fi
      ;;
    *)
      echo "Vaultwarden did not answer at $VW_URL/alive (HTTP \${code:-none}): using the local copy of the vault; vault changes reach OpenClaw once a sync works again" >&2
      ;;
  esac
fi
rbw unlocked
`

/**
 * Dashboard vault check: unlock (a no-op when unlocked), then sync. Exit 10
 * = locked, 20 = unlocked but the sync failed (stderr says why).
 */
export const VAULT_PROBE_SCRIPT = `
if ! uerr=$(timeout 60 rbw unlock 2>&1 >/dev/null) || ! rbw unlocked >/dev/null 2>&1; then
  printf '%s\\n' "\${uerr:-unlock failed or timed out}" | head -n 1 >&2
  exit 10
fi
if ! err=$(timeout 60 rbw sync 2>&1 >/dev/null); then
  printf '%s\\n' "\${err:-sync timed out}" | head -n 1 >&2
  exit 20
fi
`

// ── Custom CA certificates ──────────────────────────────────────────────────
const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

export function splitPemCerts(text: string | null | undefined): string[] {
  return (text ?? '').match(PEM_RE) ?? []
}

export const CUSTOM_CA_DIR = '/usr/local/share/ca-certificates'
export const CUSTOM_CA_PREFIX = 'openclaw-custom-'

// ── /etc/hosts managed block ────────────────────────────────────────────────
const HOSTS_BEGIN = '# BEGIN openclaw custom host mappings'
const HOSTS_END = '# END openclaw custom host mappings'

export function applyHostsBlock(
  existing: string,
  mappings: { hostname: string; ip: string }[],
): string {
  const re = new RegExp(`\\n?${HOSTS_BEGIN}[\\s\\S]*?${HOSTS_END}\\n?`, 'g')
  const base = existing.replace(re, '\n').trimEnd()
  if (!mappings.length) return base + '\n'
  const lines = mappings.map((m) => `${m.ip.trim()}\t${m.hostname.trim()}`)
  return [base, HOSTS_BEGIN, ...lines, HOSTS_END].join('\n') + '\n'
}
