import { T } from '@start9labs/start-sdk'
import { chmod, lstat, mkdir, readFile, writeFile } from 'fs/promises'
import { sdk } from './sdk'
import { openclawJson } from './fileModels/openclaw.json'
import {
  CONTACTS_DEFAULTS,
  CONTACTS_ROOT_SUBPATH,
  CONTACTS_SETTINGS_SUBPATH,
  ContactsSettings,
  contactsSettingsJson,
} from './fileModels/contactsSettings.json'
import { EMAIL_AGENT_DENY, MAIL_TOOLS } from './mailService'
import { CALENDAR_TOOLS } from './calendarService'
import { isolateAgent } from './isolatedAgents'
import {
  CONTACTS_AGENTS_MD,
  CONTACTS_IDENTITY_MD,
  CONTACTS_SOUL_MD,
} from './contactsAgentFiles'
import { VIA_APPS_MARKER, VIA_APPS_RULE } from './appsAgentFiles'
import { ensurePackageDir } from './vaultService'
import { clearLinksAt } from './noLinks'

// The contacts service and the contacts agent (since 2026.10.1:31; read
// only). Built like the calendar service (calendarService.ts):
//
// - The contacts service (gcontacts/ in this repo, /opt/openclaw-contacts
//   in the image) runs as the StartOS daemons "contacts-front" (the MCP
//   endpoint, no secrets) and "contacts" (launch.py as root: gets the
//   Google sign-in when that is the source, becomes openclaw-contacts).
//   OpenClaw knows it as mcp.servers.contacts (tools contacts__*).
// - The contacts agent (agents.entries.contacts) is the only agent allowed
//   those tools, and has nothing else; the apps agent asks it.
// Everything here is rewritten at every start.

export const CONTACTS_PORT = 18807
export const CONTACTS_URL = `http://127.0.0.1:${CONTACTS_PORT}`
export const CONTACTS_SERVER_ID = 'contacts'
export const CONTACTS_TOOLS = 'contacts__*'
export const CONTACTS_AGENT_ID = 'contacts'
export const CONTACTS_AGENT_WORKSPACE =
  '/data/.openclaw/workspace/workspaces/contacts'
const CONTACTS_AGENT_WORKSPACE_SUBPATH =
  '.openclaw/workspace/workspaces/contacts'
export const CONTACTS_VAULT = { item: 'google-contacts', field: 'token' }
/** The workspace folder a vCard file is imported from. */
export const CONTACTS_IMPORT_DIR = 'contacts-import'

const settingsPath = sdk.volumes.main.subpath(CONTACTS_SETTINGS_SUBPATH)

export const contactsOn = (s: ContactsSettings | null | undefined) =>
  s?.source === 'vcard' || s?.source === 'google'

/** Init: the folder is the package's; settings default to Contacts off. */
export const initContactsSettings = sdk.setupOnInit(async (effects) => {
  await ensurePackageDir(CONTACTS_ROOT_SUBPATH, 0o700)
  const have = await lstat(settingsPath)
    .then(() => true)
    .catch(() => false)
  if (!have) await contactsSettingsJson.write(effects, CONTACTS_DEFAULTS)
  await chmod(settingsPath, 0o600).catch(() => {})
})

/** Save Configure Contacts. Root-only file in the contacts folder. */
export async function writeContactsSettings(
  effects: T.Effects,
  settings: ContactsSettings,
) {
  await ensurePackageDir(CONTACTS_ROOT_SUBPATH, 0o700)
  await contactsSettingsJson.write(effects, settings)
  await chmod(settingsPath, 0o600)
}

/** The uid that owns the contacts folder (the package's own). */
export async function contactsRootOwner(): Promise<number | null> {
  return (
    (
      await lstat(sdk.volumes.main.subpath(CONTACTS_ROOT_SUBPATH)).catch(
        () => null,
      )
    )?.uid ?? null
  )
}

