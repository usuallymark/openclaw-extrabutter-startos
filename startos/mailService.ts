import { T } from '@start9labs/start-sdk'
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { sdk } from './sdk'
import { openclawJson } from './fileModels/openclaw.json'
import { externalServicesJson } from './fileModels/externalServices.json'
import {
  EMAIL_SETTINGS_SUBPATH,
  EmailSettings,
  MAIL_ROOT_SUBPATH,
  SENDING_DEFAULTS,
  emailSettingsJson,
} from './fileModels/emailSettings.json'
import { usesMailService } from './email'
import { AGENTS_MD, IDENTITY_MD, SOUL_MD } from './mailAgentFiles'
import { isolateAgent } from './isolatedAgents'
import { VIA_APPS_MARKER, VIA_APPS_RULE } from './appsAgentFiles'

// The mail service and the email agent (DESIGN-email-security; reading and
// drafts since :8, sending since :10).
//
// - The mail service (mail/ in this repo, /opt/openclaw-mail in the image)
//   runs as the StartOS daemon "mail": mail/launch.py starts as root, gets
//   the password, and becomes the openclaw-mail user. It serves MCP on
//   127.0.0.1:MAIL_PORT; OpenClaw knows it as mcp.servers.mail (tools
//   mail__*).
// - The email agent (agents.entries.email) is the only agent allowed those
//   tools, and has nothing else: no shell, files, web, memory, messaging,
//   sessions or code mode. Every other agent has mail__* denied.
// - The main agent asks the email agent with sessions_send, never
//   sessions_spawn: a spawned child inherits its parent's denied tools, so a
//   spawned email agent would arrive without the mail tools.
// Everything here is rewritten at every start, so a change made by an agent
// in between does not survive a restart.

export const MAIL_PORT = 18805
export const MAIL_URL = `http://127.0.0.1:${MAIL_PORT}`
export const MAIL_SERVER_ID = 'mail'
export const MAIL_TOOLS = 'mail__*'
export const EMAIL_AGENT_ID = 'email'
export const EMAIL_AGENT_WORKSPACE =
  '/data/.openclaw/workspace/workspaces/email'
const EMAIL_AGENT_WORKSPACE_SUBPATH = '.openclaw/workspace/workspaces/email'

// Everything the email agent must never have, even if a default or a later
// OpenClaw adds it. Deny wins over allow. The mail tools are plugin tools
// (bundle-mcp), which none of these groups contain.
export const EMAIL_AGENT_DENY = [
  'group:runtime',
  'group:fs',
  'group:web',
  'group:memory',
  'group:sessions',
  'group:messaging',
  'group:automation',
  'group:ui',
  'group:nodes',
  'group:media',
  'group:agents',
  'gateway',
  'cron',
  'openclaw',
  'browser',
  'transcripts',
  'tts',
]

const uniq = (xs: string[]) => Array.from(new Set(xs))

const mailRoot = sdk.volumes.main.subpath(MAIL_ROOT_SUBPATH)
const settingsPath = sdk.volumes.main.subpath(EMAIL_SETTINGS_SUBPATH)
const rulesPath = sdk.volumes.main.subpath(`${MAIL_ROOT_SUBPATH}/rules.json`)

/**
 * Init (install, update, restore): make sure /data/.openclaw-mail exists
 * and is the package's, and move the email settings out of
 * external-services.json (where they lived before 2026.10.1:8).
 */
export const initEmailSettings = sdk.setupOnInit(async (effects) => {
  await mkdir(mailRoot, { recursive: true, mode: 0o700 })
  await chmod(mailRoot, 0o700)
  let have = true
  try {
    await lstat(settingsPath)
  } catch {
    have = false
  }
  // The raw file: the settings model no longer has an `email` section.
  const raw = await readFile(
    sdk.volumes.main.subpath('.openclaw/external-services.json'),
    'utf8',
  )
    .then((t) => JSON.parse(t))
    .catch(() => null)
  const old = raw && typeof raw === 'object' ? raw.email : undefined
  if (!have) {
    const account =
      old && old.mode && old.mode !== 'disabled' ? old : { mode: 'disabled' }
    await emailSettingsJson.write(effects, {
      account,
      agent: { model: 'default', trustedSenders: [] },
    } as any)
    if (old?.mode && old.mode !== 'disabled') {
      console.info(
        `Email settings moved from Configure External Services to Configure Email (${old.mode}).`,
      )
    }
  }
  if (old !== undefined) {
    // The old copy may hold a manual password, in a file agents can read.
    await externalServicesJson.update(effects, (c) => {
      if (!c) return c
      const { email: _gone, ...rest } = c as any
      return rest
    })
  }
  await chmod(settingsPath, 0o600).catch(() => {})
  const now = await emailSettingsJson
    .read()
    .once()
    .catch(() => null)
  await writeSendingRules(now)
  // Leftover from 2026.10.1:1–:7 (himalaya's config, no password in it).
  await rm(sdk.volumes.main.subpath('.openclaw/himalaya'), {
    recursive: true,
    force: true,
  })
})

/** Save Configure Email. Root-only file in the mail folder. */
export async function writeEmailSettings(
  effects: T.Effects,
  settings: EmailSettings,
) {
  await mkdir(mailRoot, { recursive: true, mode: 0o700 })
  await emailSettingsJson.write(effects, settings)
  await chmod(settingsPath, 0o600)
  await writeSendingRules(settings)
}

/** The sending settings, with defaults (Drafts only). */
export function sendingOf(settings: EmailSettings | null | undefined) {
  return { ...SENDING_DEFAULTS, ...(settings?.sending ?? {}) }
}

