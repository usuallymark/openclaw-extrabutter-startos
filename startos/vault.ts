import { rm, writeFile } from 'fs/promises'
import { sdk } from './sdk'
import {
  VAULT_CREDENTIALS_SUBPATH,
  VAULT_ROOT_SUBPATH,
  ensurePackageDir,
} from './vaultService'

// Since 2026.10.1:27 the vault (rbw, its keys and the master password)
// belongs to the vault service (vaultService.ts, vault/). The gateway's
// processes keep these XDG folders for other tools; rbw's own files there
// are removed by the vault service's launcher.
export const RBW_DIR = '/data/.openclaw/rbw'
export const RBW_ENV = {
  XDG_CONFIG_HOME: `${RBW_DIR}/config`,
  XDG_CACHE_HOME: `${RBW_DIR}/cache`,
  XDG_RUNTIME_DIR: `${RBW_DIR}/runtime`,
  HOME: '/data',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
}

// The master password, as seen from the package runtime: in the vault
// service's folder (root's; the launcher hands the file to openclaw-vault).
export const credentialsVolumePath = sdk.volumes.main.subpath(
  VAULT_CREDENTIALS_SUBPATH,
)
// Where it was until :26 (the launcher moves it on the first start).
export const oldCredentialsVolumePath = sdk.volumes.main.subpath(
  '.openclaw/rbw/.credentials',
)

/**
 * Write the Vaultwarden master password byte-exact for the vault service.
 * Only a trailing line ending (from a paste) is stripped — nothing else.
 */
export async function writeMasterPassword(password: string) {
  const exact = password.replace(/\r?\n$/, '')
  await ensurePackageDir(VAULT_ROOT_SUBPATH, 0o711)
  await rm(credentialsVolumePath, { force: true })
  await writeFile(credentialsVolumePath, exact, { mode: 0o600 })
  // An older copy must not be moved over the new one at the next start.
  await rm(oldCredentialsVolumePath, { force: true }).catch(() => {})
}

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