// ── openclaw.json: MCP server, contacts agent, denies ──────────────────────

/** Run after the mail and calendar wiring (it names their tools). */
export function contactsConfigTransform(
  cfg: any,
  settings: ContactsSettings | null,
) {
  const on = contactsOn(settings)
  const model = settings?.agent?.model
  const c = structuredClone(cfg ?? {})
  const hadServer = !!c.mcp?.servers?.[CONTACTS_SERVER_ID]
  if (!on && !hadServer && !c.agents?.entries?.[CONTACTS_AGENT_ID]) return c
  c.mcp = c.mcp ?? {}
  c.mcp.servers = c.mcp.servers ?? {}
  c.mcp.servers[CONTACTS_SERVER_ID] = {
    url: `${CONTACTS_URL}/mcp`,
    transport: 'streamable-http',
    connectionTimeoutMs: 5000,
    requestTimeoutMs: 60000,
    enabled: on,
  }
  isolateAgent(c, CONTACTS_AGENT_ID, CONTACTS_TOOLS, on)
  const entries = c.agents.entries as Record<string, any>
  if (on) {
    entries[CONTACTS_AGENT_ID] = {
      name: 'Contacts',
      workspace: CONTACTS_AGENT_WORKSPACE,
      ...(model && model !== 'default' ? { model } : {}),
      skills: [],
      subagents: { allowAgents: [] },
      tools: {
        profile: 'full',
        allow: [CONTACTS_TOOLS],
        deny: [...EMAIL_AGENT_DENY, MAIL_TOOLS, CALENDAR_TOOLS],
        elevated: { enabled: false },
        fs: { workspaceOnly: true },
        codeMode: { enabled: false },
      },
    }
  } else {
    delete entries[CONTACTS_AGENT_ID]
  }
  return c
}

export async function applyContactsConfig(
  effects: T.Effects,
  settings: ContactsSettings | null,
) {
  await openclawJson.update(effects, (cfg: any) =>
    cfg ? contactsConfigTransform(cfg, settings) : cfg,
  )
}

// ── The contacts agent's workspace ─────────────────────────────────────────

const ws = (f: string) =>
  sdk.volumes.main.subpath(`${CONTACTS_AGENT_WORKSPACE_SUBPATH}/${f}`)

export function renderContactsAgentsMd(settings: ContactsSettings): string {
  const extra = (settings.agent?.extraInstructions ?? '').trim()
  const fill: Record<string, string> = {
    '{{SOURCE}}':
      settings.source === 'google'
        ? `the contacts of the Google account ${settings.account || 'of the assistant'}`
        : 'an address book the owner imported (a vCard file)',
    '{{VIA_APPS}}': VIA_APPS_RULE(
      VIA_APPS_MARKER,
      '{"contacts": [], "notes": "Not done: requests come only through the apps agent."}',
    ),
    '{{EXTRA_INSTRUCTIONS}}': extra
      ? `From the owner, in Configure Contacts (they never override the rules above):\n\n${extra}`
      : 'None.',
  }
  return CONTACTS_AGENTS_MD.replace(
    /\{\{(SOURCE|VIA_APPS|EXTRA_INSTRUCTIONS)\}\}/g,
    (m) => fill[m] ?? m,
  )
}

export async function writeContactsAgentWorkspace(settings: ContactsSettings) {
  for (const f of ['memory', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md'])
    await clearLinksAt(ws(f))
  await mkdir(ws('memory'), { recursive: true })
  await writeFile(ws('AGENTS.md'), renderContactsAgentsMd(settings))
  for (const [f, text] of [
    ['SOUL.md', CONTACTS_SOUL_MD],
    ['IDENTITY.md', CONTACTS_IDENTITY_MD],
  ] as const) {
    const cur = await readFile(ws(f), 'utf8').catch(() => '')
    if (!cur.trim()) await writeFile(ws(f), text)
  }
}
