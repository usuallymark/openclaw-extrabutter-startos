import { T } from '@start9labs/start-sdk'
import { chmod, lstat, mkdir, readFile, writeFile } from 'fs/promises'
import { sdk } from './sdk'
import { openclawJson } from './fileModels/openclaw.json'
import {
  CALENDAR_DEFAULTS,
  CAL_ROOT_SUBPATH,
  CAL_SETTINGS_SUBPATH,
  CalendarSettings,
  calendarSettingsJson,
} from './fileModels/calendarSettings.json'
import { EMAIL_AGENT_DENY, MAIL_TOOLS } from './mailService'
import { isolateAgent } from './isolatedAgents'
import {
  CAL_AGENTS_MD,
  CAL_IDENTITY_MD,
  CAL_READ_ONLY_RULES,
  CAL_SOUL_MD,
  CAL_WRITE_RULES,
} from './calendarAgentFiles'
import { VIA_APPS_MARKER, VIA_APPS_RULE } from './appsAgentFiles'

// The calendar service and the calendar agent (since 2026.10.1:15; read
// only). Built like the mail service (mailService.ts):
//
// - The calendar service (gcalendar/ in this repo, /opt/openclaw-calendar
//   in the image) runs as the StartOS daemons "calendar-front" (the MCP
//   endpoint, no secrets) and "calendar" (launch.py as root: gets the
//   Google sign-in, becomes openclaw-calendar). OpenClaw knows it as
//   mcp.servers.calendar (tools calendar__*).
// - The calendar agent (agents.entries.calendar) is the only agent allowed
//   those tools, and has nothing else. Every other agent has calendar__*
//   denied; the main agent asks it with sessions_send.
// Everything here is rewritten at every start.

export const CALENDAR_PORT = 18806
export const CALENDAR_URL = `http://127.0.0.1:${CALENDAR_PORT}`
export const CALENDAR_SERVER_ID = 'calendar'
export const CALENDAR_TOOLS = 'calendar__*'
export const CALENDAR_AGENT_ID = 'calendar'
export const CALENDAR_AGENT_WORKSPACE =
  '/data/.openclaw/workspace/workspaces/calendar'
const CALENDAR_AGENT_WORKSPACE_SUBPATH =
  '.openclaw/workspace/workspaces/calendar'
export const CALENDAR_VAULT = { item: 'google-calendar', field: 'token' }

const calRoot = sdk.volumes.main.subpath(CAL_ROOT_SUBPATH)
const settingsPath = sdk.volumes.main.subpath(CAL_SETTINGS_SUBPATH)

export const calendarOn = (s: CalendarSettings | null | undefined) =>
  s?.mode === 'read' || s?.mode === 'write'

/** Init (install, update, restore): the folder exists and is the
 * package's; settings default to Calendar off. */
export const initCalendarSettings = sdk.setupOnInit(async (effects) => {
  await mkdir(calRoot, { recursive: true, mode: 0o700 })
  await chmod(calRoot, 0o700)
  let have = true
  try {
    await lstat(settingsPath)
  } catch {
    have = false
  }
  if (!have) await calendarSettingsJson.write(effects, CALENDAR_DEFAULTS)
  await chmod(settingsPath, 0o600).catch(() => {})
})

/** Save Configure Calendar. Root-only file in the calendar folder. */
export async function writeCalendarSettings(
  effects: T.Effects,
  settings: CalendarSettings,
) {
  await mkdir(calRoot, { recursive: true, mode: 0o700 })
  await calendarSettingsJson.write(effects, settings)
  await chmod(settingsPath, 0o600)
}

/** The uid that owns the calendar folder (the package's own). */
export async function calendarRootOwner(): Promise<number | null> {
  try {
    return (await lstat(calRoot)).uid
  } catch {
    return null
  }
}

/** Check a pasted sign-in (tools/google-signin.py output). */
export function parseCalendarSignIn(text: string): {
  account: string
  scopes: string[]
} {
  let t: any
  try {
    t = JSON.parse(text)
  } catch {
    throw new Error(
      'The Calendar sign-in is not valid JSON. Paste the whole line printed by google-signin.py.',
    )
  }
  if (!t || typeof t !== 'object' || !t.refresh_token || !t.client_id) {
    throw new Error(
      'The Calendar sign-in has no refresh_token or client_id. Paste the whole line printed by google-signin.py.',
    )
  }
  return {
    account: String(t.account ?? ''),
    scopes: Array.isArray(t.scopes) ? t.scopes.map(String) : [],
  }
}

// ── openclaw.json: MCP server, calendar agent, denies ──────────────────────

