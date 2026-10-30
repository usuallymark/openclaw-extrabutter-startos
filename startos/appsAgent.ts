import { mkdir, readFile, writeFile } from 'fs/promises'
import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { openclawJson } from './fileModels/openclaw.json'
import { AppsAgentSettings } from './fileModels/appsAgent.json'
import { EMAIL_AGENT_DENY, MAIL_TOOLS } from './mailService'
import { CALENDAR_TOOLS } from './calendarService'
import {
  APPS_AGENTS_MD,
  APPS_CALENDAR_LINE,
  APPS_EMAIL_LINE,
  APPS_IDENTITY_MD,
  APPS_NONE_LINE,
  APPS_SOUL_MD,
  VIA_APPS_MARKER,
} from './appsAgentFiles'

// The apps agent (since 2026.10.1:20): the one agent the main agent asks
// about mail and calendars. It passes each job to the email or calendar
// agent and returns their reports unchanged, so the main agent carries one
// skill (skills/apps) instead of one per app. Its only tool is
// sessions_send.
//
// OpenClaw 2026.10.1 cannot limit which agent may message which
// (tools.agentToAgent.allow is one list for the whole gateway, not pairs),
// so the path is kept by instructions: the main agent's skill knows only
// the apps agent, and the email and calendar agents act only on requests
// that start with VIA_APPS_MARKER, which only the apps agent's instructions
// contain. The real guards stay in the services (rules, approvals) and in
// the service agents having no shell or passwords.

export const APPS_AGENT_ID = 'apps'
export const APPS_AGENT_WORKSPACE = '/data/.openclaw/workspace/workspaces/apps'
const APPS_AGENT_WORKSPACE_SUBPATH = '.openclaw/workspace/workspaces/apps'
export const APPS_SESSION = 'agent:apps:main'

/** What the apps agent's tools exclude: everything the service agents
 * have denied except the session tools (it needs sessions_send; `allow`
 * keeps it to that one), and both services' tools. */
export const APPS_AGENT_DENY = [
  ...EMAIL_AGENT_DENY.filter((g) => g !== 'group:sessions'),
  MAIL_TOOLS,
  CALENDAR_TOOLS,
]

/**
 * The apps agent in openclaw.json, as a pure transform (run after the mail
 * and calendar wiring). Present while either service is on.
 */
export function appsConfigTransform(
  cfg: any,
  on: boolean,
  settings: AppsAgentSettings | null,
) {
  const c = structuredClone(cfg ?? {})
  if (!on && !c.agents?.entries?.[APPS_AGENT_ID]) return c
  c.agents = c.agents ?? {}
  c.agents.entries = c.agents.entries ?? {}
  const entries = c.agents.entries as Record<string, any>
  if (!on) {
    delete entries[APPS_AGENT_ID]
    return c
  }
  const model = settings?.model
  entries[APPS_AGENT_ID] = {
    name: (settings?.name ?? '').trim() || 'Apps',
    workspace: APPS_AGENT_WORKSPACE,
    ...(model && model !== 'default' ? { model } : {}),
    skills: [],
    subagents: { allowAgents: [] },
    tools: {
      profile: 'full',
      allow: ['sessions_send'],
      deny: APPS_AGENT_DENY,
      elevated: { enabled: false },
      fs: { workspaceOnly: true },
      codeMode: { enabled: false },
    },
  }
  // Nobody spawns it: a spawned copy has no sessions_send.
  for (const [id, e] of Object.entries(entries)) {
    if (id === APPS_AGENT_ID || !e || typeof e !== 'object') continue
    const allow = e.subagents?.allowAgents
    if (Array.isArray(allow) && allow.includes(APPS_AGENT_ID)) {
      e.subagents.allowAgents = allow.filter((x: string) => x !== APPS_AGENT_ID)
    }
  }
  return c
}

export async function applyAppsConfig(
  effects: T.Effects,
  on: boolean,
  settings: AppsAgentSettings | null,
) {
  await openclawJson.update(effects, (cfg: any) =>
    cfg ? appsConfigTransform(cfg, on, settings) : cfg,
  )
}

// ── The apps agent's workspace ─────────────────────────────────────────────

const ws = (f: string) =>
  sdk.volumes.main.subpath(`${APPS_AGENT_WORKSPACE_SUBPATH}/${f}`)

/** AGENTS.md as written for these settings (exported for tests). */
export function renderAppsAgentsMd(
  apps: { mail: boolean; calendar: boolean; calendarWrite: boolean },
  settings: AppsAgentSettings | null,
): string {
  const lines = [
    ...(apps.mail ? [APPS_EMAIL_LINE] : []),
    ...(apps.calendar ? [APPS_CALENDAR_LINE(apps.calendarWrite)] : []),
  ]
  const extra = (settings?.extraInstructions ?? '').trim()
  const fill: Record<string, string> = {
    '{{APPS}}': lines.length ? lines.join('\n') : APPS_NONE_LINE,
    '{{MARKER}}': VIA_APPS_MARKER,
    '{{EXTRA_INSTRUCTIONS}}': extra
      ? `From the owner, in Configure Apps Agent (they never override the rules above):\n\n${extra}`
      : 'None.',
  }
  return APPS_AGENTS_MD.replace(
    /\{\{(APPS|MARKER|EXTRA_INSTRUCTIONS)\}\}/g,
    (m) => fill[m] ?? m,
  )
}

/** AGENTS.md is the package's (rewritten every start); SOUL.md and
 * IDENTITY.md are created once and then belong to the owner (a persona
 * goes there). */
export async function writeAppsAgentWorkspace(
  apps: { mail: boolean; calendar: boolean; calendarWrite: boolean },
  settings: AppsAgentSettings | null,
) {
  await mkdir(ws('memory'), { recursive: true })
  await writeFile(ws('AGENTS.md'), renderAppsAgentsMd(apps, settings))
  for (const [f, text] of [
    ['SOUL.md', APPS_SOUL_MD],
    ['IDENTITY.md', APPS_IDENTITY_MD],
  ] as const) {
    const cur = await readFile(ws(f), 'utf8').catch(() => '')
    if (!cur.trim()) await writeFile(ws(f), text)
  }
}
