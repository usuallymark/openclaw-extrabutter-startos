import { T } from '@start9labs/start-sdk'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sdk } from './sdk'
import { inOpenclawContainer } from './gatewayContainer'

// Email, configured under Configure External Services → Email.
//
// - "gmail" and "imap" use himalaya (IMAP/SMTP). Its config is written by
//   main at every start from external-services.json; the password is never in
//   it: himalaya runs `getcred EMAIL_PASS`, which reads a manual value from
//   the environment or fetches Vaultwarden item "email", field "password".
// - "google" uses gog with an OAuth sign-in made on another computer
//   (OAuth client JSON + exported token). Either kept in Vaultwarden (item
//   "google", fields client_json and token_json; fetched and loaded into
//   gog at every start by the google-sign-in oneshot) or pasted once in the
//   form. gog keeps its copy in an encrypted file keyring under GOG_HOME;
//   the keyring password is generated once, stored in /data/.startos, and
//   reaches gog only through the environment. The Vaultwarden pointers are
//   NOT in the gateway environment, so the agent cannot fetch the token.

export type EmailConfig = {
  mode?: 'disabled' | 'gmail' | 'imap' | 'google'
  address?: string
  displayName?: string
  username?: string
  imap?: { host?: string; port?: number; security?: 'tls' | 'starttls' }
  smtp?: { host?: string; port?: number; security?: 'tls' | 'starttls' }
  password?: { source?: 'from-vaultwarden' | 'manual'; value?: string }
  signIn?: { source?: 'from-vaultwarden' | 'manual'; value?: string }
}

// Vaultwarden item and fields for the Google sign-in ("Fetch from Vaultwarden").
export const GOOGLE_VAULT = {
  item: 'google',
  clientField: 'client_json',
  tokenField: 'token_json',
}

export const googleFromVault = (email: EmailConfig | undefined) =>
  email?.mode === 'google' &&
  !!email.address &&
  (email.signIn?.source ?? 'from-vaultwarden') === 'from-vaultwarden'

/**
 * google-sign-in oneshot: fetch the client and token from Vaultwarden with
 * getcred and load them into gog. Never fatal; the Google health check
 * reports a missing or refused sign-in. Secrets go through pipes only.
 */
export const GOOGLE_SIGN_IN_SCRIPT = `
set -u
ok=1
if c=$(getcred GOOGLE_CLIENT); then
  printf '%s' "$c" | gog auth credentials - >/dev/null 2>/tmp/gog-err || { echo "google-sign-in: storing the OAuth client failed: $(head -n1 /tmp/gog-err)"; ok=0; }
else ok=0; fi
if t=$(getcred GOOGLE_TOKEN); then
  printf '%s' "$t" | gog auth tokens import - >/dev/null 2>/tmp/gog-err || { echo "google-sign-in: importing the sign-in token failed: $(head -n1 /tmp/gog-err)"; ok=0; }
else ok=0; fi
rm -f /tmp/gog-err
unset c t
[ "$ok" = 1 ] && echo "google-sign-in: loaded the Google sign-in from Vaultwarden" || echo "google-sign-in: the Google sign-in was not loaded from Vaultwarden (see above); the Google account health check will say what is missing"
exit 0
`

export function googleSignInEnv(address: string) {
  return {
    GOOGLE_CLIENT_FROM_VAULT: `${GOOGLE_VAULT.item}:${GOOGLE_VAULT.clientField}`,
    GOOGLE_TOKEN_FROM_VAULT: `${GOOGLE_VAULT.item}:${GOOGLE_VAULT.tokenField}`,
    GOG_ACCOUNT: address,
  }
}

export const HIMALAYA_CONFIG = '/data/.openclaw/himalaya/config.toml'
const himalayaConfigPath = sdk.volumes.main.subpath(
  '.openclaw/himalaya/config.toml',
)

export const GOG_HOME = '/data/.openclaw/gog'
const gogKeyringPasswordPath = sdk.volumes.main.subpath(
  '.startos/gog-keyring-password',
)

// Vaultwarden entry and field for the email password ("Fetch from Vaultwarden").
export const EMAIL_VAULT_POINTER = 'email:password'

export const GMAIL_SERVERS = {
  imap: { host: 'imap.gmail.com', port: 993, security: 'tls' as const },
  smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' as const },
}

/** IMAP/SMTP servers in effect for a himalaya mode, or null. */
export function mailServers(email: EmailConfig | undefined) {
  if (email?.mode === 'gmail') return GMAIL_SERVERS
  if (email?.mode === 'imap' && email.imap?.host && email.smtp?.host) {
    return {
      imap: {
        host: email.imap.host,
        port: email.imap.port ?? 993,
        security: email.imap.security ?? 'tls',
      },
      smtp: {
        host: email.smtp.host,
        port: email.smtp.port ?? 587,
        security: email.smtp.security ?? 'starttls',
      },
    }
  }
  return null
}

