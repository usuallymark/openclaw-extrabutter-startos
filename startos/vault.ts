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