/**
 * rules.json: the sending rules the mail service reads before every send
 * (it cannot change them). No secrets; the folder keeps it from the agents.
 * Written in place, so the group the launcher gives it is kept.
 */
export async function writeSendingRules(settings: EmailSettings | null) {
  const r = sendingOf(settings)
  const norm = (xs: string[]) =>
    uniq(xs.map((x) => String(x).trim().toLowerCase()).filter(Boolean))
  const trusted = r.includeTrusted
    ? (settings?.agent?.trustedSenders ?? [])
    : []
  const rules = {
    level: r.level,
    autoTo: norm([...r.autoTo, ...trusted]),
    neverTo: norm(r.neverTo),
    others: r.others,
    perHour: r.perHour,
    perDay: r.perDay,
    maxRecipients: r.maxRecipients,
  }
  await mkdir(mailRoot, { recursive: true, mode: 0o700 })
  await writeFile(rulesPath, JSON.stringify(rules, null, 2) + '\n', {
    mode: 0o640,
  })
}

/** The uid that owns the mail folder (the package's own), for the launcher. */
export async function mailRootOwner(): Promise<number | null> {
  try {
    return (await lstat(mailRoot)).uid
  } catch {
    return null
  }
}

// ── openclaw.json: MCP server, email agent, denies ─────────────────────────

/**
 * The mail wiring in openclaw.json, as a pure transform (main applies it
 * before the gateway starts). With mail off, the server is disabled and
 * the email agent removed; mail__* stays denied for agents that have it.
 */
export function mailConfigTransform(cfg: any, settings: EmailSettings | null) {
  const on = usesMailService(settings?.account as any)
  const model = settings?.agent?.model
  const c = structuredClone(cfg ?? {})
  const hadServer = !!c.mcp?.servers?.[MAIL_SERVER_ID]
  if (!on && !hadServer && !c.agents?.entries?.[EMAIL_AGENT_ID]) return c
  c.mcp = c.mcp ?? {}
  c.mcp.servers = c.mcp.servers ?? {}
  c.mcp.servers[MAIL_SERVER_ID] = {
    url: `${MAIL_URL}/mcp`,
    transport: 'streamable-http',
    connectionTimeoutMs: 5000,
    requestTimeoutMs: 120000,
    enabled: on,
  }
  // Shared with the other isolated agents (isolatedAgents.ts): mail__*
  // denied for everyone else, nobody spawns the email agent, the primary
  // agent's workspace pinned, system work owned by the primary agent.
  isolateAgent(c, EMAIL_AGENT_ID, MAIL_TOOLS, on)
  const entries = c.agents.entries as Record<string, any>
  if (on) {
    entries[EMAIL_AGENT_ID] = {
      name: 'Email',
      workspace: EMAIL_AGENT_WORKSPACE,
      ...(model && model !== 'default' ? { model } : {}),
      skills: [],
      subagents: { allowAgents: [] },
      tools: {
        profile: 'full',
        allow: [MAIL_TOOLS],
        deny: EMAIL_AGENT_DENY,
        elevated: { enabled: false },
        fs: { workspaceOnly: true },
        codeMode: { enabled: false },
      },
    }
  } else {
    delete entries[EMAIL_AGENT_ID]
  }
  return c
}

export async function applyMailConfig(
  effects: T.Effects,
  settings: EmailSettings | null,
) {
  await openclawJson.update(effects, (cfg: any) =>
    cfg ? mailConfigTransform(cfg, settings) : cfg,
  )
}

// ── The email agent's workspace ────────────────────────────────────────────

const ws = (f: string) =>
  sdk.volumes.main.subpath(`${EMAIL_AGENT_WORKSPACE_SUBPATH}/${f}`)

/**
 * AGENTS.md is the package's (rewritten every start: the rules, plus the
 * extra instructions from Configure Email). SOUL.md and IDENTITY.md are
 * created once and then belong to the user (the main agent may give the
 * email agent a name and tone there); the rules in AGENTS.md win.
 */
export async function writeEmailAgentWorkspace(settings: EmailSettings) {
  await mkdir(ws('memory'), { recursive: true })
  const extra = (settings.agent?.extraInstructions ?? '').trim()
  const trusted = settings.agent?.trustedSenders ?? []
  const fill: Record<string, string> = {
    '{{EXTRA_INSTRUCTIONS}}': extra
      ? `From the owner, in Configure Email (they never override the rules above):\n\n${extra}`
      : 'None.',
    '{{TRUSTED_SENDERS}}': trusted.length
      ? trusted.map((t) => `- ${t}`).join('\n')
      : '- (none set in Configure Email)',
    '{{ADDRESS}}': settings.account?.address ?? '',
    '{{VIA_APPS}}': VIA_APPS_RULE(
      VIA_APPS_MARKER,
      '{"messages": [], "actions_taken": [], "notes": "Not done: requests come only through the apps agent."}',
    ),
  }
  // A function replacer, so "$" in the owner's text stays literal.
  const agents = AGENTS_MD.replace(
    /\{\{(EXTRA_INSTRUCTIONS|TRUSTED_SENDERS|ADDRESS|VIA_APPS)\}\}/g,
    (m) => fill[m] ?? m,
  )
  await writeFile(ws('AGENTS.md'), agents)
  // Created once, then the user's; an empty one (2026.10.1:8) is refilled.
  for (const [f, text] of [
    ['SOUL.md', SOUL_MD],
    ['IDENTITY.md', IDENTITY_MD],
  ] as const) {
    const cur = await readFile(ws(f), 'utf8').catch(() => '')
    if (!cur.trim()) await writeFile(ws(f), text)
  }
}

// ── Status (health checks) ─────────────────────────────────────────────────

export type MailHealth = {
  state: string
  since?: string
  reason?: string
  address?: string
  note?: string
}