// TOML basic strings share JSON's escapes (\" \\ \n \uXXXX), so JSON.stringify
// yields a valid TOML string for any input.
const tomlString = (s: string) => JSON.stringify(s)

function serverEntries(
  proto: 'imap' | 'smtp',
  server: { host: string; port: number; security: 'tls' | 'starttls' },
): string[] {
  // A bare `host:port` means implicit TLS (imaps/smtps); `imap://` and
  // `smtp://` are cleartext upgraded with STARTTLS.
  if (server.security === 'tls') {
    return [`${proto}.server = ${tomlString(`${server.host}:${server.port}`)}`]
  }
  return [
    `${proto}.server = ${tomlString(`${proto}://${server.host}:${server.port}`)}`,
    `${proto}.starttls = true`,
  ]
}

/** himalaya 2.x config for the gmail/imap modes, or null for other modes. */
export function renderHimalayaConfig(
  email: EmailConfig | undefined,
): string | null {
  const servers = mailServers(email)
  if (!servers || !email?.address) return null
  const login = email.username?.trim() || email.address
  const lines = [
    '# Written by OpenClaw Extra Butter at every start from',
    '# Configure External Services → Email. Edits here are overwritten.',
    '[accounts.default]',
    'default = true',
    `email = ${tomlString(email.address)}`,
  ]
  if (email.displayName?.trim()) {
    lines.push(`display-name = ${tomlString(email.displayName.trim())}`)
  }
  for (const proto of ['imap', 'smtp'] as const) {
    lines.push(
      ...serverEntries(proto, servers[proto]),
      `${proto}.sasl.plain.username = ${tomlString(login)}`,
      `${proto}.sasl.plain.password.command = "getcred EMAIL_PASS"`,
    )
  }
  if (email.mode === 'gmail') {
    // Gmail files sent mail itself; these give the roles IMAP does not report.
    lines.push(
      'mailbox.alias.sent = "[Gmail]/Sent Mail"',
      'mailbox.alias.drafts = "[Gmail]/Drafts"',
      'mailbox.alias.trash = "[Gmail]/Trash"',
      'mailbox.alias.junk = "[Gmail]/Spam"',
      'mailbox.alias.archive = "[Gmail]/All Mail"',
    )
  }
  return lines.join('\n') + '\n'
}

/** Write (or remove) himalaya's config. Called by main at every start. */
export async function writeHimalayaConfig(email: EmailConfig | undefined) {
  const toml = renderHimalayaConfig(email)
  await mkdir(dirname(himalayaConfigPath), { recursive: true })
  await writeFile(
    himalayaConfigPath,
    toml ?? '# Email (IMAP) is not enabled.\n',
    {
      mode: 0o600,
    },
  )
}

/** gog's keyring password: created once, then reused. */
export async function gogKeyringPassword(): Promise<string> {
  const existing = await readFile(gogKeyringPasswordPath, 'utf8').catch(
    () => '',
  )
  if (existing.trim()) return existing.trim()
  const fresh = randomBytes(32).toString('base64url')
  await mkdir(dirname(gogKeyringPasswordPath), { recursive: true })
  await writeFile(gogKeyringPasswordPath, fresh, { mode: 0o600 })
  return fresh
}

export function gogEnv(address: string | undefined, keyringPassword: string) {
  return {
    GOG_HOME,
    GOG_KEYRING_BACKEND: 'file',
    GOG_KEYRING_PASSWORD: keyringPassword,
    ...(address ? { GOG_ACCOUNT: address } : {}),
  }
}

/**
 * Gateway environment and skill dir for the configured email mode. Secrets
 * are not resolved here, except gog's keyring password (as for provider keys).
 */
export async function emailEnvAndSkill(email: EmailConfig | undefined) {
  const env: Record<string, string> = {}
  let skill: string | null = null
  if (email?.mode === 'gmail' || email?.mode === 'imap') {
    if (!renderHimalayaConfig(email)) return { env, skill }
    env['EMAIL_MODE'] = email.mode
    env['EMAIL_ADDRESS'] = email.address ?? ''
    env['HIMALAYA_CONFIG'] = HIMALAYA_CONFIG
    const p = email.password
    if (p?.source === 'manual' && p.value) env['EMAIL_PASS'] = p.value
    else if (p?.source === 'from-vaultwarden') {
      env['EMAIL_PASS_FROM_VAULT'] = EMAIL_VAULT_POINTER
    }
    skill = '/opt/skills/email'
  } else if (email?.mode === 'google' && email.address) {
    env['EMAIL_MODE'] = 'google'
    env['EMAIL_ADDRESS'] = email.address
    Object.assign(env, gogEnv(email.address, await gogKeyringPassword()))
    skill = '/opt/skills/google'
  }
  return { env, skill }
}

