import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { sdk } from './sdk'
import { EmailSettings } from './fileModels/emailSettings.json'
import { usesMailService } from './email'
import { CALENDAR_VAULT } from './calendarService'
import { EXT_SETTINGS_SUBPATH } from './fileModels/externalServices.json'

// The vault service (since 2026.10.1:27; vault/ in this repo,
// /opt/openclaw-vault in the image). rbw, its unlocked keys and the
// Vaultwarden master password belong to the user openclaw-vault; every
// agent asks the service, which gives them any item no service owns. The
// items a service owns (this file's owners.json) go only to that service:
// the email password to the mail service, the Calendar sign-in and the
// calendar links' addresses to the calendar service. Until :26 the gateway
// user ran rbw itself, so any agent with a shell could read them all and
// step around those services' rules and approvals.
//
// The Vaultwarden address and sign-in email are the package's too
// (settings.json here, root only): an agent that could change them could
// have the master password's sign-in sent to a server of its own. That is
// also why Configure External Services' file moved out of the gateway
// user's folder (PACKAGE_ROOT, below).

export const VAULT_ROOT_SUBPATH = '.openclaw-vault'
export const VAULT_CREDENTIALS_SUBPATH = `${VAULT_ROOT_SUBPATH}/credentials`

// The package's own settings that no agent may change (since :27).
export const PACKAGE_ROOT_SUBPATH = '.openclaw-package'
export { EXT_SETTINGS_SUBPATH }
const OLD_EXT_SETTINGS_SUBPATH = '.openclaw/external-services.json'

const vol = (p: string) => sdk.volumes.main.subpath(p)
const me = () => (typeof process.getuid === 'function' ? process.getuid() : 0)

/**
 * Make subpath (directly in /data) a real directory of the package's, with
 * this mode. /data lets the gateway user create entries (it is sticky, so
 * it cannot rename or remove the package's), so it could have made one of
 * these names first, as a link or a folder of its own: anything that is not
 * the package's own directory is removed and made again.
 */
export async function ensurePackageDir(subpath: string, mode: number) {
  const p = vol(subpath)
  const st = await lstat(p).catch(() => null)
  if (st && (!st.isDirectory() || st.isSymbolicLink() || st.uid !== me())) {
    console.warn(
      `/data/${subpath} was not the package's own folder (made by another user); replacing it.`,
    )
    await rm(p, { recursive: true, force: true })
  }
  await mkdir(p, { recursive: true, mode })
  await chmod(p, mode)
}

/** The uid that owns the vault folder (the package's own), for the launcher. */
export async function vaultRootOwner(): Promise<number | null> {
  return (await lstat(vol(VAULT_ROOT_SUBPATH)).catch(() => null))?.uid ?? null
}

/**
 * Init: the package's settings folder, and Configure External Services'
 * file moved into it from the gateway user's folder (where it was until
 * :26, and where an agent could edit it). Runs before anything reads it.
 */
export const initPackageSettings = sdk.setupOnInit(async () => {
  await ensurePackageDir(PACKAGE_ROOT_SUBPATH, 0o700)
  await ensurePackageDir(VAULT_ROOT_SUBPATH, 0o711)
  const now = await lstat(vol(EXT_SETTINGS_SUBPATH)).catch(() => null)
  const old = await lstat(vol(OLD_EXT_SETTINGS_SUBPATH)).catch(() => null)
  if (!now && old?.isFile()) {
    // Read without trusting it more than before: it is the same file the
    // package used until now.
    const text = await readFile(vol(OLD_EXT_SETTINGS_SUBPATH), 'utf8')
    JSON.parse(text)
    await writeFile(vol(EXT_SETTINGS_SUBPATH), text, { mode: 0o600 })
    console.info(
      "Configure External Services' settings moved to the package's own folder.",
    )
  }
  if (old) {
    await rm(vol(OLD_EXT_SETTINGS_SUBPATH), { force: true })
  }
  await chmod(vol(EXT_SETTINGS_SUBPATH), 0o600).catch(() => {})
})

/**
 * At every start: the Vaultwarden settings the vault service uses
 * (settings.json) and which items belong to which service (owners.json).
 * An item belongs to a service while that service is on.
 */
export async function writeVaultFiles(
  vw: { enabled?: boolean; url?: string; email?: string } | undefined,
  available: boolean,
  mailSettings: EmailSettings | null | undefined,
  calSettings: any,
  calOn: boolean,
) {
  await ensurePackageDir(VAULT_ROOT_SUBPATH, 0o711)
  const settings = {
    enabled: !!vw?.enabled && available,
    url: String(vw?.url ?? '').replace(/\/+$/, ''),
    email: String(vw?.email ?? '').trim(),
  }
  await rm(vol(`${VAULT_ROOT_SUBPATH}/settings.json`), { force: true })
  await writeFile(
    vol(`${VAULT_ROOT_SUBPATH}/settings.json`),
    JSON.stringify(settings) + '\n',
    { mode: 0o600 },
  )

  const items: Record<string, string> = {}
  if (usesMailService(mailSettings?.account as any)) items['email'] = 'mail'
  if (calOn) {
    items[CALENDAR_VAULT.item] = 'calendar'
    for (const l of calSettings?.links ?? []) {
      const item = String(l?.item ?? '').trim()
      if (l?.source === 'from-vaultwarden' && item)
        items[item.toLowerCase()] = 'calendar'
    }
  }
  await rm(vol(`${VAULT_ROOT_SUBPATH}/owners.json`), { force: true })
  await writeFile(
    vol(`${VAULT_ROOT_SUBPATH}/owners.json`),
    JSON.stringify({ items }, null, 2) + '\n',
    { mode: 0o644 },
  )
  await chmod(vol(`${VAULT_ROOT_SUBPATH}/owners.json`), 0o644)
  return Object.keys(items)
}