export function calendarConfigTransform(
  cfg: any,
  settings: CalendarSettings | null,
) {
  const on = calendarOn(settings)
  const model = settings?.agent?.model
  const c = structuredClone(cfg ?? {})
  const hadServer = !!c.mcp?.servers?.[CALENDAR_SERVER_ID]
  if (!on && !hadServer && !c.agents?.entries?.[CALENDAR_AGENT_ID]) return c
  c.mcp = c.mcp ?? {}
  c.mcp.servers = c.mcp.servers ?? {}
  c.mcp.servers[CALENDAR_SERVER_ID] = {
    url: `${CALENDAR_URL}/mcp`,
    transport: 'streamable-http',
    connectionTimeoutMs: 5000,
    requestTimeoutMs: 120000,
    enabled: on,
  }
  isolateAgent(c, CALENDAR_AGENT_ID, CALENDAR_TOOLS, on)
  const entries = c.agents.entries as Record<string, any>
  if (on) {
    entries[CALENDAR_AGENT_ID] = {
      name: 'Calendar',
      workspace: CALENDAR_AGENT_WORKSPACE,
      ...(model && model !== 'default' ? { model } : {}),
      skills: [],
      subagents: { allowAgents: [] },
      tools: {
        profile: 'full',
        allow: [CALENDAR_TOOLS],
        // Rebuilt after the mail wiring ran, so it names the mail tools
        // itself (the email agent gets calendar__* from isolateAgent).
        deny: [...EMAIL_AGENT_DENY, MAIL_TOOLS],
        elevated: { enabled: false },
        fs: { workspaceOnly: true },
        codeMode: { enabled: false },
      },
    }
  } else {
    delete entries[CALENDAR_AGENT_ID]
  }
  return c
}

export async function applyCalendarConfig(
  effects: T.Effects,
  settings: CalendarSettings | null,
) {
  await openclawJson.update(effects, (cfg: any) =>
    cfg ? calendarConfigTransform(cfg, settings) : cfg,
  )
}

// ── The calendar agent's workspace ─────────────────────────────────────────

const ws = (f: string) =>
  sdk.volumes.main.subpath(`${CALENDAR_AGENT_WORKSPACE_SUBPATH}/${f}`)

/** Trusted Organizers as the launcher computes them: the list, plus
 * Configure Email's Trusted Senders while the switch is on. */
export function trustedOrganizersOf(
  settings: CalendarSettings,
  emailTrusted: string[],
): string[] {
  const all = [
    ...(settings.trustedOrganizers ?? []),
    ...(settings.includeEmailTrusted !== false ? emailTrusted : []),
  ]
  return Array.from(
    new Set(all.map((t) => String(t).trim().toLowerCase()).filter(Boolean)),
  ).sort()
}

export async function writeCalendarAgentWorkspace(
  settings: CalendarSettings,
  emailTrusted: string[] = [],
) {
  await mkdir(ws('memory'), { recursive: true })
  const extra = (settings.agent?.extraInstructions ?? '').trim()
  const trusted = trustedOrganizersOf(settings, emailTrusted)
  const fill: Record<string, string> = {
    '{{EXTRA_INSTRUCTIONS}}': extra
      ? `From the owner, in Configure Calendar (they never override the rules above):\n\n${extra}`
      : 'None.',
    '{{TRUSTED_ORGANIZERS}}': trusted.length
      ? trusted.map((t) => `  - ${t}`).join('\n')
      : '  - (none set in Configure Calendar)',
    '{{ACCOUNT}}': settings.account || 'the assistant account',
    '{{CALENDAR_NAME}}': settings.calendarName || 'Assistant',
    '{{VIA_APPS}}': VIA_APPS_RULE(
      VIA_APPS_MARKER,
      '{"events": [], "actions_taken": [], "notes": "Not done: requests come only through the apps agent."}',
    ),
  }
  // The write rules first (they hold {{CALENDAR_NAME}}), then every
  // placeholder; a function replacer keeps "$" in the owner's text literal.
  const agents = CAL_AGENTS_MD.replace('{{WRITE_RULES}}', () =>
    settings.mode === 'write' ? CAL_WRITE_RULES : CAL_READ_ONLY_RULES,
  ).replace(
    /\{\{(EXTRA_INSTRUCTIONS|TRUSTED_ORGANIZERS|ACCOUNT|CALENDAR_NAME|VIA_APPS)\}\}/g,
    (m) => fill[m] ?? m,
  )
  await writeFile(ws('AGENTS.md'), agents)
  for (const [f, text] of [
    ['SOUL.md', CAL_SOUL_MD],
    ['IDENTITY.md', CAL_IDENTITY_MD],
  ] as const) {
    const cur = await readFile(ws(f), 'utf8').catch(() => '')
    if (!cur.trim()) await writeFile(ws(f), text)
  }
}