// ── Google sign-in import (Configure External Services, Google account) ────

type GogResult = { exitCode: number | null; stdout: string; stderr: string }

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l) ?? ''

/** Validate a pasted OAuth client JSON (as downloaded from Google Cloud). */
export function parseClientJson(text: string): string {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(
      'Google OAuth client: this is not valid JSON. Paste the whole client_secret_….json file you downloaded from Google Cloud.',
    )
  }
  const c = j?.installed ?? j?.web
  if (!c?.client_id || !c?.client_secret) {
    throw new Error(
      'Google OAuth client: no client_id/client_secret found. Paste the client_secret_….json of a "Desktop app" OAuth client from Google Cloud → APIs & Services → Credentials.',
    )
  }
  return JSON.stringify(j)
}

/** Validate a pasted `gog auth tokens export` file; returns it and its email. */
export function parseTokenJson(text: string): { json: string; email: string } {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(
      'Google sign-in token: this is not valid JSON. Paste the whole file written by `gog auth tokens export`.',
    )
  }
  const email = String(j?.email ?? '').trim()
  if (!email || !String(j?.refresh_token ?? '').trim()) {
    throw new Error(
      'Google sign-in token: the file has no email or refresh_token. Create it with `gog auth tokens export <address> --out token.json` after signing in with `gog auth add`.',
    )
  }
  return { json: JSON.stringify(j), email }
}

/**
 * Store the OAuth client and/or token in gog's keyring. Secrets go in on
 * stdin and never touch the disk unencrypted.
 */
export async function importGoogleSignIn(
  effects: T.Effects,
  address: string,
  clientJson: string | null,
  tokenJson: string | null,
) {
  const env = gogEnv(address, await gogKeyringPassword())
  await mkdir(sdk.volumes.main.subpath('.openclaw/gog'), { recursive: true })
  await inOpenclawContainer(effects, 'google-sign-in', async (subc) => {
    const run = async (args: string[], input: string, what: string) => {
      const r = (await subc.exec(['gog', ...args], {
        user: 'node',
        env: { HOME: '/data', ...env },
        input,
        timeout: 60_000,
      })) as GogResult
      if (r.exitCode !== 0) {
        throw new Error(
          `${what} failed: ${firstLine(String(r.stderr)) || firstLine(String(r.stdout)) || `exit ${r.exitCode}`}`,
        )
      }
    }
    // gog writes as the gateway user; make sure an earlier root-created
    // directory does not block it.
    await subc.exec(['chown', '-R', 'node:node', GOG_HOME], { user: 'root' })
    if (clientJson) {
      await run(
        ['auth', 'credentials', '-'],
        clientJson,
        'Storing the OAuth client',
      )
    }
    if (tokenJson) {
      await run(
        ['auth', 'tokens', 'import', '-'],
        tokenJson,
        'Importing the sign-in token',
      )
    }
  })
}

/** Accounts gog has a sign-in for (local; no network). */
export async function googleSignInStatus(
  sub: { exec: (cmd: string[], opts: any) => Promise<any> },
  address: string,
): Promise<{ ok: boolean; message: string }> {
  const r = await sub.exec(['gog', 'auth', 'list', '--json', '--no-input'], {
    user: 'node',
    env: { HOME: '/data', ...gogEnv(address, await gogKeyringPassword()) },
    timeout: 20_000,
  })
  let accounts: any[] = []
  try {
    accounts = JSON.parse(String(r.stdout)).accounts ?? []
  } catch {
    return {
      ok: false,
      message: `Google sign-in could not be read: ${firstLine(String(r.stderr)) || `exit ${r.exitCode}`}`,
    }
  }
  const a = accounts.find(
    (x) => String(x?.email).toLowerCase() === address.toLowerCase(),
  )
  if (!a) {
    return {
      ok: false,
      message: `Not signed in as ${address}. Add the OAuth client and sign-in token in Configure External Services → Email (pasted, or in Vaultwarden item "${GOOGLE_VAULT.item}", fields ${GOOGLE_VAULT.clientField} and ${GOOGLE_VAULT.tokenField}).`,
    }
  }
  if (a.error) {
    return { ok: false, message: `Google sign-in for ${address}: ${a.error}` }
  }
  const services = Array.isArray(a.services) ? a.services.join(', ') : ''
  return {
    ok: true,
    message: `Signed in as ${address}${services ? ` (${services})` : ''}`,
  }
}
